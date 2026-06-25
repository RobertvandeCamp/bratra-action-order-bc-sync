# Onderzoek: bratra-error queue uitlezen (23 juni 2026)

**Doel:** bepalen hoe wij de door Leo toegevoegde `bratra-error` queue kunnen uitlezen, zodat
BC-afgekeurde orders (de "verdwenen orders", open punt 2) zichtbaar en diagnosticeerbaar worden.

**Branch:** `research/bratra-error-readout` (los van de v5.2-milestonebranch). Nog geen PR.

---

## 1. Aanleiding

Leo heeft op 15-06-2026 de foutverwerking aan de BC-kant gesplitst (`docs/BC sync error queue.md`):

- Naast de bestaande DLQ is er een **aparte error queue `bratra-error`**.
- Wanneer BC een order **definitief afkeurt tijdens de buffer-write** (na de Durable Function),
  is het bericht technisch wél afgeleverd maar inhoudelijk afgekeurd. Dat hoort niet in een DLQ.
- Het originele bericht wordt verrijkt met een `error`-sectie en op `bratra-error` gezet.

Dit is vrijwel zeker de verklaring voor open punt 2 (verdwenen orders): een permanente afwijzing
(bv. veldlengte, `4xx`) verdween vóór deze wijziging stil — geen DLQ, geen buffer-rij. Voorbeeld
uit Leo's bericht: currency `TOOLONGCURRENCY` → HTTP 400 "length must be ≤ 10".

**Belangrijk:** de op 4/11 juni verdwenen orders dateren van vóór 15 juni en staan dus
**niet** in `bratra-error`. Nieuwe afwijzingen sinds 15 juni wél. Reproductie kan met een
bewust foute order (zie §6).

## 2. Berichtcontract op bratra-error

Eén order per bericht (`order`, niet `payload.orders[]`). De foutinfo zit in de **body**, niet in
headers. Afgeleid uit Leo's voorbeeld (getypeerd in `src/shared/types.ts` → `ErrorQueueMessage`):

```jsonc
{
  "meta": { "messageId": "...", "correlationId": "...", "legalEntity": "BRATRA-NL", ... },
  "order": { "poNumber": "OVERFLOW-CUR-0001", "lines": [ ... ] },
  "error": {
    "stage": "BcBufferWrite",          // of "FunctionError"
    "httpStatus": 400,
    "message": "The length of the string is 15, ...",
    "attempts": 1,
    "retryable": false,                // false = permanent (4xx); true = transient (5xx/408/429)
    "failedAtUtc": "2026-06-16T08:13:32Z",
    "correlationId": "..."
  }
}
```

Retry-classificatie aan Leo's kant: transient (`5xx/408/429`) → 5× backoff, dan error queue
(`retryable: true`); permanent (`4xx`, `400/422`) → direct error queue (`retryable: false`);
codefout → `stage: FunctionError`.

## 3. Technische aanpak (vrijwel identiek aan de DLQ-checker)

Het uitleespatroon staat al in de repo: `scripts/test-local.ts → dlqPeek()` en
`src/verifier/dlq-checker.ts`. Verschillen voor `bratra-error`:

| Aspect | DLQ (`bratra-inbound/$DeadLetterQueue`) | Error queue (`bratra-error`) |
|---|---|---|
| Entiteit | subqueue van `bratra-inbound` | **eigen queue** |
| URL | `.../bratra-inbound/$DeadLetterQueue/messages/head` | `.../bratra-error/messages/head` |
| Foutinfo | response-**headers** (`DeadLetterReason/Description`) | bericht-**body** (`error`-sectie) |
| Matching op | `BrokerProperties.MessageId` | `meta.messageId` / `meta.correlationId` |
| SAS-scope | key op `bratra-inbound` | **key op `bratra-error`** (zie §4) |

Receive-semantiek: POST `/messages/head` = peek-lock (niet-destructief, lock ~30s). Voor inspectie
géén DELETE doen — dan blijven berichten staan. Voor definitieve verwerking/replay pas DELETE
(complete) ná succesvolle opslag, net als de DLQ-checker.

## 4. Credentials — GEEN blokkade (empirisch bevestigd 23-06)

Aanvankelijke aanname was dat we een aparte Listen-key nodig hadden, omdat de Postman-key
`producer-send` queue-scoped Send is. **Die aanname was onjuist.** De key in `.env.local` is
`BratraDev` en heeft Listen-rechten (vermoedelijk namespace-breed).

Empirische test (`./scripts/bc-sync-test.sh error-queue`, 23-06) slaagde zonder 401: we lazen
`bratra-error` direct uit. Er stond op dat moment 1 bericht in de queue — Leo's eigen
currency-overflow test (`OVERFLOW-CUR-0001`, `stage: BcBufferWrite`, HTTP 400, `retryable: false`),
contract exact zoals gedocumenteerd in §2.

**Conclusie:** geen actie richting ERP Company nodig voor toegang. De `SB_ERROR_KEY_*`-vars uit §5
blijven optioneel (fallback op de bestaande key volstaat).

## 5. Wat in dit onderzoek is gebouwd (op de branch)

Read-only, backward-compatible — dispatcher/verifier draaien ongewijzigd zonder de nieuwe vars.

- `src/shared/config.ts`: optionele vars `SB_ERROR_QUEUE` (default `bratra-error`),
  `SB_ERROR_KEY_NAME`, `SB_ERROR_KEY_VALUE`.
- `src/shared/types.ts`: `ErrorQueueMessage` + `ErrorQueueErrorSection`.
- `scripts/test-local.ts`: nieuwe mode `error-queue` (`errorQueuePeek()`) — peek-only, parseert de
  `error`-sectie, valt terug op de inbound-key als geen error-key gezet is (een 401 bewijst dan
  dat de inbound-key geen toegang heeft).
- `scripts/bc-sync-test.sh`: mode `error-queue` toegevoegd.

Toe te voegen aan `.env.local` (afgeschermd, dus hier gedocumenteerd):

```
# Error queue (optioneel; default queue = bratra-error)
SB_ERROR_QUEUE=bratra-error
SB_ERROR_KEY_NAME=<listen-key-naam van ERP Company>
SB_ERROR_KEY_VALUE=<listen-key-waarde>
```

Typecheck: `npm run build:check` groen. **Live gedraaid 23-06** — peek werkt, zie §4.

## 6. Volgende stappen

1. ~~Toegang bevestigen~~ — gedaan (§4): `./scripts/bc-sync-test.sh error-queue` leest de queue.
2. Reproduceer punt 2 gericht: stuur een bewust foute order (bv. `happy` met te lange currency)
   en verifieer dat hij in `bratra-error` belandt met `retryable: false`.
3. **Productie-integratie (apart, ná validatie contract + key):** verifier laten lezen van
   `bratra-error`, analoog aan de DLQ-checker:
   - nieuwe Supabase-tabel `bc_sync_error_messages` (archief, idempotent op `message_id`),
     migratie in `bratra-data-warehouse`;
   - match op `message_id`/`correlation_id` → `bc_sync_orders` verrijken met
     `bc_error_message`, `stage`, `httpStatus`, `retryable`;
   - replay-pad voor `retryable: true` (re-dispatch met verse `messageId`).

## 7. Open vragen aan ERP Company

(Toegang is geregeld — §4. Resteren inhoudelijke vragen:)

1. Is het berichtcontract (§2) stabiel? Met name veldnamen in `error` en `order` (één order per bericht).
2. Worden `retryable: true`-berichten ook door jullie automatisch opnieuw aangeboden, of verwachten
   jullie dat wij replayen vanaf `bratra-error`?
3. Bevestiging dat de 4/11 juni verdwenen orders (vóór 15 juni) inderdaad niet in `bratra-error` staan.
