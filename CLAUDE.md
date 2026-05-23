# CLAUDE.md

## Project Overview

**bratra-action-order-bc-sync**: Lambda voor synchronisatie van action orders naar Business Central via Azure Service Bus.

Twee Lambda functies in een Docker image (ARM64), geselecteerd via HANDLER env var:
- **Dispatcher**: Haalt orders uit Supabase, mapt naar BC envelope, stuurt naar Service Bus
- **Verifier**: Controleert BC buffer status, update sync status in Supabase

## Commands

```bash
npm run build          # esbuild bundel (dual entry points)
npm run build:check    # TypeScript type check (tsc --noEmit)
npm run test:local     # Lokale test met mock EventBridge event
```

## Architecture

```
src/
  dispatcher/handler.ts    # Dispatcher Lambda entry point
  verifier/handler.ts      # Verifier Lambda entry point
  shared/                  # Gedeelde modules (config, clients, types)
  index.ts                 # HANDLER env var routing
scripts/
  test-local.ts            # Lokaal test script
```

## Dependencies

- @supabase/supabase-js -- Supabase client (action_orders schema)
- @azure/msal-node v5 -- BC API authenticatie (M2M)
- zod -- Config validatie

## Environment Variables

| Variable | Beschrijving |
|----------|-------------|
| HANDLER | "dispatcher" of "verifier" |
| SUPABASE_URL | Supabase project URL |
| SUPABASE_SERVICE_ROLE_KEY | Supabase service role key |
| SB_NAMESPACE | Azure Service Bus namespace |
| SB_QUEUE | Service Bus queue naam |
| SB_KEY_NAME | SAS key naam |
| SB_KEY_VALUE | SAS key waarde |
| BC_TENANT_ID | Azure AD tenant ID |
| BC_CLIENT_ID | App registration client ID |
| BC_CLIENT_SECRET | App registration secret |
| BC_ENVIRONMENT | BC environment naam |
| BC_COMPANY_ID | BC company ID |

## Build Output

esbuild produceert:
- `dist/dispatcher/handler.js` -- Dispatcher bundle
- `dist/verifier/handler.js` -- Verifier bundle

## Service Registry

Zie bratra-projects CLAUDE.md voor volledige service registry.

## Database Types

Types gekopieerd uit bratra-data-warehouse/src/types/database.ts. Bij schema wijzigingen moeten types handmatig bijgewerkt worden.
