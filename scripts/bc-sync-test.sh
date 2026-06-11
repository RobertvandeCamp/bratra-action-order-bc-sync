#!/usr/bin/env bash
#
# BC Sync test runner — demonstratie- en testscript voor de Action Order BC-koppeling.
#
# Wat doet de koppeling (kort):
#   Datawarehouse (Supabase) --> Dispatcher --> Azure Service Bus --> ERP Company --> BC buffer-tabel
#                                                                                        |
#   Tracking (bc_sync_orders) <-- Verifier  <-- BC buffer-API (Read op Table 55001) <----+
#
# Dit script draait de lokale E2E-test (scripts/test-local.ts) tegen de BC SANDBOX.
# Er zit een harde guard in: als BC_ENVIRONMENT niet met "Sandbox" begint, stopt de test.
#
# Gebruik:
#   ./scripts/bc-sync-test.sh status     Waar staan we nu? Tellingen per sync-status,
#                                        laatste verzending, DLQ-archief, en een LIVE
#                                        check op de BC buffer-API (toont het open
#                                        leesrechten-punt richting ERP Company).
#                                        Read-only, altijd veilig.
#
#   ./scripts/bc-sync-test.sh dry-run    Haal 2 echte orders uit het datawarehouse en
#                                        bouw het bericht (envelope) dat naar BC zou
#                                        gaan. Verstuurt NIETS. Laat zien wat we
#                                        precies op de Service Bus zetten.
#
#   ./scripts/bc-sync-test.sh live       Verstuur 2 orders naar de Service Bus sandbox,
#                                        wacht 30s en probeer de status in BC terug te
#                                        lezen (verifier). Dit is de volledige E2E-test.
#
#   ./scripts/bc-sync-test.sh dlq        Kijk in de Dead Letter Queue (peek-only,
#                                        verwijdert niets). Toont afgekeurde berichten
#                                        en de reden van afkeuring.
#
#   ./scripts/bc-sync-test.sh cleanup    Ruim test-tracking-records op (batch_id met
#                                        TEST-prefix) zodat de test herhaalbaar is.
#
# Vereisten:
#   - Node.js 22+
#   - .env.local in de repo-root met credentials (zie .env.local.example)
#   - npm install eenmalig uitgevoerd
#
# Typische demo-volgorde (bijv. voor Wesley):
#   1. status    -> waar staan we, incl. de 403 op de buffer-API
#   2. dry-run   -> dit bericht sturen we ("wat doe je dan precies?")
#   3. live      -> en zo gaat hij echt de Service Bus op
#   4. dlq       -> en zo bewaken we afgekeurde berichten
#   5. cleanup   -> testdata opruimen
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

MODE="${1:-}"

usage() {
  echo ""
  echo "Gebruik: ./scripts/bc-sync-test.sh <mode>"
  echo ""
  echo "Modes:"
  echo "  status    Statusoverzicht: tellingen, laatste verzending, DLQ, buffer-API check (read-only)"
  echo "  dry-run   Bouw het BC-bericht voor 2 orders, verstuur niets"
  echo "  live      Verstuur 2 orders naar Service Bus sandbox + verifieer in BC"
  echo "  dlq       Bekijk Dead Letter Queue (peek-only)"
  echo "  cleanup   Verwijder test-tracking-records (TEST- prefix)"
  echo ""
  echo "Lees de header van dit script voor uitleg per mode."
  echo ""
}

if [[ -z "$MODE" ]]; then
  usage
  exit 1
fi

case "$MODE" in
  status|dry-run|live|dlq|cleanup) ;;
  -h|--help|help) usage; exit 0 ;;
  *)
    echo "Onbekende mode: $MODE"
    usage
    exit 1
    ;;
esac

# --- Preflight checks --------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  echo "FOUT: Node.js niet gevonden. Installeer Node.js 22+."
  exit 1
fi

NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "FOUT: Node.js 22+ vereist, gevonden: $(node -v)"
  exit 1
fi

if [[ ! -f .env.local ]]; then
  echo "FOUT: .env.local ontbreekt in $REPO_DIR"
  echo "Kopieer .env.local.example en vul de credentials in."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "node_modules ontbreekt — eerst 'npm install' draaien..."
  npm install
fi

# --- Run ---------------------------------------------------------------------

echo ""
echo "BC Sync test — mode: $MODE (repo: $REPO_DIR)"
echo "------------------------------------------------------------"

npm run --silent test:local -- "$MODE"
