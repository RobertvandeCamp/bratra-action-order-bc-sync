import { describe, it, expect, vi, beforeEach } from "vitest";

// Supabase chained-builder mock (patroon uit bratra-gvt-matcher/tests/supabase-client.test.ts).
const mockFrom = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: mockFrom,
  })),
}));

// Config mocken zodat de singleton-client niet op echte env vars valt.
vi.mock("../shared/config", () => ({
  getConfig: () => ({
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
  }),
}));

import { fetchUnsyncedOrders } from "./order-fetcher";

describe("fetchUnsyncedOrders (SYNC-01 approval-filter)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("past .eq(approval_status, approved) toe op de orders-select", async () => {
    const approvedOrder = {
      id: 10,
      po_number: "PO10",
      company_id: 2,
      business_unit: "non_food",
      approval_status: "approved",
      order_lines: [],
    };

    // fetchUnsyncedOrders roept from() twee keer aan:
    //  step-1: bc_sync_orders.select -> eq -> in  => {data: []}  (geen reeds-gesyncte ids)
    //  step-2: orders.select -> eq(company_id) -> eq(approval_status) => {data: [approvedOrder]}
    // Met lege step-1 wordt geen .not gechaind, dus step-2 await op de tweede .eq.
    const step2Eq = vi.fn(); // tweede .eq (approval_status) -- terminal, awaited
    const step2FirstEq = vi.fn(); // eerste .eq (company_id)
    const ordersEq = step2Eq;

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      callCount++;
      if (callCount === 1) {
        // step-1: bc_sync_orders.select -> eq -> in
        const inFn = vi.fn().mockResolvedValue({ data: [], error: null });
        const eqFn = vi.fn().mockReturnValue({ in: inFn });
        const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
        expect(table).toBe("bc_sync_orders");
        return { select: selectFn };
      }
      // step-2: orders.select -> eq(company_id) -> eq(approval_status)
      ordersEq.mockResolvedValue({ data: [approvedOrder], error: null });
      step2FirstEq.mockReturnValue({ eq: ordersEq });
      const selectFn = vi.fn().mockReturnValue({ eq: step2FirstEq });
      return { select: selectFn };
    });

    const result = await fetchUnsyncedOrders(2);

    // De approval-filter is daadwerkelijk op de query toegepast.
    expect(step2FirstEq).toHaveBeenCalledWith("company_id", 2);
    expect(ordersEq).toHaveBeenCalledWith("approval_status", "approved");

    // De approved order komt terug.
    expect(result).toHaveLength(1);
    expect(result[0].po_number).toBe("PO10");
  });
});
