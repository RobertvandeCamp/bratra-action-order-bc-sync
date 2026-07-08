import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, ScheduledEvent } from "aws-lambda";
import type { BcSyncOrderRow } from "../shared/types";

// ============================================================================
// Handler-level tests voor de verifier:
// - Round 2 F1: crash -> precies één verify.summary met status "failed" + rethrow
// - PR #16 review: stuckInSent-telling (sent_at < now-60min) op de sentOrders-set
//
// Alle collaborators zijn gemockt via configureerbare vi.fn()'s zodat per test
// het gedrag gezet kan worden (getConfig gooit in de crash-test, levert een
// valide config in de stuckInSent-tests).
// ============================================================================

const { logCalls, mocks } = vi.hoisted(() => ({
  logCalls: [] as Array<{ level: string; obj: unknown; msg?: string }>,
  mocks: {
    getConfig: vi.fn(),
    fetchAllPages: vi.fn(),
    checkErrorQueue: vi.fn(),
    checkBufferStatuses: vi.fn(),
    checkDlqMessages: vi.fn(),
    authenticateM2M: vi.fn(),
    emitVerifierMetrics: vi.fn(),
  },
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
  getConfig: mocks.getConfig,
}));

vi.mock("../shared/supabase-client", () => ({
  getSupabaseClient: () => ({}),
}));

vi.mock("../shared/bc-auth", () => ({
  authenticateM2M: mocks.authenticateM2M,
}));

vi.mock("../shared/paginate", () => ({
  fetchAllPages: mocks.fetchAllPages,
}));

vi.mock("./bc-buffer-checker", () => ({
  checkBufferStatuses: mocks.checkBufferStatuses,
}));

vi.mock("./dlq-checker", () => ({
  checkDlqMessages: mocks.checkDlqMessages,
}));

vi.mock("./error-queue-checker", () => ({
  checkErrorQueue: mocks.checkErrorQueue,
}));

// ../shared/metrics: emitVerifierMetrics als spy (assert de doorgegeven counts);
// emitMetricsSafely met echte guard-semantiek (await + swallow) zodat de
// handler-flow niet afwijkt van productie.
vi.mock("../shared/metrics", () => ({
  emitVerifierMetrics: mocks.emitVerifierMetrics,
  emitMetricsSafely: async (emit: Promise<void>): Promise<void> => {
    try {
      await emit;
    } catch {
      // guard: swallow (spiegelt de echte emitMetricsSafely)
    }
  },
}));

import { handler } from "./handler";

const context = { awsRequestId: "req-verifier-test-1" } as Context;

/** Minimaal order-fixture: de handler leest alleen sent_at voor stuckInSent. */
function makeSentOrder(sentAt: string | null | undefined): BcSyncOrderRow {
  return { id: 1, sent_at: sentAt } as unknown as BcSyncOrderRow;
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

beforeEach(() => {
  logCalls.length = 0;
  vi.clearAllMocks();

  // Happy-path defaults; individuele tests overriden waar nodig.
  mocks.getConfig.mockReturnValue({
    BC_ENVIRONMENT: "Sandbox-Test",
    BC_TENANT_ID: "tenant-1",
    BC_COMPANY_ID: "company-1",
  });
  mocks.checkErrorQueue.mockResolvedValue({
    archived: 0,
    matched: 0,
    unmatched: 0,
    skipped: 0,
    deleted: 0,
    errors: 0,
  });
  mocks.fetchAllPages.mockResolvedValue([]);
  mocks.authenticateM2M.mockResolvedValue("token");
  mocks.checkBufferStatuses.mockResolvedValue({
    verified: 0,
    retried: 0,
    deadLetter: 0,
    pending: 0,
    notFound: 0,
    errors: 0,
  });
  mocks.checkDlqMessages.mockResolvedValue({
    processed: 0,
    matched: 0,
    unmatched: 0,
    skipped: 0,
    errors: 0,
  });
  mocks.emitVerifierMetrics.mockResolvedValue(undefined);
});

describe("verifier crash -> verify.summary + rethrow (round 2 F1)", () => {
  it("emit precies één verify.summary met status 'failed' en rethrowt de crash", async () => {
    mocks.getConfig.mockImplementation(() => {
      throw new Error("boom: config invalid (simulated Zod failure)");
    });

    // getConfig() gooit als eerste statement in de try -> outer catch -> rethrow.
    await expect(
      handler({} as ScheduledEvent, context),
    ).rejects.toThrow("boom: config invalid");

    // Finally draait vóór de propagatie: exact één verify.summary, status failed.
    const summaries = logCalls.filter(
      (c) => (c.obj as Record<string, unknown> | undefined)?.event === "verify.summary",
    );
    expect(summaries).toHaveLength(1);
    const summaryObj = summaries[0].obj as Record<string, unknown>;
    expect(summaryObj.status).toBe("failed");
    // Crash vóór de sent-orders-query -> buffer-note "not reached" (WR-02).
    expect(summaryObj.buffer).toBe("not reached");

    // De crash zelf is als error gelogd (diagnose-signaal naast de summary).
    const crashErrors = logCalls.filter(
      (c) => c.level === "error" && c.msg === "Verifier run failed unexpectedly",
    );
    expect(crashErrors).toHaveLength(1);

    // Ook op het crash-pad wordt precies één metriek-record geëmit (finally),
    // met de veilige default stuckInSent: 0 (crash vóór de fetch).
    expect(mocks.emitVerifierMetrics).toHaveBeenCalledTimes(1);
    expect(mocks.emitVerifierMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ stuckInSent: 0 }),
    );
  });
});

// ============================================================================
// stuckInSent (PR #16 review): sent_at < now-60min telt; nieuwer telt niet;
// null/undefined sent_at wordt uitgesloten zonder te gooien.
// ============================================================================

describe("stuckInSent-telling in emitVerifierMetrics", () => {
  it("telt orders met sent_at ouder dan 60 min; nieuwere niet", async () => {
    mocks.fetchAllPages.mockResolvedValue([
      makeSentOrder(minutesAgoIso(90)), // stuck
      makeSentOrder(minutesAgoIso(65)), // stuck
      makeSentOrder(minutesAgoIso(30)), // niet stuck (wel >2min 'sent')
      makeSentOrder(minutesAgoIso(5)), // niet stuck
    ]);

    await handler({} as ScheduledEvent, context);

    expect(mocks.emitVerifierMetrics).toHaveBeenCalledTimes(1);
    expect(mocks.emitVerifierMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ stuckInSent: 2 }),
    );
  });

  it("emit stuckInSent: 0 wanneer alle sent orders jonger dan 60 min zijn", async () => {
    mocks.fetchAllPages.mockResolvedValue([
      makeSentOrder(minutesAgoIso(10)),
      makeSentOrder(minutesAgoIso(45)),
    ]);

    await handler({} as ScheduledEvent, context);

    expect(mocks.emitVerifierMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ stuckInSent: 0 }),
    );
  });

  it("sluit null/undefined sent_at uit zonder te gooien", async () => {
    // null: expliciet uitgefilterd (o.sent_at !== null); undefined: valt door
    // de string-vergelijking (undefined < iso is altijd false) — beide tellen
    // niet mee en de run crasht niet.
    mocks.fetchAllPages.mockResolvedValue([
      makeSentOrder(null),
      makeSentOrder(undefined),
      makeSentOrder(minutesAgoIso(120)), // enige stuck order
    ]);

    await expect(
      handler({} as ScheduledEvent, context),
    ).resolves.toBeUndefined();

    expect(mocks.emitVerifierMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ stuckInSent: 1 }),
    );

    // Sanity: de run zelf is ok (geen crash-pad geraakt).
    const summaries = logCalls.filter(
      (c) => (c.obj as Record<string, unknown> | undefined)?.event === "verify.summary",
    );
    expect(summaries).toHaveLength(1);
    expect((summaries[0].obj as Record<string, unknown>).status).toBe("ok");
  });
});
