import { bcGet } from "../shared/bc-client";
import { logSyncEvent } from "../shared/event-logger";
import type {
  BCConfig,
  BcBufferRecord,
  BcSyncEventInsert,
  BcSyncOrderRow,
} from "../shared/types";
import type { getSupabaseClient } from "../shared/supabase-client";

/**
 * Bouw de identiteit-velden van een `BcSyncEventInsert` uit een in-scope
 * `BcSyncOrderRow` (de hele rij zit al in `sentOrders`, geen `.select()` nodig).
 * Alle verifier-buffer-transities komen vanaf status `sent` (D-07).
 */
export function buildBufferEvent(
  order: BcSyncOrderRow,
  event_type: BcSyncEventInsert["event_type"],
  to_status: BcSyncEventInsert["to_status"],
  detail: Record<string, unknown>,
): BcSyncEventInsert {
  return {
    sync_order_id: order.id,
    order_id: order.order_id,
    company_id: order.company_id,
    event_type,
    from_status: "sent",
    to_status,
    retry_count: order.retry_count,
    message_id: order.message_id,
    correlation_id: order.correlation_id,
    batch_id: order.batch_id,
    detail,
  };
}

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

  // D-01: verzamel per-order events en doe ÉÉN bulk-insert aan het einde. Een
  // event wordt alleen toegevoegd op de success-branch van de bijbehorende
  // status-update (een gefaalde update = transitie vond niet plaats -> geen event).
  const events: BcSyncEventInsert[] = [];

  for (const order of sentOrders) {
    try {
      // Dead-letter orders without external_id (unverifiable)
      if (!order.external_id) {
        const { error: noExtError } = await supabase
          .from("bc_sync_orders")
          .update({
            status: "dead_letter",
            bc_error_message: "Missing external_id — cannot verify in BC",
            failed_at: new Date().toISOString(),
          })
          .eq("id", order.id);
        if (!noExtError) {
          summary.deadLetter++;
          // event_type "dead_lettered" (dubbel-t) -> status "dead_letter" (enkel-t)
          events.push(
            buildBufferEvent(order, "dead_lettered", "dead_letter", {
              po_number: order.po_number,
              reason: "Missing external_id",
            }),
          );
        } else summary.errors++;
        console.warn("Order dead-lettered: no external_id", { orderId: order.id });
        continue;
      }

      // D-04: Query BC buffer by externalId (escape single quotes for OData)
      const safeExternalId = order.external_id.replace(/'/g, "''");
      const endpoint = `companies(${bcConfig.companyId})/bratraSalesOrderBuffers?$filter=externalId eq '${safeExternalId}'`;
      const result = await bcGet<BcBufferRecord>(token, bcConfig, endpoint, {
        paginate: false,
        apiRoute: "api/erpcompany/integration/v1.0",
      });

      // D-10: Not found -- buffer not yet arrived at BC
      if (!result.value || result.value.length === 0) {
        const sentAge = Date.now() - new Date(order.sent_at!).getTime();
        const oneHour = 60 * 60 * 1000;

        if (sentAge > oneHour) {
          // Aging threshold: dead-letter orders not found in BC after 1 hour
          const { error: agingError } = await supabase
            .from("bc_sync_orders")
            .update({
              status: "dead_letter",
              bc_buffer_status: "NotFound",
              bc_error_message: `Buffer not found in BC after ${Math.round(sentAge / 60000)} minutes`,
              failed_at: new Date().toISOString(),
            })
            .eq("id", order.id);
          if (agingError) {
            console.error("Failed to dead-letter aged not-found order", {
              orderId: order.id, error: agingError.message,
            });
            summary.errors++;
          } else {
            summary.deadLetter++;
            events.push(
              buildBufferEvent(order, "dead_lettered", "dead_letter", {
                po_number: order.po_number,
                bc_buffer_status: "NotFound",
                age_min: Math.round(sentAge / 60000),
              }),
            );
            console.warn("Order dead-lettered (not found in BC after 1h)", {
              orderId: order.id, externalId: order.external_id,
              sentAgeMin: Math.round(sentAge / 60000), action: "dead_letter",
            });
          }
        } else {
          console.log("Buffer not found in BC", {
            orderId: order.id, externalId: order.external_id, action: "not_found",
          });
          summary.notFound++;
        }
        continue;
      }

      const buffer = result.value[0];

      // D-09: Calculate sent_at age for warning check
      const sentAge = Date.now() - new Date(order.sent_at!).getTime();
      const tenMinutes = 10 * 60 * 1000;

      switch (buffer.status) {
        // D-07: Done -> verified
        case "Done": {
          const { error: verifyError } = await supabase
            .from("bc_sync_orders")
            .update({
              status: "verified",
              bc_buffer_status: buffer.status,
              bc_document_no: buffer.createdDocumentNo,
              bc_system_id: buffer.systemId,
              bc_entry_no: buffer.entryNo,
              verified_at: new Date().toISOString(),
            })
            .eq("id", order.id);
          if (verifyError) {
            console.error("Failed to update order to verified", {
              orderId: order.id, error: verifyError.message,
            });
            summary.errors++;
            break;
          }
          summary.verified++;
          events.push(
            buildBufferEvent(order, "verified", "verified", {
              po_number: order.po_number,
              bc_buffer_status: buffer.status,
            }),
          );
          console.log("Order verified", {
            orderId: order.id,
            externalId: order.external_id,
            bcBufferStatus: buffer.status,
            bcDocumentNo: buffer.createdDocumentNo,
            action: "verified",
          });
          break;
        }

        // D-08: Error/Fatal -> retry or dead_letter
        case "Error":
        case "Fatal": {
          if (order.retry_count < order.max_retries) {
            // Set to 'failed' (not 'pending') -- dispatcher's fetchFailedSyncRecords
            // queries status='failed' for re-dispatch eligibility
            const { error: retryError } = await supabase
              .from("bc_sync_orders")
              .update({
                status: "failed",
                bc_buffer_status: buffer.status,
                bc_error_message: buffer.errorMessage,
                failed_at: new Date().toISOString(),
              })
              .eq("id", order.id);
            if (retryError) {
              console.error("Failed to update order for retry", {
                orderId: order.id, error: retryError.message,
              });
              summary.errors++;
              break;
            }
            summary.retried++;
            // buffer_error: Error/Fatal in BC, status -> failed (retry nog mogelijk)
            events.push(
              buildBufferEvent(order, "buffer_error", "failed", {
                po_number: order.po_number,
                error_message: buffer.errorMessage,
                bc_buffer_status: buffer.status,
              }),
            );
            console.log("Order retried", {
              orderId: order.id,
              externalId: order.external_id,
              bcBufferStatus: buffer.status,
              retryCount: order.retry_count + 1,
              maxRetries: order.max_retries,
              action: "retried",
            });
          } else {
            const { error: dlError } = await supabase
              .from("bc_sync_orders")
              .update({
                status: "dead_letter",
                bc_buffer_status: buffer.status,
                bc_error_message: buffer.errorMessage,
                failed_at: new Date().toISOString(),
              })
              .eq("id", order.id);
            if (dlError) {
              console.error("Failed to update order to dead_letter", {
                orderId: order.id, error: dlError.message,
              });
              summary.errors++;
              break;
            }
            summary.deadLetter++;
            events.push(
              buildBufferEvent(order, "dead_lettered", "dead_letter", {
                po_number: order.po_number,
                bc_buffer_status: buffer.status,
                error_message: buffer.errorMessage,
              }),
            );
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
          const { error: cancelError } = await supabase
            .from("bc_sync_orders")
            .update({
              status: "dead_letter",
              bc_buffer_status: "Cancelled",
              bc_error_message: "Buffer cancelled in BC",
              failed_at: new Date().toISOString(),
            })
            .eq("id", order.id);
          if (cancelError) {
            console.error("Failed to update cancelled order to dead_letter", {
              orderId: order.id, error: cancelError.message,
            });
            summary.errors++;
            break;
          }
          summary.deadLetter++;
          events.push(
            buildBufferEvent(order, "dead_lettered", "dead_letter", {
              po_number: order.po_number,
              bc_buffer_status: "Cancelled",
            }),
          );
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

  // Best-effort bulk-log na alle per-order checks (D-01). logSyncEvent swallowt
  // zelf elke fout -- mag de verifier-flow nooit breken (T-185-11).
  await logSyncEvent(supabase, events);

  return summary;
}
