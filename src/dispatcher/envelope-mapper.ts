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
import ppArticles from "../config/pp-articles.json";

// PP EAN set loaded once at module init
const PP_EANS = new Set<string>(ppArticles as string[]);

// ============================================================================
// PP Article Detection & Legal Entity Routing
// ============================================================================

/**
 * Check if any order line has a bratra_articles.article_number in the PP EAN set.
 * If true, the entire PO is routed to the Pet Products legal entity (LEGAL_ENTITY_MAP.PP).
 */
function isPetProductsOrder(order: WarehouseOrder): boolean {
  return order.order_lines.some(
    (line) =>
      line.bratra_articles?.article_number != null &&
      PP_EANS.has(line.bratra_articles.article_number),
  );
}

/**
 * Determine the legal entity for an order based on PP detection and company_id.
 * NB: alle map-waarden staan tijdelijk op BRATRA-NL totdat ERP Company de
 * waarden per Bratra-bedrijf bevestigt (zie LEGAL_ENTITY_MAP in types.ts).
 * De PP-detectie blijft actief zodat de routing direct werkt zodra de
 * echte waarden bekend zijn.
 */
export function determineLegalEntity(order: WarehouseOrder): string {
  if (PP_EANS.size > 0 && isPetProductsOrder(order)) {
    return LEGAL_ENTITY_MAP.PP;
  }
  return LEGAL_ENTITY_MAP[order.company_id] ?? "BRATRA-NL";
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
    contractNumber: o.order_lines[0]?.contract_number || "",
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

/**
 * Group orders by legal entity and split into sub-batches of max MAX_ORDERS_PER_BATCH.
 */
export function groupOrdersIntoBatches(
  orders: WarehouseOrder[],
): BatchGroup[] {
  // Group by legalEntity
  const groups = new Map<string, WarehouseOrder[]>();

  for (const order of orders) {
    const entity = determineLegalEntity(order);
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

  return batches;
}
