import type { SQSEvent, SQSRecord, ScheduledEvent, Context } from "aws-lambda";
import { randomUUID } from "node:crypto";

import { fetchUnsyncedOrders, fetchFailedSyncRecords, recoverStalePendingRecords } from "./order-fetcher";
import {
  mapOrdersToEnvelope,
  groupOrdersIntoBatches,
  checkEnvelopeSize,
} from "./envelope-mapper";
import { sendToServiceBus } from "../shared/service-bus-client";
import { getSupabaseClient } from "../shared/supabase-client";
import { logSyncEvent } from "../shared/event-logger";
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

/** Extract and validate companyId from SQS message body (T-152.2-02) */
function extractCompanyId(record: SQSRecord): number | null {
  try {
    const body = JSON.parse(record.body) as Partial<SqsTriggerMessage>;
    const { companyId } = body;
    if (typeof companyId !== "number" || !Number.isFinite(companyId)) {
      console.error("Invalid companyId in SQS body", { body: record.body });
      return null;
    }
    return companyId;
  } catch (err) {
    console.error("Failed to parse SQS body", {
      body: record.body,
      error: (err as Error).message,
    });
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
  // Dual-trigger: detect SQS vs ScheduledEvent (D-10)
  let companyId: number;

  if (isSqsEvent(event)) {
    // SQS trigger path: extract companyId from message body (D-11)
    const record = event.Records[0]; // batch_size=1 per D-12
    console.log("Dispatcher handler invoked (SQS trigger)", {
      requestId: context.awsRequestId,
      sqsMessageId: record.messageId,
    });

    const extractedId = extractCompanyId(record);
    if (extractedId === null) {
      // Invalid message -- return success to delete from queue (avoid DLQ pollution)
      console.error("Skipping invalid SQS message");
      return;
    }
    companyId = extractedId;
  } else {
    // ScheduledEvent / manual invoke path (existing behavior)
    console.log("Dispatcher handler invoked (scheduled trigger)", {
      requestId: context.awsRequestId,
    });
    companyId = COMPANY_ID;
  }

  // D-01: Warn if BC_ENVIRONMENT is not sandbox
  const bcEnv = process.env.BC_ENVIRONMENT ?? "";
  if (!bcEnv.startsWith("Sandbox")) {
    console.warn(
      "BC_ENVIRONMENT is not sandbox -- verify this is intentional",
      { BC_ENVIRONMENT: bcEnv },
    );
  }

  const supabase = getSupabaseClient();

  // D-06: in-memory map order_id -> {sync_order_id, po_number, company_id},
  // gevuld bij elke geslaagde `dispatched`-INSERT. Voedt de SB-sent-maar-DB-
  // faalt-edges (happy-path heeft de identiteit al uit `.select()`).
  const dispatchedIdByOrderId = new Map<number, DispatchedIdentity>();

  // 0. Recover orphaned 'pending' records from Lambda crash/timeout (> 5 min old)
  await recoverStalePendingRecords(companyId);

  // 1. Fetch new unsync'd orders
  const newOrders = await fetchUnsyncedOrders(companyId);

  // 2. Fetch failed sync records for re-dispatch
  const failedRecords = await fetchFailedSyncRecords(companyId);

  // 3. Separate new orders from orders that already have a failed sync record
  const failedOrderIds = new Set(failedRecords.map((r) => r.order_id));
  const trulyNewOrders = newOrders.filter((o) => !failedOrderIds.has(o.id));

  if (trulyNewOrders.length === 0 && failedRecords.length === 0) {
    console.log("No orders to dispatch", { companyId });
    return;
  }

  console.log("Orders found", {
    newOrders: trulyNewOrders.length,
    failedForRedispatch: failedRecords.length,
  });

  const summary = {
    ordersSent: 0,
    ordersFailed: 0,
    batchesProcessed: 0,
    retriedOrders: 0,
  };

  // ---- Process NEW orders ----
  if (trulyNewOrders.length > 0) {
    const batches = groupOrdersIntoBatches(trulyNewOrders);

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
              console.warn("Skipping order -- concurrent run already claimed", {
                orderId: batch.orders[i].id,
              });
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
            dispatchedEvents.push({
              sync_order_id: syncOrderId,
              order_id: order.id,
              company_id: order.company_id,
              event_type: "dispatched",
              from_status: null,
              to_status: "pending",
              retry_count: 0,
              message_id: messageId,
              correlation_id: correlationId,
              batch_id: batchId,
              detail: { po_number: order.po_number, batch_id: batchId, message_id: messageId },
            });
          }
        }

        // D-01: bulk-log alle dispatched-events in 1 call ná de loop.
        await logSyncEvent(supabase, dispatchedEvents);

        if (claimedOrders.length === 0) {
          console.log("All orders in batch already claimed", { batchId });
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
          console.warn("Envelope too large, sending orders one by one", {
            batchId,
            orderCount: batch.orders.length,
          });
          // Fallback: send each order individually
          await sendOrdersOneByOne(claimedOrders, batchId, batch.legalEntity, supabase, summary, dispatchedIdByOrderId);
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
          console.error("SB sent but DB status update failed (orders trackable via externalId)", {
            batchId, error: updateError.message,
          });
          // D-06 edge: `.select()` gaf niets -> val terug op de in-memory map.
          const fallbackEvents: BcSyncEventInsert[] = [];
          for (const o of claimedOrders) {
            const ident = dispatchedIdByOrderId.get(o.id);
            if (!ident) continue;
            fallbackEvents.push({
              sync_order_id: ident.sync_order_id,
              order_id: o.id,
              company_id: o.company_id,
              event_type: "sent",
              from_status: "pending",
              to_status: "sent",
              message_id: messageId,
              correlation_id: correlationId,
              batch_id: batchId,
              detail: { po_number: o.po_number, batch_id: batchId, message_id: messageId, db_update_failed: true },
            });
          }
          await logSyncEvent(supabase, fallbackEvents);
        } else {
          const sentEvents: BcSyncEventInsert[] = (sentRows ?? []).map((r) => ({
            sync_order_id: r.id,
            order_id: r.order_id,
            company_id: r.company_id,
            retry_count: r.retry_count,
            event_type: "sent",
            from_status: "pending",
            to_status: "sent",
            message_id: messageId,
            correlation_id: correlationId,
            batch_id: batchId,
            detail: { po_number: r.po_number, batch_id: batchId, message_id: messageId },
          }));
          await logSyncEvent(supabase, sentEvents);
        }

        summary.ordersSent += claimedOrders.length;
      } catch (err) {
        // f. Update tracking records -> failed (D-14)
        const errorMessage = (err as Error).message;
        const failedAt = new Date().toISOString();

        console.error("Batch dispatch failed", {
          batchId,
          error: errorMessage,
        });

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
          console.error("Failed to update sync records to failed", {
            batchId,
            error: failUpdateError.message,
          });
        } else {
          const sendFailedEvents: BcSyncEventInsert[] = (failedRows ?? []).map((r) => ({
            sync_order_id: r.id,
            order_id: r.order_id,
            company_id: r.company_id,
            retry_count: r.retry_count,
            event_type: "send_failed",
            from_status: "pending",
            to_status: "failed",
            batch_id: batchId,
            detail: { po_number: r.po_number, error_message: errorMessage, batch_id: batchId },
          }));
          await logSyncEvent(supabase, sendFailedEvents);
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
      .select("id, po_number, company_id, carrier_code, carrier, req_delivery_date, exp_delivery_date, order_type, unloading_location, truck_proposal, ship_id, shipment_status, req_etd, exp_etd, eta, port_of_departure_code, port_of_departure, port_of_arrival_code, port_of_arrival, container_type, distribution_centers (code, name, location), order_lines (id, line_number, contract_number, req_quantity, exp_quantity, price, pallet_pattern, pallets, category, unit_price_currency, allocation, hazardous_goods, adr, icpe, logistic_group, action_articles!inner (article_number, description), bratra_articles (article_number))")
      .eq("company_id", companyId)
      .in("id", failedOrderIdsList);

    if (failedFetchError) {
      console.error("Failed to fetch warehouse data for re-dispatch -- skipping re-dispatch", {
        error: failedFetchError.message,
        failedOrderCount: failedRecords.length,
      });
      // Don't silently continue -- log to summary and skip re-dispatch entirely
      summary.ordersFailed += failedRecords.length;
      console.log("Dispatch complete (re-dispatch skipped due to DB error)", summary);
      return;
    }

    const failedOrderData = (failedOrderRows ?? []) as unknown as WarehouseOrder[];

    if (failedOrderData.length > 0) {
      const failedBatches = groupOrdersIntoBatches(failedOrderData);

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
              console.error("Failed to reset sync record for re-dispatch", {
                syncRecordId: syncRecord.id,
                orderId: order.id,
                error: updateError.message,
              });
              continue;
            }

            // PostgREST returns 0 rows if status was no longer 'failed' (concurrent claim)
            if (!updatedRows || updatedRows.length === 0) {
              console.warn("Skipping order -- concurrent run already claimed", {
                syncRecordId: syncRecord.id, orderId: order.id,
              });
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
              {
                sync_order_id: syncRecord.id,
                order_id: order.id,
                company_id: order.company_id,
                event_type: "redispatched",
                from_status: "failed",
                to_status: "pending",
                retry_count: newRetryCount,
                message_id: messageId,
                correlation_id: correlationId,
                batch_id: batchId,
                detail: { po_number: order.po_number, batch_id: batchId, message_id: messageId },
              },
            ]);
          }

          if (resetOrders.length === 0) {
            console.warn("No orders successfully reset for re-dispatch in batch", { batchId });
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
            console.warn("Re-dispatch envelope too large, sending one by one", {
              batchId,
            });
            await sendOrdersOneByOne(
              resetOrders,
              batchId,
              batch.legalEntity,
              supabase,
              summary,
              dispatchedIdByOrderId,
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
            console.error("SB re-dispatch sent but DB update failed", {
              batchId, error: sentError.message,
            });
            // D-06 edge (re-dispatch): val terug op de in-memory map.
            const fallbackEvents: BcSyncEventInsert[] = [];
            for (const o of resetOrders) {
              const ident = dispatchedIdByOrderId.get(o.id);
              if (!ident) continue;
              fallbackEvents.push({
                sync_order_id: ident.sync_order_id,
                order_id: o.id,
                company_id: o.company_id,
                event_type: "sent",
                from_status: "pending",
                to_status: "sent",
                message_id: messageId,
                correlation_id: correlationId,
                batch_id: batchId,
                detail: { po_number: o.po_number, batch_id: batchId, message_id: messageId, db_update_failed: true },
              });
            }
            await logSyncEvent(supabase, fallbackEvents);
          } else {
            const sentEvents: BcSyncEventInsert[] = (redispatchSentRows ?? []).map((r) => ({
              sync_order_id: r.id,
              order_id: r.order_id,
              company_id: r.company_id,
              retry_count: r.retry_count,
              event_type: "sent",
              from_status: "pending",
              to_status: "sent",
              message_id: messageId,
              correlation_id: correlationId,
              batch_id: batchId,
              detail: { po_number: r.po_number, batch_id: batchId, message_id: messageId },
            }));
            await logSyncEvent(supabase, sentEvents);
          }

          summary.ordersSent += resetOrders.length;
          summary.retriedOrders += resetOrders.length;
        } catch (err) {
          // d. Update status -> failed
          const errorMessage = (err as Error).message;
          const failedAt = new Date().toISOString();

          console.error("Re-dispatch batch failed", {
            batchId,
            error: errorMessage,
          });

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
            console.error("Failed to update re-dispatched records to failed", {
              batchId,
              error: failError.message,
            });
          } else {
            const sendFailedEvents: BcSyncEventInsert[] = (redispatchFailedRows ?? []).map((r) => ({
              sync_order_id: r.id,
              order_id: r.order_id,
              company_id: r.company_id,
              retry_count: r.retry_count,
              event_type: "send_failed",
              from_status: "pending",
              to_status: "failed",
              batch_id: batchId,
              detail: { po_number: r.po_number, error_message: errorMessage, batch_id: batchId },
            }));
            await logSyncEvent(supabase, sendFailedEvents);
          }

          summary.ordersFailed += resetOrders.length;
        }

        summary.batchesProcessed++;
      }
    }
  }

  // 9. Log summary
  console.log("Dispatch complete", summary);
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
): Promise<void> {
  for (const order of orders) {
    const singleMessageId = randomUUID();
    const singleCorrelationId = `dispatch-single-${new Date().toISOString()}`;

    try {
      const envelope = mapOrdersToEnvelope([order], {
        messageId: singleMessageId,
        correlationId: singleCorrelationId,
        legalEntity,
      });

      if (!checkEnvelopeSize(envelope)) {
        console.error("Single order exceeds envelope size limit", {
          orderId: order.id,
          poNumber: order.po_number,
        });
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

        const oversizedEvents: BcSyncEventInsert[] = (oversizedRows ?? []).map((r) => ({
          sync_order_id: r.id,
          order_id: r.order_id,
          company_id: r.company_id,
          retry_count: r.retry_count,
          event_type: "send_failed",
          from_status: "pending",
          to_status: "failed",
          batch_id: originalBatchId,
          detail: { po_number: r.po_number, error_message: oversizedMessage, batch_id: originalBatchId },
        }));
        await logSyncEvent(supabase, oversizedEvents);

        summary.ordersFailed++;
        continue;
      }

      // Update message_id and external_id for tracking before send
      const { error: metaError } = await supabase
        .from("bc_sync_orders")
        .update({
          message_id: singleMessageId,
          correlation_id: singleCorrelationId,
          external_id: `BRA-AC-${singleMessageId}-${order.po_number}`,
        })
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
        console.error("SB sent but DB update failed (order still trackable via externalId)", {
          orderId: order.id, error: sentError.message,
        });
        // D-06 edge (single): `.select()` gaf niets -> val terug op de map.
        const ident = dispatchedIdByOrderId.get(order.id);
        if (ident) {
          await logSyncEvent(supabase, [
            {
              sync_order_id: ident.sync_order_id,
              order_id: order.id,
              company_id: order.company_id,
              event_type: "sent",
              from_status: "pending",
              to_status: "sent",
              message_id: singleMessageId,
              correlation_id: singleCorrelationId,
              batch_id: originalBatchId,
              detail: { po_number: order.po_number, batch_id: originalBatchId, message_id: singleMessageId, db_update_failed: true },
            },
          ]);
        }
      } else {
        const sentEvents: BcSyncEventInsert[] = (singleSentRows ?? []).map((r) => ({
          sync_order_id: r.id,
          order_id: r.order_id,
          company_id: r.company_id,
          retry_count: r.retry_count,
          event_type: "sent",
          from_status: "pending",
          to_status: "sent",
          message_id: singleMessageId,
          correlation_id: singleCorrelationId,
          batch_id: originalBatchId,
          detail: { po_number: r.po_number, batch_id: originalBatchId, message_id: singleMessageId },
        }));
        await logSyncEvent(supabase, sentEvents);
      }

      summary.ordersSent++;
    } catch (err) {
      console.error("Single order dispatch failed", {
        orderId: order.id,
        error: (err as Error).message,
      });

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

      const singleFailedEvents: BcSyncEventInsert[] = (singleFailedRows ?? []).map((r) => ({
        sync_order_id: r.id,
        order_id: r.order_id,
        company_id: r.company_id,
        retry_count: r.retry_count,
        event_type: "send_failed",
        from_status: "pending",
        to_status: "failed",
        batch_id: originalBatchId,
        detail: { po_number: r.po_number, error_message: singleErrorMessage, batch_id: originalBatchId },
      }));
      await logSyncEvent(supabase, singleFailedEvents);

      summary.ordersFailed++;
    }
  }
}
