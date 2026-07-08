import { describe, expect, it, vi } from "vitest";
import type { Context, ScheduledEvent } from "aws-lambda";

// ============================================================================
// Round 2 F1: een crash buiten de per-checker catches (hier: getConfig gooit)
// moet precies één verify.summary met status "failed" emitten ÉN rethrowen,
// zodat de Lambda-invocatie faalt (AWS Errors-metric / 999.25-alarmen).
// Vóór de fix slikte de outer catch de exception in en leek een gecrashte
// verifier-run een geslaagde invocatie. Spiegelt de dispatcher CR-02-test.
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

// aws-embedded-metrics: mock zodat emitVerifierMetrics() geen netwerkverbinding
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

import { handler } from "./handler";

describe("verifier crash -> verify.summary + rethrow (round 2 F1)", () => {
  it("emit precies één verify.summary met status 'failed' en rethrowt de crash", async () => {
    logCalls.length = 0;
    const context = { awsRequestId: "req-verifier-crash-1" } as Context;

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
  });
});
