# BC Sync — Testoverzicht en actuele stand (11 juni 2026)

**Doel:** overzicht van wat er getest is, waar we nu staan, en hoe je de test zelf draait (demo voor het gesprek met Wesley).

---

## 1. De koppeling in het kort

```
Datawarehouse (Supabase) --> Dispatcher (Lambda) --> Azure Service Bus --> ERP Company --> BC buffer-tabel
                                                                                               |
Tracking (bc_sync_orders)  <-- Verifier (Lambda) <-- BC buffer-API (Read op Table 55001) <-----+
```

| Component | Wat | Waar |
|---|---|---|
| Dispatcher | Haalt nieuwe orders uit het datawarehouse, bouwt het `ActionOrderBatchV1`-bericht, POST naar Azure Service Bus (SAS-auth) | AWS Lambda `bratra-bc-sync-dispatcher`, getriggerd via SQS (`bc-sync-trigger`) direct na elke import, met ScheduledEvent-fallback |
| Verifier | Leest de BC buffer-tabel via de custom API (`/api/erpcompany/integration/v1.0/.../bratraSalesOrderBuffers`) en koppelt status terug | AWS Lambda `bratra-bc-sync-verifier`, EventBridge-schedule |
| DLQ-monitor | Leest `bratra-inbound/$DeadLetterQueue`, archiveert afgekeurde berichten in `bc_sync_dlq_messages`, ruimt op | Onderdeel van de verifier |
| Tracking | `action_orders.bc_sync_orders` met lifecycle `pending -> sent -> verified` / `failed -> dead_letter` + view `v_bc_sync_status` | Supabase |
| Lokaal testscript | E2E-test tegen de BC sandbox, met harde sandbox-guard | `bratra-action-order-bc-sync/scripts/bc-sync-test.sh` |

Volledige architectuurbeschrijving (componenten, flows, env-vars, AWS-resources): **README.md in de repo `bratra-action-order-bc-sync`**. Architectuur van de ERP Company-kant: `bratra-integration-architecture.pdf` (van Leo, 11 mei) in deze map.

### ERP Company-kant (samenvatting uit Leo's guide)

Wat er met ons bericht gebeurt na de Service Bus:

1. **InboundDispatcher** (Azure Function, SB-triggered): valideert de envelope, dead-lettert foute berichten, start één Durable-orchestration per order.
2. **Orchestration** POST't `{externalId, ...}` naar de BC API-page `bratraSalesOrderBuffers` (deep insert, idempotent op `externalId`; retry bij transient errors, 5 pogingen).
3. **Buffer-tabel** `Bratra SO Buffer BIN`: één rij per order, status `Pending`.
4. **Buffer Processor codeunit** (BC Job Queue, elke ~1 min): verwerkt `Pending`/`Error`-rijen, maakt de echte Sales Order aan, zet status op `Done` (+ Created Document No.) of `Error` (transient, retry met backoff) / `Fatal` (operator nodig).

Relevant voor de open punten:

- **Idempotency (relevant voor open punt 2):** dedup gebeurt op twee niveaus. De Service Bus heeft duplicate-detect op `messageId`, en BC geeft HTTP 400 bij een al bestaand `externalId` (de Function behandelt dat als succes, géén nieuwe buffer-rij). Onze re-dispatches krijgen een verse `messageId` (en dus vers `externalId`), dus volgens dit ontwerp zouden er wél nieuwe buffer-rijen moeten verschijnen — precies de vraag die uitstaat.
- **Permissies (relevant voor open punt 1):** de ERP Company Function authenticeert als service principal met de `BRATRA INT BIN` permission set, toegekend via de AAD Applications-page (9089) in BC. Voor onze M2M-app is dezelfde route nodig, maar dan met Read op de buffer-tabel.
- **DLQ-bewaking aan hun kant:** App Insights alert bij DLQ-diepte > 0 langer dan 5 minuten, gerouteerd naar Variables en ERP Company.

---

## 2. Uitgevoerde testen

| Datum | Test | Resultaat |
|---|---|---|
| 19-21 mei | Postman-collectie van Leo werkend krijgen (SAS-key, 401-debug, samen met Leo opgelost in call van 21 mei) | Berichten handmatig op de Service Bus: werkt |
| 21-22 mei | Eerste E2E vanuit eigen code: orders inschieten via dispatcher-logica | Berichten geaccepteerd; bevindingen gedeeld (vragen-leo-2026-05-22.md). BC-taakwachtrij bleek te crashen op dubbele orders; fix door Leo geleverd op 3 juni |
| 22 mei | DLQ-checker tegen `$DeadLetterQueue` | Werkt; dead-letter-redenen komen correct door als headers |
| 4 juni | Volledige dispatch-E2E met echte handler (ScheduledEvent-pad): 11 orders | 11x HTTP 201, 0 fouten, queue daarna leeg (opgepikt door processor). Claim/dedup-laag sloeg reeds verstuurde orders correct over |
| 4 juni | DLQ-monitor E2E | 6 oude berichten verwerkt, gearchiveerd, queue leeggemaakt. Redenen: InvalidEnvelopeJson, UnknownMessageName, EnvelopeMetaMissing, EmptyPayload, 2x PayloadSchemaViolation |
| 4 juni | Verifier (buffer terugkoppeling) | HTTP 403: M2M-app mist Read op Table 55001 — open punt 1 |
| Doorlopend | Automatische dispatches bij imports (SQS-trigger) | 29 mei: 1772 orders sent; 8 juni: 1209 sent; 11 juni (07:07): 156 sent. Trigger daarna tijdelijk UIT gezet voor de testfase (zie README) |
| 11 juni | Status-mode van het testscript (read-only) | Zie actuele stand hieronder; buffer-API geeft nog steeds 403 |
| 11 juni | **Happy-path test GESLAAGD** (`bc-sync-test.sh happy`): canonieke order met vers PO-nummer 4002219265 | HTTP 201; rij in buffer-tabel met status **Done** (visuele controle). messageId `bb24e0fa-5c62-4932-a7a8-9079d0da7124`, externalId `BRA-AC-bb24e0fa-...-4002219265`, verzonden 11:43 UTC. Volledige keten Service Bus -> processor -> buffer -> Job Queue -> Done bewezen |
| 11 juni | Sales order **VO26-00160** geverifieerd in BC (screenshot) | Alle mappings kloppen: External Doc No. 4002219265, klant C00006 (conform CUSTOMER_MAP), EAN 8721008420981 als Item No., Item Reference 3007781, qty 2.352, Req. Delivery 15-5, Wallersdorf. **Bespreekpunt prijs:** wire `unitPrice 2.35` is niet gebruikt; BC prijst uit eigen stamdata (1,00 EUR, totaal 2.352,00 i.p.v. 5.527,20). Vraag aan ERP Company: is onze unitPrice ergens leidend, of moet de contractprijs in BC-stamdata staan? |

Gedetailleerd testverslag van 4 juni (gedeeld met Wesley en Leo): `test-status-2026-06-04.md` in deze map.

## 3. Actuele stand (gemeten 11 juni, 09:49 NL)

```
bc_sync_orders:
   pending           5
   sent           3148     <- verstuurd, wacht op verificatie (geblokkeerd door 403)
   verified          0     <- kan pas vullen zodra leesrechten er zijn
   failed         8593     <- zie observatie hieronder
   dead_letter       0
   totaal        11746

DLQ-archief: 6 berichten verwerkt
Buffer-API:  HTTP 403 (Read op Table 55001 ontbreekt nog)
```

**Observatie failed-records (onze kant, geen ERP Company-punt):** 8556 van de 8593 failed-records stammen van één incident op 28 mei met foutmelding "fetch failed" (netwerkfout vanuit de Lambda richting Service Bus). 118 records zitten op max retries. Dit onderstreept het belang van het hardening-plan (alarmering, monitoring); staat op de backlog (999.11).

## 4. Open punten richting ERP Company

| # | Punt | Eerste verzoek | Herhaald | Status |
|---|---|---|---|---|
| 1 | Read-rechten op buffer-tabel (Table 55001, Bratra SO Buffer) voor onze M2M-app, via de "Bratra Integration" permission set. Pad: `/api/erpcompany/integration/v1.0/.../bratraSalesOrderBuffers` | 23 mei | 4 juni | Open — zonder dit kan de verifier de 3148 `sent`-orders niet afhandelen |
| 2 | Op 4 juni verstuurde orders (11 stuks, HTTP 201, geen DLQ) zijn bij visuele controle niet zichtbaar in de buffer-tabel | 4 juni (testverslag) | 9 juni | Open, maar AANGESCHERPT door de geslaagde happy-path test van 11 juni: een order met een vers PO-nummer komt wél in de buffer en gaat naar Done. Het verschil: de 11 orders van 4 juni waren re-dispatches van PO's die al als sales order in BC bestaan. Vraag aan ERP Company is nu specifiek: wat gebeurt er met berichten voor een al bestaande PO — volgens Leo's guide zou een vers externalId een Error-rij ("already exists") moeten opleveren, maar er verschijnt niets |

## 5. Zelf de test draaien (demo)

Vanuit de repo `bratra-action-order-bc-sync` (vereist `.env.local`; het script heeft een harde guard die stopt als `BC_ENVIRONMENT` geen sandbox is):

```bash
./scripts/bc-sync-test.sh status     # Waar staan we: tellingen, laatste verzending, DLQ, live buffer-API-check (read-only, altijd veilig)
./scripts/bc-sync-test.sh dry-run    # Bouw het BC-bericht voor 2 echte orders, verstuur niets ("wat doe je dan precies?")
./scripts/bc-sync-test.sh live       # Verstuur 2 orders naar de Service Bus sandbox, wacht 30s, verifieer in BC
./scripts/bc-sync-test.sh dlq        # Kijk in de Dead Letter Queue (peek-only)
./scripts/bc-sync-test.sh cleanup    # Ruim test-records op (TEST- prefix), test is herhaalbaar
```

Demo-volgorde voor het gesprek:

1. `status` — actuele stand, en de 403 op de buffer-API is live zichtbaar (open punt 1)
2. `dry-run` — het exacte JSON-bericht dat we versturen
3. `live` — bericht gaat echt de Service Bus op (HTTP 201), verifier-poging toont opnieuw de 403
4. `dlq` — zo bewaken we afgekeurde berichten
5. `cleanup` — testdata opruimen

## 6. Gerelateerde documenten

Zie [`README.md`](README.md) in deze map voor de volledige documentatie-index. Daarnaast:

| Document | Inhoud |
|---|---|
| `bratra-projects/docs/management-updates/bc-sync-status-2026-06-08.md` | Statusrapport voor MC en Bart |
| `bratra-projects/docs/features/erpcompany-bc-integration-docs/timeline/` | Mail-tijdlijn en correspondentie met ERP Company |
| Backlog 999.11 (bratra-projects ROADMAP.md) | Productie-hardening plan (logging, alarmering, monitoring, IaC) |
