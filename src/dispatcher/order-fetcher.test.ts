import { describe, it, expect, vi, beforeEach } from "vitest";

// Supabase chained-builder mock. Each from() returns a thenable builder that
// records its select columns / eq filters / range / in-ids, then resolves via a
// per-table resolver that behaves like a real paginated DB (slice by range).
const mockFrom = vi.fn();

type BuilderState = {
  table: string;
  columns: string | null;
  eqs: Array<[string, unknown]>;
  orders: string[];
  range: [number, number] | null;
  inIds: number[] | null;
};

// Every builder created during a test, for post-hoc assertions on filters.
let builders: BuilderState[] = [];

function makeBuilder(
  table: string,
  resolve: (state: BuilderState) => { data: unknown; error: unknown },
) {
  const state: BuilderState = {
    table,
    columns: null,
    eqs: [],
    orders: [],
    range: null,
    inIds: null,
  };
  builders.push(state);
  const builder = {
    select(cols: string) {
      state.columns = cols;
      return builder;
    },
    eq(col: string, val: unknown) {
      state.eqs.push([col, val]);
      return builder;
    },
    order(col: string) {
      state.orders.push(col);
      return builder;
    },
    in(_col: string, vals: number[]) {
      state.inIds = vals;
      return builder;
    },
    range(from: number, to: number) {
      state.range = [from, to];
      return builder;
    },
    then(
      onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) {
      return Promise.resolve(resolve(state)).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

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

/**
 * Wire mockFrom to behave like a paginated DB given fixture rows.
 *   bc_sync_orders.select("order_id") -> slice syncedRows by .range
 *   orders.select("id")               -> slice approvedRows by .range
 *   orders.select(<full>).in("id",..) -> fullOrders filtered by inIds
 */
function setupDb(fixtures: {
  syncedRows: Array<{ order_id: number }>;
  approvedRows: Array<{ id: number }>;
  fullOrders: Array<{ id: number; po_number: string; order_lines: unknown[] }>;
}) {
  mockFrom.mockImplementation((table: string) =>
    makeBuilder(table, (state) => {
      if (table === "bc_sync_orders") {
        const [from, to] = state.range ?? [0, fixtures.syncedRows.length - 1];
        return { data: fixtures.syncedRows.slice(from, to + 1), error: null };
      }
      if (table === "orders" && state.columns === "id") {
        const [from, to] = state.range ?? [0, fixtures.approvedRows.length - 1];
        return { data: fixtures.approvedRows.slice(from, to + 1), error: null };
      }
      if (table === "orders") {
        const ids = new Set(state.inIds ?? []);
        return {
          data: fixtures.fullOrders.filter((o) => ids.has(o.id)),
          error: null,
        };
      }
      return { data: [], error: null };
    }),
  );
}

describe("fetchUnsyncedOrders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    builders = [];
  });

  it("SYNC-01: past .eq(approval_status, approved) toe en geeft de approved unsynced order terug", async () => {
    const approvedOrder = {
      id: 10,
      po_number: "PO10",
      company_id: 2,
      business_unit: "non_food",
      approval_status: "approved",
      order_lines: [],
    };
    setupDb({
      syncedRows: [], // niets gesynct
      approvedRows: [{ id: 10 }],
      fullOrders: [approvedOrder],
    });

    const result = await fetchUnsyncedOrders(2);

    // De approval-filter is daadwerkelijk op de ids-select toegepast.
    const idsSelect = builders.find(
      (b) => b.table === "orders" && b.columns === "id",
    );
    expect(idsSelect).toBeDefined();
    expect(idsSelect?.eqs).toContainEqual(["company_id", 2]);
    expect(idsSelect?.eqs).toContainEqual(["approval_status", "approved"]);

    // De approved order komt terug.
    expect(result).toHaveLength(1);
    expect(result[0].po_number).toBe("PO10");
  });

  it("regressie (go-live 2026-06-25): >1000 synced rijen worden volledig gelezen -- geen overflow als 'nieuw'", async () => {
    // 1899 reeds-gesyncte orders (id 1..1899): id's > 1000 vallen op pagina 2.
    const syncedRows = Array.from({ length: 1899 }, (_, i) => ({
      order_id: i + 1,
    }));
    // Alle approved orders zitten AL in de synced-set -- ook id 1500 (pagina 2).
    const approvedRows = [{ id: 1 }, { id: 500 }, { id: 1500 }];
    setupDb({ syncedRows, approvedRows, fullOrders: [] });

    const result = await fetchUnsyncedOrders(1);

    // Met gebroken paginatie zou id 1500 (>1000) buiten de synced-set vallen en
    // als 'nieuw' gedispatcht worden. Met de fix is de set compleet -> leeg.
    expect(result).toEqual([]);

    // Bewijs dat paginatie echt 2 pagina's las (page1 vol -> page2).
    const syncPages = builders.filter((b) => b.table === "bc_sync_orders");
    expect(syncPages.length).toBe(2);
    expect(syncPages[0].range).toEqual([0, 999]);
    expect(syncPages[1].range).toEqual([1000, 1999]);
    // Stabiele paging-key vereist: elke gepagineerde query ordert op een unieke kolom
    // (zonder .order() kan PostgREST rijen tussen pagina's overslaan/dupliceren).
    expect(syncPages.every((b) => b.orders.includes("id"))).toBe(true);
    const idsPages = builders.filter(
      (b) => b.table === "orders" && b.columns === "id",
    );
    expect(idsPages.every((b) => b.orders.includes("id"))).toBe(true);

    // Geen full-row fetch (.in) omdat unsyncedIds leeg is.
    const fullFetch = builders.find(
      (b) => b.table === "orders" && b.inIds !== null,
    );
    expect(fullFetch).toBeUndefined();
  });

  it("anti-join laat alleen niet-gesyncte approved orders door", async () => {
    const orderA = { id: 7, po_number: "PO7", order_lines: [] };
    const orderB = { id: 8, po_number: "PO8", order_lines: [] };
    setupDb({
      syncedRows: [{ order_id: 7 }], // 7 al gesynct, 8 niet
      approvedRows: [{ id: 7 }, { id: 8 }],
      fullOrders: [orderA, orderB],
    });

    const result = await fetchUnsyncedOrders(2);

    expect(result.map((o) => o.id)).toEqual([8]);
    const fullFetch = builders.find(
      (b) => b.table === "orders" && b.inIds !== null,
    );
    expect(fullFetch?.inIds).toEqual([8]);
    // SYNC-01 boundary-guard: chunk-fetch herhaalt company_id + approval_status
    // (approval kan wijzigen tussen de ids-query en deze full-row fetch).
    expect(fullFetch?.eqs).toContainEqual(["company_id", 2]);
    expect(fullFetch?.eqs).toContainEqual(["approval_status", "approved"]);
  });
});
