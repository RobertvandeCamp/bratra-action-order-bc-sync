import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Mock aws-embedded-metrics op top-level (voor hoisting).
// flush() resolveert naar undefined — geen live CloudWatch-assertie nodig.
// ============================================================================
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
// resolveMetricsTarget — APP_TARGET resolutie
//
// De module is een singleton, dus elke case importeert vers via
// vi.resetModules() + dynamic import (spiegelt logger.test.ts round-2-F3).
// ============================================================================

describe("resolveMetricsTarget", () => {
  let originalAppTarget: string | undefined;

  beforeEach(() => {
    originalAppTarget = process.env.APP_TARGET;
  });

  afterEach(() => {
    if (originalAppTarget === undefined) {
      delete process.env.APP_TARGET;
    } else {
      process.env.APP_TARGET = originalAppTarget;
    }
    vi.resetModules();
  });

  async function importFreshMetrics() {
    vi.resetModules();
    return import("./metrics");
  }

  it('APP_TARGET="production" resolveert naar "production"', async () => {
    process.env.APP_TARGET = "production";
    const { resolveMetricsTarget } = await importFreshMetrics();
    expect(resolveMetricsTarget()).toBe("production");
  });

  it('APP_TARGET="sandbox" resolveert naar "sandbox"', async () => {
    process.env.APP_TARGET = "sandbox";
    const { resolveMetricsTarget } = await importFreshMetrics();
    expect(resolveMetricsTarget()).toBe("sandbox");
  });

  it("ongezette APP_TARGET valt terug op 'sandbox'", async () => {
    delete process.env.APP_TARGET;
    const { resolveMetricsTarget } = await importFreshMetrics();
    expect(resolveMetricsTarget()).toBe("sandbox");
  });

  it("lege APP_TARGET valt terug op 'sandbox'", async () => {
    process.env.APP_TARGET = "   "; // whitespace-only
    const { resolveMetricsTarget } = await importFreshMetrics();
    expect(resolveMetricsTarget()).toBe("sandbox");
  });
});

// ============================================================================
// emitDispatcherMetrics — exported async function, resolves zonder te gooien
// ============================================================================

describe("emitDispatcherMetrics", () => {
  it("is een exported async function", async () => {
    const { emitDispatcherMetrics } = await import("./metrics");
    expect(typeof emitDispatcherMetrics).toBe("function");
  });

  it("resolves zonder te gooien bij zeroed counts", async () => {
    const { emitDispatcherMetrics } = await import("./metrics");
    await expect(
      emitDispatcherMetrics({
        ordersSent: 0,
        ordersFailed: 0,
        retriedOrders: 0,
        batchesProcessed: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves zonder te gooien bij positieve counts", async () => {
    const { emitDispatcherMetrics } = await import("./metrics");
    await expect(
      emitDispatcherMetrics({
        ordersSent: 5,
        ordersFailed: 1,
        retriedOrders: 2,
        batchesProcessed: 3,
      }),
    ).resolves.toBeUndefined();
  });
});

// ============================================================================
// emitVerifierMetrics — exported async function, resolves zonder te gooien
// ============================================================================

describe("emitVerifierMetrics", () => {
  it("is een exported async function", async () => {
    const { emitVerifierMetrics } = await import("./metrics");
    expect(typeof emitVerifierMetrics).toBe("function");
  });

  it("resolves zonder te gooien bij zeroed counts", async () => {
    const { emitVerifierMetrics } = await import("./metrics");
    await expect(
      emitVerifierMetrics({
        ordersVerified: 0,
        ordersBcRejected: 0,
        ordersDeadLetter: 0,
        dlqDepth: 0,
        errorQueueMessages: 0,
        stuckInSent: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves zonder te gooien bij positieve counts", async () => {
    const { emitVerifierMetrics } = await import("./metrics");
    await expect(
      emitVerifierMetrics({
        ordersVerified: 10,
        ordersBcRejected: 2,
        ordersDeadLetter: 1,
        dlqDepth: 3,
        errorQueueMessages: 5,
        stuckInSent: 4,
      }),
    ).resolves.toBeUndefined();
  });
});
