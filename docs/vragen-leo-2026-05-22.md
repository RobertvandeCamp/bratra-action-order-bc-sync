# Vragen voor Leo / ERP Company — 22 mei 2026

We hebben de afgelopen dagen de BC Sync Service gebouwd en getest tegen de sandbox. Dispatcher werkt (HTTP 201 naar Service Bus). Na uitgebreid A/B testen hebben we goed inzicht in wat werkt en wat niet.

## 1. Buffer Processor Job Queue lijkt gestopt (URGENT)

Alle buffer entries sinds ~10:35 AM vandaag staan permanent op Pending -- inclusief berichten met exact dezelfde data als Leo's happy path test (PO `4002845709`, EAN `8721008420981`).

Alleen entry 52 (10:24 AM) werd Done. Alles daarna hangt op Pending:

| Entry | Received | PO | Data | Status |
|-------|----------|------|------|--------|
| 52 | 10:24 AM | 4002516997 | V4 minimaal | **Done** (VO26-00093) |
| 53-57 | 10:24-10:40 | 4002516997 | V5-V9 (specifieke veld-tests) | Pending |
| 78 | 12:01 PM | 4002516995 | Toekomstige datum, 1 line | Pending |
| 79 | 12:44 PM | 4002516995 | Exact happy path line data | Pending |
| 80 | 1:00 PM | 4002845709 | **Exact Leo's happy path** | Pending |
| 81-83 | 1:38 PM | 3 orders batch | Multi-order, happy path data | Pending |

Entry 80 is **identiek** aan Leo's eerdere succesvolle tests (entries 22-27, allemaal Done). Dat het nu op Pending hangt, wijst op een gestopte Job Queue, niet op data issues.

**Vraag:** Kun je de `BratraBufferProcessorBIN` Job Queue entry in BC checken? Die draait normaal elke ~1 minuut. Mogelijk is deze gestopt of heeft een error.

## 2. Multi-order batches werken

Na extra testen: multi-order envelopes (meerdere orders in 1 bericht) worden correct ge-fan-out naar aparte buffer rijen. Entries 81-83 tonen 3 orders uit 1 envelope, elk met hun eigen Entry No.

## 3. Veldwaarden die de Buffer Processor niet aankan

Uit onze A/B test (entries 49-57, vanochtend 10:24-10:40):

**Werkt (Done):** V1-V4 -- inclusief lege carrier/DC, category="", logisticGroup="", expQty=0, icpe=null

**Hangt op Pending:** V5-V9 -- specifieke velden die afwijken:

| Veld | Waarde die faalt | Werkende waarde |
|------|-----------------|-----------------|
| `lineNumber` | `0` | `10, 20, 30...` (> 0) |
| `expDeliveryDate` | `null` | Een datum (bijv. `"2026-07-15"`) |
| `truckProposal` | `""` (lege string) | `"0"` of `"1"` |
| `reqDeliveryDate` | `"2025-06-26"` (verleden) | Toekomstige datum |

We hebben onze mapper al aangepast met defaults. Maar: deze test entries (53-57) hingen VOORDAT de Job Queue stopte, dus het is mogelijk dat ze echt niet verwerkt kunnen worden.

**Vraag:** Kun je bevestigen welke van deze velden de Buffer Processor niet aankan? En kun je alle Pending test entries (53-57, 78-83) cancellen/opruimen?

## 4. Item/EAN resolution in BC sandbox

Onze non-food orders hebben diverse EAN nummers. Tot nu toe hebben we alleen `8721008420981` succesvol getest (Entry 52, Done). Onze echte orders hebben andere EAN's.

**Vraag:** Staan alle EAN nummers uit onze non-food data als Items in de BC sandbox? Als items ontbreken, wat doet de Buffer Processor -- Error, Fatal, of Pending?

## 5. API pad voor bratraSalesOrderBuffers (verifier)

Onze verifier Lambda wil de buffer status lezen via de BC API:

```
GET https://api.businesscentral.dynamics.com/v2.0/{tenant}/{environment}/api/v2.0/companies({companyId})/bratraSalesOrderBuffers?$filter=externalId eq 'BRA-AC-...'
```

Dit geeft HTTP 404. De page is een custom API page (table 50100).

**Vraag:** Wat is het juiste API pad? En heeft onze app registration leesrechten?

## Samenvatting

**Wat WEL werkt:**
- SAS authenticatie naar Service Bus (met `BratraDev` policy)
- Envelopes in ActionOrderBatchV1 formaat komen aan in de buffer
- Multi-order batches worden correct ge-fan-out
- External ID formaat `BRA-AC-{messageId}-{poNumber}` werkt
- Lege carrier/DC/contract/category/logisticGroup/icpe zijn OK

**Blokkades:**
1. ~~Job Queue lijkt gestopt~~ → **Beantwoord 23 mei** (zie onder)
2. Onbekend welke velden verplicht zijn voor Buffer Processor
3. Verifier API pad onbekend (404)

**Wat we nodig hebben:**
1. ~~Job Queue herstarten / checken~~ → Beantwoord
2. Bevestig verplichte velden
3. Opruimen Pending test entries → **Wesley/Leo moeten Pending entries cancellen**
4. API pad voor verifier → **Nog open**
5. EAN/Item beschikbaarheid in sandbox → Beantwoord (beperkt, na unit tests → acceptatie-omgeving)

---

## Antwoord Wesley — 23 mei 2026

### Job Queue crash: duplicate PO check

De `BratraBufferProcessorBIN` Job Queue (Codeunit 55000) stond op "Fout":

> "Verkoop Order 4002516997 bestaat al voor data klant"

**Oorzaak:** Onze eerste succesvolle test (entry 52, V4) maakte Sales Order `VO26-00093` aan voor PO `4002516997`. Alle latere tests met hetzelfde PO nummer crashen de Job Queue omdat Leo een controle heeft ingebouwd dat dezelfde reference (PO) niet meerdere keren als Sales Order aangemaakt kan worden.

**Impact:** De gecrasde Job Queue blokkeert ALLE Pending entries (53-57, 78-83), niet alleen de duplicates.

**Herstarten helpt niet** -- zolang de Pending entries met het duplicate PO nummer in de buffer staan, crasht de Job Queue opnieuw.

### Sandbox data beperkt

Wesley bevestigt:
- Sandbox data is beperkt (weinig Items/EAN's beschikbaar)
- Voor andere test scenario's moeten we daadwerkelijk data aanmaken
- Na unit tests → aansluiten op acceptatie-omgeving met volledige EAN data

### Vervolgacties

1. **Wesley/Leo:** Cancel alle Pending test entries (53-57, 78-83) zodat Job Queue weer kan draaien
2. **Wij:** Testen met PO nummers die nog niet in BC staan als Sales Order
3. **Planning:** Na unit tests → acceptatie-omgeving (met volledige EAN data)
4. **Nog open:** Verifier API pad (vraag 5), veldvalidatie bevestiging (vraag 3)
