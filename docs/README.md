# BC Sync — Documentatie

Centrale plek voor alle technische documentatie rondom de Business Central order-integratie.

## Architectuur & contract

| Document | Inhoud |
|---|---|
| [`../README.md`](../README.md) | Architectuur van deze service: dispatcher/verifier-flows, order-lifecycle, Pet Products-routing, env-vars, AWS-resources |
| [`bratra-integration-architecture.pdf`](bratra-integration-architecture.pdf) | ERP Company-kant (van Leo, 11 mei 2026): envelope-contract, idempotency, DLQ-failure-classes, buffer-processor, telemetrie |
| [`bratra-inbound.postman_collection.json`](bratra-inbound.postman_collection.json) + [`_environment.json`](bratra-inbound.postman_environment.json) | Postman-collectie van Leo: 4 requests (happy path, custom envelope, DLQ-demo, multi-order batch) |

## Testen & status

| Document | Inhoud |
|---|---|
| [`test-overzicht-bc-sync.md`](test-overzicht-bc-sync.md) | Overzicht uitgevoerde testen, actuele stand, open punten richting ERP Company, demo-instructies |
| [`test-status-2026-06-04.md`](test-status-2026-06-04.md) | Testverslag 4 juni (gedeeld met Wesley/Leo): dispatch + DLQ E2E geslaagd, buffer-403 en duplicaatvraag open |
| [`vragen-leo-2026-05-22.md`](vragen-leo-2026-05-22.md) | Bevindingen eerste testronde (22 mei) |

Zelf testen: [`../scripts/bc-sync-test.sh`](../scripts/bc-sync-test.sh) (`status` / `dry-run` / `live` / `dlq` / `cleanup`).

## Setup & toegang

| Document | Inhoud |
|---|---|
| [`setup-m2m-authenticatie.md`](setup-m2m-authenticatie.md) | M2M-authenticatie opzetten (App Registration, admin consent) — instructie voor Erik |
| [`Machine-to-Machine authenticatie opzetten voor Business Central.pdf`](<Machine-to-Machine authenticatie opzetten voor Business Central.pdf>) | Zelfde instructie als PDF |
| [`instructie-extra-omgevingen-erik.md`](instructie-extra-omgevingen-erik.md) | App registreren in extra BC-omgevingen (2 min per omgeving) |

## Elders

| Locatie | Inhoud |
|---|---|
| `bratra-projects/docs/management-updates/` | Managementrapportages (MC/Bart) |
| `bratra-projects/docs/features/erpcompany-bc-integration-docs/` | Projecthistorie: mail-tijdlijn en correspondentie met ERP Company, supplier-onboarding-naar-bc |
| `bratra-petfood-bc-integration` (repo) | Verkennings-POC en BC explore-CLI (archief, opgevolgd door deze service) |
