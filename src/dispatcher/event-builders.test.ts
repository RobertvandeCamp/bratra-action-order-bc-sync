import { describe, expect, it } from "vitest";

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

// ============================================================================
// trace_id-in-detail tests (fase 207-02, TRACE-04/D-00c)
//
// Asserteert dat DispatchContext.traceId in elk builder-detail terechtkomt
// via `trace_id`, zodat het in bc_sync_events.detail JSONB belandt zonder
// DB-migratie (D-00c). Loose-param builders (buildSendFailedEvent,
// buildStaleRecoveredEvent) krijgen traceId als apart argument.
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

describe("trace_id in event detail (D-00c / TRACE-04)", () => {
  it("buildDispatchedEvent bevat trace_id in detail", () => {
    const event = buildDispatchedEvent(dispatchedRow, ctx);
    expect(event.detail).toMatchObject({ trace_id: "trace-abc" });
  });

  it("buildSentEvent bevat trace_id in detail", () => {
    const event = buildSentEvent(syncOrderRow, ctx);
    expect(event.detail).toMatchObject({ trace_id: "trace-abc" });
  });

  it("buildSentFallbackEvent bevat trace_id in detail (D-06 edge)", () => {
    const event = buildSentFallbackEvent(dispatchedRow, ctx);
    expect(event.detail).toMatchObject({ trace_id: "trace-abc" });
  });

  it("buildRedispatchedEvent bevat trace_id in detail", () => {
    const event = buildRedispatchedEvent(
      { sync_order_id: 10, order_id: 100, company_id: 2, po_number: "PO-100", retry_count: 2 },
      ctx,
    );
    expect(event.detail).toMatchObject({ trace_id: "trace-abc" });
  });

  it("buildSendFailedEvent bevat trace_id in detail (los traceId-arg)", () => {
    const event = buildSendFailedEvent(syncOrderRow, "batch-1", "error msg", "trace-abc");
    expect(event.detail).toMatchObject({ trace_id: "trace-abc" });
  });

  it("buildStaleRecoveredEvent bevat trace_id in detail (los traceId-arg)", () => {
    const event = buildStaleRecoveredEvent(
      { sync_order_id: 10, order_id: 100, company_id: 2, po_number: "PO-100", retry_count: 1 },
      "Recovered from stale pending",
      7,
      "trace-abc",
    );
    expect(event.detail).toMatchObject({ trace_id: "trace-abc" });
  });
});

describe("trace_id isolatie — verschillende traceId-waarden", () => {
  it("buildDispatchedEvent gebruikt de traceId van de doorgegeven context, niet een vaste waarde", () => {
    const ctxX: DispatchContext = { ...ctx, traceId: "trace-xyz" };
    const event = buildDispatchedEvent(dispatchedRow, ctxX);
    expect((event.detail as Record<string, unknown>).trace_id).toBe("trace-xyz");
  });
});
