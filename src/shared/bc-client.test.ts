import { describe, expect, it, vi, afterEach } from "vitest";
import type { Logger } from "pino";
import { bcGet } from "./bc-client";
import type { BCConfig } from "./types";

const testConfig: BCConfig = {
  tenantId: "tenant-id",
  environment: "sandbox",
  companyId: "company-uuid",
};

const testToken = "test-bearer-token";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bcGet fetch timeout", () => {
  it("rejects with AbortError/TimeoutError when fetch is aborted", async () => {
    // Stub global fetch to simulate a timeout abort (DOMException AbortError)
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((_, reject) =>
          setTimeout(
            () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            50,
          ),
        ),
    );

    await expect(bcGet(testToken, testConfig, "salesOrders")).rejects.toThrow(
      /aborted|timeout/i,
    );
  });

  it("resolves successfully when fetch returns 200", async () => {
    const mockData = { value: [{ id: "1" }] };
    vi.stubGlobal(
      "fetch",
      () =>
        Promise.resolve(
          new Response(JSON.stringify(mockData), { status: 200 }),
        ),
    );

    const result = await bcGet(testToken, testConfig, "salesOrders", {
      paginate: false,
    });
    expect(result.value).toHaveLength(1);
  });
});

// ============================================================================
// WR-03: de logger-parameter is geen dead code meer — 429-backoff (debug) en
// de 30s-timeout-abort (warn) zijn observeerbaar in de run-context.
// ============================================================================

describe("bcGet retry/timeout observability (WR-03)", () => {
  it("logt 429-backoff op debug met attempt + delayMs", async () => {
    vi.useFakeTimers();
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call++;
      if (call === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return new Response(JSON.stringify({ value: [{ id: "1" }] }), { status: 200 });
    });
    const debug = vi.fn();
    const spyLogger = { debug, warn: vi.fn() } as unknown as Logger;

    const promise = bcGet(testToken, testConfig, "salesOrders", { paginate: false }, spyLogger);
    await vi.advanceTimersByTimeAsync(1000); // baseDelay attempt 0
    const result = await promise;

    expect(result.value).toHaveLength(1);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0][0]).toMatchObject({ attempt: 0, delayMs: 1000 });
    expect(debug.mock.calls[0][1]).toMatch(/429/);
  });

  it("logt een fetch-timeout op warn vóór de rethrow", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.reject(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      ),
    );
    const warn = vi.fn();
    const spyLogger = { warn, debug: vi.fn() } as unknown as Logger;

    await expect(
      bcGet(testToken, testConfig, "salesOrders", { paginate: false }, spyLogger),
    ).rejects.toThrow(/timeout/i);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ timeoutMs: 30_000 });
    expect(warn.mock.calls[0][1]).toMatch(/timed out/);
  });
});
