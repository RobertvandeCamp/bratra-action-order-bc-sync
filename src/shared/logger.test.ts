import { describe, expect, it } from "vitest";
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
