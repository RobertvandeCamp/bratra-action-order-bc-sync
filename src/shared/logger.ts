// ============================================================================
// CloudWatch structured logger (pino).
//
// Verantwoordelijkheid: JSON-logs naar stdout (CloudWatch).
// NIET verwarren met event-logger.ts = Supabase-audit (bc_sync_events).
// Context-propagatie via expliciete parameter (D-00b/D-06), niet via
// async-local-storage (Express-specifiek; bewust weggelaten).
// ============================================================================
import pino from "pino";

// service-naam uit HANDLER env (dispatcher/verifier); valt terug op "bc-sync"
const SERVICE = process.env.HANDLER ?? "bc-sync";
// env afgeleid van APP_TARGET (production/sandbox/legacy)
const ENV = process.env.APP_TARGET?.trim() || "legacy";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    service: SERVICE,
    env: ENV,
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Factory: child-logger gebonden aan één Lambda-invocation.
 * Alle logregels van deze run bevatten traceId, requestId, trigger, companyId.
 *
 * @param context - run-context gebonden aan de Lambda-invocatie
 * @returns pino child-logger met gebonden velden
 */
export function createRunLogger(context: {
  traceId: string;
  requestId: string;
  trigger: "sqs" | "scheduled" | "manual";
  companyId?: number;
}): pino.Logger {
  return logger.child(context);
}
