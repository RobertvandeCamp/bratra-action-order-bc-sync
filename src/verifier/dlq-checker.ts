import type { Logger } from "pino";

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
/**
 * Zet een gematchte order op `dead_letter` (idempotent + terminal-guard). Gedeeld
 * door het hoofdpad en het self-heal-pad in de idempotency-skip -- spiegelt
 * applyRejection in error-queue-checker.ts (PR#5 claude review).
 *
 * Returns:
 *  - "updated"  -- order succesvol op dead_letter gezet + dead_lettered-event gelogd
 *  - "terminal" -- order zit al in een terminale status; NIET overschreven, geen event
 *  - "failed"   -- de UPDATE faalde; de caller mag NIET completen (laat voor retry)
 */
async function applyDlqDeadLetter(
  supabase: ReturnType<typeof getSupabaseClient>,
  matchedOrder: DlqMatchedOrder,
  deadLetterReason: string,
  deadLetterErrorDescription: string,
  messageId: string,
  logger: Logger,
): Promise<"updated" | "terminal" | "failed"> {
  // Terminal-guard: een order die al terminaal is (verified/dead_letter/skipped/
  // bc_rejected) NIET overschrijven. De error-queue-checker draait eerder in
  // dezelfde run; zonder guard wint een DLQ-bericht van een net gezette bc_rejected.
  if (TERMINAL_STATUSES.has(matchedOrder.status)) {
    logger.warn({ orderId: matchedOrder.id, currentStatus: matchedOrder.status, messageId }, "DLQ match already in terminal status -- NOT overwriting to dead_letter");
    return "terminal";
  }

  const { error: updateError } = await supabase
    .from("bc_sync_orders")
    .update({
      status: "dead_letter",
      bc_error_message: `${deadLetterReason}: ${deadLetterErrorDescription}`.trim(),
    })
    .eq("id", matchedOrder.id);

  if (updateError) {
    logger.error({ orderId: matchedOrder.id, messageId, error: updateError.message }, "Failed to update bc_sync_orders for DLQ match");
    return "failed";
  }

  // dead_lettered-event ALLEEN bij een geslaagde transitie naar dead_letter.
  await logSyncEvent(supabase, [
    buildDlqDeadLetteredEvent(matchedOrder, deadLetterReason, deadLetterErrorDescription),
  ]);
  return "updated";
}

export async function checkDlqMessages(
  supabase: ReturnType<typeof getSupabaseClient>,
  logger: Logger,
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
      const { data: existing, error: existingErr } = await supabase
        .from("bc_sync_dlq_messages")
        .select("id")
        .eq("message_id", messageId)
        .limit(1);

      // Een DB-fout is GEEN "nog niet gezien": bij stil doorgaan zou het bericht
      // opnieuw als nieuw verwerkt worden (mogelijk UNIQUE-violatie). Tel als error,
      // laat in de queue voor een volgende run (PR#5 claude #4, spiegelt error-queue).
      if (existingErr) {
        logger.error({ messageId, error: existingErr.message }, "DLQ idempotency-check faalde (DB-fout) -- bericht overgeslagen deze run");
        summary.errors++;
        continue; // NIET completen
      }

      if (existing && existing.length > 0) {
        // Al gearchiveerd. Self-heal: een eerdere run kan wel gearchiveerd maar de
        // status-update gemist hebben (update-fout). Re-match + re-update voor we
        // completen, anders blijft de order eeuwig niet-dead_letter (PR#5 claude High).
        summary.skipped++;
        const { data: healRows, error: healMatchErr } = await supabase
          .from("bc_sync_orders")
          .select("id, order_id, company_id, po_number, retry_count, status")
          .eq("message_id", messageId)
          .limit(1);
        if (healMatchErr) {
          logger.error({ messageId, error: healMatchErr.message }, "DLQ self-heal match faalde (DB-fout) -- laten staan voor retry");
          summary.errors++;
          continue; // NIET completen
        }
        const healOrder =
          healRows && healRows.length > 0 ? (healRows[0] as DlqMatchedOrder) : null;
        if (healOrder) {
          const outcome = await applyDlqDeadLetter(
            supabase,
            healOrder,
            msg.deadLetterReason,
            msg.deadLetterErrorDescription,
            messageId,
            logger,
          );
          if (outcome === "failed") {
            summary.errors++;
            continue; // NIET completen -- volgende run probeert de self-heal opnieuw
          }
        }
        logger.debug({ messageId, sequenceNumber: msg.brokerProperties.SequenceNumber }, "DLQ message already archived (idempotent skip, re-checked match)");
        await completeDlqMessage(config.SB_NAMESPACE, config.SB_QUEUE, sasToken, msg);
        continue;
      }

      // 2. Match check (D-11): zoek bc_sync_orders op message_id. Select verbreed
      // (RISK-2) zodat een complete dead_lettered-event-rij gebouwd kan worden.
      const { data: matchedOrders, error: matchError } = await supabase
        .from("bc_sync_orders")
        .select("id, order_id, company_id, po_number, retry_count, status")
        .eq("message_id", messageId)
        .limit(1);

      // Een DB-fout is GEEN "geen match": zou het bericht als unmatched archiveren
      // EN uit de queue verwijderen -> de dead_letter-koppeling permanent kwijt.
      // Tel als error, laat in de queue voor een volgende run (PR#5 claude High).
      if (matchError) {
        logger.error({ messageId, error: matchError.message }, "DLQ match-lookup faalde (DB-fout) -- bericht overgeslagen deze run");
        summary.errors++;
        continue; // NIET archiveren/completen
      }

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
        logger.warn({ messageId }, "DLQ message body is not valid JSON");
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
        logger.error({ messageId, error: insertError.message }, "Failed to insert DLQ message");
        summary.errors++;
        // NIET completen -- bericht blijft in queue voor volgende run
        continue;
      }

      // 5. Bij match: update bc_sync_orders (D-11) via de gedeelde helper.
      if (matchedOrder) {
        const outcome = await applyDlqDeadLetter(
          supabase,
          matchedOrder,
          msg.deadLetterReason,
          msg.deadLetterErrorDescription,
          messageId,
          logger,
        );

        if (outcome === "failed") {
          summary.errors++;
          // Archief is al gelukt, maar de status staat NOG NIET op dead_letter.
          // NIET completen -- de self-heal in de idempotency-skip retry't de update
          // een volgende run (PR#5 claude High). Anders gaat de transitie verloren.
          continue;
        }

        if (outcome === "terminal") {
          // Al terminaal -> geen dead_letter-transitie door ons; tel als unmatched
          // (consistent met het terminal-pad in error-queue-checker, PR#5 claude #3).
          summary.unmatched++;
        } else {
          summary.matched++;
          logger.info({ messageId, sequenceNumber: msg.brokerProperties.SequenceNumber, deadLetterReason: msg.deadLetterReason, matched: true, orderId: matchedOrder.id }, "DLQ message processed (matched)");
        }
      } else {
        // D-12: geen match, alsnog opgeslagen
        summary.unmatched++;
        logger.warn({ messageId, sequenceNumber: msg.brokerProperties.SequenceNumber, deadLetterReason: msg.deadLetterReason, matched: false }, "DLQ message processed (no match)");
      }

      // 6. Complete bericht uit queue (D-03: alleen na succesvolle insert)
      await completeDlqMessage(config.SB_NAMESPACE, config.SB_QUEUE, sasToken, msg);
      summary.processed++;
    } catch (err) {
      logger.error({ error: (err as Error).message }, "Error processing DLQ message");
      summary.errors++;
    }
  }

  logger.info({ ...summary }, "DLQ check summary");
  return summary;
}
