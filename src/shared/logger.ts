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

// LOG_LEVEL wordt hier BEWUST raw uit process.env gelezen en lokaal
// gevalideerd, NIET via getConfig(): de logger moet ook bestaan wanneer
// config-validatie faalt (kip-ei bij startup-fouten). Round 2 F3: een
// ongeldige waarde valt terug op "info" i.p.v. pino te laten crashen bij
// module-import. Dit is de ENIGE plek die LOG_LEVEL valideert (config.ts
// bevat er bewust géén tweede, dode schema-entry voor).
const PINO_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);
const rawLogLevel = process.env.LOG_LEVEL;
const LOG_LEVEL =
  rawLogLevel !== undefined && PINO_LEVELS.has(rawLogLevel) ? rawLogLevel : "info";

export const logger = pino({
  level: LOG_LEVEL,
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
  trigger: "sqs" | "s3" | "http" | "scheduled" | "manual";
  companyId?: number;
}): pino.Logger {
  return logger.child(context);
}
