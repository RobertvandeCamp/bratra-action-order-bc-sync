import { describe, expect, it } from "vitest";

import type { getSupabaseClient } from "../shared/supabase-client";
import type { ErrorQueueMessage } from "../shared/types";
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
    const result = await matchOrder(client, parsed);
    expect(result.externalId).toBe(externalId);
    expect(result.matchedOrder).toEqual({ id: 7, status: "sent" });
  });

  it("valt terug op message_id bij precies een rij", async () => {
    const { client } = makeSelectFake({
      [`external_id=${externalId}`]: { data: [], error: null }, // geen primaire match
      "message_id=meta-123": { data: [{ id: 11, status: "sent" }], error: null },
    });
    const result = await matchOrder(client, parsed);
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
    const result = await matchOrder(client, parsed);
    expect(result.matchedOrder).toBeNull();
  });

  it("matcht niet als de primaire external_id-query niets vindt en er geen fallback-rij is", async () => {
    const { client } = makeSelectFake({
      [`external_id=${externalId}`]: { data: [], error: null },
      "message_id=meta-123": { data: [], error: null },
    });
    const result = await matchOrder(client, parsed);
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
    const result = await matchOrder(client, noPo);
    // externalId blijft null (geen poNumber), maar fallback op message_id matcht wel
    expect(result.externalId).toBeNull();
    expect(result.matchedOrder).toEqual({ id: 5, status: "sent" });
    // geen external_id-query uitgevoerd
    expect(calls.some((c) => c.column === "external_id")).toBe(false);
  });
});

// ============================================================================
// applyRejection -- idempotentie + terminal-guard + update-payload
// ============================================================================

describe("applyRejection", () => {
  it("skipt idempotent als de order al bc_rejected is", async () => {
    const { client, updates } = makeUpdateFake();
    const outcome = await applyRejection(client, { id: 1, status: "bc_rejected" }, "err", "msg-1");
    expect(outcome).toBe("already");
    expect(updates).toHaveLength(0); // geen UPDATE
  });

  it.each(["verified", "dead_letter", "skipped"])(
    "overschrijft een terminale order (%s) NIET naar bc_rejected",
    async (status) => {
      const { client, updates } = makeUpdateFake();
      const outcome = await applyRejection(client, { id: 2, status }, "err", "msg-1");
      expect(outcome).toBe("terminal");
      expect(updates).toHaveLength(0);
    },
  );

  it("zet een order in status 'sent' op bc_rejected met de juiste payload", async () => {
    const { client, updates } = makeUpdateFake();
    const outcome = await applyRejection(client, { id: 3, status: "sent" }, "BC zegt nee", "msg-1");
    expect(outcome).toBe("updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(3);
    expect(updates[0].payload.status).toBe("bc_rejected");
    expect(updates[0].payload.bc_error_message).toBe("BC zegt nee");
    expect(typeof updates[0].payload.failed_at).toBe("string");
  });

  it("geeft 'failed' terug als de UPDATE een DB-error oplevert", async () => {
    const { client, updates } = makeUpdateFake({ message: "deadlock" });
    const outcome = await applyRejection(client, { id: 4, status: "sent" }, "err", "msg-1");
    expect(outcome).toBe("failed");
    expect(updates).toHaveLength(1); // update geprobeerd, maar faalde
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
