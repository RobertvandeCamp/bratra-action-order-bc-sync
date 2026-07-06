import type { SQSEvent, SQSRecord, ScheduledEvent, Context } from "aws-lambda";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import {
  fetchUnsyncedOrders,
  fetchFailedSyncRecords,
  recoverStalePendingRecords,
  assertWarehouseOrders,
} from "./order-fetcher";
import {
  mapOrdersToEnvelope,
  groupOrdersIntoBatches,
  checkEnvelopeSize,
} from "./envelope-mapper";
import { sendToServiceBus } from "../shared/service-bus-client";
import { getConfig } from "../shared/config";
import { getSupabaseClient } from "../shared/supabase-client";
import { logSyncEvent } from "../shared/event-logger";
import { logger, createRunLogger } from "../shared/logger";
import {
  buildDispatchedEvent,
  buildSentEvent,
  buildSentFallbackEvent,
  buildSendFailedEvent,
  buildRedispatchedEvent,
  type DispatchContext,
} from "./event-builders";
import type {
  BcSyncEventInsert,
  BcSyncOrderInsert,
  BcSyncOrderRow,
  SqsTriggerMessage,
  WarehouseOrder,
} from "../shared/types";

/**
 * In-memory fallback voor de D-06 edge: bij de `dispatched`-INSERT-loop vangen
 * we per order de teruggekomen `sync_order_id` (de bc_sync_orders.id). Als
 * later de status-update naar `sent` faalt (SB is al verstuurd, `.select()`
 * geeft niets terug), leveren deze entries de identiteit voor het `sent`-event
 * met `detail.db_update_failed = true`. Key = order_id (action order-id).
 */
type DispatchedIdentity = {
  sync_order_id: number;
  po_number: string;
  company_id: number;
};

/** Dispatcher accepts both SQS (event-driven) and ScheduledEvent (fallback) triggers */
type DispatcherEvent = SQSEvent | ScheduledEvent;

/** Type guard: SQS events have Records[], ScheduledEvent does not */
function isSqsEvent(event: DispatcherEvent): event is SQSEvent {
  return "Records" in event && Array.isArray((event as SQSEvent).Records);
}

/**
 * Extract and validate companyId + traceId from SQS message body (T-152.2-02 / TRACE-04).
 *
 * Returns `null` on parse error or invalid companyId (caller deletes from queue).
 * traceId is returned as-is if present and non-empty; empty string otherwise (caller
 * falls back to context.awsRequestId at the call-site).
 */
export function extractSqsContext(record: SQSRecord): { companyId: number; traceId: string } | null {
  try {
    const body = JSON.parse(record.body) as Partial<SqsTriggerMessage>;
    const { companyId, traceId } = body;
    if (typeof companyId !== "number" || !Number.isFinite(companyId)) {
      logger.error({ body: record.body }, "Invalid companyId in SQS body");
      return null;
    }
    return {
      companyId,
      // Fallback: awsRequestId (ingevuld door caller voor zowel SQS als scheduled)
      traceId: typeof traceId === "string" && traceId.length > 0 ? traceId : "",
    };
  } catch (err) {
    logger.error({ body: record.body, error: (err as Error).message }, "Failed to parse SQS body");
    return null;
  }
}

/** Non-food company (D-04: Non-food first) */
const COMPANY_ID = 2;

/** Postgres unique violation error code */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Dispatcher Lambda handler.
 *
 * Orchestrates: fetch unsync'd orders -> batch -> create tracking records ->
 * map to envelope -> send to Service Bus -> update status.
 *
 * Per-batch error isolation: failure in one batch does not block others.
 * Re-dispatch of failed orders uses UPDATE (not INSERT) on existing bc_sync_orders records.
 *
 * CONSTRAINT D-01: ONLY BC Sandbox. Handler does NOT call BC API (D-02).
 * CONSTRAINT D-02: Sends ONLY to Service Bus via sendToServiceBus(). No direct BC API calls.
 */
export const handler = async (
  event: DispatcherEvent,
  context: Context,
): Promise<void> => {
  // Vóór alle branches, zodat óók het invalid-SQS-pad (round 2 F2) een echte
  // durationMs in zijn dispatch.summary heeft.
  const startMs = Date.now();

  // Dual-trigger: detect SQS vs ScheduledEvent (D-10)
  let companyId: number;
  let traceId: string;

  if (isSqsEvent(event)) {
    // SQS trigger path: extract companyId + traceId from message body (D-11 / TRACE-04)
    const record = event.Records[0]; // batch_size=1 per D-12
    const extracted = extractSqsContext(record);
    if (extracted === null) {
      // Invalid message -- return success to delete from queue (avoid DLQ
      // pollution / SQS-redrive storm). Retry-semantiek: NIET rethrowen.
      //
      // Round 2 F2: dit pad ligt VÓÓR de try/finally-constructie hieronder,
      // dus emit hier zelf precies één dispatch.summary met status "failed"
      // (one-summary-per-run garantie, D-07/D-08). companyId is per definitie
      // onbekend (body onparseerbaar); traceId valt terug op awsRequestId.
      const invalidMsgLogger = createRunLogger({
        traceId: context.awsRequestId,
        requestId: context.awsRequestId,
        trigger: "sqs",
      });
      invalidMsgLogger.error("Skipping invalid SQS message");
      invalidMsgLogger.info(
        {
          event: "dispatch.summary",
          status: "failed",
          reason: "invalid_sqs_message",
          durationMs: Date.now() - startMs,
          ordersSent: 0,
          ordersFailed: 0,
          batchesProcessed: 0,
          retriedOrders: 0,
        },
        "dispatch.summary",
      );
      return;
    }
    companyId = extracted.companyId;
    traceId = extracted.traceId || context.awsRequestId; // fallback to awsRequestId (TRACE-04)
  } else {
    // ScheduledEvent / manual invoke path (existing behavior)
    companyId = COMPANY_ID;
    traceId = context.awsRequestId; // altijd awsRequestId op scheduled/manual pad (TRACE-04)
  }

  // Run-logger: gebonden aan deze invocatie (traceId, requestId, trigger, companyId)
  const runLogger = createRunLogger({
    traceId,
    requestId: context.awsRequestId,
    trigger: isSqsEvent(event) ? "sqs" : "scheduled",
    companyId,
  });
  runLogger.info("Dispatcher handler invoked");

  // Summary tellers voor het dispatch-run (buiten try: ook bij crash precies één summary-event -- D-07/D-08)
  const summary = {
    ordersSent: 0,
    ordersFailed: 0,
    batchesProcessed: 0,
    retriedOrders: 0,
  };
  // CR-02: een crash buiten de per-batch catches (config, order-fetch, guard)
  // moet dispatch.summary status "failed" geven — dit is het emit-punt voor de
  // 999.25-alarmen; "ok" bij een crash is actief vals bewijs.
  let crashed = false;

  try {
    // D-01: Warn if the RESOLVED BC_ENVIRONMENT is not sandbox. Read it from
    // getConfig() (APP_TARGET-resolver) instead of raw process.env.BC_ENVIRONMENT,
    // so the warning reflects the real target after resolution -- mirrors
    // verifier/handler.ts.
    const config = getConfig();
    if (!config.BC_ENVIRONMENT.startsWith("Sandbox")) {
      runLogger.warn(
        { BC_ENVIRONMENT: config.BC_ENVIRONMENT },
        "BC_ENVIRONMENT is not sandbox -- verify this is intentional",
      );
    }

    const supabase = getSupabaseClient();

    // D-06: in-memory map order_id -> {sync_order_id, po_number, company_id},
    // gevuld bij elke geslaagde `dispatched`-INSERT. Voedt de SB-sent-maar-DB-
    // faalt-edges (happy-path heeft de identiteit al uit `.select()`).
    const dispatchedIdByOrderId = new Map<number, DispatchedIdentity>();

    // 0. Recover orphaned 'pending' records from Lambda crash/timeout (> 5 min old)
    await recoverStalePendingRecords(companyId, traceId, runLogger);

    // 1. Fetch new unsync'd orders
    const newOrders = await fetchUnsyncedOrders(companyId);

    // 2. Fetch failed sync records for re-dispatch
    const failedRecords = await fetchFailedSyncRecords(companyId);

    // 3. Separate new orders from orders that already have a failed sync record
    const failedOrderIds = new Set(failedRecords.map((r) => r.order_id));
    const trulyNewOrders = newOrders.filter((o) => !failedOrderIds.has(o.id));

    if (trulyNewOrders.length === 0 && failedRecords.length === 0) {
      runLogger.info({ companyId }, "No orders to dispatch");
      return; // finally fires → dispatch.summary emitted
    }

    runLogger.info(
      { newOrders: trulyNewOrders.length, failedForRedispatch: failedRecords.length },
      "Orders found",
    );

    // ---- Process NEW orders ----
    if (trulyNewOrders.length > 0) {
      const { batches, skipped } = groupOrdersIntoBatches(trulyNewOrders);

      // Fail-fast (D-04): ongeclassificeerde NEW orders hebben nog geen
      // bc_sync_orders-rij. INSERT een rij met status 'failed' zodat de order
      // traceerbaar is i.p.v. stilletjes te verdwijnen (RESEARCH Open Question 1).
      for (const { order, reason } of skipped) {
        const failedAt = new Date().toISOString();
        runLogger.error(
          { orderId: order.id, poNumber: order.po_number, reason },
          "Skipping unclassified NEW order (fail-fast routing)",
        );

        const failedInsert: BcSyncOrderInsert = {
          status: "failed",
          company_id: order.company_id,
          order_id: order.id,
          po_number: order.po_number,
          error_message: reason,
          failed_at: failedAt,
        };

        const { error: skipInsertError } = await supabase
          .from("bc_sync_orders")
          .insert(failedInsert);

        if (skipInsertError) {
          if (skipInsertError.code === PG_UNIQUE_VIOLATION) {
            // WR-01: concurrent run already inserted a tracking row for this
            // order. The failed-trace row exists, so this is benign -- mirror the
            // batch INSERT path which also skips silently on 23505.
            runLogger.warn({ orderId: order.id }, "Skipping unclassified order -- concurrent run already claimed");
          } else {
            runLogger.error(
              { orderId: order.id, error: skipInsertError.message },
              "Failed to insert failed sync record for skipped order",
            );
          }
        }

        summary.ordersFailed++;
      }

      for (const batch of batches) {
        const batchId = randomUUID();
        const messageId = randomUUID();
        const correlationId = `dispatch-${new Date().toISOString()}`;

        // Track claimed orders outside try for catch block access
        const claimedOrders: WarehouseOrder[] = [];
        try {
          // a. INSERT bc_sync_orders records (status: pending) per D-12
          const insertRecords: BcSyncOrderInsert[] = batch.orders.map(
            (order) => ({
              status: "pending",
              company_id: order.company_id,
              order_id: order.id,
              po_number: order.po_number,
              batch_id: batchId,
              message_id: messageId,
              correlation_id: correlationId,
              external_id: `BRA-AC-${messageId}-${order.po_number}`, // D-11
            }),
          );

          // Insert per order so unique violations only skip the duplicate, not the whole batch
          const dispatchedEvents: BcSyncEventInsert[] = [];
          for (let i = 0; i < insertRecords.length; i++) {
            const { data: insertedRows, error: insertError } = await supabase
              .from("bc_sync_orders")
              .insert(insertRecords[i])
              .select("id");

            if (insertError) {
              if (insertError.code === PG_UNIQUE_VIOLATION) {
                runLogger.debug(
                  { orderId: batch.orders[i].id },
                  "Skipping order -- concurrent run already claimed",
                );
                continue;
              }
              throw new Error(`Failed to insert sync record: ${insertError.message}`);
            }

            const order = batch.orders[i];
            const syncOrderId = (insertedRows ?? [])[0]?.id as number | undefined;
            claimedOrders.push(order);

            // D-06: bewaar de zojuist gecreëerde sync_order_id voor de fallback.
            if (typeof syncOrderId === "number") {
              dispatchedIdByOrderId.set(order.id, {
                sync_order_id: syncOrderId,
                po_number: order.po_number,
                company_id: order.company_id,
              });
              // `dispatched`-event: null -> pending (per geslaagde insert).
              dispatchedEvents.push(
                buildDispatchedEvent(
                  {
                    sync_order_id: syncOrderId,
                    order_id: order.id,
                    company_id: order.company_id,
                    po_number: order.po_number,
                  },
                  { batchId, messageId, correlationId, traceId },
                ),
              );
            }
          }

          // D-01: bulk-log alle dispatched-events in 1 call ná de loop.
          await logSyncEvent(supabase, dispatchedEvents, runLogger);

          if (claimedOrders.length === 0) {
            runLogger.debug({ batchId }, "All orders in batch already claimed");
            summary.batchesProcessed++;
            continue;
          }

          // b. Map only claimed orders to envelope
          const envelope = mapOrdersToEnvelope(claimedOrders, {
            messageId,
            correlationId,
            legalEntity: batch.legalEntity,
          });

          // c. Check envelope size (D-10, T-151-07)
          if (!checkEnvelopeSize(envelope)) {
            runLogger.warn(
              { batchId, orderCount: batch.orders.length },
              "Envelope too large, sending orders one by one",
            );
            // Fallback: send each order individually
            await sendOrdersOneByOne(claimedOrders, batchId, batch.legalEntity, supabase, summary, dispatchedIdByOrderId, false, traceId, runLogger);
            summary.batchesProcessed++;
            continue;
          }

          // d. Send to Service Bus
          await sendToServiceBus(envelope);

          // e. Update tracking records -> sent (D-13)
          const sentAt = new Date().toISOString();
          const { data: sentRows, error: updateError } = await supabase
            .from("bc_sync_orders")
            .update({ status: "sent", sent_at: sentAt })
            .eq("batch_id", batchId)
            .select("id, order_id, company_id, po_number, retry_count");

          if (updateError) {
            // SB message already sent -- do NOT throw (would cause re-dispatch duplicates).
            // Log error; verifier can still find orders via externalId in BC buffer.
            runLogger.error(
              { batchId, error: updateError.message },
              "SB sent but DB status update failed (orders trackable via externalId)",
            );
            // D-06 edge: `.select()` gaf niets -> val terug op de in-memory map.
            const ctx: DispatchContext = { batchId, messageId, correlationId, traceId };
            const fallbackEvents: BcSyncEventInsert[] = [];
            for (const o of claimedOrders) {
              const ident = dispatchedIdByOrderId.get(o.id);
              if (!ident) continue;
              fallbackEvents.push(
                buildSentFallbackEvent(
                  { sync_order_id: ident.sync_order_id, order_id: o.id, company_id: o.company_id, po_number: o.po_number },
                  ctx,
                ),
              );
            }
            await logSyncEvent(supabase, fallbackEvents, runLogger);
          } else {
            const ctx: DispatchContext = { batchId, messageId, correlationId, traceId };
            const sentEvents = (sentRows ?? []).map((r) => buildSentEvent(r, ctx));
            await logSyncEvent(supabase, sentEvents, runLogger);
          }

          summary.ordersSent += claimedOrders.length;
        } catch (err) {
          // f. Update tracking records -> failed (D-14)
          const errorMessage = (err as Error).message;
          const failedAt = new Date().toISOString();

          runLogger.error({ batchId, error: errorMessage }, "Batch dispatch failed");

          const { data: failedRows, error: failUpdateError } = await supabase
            .from("bc_sync_orders")
            .update({
              status: "failed",
              error_message: errorMessage,
              failed_at: failedAt,
            })
            .eq("batch_id", batchId)
            .select("id, order_id, company_id, po_number, retry_count");

          if (failUpdateError) {
            runLogger.error(
              { batchId, error: failUpdateError.message },
              "Failed to update sync records to failed",
            );
          } else {
            const sendFailedEvents = (failedRows ?? []).map((r) =>
              buildSendFailedEvent(r, batchId, errorMessage, traceId),
            );
            await logSyncEvent(supabase, sendFailedEvents, runLogger);
          }

          summary.ordersFailed += claimedOrders.length;
        }

        summary.batchesProcessed++;
      }
    }

    // ---- Re-dispatch FAILED orders (D-05, RESEARCH.md Pitfall 2) ----
    if (failedRecords.length > 0) {
      // Get the warehouse order data for failed orders
      const failedOrderMap = new Map<number, BcSyncOrderRow>();
      for (const rec of failedRecords) {
        failedOrderMap.set(rec.order_id, rec);
      }

      // Fetch warehouse data separately for failed orders (they're excluded from newOrders
      // because 'failed' is in the step 1 anti-join exclusion list)
      const failedOrderIdsList = failedRecords.map((r) => r.order_id);
      const { data: failedOrderRows, error: failedFetchError } = await supabase
        .from("orders")
        .select("id, po_number, company_id, business_unit, approval_status, carrier_code, carrier, req_delivery_date, exp_delivery_date, order_type, unloading_location, truck_proposal, ship_id, shipment_status, req_etd, exp_etd, eta, port_of_departure_code, port_of_departure, port_of_arrival_code, port_of_arrival, container_type, distribution_centers (code, name, location), order_lines (id, line_number, contract_number, req_quantity, exp_quantity, price, pallet_pattern, pallets, category, unit_price_currency, allocation, hazardous_goods, adr, icpe, logistic_group, action_articles!inner (article_number, description), bratra_articles (article_number))")
        .eq("company_id", companyId)
        .eq("approval_status", "approved")
        .in("id", failedOrderIdsList);

      if (failedFetchError) {
        runLogger.error(
          { error: failedFetchError.message, failedOrderCount: failedRecords.length },
          "Failed to fetch warehouse data for re-dispatch -- skipping re-dispatch",
        );
        // Don't silently continue -- update summary and skip re-dispatch entirely.
        // finally will emit dispatch.summary (D-07).
        summary.ordersFailed += failedRecords.length;
        runLogger.warn(
          { failedOrderCount: failedRecords.length },
          "Re-dispatch skipped due to DB fetch error",
        );
        return; // finally fires → dispatch.summary emitted
      }

      // WR-05: guard the load-bearing shape at the re-dispatch fetch boundary.
      const failedOrderData = assertWarehouseOrders(
        failedOrderRows ?? [],
        "re-dispatch warehouse fetch",
      );

      // WR-02: failed rows whose order is no longer 'approved' (rejected/pending)
      // must be terminated ('skipped') so they leave the candidate set, otherwise
      // they keep retry_count < max_retries and are re-fetched every run forever
      // (same unbounded-loop family as CR-01). SYNC-01 already guarantees we do
      // not re-send unapproved orders; this also stops the churn.
      //
      // BUGFIX: absence from failedOrderData is NOT proof of disapproval. The
      // re-dispatch fetch above also drops rows via `action_articles!inner` and
      // other line filters, so a STILL-approved order can be missing purely
      // because a join filtered it out. Marking those 'skipped' would wrongly
      // terminate a healthy order that should be retried. Therefore re-check
      // approval_status explicitly for the absent order_ids with a targeted query
      // and only skip the ones that are GENUINELY not approved.
      const fetchedOrderIds = new Set(failedOrderData.map((o) => o.id));
      const absentOrderIds = failedRecords
        .map((r) => r.order_id)
        .filter((id) => !fetchedOrderIds.has(id));

      let unapprovedRecords: BcSyncOrderRow[] = [];
      if (absentOrderIds.length > 0) {
        const { data: approvalRows, error: approvalCheckError } = await supabase
          .from("orders")
          .select("id, approval_status")
          .eq("company_id", companyId)
          .in("id", absentOrderIds);

        if (approvalCheckError) {
          // Cannot determine approval -- do NOT skip on inference. Leave the rows
          // 'failed' so they remain candidates; a later run re-checks them. This
          // is safe: SYNC-01 still prevents re-sending unapproved orders.
          runLogger.error(
            { error: approvalCheckError.message, absentCount: absentOrderIds.length },
            "Failed to re-check approval_status for absent failed records -- not terminating them",
          );
        } else {
          // An order is genuinely not approved if it is present with a non-approved
          // status, OR if it no longer exists in orders at all (deleted). Orders
          // absent ONLY due to inner-join/article filters re-appear here as
          // 'approved' and are deliberately left for retry.
          const approvedAbsentIds = new Set(
            (approvalRows ?? [])
              .filter((row) => row.approval_status === "approved")
              .map((row) => row.id),
          );
          unapprovedRecords = failedRecords.filter(
            (rec) =>
              !fetchedOrderIds.has(rec.order_id) &&
              !approvedAbsentIds.has(rec.order_id),
          );
        }
      }
      for (const rec of unapprovedRecords) {
        const { error: skipError } = await supabase
          .from("bc_sync_orders")
          .update({
            status: "skipped",
            error_message: "Order no longer approved -- not re-dispatched",
            failed_at: new Date().toISOString(),
          })
          .eq("id", rec.id);

        if (skipError) {
          runLogger.error(
            { syncRecordId: rec.id, orderId: rec.order_id, error: skipError.message },
            "Failed to mark unapproved failed record as skipped",
          );
        } else {
          runLogger.warn(
            { syncRecordId: rec.id, orderId: rec.order_id },
            "Marked failed record skipped -- order no longer approved",
          );
        }
      }

      if (failedOrderData.length > 0) {
        const { batches: failedBatches, skipped: failedSkipped } =
          groupOrdersIntoBatches(failedOrderData);

        // Fail-fast (D-04): ongeclassificeerde re-dispatch orders hebben AL een
        // bc_sync_orders-rij. Markeer die 'failed' met de skip-reason (match op
        // order_id, want de order zit niet in een batch).
        for (const { order, reason } of failedSkipped) {
          const failedAt = new Date().toISOString();
          runLogger.error(
            { orderId: order.id, poNumber: order.po_number, reason },
            "Skipping unclassified re-dispatch order (fail-fast routing)",
          );

          const syncRecord = failedOrderMap.get(order.id);
          if (!syncRecord) {
            summary.ordersFailed++;
            continue;
          }

          // CR-01: increment retry_count so a structurally unroutable order
          // (permanent null/unknown business_unit) eventually reaches max_retries
          // and drops out of fetchFailedSyncRecords -- without this it is
          // re-fetched and re-skipped on every invocation forever (never reaches
          // dead_letter). Mirrors the batch-failure path below (handler.ts ~382).
          const { error: skipUpdateError } = await supabase
            .from("bc_sync_orders")
            .update({
              status: "failed",
              error_message: reason,
              failed_at: failedAt,
              retry_count: syncRecord.retry_count + 1,
            })
            .eq("order_id", order.id);

          if (skipUpdateError) {
            runLogger.error(
              { orderId: order.id, error: skipUpdateError.message },
              "Failed to mark skipped re-dispatch order as failed",
            );
          }

          summary.ordersFailed++;
        }

        for (const batch of failedBatches) {
          const batchId = randomUUID();
          const messageId = randomUUID();
          const correlationId = `redispatch-${new Date().toISOString()}`;

          // Track which orders were successfully reset -- only send those
          const resetOrders: WarehouseOrder[] = [];
          try {
            // a. UPDATE (not INSERT) existing bc_sync_orders records
            for (const order of batch.orders) {
              const syncRecord = failedOrderMap.get(order.id);
              if (!syncRecord) continue;

              const newRetryCount = syncRecord.retry_count + 1;
              const { data: updatedRows, error: updateError } = await supabase
                .from("bc_sync_orders")
                .update({
                  status: "pending",
                  message_id: messageId,
                  correlation_id: correlationId,
                  batch_id: batchId,
                  external_id: `BRA-AC-${messageId}-${order.po_number}`,
                  retry_count: newRetryCount,
                  error_message: null,
                  failed_at: null,
                })
                .eq("id", syncRecord.id)
                .eq("status", "failed") // Optimistic lock: only update if still 'failed'
                .select("id, order_id, company_id, retry_count");

              if (updateError) {
                runLogger.error(
                  { syncRecordId: syncRecord.id, orderId: order.id, error: updateError.message },
                  "Failed to reset sync record for re-dispatch",
                );
                continue;
              }

              // PostgREST returns 0 rows if status was no longer 'failed' (concurrent claim)
              if (!updatedRows || updatedRows.length === 0) {
                runLogger.debug(
                  { syncRecordId: syncRecord.id, orderId: order.id },
                  "Skipping order -- concurrent run already claimed",
                );
                continue;
              }
              resetOrders.push(order);

              // D-06: bewaar de identiteit voor de re-dispatch SB-sent-DB-faalt-edge.
              dispatchedIdByOrderId.set(order.id, {
                sync_order_id: syncRecord.id,
                po_number: order.po_number,
                company_id: order.company_id,
              });

              // `redispatched`-event: failed -> pending (per gereset order).
              await logSyncEvent(supabase, [
                buildRedispatchedEvent(
                  {
                    sync_order_id: syncRecord.id,
                    order_id: order.id,
                    company_id: order.company_id,
                    po_number: order.po_number,
                    retry_count: newRetryCount,
                  },
                  { batchId, messageId, correlationId, traceId },
                ),
              ], runLogger);
            }

            if (resetOrders.length === 0) {
              runLogger.warn({ batchId }, "No orders successfully reset for re-dispatch in batch");
              summary.batchesProcessed++;
              continue;
            }

            // b. Map to envelope and send (only successfully reset orders)
            const envelope = mapOrdersToEnvelope(resetOrders, {
              messageId,
              correlationId,
              legalEntity: batch.legalEntity,
            });

            if (!checkEnvelopeSize(envelope)) {
              runLogger.warn({ batchId }, "Re-dispatch envelope too large, sending one by one");
              await sendOrdersOneByOne(
                resetOrders,
                batchId,
                batch.legalEntity,
                supabase,
                summary,
                dispatchedIdByOrderId,
                true, // re-dispatch: keep stable external_id, unique per-send messageId
                traceId,
                runLogger,
              );
              summary.retriedOrders += resetOrders.length;
              summary.batchesProcessed++;
              continue;
            }

            await sendToServiceBus(envelope);

            // c. Update status -> sent
            const sentAt = new Date().toISOString();
            const { data: redispatchSentRows, error: sentError } = await supabase
              .from("bc_sync_orders")
              .update({ status: "sent", sent_at: sentAt })
              .eq("batch_id", batchId)
              .select("id, order_id, company_id, po_number, retry_count");

            if (sentError) {
              runLogger.error(
                { batchId, error: sentError.message },
                "SB re-dispatch sent but DB update failed",
              );
              // D-06 edge (re-dispatch): val terug op de in-memory map.
              const ctx: DispatchContext = { batchId, messageId, correlationId, traceId };
              const fallbackEvents: BcSyncEventInsert[] = [];
              for (const o of resetOrders) {
                const ident = dispatchedIdByOrderId.get(o.id);
                if (!ident) continue;
                fallbackEvents.push(
                  buildSentFallbackEvent(
                    { sync_order_id: ident.sync_order_id, order_id: o.id, company_id: o.company_id, po_number: o.po_number },
                    ctx,
                  ),
                );
              }
              await logSyncEvent(supabase, fallbackEvents, runLogger);
            } else {
              const ctx: DispatchContext = { batchId, messageId, correlationId, traceId };
              const sentEvents = (redispatchSentRows ?? []).map((r) => buildSentEvent(r, ctx));
              await logSyncEvent(supabase, sentEvents, runLogger);
            }

            summary.ordersSent += resetOrders.length;
            summary.retriedOrders += resetOrders.length;
          } catch (err) {
            // d. Update status -> failed
            const errorMessage = (err as Error).message;
            const failedAt = new Date().toISOString();

            runLogger.error({ batchId, error: errorMessage }, "Re-dispatch batch failed");

            const { data: redispatchFailedRows, error: failError } = await supabase
              .from("bc_sync_orders")
              .update({
                status: "failed",
                error_message: errorMessage,
                failed_at: failedAt,
              })
              .eq("batch_id", batchId)
              .select("id, order_id, company_id, po_number, retry_count");

            if (failError) {
              runLogger.error(
                { batchId, error: failError.message },
                "Failed to update re-dispatched records to failed",
              );
            } else {
              const sendFailedEvents = (redispatchFailedRows ?? []).map((r) =>
                buildSendFailedEvent(r, batchId, errorMessage, traceId),
              );
              await logSyncEvent(supabase, sendFailedEvents, runLogger);
            }

            summary.ordersFailed += resetOrders.length;
          }

          summary.batchesProcessed++;
        }
      }
    }
  } catch (err) {
    crashed = true;
    runLogger.error({ error: (err as Error).message }, "Dispatcher run failed unexpectedly");
    throw err; // rethrow: SQS-retry-semantiek behouden
  } finally {
    // Precies één dispatch.summary per run, ook bij crash of vroege return (D-07/D-08).
    // Emit-punt voor 999.25 EMF-metrics (GEEN rij in bc_sync_events).
    runLogger.info(
      {
        event: "dispatch.summary",
        status: crashed || summary.ordersFailed > 0 ? "failed" : "ok",
        durationMs: Date.now() - startMs,
        ...summary,
      },
      "dispatch.summary",
    );
  }
};

// ============================================================================
// Helper: send orders one-by-one when envelope exceeds size limit
// ============================================================================

/**
 * Fallback for oversized batches: send each order as its own envelope.
 * Updates bc_sync_orders per order (the batch_id was already set during INSERT).
 */
async function sendOrdersOneByOne(
  orders: WarehouseOrder[],
  originalBatchId: string,
  legalEntity: string,
  supabase: ReturnType<typeof getSupabaseClient>,
  summary: { ordersSent: number; ordersFailed: number },
  dispatchedIdByOrderId: Map<number, DispatchedIdentity>,
  // WR-04: on re-dispatch the row was already claimed-as-pending with a stable
  // external_id (the verifier reconciles BC buffer records by external_id).
  // Re-randomizing the external_id here would churn it and break that
  // reconciliation, so the re-dispatch caller signals (isRedispatch) that the
  // row's external_id must be left untouched. The NEW path omits it and gets a
  // fresh single-send external_id as before.
  isRedispatch = false,
  traceId: string,
  runLogger: Logger,
): Promise<void> {
  for (const order of orders) {
    // BUGFIX (Duplicate Service Bus message IDs): every individual send MUST get
    // a UNIQUE broker MessageId. Previously the re-dispatch path reused one
    // shared batch messageId for every one-by-one POST, so each envelope (and
    // thus each BrokerProperties.MessageId) was identical -> the broker
    // deduplicated/rejected the later sends. The broker messageId is decoupled
    // from external_id: we always mint a fresh per-send id for the envelope,
    // while the stable external_id on the row is preserved on re-dispatch.
    const preserveExternalId = isRedispatch;
    const singleMessageId = randomUUID();
    const singleCorrelationId = `dispatch-single-${new Date().toISOString()}`;

    try {
      const envelope = mapOrdersToEnvelope([order], {
        messageId: singleMessageId,
        correlationId: singleCorrelationId,
        legalEntity,
      });

      if (!checkEnvelopeSize(envelope)) {
        runLogger.error(
          { orderId: order.id, poNumber: order.po_number },
          "Single order exceeds envelope size limit",
        );
        // Mark as failed -- a single order that exceeds 200 KiB is a data issue
        const oversizedMessage = "Single order exceeds 200 KiB envelope size limit";
        const { data: oversizedRows } = await supabase
          .from("bc_sync_orders")
          .update({
            status: "failed",
            error_message: oversizedMessage,
            failed_at: new Date().toISOString(),
          })
          .eq("batch_id", originalBatchId)
          .eq("order_id", order.id)
          .select("id, order_id, company_id, po_number, retry_count");

        const oversizedEvents = (oversizedRows ?? []).map((r) =>
          buildSendFailedEvent(r, originalBatchId, oversizedMessage, traceId),
        );
        await logSyncEvent(supabase, oversizedEvents, runLogger);

        summary.ordersFailed++;
        continue;
      }

      // WR-04: keep the stable external_id on re-dispatch (verifier reconciles
      // by external_id), but still record THIS send's unique broker message_id
      // so the row reflects the id actually sent to the broker. On the NEW path
      // we assign a fresh external_id derived from that same unique messageId.
      const metaUpdate = preserveExternalId
        ? { message_id: singleMessageId, correlation_id: singleCorrelationId }
        : {
            message_id: singleMessageId,
            correlation_id: singleCorrelationId,
            external_id: `BRA-AC-${singleMessageId}-${order.po_number}`,
          };

      const { error: metaError } = await supabase
        .from("bc_sync_orders")
        .update(metaUpdate)
        .eq("batch_id", originalBatchId)
        .eq("order_id", order.id);

      if (metaError) {
        throw new Error(`Failed to update tracking metadata: ${metaError.message}`);
      }

      await sendToServiceBus(envelope);

      const { data: singleSentRows, error: sentError } = await supabase
        .from("bc_sync_orders")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("batch_id", originalBatchId)
        .eq("order_id", order.id)
        .select("id, order_id, company_id, po_number, retry_count");

      if (sentError) {
        // SB message already sent -- log but mark as sent anyway to prevent
        // re-dispatch duplicates. The verifier will pick this up via externalId.
        runLogger.error(
          { orderId: order.id, error: sentError.message },
          "SB sent but DB update failed (order still trackable via externalId)",
        );
        // D-06 edge (single): `.select()` gaf niets -> val terug op de map.
        const singleCtx: DispatchContext = {
          batchId: originalBatchId,
          messageId: singleMessageId,
          correlationId: singleCorrelationId,
          traceId,
        };
        const ident = dispatchedIdByOrderId.get(order.id);
        if (ident) {
          await logSyncEvent(supabase, [
            buildSentFallbackEvent(
              { sync_order_id: ident.sync_order_id, order_id: order.id, company_id: order.company_id, po_number: order.po_number },
              singleCtx,
            ),
          ], runLogger);
        }
      } else {
        const singleCtx: DispatchContext = {
          batchId: originalBatchId,
          messageId: singleMessageId,
          correlationId: singleCorrelationId,
          traceId,
        };
        const sentEvents = (singleSentRows ?? []).map((r) => buildSentEvent(r, singleCtx));
        await logSyncEvent(supabase, sentEvents, runLogger);
      }

      summary.ordersSent++;
    } catch (err) {
      runLogger.error(
        { orderId: order.id, error: (err as Error).message },
        "Single order dispatch failed",
      );

      const singleErrorMessage = (err as Error).message;
      const { data: singleFailedRows } = await supabase
        .from("bc_sync_orders")
        .update({
          status: "failed",
          error_message: singleErrorMessage,
          failed_at: new Date().toISOString(),
        })
        .eq("batch_id", originalBatchId)
        .eq("order_id", order.id)
        .select("id, order_id, company_id, po_number, retry_count");

      const singleFailedEvents = (singleFailedRows ?? []).map((r) =>
        buildSendFailedEvent(r, originalBatchId, singleErrorMessage, traceId),
      );
      await logSyncEvent(supabase, singleFailedEvents, runLogger);

      summary.ordersFailed++;
    }
  }
}
