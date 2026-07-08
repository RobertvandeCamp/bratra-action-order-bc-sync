# CloudWatch Logs Insights — traceId chain query

## Doel

Met één query op `traceId` is de complete BC-keten-run terug te vinden over alle betrokken Lambda-loggroepen. Dit is het E2E-bewijs voor TRACE-04/TRACE-05: de traceId is te volgen van bron (frontend of importer) → trigger → dispatcher → verifier.

---

## Loggroepen (actieve set, v5.10)

```
/aws/lambda/bratra-bc-sync-dispatcher
/aws/lambda/bratra-bc-sync-verifier
/aws/lambda/bratra-action-order-bc-sync-trigger
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
| `service` | `HANDLER` env var, anders SERVICE-fallback per repo | "dispatcher" / "verifier" / "bc-sync-trigger" / "action-orders-importer" |
| `level` | pino formatter | "info" / "warn" / "error" |
| `event` | gestructureerd veld | "dispatch.summary" / "verify.summary" / "trigger.accepted" / "import.summary" |
| `msg` | pino msg | tekstomschrijving van de logregel |
| `traceId` | `createRunLogger` child-binding | UUID of awsRequestId-fallback |

> **Let op:** pino gebruikt `msg`, niet `message`. CloudWatch Logs Insights parseert de JSON-velden automatisch.

---

## E2E-paden

### UI-pad (approve + trigger)

De frontend (`bratra-action-order-upload`) genereert per `triggerBcSync`-aanroep een `traceId` via `crypto.randomUUID()` en stuurt die mee in de POST-body. Verwachte doorloop van die ene traceId:

1. **trigger-logs** (`bc-sync-trigger`): `trigger.accepted` met de gesaniteerde frontend-traceId (fallback: API Gateway request-id).
2. **dispatcher-logs** (`dispatcher`): de traceId uit de SQS-body gebonden aan alle logregels, afgesloten met `dispatch.summary`.
3. **`bc_sync_events.detail`**: dezelfde waarde als `trace_id` in de event-details (Supabase).

### Import-pad (bestandsupload)

De importer (`bratra-action-orders-importer`) gebruikt zijn `context.awsRequestId` als run-traceId en stuurt die mee in de `notifyBcSyncTrigger`-SQS-body. Verwachte doorloop:

1. **importer-logs** (`action-orders-importer`): alle regels van de run gebonden aan de awsRequestId-traceId, afgesloten met `import.summary`.
2. **dispatcher-logs** (`dispatcher`): dezelfde importer-traceId, uit de SQS-body, over de dispatch-run heen.

---

## Gebruik

### Via de AWS-console

1. Open **CloudWatch → Logs Insights**
2. Selecteer alle vier loggroepen (zie boven)
3. Stel het tijdsvenster in rondom de bekende run (dispatcher loopt op event; verifier loopt 5–10 min later)
4. Plak de query en vervang `VERVANG_MET_JOUW_TRACE_ID` met de werkelijke traceId
5. Klik **Run query**

### Via de opgeslagen query

De opgeslagen CloudWatch-query (id `196c1c3d`) heet **"bc-sync — traceId keten (v5.10, 4 loggroepen)"** en staat voorgeconfigureerd op de vier loggroepen hierboven met de definitieve query-tekst. Alleen de traceId-placeholder hoeft ingevuld.

### Via de AWS CLI

```bash
aws logs start-query \
  --log-group-names \
    /aws/lambda/bratra-bc-sync-dispatcher \
    /aws/lambda/bratra-bc-sync-verifier \
    /aws/lambda/bratra-action-order-bc-sync-trigger \
    /aws/lambda/bratra-action-orders-importer \
  --start-time $(date -d '-2 hours' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, service, level, event, msg | filter traceId = "JOUW_TRACE_ID" | sort @timestamp asc | limit 200' \
  --region eu-central-1
```

Haal het resultaat op:
```bash
aws logs get-query-results --query-id <queryId> --region eu-central-1
```

---

## Verwacht resultaat (sandbox-run, UI-pad)

Een succesvolle sandbox-run toont (chronologisch):

| tijd | service | level | event | msg |
|------|---------|-------|-------|-----|
| T+0s | bc-sync-trigger | info | trigger.accepted | trigger geaccepteerd, SQS verstuurd |
| T+1s | dispatcher | info | – | orders gevonden + envelope verstuurd |
| T+2s | dispatcher | info | dispatch.summary | ordersSent: N, ordersFailed: 0 |
| T+5m | verifier | info | – | verificatie gestart |
| T+5m | verifier | info | verify.summary | status: ok, buffer: {...}, dlq: {...} |

De `traceId` verschijnt in élke logregel (via de pino child-binding aan `createRunLogger`). In `bc_sync_events.detail` zit het als `trace_id`. Voor het import-pad begint de tabel bij `action-orders-importer` (t/m `import.summary`) en volgt de dispatcher met dezelfde traceId.
