# BC Sync — Teststatus 2026-06-04

**Voor:** Wesley & Leo (ERP Company)
**Van:** Robert (Bratra / Codaeva)
**Context:** Hervatting BC Sync testen nadat Leo de taakwachtrij-fix heeft doorgevoerd (duplicate-PO crash → fouten worden nu gelogd).

---

## Samenvatting

Wij hebben vandaag de **dispatch-flow** en de **DLQ-monitoring** aan onze kant getest. De berichten komen aan bij Azure Service Bus en worden door jullie processor opgepikt. Wat er **ná het oppikken** met de berichten gebeurt, kunnen wij echter **niet verifiëren** — onze M2M-app heeft nog geen leesrechten op de buffer-tabel (403). Daarnaast zien wij na een nieuwe dispatch **geen nieuwe entries** in de buffer-tabel, wat een vraag oproept (zie open punten).

---

## Wat is getest

| #    | Test                                                         |                                                              |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 1    | **Dispatch** — orders vanuit het datawarehouse naar Azure Service Bus |                                                              |
| 2    | **DLQ-monitor** — Dead Letter Queue uitlezen, matchen, archiveren, opschonen | Echte DLQ-checker-code aangeroepen tegen `bratra-inbound/$DeadLetterQueue` |

---

## Wat is gevalideerd (hard bevestigd aan onze kant)

### 1. Dispatch naar Service Bus werkt
- **11 berichten verstuurd**, allemaal HTTP **201 Created** door Service Bus geaccepteerd. 0 verzendfouten.
- Verzendtijdstip: **2026-06-04 16:29 (NL) / 14:29 UTC**.
- Geen dubbele verzending van eerder verstuurde orders.

### 2. Berichten worden door jullie processor opgepikt
- Direct na de dispatch is de queue `bratra-inbound` leeg:
  - `ActiveMessageCount: 0`
  - `DeadLetterMessageCount: 0`
- De 11 berichten zijn dus **uit de queue verdwenen** (opgepikt) en **niet dead-lettered**.

### 3. DLQ-monitoring werkt
- 6 bestaande DLQ-berichten verwerkt: uitgelezen, gearchiveerd in onze tabel `bc_sync_dlq_messages`, en uit de queue verwijderd (receive + complete).
- De gevonden dead-letter-redenen kwamen correct door als headers:
  `InvalidEnvelopeJson`, `UnknownMessageName`, `EnvelopeMetaMissing`, `EmptyPayload`, 2× `PayloadSchemaViolation`.
- Dit waren oudere test-/synthetische berichten (geen match met onze actieve orders) — correct afgehandeld en gearchiveerd met `matched_sync_order_id = NULL`.

---

## Wat NIET bevestigd kon worden (open punten)

### A. Buffer-leesrechten ontbreken (403)
Onze M2M-app krijgt bij het lezen van de buffer-API een **403**:

```
GET .../api/erpcompany/integration/v1.0/companies({id})/bratraSalesOrderBuffers
→ 403  "TableData 55001 Bratra SO Buffer ... Read: Bratra Integration"
```

Hierdoor kan onze **verifier** de sync-status niet terugkoppelen. Op dit moment staan **~991 orders op status `sent`** die wij niet naar `verified` kunnen brengen zolang dit recht ontbreekt.

> **Verzoek:** kennen jullie de **Bratra Integration**-permissieset Read-rechten toe op **Table 55001 (Bratra SO Buffer)** voor onze M2M app-registratie? Het juiste API-pad is `/api/erpcompany/integration/v1.0/...` (niet de standaard `/api/v2.0/...`).

### B. Geen nieuwe buffer-entries na de dispatch van 16:29
De buffer-tabel was vóór (16:25) en ná (17:16) onze dispatch **identiek** — geen nieuwe entries voor onze 11 berichten van 16:29, terwijl de queue wél leeg is (berichten zijn opgepikt).

Onze hypothese: deze 11 orders waren **geen verse orders** — ze hadden al een eerdere sync-poging (2 recent verstuurd + 9 herstelde "pending"). Mogelijk worden ze aan jullie kant als **duplicaat** herkend en zónder nieuwe buffer-entry afgehandeld.

> **Vraag:** kunnen jullie aan jullie kant zien wat er met deze 11 berichten (verstuurd 16:29 NL / 14:29 UTC) is gebeurd? Worden duplicaten genegeerd vóór de buffer-write, of zouden ze als error-entry moeten verschijnen?

---

## Openstaande punten aan onze kant (los van ERP Company)

Tijdens eerdere tests zagen wij in de buffer-tabel terugkerende fouten in de `Error Message`-kolom:
- **"A sales order ... already exists"** — verwacht bij her-verzending van bestaande PO's (duplicaten).
- **"Het veld klantnummer ..."** — lijkt een **mapping-kwestie** met het klantnummer-veld. Dit onderzoeken wij aan onze kant zodra wij de buffer kunnen uitlezen (punt A).

---

## Waar staan we

| Onderdeel | Status |
|-----------|--------|
| Dispatcher (orders → Service Bus) | ✅ Werkt — bevestigd |
| Taakwachtrij-fix (Leo) | ✅ Doorgevoerd — geen crash meer |
| DLQ-monitoring | ✅ Werkt — bevestigd |
| Berichten opgepikt door processor | ✅ Bevestigd (queue leeg) |
| Buffer-verwerking zichtbaar | ⚠️ Niet te verifiëren — wacht op leesrechten (punt A) + vraag over duplicaten (punt B) |
| Verifier (status terugkoppelen) | ⛔ Geblokkeerd op 403 (punt A) |

**Volgende stap:** zodra de Read-rechten op Table 55001 zijn toegekend, kan onze verifier de ~991 `sent`-orders afhandelen en kunnen wij de mapping-fouten (klantnummer) zelf onderzoeken.

---

## Bijlage — de 11 verstuurde orders (2026-06-04 14:29 UTC)

ExternalId-formaat: `BRA-AC-{messageId}-{poNumber}`

**Batch `3f191be1-...` (9 orders):**
```
4002748997, 4002748765, 4002748989, 4002748992, 4002748758,
4002748760, 4002748761, 4002748766, 4002748990
```

**Batch `031237ff-...` (2 orders):**
```
4002939835, 4002939834
```
