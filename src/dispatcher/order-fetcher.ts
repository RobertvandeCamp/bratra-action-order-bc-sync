import type { Logger } from "pino";

import { getSupabaseClient } from "../shared/supabase-client";
import { logSyncEvent } from "../shared/event-logger";
import { fetchAllPages } from "../shared/paginate";
import { buildStaleRecoveredEvent } from "./event-builders";
import type { WarehouseOrder, BcSyncOrderRow, BcSyncEventInsert } from "../shared/types";

const ORDER_SELECT = `
  id, po_number, company_id, business_unit, approval_status, carrier_code, carrier,
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
 * WR-05: lightweight runtime guard at the warehouse-fetch I/O boundary.
 *
 * The Supabase client is untyped, so the result is cast to WarehouseOrder[].
 * Because the WarehouseOrder type is hand-synced (not generated), a renamed
 * column or dropped relation surfaces later as an opaque undefined/NaN deep
 * inside mapOrder. This guard asserts only the non-null assumptions that
 * mapOrder/mapOrderLine actually dereference (order_lines array,
 * action_articles.article_number), failing fast at the boundary instead.
 *
 * Not a full schema validation (Zod would be over-engineering here per the
 * review) -- just the load-bearing shape mapOrder relies on.
 */
export function assertWarehouseOrders(
  rows: unknown,
  context: string,
): WarehouseOrder[] {
  if (!Array.isArray(rows)) {
    throw new Error(`${context}: expected an array of orders, got ${typeof rows}`);
  }
  for (const row of rows) {
    const o = row as Partial<WarehouseOrder>;
    if (o == null || typeof o.id !== "number") {
      throw new Error(`${context}: order row missing numeric 'id'`);
    }
    if (!Array.isArray(o.order_lines)) {
      throw new Error(
        `${context}: order ${o.id} missing 'order_lines' array (relation renamed/dropped?)`,
      );
    }
    for (const line of o.order_lines) {
      const article = line?.action_articles;
      if (article == null || typeof article.article_number !== "string") {
        throw new Error(
          `${context}: order ${o.id} line ${line?.id ?? "?"} missing action_articles.article_number`,
        );
      }
    }
  }
  return rows as WarehouseOrder[];
}

/** Chunk size for the id-restricted full-row fetch (keeps the `in(...)` URL bounded). */
const CHUNK_SIZE = 500;

/**
 * Fetch orders that have not been synced to BC yet (no bc_sync_orders record in any status).
 *
 * Uses an in-memory anti-join because Supabase JS does not support NOT EXISTS, and
 * the previous `NOT IN (<all synced ids>)` URL did not scale to thousands of ids:
 *   1. Collect ALL synced order_ids (any status), paginated past the 1000-row cap.
 *   2a. Collect ALL approved order ids (ids only -- cheap), paginated.
 *   2b. Anti-join in memory: approved ids minus synced ids.
 *   2c. Fetch full order rows for the unsynced ids, chunked.
 *
 * Failed orders eligible for re-dispatch are handled separately by the handler
 * via fetchFailedSyncRecords() + dedicated warehouse data fetch.
 */
export async function fetchUnsyncedOrders(
  companyId: number,
): Promise<WarehouseOrder[]> {
  const supabase = getSupabaseClient();

  // Step 1: collect order_ids that already have ANY bc_sync_orders record.
  // The status filter is intentionally dropped: the contract is "no bc_sync_orders
  // record in ANY status", so every record counts -- a superset is exactly what the
  // anti-join needs. This also keeps terminal statuses (skipped/dead_letter/
  // bc_rejected) excluded from re-dispatch, including bc_rejected which the phase-183
  // partial unique index does not constrain (ERR-04).
  const syncedRows = await fetchAllPages<{ order_id: number }>(
    (from, to) =>
      supabase
        .from("bc_sync_orders")
        .select("order_id")
        .eq("company_id", companyId)
        .order("id", { ascending: true }) // stable paging key (PK)
        .range(from, to),
    `Failed to query synced order_ids for company ${companyId}`,
  );
  const syncedOrderIds = new Set<number>(syncedRows.map((r) => r.order_id));

  // Step 2a: collect ALL approved order ids (ids only -- cheap), paginated.
  const approvedRows = await fetchAllPages<{ id: number }>(
    (from, to) =>
      supabase
        .from("orders")
        .select("id")
        .eq("company_id", companyId)
        .eq("approval_status", "approved")
        .order("id", { ascending: true }) // stable paging key (PK)
        .range(from, to),
    `Failed to query approved order ids for company ${companyId}`,
  );

  // Step 2b: anti-join in memory.
  const unsyncedIds = approvedRows
    .map((r) => r.id)
    .filter((id) => !syncedOrderIds.has(id));

  // Step 2c: nothing new -> done (avoids an empty `in()` query).
  if (unsyncedIds.length === 0) {
    return [];
  }

  // Step 2d: fetch full order rows for the unsynced ids, chunked so the `in(...)`
  // URL stays bounded. Each chunk returns at most CHUNK_SIZE rows (id is unique),
  // well under the 1000-row cap. In steady-state unsyncedIds is small.
  // Re-apply company_id + approval_status here (not just on the Step 2a id query):
  // approval can change between Step 2a and this fetch, so the filter must hold at
  // the warehouse I/O boundary too (SYNC-01).
  const orders: WarehouseOrder[] = [];
  for (let i = 0; i < unsyncedIds.length; i += CHUNK_SIZE) {
    const chunk = unsyncedIds.slice(i, i + CHUNK_SIZE);
    const { data, error } = await supabase
      .from("orders")
      .select(ORDER_SELECT)
      .eq("company_id", companyId)
      .eq("approval_status", "approved")
      .in("id", chunk);

    if (error) {
      throw new Error(
        `Failed to query orders for company ${companyId}: ${error.message}`,
      );
    }

    // Cast via unknown: Supabase untyped client infers distribution_centers as array,
    // but the FK on distribution_center_id makes it a single object at runtime.
    // WR-05: guard the load-bearing shape at the boundary before casting.
    orders.push(...assertWarehouseOrders(data ?? [], "fetchUnsyncedOrders"));
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

  // Fetch all failed records (paginated past the 1000-row cap -- same latent bug
  // as fetchUnsyncedOrders), then filter retry_count < max_retries in JS
  // (PostgREST cannot compare two columns directly).
  const allFailed = await fetchAllPages<BcSyncOrderRow>(
    (from, to) =>
      supabase
        .from("bc_sync_orders")
        .select("*")
        .eq("company_id", companyId)
        .eq("status", "failed")
        .order("id", { ascending: true }) // stable paging key (PK)
        .range(from, to),
    `Failed to query failed sync records for company ${companyId}`,
  );

  return allFailed.filter((r) => r.retry_count < r.max_retries);
}

/**
 * Recover orphaned 'pending' records stuck after a Lambda crash/timeout.
 * Records in 'pending' older than 5 minutes are reset to 'failed' so
 * the re-dispatch flow can pick them up.
 */
export async function recoverStalePendingRecords(
  companyId: number,
  traceId: string,
  runLogger: Logger,
): Promise<number> {
  const supabase = getSupabaseClient();
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const staleReason = "Recovered from stale pending (Lambda crash/timeout)";
  const { data: staleRows, error } = await supabase
    .from("bc_sync_orders")
    .update({
      status: "failed",
      error_message: staleReason,
      failed_at: new Date().toISOString(),
    })
    .eq("company_id", companyId)
    .eq("status", "pending")
    .lt("queued_at", fiveMinutesAgo)
    .select("id, order_id, company_id, retry_count, po_number, queued_at");

  if (error) {
    runLogger.error({ error: error.message }, "Failed to recover stale pending records");
    return 0;
  }

  const count = staleRows?.length ?? 0;
  if (count > 0) {
    runLogger.warn({ count, companyId }, "Recovered stale pending records");

    // `stale_recovered`-event: pending -> failed (per gerecoverde order).
    const now = Date.now();
    const events: BcSyncEventInsert[] = staleRows.map((r) => {
      const ageMin =
        typeof r.queued_at === "string"
          ? Math.round((now - new Date(r.queued_at).getTime()) / 60000)
          : null;
      return buildStaleRecoveredEvent(
        {
          sync_order_id: r.id,
          order_id: r.order_id,
          company_id: r.company_id,
          po_number: r.po_number,
          retry_count: r.retry_count,
        },
        staleReason,
        ageMin,
        traceId,
      );
    });
    await logSyncEvent(supabase, events);
  }
  return count;
}
