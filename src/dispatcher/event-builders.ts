import type { BcSyncEventInsert } from "../shared/types";

/**
 * Pure event-builders voor de dispatcher-transities (fase 185, TRACE-01).
 *
 * Elke builder mapt een DB-`.select()`-rij (of, op de D-06 faalpaden, een
 * in-memory fallback-identiteit) naar één `BcSyncEventInsert`. Het `event_type`
 * is per builder HARDcoded (D-02/D-08): de status alleen is niet genoeg, want
 * meerdere event_types mappen op dezelfde status (1:N). De builders zijn puur
 * (geen I/O) zodat de event_type<->status-mapping en de detail-policy
 * (D-03/D-04/D-05) deterministisch te unit-testen zijn.
 */

/** Vorm van de rij die de `dispatched`-INSERT-`.select("id")` teruggeeft. */
export interface DispatchedRow {
  sync_order_id: number;
  order_id: number;
  company_id: number;
  po_number: string;
}

/**
 * Rij-vorm van de status-`.update().select(...)` op `bc_sync_orders`. Eén type
 * voor alle update-sites (sent/send_failed/redispatched/oversized).
 */
export interface SyncOrderRow {
  id: number;
  order_id: number;
  company_id: number;
  po_number: string;
  retry_count: number;
}

/** Gedeelde dispatch-context (batch/message-ids) per transitie. */
export interface DispatchContext {
  batchId: string;
  messageId: string;
  correlationId: string;
}

/**
 * `dispatched`: null -> pending. Per geslaagde per-order INSERT. retry_count is
 * altijd 0 (eerste poging). `sync_order_id` komt uit de zojuist gecreëerde rij.
 */
export function buildDispatchedEvent(
  row: DispatchedRow,
  ctx: DispatchContext,
): BcSyncEventInsert {
  return {
    sync_order_id: row.sync_order_id,
    order_id: row.order_id,
    company_id: row.company_id,
    event_type: "dispatched",
    from_status: null,
    to_status: "pending",
    retry_count: 0,
    message_id: ctx.messageId,
    correlation_id: ctx.correlationId,
    batch_id: ctx.batchId,
    detail: { po_number: row.po_number, batch_id: ctx.batchId, message_id: ctx.messageId },
  };
}

/**
 * `sent` happy-path: pending -> sent. Mapt een `.update().select()`-rij; de
 * status-kolom is bevestigd door PostgREST RETURNING.
 */
export function buildSentEvent(
  row: SyncOrderRow,
  ctx: DispatchContext,
): BcSyncEventInsert {
  return {
    sync_order_id: row.id,
    order_id: row.order_id,
    company_id: row.company_id,
    retry_count: row.retry_count,
    event_type: "sent",
    from_status: "pending",
    to_status: "sent",
    message_id: ctx.messageId,
    correlation_id: ctx.correlationId,
    batch_id: ctx.batchId,
    detail: { po_number: row.po_number, batch_id: ctx.batchId, message_id: ctx.messageId },
  };
}

/**
 * `sent` D-06 faalpad: SB is verstuurd maar de DB-update faalde, dus `.select()`
 * gaf niets. `sync_order_id` komt uit de in-memory map (`DispatchedRow`).
 * `detail.db_update_failed = true` markeert dat de status-kolom achterloopt.
 */
export function buildSentFallbackEvent(
  ident: DispatchedRow,
  ctx: DispatchContext,
): BcSyncEventInsert {
  return {
    sync_order_id: ident.sync_order_id,
    order_id: ident.order_id,
    company_id: ident.company_id,
    event_type: "sent",
    from_status: "pending",
    to_status: "sent",
    message_id: ctx.messageId,
    correlation_id: ctx.correlationId,
    batch_id: ctx.batchId,
    detail: {
      po_number: ident.po_number,
      batch_id: ctx.batchId,
      message_id: ctx.messageId,
      db_update_failed: true,
    },
  };
}

/**
 * `send_failed`: pending -> failed. `detail.error_message` draagt de bestaande
 * dispatcher-foutstring (geen nieuwe blootstelling, T-185-06 accept).
 */
export function buildSendFailedEvent(
  row: SyncOrderRow,
  batchId: string,
  errorMessage: string,
): BcSyncEventInsert {
  return {
    sync_order_id: row.id,
    order_id: row.order_id,
    company_id: row.company_id,
    retry_count: row.retry_count,
    event_type: "send_failed",
    from_status: "pending",
    to_status: "failed",
    batch_id: batchId,
    detail: { po_number: row.po_number, error_message: errorMessage, batch_id: batchId },
  };
}

/**
 * `redispatched`: failed -> pending. `retry_count` is de NIEUWE (opgehoogde)
 * waarde na de reset.
 */
export function buildRedispatchedEvent(
  args: {
    sync_order_id: number;
    order_id: number;
    company_id: number;
    po_number: string;
    retry_count: number;
  },
  ctx: DispatchContext,
): BcSyncEventInsert {
  return {
    sync_order_id: args.sync_order_id,
    order_id: args.order_id,
    company_id: args.company_id,
    event_type: "redispatched",
    from_status: "failed",
    to_status: "pending",
    retry_count: args.retry_count,
    message_id: ctx.messageId,
    correlation_id: ctx.correlationId,
    batch_id: ctx.batchId,
    detail: { po_number: args.po_number, batch_id: ctx.batchId, message_id: ctx.messageId },
  };
}

/**
 * `stale_recovered`: pending -> failed (order-fetcher). `detail` draagt reden +
 * leeftijd in minuten. Geen message/correlation/batch -- de stale-recovery
 * heeft geen dispatch-context.
 */
export function buildStaleRecoveredEvent(
  args: {
    sync_order_id: number;
    order_id: number;
    company_id: number;
    po_number: string;
    retry_count: number;
  },
  reason: string,
  ageMin: number | null,
): BcSyncEventInsert {
  return {
    sync_order_id: args.sync_order_id,
    order_id: args.order_id,
    company_id: args.company_id,
    retry_count: args.retry_count,
    event_type: "stale_recovered",
    from_status: "pending",
    to_status: "failed",
    detail: { po_number: args.po_number, reason, age_min: ageMin },
  };
}
