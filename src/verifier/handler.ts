import type { ScheduledEvent, Context } from "aws-lambda";

import { getConfig } from "../shared/config";
import { getSupabaseClient } from "../shared/supabase-client";
import { authenticateM2M } from "../shared/bc-auth";
import { checkBufferStatuses } from "./bc-buffer-checker";
import { checkDlqMessages } from "./dlq-checker";
import type { BCConfig, DlqSummary } from "../shared/types";

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

  // 4. D-03: Query sent orders older than 2 minutes
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const { data: sentOrders, error } = await supabase
    .from("bc_sync_orders")
    .select("*")
    .eq("company_id", COMPANY_ID)
    .eq("status", "sent")
    .lt("sent_at", twoMinutesAgo);

  if (error) {
    throw new Error(`Failed to query sent orders: ${error.message}`);
  }

  // 5-7. Buffer check (only when sent orders exist)
  let bufferSummary = null;

  if (!sentOrders || sentOrders.length === 0) {
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
    bufferSummary = await checkBufferStatuses(sentOrders, token, bcConfig, supabase);
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
    buffer: bufferSummary ?? "no sent orders",
    dlq: dlqSummary ?? "skipped (error)",
  });
};
