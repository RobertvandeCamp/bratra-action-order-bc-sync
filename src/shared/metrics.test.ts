import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMetricsLogger } from "aws-embedded-metrics";

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

const mockedCreateMetricsLogger = vi.mocked(createMetricsLogger);

function makeMockLogger() {
  return {
    setNamespace: vi.fn(),
    setDimensions: vi.fn(),
    putMetric: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

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

// ============================================================================
// Lock-step-checks (WR-06): dit is de CANONIEKE module — een typo in
// namespace, dimensies of metriek-namen propageert naar drie repos.
// Asserteer daarom exact wat er geput wordt (spiegelt het patroon van
// bratra-action-order-bc-sync-trigger/src/metrics.test.ts).
// ============================================================================

describe("emitDispatcherMetrics lock-step checks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('gebruikt namespace "Bratra/BcSync" en dimensies {Service:"dispatcher", Target} met precies één flush', async () => {
    vi.stubEnv("APP_TARGET", "production");
    const mockLogger = makeMockLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCreateMetricsLogger.mockReturnValueOnce(mockLogger as any);

    const { emitDispatcherMetrics } = await import("./metrics");
    await emitDispatcherMetrics({
      ordersSent: 0,
      ordersFailed: 0,
      retriedOrders: 0,
      batchesProcessed: 0,
    });

    expect(mockLogger.setNamespace).toHaveBeenCalledWith("Bratra/BcSync");
    expect(mockLogger.setDimensions).toHaveBeenCalledWith({
      Service: "dispatcher",
      Target: "production",
    });
    expect(mockLogger.flush).toHaveBeenCalledTimes(1);
  });

  it("emiteert exact de vier MET-01 metriek-namen met de aangeleverde waarden", async () => {
    vi.stubEnv("APP_TARGET", "sandbox");
    const mockLogger = makeMockLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCreateMetricsLogger.mockReturnValueOnce(mockLogger as any);

    const { emitDispatcherMetrics } = await import("./metrics");
    await emitDispatcherMetrics({
      ordersSent: 5,
      ordersFailed: 1,
      retriedOrders: 2,
      batchesProcessed: 3,
    });

    expect(mockLogger.putMetric).toHaveBeenCalledTimes(4);
    expect(mockLogger.putMetric).toHaveBeenCalledWith("OrdersSent", 5, "Count");
    expect(mockLogger.putMetric).toHaveBeenCalledWith("OrdersFailed", 1, "Count");
    expect(mockLogger.putMetric).toHaveBeenCalledWith("RetriedOrders", 2, "Count");
    expect(mockLogger.putMetric).toHaveBeenCalledWith("BatchesProcessed", 3, "Count");
    expect(mockLogger.setDimensions).toHaveBeenCalledWith({
      Service: "dispatcher",
      Target: "sandbox",
    });
  });
});

describe("emitVerifierMetrics lock-step checks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('gebruikt namespace "Bratra/BcSync" en dimensies {Service:"verifier", Target} met precies één flush', async () => {
    vi.stubEnv("APP_TARGET", "production");
    const mockLogger = makeMockLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCreateMetricsLogger.mockReturnValueOnce(mockLogger as any);

    const { emitVerifierMetrics } = await import("./metrics");
    await emitVerifierMetrics({
      ordersVerified: 0,
      ordersBcRejected: 0,
      ordersDeadLetter: 0,
      dlqDepth: 0,
      errorQueueMessages: 0,
      stuckInSent: 0,
    });

    expect(mockLogger.setNamespace).toHaveBeenCalledWith("Bratra/BcSync");
    expect(mockLogger.setDimensions).toHaveBeenCalledWith({
      Service: "verifier",
      Target: "production",
    });
    expect(mockLogger.flush).toHaveBeenCalledTimes(1);
  });

  it("emiteert exact de zes MET-02 metriek-namen met de aangeleverde waarden", async () => {
    vi.stubEnv("APP_TARGET", "sandbox");
    const mockLogger = makeMockLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCreateMetricsLogger.mockReturnValueOnce(mockLogger as any);

    const { emitVerifierMetrics } = await import("./metrics");
    await emitVerifierMetrics({
      ordersVerified: 10,
      ordersBcRejected: 2,
      ordersDeadLetter: 1,
      dlqDepth: 3,
      errorQueueMessages: 5,
      stuckInSent: 4,
    });

    expect(mockLogger.putMetric).toHaveBeenCalledTimes(6);
    expect(mockLogger.putMetric).toHaveBeenCalledWith("OrdersVerified", 10, "Count");
    expect(mockLogger.putMetric).toHaveBeenCalledWith("OrdersBcRejected", 2, "Count");
    expect(mockLogger.putMetric).toHaveBeenCalledWith("OrdersDeadLetter", 1, "Count");
    expect(mockLogger.putMetric).toHaveBeenCalledWith("DlqDepth", 3, "Count");
    expect(mockLogger.putMetric).toHaveBeenCalledWith("ErrorQueueMessages", 5, "Count");
    expect(mockLogger.putMetric).toHaveBeenCalledWith("StuckInSent", 4, "Count");
    expect(mockLogger.setDimensions).toHaveBeenCalledWith({
      Service: "verifier",
      Target: "sandbox",
    });
  });
});
