// ============================================================================
// CloudWatch EMF metrics (aws-embedded-metrics).
//
// Verantwoordelijkheid: EMF-records naar stdout (CloudWatch).
// Namespace: "Bratra/BcSync", dimensies: [Service, Target].
//
// Dit is de CANONIEKE bron-module; fase 210 en de importer/trigger-kopieën
// overnemen exact deze code (multi-repo-kopieconventie zoals de v5.10-logger).
//
// Target-resolutie spiegelt logger.ts: process.env.APP_TARGET?.trim() met
// "sandbox" als veilige default voor unset/leeg (geen "legacy" — Target-dim
// accepteert alleen "production" | "sandbox").
// ============================================================================
import { createMetricsLogger, Unit } from "aws-embedded-metrics";

/**
 * Resolve de Target-dimensie op basis van APP_TARGET.
 *
 * - APP_TARGET="production" -> "production"
 * - APP_TARGET="sandbox"    -> "sandbox"
 * - unset / leeg / whitespace -> "sandbox" (veilige default; spiegelt config.ts
 *   resolveTargetPrefix()-logica maar kiest "sandbox" i.p.v. de legacy-prefix
 *   omdat Target-dim alleen production|sandbox mag zijn)
 */
export function resolveMetricsTarget(): "production" | "sandbox" {
  const normalized = process.env.APP_TARGET?.trim();
  return normalized === "production" ? "production" : "sandbox";
}

// ============================================================================
// Dispatcher metrics
// ============================================================================

export interface DispatcherMetricsCounts {
  ordersSent: number;
  ordersFailed: number;
  retriedOrders: number;
  batchesProcessed: number;
}

/**
 * Emit precies één EMF-record voor een dispatcher-run.
 *
 * Namespace: "Bratra/BcSync", dimensies: { Service: "dispatcher", Target }.
 * Metriek-namen (MET-01): OrdersSent, OrdersFailed, RetriedOrders, BatchesProcessed.
 *
 * Roep aan DIRECT NA de dispatch.summary logger.info, zodat een flush-fout
 * het summary-bewijs nooit kan onderdrukken (T-209-03).
 */
export async function emitDispatcherMetrics(counts: DispatcherMetricsCounts): Promise<void> {
  const metrics = createMetricsLogger();
  metrics.setNamespace("Bratra/BcSync");
  metrics.setDimensions({ Service: "dispatcher", Target: resolveMetricsTarget() });
  metrics.putMetric("OrdersSent", counts.ordersSent, Unit.Count);
  metrics.putMetric("OrdersFailed", counts.ordersFailed, Unit.Count);
  metrics.putMetric("RetriedOrders", counts.retriedOrders, Unit.Count);
  metrics.putMetric("BatchesProcessed", counts.batchesProcessed, Unit.Count);
  await metrics.flush();
}

// ============================================================================
// Verifier metrics
// ============================================================================

export interface VerifierMetricsCounts {
  ordersVerified: number;
  ordersBcRejected: number;
  ordersDeadLetter: number;
  /**
   * Aantal DLQ-berichten GEZIEN in deze verifier-run:
   * dlqSummary.processed (verwerkt en uit de queue verwijderd)
   * + dlqSummary.errors (gezien maar verwerking faalde).
   *
   * LET OP: dit is een per-run consumptieteller, GEEN standing queue-diepte
   * (ApproximateNumberOfMessages). De naam "DlqDepth" ligt vast in MET-02 en
   * de fase-210-alarmen bouwen erop — NIET hernoemen. Door errors mee te
   * tellen onderrapporteert de metriek niet juist wanneer de DLQ-checker
   * faalt en de backlog groeit.
   */
  dlqDepth: number;
  errorQueueMessages: number;
  stuckInSent: number;
}

/**
 * Emit precies één EMF-record voor een verifier-run.
 *
 * Namespace: "Bratra/BcSync", dimensies: { Service: "verifier", Target }.
 * Metriek-namen (MET-02): OrdersVerified, OrdersBcRejected, OrdersDeadLetter,
 * DlqDepth, ErrorQueueMessages, StuckInSent.
 *
 * Roep aan DIRECT NA de verify.summary logger.info (T-209-03).
 */
export async function emitVerifierMetrics(counts: VerifierMetricsCounts): Promise<void> {
  const metrics = createMetricsLogger();
  metrics.setNamespace("Bratra/BcSync");
  metrics.setDimensions({ Service: "verifier", Target: resolveMetricsTarget() });
  metrics.putMetric("OrdersVerified", counts.ordersVerified, Unit.Count);
  metrics.putMetric("OrdersBcRejected", counts.ordersBcRejected, Unit.Count);
  metrics.putMetric("OrdersDeadLetter", counts.ordersDeadLetter, Unit.Count);
  metrics.putMetric("DlqDepth", counts.dlqDepth, Unit.Count);
  metrics.putMetric("ErrorQueueMessages", counts.errorQueueMessages, Unit.Count);
  metrics.putMetric("StuckInSent", counts.stuckInSent, Unit.Count);
  await metrics.flush();
}
