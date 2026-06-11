# bratra-action-order-bc-sync

Automatically sends action orders from the BRATRA data warehouse to Business Central via the ERP Company integration layer (Azure Service Bus).

Full integration documentation (ERP Company architecture guide, Postman collection, test reports, M2M setup) lives in [`docs/`](docs/README.md).

## What it does

BRATRA employees import weekly action orders (purchase orders from Action) into the data warehouse via Excel uploads. Previously, these orders had to be manually entered into Business Central. This service automates that process:

1. **Dispatcher** picks up new orders from the data warehouse, converts them to the BC envelope format, and sends them to Azure Service Bus. The ERP Company integration layer (Durable Functions) picks up the message and creates Sales Orders in Business Central.

2. **Verifier** checks whether BC has successfully processed the orders by querying the BC Sales Order Buffer API. It updates the tracking status accordingly — verified, failed (retry), or dead-lettered.

Both run as scheduled AWS Lambda functions (EventBridge). The dispatcher runs every 5 minutes, the verifier every 10 minutes.

### Order lifecycle

```
New order in warehouse
  │
  ▼
Dispatcher picks it up ──► Azure Service Bus ──► ERP Company ──► BC Sales Order Buffer
  │                                                                      │
  ▼                                                                      ▼
bc_sync_orders: pending → sent                              Buffer status: Pending → Done
  │                                                                      │
  ▼                                                                      │
Verifier checks buffer ◄────────────────────────────────────────────────┘
  │
  ├─ Done       → verified (with Sales Order number)
  ├─ Error      → failed (retry up to 3x, then dead_letter)
  └─ Not found  → wait (dead_letter after 1 hour)
```

### Pet Products routing

Non-food orders may contain Pet Products articles. The dispatcher detects these by checking article EAN numbers against a configurable list (`src/config/pp-articles.json`). If any line in a PO matches, the entire order is routed to the `BRATRA-PRODUCTS` legal entity instead of `BRATRA-NONFOOD`.

## Architecture

One repo, two Lambda functions, one Docker image. The `HANDLER` environment variable selects which function runs.

```
src/
├── index.ts                        # HANDLER env var router
├── dispatcher/
│   ├── handler.ts                  # Orchestration: fetch → batch → send → track
│   ├── order-fetcher.ts            # Query unsynced orders from Supabase
│   └── envelope-mapper.ts          # Map warehouse data → ActionOrderBatchV1
├── verifier/
│   ├── handler.ts                  # Orchestration: query sent → auth → check → update
│   └── bc-buffer-checker.ts        # Check BC buffer status per order
└── shared/
    ├── config.ts                   # Zod-validated environment config
    ├── types.ts                    # ActionOrderBatchV1Envelope, BcSyncOrderRow, etc.
    ├── supabase-client.ts          # Supabase service_role client (action_orders schema)
    ├── service-bus-client.ts       # SAS token generation + HTTP POST to Azure SB
    ├── bc-auth.ts                  # MSAL M2M singleton with token caching
    └── bc-client.ts                # BC REST API client with pagination + 429 retry
```

### Dispatcher flow

1. Recover stale pending records (orphaned from Lambda crash, older than 5 min)
2. Fetch unsynced orders from `action_orders.orders` (company_id=2, Non-food)
3. Fetch failed orders eligible for re-dispatch (retry_count < max_retries)
4. Per batch (max 10 orders, max 256 KiB):
   - Insert tracking records in `bc_sync_orders` (per order, not batch — concurrency safe)
   - Map to ActionOrderBatchV1 envelope
   - POST to Azure Service Bus with SAS token auth
   - Update tracking status to `sent`
5. Re-dispatch failed orders (UPDATE existing records with fresh message_id)
6. Log summary

### Verifier flow

1. Query `bc_sync_orders` where status=`sent` and sent_at > 2 minutes ago
2. Authenticate via MSAL M2M (token cached ~60 min)
3. Per order: GET `bratraSalesOrderBuffers?$filter=externalId eq '{id}'`
4. Update status based on buffer response:
   - `Done` → `verified` + bc_document_no
   - `Error`/`Fatal` → `failed` (dispatcher retries) or `dead_letter` (max retries exceeded)
   - `Pending`/`Processing` → skip (warn if > 10 min)
   - Not found → skip (dead_letter after 1 hour)
5. Log summary

## Database

Tracking table: `action_orders.bc_sync_orders` (in Supabase)

Status lifecycle: `pending` → `sent` → `verified` | `failed` → `dead_letter` | `skipped`

The table includes RLS policies (company-scoped read for authenticated users, full access for service_role) and a monitoring view `v_bc_sync_status` that joins with order and distribution center data.

## Development

### Prerequisites

- Node.js 22+
- Docker (for ARM64 builds)
- `.env.local` with credentials (see `.env.local.example`)

### Commands

```bash
npm run build          # esbuild bundle (dual entry points → dist/)
npm run build:check    # TypeScript type check only
npm run test:local -- dry-run   # Fetch 2 orders, build envelope, don't send
npm run test:local -- live      # Send 2 orders to SB sandbox, verify via BC
npm run test:local -- cleanup   # Delete test tracking records (TEST- prefix)
```

### Local testing

The test script (`scripts/test-local.ts`) has three modes:

| Mode | What it does | Service Bus | Repeatable? |
|------|-------------|-------------|-------------|
| `dry-run` | Fetches 2 orders, builds envelope, logs everything | No send | Always |
| `live` | Sends 2 orders, waits 30s, runs verifier | Sends to sandbox | After cleanup |
| `cleanup` | Deletes `bc_sync_orders` records with `TEST-` batch_id prefix | — | Resets state |

The test script has a hard sandbox guard — it exits if `BC_ENVIRONMENT` does not start with `Sandbox`.

### Docker build & deploy

```bash
# Build ARM64 image
docker buildx build --platform linux/arm64 -f docker/Dockerfile \
  -t 683001725253.dkr.ecr.eu-central-1.amazonaws.com/bratra/bratra-action-order-bc-sync:latest \
  --provenance=false --push .
```

CI/CD via GitHub Actions (`.github/workflows/build-test-deploy.yml`) — builds, pushes to ECR, and updates both Lambda functions on push to main.

## Environment variables

| Variable | Description | Example |
|----------|-------------|---------|
| `HANDLER` | Which Lambda to run | `dispatcher` or `verifier` |
| `SUPABASE_URL` | Supabase project URL | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role JWT | `eyJ...` |
| `SB_NAMESPACE` | Azure Service Bus namespace (without .servicebus.windows.net) | `sb-bratra-int-dev-weu` |
| `SB_QUEUE` | Service Bus queue name | `bratra-inbound` |
| `SB_KEY_NAME` | SAS policy name | `producer-send` |
| `SB_KEY_VALUE` | SAS key value | `oEr9...` |
| `BC_TENANT_ID` | Azure AD tenant ID | `304a...` |
| `BC_CLIENT_ID` | App registration client ID | `1690...` |
| `BC_CLIENT_SECRET` | App registration client secret | `gb38...` |
| `BC_ENVIRONMENT` | BC environment name | `Sandbox_POC_20251229` |
| `BC_COMPANY_ID` | BC company UUID | `4465...` |

## AWS resources

| Resource | Name |
|----------|------|
| ECR repository | `bratra/bratra-action-order-bc-sync` |
| Lambda (dispatcher) | `bratra-bc-sync-dispatcher` |
| Lambda (verifier) | `bratra-bc-sync-verifier` |
| SQS trigger queue | `bc-sync-trigger` (+ `bc-sync-trigger-dlq`), event source mapping UUID `74760256-d580-4a6a-8de4-2d3d9c21ab8d` |
| Execution role | `codaeva-lambda-execution-role` |
| Region | `eu-central-1` |

## Temporarily disabling the dispatcher (test phase)

> **Status: the dispatcher trigger is DISABLED since 2026-06-11.** During the test phase with ERP Company we don't want every import to automatically dispatch orders to the (sandbox) Service Bus. The verifier has no active schedule, so disabling the SQS trigger stops all automatic syncing.

The dispatcher's only trigger is the SQS event source mapping on the `bc-sync-trigger` queue.

**Disable (sync off):**

```bash
aws lambda update-event-source-mapping \
  --uuid 74760256-d580-4a6a-8de4-2d3d9c21ab8d \
  --no-enabled --region eu-central-1
```

**Re-enable (sync on):**

```bash
aws lambda update-event-source-mapping \
  --uuid 74760256-d580-4a6a-8de4-2d3d9c21ab8d \
  --enabled --region eu-central-1
```

**Verify current state:**

```bash
aws lambda list-event-source-mappings \
  --function-name bratra-bc-sync-dispatcher \
  --region eu-central-1 --query "EventSourceMappings[].State"
```

### Behavior while disabled

- Imports keep working normally; the importer keeps sending trigger messages to `bc-sync-trigger`. Those messages wait in the queue (retention: 4 days) and are processed when the mapping is re-enabled. Messages older than 4 days expire.
- No orders are lost either way: the dispatcher fetches *all* unsynced orders from the warehouse on every run (anti-join on `bc_sync_orders`), not just the triggering batch. After re-enabling, the first run catches up everything.
- If no trigger message is left in the queue after re-enabling (all expired), force a catch-up run manually:

```bash
aws lambda invoke --function-name bratra-bc-sync-dispatcher \
  --payload '{"source":"manual-catchup"}' \
  --cli-binary-format raw-in-base64-out \
  --region eu-central-1 /tmp/dispatcher-out.json && cat /tmp/dispatcher-out.json
```

(Any payload without an SQS `Records` array takes the ScheduledEvent path = full dispatch run.)

## Related services

| Service | Purpose |
|---------|---------|
| [bratra-data-warehouse](https://github.com/RobertvandeCamp/bratra-data-warehouse) | Supabase migrations (bc_sync_orders table) |
| [bratra-action-orders-importer](https://github.com/RobertvandeCamp/bratra-action-orders-importer) | Imports action order Excels into warehouse |
| [bratra-bc-mcp-server](https://github.com/RobertvandeCamp/bratra-bc-mcp-server) | MCP server for BC data access via Claude |
