import { describe, expect, it } from "vitest";
import pino from "pino";

import type { getSupabaseClient } from "../shared/supabase-client";
import type { ErrorQueueMessage } from "../shared/types";

const silentLogger = pino({ level: "silent" });
import {
  applyRejection,
  brokerPropertiesSchema,
  deriveExternalId,
  errorQueueMessageSchema,
  matchOrder,
  parseWellFormed,
  TERMINAL_STATUSES,
} from "./error-queue-checker";

// ============================================================================
// Tiny inline Supabase fakes -- geen mocking-framework, alleen kleine objecten
// die exact de gebruikte chains (.from().select().eq().limit() en
// .from().update().eq()) nabootsen en een vooraf bepaald {data,error} teruggeven.
// ============================================================================

type DbResult = { data: unknown; error: { message: string } | null };

/**
 * Fake voor matchOrder: leg per query-key (de `.eq(column, value)` paar) een
 * resultaat vast. matchOrder doet `.from(t).select(s).eq(col,val).limit(n)`,
 * dus het terminale `.limit()` resolved naar het vastgelegde resultaat.
 */
function makeSelectFake(
  results: Record<string, DbResult>,
): { client: ReturnType<typeof getSupabaseClient>; calls: Array<{ column: string; value: unknown }> } {
  const calls: Array<{ column: string; value: unknown }> = [];

  const client = {
    from() {
      let captured: { column: string; value: unknown } | null = null;
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          captured = { column, value };
          calls.push({ column, value });
          return builder;
        },
        limit(_n: number) {
          const key = `${captured?.column}=${String(captured?.value)}`;
          return Promise.resolve(results[key] ?? { data: [], error: null });
        },
      };
      return builder;
    },
  } as unknown as ReturnType<typeof getSupabaseClient>;

  return { client, calls };
}

/**
 * Fake voor applyRejection: `.from(t).update(payload).eq("id", val)` is awaited
 * en geeft {error}. Capture de update-payload zodat de test hem kan inspecteren.
 */
function makeUpdateFake(error: { message: string } | null = null): {
  client: ReturnType<typeof getSupabaseClient>;
  updates: Array<{ payload: Record<string, unknown>; id: unknown }>;
} {
  const updates: Array<{ payload: Record<string, unknown>; id: unknown }> = [];

  const client = {
    from() {
      let payload: Record<string, unknown> = {};
      const builder = {
        update(p: Record<string, unknown>) {
          payload = p;
          return builder;
        },
        eq(_column: string, value: unknown) {
          updates.push({ payload, id: value });
          return Promise.resolve({ error });
        },
      };
      return builder;
    },
  } as unknown as ReturnType<typeof getSupabaseClient>;

  return { client, updates };
}

/**
 * Fake voor applyRejection INCL. de event-log-insert. `applyRejection` doet nu
 * twee chains:
 *   - `.from("bc_sync_orders").update(payload).eq("id", val)`  (de status-update)
 *   - `.from("bc_sync_events").insert(events)`                 (via logSyncEvent)
 * Deze fake routeert op tabelnaam zodat de test BOTH de update-payload én de
 * gelogde events kan inspecteren.
 */
function makeRejectionFake(updateError: { message: string } | null = null): {
  client: ReturnType<typeof getSupabaseClient>;
  updates: Array<{ payload: Record<string, unknown>; id: unknown }>;
  events: Array<Record<string, unknown>>;
} {
  const updates: Array<{ payload: Record<string, unknown>; id: unknown }> = [];
  const events: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
      if (table === "bc_sync_events") {
        return {
          insert(rows: Record<string, unknown>[]) {
            events.push(...rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      // bc_sync_orders update-chain
      let payload: Record<string, unknown> = {};
      const builder = {
        update(p: Record<string, unknown>) {
          payload = p;
          return builder;
        },
        eq(_column: string, value: unknown) {
          updates.push({ payload, id: value });
          return Promise.resolve({ error: updateError });
        },
      };
      return builder;
    },
  } as unknown as ReturnType<typeof getSupabaseClient>;

  return { client, updates, events };
}

const wellFormedBody = {
  meta: { messageId: "meta-123", correlationId: "corr-1" },
  order: { poNumber: "PO-999", orderType: "X" },
  error: { stage: "BcBufferWrite", message: "BC rejected", retryable: false, httpStatus: 422 },
};

// ============================================================================
// errorQueueMessageSchema -- well-formed detectie
// ============================================================================

describe("errorQueueMessageSchema", () => {
  it("accepteert een goed-gevormd bericht", () => {
    const result = errorQueueMessageSchema.safeParse(wellFormedBody);
    expect(result.success).toBe(true);
  });

  it("is NIET goed-gevormd als error.message ontbreekt (alleen stage)", () => {
    const body = {
      meta: { messageId: "meta-123" },
      order: { poNumber: "PO-999" },
      error: { stage: "BcBufferWrite", retryable: false }, // geen message
    };
    expect(parseWellFormed(body)).toBeNull();
  });

  it("is NIET goed-gevormd bij lege error.message", () => {
    const body = { ...wellFormedBody, error: { stage: "S", message: "" } };
    expect(parseWellFormed(body)).toBeNull();
  });

  it("passthrough bewaart onbekende velden (niets verloren, D-09)", () => {
    const body = {
      ...wellFormedBody,
      order: { poNumber: "PO-999", extraOrderField: "keep-me" },
      error: { ...wellFormedBody.error, extraErrorField: "keep-too" },
      topLevelExtra: "also-keep",
    };
    const parsed = parseWellFormed(body) as unknown as Record<string, unknown>;
    expect(parsed).not.toBeNull();
    expect((parsed.order as Record<string, unknown>).extraOrderField).toBe("keep-me");
    expect((parsed.error as Record<string, unknown>).extraErrorField).toBe("keep-too");
    expect(parsed.topLevelExtra).toBe("also-keep");
  });

  it("matcht bij goed-gevormd niet-null en levert een ErrorQueueMessage", () => {
    const parsed = parseWellFormed(wellFormedBody);
    expect(parsed).not.toBeNull();
    expect(parsed?.error.message).toBe("BC rejected");
  });
});

// ============================================================================
// brokerPropertiesSchema -- externe header-grens
// ============================================================================

describe("brokerPropertiesSchema", () => {
  const valid = { MessageId: "abc", SequenceNumber: 42, LockToken: "tok-1" };

  it("parseert een geldige header", () => {
    const result = brokerPropertiesSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("verwerpt een header zonder MessageId", () => {
    const { MessageId: _drop, ...rest } = valid;
    expect(brokerPropertiesSchema.safeParse(rest).success).toBe(false);
  });

  it("verwerpt een header zonder LockToken", () => {
    const { LockToken: _drop, ...rest } = valid;
    expect(brokerPropertiesSchema.safeParse(rest).success).toBe(false);
  });

  it("verwerpt een non-numerieke SequenceNumber", () => {
    const result = brokerPropertiesSchema.safeParse({ ...valid, SequenceNumber: "42" });
    expect(result.success).toBe(false);
  });

  it("verwerpt een lege MessageId (min(1))", () => {
    expect(brokerPropertiesSchema.safeParse({ ...valid, MessageId: "" }).success).toBe(false);
  });
});

// ============================================================================
// external_id derivatie
// ============================================================================

describe("deriveExternalId", () => {
  it("levert BRA-AC-{messageId}-{poNumber}", () => {
    expect(deriveExternalId("meta-123", "PO-999")).toBe("BRA-AC-meta-123-PO-999");
  });
});

// ============================================================================
// matchOrder -- met fake Supabase client
// ============================================================================

describe("matchOrder", () => {
  const parsed = wellFormedBody as unknown as ErrorQueueMessage;
  const externalId = "BRA-AC-meta-123-PO-999";

  it("matcht primair op external_id en geeft de order terug", async () => {
    const { client } = makeSelectFake({
      [`external_id=${externalId}`]: { data: [{ id: 7, status: "sent" }], error: null },
    });
    const result = await matchOrder(client, parsed, silentLogger);
    expect(result.externalId).toBe(externalId);
    expect(result.matchedOrder).toEqual({ id: 7, status: "sent" });
  });

  it("valt terug op message_id bij precies een rij", async () => {
    const { client } = makeSelectFake({
      [`external_id=${externalId}`]: { data: [], error: null }, // geen primaire match
      "message_id=meta-123": { data: [{ id: 11, status: "sent" }], error: null },
    });
    const result = await matchOrder(client, parsed, silentLogger);
    expect(result.matchedOrder).toEqual({ id: 11, status: "sent" });
  });

  it("geeft UNMATCHED bij >1 fallback-rij (geen willekeurige pick)", async () => {
    const { client } = makeSelectFake({
      [`external_id=${externalId}`]: { data: [], error: null },
      "message_id=meta-123": {
        data: [
          { id: 11, status: "sent" },
          { id: 12, status: "sent" },
        ],
        error: null,
      },
    });
    const result = await matchOrder(client, parsed, silentLogger);
    expect(result.matchedOrder).toBeNull();
  });

  it("matcht niet als de primaire external_id-query niets vindt en er geen fallback-rij is", async () => {
    const { client } = makeSelectFake({
      [`external_id=${externalId}`]: { data: [], error: null },
      "message_id=meta-123": { data: [], error: null },
    });
    const result = await matchOrder(client, parsed, silentLogger);
    expect(result.matchedOrder).toBeNull();
    expect(result.externalId).toBe(externalId);
  });

  it("doet geen external_id-match als meta.messageId of poNumber ontbreekt", async () => {
    const noPo = {
      meta: { messageId: "meta-123" },
      order: {},
      error: { stage: "S", message: "m" },
    } as unknown as ErrorQueueMessage;
    const { client, calls } = makeSelectFake({
      "message_id=meta-123": { data: [{ id: 5, status: "sent" }], error: null },
    });
    const result = await matchOrder(client, noPo, silentLogger);
    // externalId blijft null (geen poNumber), maar fallback op message_id matcht wel
    expect(result.externalId).toBeNull();
    expect(result.matchedOrder).toEqual({ id: 5, status: "sent" });
    // geen external_id-query uitgevoerd
    expect(calls.some((c) => c.column === "external_id")).toBe(false);
  });

  it("zet dbError bij een DB-fout op de external_id-query (NIET als unmatched)", async () => {
    const { client } = makeSelectFake({
      [`external_id=${externalId}`]: { data: null, error: { message: "timeout" } },
    });
    const result = await matchOrder(client, parsed, silentLogger);
    expect(result.dbError).toBe(true);
    expect(result.matchedOrder).toBeNull();
    expect(result.externalId).toBe(externalId); // externalId blijft beschikbaar voor logging
  });

  it("zet dbError bij een DB-fout op de message_id-fallback (NIET als unmatched)", async () => {
    const { client } = makeSelectFake({
      [`external_id=${externalId}`]: { data: [], error: null }, // geen primaire match
      "message_id=meta-123": { data: null, error: { message: "connection reset" } },
    });
    const result = await matchOrder(client, parsed, silentLogger);
    expect(result.dbError).toBe(true);
    expect(result.matchedOrder).toBeNull();
  });

  it("dbError is false op een normale (geslaagde) match", async () => {
    const { client } = makeSelectFake({
      [`external_id=${externalId}`]: { data: [{ id: 7, status: "sent" }], error: null },
    });
    const result = await matchOrder(client, parsed, silentLogger);
    expect(result.dbError).toBe(false);
  });
});

// ============================================================================
// applyRejection -- idempotentie + terminal-guard + update-payload
// ============================================================================

describe("applyRejection", () => {
  it("skipt idempotent als de order al bc_rejected is", async () => {
    const { client, updates } = makeUpdateFake();
    const outcome = await applyRejection(client, { id: 1, status: "bc_rejected", order_id: 100, company_id: 2 }, "err", "msg-1", null, silentLogger);
    expect(outcome).toBe("already");
    expect(updates).toHaveLength(0); // geen UPDATE
  });

  it.each(["verified", "dead_letter", "skipped"])(
    "overschrijft een terminale order (%s) NIET naar bc_rejected",
    async (status) => {
      const { client, updates } = makeUpdateFake();
      const outcome = await applyRejection(client, { id: 2, status, order_id: 100, company_id: 2 }, "err", "msg-1", null, silentLogger);
      expect(outcome).toBe("terminal");
      expect(updates).toHaveLength(0);
    },
  );

  it("zet een order in status 'sent' op bc_rejected met de juiste payload", async () => {
    const { client, updates } = makeUpdateFake();
    const outcome = await applyRejection(client, { id: 3, status: "sent", order_id: 100, company_id: 2 }, "BC zegt nee", "msg-1", null, silentLogger);
    expect(outcome).toBe("updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(3);
    expect(updates[0].payload.status).toBe("bc_rejected");
    expect(updates[0].payload.bc_error_message).toBe("BC zegt nee");
    expect(typeof updates[0].payload.failed_at).toBe("string");
  });

  it("geeft 'failed' terug als de UPDATE een DB-error oplevert", async () => {
    const { client, updates } = makeUpdateFake({ message: "deadlock" });
    const outcome = await applyRejection(client, { id: 4, status: "sent", order_id: 100, company_id: 2 }, "err", "msg-1", null, silentLogger);
    expect(outcome).toBe("failed");
    expect(updates).toHaveLength(1); // update geprobeerd, maar faalde
  });
});

// ============================================================================
// applyRejection -- bc_rejected event-logging (fase 185, TRACE-01)
// ============================================================================

describe("applyRejection bc_rejected event-logging", () => {
  const matched = {
    id: 7,
    status: "sent",
    order_id: 1001,
    company_id: 2,
    po_number: "PO-555",
    retry_count: 1,
  };

  it("logt EEN bc_rejected event bij outcome 'updated' met from_status uit matchedOrder.status", async () => {
    const { client, events } = makeRejectionFake();
    const outcome = await applyRejection(client, matched, "BC zegt nee", "msg-1", null, silentLogger);
    expect(outcome).toBe("updated");
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.event_type).toBe("bc_rejected");
    expect(ev.from_status).toBe("sent"); // overgenomen van matchedOrder.status
    expect(ev.to_status).toBe("bc_rejected");
    expect(ev.sync_order_id).toBe(7);
    expect(ev.order_id).toBe(1001);
    expect(ev.company_id).toBe(2);
    expect((ev.detail as Record<string, unknown>).po_number).toBe("PO-555");
    expect((ev.detail as Record<string, unknown>).bc_error_message).toBe("BC zegt nee");
  });

  it("schrijft de echte BC-rejectietijd (failedAtUtc) naar failed_at (PR#5 #3)", async () => {
    const { client, updates } = makeRejectionFake();
    const bcTime = "2026-06-20T08:30:00Z";
    const outcome = await applyRejection(client, matched, "BC zegt nee", "msg-ts", bcTime, silentLogger);
    expect(outcome).toBe("updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.failed_at).toBe(bcTime); // niet de verwerkingstijd
  });

  it("valt terug op de verwerkingstijd voor failed_at als failedAtUtc ontbreekt", async () => {
    const { client, updates } = makeRejectionFake();
    const outcome = await applyRejection(client, matched, "err", "msg-noTs", null, silentLogger);
    expect(outcome).toBe("updated");
    expect(typeof updates[0].payload.failed_at).toBe("string"); // fallback ISO-timestamp
  });

  it("neemt from_status 'failed' over als de order in status failed staat", async () => {
    const { client, events } = makeRejectionFake();
    const outcome = await applyRejection(
      client,
      { ...matched, status: "failed" },
      "err",
      "msg-2",
      null,
      silentLogger,
    );
    expect(outcome).toBe("updated");
    expect(events).toHaveLength(1);
    expect(events[0].from_status).toBe("failed");
  });

  it("logt GEEN event bij outcome 'already' (al bc_rejected)", async () => {
    const { client, events } = makeRejectionFake();
    const outcome = await applyRejection(
      client,
      { ...matched, status: "bc_rejected" },
      "err",
      "msg-3",
      null,
      silentLogger,
    );
    expect(outcome).toBe("already");
    expect(events).toHaveLength(0);
  });

  it.each(["verified", "dead_letter", "skipped"])(
    "logt GEEN event bij outcome 'terminal' (%s)",
    async (status) => {
      const { client, events } = makeRejectionFake();
      const outcome = await applyRejection(client, { ...matched, status }, "err", "msg-4", null, silentLogger);
      expect(outcome).toBe("terminal");
      expect(events).toHaveLength(0);
    },
  );

  it("logt GEEN event bij outcome 'failed' (UPDATE faalde)", async () => {
    const { client, events } = makeRejectionFake({ message: "deadlock" });
    const outcome = await applyRejection(client, matched, "err", "msg-5", null, silentLogger);
    expect(outcome).toBe("failed");
    expect(events).toHaveLength(0);
  });
});

// ============================================================================
// TERMINAL_STATUSES -- guard-set inhoud
// ============================================================================

describe("TERMINAL_STATUSES", () => {
  it("bevat de terminale statussen incl. bc_rejected", () => {
    expect(TERMINAL_STATUSES.has("verified")).toBe(true);
    expect(TERMINAL_STATUSES.has("dead_letter")).toBe(true);
    expect(TERMINAL_STATUSES.has("skipped")).toBe(true);
    expect(TERMINAL_STATUSES.has("bc_rejected")).toBe(true);
    expect(TERMINAL_STATUSES.has("sent")).toBe(false);
    expect(TERMINAL_STATUSES.has("pending")).toBe(false);
  });
});
