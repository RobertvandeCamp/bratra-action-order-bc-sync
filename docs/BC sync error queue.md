# BC sync error queue



Hoi Robert, 

Zie onderstaande toelichting.

Ik heb de foutverwerking nu opgesplitst in twee delen. Naast de bestaande flow is er een aparte **error queue** toegevoegd.

De reden hiervoor is dat een standaard DLQ niet voldoende is in dit scenario. Op het moment dat Business Central een foutmelding teruggeeft, is de Durable Function al een stap verder in de verwerking. Het bericht is dan technisch gezien niet simpelweg “niet afgeleverd”, maar inhoudelijk afgekeurd door Business Central.

Daarom worden dit soort fouten nu apart naar de error queue gestuurd. De berichten die daar terechtkomen, zijn bedoeld voor inspectie en eventuele herverwerking/replay.

Qua structuur heb ik een extra foutsectie toegevoegd aan het bericht. Het originele bericht blijft volledig behouden, maar wordt verrijkt met de foutinformatie vanuit Business Central. Hierdoor is altijd inzichtelijk:

- welk origineel bericht is aangeboden;
- welke fout Business Central heeft teruggegeven;
- op welk moment of in welke stap het fout is gegaan;
- of het bericht opnieuw verwerkt kan worden na correctie.

Hiermee blijft de originele payload intact en is de foutafhandeling beter geschikt voor beheer, analyse en gecontroleerde replay.

**Bratra Integration — Voortgang foutafhandeling Sales Orders**

**Datum:** 15-06-2026
**Omgeving:** dev / `Sandbox_POC_20251229`

**Samenvatting**

Voor de Bratra Sales Order-integratie is de foutafhandeling verder aangescherpt. De oplossing ondersteunt nu een aparte foutqueue, slimmer retry-gedrag en duidelijkere foutregistratie richting Business Central. Hierdoor kunnen technische fouten, tijdelijke verstoringen en functionele datafouten beter van elkaar worden onderscheiden en gecontroleerd worden opgevolgd.

**Wat is er gebouwd**

**1. Error queue in Azure / Functions**

Wanneer Business Central een order definitief afkeurt tijdens het wegschrijven naar de buffer, wordt het oorspronkelijke bericht nu verrijkt met de foutdetails uit Business Central en naar een aparte error queue gestuurd:

```
bratra-error
```

Het originele bericht blijft volledig behouden, inclusief payload en context. Daardoor kan het bericht later gecontroleerd worden geïnspecteerd en, indien nodig, opnieuw worden verwerkt. Dit ondersteunt idempotente herverwerking en voorkomt dat foutanalyse afhankelijk wordt van losse logging of gedeeltelijke data.

**2. Slim retry-gedrag**

De Function maakt nu onderscheid tussen tijdelijke, permanente en onverwachte fouten.

| Type fout                                                    | Gedrag                                                       | Markering              |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------- |
| Tijdelijke fout, bijvoorbeeld BC `5xx`, `408` of `429`       | Maximaal 5 pogingen met oplopende backoff. Daarna naar de error queue. | `retryable: true`      |
| Permanente fout, bijvoorbeeld BC `4xx`, zoals `400` of `422` | Direct naar de error queue. Geen retries.                    | `retryable: false`     |
| Onverwachte codefout in de Function                          | Naar de error queue met aparte technische markering.         | `stage: FunctionError` |

Hierdoor is op de error queue direct zichtbaar of een bericht veilig opnieuw aangeboden kan worden, een data- of validatiefout bevat, of dat er sprake is van een softwarematig probleem.

**3. Artikelvalidatie verplaatst naar de BC-verwerking**

De controle of een artikelnummer bestaat, is verplaatst van de inkomende bufferregel naar de daadwerkelijke verwerking in Business Central.

Voorheen kon een onbekend artikel ertoe leiden dat de volledige inbound POST werd geweigerd. Dat maakte foutafhandeling en opvolging minder beheersbaar, omdat het bericht niet netjes als verwerkbare bufferdata beschikbaar kwam.

Na de aanpassing wordt de bufferregel wel aangemaakt, maar krijgt deze een duidelijke Error-status met een functionele melding, bijvoorbeeld:

> Item X bestaat niet — maak het artikel aan of corrigeer de mapping.

Dit is nu consistent met de bestaande logica voor situaties waarin een klant niet wordt gevonden.

**Voorbeeld bericht :** 

{

"meta": {

"messageId": "22222222-2222-2222-2222-222222222222",

"correlationId": "cccccccc-0000-0000-0000-000000000003",

"name": "ActionOrderBatchV1",

"version": "1",

"source": "BratraIntegrationPlatform",

"legalEntity": "BRATRA-NL",

"occurredOnUtc": "2026-06-16T08:30:00Z"

},

"payload": {

"orders": [

{

"poNumber": "OVERFLOW-CUR-0001",

"orderType": "Regular order",

"contractNumber": "",

"carrier": {

"code": "",

"name": ""

},

"distributionCenter": {

"code": "",

"name": "",

"unloadingLocation": ""

},

"dates": {

"reqDeliveryDate": "2026-06-20",

"expDeliveryDate": null,

"reqETD": null,

"expETD": null,

"eta": null

},

"shipping": {

"truckProposal": "",

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

"articleNumberAction": "3007781",

"articleNumberSupplier": "8721008420981",

"articleDescription": "currency overflow reject test",

"category": "11",

"logisticGroup": "009",

"allocation": null,

"quantities": {

"reqQuantity": 1,

"expQuantity": 1,

"palletPattern": 0,

"pallets": 0

},

"pricing": {

"unitPrice": 1.00,

"currency": "TOOLONGCURRENCY"

}

}

]

}

]

}

}

Response in Error Queue 

{

 "meta": {

  "messageId": "22222222-2222-2222-2222-222222222222",

  "correlationId": "cccccccc-0000-0000-0000-000000000003",

  "name": "ActionOrderBatchV1",

  "version": "1",

  "source": "BratraIntegrationPlatform",

  "legalEntity": "BRATRA-NL",

  "occurredOnUtc": "2026-06-16T08:30:00Z"

 },

 "order": {

  "poNumber": "OVERFLOW-CUR-0001",

  "orderType": "Regular order",

  "contractNumber": "",

  "carrier": {

   "code": "",

   "name": ""

  },

  "distributionCenter": {

   "code": "",

   "name": "",

   "unloadingLocation": ""

  },

  "dates": {

   "reqDeliveryDate": "2026-06-20"

  },

  "shipping": {

   "truckProposal": "",

   "shipId": "",

   "shipmentStatus": ""

  },

  "lines": [

   {

​    "lineNumber": 10,

​    "articleNumberAction": "3007781",

​    "articleNumberSupplier": "8721008420981",

​    "articleDescription": "currency overflow reject test",

​    "category": "11",

​    "logisticGroup": "009",

​    "quantities": {

​     "reqQuantity": 1,

​     "expQuantity": 1,

​     "palletPattern": 0,

​     "pallets": 0

​    },

​    "pricing": {

​     "unitPrice": 1.0,

​     "currency": "TOOLONGCURRENCY"

​    }

   }

  ]

 },

 "error": {

  "stage": "BcBufferWrite",

  "httpStatus": 400,

  "message": "The length of the string is 15, but it must be less than or equal to 10 characters. Value: TOOLONGCURRENCY  CorrelationId:  e761d6c7-5b7a-487f-8cbd-d0f63a2bf5ea.",

  "attempts": 1,

  "retryable": false,

  "failedAtUtc": "2026-06-16T08:13:32.242291Z",

  "correlationId": "cccccccc-0000-0000-0000-000000000003"

 }

}