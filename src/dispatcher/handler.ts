import type { ScheduledEvent, Context } from "aws-lambda";
import { randomUUID } from "node:crypto";

import { fetchUnsyncedOrders, fetchFailedSyncRecords } from "./order-fetcher";
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
  WarehouseOrder,
} from "../shared/types";

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
  _event: ScheduledEvent,
  context: Context,
): Promise<void> => {
  console.log("Dispatcher handler invoked", {
    requestId: context.awsRequestId,
  });

  // D-01: Warn if BC_ENVIRONMENT is not sandbox
  const bcEnv = process.env.BC_ENVIRONMENT ?? "";
  if (!bcEnv.startsWith("Sandbox")) {
    console.warn(
      "BC_ENVIRONMENT is not sandbox -- verify this is intentional",
      { BC_ENVIRONMENT: bcEnv },
    );
  }

  const supabase = getSupabaseClient();

  // 1. Fetch new unsync'd orders
  const newOrders = await fetchUnsyncedOrders(COMPANY_ID);

  // 2. Fetch failed sync records for re-dispatch
  const failedRecords = await fetchFailedSyncRecords(COMPANY_ID);

  // 3. Separate new orders from orders that already have a failed sync record
  const failedOrderIds = new Set(failedRecords.map((r) => r.order_id));
  const trulyNewOrders = newOrders.filter((o) => !failedOrderIds.has(o.id));

  if (trulyNewOrders.length === 0 && failedRecords.length === 0) {
    console.log("No orders to dispatch", { companyId: COMPANY_ID });
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

        const { error: insertError } = await supabase
          .from("bc_sync_orders")
          .insert(insertRecords);

        if (insertError) {
          // Pitfall 4: Handle unique constraint violation (concurrent runs)
          if (insertError.code === PG_UNIQUE_VIOLATION) {
            console.warn("Skipping batch -- concurrent run already claimed these orders", {
              batchId,
              orderIds: batch.orders.map((o) => o.id),
            });
            continue;
          }
          throw new Error(`Failed to insert sync records: ${insertError.message}`);
        }

        // b. Map orders to envelope
        const envelope = mapOrdersToEnvelope(batch.orders, {
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
          await sendOrdersOneByOne(batch.orders, batchId, batch.legalEntity, supabase, summary);
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
          console.error("Failed to update sync records to sent", {
            batchId,
            error: updateError.message,
          });
        }

        summary.ordersSent += batch.orders.length;
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

        summary.ordersFailed += batch.orders.length;
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

    // Fetch warehouse data for the failed order_ids
    const failedOrderData = newOrders.filter((o) => failedOrderIds.has(o.id));

    if (failedOrderData.length > 0) {
      const failedBatches = groupOrdersIntoBatches(failedOrderData);

      for (const batch of failedBatches) {
        const batchId = randomUUID();
        const messageId = randomUUID();
        const correlationId = `redispatch-${new Date().toISOString()}`;

        try {
          // a. UPDATE (not INSERT) existing bc_sync_orders records
          // Track which orders were successfully reset -- only send those
          const resetOrders: WarehouseOrder[] = [];
          for (const order of batch.orders) {
            const syncRecord = failedOrderMap.get(order.id);
            if (!syncRecord) continue;

            const { error: updateError } = await supabase
              .from("bc_sync_orders")
              .update({
                status: "pending",
                message_id: messageId,
                correlation_id: correlationId,
                batch_id: batchId,
                retry_count: syncRecord.retry_count + 1,
                error_message: null,
                failed_at: null,
              })
              .eq("id", syncRecord.id);

            if (updateError) {
              console.error("Failed to reset sync record for re-dispatch", {
                syncRecordId: syncRecord.id,
                orderId: order.id,
                error: updateError.message,
              });
              // Skip this order -- tracking row not reset, would cause duplicate SB messages
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
            console.error("Failed to update re-dispatched records to sent", {
              batchId,
              error: sentError.message,
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

      // Update message_id for tracking before send
      await supabase
        .from("bc_sync_orders")
        .update({
          message_id: singleMessageId,
          correlation_id: singleCorrelationId,
        })
        .eq("batch_id", originalBatchId)
        .eq("order_id", order.id);

      await sendToServiceBus(envelope);

      await supabase
        .from("bc_sync_orders")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("batch_id", originalBatchId)
        .eq("order_id", order.id);

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
