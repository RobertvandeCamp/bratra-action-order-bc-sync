import { bcGet } from "../shared/bc-client";
import type {
  BCConfig,
  BcBufferRecord,
  BcSyncOrderRow,
} from "../shared/types";
import type { getSupabaseClient } from "../shared/supabase-client";

// ============================================================================
// Verify Summary
// ============================================================================

export interface VerifySummary {
  verified: number;
  retried: number;
  deadLetter: number;
  pending: number;
  notFound: number;
  errors: number;
}

// ============================================================================
// BC Buffer Checker
// ============================================================================

/**
 * Check BC buffer statuses for sent orders and update bc_sync_orders accordingly.
 *
 * Per order: query bratraSalesOrderBuffers by externalId, interpret the buffer
 * status, and update the sync tracking record in Supabase.
 *
 * Sequential iteration (no Promise.all) to avoid BC API rate limiting.
 */
export async function checkBufferStatuses(
  sentOrders: BcSyncOrderRow[],
  token: string,
  bcConfig: BCConfig,
  supabase: ReturnType<typeof getSupabaseClient>,
): Promise<VerifySummary> {
  const summary: VerifySummary = {
    verified: 0,
    retried: 0,
    deadLetter: 0,
    pending: 0,
    notFound: 0,
    errors: 0,
  };

  for (const order of sentOrders) {
    try {
      // Skip orders without external_id
      if (!order.external_id) {
        console.warn("Order has no external_id, skipping", { orderId: order.id });
        continue;
      }

      // D-04: Query BC buffer by externalId
      const endpoint = `companies(${bcConfig.companyId})/bratraSalesOrderBuffers?$filter=externalId eq '${order.external_id}'`;
      const result = await bcGet<BcBufferRecord>(token, bcConfig, endpoint, {
        paginate: false,
      });

      // D-10: Not found -- buffer not yet arrived at BC
      if (!result.value || result.value.length === 0) {
        console.log("Buffer not found in BC", {
          orderId: order.id,
          externalId: order.external_id,
          action: "not_found",
        });
        summary.notFound++;
        continue;
      }

      const buffer = result.value[0];

      // D-09: Calculate sent_at age for warning check
      const sentAge = Date.now() - new Date(order.sent_at!).getTime();
      const tenMinutes = 10 * 60 * 1000;

      switch (buffer.status) {
        // D-07: Done -> verified
        case "Done": {
          await supabase
            .from("bc_sync_orders")
            .update({
              status: "verified",
              bc_buffer_status: buffer.status,
              bc_document_no: buffer.salesDocumentNo,
              bc_system_id: buffer.systemId,
              bc_entry_no: buffer.entryNo,
              verified_at: new Date().toISOString(),
            })
            .eq("id", order.id);
          summary.verified++;
          console.log("Order verified", {
            orderId: order.id,
            externalId: order.external_id,
            bcBufferStatus: buffer.status,
            bcDocumentNo: buffer.salesDocumentNo,
            action: "verified",
          });
          break;
        }

        // D-08: Error/Fatal -> retry or dead_letter
        case "Error":
        case "Fatal": {
          if (order.retry_count < order.max_retries) {
            await supabase
              .from("bc_sync_orders")
              .update({
                status: "pending",
                bc_buffer_status: buffer.status,
                bc_error_message: buffer.errorMessage,
                retry_count: order.retry_count + 1,
              })
              .eq("id", order.id);
            summary.retried++;
            console.log("Order retried", {
              orderId: order.id,
              externalId: order.external_id,
              bcBufferStatus: buffer.status,
              retryCount: order.retry_count + 1,
              maxRetries: order.max_retries,
              action: "retried",
            });
          } else {
            await supabase
              .from("bc_sync_orders")
              .update({
                status: "dead_letter",
                bc_buffer_status: buffer.status,
                bc_error_message: buffer.errorMessage,
                failed_at: new Date().toISOString(),
              })
              .eq("id", order.id);
            summary.deadLetter++;
            console.log("Order dead-lettered", {
              orderId: order.id,
              externalId: order.external_id,
              bcBufferStatus: buffer.status,
              bcErrorMessage: buffer.errorMessage,
              action: "dead_letter",
            });
          }
          break;
        }

        // D-09: Pending/Processing -> skip, warn if > 10 min
        case "Pending":
        case "Processing": {
          if (sentAge > tenMinutes) {
            console.warn("BC processing taking long", {
              orderId: order.id,
              externalId: order.external_id,
              sentAgeMin: Math.round(sentAge / 60000),
              bcStatus: buffer.status,
            });
          }
          summary.pending++;
          console.log("Order still processing in BC", {
            orderId: order.id,
            externalId: order.external_id,
            bcBufferStatus: buffer.status,
            action: "pending",
          });
          break;
        }

        // Cancelled -> dead_letter (RESEARCH pitfall 5)
        case "Cancelled": {
          await supabase
            .from("bc_sync_orders")
            .update({
              status: "dead_letter",
              bc_buffer_status: "Cancelled",
              bc_error_message: "Buffer cancelled in BC",
              failed_at: new Date().toISOString(),
            })
            .eq("id", order.id);
          summary.deadLetter++;
          console.log("Order cancelled in BC", {
            orderId: order.id,
            externalId: order.external_id,
            bcBufferStatus: buffer.status,
            action: "dead_letter",
          });
          break;
        }

        default: {
          console.warn("Unknown BC buffer status", {
            orderId: order.id,
            externalId: order.external_id,
            bcBufferStatus: buffer.status,
          });
          summary.errors++;
          break;
        }
      }
    } catch (err) {
      console.error("Error checking buffer for order", {
        orderId: order.id,
        error: (err as Error).message,
      });
      summary.errors++;
    }
  }

  return summary;
}
