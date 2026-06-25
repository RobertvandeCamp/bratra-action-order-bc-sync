import { describe, it, expect } from "vitest";
import {
  determineLegalEntity,
  groupOrdersIntoBatches,
} from "./envelope-mapper";
import type { WarehouseOrder } from "../shared/types";

/** Minimale geldige WarehouseOrder-stub; override per test via `over`. */
function makeOrder(over: Partial<WarehouseOrder>): WarehouseOrder {
  return {
    id: 1,
    po_number: "PO1",
    company_id: 2,
    business_unit: "non_food",
    approval_status: "approved",
    carrier_code: null,
    carrier: null,
    req_delivery_date: "2026-06-17",
    exp_delivery_date: null,
    order_type: null,
    unloading_location: null,
    truck_proposal: null,
    ship_id: null,
    shipment_status: null,
    req_etd: null,
    exp_etd: null,
    eta: null,
    port_of_departure_code: null,
    port_of_departure: null,
    port_of_arrival_code: null,
    port_of_arrival: null,
    container_type: null,
    distribution_centers: null,
    order_lines: [],
    ...over,
  } as WarehouseOrder;
}

describe("determineLegalEntity (SEG-03 / D-02 / D-04)", () => {
  it("routeert non_food -> BRATRA-NL", () => {
    expect(determineLegalEntity(makeOrder({ business_unit: "non_food" }))).toBe(
      "BRATRA-NL",
    );
  });

  it("routeert pet_products -> BRATRA-NL", () => {
    expect(
      determineLegalEntity(makeOrder({ business_unit: "pet_products" })),
    ).toBe("BRATRA-NL");
  });

  it("fail-fast (throw) bij business_unit=null", () => {
    expect(() =>
      determineLegalEntity(makeOrder({ business_unit: null })),
    ).toThrow();
  });

  it("fail-fast (throw) bij onbekende business_unit", () => {
    expect(() =>
      determineLegalEntity(makeOrder({ business_unit: "xxx" as never })),
    ).toThrow();
  });
});

describe("groupOrdersIntoBatches (batch-isolatie / Pitfall 1)", () => {
  it("isoleert een ongeclassificeerde order zonder de batch te kelderen", () => {
    const badOrder = makeOrder({ id: 99, po_number: "BAD", business_unit: null });
    const goodOrder = makeOrder({
      id: 1,
      po_number: "GOOD",
      business_unit: "non_food",
    });

    let result: ReturnType<typeof groupOrdersIntoBatches> | undefined;
    expect(() => {
      result = groupOrdersIntoBatches([badOrder, goodOrder]);
    }).not.toThrow();

    expect(result).toBeDefined();
    // De geldige order is gebatcht.
    const batchedIds = result!.batches.flatMap((b) => b.orders.map((o) => o.id));
    expect(batchedIds).toContain(goodOrder.id);
    expect(batchedIds).not.toContain(badOrder.id);
    // De bad order zit in skipped, met een reason.
    expect(result!.skipped).toHaveLength(1);
    expect(result!.skipped[0].order.id).toBe(badOrder.id);
    expect(result!.skipped[0].reason).toMatch(/business_unit/);
  });
});
