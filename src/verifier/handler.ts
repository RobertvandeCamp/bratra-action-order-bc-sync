import type { ScheduledEvent, Context } from "aws-lambda";

import { getConfig } from "../shared/config";
import { createRunLogger } from "../shared/logger";
import { emitVerifierMetrics } from "../shared/metrics";
import { getSupabaseClient } from "../shared/supabase-client";
import { authenticateM2M } from "../shared/bc-auth";
import { fetchAllPages } from "../shared/paginate";
import { checkBufferStatuses } from "./bc-buffer-checker";
import { checkDlqMessages } from "./dlq-checker";
import { checkErrorQueue } from "./error-queue-checker";
import type { BCConfig, BcSyncOrderRow, DlqSummary, ErrorQueueSummary } from "../shared/types";
import type { VerifySummary } from "./bc-buffer-checker";

/** Non-food company (consistent with dispatcher) */
const COMPANY_ID = 2;

/**
 * Verifier Lambda handler.
 *
 * Orchestrates: query sent orders > 2 min -> M2M auth -> check BC buffer
 * statuses -> log summary.
 *
 * CONSTRAINT D-01: ONLY BC Sandbox. Warns if BC_ENVIRONMENT does not start
 * with "Sandbox" (same pattern as dispatcher).
 */
export const handler = async (
  _event: ScheduledEvent,
  context: Context,
): Promise<void> => {
  const traceId = context.awsRequestId; // verifier heeft altijd zijn eigen run-id
  const runLogger = createRunLogger({
    traceId,
    requestId: context.awsRequestId,
    trigger: "scheduled",
    companyId: COMPANY_ID,
  });

  runLogger.info({ requestId: context.awsRequestId }, "Verifier handler invoked");

  const startMs = Date.now();

  // Summary-accumulators declareren VOOR de try, zodat verify.summary altijd
  // één keer emitted (ook bij een crash) — D-07/D-09.
  let errorQueueSummary: ErrorQueueSummary | null = null;
  let bufferSummary: VerifySummary | null = null;
  // "not reached" tot het expliciete no-sent-orders-pad (WR-02): bij een crash
  // vóór de sent-orders-query mag de summary niet suggereren dat er geen
  // sent orders waren.
  let bufferNote = "not reached";
  let dlqSummary: DlqSummary | null = null;
  let verifyStatus: "ok" | "failed" = "ok";
  // StuckInSent: berekend op de al-opgehaalde sentOrders (sent_at < now-60min),
  // geen extra Supabase-query. Default 0 zodat een crash vóór de fetch geen
  // ongedefinieerde waarde emits.
  let stuckInSent = 0;

  try {
    // 1. Validated config
    const config = getConfig();

    // 2. Supabase client
    const supabase = getSupabaseClient();

    // 3. D-01: Sandbox guard
    if (!config.BC_ENVIRONMENT.startsWith("Sandbox")) {
      runLogger.warn(
        { BC_ENVIRONMENT: config.BC_ENVIRONMENT },
        "BC_ENVIRONMENT is not sandbox -- verify this is intentional",
      );
    }

    // 4. Error-queue check FIRST (non-fatal, D-05/ERR-03). Runs BEFORE the sent-orders
    // query so a BC-rejected order is moved to 'bc_rejected' and leaves the 'sent' set
    // before the buffer-check's "NotFound > 1h -> dead_letter" path can mislabel it.
    try {
      errorQueueSummary = await checkErrorQueue(supabase, runLogger);
    } catch (err) {
      // Non-fatal voor de run, maar WEL een failed-signaal in verify.summary:
      // een checker die volledig faalt (verkeerde queue-naam, ongeldige SAS)
      // mag niet eeuwig status "ok" rapporteren (WR-02, spiegelt dispatch.summary).
      verifyStatus = "failed";
      runLogger.error({ error: (err as Error).message }, "Error-queue check failed (non-fatal)");
    }

    // 5. D-03: Query sent orders older than 2 minutes. Paginated past the PostgREST
    // 1000-row cap (same latent bug as the dispatcher's anti-join): a mass-dispatch
    // can leave >1000 orders simultaneously 'sent', and an unbounded select would
    // silently drop the overflow from verification. `.order("id")` gives the stable
    // paging key the pagination requires.
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    const sentOrders = await fetchAllPages<BcSyncOrderRow>(
      (from, to) =>
        supabase
          .from("bc_sync_orders")
          .select("*")
          .eq("company_id", COMPANY_ID)
          .eq("status", "sent")
          .lt("sent_at", twoMinutesAgo)
          .order("id", { ascending: true })
          .range(from, to),
      "Failed to query sent orders",
    );

    // StuckInSent: orders die al ≥60 min in "sent" staan zonder verificatie.
    // Berekend op de al-opgehaalde sentOrders — geen extra Supabase-query (MET-02).
    const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    stuckInSent = sentOrders.filter(
      (o) => o.sent_at !== null && o.sent_at < sixtyMinutesAgo,
    ).length;

    // 5-7. Buffer check. Defer ALLEEN wanneer de error-queue-check WEL draaide maar
    // berichten ONVERWERKT liet (errors > 0): dan kan er nog een pending bc_rejected-
    // transitie openstaan en zou de buffer-check een 'sent'-order onterecht naar
    // 'dead_letter' kunnen verouderen. Bij een volledige exception (summary null) NIET
    // meer oneindig deferren -- anders blijven orders bij een persistente fout (verkeerde
    // queue-naam, ongeldige SAS) eeuwig in 'sent' hangen zonder verificatie (PR#5 #2).
    const deferBuffer =
      errorQueueSummary !== null && errorQueueSummary.errors > 0;

    if (deferBuffer) {
      bufferNote = "deferred (error-queue errors > 0)";
      runLogger.warn(
        { errorQueueErrors: errorQueueSummary?.errors },
        "Buffer check deferred: error-queue left unprocessed messages this run (errors > 0) -- skipping to avoid mislabeling a pending bc_rejected order as dead_letter",
      );
    } else if (!sentOrders || sentOrders.length === 0) {
      bufferNote = "no sent orders";
      runLogger.info("No sent orders to verify");
    } else {
      runLogger.info({ count: sentOrders.length }, "Sent orders to verify");

      // 5. D-06: M2M auth for BC API
      const token = await authenticateM2M(config.BC_TENANT_ID);

      // 6. Build BCConfig
      const bcConfig: BCConfig = {
        tenantId: config.BC_TENANT_ID,
        environment: config.BC_ENVIRONMENT,
        companyId: config.BC_COMPANY_ID,
      };

      // 7. Check buffer statuses
      bufferSummary = await checkBufferStatuses(sentOrders, token, bcConfig, supabase, runLogger);
    }

    // 8. DLQ check (non-fatal, always runs -- D-09)
    try {
      dlqSummary = await checkDlqMessages(supabase, runLogger);
    } catch (err) {
      // Zelfde WR-02-semantiek als de error-queue-check hierboven.
      verifyStatus = "failed";
      runLogger.error({ error: (err as Error).message }, "DLQ check failed (non-fatal)");
    }
  } catch (err) {
    verifyStatus = "failed";
    runLogger.error({ error: (err as Error).message }, "Verifier run failed unexpectedly");
    // Round 2 F1: rethrow zodat een gecrashte run de Lambda-invocatie laat
    // FALEN (voedt de AWS `Errors`-metric + de 999.25-alarmen; zonder rethrow
    // lijkt een gecrashte verifier-run een geslaagde invocatie). Het finally-
    // blok draait vóór de propagatie, dus verify.summary wordt nog steeds
    // precies één keer emitted. Rethrow is hier veilig: scheduled, idempotent,
    // read-mostly, reserved concurrency 1 (spiegelt dispatcher CR-02).
    throw err;
  } finally {
    // 9. Eén gegarandeerd verify.summary-event per run (D-07/D-08/D-09).
    // Nestels per checker (buffer/dlq/errorQueue) + durationMs + status.
    // Wordt ALLEEN als CloudWatch-logregel geschreven (niet naar bc_sync_events).
    // WR-02: status ook "failed" bij per-item errors in de checker-summaries
    // (spiegelt dispatch.summary, waar één failed order al status "failed" geeft)
    // — anders missen alarmen op verify.summary.status elke persistente
    // partiële failure.
    const checkerErrors =
      (bufferSummary?.errors ?? 0) +
      (dlqSummary?.errors ?? 0) +
      (errorQueueSummary?.errors ?? 0);
    runLogger.info({
      event: "verify.summary",
      status: verifyStatus === "failed" || checkerErrors > 0 ? "failed" : "ok",
      durationMs: Date.now() - startMs,
      buffer: bufferSummary ?? bufferNote,
      dlq: dlqSummary ?? "skipped (error)",
      errorQueue: errorQueueSummary ?? "skipped (error)",
    }, "verify.summary");
    // Metriek-bronnen (MET-02):
    //   OrdersVerified     <- bufferSummary.verified     (BC buffer Done -> verified)
    //   OrdersBcRejected   <- errorQueueSummary.matched  (error-queue matched = bc_rejected-transitie)
    //   OrdersDeadLetter   <- bufferSummary.deadLetter   (>1h NotFound -> dead_letter)
    //   DlqDepth           <- dlqSummary.processed + errors (DLQ-berichten GEZIEN deze run,
    //                         incl. verwerkingsfouten; per-run teller, GEEN queue-diepte —
    //                         zie docstring op VerifierMetricsCounts.dlqDepth)
    //   ErrorQueueMessages <- errorQueueSummary.deleted  (error-queue-berichten geconsumeerd)
    //   StuckInSent        <- stuckInSent                (al-opgehaalde sent-set, sent_at < now-60min)
    await emitVerifierMetrics({
      ordersVerified: bufferSummary?.verified ?? 0,
      ordersBcRejected: errorQueueSummary?.matched ?? 0,
      ordersDeadLetter: bufferSummary?.deadLetter ?? 0,
      dlqDepth: (dlqSummary?.processed ?? 0) + (dlqSummary?.errors ?? 0),
      errorQueueMessages: errorQueueSummary?.deleted ?? 0,
      stuckInSent,
    }).catch((err: Error) => {
      // T-209-03: flush-fout mag het summary-bewijs of de rethrow-semantiek nooit beïnvloeden
      runLogger.warn({ error: err.message, event: "metrics.flush_error" }, "metrics.flush_error");
    });
  }
};
