import { describe, expect, it, vi, afterEach } from "vitest";
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
