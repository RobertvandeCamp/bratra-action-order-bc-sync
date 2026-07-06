import type { ScheduledEvent, Context } from "aws-lambda";

import { getConfig } from "../shared/config";
import { logger } from "../shared/logger";
import { getSupabaseClient } from "../shared/supabase-client";
import { authenticateM2M } from "../shared/bc-auth";
import { fetchAllPages } from "../shared/paginate";
import { checkBufferStatuses } from "./bc-buffer-checker";
import { checkDlqMessages } from "./dlq-checker";
import { checkErrorQueue } from "./error-queue-checker";
import type { BCConfig, BcSyncOrderRow, DlqSummary, ErrorQueueSummary } from "../shared/types";

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
  console.log("Verifier handler invoked", {
    requestId: context.awsRequestId,
  });

  // 1. Validated config
  const config = getConfig();

  // 2. Supabase client
  const supabase = getSupabaseClient();

  // 3. D-01: Sandbox guard
  if (!config.BC_ENVIRONMENT.startsWith("Sandbox")) {
    console.warn(
      "BC_ENVIRONMENT is not sandbox -- verify this is intentional",
      { BC_ENVIRONMENT: config.BC_ENVIRONMENT },
    );
  }

  // 4. Error-queue check FIRST (non-fatal, D-05/ERR-03). Runs BEFORE the sent-orders
  // query so a BC-rejected order is moved to 'bc_rejected' and leaves the 'sent' set
  // before the buffer-check's "NotFound > 1h -> dead_letter" path can mislabel it.
  let errorQueueSummary: ErrorQueueSummary | null = null;
  try {
    errorQueueSummary = await checkErrorQueue(supabase);
  } catch (err) {
    console.error("Error-queue check failed (non-fatal)", { error: (err as Error).message });
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

  // 5-7. Buffer check. Defer ALLEEN wanneer de error-queue-check WEL draaide maar
  // berichten ONVERWERKT liet (errors > 0): dan kan er nog een pending bc_rejected-
  // transitie openstaan en zou de buffer-check een 'sent'-order onterecht naar
  // 'dead_letter' kunnen verouderen. Bij een volledige exception (summary null) NIET
  // meer oneindig deferren -- anders blijven orders bij een persistente fout (verkeerde
  // queue-naam, ongeldige SAS) eeuwig in 'sent' hangen zonder verificatie (PR#5 #2).
  const deferBuffer =
    errorQueueSummary !== null && errorQueueSummary.errors > 0;
  let bufferSummary = null;
  let bufferNote = "no sent orders";

  if (deferBuffer) {
    bufferNote = "deferred (error-queue errors > 0)";
    console.warn(
      "Buffer check deferred: error-queue left unprocessed messages this run (errors > 0) -- skipping to avoid mislabeling a pending bc_rejected order as dead_letter",
      { errorQueueErrors: errorQueueSummary?.errors },
    );
  } else if (!sentOrders || sentOrders.length === 0) {
    console.log("No sent orders to verify");
  } else {
    console.log("Sent orders to verify", { count: sentOrders.length });

    // 5. D-06: M2M auth for BC API
    const token = await authenticateM2M(config.BC_TENANT_ID);

    // 6. Build BCConfig
    const bcConfig: BCConfig = {
      tenantId: config.BC_TENANT_ID,
      environment: config.BC_ENVIRONMENT,
      companyId: config.BC_COMPANY_ID,
    };

    // 7. Check buffer statuses
    bufferSummary = await checkBufferStatuses(sentOrders, token, bcConfig, supabase, logger);
  }

  // 8. DLQ check (non-fatal, always runs -- D-09)
  let dlqSummary: DlqSummary | null = null;
  try {
    dlqSummary = await checkDlqMessages(supabase);
  } catch (err) {
    console.error("DLQ check failed (non-fatal)", { error: (err as Error).message });
  }

  // 9. Log gecombineerde summary (D-10)
  console.log("Verification complete", {
    errorQueue: errorQueueSummary ?? "skipped (error)",
    buffer: bufferSummary ?? bufferNote,
    dlq: dlqSummary ?? "skipped (error)",
  });
};
