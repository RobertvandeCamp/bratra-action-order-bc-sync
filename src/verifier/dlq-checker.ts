import { getConfig } from "../shared/config";
import { logSyncEvent } from "../shared/event-logger";
import { generateSasToken } from "../shared/service-bus-client";
import { TERMINAL_STATUSES } from "./error-queue-checker";
import type { getSupabaseClient } from "../shared/supabase-client";
import type {
  BcSyncEventInsert,
  BcSyncEventStatus,
  DlqSummary,
  DlqBrokerProperties,
  DlqMessage,
} from "../shared/types";

/** Vorm van de verbrede DLQ-match-select-rij (RISK-2). */
export interface DlqMatchedOrder {
  id: number;
  order_id: number;
  company_id: number;
  po_number: string;
  retry_count: number;
  status: string;
}

/**
 * Pure builder voor het DLQ `dead_lettered`-event (fase 185, TRACE-01).
 *
 * KRITISCH (Pitfall 2): event_type `dead_lettered` (dubbel-t) mapt op status
 * `dead_letter` (enkel-t). `from_status` komt uit `matchedOrder.status`; valt
 * terug op `"sent"` (D-07) als de status ontbreekt. Puur zodat de
 * event_type<->status-mapping en de detail-policy (D-03/D-04) deterministisch
 * te unit-testen zijn -- de aanroep gebeurt ALLEEN binnen `if (matchedOrder)`.
 */
export function buildDlqDeadLetteredEvent(
  matchedOrder: DlqMatchedOrder,
  deadLetterReason: string,
  deadLetterErrorDescription: string,
): BcSyncEventInsert {
  return {
    sync_order_id: matchedOrder.id,
    order_id: matchedOrder.order_id,
    company_id: matchedOrder.company_id,
    event_type: "dead_lettered",
    from_status: (matchedOrder.status as BcSyncEventStatus) ?? "sent",
    to_status: "dead_letter",
    retry_count: matchedOrder.retry_count,
    detail: {
      po_number: matchedOrder.po_number,
      dead_letter_reason: deadLetterReason,
      dead_letter_error_description: deadLetterErrorDescription,
    },
  };
}

// ============================================================================
// DLQ Checker -- Service Bus Dead Letter Queue monitoring
// ============================================================================

/** Max berichten per verifier run (D-06 DoS mitigatie) */
const MAX_MESSAGES = 10;

/**
 * Receive a single message from the DLQ via peek-lock.
 *
 * Returns null when queue is empty (HTTP 204).
 * Uses Location header for DELETE URL when available (Pitfall 3).
 * Reads DeadLetterReason/Description as separate response headers (Pitfall 2).
 */
async function receiveDlqMessage(
  namespace: string,
  queue: string,
  sasToken: string,
): Promise<DlqMessage | null> {
  const url = `https://${namespace}.servicebus.windows.net/${queue}/$DeadLetterQueue/messages/head?timeout=5`;

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: sasToken },
  });

  // HTTP 204 = queue leeg
  if (response.status === 204) return null;

  if (response.status !== 201) {
    const body = await response.text();
    throw new Error(`DLQ receive failed (${response.status}): ${body.slice(0, 300)}`);
  }

  // Parse BrokerProperties header
  const brokerPropsRaw = response.headers.get("BrokerProperties");
  if (!brokerPropsRaw) {
    throw new Error("Missing BrokerProperties header in DLQ response");
  }
  const brokerProperties: DlqBrokerProperties = JSON.parse(brokerPropsRaw);

  // DeadLetterReason en DeadLetterErrorDescription als aparte headers (Pitfall 2)
  const deadLetterReason = response.headers.get("DeadLetterReason") ?? "Unknown";
  const deadLetterErrorDescription = response.headers.get("DeadLetterErrorDescription") ?? "";

  // Message body
  const body = await response.text();

  // Location header voor DELETE URL (Pitfall 3)
  const locationUrl = response.headers.get("Location") ?? null;

  return {
    brokerProperties,
    deadLetterReason,
    deadLetterErrorDescription,
    body,
    lockToken: brokerProperties.LockToken,
    locationUrl,
  };
}

/**
 * Complete (delete) a locked DLQ message.
 *
 * Uses Location header URL when available, otherwise constructs URL from
 * namespace/queue/sequenceNumber/lockToken.
 */
async function completeDlqMessage(
  namespace: string,
  queue: string,
  sasToken: string,
  msg: DlqMessage,
): Promise<void> {
  const deleteUrl = msg.locationUrl
    ?? `https://${namespace}.servicebus.windows.net/${queue}/$DeadLetterQueue/messages/${msg.brokerProperties.SequenceNumber}/${msg.lockToken}`;

  const response = await fetch(deleteUrl, {
    method: "DELETE",
    headers: { Authorization: sasToken },
  });

  if (response.status !== 200) {
    const body = await response.text();
    throw new Error(`DLQ complete failed (${response.status}): ${body.slice(0, 300)}`);
  }
}

/**
 * Check the Service Bus DLQ for dead-lettered messages.
 *
 * Per message:
 * 1. Idempotency check (D-13): skip if already in bc_sync_dlq_messages
 * 2. Match check (D-11): find corresponding bc_sync_orders record
 * 3. Archive: INSERT into bc_sync_dlq_messages (D-05/D-06)
 * 4. Update: SET bc_sync_orders.status = 'dead_letter' if matched (D-11)
 * 5. Complete: DELETE from queue only after successful insert (D-03)
 *
 * Non-fatal: errors are counted, not thrown. Sequential processing (no Promise.all).
 */
export async function checkDlqMessages(
  supabase: ReturnType<typeof getSupabaseClient>,
): Promise<DlqSummary> {
  const summary: DlqSummary = { processed: 0, matched: 0, unmatched: 0, skipped: 0, errors: 0 };

  const config = getConfig();

  // SAS token scoped to parent queue (grants DLQ access per PATTERNS.md)
  const sasToken = generateSasToken(
    config.SB_NAMESPACE,
    config.SB_QUEUE,
    config.SB_KEY_NAME,
    config.SB_KEY_VALUE,
  );

  for (let i = 0; i < MAX_MESSAGES; i++) {
    try {
      const msg = await receiveDlqMessage(config.SB_NAMESPACE, config.SB_QUEUE, sasToken);
      if (!msg) break; // Queue leeg

      const messageId = msg.brokerProperties.MessageId;

      // 1. Idempotency check (D-13)
      const { data: existing } = await supabase
        .from("bc_sync_dlq_messages")
        .select("id")
        .eq("message_id", messageId)
        .limit(1);

      if (existing && existing.length > 0) {
        console.log("DLQ message already processed (idempotent skip)", {
          messageId,
          sequenceNumber: msg.brokerProperties.SequenceNumber,
        });
        summary.skipped++;
        // Complete uit queue (al verwerkt)
        await completeDlqMessage(config.SB_NAMESPACE, config.SB_QUEUE, sasToken, msg);
        continue;
      }

      // 2. Match check (D-11): zoek bc_sync_orders op message_id. Select verbreed
      // (RISK-2) zodat een complete dead_lettered-event-rij gebouwd kan worden.
      const { data: matchedOrders } = await supabase
        .from("bc_sync_orders")
        .select("id, order_id, company_id, po_number, retry_count, status")
        .eq("message_id", messageId)
        .limit(1);

      const matchedOrder: DlqMatchedOrder | null =
        matchedOrders && matchedOrders.length > 0
          ? (matchedOrders[0] as DlqMatchedOrder)
          : null;

      // 3. Parse envelope body als JSON (T-152.1-05: wrapped in try/catch)
      let envelopeBody: unknown = null;
      try {
        envelopeBody = JSON.parse(msg.body);
      } catch {
        // Body niet parseable als JSON -- opslaan als null
        console.warn("DLQ message body is not valid JSON", { messageId });
      }

      // 4. INSERT in bc_sync_dlq_messages (D-05/D-06)
      const { error: insertError } = await supabase
        .from("bc_sync_dlq_messages")
        .insert({
          message_id: messageId,
          correlation_id: msg.brokerProperties.CorrelationId ?? null,
          sequence_number: msg.brokerProperties.SequenceNumber,
          dead_letter_reason: msg.deadLetterReason,
          dead_letter_error_description: msg.deadLetterErrorDescription,
          envelope_body: envelopeBody,
          broker_properties: msg.brokerProperties,
          matched_sync_order_id: matchedOrder?.id ?? null,
          received_at: msg.brokerProperties.EnqueuedTimeUtc,
        });

      if (insertError) {
        console.error("Failed to insert DLQ message", {
          messageId,
          error: insertError.message,
        });
        summary.errors++;
        // NIET completen -- bericht blijft in queue voor volgende run
        continue;
      }

      // 5. Bij match: update bc_sync_orders (D-11)
      if (matchedOrder) {
        // Terminal-guard (PR#5 claude High #1): een order die al in een terminale
        // status zit (verified/dead_letter/skipped/bc_rejected) NIET overschrijven
        // naar dead_letter. De error-queue-checker (stap 4) draait eerder in dezelfde
        // verifier-run; zonder deze guard wint een DLQ-bericht van een net gezette
        // bc_rejected en gaat die terminale uitkomst verloren. Spiegelt applyRejection.
        if (TERMINAL_STATUSES.has(matchedOrder.status)) {
          console.warn(
            "DLQ match already in terminal status -- NOT overwriting to dead_letter",
            { orderId: matchedOrder.id, currentStatus: matchedOrder.status, messageId },
          );
        } else {
          const { error: updateError } = await supabase
            .from("bc_sync_orders")
            .update({
              status: "dead_letter",
              bc_error_message: `${msg.deadLetterReason}: ${msg.deadLetterErrorDescription}`.trim(),
            })
            .eq("id", matchedOrder.id);

          if (updateError) {
            console.error("Failed to update bc_sync_orders for DLQ match", {
              orderId: matchedOrder.id,
              messageId,
              error: updateError.message,
            });
            // Insert succeeded, continue met complete
          } else {
            // dead_lettered-event ALLEEN bij een geslaagde transitie naar dead_letter.
            await logSyncEvent(supabase, [
              buildDlqDeadLetteredEvent(
                matchedOrder,
                msg.deadLetterReason,
                msg.deadLetterErrorDescription,
              ),
            ]);
          }
        }

        summary.matched++;
        console.log("DLQ message processed (matched)", {
          messageId,
          sequenceNumber: msg.brokerProperties.SequenceNumber,
          deadLetterReason: msg.deadLetterReason,
          matched: true,
          orderId: matchedOrder.id,
        });
      } else {
        // D-12: geen match, alsnog opgeslagen
        summary.unmatched++;
        console.warn("DLQ message processed (no match)", {
          messageId,
          sequenceNumber: msg.brokerProperties.SequenceNumber,
          deadLetterReason: msg.deadLetterReason,
          matched: false,
        });
      }

      // 6. Complete bericht uit queue (D-03: alleen na succesvolle insert)
      await completeDlqMessage(config.SB_NAMESPACE, config.SB_QUEUE, sasToken, msg);
      summary.processed++;
    } catch (err) {
      console.error("Error processing DLQ message", {
        error: (err as Error).message,
      });
      summary.errors++;
    }
  }

  console.log("DLQ check summary", summary);
  return summary;
}
