import { describe, it, expect } from "vitest";
import {
  determineLegalEntity,
  groupOrdersIntoBatches,
  mapOrdersToEnvelope,
} from "./envelope-mapper";
import type { WarehouseOrder, WarehouseOrderLine } from "../shared/types";

/** Minimale geldige WarehouseOrderLine-stub; override per test via `over`. */
function makeLine(over: Partial<WarehouseOrderLine>): WarehouseOrderLine {
  return {
    id: 1,
    line_number: 10,
    contract_number: null,
    req_quantity: 1,
    exp_quantity: null,
    price: 0,
    pallet_pattern: null,
    pallets: null,
    category: null,
    unit_price_currency: null,
    allocation: null,
    hazardous_goods: null,
    adr: null,
    icpe: null,
    logistic_group: null,
    action_articles: { article_number: "A1", description: null },
    bratra_articles: null,
    ...over,
  } as WarehouseOrderLine;
}

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

describe("mapOrdersToEnvelope — contractNumber op line-niveau", () => {
  const opts = {
    messageId: "m1",
    correlationId: "c1",
    legalEntity: "BRATRA-NL",
  };

  it("zet elk regel-contractnummer op de betreffende line (behoudt verschillen)", () => {
    const order = makeOrder({
      order_lines: [
        makeLine({ id: 1, line_number: 10, contract_number: "C-100" }),
        makeLine({ id: 2, line_number: 20, contract_number: "C-200" }),
      ],
    });
    const lines = mapOrdersToEnvelope([order], opts).payload.orders[0].lines;
    expect(lines[0].contractNumber).toBe("C-100");
    expect(lines[1].contractNumber).toBe("C-200");
  });

  it("valt terug op lege string bij ontbrekend contractnummer", () => {
    const order = makeOrder({
      order_lines: [makeLine({ contract_number: null })],
    });
    const env = mapOrdersToEnvelope([order], opts);
    expect(env.payload.orders[0].lines[0].contractNumber).toBe("");
  });

  it("stuurt GEEN contractNumber meer op header/order-niveau", () => {
    const order = makeOrder({
      order_lines: [makeLine({ contract_number: "C-1" })],
    });
    const env = mapOrdersToEnvelope([order], opts);
    expect(env.payload.orders[0]).not.toHaveProperty("contractNumber");
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
