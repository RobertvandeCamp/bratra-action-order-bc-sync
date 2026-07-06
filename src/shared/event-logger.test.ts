import { describe, expect, it, vi, afterEach } from "vitest";

import { logSyncEvent } from "./event-logger";
import * as loggerModule from "./logger";
import type { getSupabaseClient } from "./supabase-client";
import type { BcSyncEventInsert } from "./types";

// ============================================================================
// Tiny inline Supabase fake -- geen mocking-framework, alleen een klein object
// dat de gebruikte chain (.from(table).insert(payload)) nabootst, de payload
// opvangt en een vooraf bepaald {error} teruggeeft. Zelfde structuur als
// makeUpdateFake uit error-queue-checker.test.ts.
// ============================================================================

function makeInsertFake(error: { message: string } | null = null): {
  client: ReturnType<typeof getSupabaseClient>;
  inserts: unknown[][];
  tables: string[];
} {
  const inserts: unknown[][] = [];
  const tables: string[] = [];

  const client = {
    from(table: string) {
      tables.push(table);
      return {
        insert(payload: unknown[]) {
          inserts.push(payload);
          return Promise.resolve({ error });
        },
      };
    },
  } as unknown as ReturnType<typeof getSupabaseClient>;

  return { client, inserts, tables };
}

/**
 * Fake waarvan `.insert` zelf gooit (geen rejected promise maar een synchrone
 * throw) -- dekt het catch-pad van logSyncEvent.
 */
function makeThrowingInsertFake(message: string): ReturnType<typeof getSupabaseClient> {
  return {
    from() {
      return {
        insert() {
          throw new Error(message);
        },
      };
    },
  } as unknown as ReturnType<typeof getSupabaseClient>;
}

const sampleEvent: BcSyncEventInsert = {
  sync_order_id: 1,
  order_id: 2,
  company_id: 2,
  event_type: "sent",
  from_status: "pending",
  to_status: "sent",
};

describe("logSyncEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("doet geen insert bij een lege array (early return)", async () => {
    const { client, inserts } = makeInsertFake();
    await logSyncEvent(client, []);
    expect(inserts).toHaveLength(0);
  });

  it("doet exact 1 bulk-insert met de volledige array als payload (D-01)", async () => {
    const { client, inserts, tables } = makeInsertFake();
    const events: BcSyncEventInsert[] = [
      sampleEvent,
      { ...sampleEvent, sync_order_id: 3, order_id: 4 },
    ];
    await logSyncEvent(client, events);
    expect(inserts).toHaveLength(1);
    expect(tables).toEqual(["bc_sync_events"]);
    expect(inserts[0]).toEqual(events);
  });

  it("swallowt een DB-error en re-throwt niet (D-02)", async () => {
    const { client } = makeInsertFake({ message: "CHECK violation" });
    // Migrated from console.error to pino logger.error (Task 3, 207-01)
    const errorSpy = vi.spyOn(loggerModule.logger, "error").mockImplementation(() => loggerModule.logger);
    await expect(logSyncEvent(client, [sampleEvent])).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("swallowt een geworpen exception en re-throwt niet (D-02)", async () => {
    const client = makeThrowingInsertFake("boom");
    // Migrated from console.error to pino logger.error (Task 3, 207-01)
    const errorSpy = vi.spyOn(loggerModule.logger, "error").mockImplementation(() => loggerModule.logger);
    await expect(logSyncEvent(client, [sampleEvent])).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});
