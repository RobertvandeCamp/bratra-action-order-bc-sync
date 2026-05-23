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
import type {
  BcSyncOrderInsert,
  BcSyncOrderRow,
  SqsTriggerMessage,
  WarehouseOrder,
} from "../shared/types";

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
        for (let i = 0; i < insertRecords.length; i++) {
          const { error: insertError } = await supabase
            .from("bc_sync_orders")
            .insert(insertRecords[i]);

          if (insertError) {
            if (insertError.code === PG_UNIQUE_VIOLATION) {
              console.warn("Skipping order -- concurrent run already claimed", {
                orderId: batch.orders[i].id,
              });
              continue;
            }
            throw new Error(`Failed to insert sync record: ${insertError.message}`);
          }
          claimedOrders.push(batch.orders[i]);
        }

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
          await sendOrdersOneByOne(claimedOrders, batchId, batch.legalEntity, supabase, summary);
          summary.batchesProcessed++;
          continue;
        }

        // d. Send to Service Bus
        await sendToServiceBus(envelope);

        // e. Update tracking records -> sent (D-13)
        const sentAt = new Date().toISOString();
        const { error: updateError } = await supabase
          .from("bc_sync_orders")
          .update({ status: "sent", sent_at: sentAt })
          .eq("batch_id", batchId);

        if (updateError) {
          // SB message already sent -- do NOT throw (would cause re-dispatch duplicates).
          // Log error; verifier can still find orders via externalId in BC buffer.
          console.error("SB sent but DB status update failed (orders trackable via externalId)", {
            batchId, error: updateError.message,
          });
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

        const { error: failUpdateError } = await supabase
          .from("bc_sync_orders")
          .update({
            status: "failed",
            error_message: errorMessage,
            failed_at: failedAt,
          })
          .eq("batch_id", batchId);

        if (failUpdateError) {
          console.error("Failed to update sync records to failed", {
            batchId,
            error: failUpdateError.message,
          });
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

            const { data: updatedRows, error: updateError } = await supabase
              .from("bc_sync_orders")
              .update({
                status: "pending",
                message_id: messageId,
                correlation_id: correlationId,
                batch_id: batchId,
                external_id: `BRA-AC-${messageId}-${order.po_number}`,
                retry_count: syncRecord.retry_count + 1,
                error_message: null,
                failed_at: null,
              })
              .eq("id", syncRecord.id)
              .eq("status", "failed") // Optimistic lock: only update if still 'failed'
              .select("id");

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
            );
            summary.retriedOrders += resetOrders.length;
            summary.batchesProcessed++;
            continue;
          }

          await sendToServiceBus(envelope);

          // c. Update status -> sent
          const sentAt = new Date().toISOString();
          const { error: sentError } = await supabase
            .from("bc_sync_orders")
            .update({ status: "sent", sent_at: sentAt })
            .eq("batch_id", batchId);

          if (sentError) {
            console.error("SB re-dispatch sent but DB update failed", {
              batchId, error: sentError.message,
            });
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

          const { error: failError } = await supabase
            .from("bc_sync_orders")
            .update({
              status: "failed",
              error_message: errorMessage,
              failed_at: failedAt,
            })
            .eq("batch_id", batchId);

          if (failError) {
            console.error("Failed to update re-dispatched records to failed", {
              batchId,
              error: failError.message,
            });
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
        await supabase
          .from("bc_sync_orders")
          .update({
            status: "failed",
            error_message: "Single order exceeds 200 KiB envelope size limit",
            failed_at: new Date().toISOString(),
          })
          .eq("batch_id", originalBatchId)
          .eq("order_id", order.id);

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

      const { error: sentError } = await supabase
        .from("bc_sync_orders")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("batch_id", originalBatchId)
        .eq("order_id", order.id);

      if (sentError) {
        // SB message already sent -- log but mark as sent anyway to prevent
        // re-dispatch duplicates. The verifier will pick this up via externalId.
        console.error("SB sent but DB update failed (order still trackable via externalId)", {
          orderId: order.id, error: sentError.message,
        });
      }

      summary.ordersSent++;
    } catch (err) {
      console.error("Single order dispatch failed", {
        orderId: order.id,
        error: (err as Error).message,
      });

      await supabase
        .from("bc_sync_orders")
        .update({
          status: "failed",
          error_message: (err as Error).message,
          failed_at: new Date().toISOString(),
        })
        .eq("batch_id", originalBatchId)
        .eq("order_id", order.id);

      summary.ordersFailed++;
    }
  }
}
