import { describe, expect, it, vi } from "vitest";
import type { Context, SQSRecord } from "aws-lambda";

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
import { extractSqsContext, handler } from "./handler";

// ============================================================================
// Logger-spy + crashende config voor de CR-02 crash-summary test onderaan.
// De logger-mock registreert alle calls (ook die van extractSqsContext, die de
// base logger gebruikt); de config-mock laat getConfig gooien zodat de handler
// crasht vóór de batch-loop (het pad dat vóór CR-02 status "ok" rapporteerde).
// ============================================================================

const { logCalls } = vi.hoisted(() => ({
  logCalls: [] as Array<{ level: string; obj: unknown; msg?: string }>,
}));

vi.mock("../shared/logger", () => {
  const record =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      logCalls.push({ level, obj, msg });
    };
  const spyLogger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  };
  return { logger: spyLogger, createRunLogger: () => spyLogger };
});

vi.mock("../shared/config", () => ({
  FETCH_TIMEOUT_MS: 30_000,
  getConfig: () => {
    throw new Error("boom: config invalid (simulated Zod failure)");
  },
}));

// aws-embedded-metrics: mock zodat emitDispatcherMetrics() geen netwerkverbinding
// probeert in tests (ECONNREFUSED 0.0.0.0:25888 bij echte flush naar CW Agent).
vi.mock("aws-embedded-metrics", () => ({
  createMetricsLogger: vi.fn(() => ({
    setNamespace: vi.fn(),
    setDimensions: vi.fn(),
    putMetric: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
  Unit: { Count: "Count" },
}));

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

// ============================================================================
// CR-02: een crash buiten de per-batch catches (hier: getConfig gooit) moet
// precies één dispatch.summary met status "failed" emitten én rethrowen
// (SQS-retry-semantiek). Vóór de fix rapporteerde dit pad status "ok".
// ============================================================================

describe("dispatcher crash -> dispatch.summary (CR-02)", () => {
  it("emit precies één dispatch.summary met status 'failed' en rethrowt de crash", async () => {
    logCalls.length = 0;
    const context = { awsRequestId: "req-crash-1" } as Context;

    // Scheduled/manual pad (geen Records) -> getConfig() gooit in de try.
    await expect(
      handler({} as never, context),
    ).rejects.toThrow("boom: config invalid");

    const summaries = logCalls.filter(
      (c) => (c.obj as Record<string, unknown> | undefined)?.event === "dispatch.summary",
    );
    expect(summaries).toHaveLength(1);
    const summaryObj = summaries[0].obj as Record<string, unknown>;
    expect(summaryObj.status).toBe("failed");
    expect(summaryObj.ordersSent).toBe(0);
    expect(summaryObj.ordersFailed).toBe(0);

    // De crash zelf is als error gelogd (diagnose-signaal naast de summary).
    const crashErrors = logCalls.filter(
      (c) =>
        c.level === "error" &&
        c.msg === "Dispatcher run failed unexpectedly",
    );
    expect(crashErrors).toHaveLength(1);
  });
});

// ============================================================================
// Round 2 F2: een ongeldig SQS-bericht (onparseerbare body) keert terug VÓÓR de
// try/finally en produceerde daardoor een run zonder dispatch.summary. De fix
// emit op dat pad precies één summary met status "failed" en reason
// "invalid_sqs_message", zonder de retry-semantiek te veranderen (het bericht
// wordt nog steeds ingeslikt -- resolve, geen rethrow, geen SQS-redrive storm).
// ============================================================================

describe("dispatcher invalid SQS message -> dispatch.summary (round 2 F2)", () => {
  it("slikt het bericht in (resolve) en emit exact één failed summary met reason invalid_sqs_message", async () => {
    logCalls.length = 0;
    const context = { awsRequestId: "req-invalid-sqs-1" } as Context;
    const event = { Records: [{ body: "not json" } as SQSRecord] };

    // Resolve (geen reject) bewijst óók dat de early-return vóór de try ligt:
    // de gemockte getConfig() zou anders gooien (zie CR-02-test hierboven).
    await expect(handler(event as never, context)).resolves.toBeUndefined();

    const summaries = logCalls.filter(
      (c) => (c.obj as Record<string, unknown> | undefined)?.event === "dispatch.summary",
    );
    expect(summaries).toHaveLength(1);
    const summaryObj = summaries[0].obj as Record<string, unknown>;
    expect(summaryObj.status).toBe("failed");
    expect(summaryObj.reason).toBe("invalid_sqs_message");
    expect(summaryObj.ordersSent).toBe(0);
    expect(summaryObj.ordersFailed).toBe(0);
    expect(summaryObj.batchesProcessed).toBe(0);
    expect(summaryObj.retriedOrders).toBe(0);
  });

  it("een geldig SQS-bericht met crashende config emit óók exact één summary (geen dubbel-emit op het SQS-pad)", async () => {
    logCalls.length = 0;
    const context = { awsRequestId: "req-valid-sqs-1" } as Context;
    const event = {
      Records: [{ body: JSON.stringify({ companyId: 2, traceId: "t-1" }) } as SQSRecord],
    };

    // Geldig bericht -> voorbij de early-return -> getConfig() gooit -> rethrow.
    await expect(handler(event as never, context)).rejects.toThrow("boom: config invalid");

    const summaries = logCalls.filter(
      (c) => (c.obj as Record<string, unknown> | undefined)?.event === "dispatch.summary",
    );
    expect(summaries).toHaveLength(1);
    expect((summaries[0].obj as Record<string, unknown>).status).toBe("failed");
  });
});
