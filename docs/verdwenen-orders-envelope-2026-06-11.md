# Verdwenen orders — exact verzonden bericht (11 juni 2026)

**Voor:** Wesley & Leo (ERP Company)
**Van:** Robert (Bratra / Codaeva)
**Onderwerp:** twee orders geaccepteerd door de Service Bus (HTTP 201), niet in de DLQ, maar ook niet zichtbaar in de Bratra Sales Order Buffers.

---

## Context

Vandaag hebben we twee tests gedraaid tegen de sandbox (`Sandbox_POC_20251229`):

1. **Happy path (11:43 UTC) — GESLAAGD.** Canonieke testorder uit jullie Postman-collectie met vers PO-nummer `4002219265`. Binnen een minuut in de buffer met status Done; sales order `VO26-00160` correct aangemaakt.
2. **Twee echte orders (12:25 UTC) — VERDWENEN.** Zelfde envelope-structuur, zelfde `legalEntity` (`BRATRA-NL`), verse PO-nummers die nog niet in BC bestaan. HTTP 201, queue opgepikt, DLQ leeg — maar geen buffer-rijen.

De envelope hieronder is byte-voor-byte gereconstrueerd uit dezelfde brondata en meta-waarden als het verzonden bericht.

## Traceergegevens

| Gegeven | Waarde |
|---|---|
| Verzonden | 2026-06-11 12:25:47 UTC |
| MessageId | `0e089e21-2cfc-416f-99c1-762f63a3f973` |
| CorrelationId | `test-2026-06-11T12-25-46-996Z` |
| External ID order 1 | `BRA-AC-0e089e21-2cfc-416f-99c1-762f63a3f973-4002950522` |
| External ID order 2 | `BRA-AC-0e089e21-2cfc-416f-99c1-762f63a3f973-4002950521` |
| Service Bus respons | HTTP 201 Created |
| DLQ (12:35 UTC gecontroleerd) | leeg |
| Buffer (visuele controle) | geen rijen voor deze External IDs |

## Het exacte HTTP-request

```
POST https://sb-bratra-int-dev-weu.servicebus.windows.net/bratra-inbound/messages
Authorization: SharedAccessSignature sr=...&skn=producer-send   (geldig; SB gaf 201)
Content-Type: application/json
BrokerProperties: {"MessageId":"0e089e21-2cfc-416f-99c1-762f63a3f973","CorrelationId":"test-2026-06-11T12-25-46-996Z","Label":"ActionOrderBatchV1"}
```

## De volledige envelope (body)

```json
{
  "meta": {
    "messageId": "0e089e21-2cfc-416f-99c1-762f63a3f973",
    "correlationId": "test-2026-06-11T12-25-46-996Z",
    "name": "ActionOrderBatchV1",
    "version": "1",
    "source": "BratraIntegrationPlatform",
    "legalEntity": "BRATRA-NL",
    "occurredOnUtc": "2026-06-11T12:25:47.251Z"
  },
  "payload": {
    "orders": [
      {
        "poNumber": "4002950522",
        "orderType": "Regular order",
        "contractNumber": "A250012349",
        "carrier": {
          "code": "50015",
          "name": "ID Freight Netherlands B.V."
        },
        "distributionCenter": {
          "code": "",
          "name": "Osla",
          "unloadingLocation": ""
        },
        "dates": {
          "reqDeliveryDate": "2026-06-15",
          "expDeliveryDate": "2026-06-15",
          "reqETD": null,
          "expETD": null,
          "eta": null
        },
        "shipping": {
          "truckProposal": "2",
          "shipId": "",
          "shipmentStatus": "",
          "portOfDepartureCode": null,
          "portOfDeparture": null,
          "portOfArrivalCode": null,
          "portOfArrival": null,
          "containerType": null
        },
        "lines": [
          {
            "lineNumber": 20,
            "articleNumberAction": "3009167",
            "articleNumberSupplier": "8721325712851",
            "articleDescription": "mcgregor heren cap katoen div.kleuren",
            "category": "11",
            "logisticGroup": "009",
            "allocation": null,
            "quantities": {
              "reqQuantity": 2940,
              "expQuantity": 2940,
              "palletPattern": 980,
              "pallets": 3
            },
            "pricing": {
              "unitPrice": 2.95,
              "currency": "EUR"
            },
            "compliance": {
              "hg": "",
              "adr": null,
              "icpe": 1510
            }
          },
          {
            "lineNumber": 10,
            "articleNumberAction": "3204474",
            "articleNumberSupplier": "8721082939904",
            "articleDescription": "kaytan sportsokken pol/ea 39-46 div.kl",
            "category": "14",
            "logisticGroup": "017",
            "allocation": null,
            "quantities": {
              "reqQuantity": 960,
              "expQuantity": 960,
              "palletPattern": 960,
              "pallets": 1
            },
            "pricing": {
              "unitPrice": 1.38,
              "currency": "EUR"
            },
            "compliance": {
              "hg": "",
              "adr": null,
              "icpe": 1510
            }
          },
          {
            "lineNumber": 30,
            "articleNumberAction": "3222643",
            "articleNumberSupplier": "8721325712424",
            "articleDescription": "ls trainer socks fancy 4pr cot/pol 35-42",
            "category": "11",
            "logisticGroup": "009",
            "allocation": null,
            "quantities": {
              "reqQuantity": 1584,
              "expQuantity": 1584,
              "palletPattern": 1584,
              "pallets": 1
            },
            "pricing": {
              "unitPrice": 1.25,
              "currency": "EUR"
            },
            "compliance": {
              "hg": "",
              "adr": null,
              "icpe": 1510
            }
          }
        ]
      },
      {
        "poNumber": "4002950521",
        "orderType": "Regular order",
        "contractNumber": "A250012349",
        "carrier": {
          "code": "50015",
          "name": "ID Freight Netherlands B.V."
        },
        "distributionCenter": {
          "code": "",
          "name": "Bratislava",
          "unloadingLocation": ""
        },
        "dates": {
          "reqDeliveryDate": "2026-06-15",
          "expDeliveryDate": "2026-06-15",
          "reqETD": null,
          "expETD": null,
          "eta": null
        },
        "shipping": {
          "truckProposal": "2",
          "shipId": "",
          "shipmentStatus": "",
          "portOfDepartureCode": null,
          "portOfDeparture": null,
          "portOfArrivalCode": null,
          "portOfArrival": null,
          "containerType": null
        },
        "lines": [
          {
            "lineNumber": 10,
            "articleNumberAction": "3009167",
            "articleNumberSupplier": "8721325712851",
            "articleDescription": "mcgregor heren cap katoen div.kleuren",
            "category": "11",
            "logisticGroup": "009",
            "allocation": null,
            "quantities": {
              "reqQuantity": 2940,
              "expQuantity": 2940,
              "palletPattern": 980,
              "pallets": 3
            },
            "pricing": {
              "unitPrice": 2.95,
              "currency": "EUR"
            },
            "compliance": {
              "hg": "",
              "adr": null,
              "icpe": 1510
            }
          },
          {
            "lineNumber": 30,
            "articleNumberAction": "3223059",
            "articleNumberSupplier": "8721325712448",
            "articleDescription": "heren sportsokken mcg 3p co/pol/ea 39-46",
            "category": "11",
            "logisticGroup": "009",
            "allocation": null,
            "quantities": {
              "reqQuantity": 1296,
              "expQuantity": 1296,
              "palletPattern": 1296,
              "pallets": 1
            },
            "pricing": {
              "unitPrice": 2.2,
              "currency": "EUR"
            },
            "compliance": {
              "hg": "",
              "adr": null,
              "icpe": 1510
            }
          },
          {
            "lineNumber": 20,
            "articleNumberAction": "3222643",
            "articleNumberSupplier": "8721325712424",
            "articleDescription": "ls trainer socks fancy 4pr cot/pol 35-42",
            "category": "11",
            "logisticGroup": "009",
            "allocation": null,
            "quantities": {
              "reqQuantity": 1584,
              "expQuantity": 1584,
              "palletPattern": 1584,
              "pallets": 1
            },
            "pricing": {
              "unitPrice": 1.25,
              "currency": "EUR"
            },
            "compliance": {
              "hg": "",
              "adr": null,
              "icpe": 1510
            }
          }
        ]
      }
    ]
  }
}
```

## Vergelijking met het geslaagde happy-path-bericht

We hebben de structuur van beide berichten veld-voor-veld vergeleken:

- **Identiek:** alle veldnamen, types en de meta-structuur (incl. `legalEntity: BRATRA-NL`).
- **Verschillen alleen op waarde-niveau:**
  - `distributionCenter.code` is **leeg** (`""`), naam "Osla" (happy: code `8990`, Wallersdorf)
  - `contractNumber`: `A250012349` resp. `A250012348` (happy: `A250002419`)
  - 2 orders in één envelope i.p.v. 1 (volgens jullie guide: fan-out, één orchestration per order)
  - 3 orderregels per order met echte EAN's

## Vragen

1. Kunnen jullie in App Insights de keten traceren op `correlationId = test-2026-06-11T12-25-46-996Z` (of het MessageId)? Volgens jullie guide loggen beide kanten met dit ID (events BRA-IN-0001 t/m 0007).
2. Waar stranden deze berichten? Ze zijn niet dead-lettered en bereiken de buffer niet — volgens de guide zou een fout in dispatcher of orchestration in de DLQ moeten landen.
3. Kan de lege `distributionCenter.code` of een onbekend `contractNumber` een stille afwijzing veroorzaken (vóór de buffer-write, zonder DLQ)?
4. Dit verklaart vermoedelijk ook onze melding van 4 juni (11 orders, zelfde symptoom).

Alle hulp welkom — met deze IDs moet de run exact terug te vinden zijn.
