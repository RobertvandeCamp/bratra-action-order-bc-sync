import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger, createRunLogger } from "./logger";

describe("logger module", () => {
  it("base logger is defined and has log methods", () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("createRunLogger returns a defined child-logger with log methods", () => {
    const runLogger = createRunLogger({
      traceId: "t1",
      requestId: "r1",
      trigger: "sqs",
      companyId: 2,
    });
    expect(runLogger).toBeDefined();
    expect(typeof runLogger.info).toBe("function");
    expect(typeof runLogger.warn).toBe("function");
    expect(typeof runLogger.error).toBe("function");
  });

  it("createRunLogger without companyId returns a defined child-logger", () => {
    const runLogger = createRunLogger({
      traceId: "trace-abc",
      requestId: "req-xyz",
      trigger: "scheduled",
    });
    expect(runLogger).toBeDefined();
    expect(typeof runLogger.info).toBe("function");
  });

  it("createRunLogger with trigger=manual returns a defined child-logger", () => {
    const runLogger = createRunLogger({
      traceId: "trace-manual",
      requestId: "req-manual",
      trigger: "manual",
      companyId: 1,
    });
    expect(runLogger).toBeDefined();
    expect(typeof runLogger.info).toBe("function");
  });
});

// ============================================================================
// Round 2 F3: LOG_LEVEL wordt in logger.ts raw uit process.env gelezen (bewust
// NIET via getConfig() -- de logger moet ook bestaan als config-validatie
// faalt). Een ongeldige waarde mag pino dan niet bij module-import laten
// crashen: fallback naar "info". De logger is een module-scope singleton, dus
// elke case importeert vers via vi.resetModules() + dynamic import.
// ============================================================================

describe("LOG_LEVEL validatie (round 2 F3)", () => {
  let originalLogLevel: string | undefined;

  beforeEach(() => {
    originalLogLevel = process.env.LOG_LEVEL;
  });

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
    vi.resetModules();
  });

  async function importFreshLogger() {
    vi.resetModules();
    return import("./logger");
  }

  it("ongeldige LOG_LEVEL valt terug op 'info' (geen crash bij module-import)", async () => {
    process.env.LOG_LEVEL = "verbose"; // geen pino-level
    const { logger: freshLogger } = await importFreshLogger();
    expect(freshLogger.level).toBe("info");
  });

  it("geldige LOG_LEVEL wordt overgenomen", async () => {
    process.env.LOG_LEVEL = "debug";
    const { logger: freshLogger } = await importFreshLogger();
    expect(freshLogger.level).toBe("debug");
  });

  it("ongezette LOG_LEVEL default naar 'info'", async () => {
    delete process.env.LOG_LEVEL;
    const { logger: freshLogger } = await importFreshLogger();
    expect(freshLogger.level).toBe("info");
  });
});
