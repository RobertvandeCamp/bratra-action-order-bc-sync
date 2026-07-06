import type { Logger } from "pino";
import { logger as baseLogger } from "./logger";
import type { getSupabaseClient } from "./supabase-client";
import type { BcSyncEventInsert } from "./types";

/**
 * Append-only event-logging voor de bc-sync Lambda (TRACE-01).
 *
 * Dun en best-effort: bulk-insert van alle events in 1 PostgREST-call per
 * transitie (D-01) en non-fatal (D-02) -- elke insert-fout wordt opgeslokt en
 * NOOIT doorgegeven aan de aanroeper. Logging mag de sync-flow nooit breken.
 *
 * De `events`-parameter is `BcSyncEventInsert[]`-getypeerd: omdat de Supabase
 * client `<any>`-getypeerd is, is dit de ENIGE compile-time guard op de
 * payload (Pitfall 5). De tabel-referentie is `.from("bc_sync_events")` --
 * NIET schema-qualified, de client heeft al `db.schema = "action_orders"`.
 *
 * @param supabase - de gedeelde service_role action_orders-client (geïnjecteerd)
 * @param events - de event-rijen om append-only weg te schrijven
 * @param logger - optionele run-logger (dispatcher/verifier child); valt terug op base logger (D-04/D-06)
 */
export async function logSyncEvent(
  supabase: ReturnType<typeof getSupabaseClient>,
  events: BcSyncEventInsert[],
  logger?: Logger,
): Promise<void> {
  const log = logger ?? baseLogger;

  if (events.length === 0) return;

  try {
    const { error } = await supabase.from("bc_sync_events").insert(events);
    if (error) {
      // Volledige PostgREST-error voor diagnose (Pitfall 4: best-effort
      // verbergt schema-/CHECK-fouten; de message moet zichtbaar zijn in
      // CloudWatch). Count + unieke event_types geven context zonder de hele
      // payload te dumpen.
      log.error(
        {
          count: events.length,
          eventTypes: [...new Set(events.map((e) => e.event_type))],
          error: error.message,
        },
        "logSyncEvent insert failed (non-fatal)",
      );
    }
  } catch (err) {
    log.error(
      { error: (err as Error).message },
      "logSyncEvent threw (non-fatal)",
    );
  }
}
