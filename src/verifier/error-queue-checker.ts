import { getConfig } from "../shared/config";
import { generateSasToken } from "../shared/service-bus-client";
import type { getSupabaseClient } from "../shared/supabase-client";
import type {
  BcSyncErrorMessageInsert,
  DlqBrokerProperties,
  ErrorQueueMessage,
  ErrorQueueSummary,
} from "../shared/types";

// ============================================================================
// Error-queue Checker -- bratra-error queue (BC content-rejections)
// ============================================================================
//
// Anders dan de DLQ (dlq-checker.ts):
//  - gewone queue endpoint (geen dead-letter-subqueue);
//  - foutinformatie zit in de BODY (error-sectie), niet in response-headers;
//  - matched order -> status 'bc_rejected' (BC-content-rejection, terminal).
//
// Idempotentie via BrokerProperties.MessageId (envelope-header -- ook beschikbaar
// als de body malformed is). Archiveren VOOR completen/verwijderen (D-02).
// ============================================================================

/** Max berichten per verifier run (DoS-mitigatie, mirror dlq-checker MAX_MESSAGES) */
const MAX_MESSAGES = 10;

/** Enkel ontvangen bericht van de error-queue (envelope-header + raw body) */
interface ReceivedErrorMessage {
  brokerProperties: DlqBrokerProperties;
  /** Raw body string -- defensief geparsed in de loop */
  body: string;
  lockToken: string;
  /** Location header voor DELETE URL (complete bericht) */
  locationUrl: string | null;
}

/**
 * Receive a single message from the ORDINARY bratra-error queue via peek-lock.
 *
 * Endpoint: `{queue}/messages/head` -- the ordinary queue, NOT a dead-letter subqueue (D-01).
 * Returns null when the queue is empty (HTTP 204).
 * Uses the Location header for the DELETE URL when available.
 */
async function receiveErrorMessage(
  namespace: string,
  queue: string,
  sasToken: string,
): Promise<ReceivedErrorMessage | null> {
  const url = `https://${namespace}.servicebus.windows.net/${queue}/messages/head?timeout=5`;

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: sasToken },
  });

  // HTTP 204 = queue leeg
  if (response.status === 204) return null;

  if (response.status !== 201) {
    const body = await response.text();
    throw new Error(`Error-queue receive failed (${response.status}): ${body.slice(0, 300)}`);
  }

  // BrokerProperties envelope-header (MessageId, SequenceNumber, LockToken, ...)
  const brokerPropsRaw = response.headers.get("BrokerProperties");
  if (!brokerPropsRaw) {
    throw new Error("Missing BrokerProperties header in error-queue response");
  }
  const brokerProperties: DlqBrokerProperties = JSON.parse(brokerPropsRaw);

  const body = await response.text();
  const locationUrl = response.headers.get("Location") ?? null;

  return {
    brokerProperties,
    body,
    lockToken: brokerProperties.LockToken,
    locationUrl,
  };
}

/**
 * Complete (delete) a locked error-queue message.
 *
 * Uses the Location header URL when available, otherwise constructs the URL from
 * namespace/queue/sequenceNumber/lockToken. Ordinary queue endpoint (no DLQ).
 */
async function completeErrorMessage(
  namespace: string,
  queue: string,
  sasToken: string,
  msg: ReceivedErrorMessage,
): Promise<void> {
  const deleteUrl = msg.locationUrl
    ?? `https://${namespace}.servicebus.windows.net/${queue}/messages/${msg.brokerProperties.SequenceNumber}/${msg.lockToken}`;

  const response = await fetch(deleteUrl, {
    method: "DELETE",
    headers: { Authorization: sasToken },
  });

  if (response.status !== 200) {
    const body = await response.text();
    throw new Error(`Error-queue complete failed (${response.status}): ${body.slice(0, 300)}`);
  }
}

/** Parse body als JSON; geeft null terug bij een parse-fout (nooit crashen, D-09) */
function parseJsonOrNull(body: string, messageId: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    console.warn("Error-queue message body is not valid JSON", { messageId });
    return null;
  }
}

/** Een bericht is goed-gevormd als body als JSON parst EN error- en order-secties heeft */
function isWellFormed(parsed: unknown): parsed is ErrorQueueMessage {
  if (typeof parsed !== "object" || parsed === null) return false;
  const candidate = parsed as Partial<ErrorQueueMessage>;
  const error = candidate.error;
  const hasError =
    typeof error === "object" &&
    error !== null &&
    (typeof error.message === "string" || typeof error.stage === "string");
  const hasOrder = typeof candidate.order === "object" && candidate.order !== null;
  return hasError && hasOrder;
}

/**
 * Check the `bratra-error` Service Bus queue for BC content-rejections.
 *
 * Per message:
 * 1. messageId = envelope BrokerProperties.MessageId (idempotency key, D-10)
 * 2. Idempotency check (D-02): skip if already in bc_sync_error_messages
 * 3. Parse body DEFENSIVELY (D-09/D-10): malformed/missing sections -> unmatched
 * 4. Match (D-03): external_id `BRA-AC-{messageId}-{poNumber}`, fallback meta.messageId
 * 5. Archive: INSERT into bc_sync_error_messages BEFORE delete (D-02)
 * 6. On match: SET bc_sync_orders.status = 'bc_rejected' (skip if already, D-04)
 * 7. Complete: DELETE from queue ONLY after a successful insert (D-02)
 *
 * Writes no sync-event audit rows -- event-logging is out of scope this phase (D-11, phase 185).
 * Non-fatal: per-message errors are counted, not thrown. Sequential (no Promise.all).
 */
export async function checkErrorQueue(
  supabase: ReturnType<typeof getSupabaseClient>,
): Promise<ErrorQueueSummary> {
  const summary: ErrorQueueSummary = {
    archived: 0,
    matched: 0,
    unmatched: 0,
    skipped: 0,
    deleted: 0,
    errors: 0,
  };

  const config = getConfig();

  // SAS token scoped op de error-queue. Listen-key kan afwijken van de inbound-key;
  // valt terug op SB_KEY_NAME/VALUE als niet apart gezet (D-01, mirror errorQueuePeek).
  const sasToken = generateSasToken(
    config.SB_NAMESPACE,
    config.SB_ERROR_QUEUE,
    config.SB_ERROR_KEY_NAME ?? config.SB_KEY_NAME,
    config.SB_ERROR_KEY_VALUE ?? config.SB_KEY_VALUE,
  );

  for (let i = 0; i < MAX_MESSAGES; i++) {
    try {
      const msg = await receiveErrorMessage(
        config.SB_NAMESPACE,
        config.SB_ERROR_QUEUE,
        sasToken,
      );
      if (!msg) break; // Queue leeg

      // 1. Idempotentie-sleutel uit de ENVELOPE (D-10: ook bij malformed body)
      const messageId = msg.brokerProperties.MessageId;
      if (!messageId) {
        console.error("Error-queue message zonder MessageId -- niet verwijderd (un-keyable)", {
          sequenceNumber: msg.brokerProperties.SequenceNumber,
        });
        summary.errors++;
        // NIET completen -- bericht zonder sleutel niet droppen
        continue;
      }

      // 2. Idempotency check (D-02)
      const { data: existing } = await supabase
        .from("bc_sync_error_messages")
        .select("id")
        .eq("message_id", messageId)
        .limit(1);

      if (existing && existing.length > 0) {
        console.log("Error-queue message already archived (idempotent skip)", {
          messageId,
          sequenceNumber: msg.brokerProperties.SequenceNumber,
        });
        summary.skipped++;
        // Al gearchiveerd -> alsnog completen uit de queue
        await completeErrorMessage(config.SB_NAMESPACE, config.SB_ERROR_QUEUE, sasToken, msg);
        summary.deleted++;
        continue;
      }

      // 3. Parse body DEFENSIVELY (D-09, D-10): nooit crashen, nooit droppen
      const parsedRaw: unknown = parseJsonOrNull(msg.body, messageId);
      const parsed: ErrorQueueMessage | null = isWellFormed(parsedRaw) ? parsedRaw : null;
      const wellFormed = parsed !== null;

      // 4. Match (D-03), ALLEEN als goed-gevormd
      let matchedOrder: { id: number; status: string } | null = null;
      let externalId: string | null = null;

      if (parsed) {
        const metaMessageId = parsed.meta?.messageId ?? null;
        const poNumber = parsed.order?.poNumber ?? null;

        if (metaMessageId && poNumber) {
          externalId = `BRA-AC-${metaMessageId}-${poNumber}`;
          const { data: byExternal } = await supabase
            .from("bc_sync_orders")
            .select("id, status")
            .eq("external_id", externalId)
            .limit(1);
          if (byExternal && byExternal.length > 0) {
            matchedOrder = byExternal[0] as { id: number; status: string };
          }
        }

        // Fallback: meta.messageId -> bc_sync_orders.message_id
        if (!matchedOrder && metaMessageId) {
          const { data: byMessageId } = await supabase
            .from("bc_sync_orders")
            .select("id, status")
            .eq("message_id", metaMessageId)
            .limit(1);
          if (byMessageId && byMessageId.length > 0) {
            matchedOrder = byMessageId[0] as { id: number; status: string };
          }
        }
      }

      // 5. Bouw de archief-rij. Body altijd volledig bewaren: parsed object bij
      // goed-gevormd, anders de raw string (D-09: niets verliezen).
      const error = parsed?.error;
      const insertRow: BcSyncErrorMessageInsert = {
        message_id: messageId,
        meta_message_id: parsed?.meta?.messageId ?? null,
        po_number: parsed?.order?.poNumber ?? null,
        external_id: externalId,
        sequence_number: msg.brokerProperties.SequenceNumber ?? null,
        error_stage: error?.stage ?? null,
        error_http_status: error?.httpStatus ?? null,
        error_message: error?.message ?? null,
        error_attempts: error?.attempts ?? null,
        error_retryable: error?.retryable ?? null,
        failed_at_utc: error?.failedAtUtc ?? null,
        message_body: parsed ?? msg.body,
        broker_properties: msg.brokerProperties,
        matched_sync_order_id: matchedOrder?.id ?? null,
        received_at: msg.brokerProperties.EnqueuedTimeUtc ?? new Date().toISOString(),
      };

      // 6. Archiveren VOOR completen (D-02)
      const { error: insertError } = await supabase
        .from("bc_sync_error_messages")
        .insert(insertRow);

      if (insertError) {
        console.error("Failed to insert error-queue message", {
          messageId,
          error: insertError.message,
        });
        summary.errors++;
        // NIET completen -- bericht blijft in queue voor volgende run
        continue;
      }
      summary.archived++;

      // 7. Bij match: order op bc_rejected zetten (D-04, idempotent skip)
      if (matchedOrder) {
        if (matchedOrder.status !== "bc_rejected") {
          const { error: updateError } = await supabase
            .from("bc_sync_orders")
            .update({
              status: "bc_rejected",
              bc_error_message: error?.message ?? "(no error message)",
              failed_at: new Date().toISOString(),
            })
            .eq("id", matchedOrder.id);

          if (updateError) {
            console.error("Failed to update bc_sync_orders to bc_rejected", {
              orderId: matchedOrder.id,
              messageId,
              error: updateError.message,
            });
            // Insert is al gelukt -- doorgaan met completen
          }
        } else {
          console.log("Order already bc_rejected (idempotent skip)", {
            orderId: matchedOrder.id,
            messageId,
          });
        }

        summary.matched++;
        console.log("Error-queue message processed (matched)", {
          messageId,
          sequenceNumber: msg.brokerProperties.SequenceNumber,
          externalId,
          orderId: matchedOrder.id,
        });
      } else {
        // D-03: geen match of niet goed-gevormd -> gearchiveerd zonder match
        summary.unmatched++;
        console.warn("Error-queue message processed (no match)", {
          messageId,
          sequenceNumber: msg.brokerProperties.SequenceNumber,
          wellFormed,
        });
      }

      // 8. Completen uit de queue (D-02: alleen na succesvolle insert)
      await completeErrorMessage(config.SB_NAMESPACE, config.SB_ERROR_QUEUE, sasToken, msg);
      summary.deleted++;
    } catch (err) {
      console.error("Error processing error-queue message", {
        error: (err as Error).message,
      });
      summary.errors++;
    }
  }

  console.log("Error-queue check summary", summary);
  return summary;
}
