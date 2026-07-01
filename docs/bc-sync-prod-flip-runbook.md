# bc-sync productie-flip runbook

**Doel:** de gecontroleerde productie-cutover van `bratra-action-order-bc-sync` (verifier-eerst,
dan dispatcher) met exacte commando's, het env-var-contract, de post-test cleanup en de
noodrollback.

**Scope / validatiegrens:** prod valideert **t/m verzonden naar BC** = **SYNC-05a**: order in de
prod-buffer op `Pending` + `bc_sync_orders.status = sent`. **GEEN** `Done`/`verified`/`bc_document_no`
in prod (D1, D2) — Bratra's BC Job Queue verwerkt de buffer bewust NIET; orders blijven `Pending`.

**Eindtoestand:** na test + cleanup blijft `APP_TARGET=production` op BEIDE functies. Dit ís de
go-live; **GEEN rollback naar sandbox als eindstap** (D8). Sandbox testen voortaan los via
`ops-bratra`. De `APP_TARGET=sandbox`-rollback hieronder is uitsluitend een noodmaatregel.

> **Veiligheid (T-202-01):** dit runbook bevat alleen var-NAMEN en bronverwijzingen — NOOIT
> secret-waarden. Secrets komen uit AWS Secrets Manager / operator-beheerde `.env.prod`
> (nooit gecommit). Log nooit `SB_KEY_VALUE`, `BC_CLIENT_SECRET` of `SUPABASE_SERVICE_ROLE_KEY`.

---

## 0. Readiness (pre-flight, autonoom geverifieerd 2026-07-01)

| Check | Bron | Status |
|-------|------|--------|
| Fase 201 gemerged op master | `git log origin/master` → top = `3a69028` (PR #11 "v5.8 fase 201: selector & config") | **OK** |
| Resolver-image op BEIDE Lambdas | `Code.ImageUri` tag `3a69028...`, digest `sha256:bd7764fc...`, `LastModified 2026-07-01T08:47Z` op dispatcher **én** verifier | **OK** |
| Huidige env-staat beide functies | alleen LEGACY ongeprefixte keys (`BC_*`, `SB_*`, `SUPABASE_*`, `HANDLER`) — **geen** `APP_TARGET`, **geen** `PROD_*`/`SANDBOX_*`-paren | legacy-sandbox-pad (resolver-prefix = `""`) |
| Dispatcher SQS-mapping | UUID `74760256-d580-4a6a-8de4-2d3d9c21ab8d` op `bc-sync-trigger` → **State `Enabled`** (LET OP: README claimt "disabled sinds 2026-06-11" — live is enabled) | **flag** |

**Gevolg voor de flip:** de operator moet vóór de flip op elke functie de volledige
`SANDBOX_*`- én `PROD_*`-paren toevoegen (die staan er nu niet) én daarna pas `APP_TARGET`
zetten. Zonder de `PROD_*`-paren faalt de resolver fail-fast (Zod `min(1)`) — geen stille
terugval naar sandbox (`src/shared/config.ts:139-146`).

### Openstaand operator-actiepunt vóór GO — sent-count (D10)

De pre-flight sent-count kon **niet autonoom** worden gemeten: de Supabase-read vereist
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` uit een operator-secret (`.env.prod`, niet leesbaar
vanuit deze omgeving — bewust, T-202-01). **De operator meet dit read-only vóór de verifier-flip:**

```sql
-- action_orders schema, company_id = 2 (non-food). Read-only.
SELECT status, count(*)
FROM action_orders.bc_sync_orders
WHERE company_id = 2
GROUP BY status
ORDER BY status;
```

**Waarom kritisch:** elke rij op `status = sent` verwijst naar een **sandbox**-`externalId`. Een
prod-lezende verifier vindt die niet in de prod-buffer en kantelt de rij na 1u naar `dead_letter`
(`src/verifier/bc-buffer-checker.ts:117-158`). Vóór de verifier-flip moeten deze stale `sent`-rijen
**opgeruimd of bewust geaccepteerd** worden (mass-dead-letter-signaal, T-202-03). Dit is
precondition 4 van de go/no-go.

---

## 1. Env-var-contract (per functie, BEIDE dragen beide sets)

Eén Docker-image draagt dispatcher én verifier; `HANDLER` kiest welke draait. Beide functies
dragen **beide** config-sets. `APP_TARGET` schakelt over twee assen tegelijk: BC-API-as
(`BC_ENVIRONMENT`, `BC_COMPANY_ID`) en Service-Bus-as (`SB_NAMESPACE`, `SB_QUEUE`, `SB_KEY_*`,
`SB_ERROR_*`).

### Gedeeld — ALTIJD ongeprefixt (omgeving-onafhankelijk)

| Var | Bron |
|-----|------|
| `BC_TENANT_ID` | Secrets Manager / `.env.prod` |
| `BC_CLIENT_ID` | Secrets Manager / `.env.prod` |
| `BC_CLIENT_SECRET` | Secrets Manager / `.env.prod` (secret) |
| `SUPABASE_URL` | operator |
| `SUPABASE_SERVICE_ROLE_KEY` | operator (secret) |
| `HANDLER` | `dispatcher` of `verifier` (blijft ongewijzigd) |

### Getarget — `SANDBOX_*` / `PROD_*`-paren (resolver, `config.ts:91-103`)

| Basis-key | `PROD_*`-waarde (prod-flip) | Bron |
|-----------|----------------------------|------|
| `BC_ENVIRONMENT` | `PROD_BC_ENVIRONMENT` = prod-BC-omgevingsnaam | operator |
| `BC_COMPANY_ID` | `PROD_BC_COMPANY_ID` = prod-company-UUID (non-food = `2`/mapping-UUID) | operator |
| `SB_NAMESPACE` | `PROD_SB_NAMESPACE` = `sb-bratra-int-prd-weu` | vast |
| `SB_QUEUE` | `PROD_SB_QUEUE` = `bratra-inbound` | vast |
| `SB_KEY_NAME` | `PROD_SB_KEY_NAME` = `BratraPrd` | vast |
| `SB_KEY_VALUE` | `PROD_SB_KEY_VALUE` = SAS-key-waarde | **Secrets Manager / `.env.prod` (secret — nooit committen)** |
| `SB_ERROR_QUEUE` | `PROD_SB_ERROR_QUEUE` = `bratra-error` (default) | optioneel |
| `SB_ERROR_KEY_NAME` | `PROD_SB_ERROR_KEY_NAME` | optioneel — paar met VALUE (`config.ts:44-56`) |
| `SB_ERROR_KEY_VALUE` | `PROD_SB_ERROR_KEY_VALUE` (secret) | optioneel — paar met NAME |

> `SB_ERROR_KEY_NAME`/`SB_ERROR_KEY_VALUE` zijn een **paar**: beide gezet of beide leeg, anders
> fail-fast (kapot SAS-token, `config.ts:44-56`).

> **Prod SAS-key = `BratraPrd` (Send + Listen), niet `producer-send` (send-only).** De verifier
> doet een peek-lock **receive** op `bratra-error` (`error-queue-checker.ts:86`) én op
> `bratra-inbound/$DeadLetterQueue` (`dlq-checker.ts:73`) — dat vereist **Listen**. De oorspronkelijke
> `producer-send`-key was send-only → HTTP 401 op elke receive → de buffer-check werd deferred
> (`handler.ts:82-91`). ERP Company leverde daarom `BratraPrd` (Send+Listen) op `sb-bratra-int-prd-weu`;
> die dekt zowel de dispatcher-send als de verifier-receive. Omdat `SB_ERROR_KEY_*` niet apart gezet is,
> valt de error-queue terug op deze `SB_KEY_*` (`error-queue-checker.ts:456-458`). Geverifieerd
> 2026-07-01: `errorQueue errors=0`, `dlq errors=0`, buffer-check draait.
>
> **Belangrijk (ERP Company-constraint):** Listen op `bratra-inbound` geeft SAS-technisch óók receive op
> de **hoofd**-queue, niet enkel de DLQ. De verifier leest bewust **alléén** `bratra-error` +
> `bratra-inbound/$DeadLetterQueue`, NOOIT de live `bratra-inbound/messages/head` — anders zou hij
> prod-orders kunnen wegnemen vóór BC ze verwerkt. Dit is by-design (geen codepad leest de hoofd-queue).

De `SANDBOX_*`-tegenhangers (`SANDBOX_BC_ENVIRONMENT` = `Sandbox_POC_20251229`,
`SANDBOX_SB_NAMESPACE` = `sb-bratra-int-dev-weu`, etc.) moeten er óók staan zodat de noodrollback
naar sandbox werkt. Volledige contract-referentie: `.env.local.example`.

### Selector-gedrag (`config.ts:119-130`)

| `APP_TARGET` | Resolvet uit | Effect |
|--------------|--------------|--------|
| `sandbox` | `SANDBOX_*`-paren | default, geen flip |
| `production` | `PROD_*`-paren | prod (fase 202, verifier-eerst) |
| leeg / ongezet / whitespace | ongeprefixte legacy-keys | backward-compat (huidige staat) |

---

## 2. Flip-mechanisme

Env vars gaan **direct op de deployed Lambda** via `aws lambda update-function-configuration`,
**NIET** via CI (de `build-test-deploy.yml`-workflow deployt alleen de image, niet de config).

> `update-function-configuration --environment` **vervangt de hele Variables-map**. Lees eerst de
> bestaande map, voeg de nieuwe keys toe en schrijf het volledige samengevoegde object terug —
> anders verlies je bestaande keys. Wacht na elke update op `LastUpdateStatus = Successful`.

**Volgorde: verifier eerst (read-only), dan dispatcher (D6).**

### 2a. Verifier-flip (wave 2 — read-only, geen sends)

1. Voeg op `bratra-bc-sync-verifier` de ontbrekende `SANDBOX_*`- én `PROD_*`-paren toe
   (merge in bestaande Variables-map).
2. Zet `APP_TARGET=production`:

```bash
# Merge PROD_*/SANDBOX_* pairs + APP_TARGET into the EXISTING variables map first,
# then write the full merged map back. Secrets uit .env.prod / Secrets Manager.
aws lambda update-function-configuration \
  --function-name bratra-bc-sync-verifier \
  --environment "Variables={...volledige samengevoegde map incl. APP_TARGET=production...}" \
  --region eu-central-1
```

3. Verifieer read-only: verifier-run leest de **prod**-buffer (HTTP 200) en laat matchende orders
   op `sent`; `Pending`/`Processing` → blijft `sent` (`bc-buffer-checker.ts:280-298`). GEEN sends,
   dus geen onomkeerbare bijwerking.

### 2b. Dispatcher-flip (wave 3 — live sends, ná bevestigde verifier-flip)

1. Voeg dezelfde `SANDBOX_*`/`PROD_*`-paren toe op `bratra-bc-sync-dispatcher` en zet
   `APP_TARGET=production` (zelfde `update-function-configuration`-patroon).
2. Zorg dat de SQS event-source-mapping **enabled** is voor live sends:

```bash
aws lambda update-event-source-mapping \
  --uuid 74760256-d580-4a6a-8de4-2d3d9c21ab8d \
  --enabled --region eu-central-1
```

3. Draai de test-flow (portaal): `skip-historical.sql` → `setup.sql` (no-op w48) → upload
   `Orders W48_TEST.xlsx` (Non-food, week 48, jaar 2026) → import `completed` → approve →
   dispatcher stuurt **alleen** de W48-regels naar de prod-Service-Bus.
4. Valideer t/m **SYNC-05a**: prod-buffer toont de W48-rijen op `Pending` én
   `bc_sync_orders.status = sent`. Verwacht **GEEN** `Done`/`verified`/`bc_document_no`.

---

## 3. Post-test cleanup (D9)

**Onze kant:**
1. `test-data/bc-sync-w48/revert-skip-historical.sql` — herstelt de geskipte historische orders.
2. `test-data/bc-sync-w48/cleanup.sql` — verwijdert de `TEST-%W48%`-data (FK-volgorde kind→ouder;
   raakt W45/W46/W47 niet).
3. Verwijder de W48-test-data verder aan onze kant naar behoefte.

**Bratra-kant:** Bratra ruimt de prod-buffer-`Pending`-rijen op (buffer-processing staat uit, Leo
kan zelf opschonen — bevestigd).

**Eindtoestand:** `APP_TARGET=production` blijft op beide functies staan (D8). Geen rollback.

---

## 4. Noodrollback (ALLEEN bij incident — NIET de eindstap)

Per functie terug naar sandbox:

```bash
# 1. Zet APP_TARGET terug naar sandbox (merge in bestaande map, schrijf volledig terug)
aws lambda update-function-configuration \
  --function-name bratra-bc-sync-verifier \
  --environment "Variables={...bestaande map met APP_TARGET=sandbox...}" \
  --region eu-central-1
# idem voor bratra-bc-sync-dispatcher

# 2. Stop live sends: disable de dispatcher SQS-mapping
aws lambda update-event-source-mapping \
  --uuid 74760256-d580-4a6a-8de4-2d3d9c21ab8d \
  --no-enabled --region eu-central-1
```

De `SANDBOX_*`-paren moeten aanwezig zijn opdat deze rollback resolvet (anders fail-fast).

---

## Referenties

- `src/shared/config.ts` — APP_TARGET-resolver, `SANDBOX_*`/`PROD_*`-paren, gedeelde ongeprefixte keys.
- `src/verifier/bc-buffer-checker.ts` — `Pending`/`Processing`→`sent` (`:280-298`); NotFound>1u→`dead_letter` (`:117-158`).
- `README.md` — "Dual config-set & APP_TARGET", "AWS resources", dispatcher disable/enable.
- `.env.local.example` — volledig `SANDBOX_*`/`PROD_*`-contract (placeholders).
- `.planning/phases/202-bc-sync-prod-flip-e2e/202-CONTEXT.md` — beslissingen D1-D11.
