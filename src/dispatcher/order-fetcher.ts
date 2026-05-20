import { getSupabaseClient } from "../shared/supabase-client";
import type { WarehouseOrder, BcSyncOrderRow } from "../shared/types";

const ORDER_SELECT = `
  id, po_number, company_id, carrier_code, carrier,
  req_delivery_date, exp_delivery_date,
  order_type, unloading_location, truck_proposal,
  ship_id, shipment_status,
  req_etd, exp_etd, eta,
  port_of_departure_code, port_of_departure,
  port_of_arrival_code, port_of_arrival,
  container_type,
  distribution_centers (code, name, location),
  order_lines (
    id, line_number, contract_number,
    req_quantity, exp_quantity, price,
    pallet_pattern, pallets,
    category, unit_price_currency, allocation,
    hazardous_goods, adr, icpe, logistic_group,
    action_articles!inner (article_number, description),
    bratra_articles (article_number)
  )
`;

/**
 * Fetch orders that have not been synced to BC yet (no bc_sync_orders record in any status).
 *
 * Uses a two-step anti-join pattern because Supabase JS does not support NOT EXISTS:
 *   1. Get order_ids with ANY sync record (all statuses)
 *   2. Get orders WHERE id NOT IN those ids
 *
 * Failed orders eligible for re-dispatch are handled separately by the handler
 * via fetchFailedSyncRecords() + dedicated warehouse data fetch.
 */
export async function fetchUnsyncedOrders(
  companyId: number,
): Promise<WarehouseOrder[]> {
  const supabase = getSupabaseClient();

  // Step 1: Get order_ids that should NOT be fetched as new:
  // - active sync records (pending/sent/verified)
  // - failed records (retry-eligible ones are re-fetched in step 3 via fetchFailedSyncRecords)
  // - dead_letter records (permanently failed)
  // - skipped records
  const { data: syncedOrders, error: syncError } = await supabase
    .from("bc_sync_orders")
    .select("order_id")
    .eq("company_id", companyId)
    .in("status", ["pending", "sent", "verified", "failed", "dead_letter", "skipped"]);

  if (syncError) {
    throw new Error(
      `Failed to query synced order_ids for company ${companyId}: ${syncError.message}`,
    );
  }

  const syncedOrderIds = (syncedOrders ?? []).map(
    (r: { order_id: number }) => r.order_id,
  );

  // Step 2: Get orders NOT in synced list, with nested relations
  let query = supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("company_id", companyId);

  if (syncedOrderIds.length > 0) {
    query = query.not(
      "id",
      "in",
      `(${syncedOrderIds.join(",")})`,
    );
  }

  const { data: newOrders, error: orderError } = await query;

  if (orderError) {
    throw new Error(
      `Failed to query orders for company ${companyId}: ${orderError.message}`,
    );
  }

  // Cast via unknown: Supabase untyped client infers distribution_centers as array,
  // but the FK on distribution_center_id makes it a single object at runtime.
  // Note: failed orders are handled separately by the handler (fetchFailedSyncRecords +
  // dedicated warehouse data fetch) to avoid redundant DB calls.
  return (newOrders ?? []) as unknown as WarehouseOrder[];
}

/**
 * Fetch bc_sync_orders records with status 'failed' and retry_count < max_retries.
 * The handler needs these to UPDATE existing records (not INSERT new ones).
 */
export async function fetchFailedSyncRecords(
  companyId: number,
): Promise<BcSyncOrderRow[]> {
  const supabase = getSupabaseClient();

  // Fetch all failed records, then filter retry_count < max_retries in JS
  // (PostgREST cannot compare two columns directly)
  const { data: allFailed, error } = await supabase
    .from("bc_sync_orders")
    .select("*")
    .eq("company_id", companyId)
    .eq("status", "failed");

  if (error) {
    throw new Error(
      `Failed to query failed sync records for company ${companyId}: ${error.message}`,
    );
  }

  return (allFailed ?? []).filter(
    (r: BcSyncOrderRow) => r.retry_count < r.max_retries,
  ) as BcSyncOrderRow[];
}

/**
 * Recover orphaned 'pending' records stuck after a Lambda crash/timeout.
 * Records in 'pending' older than 5 minutes are reset to 'failed' so
 * the re-dispatch flow can pick them up.
 */
export async function recoverStalePendingRecords(
  companyId: number,
): Promise<number> {
  const supabase = getSupabaseClient();
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: staleRows, error } = await supabase
    .from("bc_sync_orders")
    .update({
      status: "failed",
      error_message: "Recovered from stale pending (Lambda crash/timeout)",
      failed_at: new Date().toISOString(),
    })
    .eq("company_id", companyId)
    .eq("status", "pending")
    .lt("queued_at", fiveMinutesAgo)
    .select("id");

  if (error) {
    console.error("Failed to recover stale pending records", { error: error.message });
    return 0;
  }

  const count = staleRows?.length ?? 0;
  if (count > 0) {
    console.warn("Recovered stale pending records", { count, companyId });
  }
  return count;
}
