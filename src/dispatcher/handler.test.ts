import { describe, expect, it } from "vitest";
import type { SQSRecord } from "aws-lambda";

import type { BcSyncEventInsert, BcSyncEventType } from "../shared/types";
import {
  buildDispatchedEvent,
  buildRedispatchedEvent,
  buildSendFailedEvent,
  buildSentEvent,
  buildSentFallbackEvent,
  buildStaleRecoveredEvent,
  type DispatchContext,
  type DispatchedRow,
  type SyncOrderRow,
} from "./event-builders";
import { extractSqsContext } from "./handler";

// ============================================================================
// Per-transition event-builder tests (fase 185, TRACE-01).
//
// De event-bouwlogica is geëxtraheerd uit handler.ts/order-fetcher.ts naar
// pure builders zodat de event_type<->status-mapping (D-08) en de D-06
// db_update_failed-fallback deterministisch vast te leggen zijn -- zonder de
// hele Lambda-handler (Service Bus, fetchers) te hoeven aansturen.
// ============================================================================

const ctx: DispatchContext = {
  batchId: "batch-1",
  messageId: "msg-1",
  correlationId: "corr-1",
  traceId: "trace-abc",
};

const dispatchedRow: DispatchedRow = {
  sync_order_id: 10,
  order_id: 100,
  company_id: 2,
  po_number: "PO-100",
};

const syncOrderRow: SyncOrderRow = {
  id: 10,
  order_id: 100,
  company_id: 2,
  po_number: "PO-100",
  retry_count: 0,
};

/** De toegestane from/to_status-set uit de DB-CHECK (Pitfall 2-bewustzijn). */
const ALLOWED_STATUSES = new Set([
  "pending",
  "sent",
  "verified",
  "failed",
  "dead_letter",
  "skipped",
  "bc_rejected",
  null,
  undefined,
]);

function assertStatusesValid(event: BcSyncEventInsert): void {
  expect(ALLOWED_STATUSES.has(event.from_status as string)).toBe(true);
  expect(ALLOWED_STATUSES.has(event.to_status as string)).toBe(true);
}

// ============================================================================
// event_type <-> status mapping (D-08) -- parametrisch over de 5 dispatcher-types
// ============================================================================

describe("dispatcher event_type <-> status mapping (D-08)", () => {
  const cases: Array<{
    name: BcSyncEventType;
    event: BcSyncEventInsert;
    fromStatus: string | null;
    toStatus: string;
  }> = [
    {
      name: "dispatched",
      event: buildDispatchedEvent(dispatchedRow, ctx),
      fromStatus: null,
      toStatus: "pending",
    },
    {
      name: "sent",
      event: buildSentEvent(syncOrderRow, ctx),
      fromStatus: "pending",
      toStatus: "sent",
    },
    {
      name: "send_failed",
      event: buildSendFailedEvent(syncOrderRow, ctx.batchId, "boom", "trace-abc"),
      fromStatus: "pending",
      toStatus: "failed",
    },
    {
      name: "redispatched",
      event: buildRedispatchedEvent(
        { sync_order_id: 10, order_id: 100, company_id: 2, po_number: "PO-100", retry_count: 2 },
        ctx,
      ),
      fromStatus: "failed",
      toStatus: "pending",
    },
    {
      name: "stale_recovered",
      event: buildStaleRecoveredEvent(
        { sync_order_id: 10, order_id: 100, company_id: 2, po_number: "PO-100", retry_count: 1 },
        "Recovered from stale pending",
        7,
        "trace-abc",
      ),
      fromStatus: "pending",
      toStatus: "failed",
    },
  ];

  it.each(cases)(
    "$name schrijft het juiste event_type + from/to_status + po_number in detail",
    ({ name, event, fromStatus, toStatus }) => {
      expect(event.event_type).toBe(name);
      expect(event.from_status ?? null).toBe(fromStatus);
      expect(event.to_status).toBe(toStatus);
      // D-04: po_number altijd in detail.
      expect((event.detail as Record<string, unknown>).po_number).toBe("PO-100");
      // D-04: company_id NIET dupliceren in detail (al een kolom).
      expect((event.detail as Record<string, unknown>).company_id).toBeUndefined();
      // Pitfall 2: alle statussen binnen de DB-CHECK-set.
      assertStatusesValid(event);
    },
  );
});

// ============================================================================
// dispatched: per-order identiteit + retry_count 0
// ============================================================================

describe("buildDispatchedEvent", () => {
  it("zet sync_order_id/order_id/company_id en retry_count 0", () => {
    const event = buildDispatchedEvent(dispatchedRow, ctx);
    expect(event.sync_order_id).toBe(10);
    expect(event.order_id).toBe(100);
    expect(event.company_id).toBe(2);
    expect(event.retry_count).toBe(0);
    expect(event.from_status).toBeNull();
    expect(event.to_status).toBe("pending");
  });
});

// ============================================================================
// sent happy-path vs. D-06 db_update_failed-edge
// ============================================================================

describe("buildSentEvent (happy-path)", () => {
  it("mapt een .select()-rij naar pending -> sent zonder db_update_failed", () => {
    const event = buildSentEvent(syncOrderRow, ctx);
    expect(event.event_type).toBe("sent");
    expect(event.from_status).toBe("pending");
    expect(event.to_status).toBe("sent");
    expect(event.sync_order_id).toBe(10);
    expect((event.detail as Record<string, unknown>).db_update_failed).toBeUndefined();
  });
});

describe("buildSentFallbackEvent (D-06 edge)", () => {
  it("logt tóch een sent-event met db_update_failed=true en sync_order_id uit de map", () => {
    const event = buildSentFallbackEvent(dispatchedRow, ctx);
    expect(event.event_type).toBe("sent");
    expect(event.from_status).toBe("pending");
    expect(event.to_status).toBe("sent");
    // sync_order_id komt uit de in-memory map -> niet undefined (T-185-07).
    expect(event.sync_order_id).toBe(10);
    expect(typeof event.sync_order_id).toBe("number");
    expect((event.detail as Record<string, unknown>).db_update_failed).toBe(true);
    expect((event.detail as Record<string, unknown>).po_number).toBe("PO-100");
  });
});

// ============================================================================
// send_failed: error_message in detail
// ============================================================================

describe("buildSendFailedEvent", () => {
  it("zet to_status failed en error_message in detail", () => {
    const event = buildSendFailedEvent(syncOrderRow, "batch-9", "BC rejected envelope", "trace-abc");
    expect(event.event_type).toBe("send_failed");
    expect(event.to_status).toBe("failed");
    expect((event.detail as Record<string, unknown>).error_message).toBe("BC rejected envelope");
    expect(event.batch_id).toBe("batch-9");
  });
});

// ============================================================================
// redispatched: failed -> pending met opgehoogde retry_count
// ============================================================================

describe("buildRedispatchedEvent", () => {
  it("draagt de nieuwe retry_count en from failed -> to pending", () => {
    const event = buildRedispatchedEvent(
      { sync_order_id: 10, order_id: 100, company_id: 2, po_number: "PO-100", retry_count: 3 },
      ctx,
    );
    expect(event.event_type).toBe("redispatched");
    expect(event.from_status).toBe("failed");
    expect(event.to_status).toBe("pending");
    expect(event.retry_count).toBe(3);
  });
});

// ============================================================================
// stale_recovered: reden + leeftijd in detail (order-fetcher transitie)
// ============================================================================

describe("buildStaleRecoveredEvent", () => {
  it("zet pending -> failed met reason en age_min in detail", () => {
    const event = buildStaleRecoveredEvent(
      { sync_order_id: 10, order_id: 100, company_id: 2, po_number: "PO-100", retry_count: 1 },
      "Recovered from stale pending",
      12,
      "trace-abc",
    );
    expect(event.event_type).toBe("stale_recovered");
    expect(event.from_status).toBe("pending");
    expect(event.to_status).toBe("failed");
    const detail = event.detail as Record<string, unknown>;
    expect(detail.po_number).toBe("PO-100");
    expect(detail.reason).toBe("Recovered from stale pending");
    expect(detail.age_min).toBe(12);
  });

  it("tolereert een ontbrekende leeftijd (age_min null)", () => {
    const event = buildStaleRecoveredEvent(
      { sync_order_id: 10, order_id: 100, company_id: 2, po_number: "PO-100", retry_count: 1 },
      "Recovered from stale pending",
      null,
      "trace-abc",
    );
    expect((event.detail as Record<string, unknown>).age_min).toBeNull();
  });
});

// ============================================================================
// extractSqsContext — traceId extractie + fallback (fase 207-02, TRACE-04)
// ============================================================================

describe("extractSqsContext", () => {
  it("extraheert traceId uit de SQS body als het aanwezig is", () => {
    const record = {
      body: JSON.stringify({ companyId: 2, traceId: "abc-123" }),
    } as SQSRecord;
    const result = extractSqsContext(record);
    expect(result).not.toBeNull();
    expect(result?.companyId).toBe(2);
    expect(result?.traceId).toBe("abc-123");
  });

  it("valt terug op lege string als traceId ontbreekt in de body", () => {
    const record = {
      body: JSON.stringify({ companyId: 2 }),
    } as SQSRecord;
    const result = extractSqsContext(record);
    expect(result).not.toBeNull();
    expect(result?.traceId).toBe("");
  });

  it("valt terug op lege string als traceId een lege string is", () => {
    const record = {
      body: JSON.stringify({ companyId: 2, traceId: "" }),
    } as SQSRecord;
    const result = extractSqsContext(record);
    expect(result?.traceId).toBe("");
  });

  it("retourneert null bij ontbrekende of ongeldige companyId", () => {
    const record = {
      body: JSON.stringify({ companyId: "invalid", traceId: "abc" }),
    } as SQSRecord;
    expect(extractSqsContext(record)).toBeNull();
  });

  it("retourneert null bij een ongeldig JSON-body", () => {
    const record = { body: "not json" } as SQSRecord;
    expect(extractSqsContext(record)).toBeNull();
  });
});
