import type {
  ActionOrderBatchV1Envelope,
  EnvelopeOrder,
  EnvelopeOrderLine,
  WarehouseOrder,
  WarehouseOrderLine,
} from "../shared/types";
import {
  LEGAL_ENTITY_MAP,
  MAX_ORDERS_PER_BATCH,
  MAX_ENVELOPE_BYTES,
} from "../shared/types";

// ============================================================================
// Legal Entity Routing (SEG-03)
// ============================================================================

/**
 * Determine the legal entity for an order via data-driven routing on
 * orders.business_unit (D-02). Fail-fast (throw) bij null/onbekende
 * business_unit (D-04) -- geen stille fallback, zodat ongeclassificeerde
 * orders direct opvallen i.p.v. naar de verkeerde entity gerouteerd te worden.
 *
 * NB: alle LEGAL_ENTITY_MAP-waarden staan tijdelijk op BRATRA-NL totdat ERP
 * Company de waarden per Bratra-bedrijf bevestigt (zie types.ts).
 */
export function determineLegalEntity(order: WarehouseOrder): string {
  const entity =
    order.business_unit != null
      ? LEGAL_ENTITY_MAP[order.business_unit]
      : undefined;
  if (entity == null) {
    throw new Error(
      `Cannot route order ${order.id} (PO ${order.po_number}): ` +
        `business_unit=${order.business_unit ?? "null"} not in LEGAL_ENTITY_MAP`,
    );
  }
  return entity;
}

// ============================================================================
// Envelope Mapper
// ============================================================================

interface MapOptions {
  messageId: string;
  correlationId: string;
  legalEntity: string;
}

/**
 * Map warehouse orders to an ActionOrderBatchV1 envelope for Service Bus.
 */
export function mapOrdersToEnvelope(
  orders: WarehouseOrder[],
  options: MapOptions,
): ActionOrderBatchV1Envelope {
  return {
    meta: {
      messageId: options.messageId,
      correlationId: options.correlationId,
      name: "ActionOrderBatchV1",
      version: "1",
      source: "BratraIntegrationPlatform",
      legalEntity: options.legalEntity,
      occurredOnUtc: new Date().toISOString(),
    },
    payload: {
      orders: orders.map(mapOrder),
    },
  };
}

// Sensible defaults aligned with Postman happy path examples from ERP Company.
// ERP Company schema rejects null for numeric fields -- use 0 as default.
// String fields use "" instead of null where Postman examples show empty strings.

function mapOrder(o: WarehouseOrder): EnvelopeOrder {
  // BC Buffer Processor rejects: null expDeliveryDate, empty truckProposal,
  // past delivery dates. Apply sensible defaults.
  const reqDate = o.req_delivery_date ?? new Date().toISOString().slice(0, 10);

  return {
    poNumber: o.po_number,
    orderType: o.order_type || "Regular order",
    carrier: {
      code: o.carrier_code || "",
      name: o.carrier || "",
    },
    distributionCenter: {
      code: o.distribution_centers?.code || "",
      name: o.distribution_centers?.name || "",
      unloadingLocation: o.unloading_location || "",
    },
    dates: {
      reqDeliveryDate: reqDate,
      expDeliveryDate: o.exp_delivery_date ?? reqDate, // fallback to reqDeliveryDate
      reqETD: o.req_etd ?? null,
      expETD: o.exp_etd ?? null,
      eta: o.eta ?? null,
    },
    shipping: {
      truckProposal: o.truck_proposal || "0", // BC rejects empty string
      shipId: o.ship_id ?? "",
      shipmentStatus: o.shipment_status ?? "",
      portOfDepartureCode: o.port_of_departure_code ?? null,
      portOfDeparture: o.port_of_departure ?? null,
      portOfArrivalCode: o.port_of_arrival_code ?? null,
      portOfArrival: o.port_of_arrival ?? null,
      containerType: o.container_type ?? null,
    },
    lines: o.order_lines.map((line, idx) => mapOrderLine(line, idx)),
  };
}

function mapOrderLine(
  l: WarehouseOrderLine,
  index: number,
): EnvelopeOrderLine {
  return {
    // BC rejects lineNumber=0. Generate 10, 20, 30... if not set in DB.
    lineNumber: l.line_number ?? (index + 1) * 10,
    // Contractnummer staat per order-regel in de bron en hoort op line-niveau in
    // de envelope (ERP Company's buffer verwacht het hier, niet op de header).
    contractNumber: l.contract_number || "",
    articleNumberAction: l.action_articles.article_number ?? "",
    articleNumberSupplier: l.bratra_articles?.article_number ?? "",
    articleDescription: l.action_articles.description ?? "",
    category: l.category || "",
    logisticGroup: l.logistic_group || "",
    allocation: l.allocation ?? null,
    quantities: {
      reqQuantity: l.req_quantity ?? 0,
      expQuantity: l.exp_quantity ?? 0,
      palletPattern: l.pallet_pattern ?? 0,
      pallets: l.pallets ?? 0,
    },
    pricing: {
      unitPrice: l.price ?? 0,
      currency: l.unit_price_currency || "EUR",
    },
    compliance: {
      hg: l.hazardous_goods || "",
      adr: l.adr ?? null,
      icpe: l.icpe ? Number(l.icpe) : null,
    },
  };
}

// ============================================================================
// Envelope Size Check
// ============================================================================

/**
 * Check if envelope JSON fits within the 200 KiB safety limit for Service Bus.
 */
export function checkEnvelopeSize(
  envelope: ActionOrderBatchV1Envelope,
): boolean {
  const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf-8");
  return bytes <= MAX_ENVELOPE_BYTES;
}

// ============================================================================
// Batch Grouping
// ============================================================================

interface BatchGroup {
  orders: WarehouseOrder[];
  legalEntity: string;
}

/** Een order die niet gerouteerd kon worden (fail-fast) en wordt overgeslagen. */
export interface SkippedOrder {
  order: WarehouseOrder;
  reason: string;
}

/**
 * Group orders by legal entity and split into sub-batches of max MAX_ORDERS_PER_BATCH.
 *
 * Fail-fast isolatie (D-04, RESEARCH Pitfall 1): determineLegalEntity throwt bij
 * een ongeclassificeerde order. Die throw wordt PER ORDER opgevangen zodat één
 * slechte order de batch (en daarmee de hele Lambda-invocatie) niet keldert --
 * deze functie wordt namelijk BUITEN de per-batch try/catch in de handler
 * aangeroepen. Overgeslagen orders komen in `skipped`; de handler markeert die
 * als `failed` in bc_sync_orders.
 */
export function groupOrdersIntoBatches(
  orders: WarehouseOrder[],
): { batches: BatchGroup[]; skipped: SkippedOrder[] } {
  // Group by legalEntity
  const groups = new Map<string, WarehouseOrder[]>();
  const skipped: SkippedOrder[] = [];

  for (const order of orders) {
    let entity: string;
    try {
      entity = determineLegalEntity(order);
    } catch (err) {
      skipped.push({ order, reason: (err as Error).message });
      continue;
    }
    const existing = groups.get(entity);
    if (existing) {
      existing.push(order);
    } else {
      groups.set(entity, [order]);
    }
  }

  // Split each group into sub-batches
  const batches: BatchGroup[] = [];

  for (const [legalEntity, groupOrders] of groups) {
    for (let i = 0; i < groupOrders.length; i += MAX_ORDERS_PER_BATCH) {
      batches.push({
        orders: groupOrders.slice(i, i + MAX_ORDERS_PER_BATCH),
        legalEntity,
      });
    }
  }

  return { batches, skipped };
}
