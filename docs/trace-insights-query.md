# CloudWatch Logs Insights — traceId chain query

## Doel

Met één query op `traceId` is de complete BC-keten-run terug te vinden over alle betrokken Lambda-loggroepen. Dit is het E2E-bewijs voor succescriterium 5 (TRACE-04/TRACE-05): de traceId die 208 in de SQS-body plaatst, is te volgen van trigger → dispatcher → verifier.

Fase 208 hergebruikt deze query voor het E2E-bewijs over de UI-pad en de importer-pad (TRACE-05).

---

## Loggroepen

### Actief na fase 207 (bc-sync dispatcher + verifier)

```
/aws/lambda/bratra-bc-sync-dispatcher
/aws/lambda/bratra-bc-sync-verifier
```

### Actief na fase 208 (trigger + importer)

```
/aws/lambda/bratra-bc-sync-trigger
/aws/lambda/bratra-action-orders-importer
```

> **Selectie in de console:** Open CloudWatch → Logs Insights → klik "Select log group(s)" → voeg alle vier groepen toe. In de CLI gebruik je de `--log-group-names` flag (zie onderaan).

---

## Query

```
fields @timestamp, service, level, event, msg
| filter traceId = "VERVANG_MET_JOUW_TRACE_ID"
| sort @timestamp asc
| limit 200
```

### Toelichting velden

| Veld | Herkomst | Waarde (voorbeeld) |
|------|----------|--------------------|
| `@timestamp` | CloudWatch | 2026-07-06T13:00:00.000Z |
| `service` | `HANDLER` env var | "dispatcher" / "verifier" / "trigger" / "importer" |
| `level` | pino formatter | "info" / "warn" / "error" |
| `event` | gestructureerd veld | "dispatch.summary" / "verify.summary" / afwezig |
| `msg` | pino msg | tekstomschrijving van de logregel |
| `traceId` | `createRunLogger` child-binding | UUID of awsRequestId-fallback |

> **Let op:** pino gebruikt `msg`, niet `message`. CloudWatch Logs Insights parseert de JSON-velden automatisch.

---

## Gebruik

### Via de AWS-console

1. Open **CloudWatch → Logs Insights**
2. Selecteer alle vier loggroepen (207: dispatcher + verifier; na 208 ook trigger + importer)
3. Stel het tijdsvenster in rondom de bekende run (dispatcher loopt op een schedule of event, verifier loopt 5–10 min later)
4. Plak de query en vervang `VERVANG_MET_JOUW_TRACE_ID` met de werkelijke traceId
5. Klik **Run query**

### Via de AWS CLI

```bash
aws logs start-query \
  --log-group-names \
    /aws/lambda/bratra-bc-sync-dispatcher \
    /aws/lambda/bratra-bc-sync-verifier \
  --start-time $(date -d '-2 hours' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, service, level, event, msg | filter traceId = "JOUW_TRACE_ID" | sort @timestamp asc | limit 200' \
  --region eu-central-1
```

Haal het resultaat op:
```bash
aws logs get-query-results --query-id <queryId> --region eu-central-1
```

> Voeg na fase 208 ook `bratra-bc-sync-trigger` en `bratra-action-orders-importer` toe aan `--log-group-names`.

---

## Verwacht resultaat (sandbox-run)

Een succesvolle sandbox-run toont (chronologisch):

| tijd | service | level | event | msg |
|------|---------|-------|-------|-----|
| T+0s | dispatcher | info | – | dispatch.started (of vergelijkbaar) |
| T+1s | dispatcher | info | – | orders gevonden + envelope verstuurd |
| T+2s | dispatcher | info | dispatch.summary | ordersSent: N, ordersFailed: 0 |
| T+5m | verifier | info | – | verificatie gestart |
| T+5m | verifier | info | verify.summary | status: ok, buffer: {...}, dlq: {...} |

De `traceId` verschijnt in élke logregel (via de pino child-binding aan `createRunLogger`). In `bc_sync_events.detail` zit het als `trace_id`.

---

## Hergebruik in fase 208

Fase 208 (TRACE-05) voegt `traceId` toe aan:
- de trigger Lambda logs (service: "trigger")
- de importer Lambda logs (service: "importer")
- de SQS-body tussen trigger en dispatcher

Na 208 toont de query de volledige keten over alle vier loggroepen met één traceId. De query-tekst hierboven is de definitieve versie — alleen de loggroepen-selectie breidt uit.
