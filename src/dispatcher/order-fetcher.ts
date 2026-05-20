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
 * Fetch orders that have not been synced to BC yet (no active bc_sync_orders record).
 * Also includes failed orders that are eligible for re-dispatch (retry_count < max_retries).
 *
 * Uses a two-step anti-join pattern because Supabase JS does not support NOT EXISTS:
 *   1. Get order_ids with active sync records (pending/sent/verified)
 *   2. Get orders WHERE id NOT IN those ids
 *   3. Get failed orders eligible for re-dispatch and merge them in
 */
export async function fetchUnsyncedOrders(
  companyId: number,
): Promise<WarehouseOrder[]> {
  const supabase = getSupabaseClient();

  // Step 1: Get order_ids that already have an active sync record
  const { data: syncedOrders, error: syncError } = await supabase
    .from("bc_sync_orders")
    .select("order_id")
    .eq("company_id", companyId)
    .in("status", ["pending", "sent", "verified"]);

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
  const orders: WarehouseOrder[] = (newOrders ?? []) as unknown as WarehouseOrder[];

  // Step 3: Get failed orders eligible for re-dispatch
  const failedRecords = await fetchFailedSyncRecords(companyId);

  if (failedRecords.length > 0) {
    const existingIds = new Set(orders.map((o) => o.id));
    const failedOrderIds = failedRecords
      .map((r) => r.order_id)
      .filter((id) => !existingIds.has(id));

    if (failedOrderIds.length > 0) {
      const { data: failedOrders, error: failedError } = await supabase
        .from("orders")
        .select(ORDER_SELECT)
        .eq("company_id", companyId)
        .in("id", failedOrderIds);

      if (failedError) {
        throw new Error(
          `Failed to query failed orders for company ${companyId}: ${failedError.message}`,
        );
      }

      orders.push(...((failedOrders ?? []) as unknown as WarehouseOrder[]));
    }
  }

  return orders;
}

/**
 * Fetch bc_sync_orders records with status 'failed' and retry_count < max_retries.
 * The handler needs these to UPDATE existing records (not INSERT new ones).
 */
export async function fetchFailedSyncRecords(
  companyId: number,
): Promise<BcSyncOrderRow[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("bc_sync_orders")
    .select("*")
    .eq("company_id", companyId)
    .eq("status", "failed")
    .lt("retry_count", 3); // max_retries default is 3

  if (error) {
    throw new Error(
      `Failed to query failed sync records for company ${companyId}: ${error.message}`,
    );
  }

  return (data ?? []) as BcSyncOrderRow[];
}
