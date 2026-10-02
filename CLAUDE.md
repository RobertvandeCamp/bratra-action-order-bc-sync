# CLAUDE.md

## Project Overview

**bratra-action-order-bc-sync**: Lambda voor synchronisatie van action orders naar Business Central via Azure Service Bus.

Twee Lambda functies in een Docker image (ARM64), geselecteerd via HANDLER env var:
- **Dispatcher**: Haalt orders uit Supabase, mapt naar BC envelope, stuurt naar Service Bus. Getriggerd via SQS (body `SqsTriggerMessage`) of een scheduled/handmatige event (fallback, Non-food)
- **Verifier**: Controleert BC buffer status, verwerkt de Service Bus-DLQ en de error queue (`bratra-error`), update sync status in Supabase

## Commands

```bash
npm run build          # esbuild bundel (drie entry points, zie Build Output)
npm run build:check    # TypeScript type check (tsc --noEmit)
npm test               # Vitest unit tests (src/**/*.test.ts)
npm run test:local     # Lokale E2E-test tegen BC Sandbox: npm run test:local -- <mode> (zie scripts/test-local.ts)
```

## Architecture

```
src/
  dispatcher/handler.ts    # Dispatcher Lambda entry point
  verifier/handler.ts      # Verifier Lambda entry point
  shared/                  # Gedeelde modules (config, clients, types)
    logger.ts              # pino JSON-logs naar stdout (CloudWatch); leest LOG_LEVEL zelf
    metrics.ts             # CloudWatch EMF metrics (namespace Bratra/BcSync); canonieke bron, zie Multi-repo kopieën
    event-logger.ts        # Supabase-audit: append-only inserts in action_orders.bc_sync_events
  index.ts                 # HANDLER env var routing
scripts/
  test-local.ts            # Lokaal test script
  bc-sync-test.sh          # Wrapper rond test-local.ts tegen BC Sandbox
  setup-verifier-schedule.sh # EventBridge-schedule voor de verifier (idempotent)
```

## Dependencies

- @supabase/supabase-js -- Supabase client (action_orders schema)
- @azure/msal-node -- BC API authenticatie (M2M)
- zod -- Config validatie
- pino -- Structured logging (`src/shared/logger.ts`)
- aws-embedded-metrics -- CloudWatch EMF metrics (`src/shared/metrics.ts`)

Versies staan in `package.json` (gepind in `package-lock.json`).

## Environment Variables

`APP_TARGET` kiest per variabele in de tweede tabel welke set gelezen wordt: `production` → `PROD_<naam>`, `sandbox` → `SANDBOX_<naam>`, leeg/ongezet → de ongeprefixte `<naam>` (legacy-pad). Een ontbrekende waarde voor de gekozen set faalt fail-fast; er is geen terugval naar de andere set (`src/shared/config.ts`).

| Variable | Beschrijving |
|----------|-------------|
| HANDLER | "dispatcher" of "verifier"; ook de `service` in de logs |
| APP_TARGET | "production", "sandbox" of leeg (legacy); andere waarden falen. Ook de `Target`-dimensie van de metrics (leeg → "sandbox") |
| LOG_LEVEL | pino log level (default "info"; ongeldige waarde → "info"), alleen gelezen door `logger.ts` |
| SUPABASE_URL | Supabase project URL |
| SUPABASE_SERVICE_ROLE_KEY | Supabase service role key |
| BC_TENANT_ID | Azure AD tenant ID |
| BC_CLIENT_ID | App registration client ID |
| BC_CLIENT_SECRET | App registration secret |

Per target, als `SANDBOX_<naam>` / `PROD_<naam>` (of ongeprefixt bij leeg `APP_TARGET`):

| Variable | Beschrijving |
|----------|-------------|
| SB_NAMESPACE | Azure Service Bus namespace |
| SB_QUEUE | Service Bus queue naam |
| SB_KEY_NAME | SAS key naam |
| SB_KEY_VALUE | SAS key waarde |
| SB_ERROR_QUEUE | Error queue naam (default "bratra-error") |
| SB_ERROR_KEY_NAME | SAS key naam voor de error queue (optioneel, samen met SB_ERROR_KEY_VALUE; anders SB_KEY_*) |
| SB_ERROR_KEY_VALUE | SAS key waarde voor de error queue |
| BC_ENVIRONMENT | BC environment naam |
| BC_COMPANY_ID | BC company ID |

## Build Output

esbuild produceert:
- `dist/index.js` -- HANDLER-routing; de Docker CMD `index.handler` wijst hierheen
- `dist/dispatcher/handler.js` -- Dispatcher bundle
- `dist/verifier/handler.js` -- Verifier bundle

## Multi-repo kopieën

Deze repo is de canonieke bron van twee contracten die handmatig in lock-step gekopieerd worden; wijzig alle drie in dezelfde PR:

- `src/shared/metrics.ts` -- kopieën in `bratra-action-order-bc-sync-trigger/src/metrics.ts` en `bratra-action-orders-importer/src/metrics.ts`. Raakt een wijziging metric-namen, de namespace (`Bratra/BcSync`) of de dimensies (`Service`, `Target`), werk de kopieën bij.
- `SqsTriggerMessage` in `src/shared/types.ts` -- kopieën in `bratra-action-order-bc-sync-trigger/src/types.ts` en inline in `bratra-action-orders-importer/src/index.ts`.

## Service Registry

Zie bratra-projects CLAUDE.md voor volledige service registry.

## Database Types

De DB-types in `src/shared/types.ts` zijn handmatig overgenomen uit bratra-data-warehouse (`src/types/database.ts` en de migraties). Bij schema wijzigingen moeten types handmatig bijgewerkt worden.
