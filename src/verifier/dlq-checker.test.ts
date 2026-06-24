import { afterEach, describe, expect, it, vi } from "vitest";

import type { getSupabaseClient } from "../shared/supabase-client";
import {
  buildDlqDeadLetteredEvent,
  checkDlqMessages,
  type DlqMatchedOrder,
} from "./dlq-checker";

// ============================================================================
// Config + Service Bus worden gemockt zodat checkDlqMessages zonder echte
// Azure-toegang draait. De pure builder wordt los getest; de no-match-guard
// wordt via de echte checkDlqMessages-flow geverifieerd (alleen bij een match
// wordt een event geschreven).
// ============================================================================

vi.mock("../shared/config", () => ({
  getConfig: () => ({
    SB_NAMESPACE: "ns",
    SB_QUEUE: "q",
    SB_KEY_NAME: "key",
    SB_KEY_VALUE: "secret",
  }),
}));

vi.mock("../shared/service-bus-client", () => ({
  generateSasToken: () => "SharedAccessSignature sr=fake",
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ----------------------------------------------------------------------------
// Pure builder: buildDlqDeadLetteredEvent
// ----------------------------------------------------------------------------

function makeMatched(overrides: Partial<DlqMatchedOrder> = {}): DlqMatchedOrder {
  return {
    id: 42,
    order_id: 1001,
    company_id: 2,
    po_number: "PO-555",
    retry_count: 1,
    status: "sent",
    ...overrides,
  };
}

describe("buildDlqDeadLetteredEvent", () => {
  it("mapt een match naar event_type 'dead_lettered' / to_status 'dead_letter' (Pitfall 2)", () => {
    const event = buildDlqDeadLetteredEvent(makeMatched(), "MaxDeliveryCountExceeded", "te vaak afgeleverd");
    expect(event.event_type).toBe("dead_lettered");
    expect(event.to_status).toBe("dead_letter");
    // NOOIT de event_type-spelling als status
    expect(event.to_status).not.toBe("dead_lettered");
  });

  it("kopieert identiteit-velden en zet from_status uit matchedOrder.status (D-07)", () => {
    const event = buildDlqDeadLetteredEvent(makeMatched({ status: "sent" }), "r", "d");
    expect(event.sync_order_id).toBe(42);
    expect(event.order_id).toBe(1001);
    expect(event.company_id).toBe(2);
    expect(event.retry_count).toBe(1);
    expect(event.from_status).toBe("sent");
  });

  it("valt terug op from_status 'sent' wanneer matchedOrder.status ontbreekt (D-07)", () => {
    const event = buildDlqDeadLetteredEvent(
      makeMatched({ status: undefined as unknown as string }),
      "r",
      "d",
    );
    expect(event.from_status).toBe("sent");
  });

  it("vult detail volgens policy: altijd po_number + de dead-letter-context (D-03/D-04)", () => {
    const event = buildDlqDeadLetteredEvent(makeMatched(), "MaxDeliveryCountExceeded", "te vaak");
    const detail = event.detail as Record<string, unknown>;
    expect(detail.po_number).toBe("PO-555");
    expect(detail.dead_letter_reason).toBe("MaxDeliveryCountExceeded");
    expect(detail.dead_letter_error_description).toBe("te vaak");
    // company_id niet gedupliceerd in detail (D-04: het is al een kolom)
    expect(detail.company_id).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// checkDlqMessages: de no-match-guard ("geen match -> geen event") en het
// match-pad ("match -> precies 1 event"). fetch wordt gestubt: 1 DLQ-bericht,
// daarna leeg (204).
// ----------------------------------------------------------------------------

type FakeResponse = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

function makeResp(
  status: number,
  headers: Record<string, string>,
  body: string,
): FakeResponse {
  return {
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    text: async () => body,
  };
}

/** fetch-stub: 1 DLQ-bericht ophalen (201), completen (200), daarna leeg (204). */
function stubDlqFetchSingleMessage(): void {
  let receiveCount = 0;
  const fetchMock = vi.fn(
    async (_url: string, opts?: { method?: string }): Promise<FakeResponse> => {
      const method = opts?.method;
      if (method === "POST") {
        receiveCount++;
        if (receiveCount === 1) {
          return makeResp(
            201,
            {
              BrokerProperties: JSON.stringify({
                MessageId: "m1",
                SequenceNumber: 5,
                CorrelationId: "c1",
                EnqueuedTimeUtc: "2026-06-24T00:00:00Z",
                LockToken: "lt1",
              }),
              DeadLetterReason: "MaxDeliveryCountExceeded",
              DeadLetterErrorDescription: "te vaak afgeleverd",
              Location: "https://ns.servicebus.windows.net/q/$DeadLetterQueue/messages/5/lt1",
            },
            JSON.stringify({ foo: "bar" }),
          );
        }
        return makeResp(204, {}, "");
      }
      if (method === "DELETE") {
        return makeResp(200, {}, "");
      }
      throw new Error(`unexpected fetch method ${method}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
}

/**
 * Tiny supabase-fake voor de DLQ-flow. `matchRows` bepaalt of de
 * bc_sync_orders-match een rij teruggeeft. Captured: elke bc_sync_events-insert.
 */
function makeDlqSupabase(matchRows: unknown[]): {
  client: ReturnType<typeof getSupabaseClient>;
  eventInserts: unknown[][];
} {
  const eventInserts: unknown[][] = [];

  const client = {
    from(table: string) {
      if (table === "bc_sync_events") {
        return {
          insert(rows: unknown[]) {
            eventInserts.push(rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "bc_sync_dlq_messages") {
        const selectBuilder = {
          eq() {
            return selectBuilder;
          },
          limit() {
            return Promise.resolve({ data: [], error: null });
          },
        };
        return {
          select() {
            return selectBuilder;
          },
          insert() {
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "bc_sync_orders") {
        const selectBuilder = {
          eq() {
            return selectBuilder;
          },
          limit() {
            return Promise.resolve({ data: matchRows, error: null });
          },
        };
        return {
          select() {
            return selectBuilder;
          },
          update() {
            return {
              eq() {
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as ReturnType<typeof getSupabaseClient>;

  return { client, eventInserts };
}

describe("checkDlqMessages event-logging", () => {
  it("schrijft GEEN event wanneer er geen match is (no-match -> 0 events)", async () => {
    stubDlqFetchSingleMessage();
    const { client, eventInserts } = makeDlqSupabase([]); // geen match

    const summary = await checkDlqMessages(client);

    expect(eventInserts.flat()).toHaveLength(0);
    expect(summary.unmatched).toBe(1);
    expect(summary.matched).toBe(0);
  });

  it("schrijft precies 1 dead_lettered-event bij een match (to_status dead_letter)", async () => {
    stubDlqFetchSingleMessage();
    const { client, eventInserts } = makeDlqSupabase([
      { id: 42, order_id: 1001, company_id: 2, po_number: "PO-9", retry_count: 0, status: "sent" },
    ]);

    const summary = await checkDlqMessages(client);

    const events = eventInserts.flat() as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("dead_lettered");
    expect(events[0].to_status).toBe("dead_letter");
    expect(events[0].sync_order_id).toBe(42);
    expect(summary.matched).toBe(1);
  });
});
