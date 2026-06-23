import { z } from "zod";

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

// ============================================================================
// Schema-validatie van de externe I/O-grens (coding-principles: Zod op elke
// external I/O boundary). Een bericht is ALLEEN goed-gevormd als de error-sectie
// BOTH een non-empty `stage` EN een non-empty `message` heeft -- een incomplete/
// hernoemde error-sectie routeert naar archive-as-unmatched (D-09/D-10), nooit
// naar een silently-incomplete matched archive. Onbekende velden worden bewust
// genegeerd (.passthrough) zodat de volledige body bewaard blijft (D-09).
// ============================================================================

const errorQueueErrorSchema = z
  .object({
    stage: z.string().min(1),
    httpStatus: z.number().optional(),
    message: z.string().min(1),
    attempts: z.number().optional(),
    retryable: z.boolean().optional(),
    failedAtUtc: z.string().optional(),
    correlationId: z.string().optional(),
  })
  .passthrough();

const errorQueueMessageSchema = z
  .object({
    meta: z.object({ messageId: z.string().optional() }).passthrough().optional(),
    order: z.object({ poNumber: z.string().optional() }).passthrough(),
    error: errorQueueErrorSchema,
  })
  .passthrough();

/** Een bericht is goed-gevormd als de body het ErrorQueueMessage-schema haalt. */
function parseWellFormed(parsed: unknown): ErrorQueueMessage | null {
  const result = errorQueueMessageSchema.safeParse(parsed);
  return result.success ? (result.data as unknown as ErrorQueueMessage) : null;
}

type MatchedOrder = { id: number; status: string };

/** Resultaat van een match-poging: de order (of null) plus de berekende external_id. */
interface MatchResult {
  matchedOrder: MatchedOrder | null;
  externalId: string | null;
}

/**
 * Match een goed-gevormd bericht aan een bc_sync_orders-rij (D-03).
 *
 * Primair: `external_id` = `BRA-AC-{metaMessageId}-{poNumber}` (uniek per PO).
 * Fallback: `message_id` = metaMessageId. Batch-dispatches DELEN een message_id,
 * dus de fallback haalt candidates ZONDER limit op: bij meer dan een hit is de
 * match ambigu -> behandel als UNMATCHED (geen wilde order op bc_rejected zetten).
 */
async function matchOrder(
  supabase: ReturnType<typeof getSupabaseClient>,
  parsed: ErrorQueueMessage,
): Promise<MatchResult> {
  const metaMessageId = parsed.meta?.messageId ?? null;
  const poNumber = parsed.order?.poNumber ?? null;

  let externalId: string | null = null;
  let matchedOrder: MatchedOrder | null = null;

  if (metaMessageId && poNumber) {
    externalId = `BRA-AC-${metaMessageId}-${poNumber}`;
    const { data: byExternal } = await supabase
      .from("bc_sync_orders")
      .select("id, status")
      .eq("external_id", externalId)
      .limit(1);
    if (byExternal && byExternal.length > 0) {
      matchedOrder = byExternal[0] as MatchedOrder;
    }
  }

  // Fallback: meta.messageId -> bc_sync_orders.message_id. GEEN limit(1):
  // bij meerdere hits is de match ambigu en mag GEEN willekeurige order
  // gemislabeld worden (cursor/claude: batch deelt een message_id).
  if (!matchedOrder && metaMessageId) {
    const { data: byMessageId } = await supabase
      .from("bc_sync_orders")
      .select("id, status")
      .eq("message_id", metaMessageId)
      .limit(2);
    if (byMessageId && byMessageId.length === 1) {
      matchedOrder = byMessageId[0] as MatchedOrder;
    } else if (byMessageId && byMessageId.length > 1) {
      console.warn(
        "Error-queue fallback match ambiguous (multiple orders share message_id) -- treating as UNMATCHED",
        { metaMessageId, candidates: byMessageId.length },
      );
      // matchedOrder blijft null -> archive-as-unmatched
    }
  }

  return { matchedOrder, externalId };
}

/**
 * Zet een gematchte order op `bc_rejected` (D-04, idempotent).
 *
 * Returns:
 *  - "updated"     -- order succesvol op bc_rejected gezet (matched++)
 *  - "already"     -- order was al bc_rejected, niets te doen (matched++)
 *  - "failed"      -- UPDATE faalde; order NIET op bc_rejected (errors++, NIET completen)
 *
 * Gebruikt door zowel het hoofdpad als het idempotency-skip pad (self-heal van
 * een eerder gefaalde update).
 */
async function applyRejection(
  supabase: ReturnType<typeof getSupabaseClient>,
  matchedOrder: MatchedOrder,
  errorMessage: string,
  messageId: string,
): Promise<"updated" | "already" | "failed"> {
  if (matchedOrder.status === "bc_rejected") {
    console.log("Order already bc_rejected (idempotent skip)", {
      orderId: matchedOrder.id,
      messageId,
    });
    return "already";
  }

  const { error: updateError } = await supabase
    .from("bc_sync_orders")
    .update({
      status: "bc_rejected",
      bc_error_message: errorMessage,
      failed_at: new Date().toISOString(),
    })
    .eq("id", matchedOrder.id);

  if (updateError) {
    console.error("Failed to update bc_sync_orders to bc_rejected", {
      orderId: matchedOrder.id,
      messageId,
      error: updateError.message,
    });
    return "failed";
  }

  return "updated";
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

      // 3. Parse body DEFENSIVELY (D-09, D-10): nooit crashen, nooit droppen.
      //    Schema-validatie op de I/O-grens (Zod): incomplete error-sectie ->
      //    archive-as-unmatched, geen silently-incomplete matched archive.
      const parsedRaw: unknown = parseJsonOrNull(msg.body, messageId);
      const parsed: ErrorQueueMessage | null = parseWellFormed(parsedRaw);
      const wellFormed = parsed !== null;

      // 2. Idempotency check (D-02). Captureer OOK de error: een transiente
      //    DB-fout geeft data=null + error!=null; zonder check zou de guard
      //    doorvallen en een duplicate INSERT (UNIQUE-violation) proberen.
      const { data: existing, error: existingErr } = await supabase
        .from("bc_sync_error_messages")
        .select("id")
        .eq("message_id", messageId)
        .limit(1);

      if (existingErr) {
        console.error("Idempotency check failed (DB error) -- skipping message this run", {
          messageId,
          sequenceNumber: msg.brokerProperties.SequenceNumber,
          error: existingErr.message,
        });
        summary.errors++;
        // NIET completen -- bericht blijft in queue voor een volgende run
        continue;
      }

      if (existing && existing.length > 0) {
        // Al gearchiveerd. Self-heal (D-04): re-attempt de match + bc_rejected
        // update voor het geval een eerdere run wel archiveerde maar de update
        // faalde. Pas completen NA een geslaagde (of niet-nodige) update.
        summary.skipped++;

        if (parsed) {
          const { matchedOrder } = await matchOrder(supabase, parsed);
          if (matchedOrder) {
            const errorMessage = parsed.error?.message ?? "(no error message)";
            const outcome = await applyRejection(supabase, matchedOrder, errorMessage, messageId);
            if (outcome === "failed") {
              summary.errors++;
              // NIET completen -- update moet alsnog slagen in een volgende run
              continue;
            }
          }
        }

        console.log("Error-queue message already archived (idempotent skip, re-checked match)", {
          messageId,
          sequenceNumber: msg.brokerProperties.SequenceNumber,
        });
        // Niets meer te updaten (of al bc_rejected / unmatched) -> completen uit de queue
        await completeErrorMessage(config.SB_NAMESPACE, config.SB_ERROR_QUEUE, sasToken, msg);
        summary.deleted++;
        continue;
      }

      // 4. Match (D-03), ALLEEN als goed-gevormd
      const { matchedOrder, externalId } = parsed
        ? await matchOrder(supabase, parsed)
        : { matchedOrder: null, externalId: null };

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

      // 7. Bij match: order op bc_rejected zetten (D-04, idempotent skip).
      //    Als de UPDATE faalt: errors++, NIET completen (bericht blijft in de
      //    queue zodat een volgende run de update opnieuw probeert -- via het
      //    self-heal pad in de idempotency-skip). matched++ is CONDITIONEEL op
      //    een geslaagde (of niet-nodige) update.
      if (matchedOrder) {
        const outcome = await applyRejection(
          supabase,
          matchedOrder,
          error?.message ?? "(no error message)",
          messageId,
        );

        if (outcome === "failed") {
          summary.errors++;
          // Insert is al gelukt, maar de order staat NOG NIET op bc_rejected.
          // NIET completen -- self-heal in de skip-path probeert het opnieuw.
          continue;
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
