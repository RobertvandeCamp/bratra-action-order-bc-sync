#!/usr/bin/env bash
#
# Verifier schedule setup — reproduceerbaar recept voor de cron-trigger + robuustheid
# van de verifier-Lambda (bratra-bc-sync-verifier).
#
# Wat doet dit script (kort):
#   De verifier had in productie GEEN enkele trigger; orders bleven op `sent` hangen.
#   Dit script legt de volledige AWS-configuratie idempotent vast:
#     1. Een EventBridge-rule (cron) die de verifier elke 15 min draait, ma-vr,
#        ~NL kantooruren (UTC-rule; NL-timezone bewust out-of-scope).
#     2. Een lambda resource-policy (permission) zodat EventBridge mag invoken,
#        strikt scoped op DEZE rule-ARN (geen wildcard — threat-mitigatie T-193-01).
#     3. Een target dat de verifier aanroept met Input {"source":"scheduled"} puur
#        voor log-attributie (de handler negeert het event).
#     4. Reserved concurrency = 1 zodat cron en handmatige/`/verify`-aanroep nooit
#        overlappen op de destructieve Service Bus error/DLQ-reads (T-193-02).
#     5. Timeout = 300s zodat een grote batch sequentiële BC-GETs niet halverwege
#        wordt afgebroken.
#   Er wordt GEEN Lambda-code gedeployed; dit is puur ops-config.
#
# Gebruik:
#   ./scripts/setup-verifier-schedule.sh apply     Pas de volledige config toe
#                                                  (idempotent — veilig te herhalen).
#                                                  Default als geen argument is gegeven.
#
#   ./scripts/setup-verifier-schedule.sh status    Read-only overzicht: rule-state,
#                                                  reserved concurrency, timeout en de
#                                                  geconfigureerde targets. Muteert niets.
#
#   ./scripts/setup-verifier-schedule.sh enable    Zet de cron-rule AAN
#                                                  (aws events enable-rule).
#
#   ./scripts/setup-verifier-schedule.sh disable   Zet de cron-rule UIT
#                                                  (aws events disable-rule).
#
# Vereisten:
#   - AWS CLI v2 op PATH met credentials voor account 683001725253 (eu-central-1).
#   - Geen --profile hard-coded; het script vertrouwt op de omgeving (zoals de
#     overige scripts in deze repo).
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# --- Identifiers (zie README 'Verifier schedule' + plan 193) -----------------

REGION="eu-central-1"
ACCOUNT_ID="683001725253"
FUNCTION_NAME="bratra-bc-sync-verifier"
RULE_NAME="bratra-bc-sync-verifier-schedule"
STATEMENT_ID="bratra-bc-sync-verifier-schedule-invoke"
TARGET_ID="verifier"
CRON="cron(0/15 6-16 ? * MON-FRI *)"
RESERVED=1
TIMEOUT=300

FUNCTION_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"
RULE_ARN="arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}"

MODE="${1:-apply}"

usage() {
  echo ""
  echo "Gebruik: ./scripts/setup-verifier-schedule.sh <subcommand>"
  echo ""
  echo "Subcommands:"
  echo "  apply     Pas de volledige verifier-schedule config toe (idempotent, default)"
  echo "  status    Read-only overzicht: rule-state, reserved concurrency, timeout, targets"
  echo "  enable    Zet de cron-rule AAN (aws events enable-rule)"
  echo "  disable   Zet de cron-rule UIT (aws events disable-rule)"
  echo ""
  echo "Lees de header van dit script voor uitleg per subcommand."
  echo ""
}

case "$MODE" in
  apply|status|enable|disable) ;;
  -h|--help|help) usage; exit 0 ;;
  *)
    echo "Onbekend subcommand: $MODE"
    usage
    exit 1
    ;;
esac

# --- Preflight checks --------------------------------------------------------

if ! command -v aws >/dev/null 2>&1; then
  echo "FOUT: AWS CLI niet gevonden. Installeer AWS CLI v2 en configureer credentials."
  exit 1
fi

# Account-guard: de identifiers (ARNs) zijn hard-coded op account 683001725253.
# Draaien met credentials voor een ander account zou ARNs naar het verkeerde account
# laten wijzen en stille faal veroorzaken. Faal hier expliciet bij mismatch.
CALLER_ACCOUNT="$(aws sts get-caller-identity --query Account --output text --region "$REGION" 2>/dev/null || true)"
if [ -z "$CALLER_ACCOUNT" ] || [ "$CALLER_ACCOUNT" = "None" ]; then
  echo "FOUT: kon AWS-account niet bepalen (aws sts get-caller-identity faalde). Check je credentials." >&2
  exit 1
fi
if [ "$CALLER_ACCOUNT" != "$ACCOUNT_ID" ]; then
  echo "FOUT: actieve AWS-account ($CALLER_ACCOUNT) != verwacht ($ACCOUNT_ID)." >&2
  echo "      Verkeerde credentials/omgeving — afgebroken om mutaties op het verkeerde account te voorkomen." >&2
  exit 1
fi

# --- Subcommands -------------------------------------------------------------

apply() {
  echo ""
  echo "Verifier schedule — apply (rule: $RULE_NAME, functie: $FUNCTION_NAME, regio: $REGION)"
  echo "------------------------------------------------------------"

  # 1. EventBridge cron-rule (create-or-update; idempotent).
  #    Behoud de bestaande State: een operator die bewust 'disable' draaide tijdens een
  #    incident mag niet stil her-enabled worden door een re-apply (alleen timeout/
  #    concurrency bijwerken). Nieuwe rule (nog niet bestaand) start ENABLED.
  local desired_state
  desired_state="$(aws events describe-rule --name "$RULE_NAME" --region "$REGION" --query State --output text 2>/dev/null || echo ENABLED)"
  case "$desired_state" in ENABLED|DISABLED) ;; *) desired_state="ENABLED" ;; esac
  aws events put-rule \
    --name "$RULE_NAME" \
    --schedule-expression "$CRON" \
    --state "$desired_state" \
    --description "Cron-trigger voor bratra-bc-sync-verifier: elke 15 min, ma-vr, ~NL kantooruren (UTC)" \
    --region "$REGION" >/dev/null
  echo "[1/5] put-rule OK — cron '$CRON' (${desired_state})."

  # 2. Lambda-permission idempotent: eerst verwijderen (negeer ALLEEN ResourceNotFound op
  #    de eerste run; echte fouten — IAM/throttle/netwerk — moeten zichtbaar zijn),
  #    daarna toevoegen scoped op de rule-ARN (T-193-01, geen wildcard).
  local rm_err
  if ! rm_err="$(aws lambda remove-permission --function-name "$FUNCTION_NAME" --statement-id "$STATEMENT_ID" --region "$REGION" 2>&1)"; then
    if ! printf '%s' "$rm_err" | grep -q "ResourceNotFoundException"; then
      echo "FOUT bij remove-permission (geen ResourceNotFound): $rm_err" >&2
      exit 1
    fi
  fi
  aws lambda add-permission \
    --function-name "$FUNCTION_NAME" \
    --statement-id "$STATEMENT_ID" \
    --action lambda:InvokeFunction \
    --principal events.amazonaws.com \
    --source-arn "$RULE_ARN" \
    --region "$REGION" >/dev/null
  echo "[2/5] add-permission OK — source-arn strikt op rule-ARN (geen wildcard)."

  # 3. Target: koppel de verifier aan de rule met Input {"source":"scheduled"} puur
  #    voor log-attributie (put-targets overschrijft op target-id → idempotent).
  #    Input moet een JSON-STRING zijn; de --targets shorthand-parser kan die geneste
  #    JSON niet aan, dus we leveren het target als JSON via een tijdelijk file://-bestand.
  local targets_json
  targets_json="$(mktemp "${TMPDIR:-/tmp}/verifier-targets-XXXXXX.json")"
  trap 'rm -f "${targets_json:-}"' EXIT   # ruim temp op, ook bij set -e abort
  cat >"$targets_json" <<JSON
[{"Id":"${TARGET_ID}","Arn":"${FUNCTION_ARN}","Input":"{\"source\":\"scheduled\"}"}]
JSON
  # put-targets geeft exit 0 ZELFS als targets niet registreren; de echte uitkomst zit
  # in FailedEntryCount. Lees die expliciet en faal hard bij >0 (anders draait de cron
  # door zonder target en blijven orders stil op `sent` hangen).
  local failed
  failed="$(aws events put-targets \
    --rule "$RULE_NAME" \
    --targets "file://${targets_json}" \
    --region "$REGION" \
    --query FailedEntryCount --output text)"
  rm -f "$targets_json"; trap - EXIT
  if [ "$failed" != "0" ]; then
    echo "FOUT: put-targets registreerde $failed target(s) NIET (FailedEntryCount=$failed)." >&2
    echo "      Controleer FUNCTION_ARN/IAM; de cron is mogelijk niet aan de verifier gekoppeld." >&2
    exit 1
  fi
  echo "[3/5] put-targets OK — verifier gekoppeld met Input {\"source\":\"scheduled\"} (FailedEntryCount=0)."

  # 4. Reserved concurrency = 1 (T-193-02; voorkomt overlappende runs).
  aws lambda put-function-concurrency \
    --function-name "$FUNCTION_NAME" \
    --reserved-concurrent-executions "$RESERVED" \
    --region "$REGION" >/dev/null
  echo "[4/5] put-function-concurrency OK — reserved-concurrent-executions=$RESERVED."

  # 5. Timeout = 300s (grote batch BC-GETs niet halverwege afbreken).
  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --timeout "$TIMEOUT" \
    --region "$REGION" >/dev/null
  echo "[5/5] update-function-configuration OK — timeout=${TIMEOUT}s."

  echo ""
  echo "Klaar. Draai './scripts/setup-verifier-schedule.sh status' om te verifieren."
}

status() {
  echo ""
  echo "Verifier schedule — status (read-only)"
  echo "------------------------------------------------------------"

  echo "Rule-state:"
  aws events describe-rule \
    --name "$RULE_NAME" \
    --region "$REGION" \
    --query "{Name:Name,State:State,Schedule:ScheduleExpression}"

  echo "Reserved concurrency:"
  aws lambda get-function-concurrency \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION"

  echo "Timeout (s):"
  aws lambda get-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --query Timeout

  echo "Targets:"
  aws events list-targets-by-rule \
    --rule "$RULE_NAME" \
    --region "$REGION"
}

enable() {
  aws events enable-rule --name "$RULE_NAME" --region "$REGION"
  echo "Rule '$RULE_NAME' ENABLED."
}

disable() {
  aws events disable-rule --name "$RULE_NAME" --region "$REGION"
  echo "Rule '$RULE_NAME' DISABLED."
}

case "$MODE" in
  apply) apply ;;
  status) status ;;
  enable) enable ;;
  disable) disable ;;
esac
