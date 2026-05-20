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
 * If true, the entire PO is routed to BRATRA-PRODUCTS legal entity.
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
 * PP orders -> BRATRA-PRODUCTS, otherwise -> company_id mapping or fallback.
 */
export function determineLegalEntity(order: WarehouseOrder): string {
  if (PP_EANS.size > 0 && isPetProductsOrder(order)) {
    return LEGAL_ENTITY_MAP.PP;
  }
  return LEGAL_ENTITY_MAP[order.company_id] ?? "BRATRA-NONFOOD";
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

function mapOrder(o: WarehouseOrder): EnvelopeOrder {
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
      reqDeliveryDate: o.req_delivery_date,
      expDeliveryDate: o.exp_delivery_date,
      reqETD: o.req_etd,
      expETD: o.exp_etd,
      eta: o.eta,
    },
    shipping: {
      truckProposal: o.truck_proposal,
      shipId: o.ship_id,
      shipmentStatus: o.shipment_status,
      portOfDepartureCode: o.port_of_departure_code,
      portOfDeparture: o.port_of_departure,
      portOfArrivalCode: o.port_of_arrival_code,
      portOfArrival: o.port_of_arrival,
      containerType: o.container_type,
    },
    lines: o.order_lines.map(mapOrderLine),
  };
}

function mapOrderLine(l: WarehouseOrderLine): EnvelopeOrderLine {
  return {
    lineNumber: l.line_number ?? 0,
    articleNumberAction: l.action_articles.article_number,
    articleNumberSupplier: l.bratra_articles?.article_number ?? null,
    articleDescription: l.action_articles.description,
    category: l.category || "",
    logisticGroup: l.logistic_group || "",
    allocation: l.allocation,
    quantities: {
      reqQuantity: l.req_quantity,
      expQuantity: l.exp_quantity,
      palletPattern: l.pallet_pattern ? String(l.pallet_pattern) : null,
      pallets: l.pallets,
    },
    pricing: {
      unitPrice: l.price,
      currency: l.unit_price_currency || "EUR",
    },
    compliance: {
      hg: l.hazardous_goods || "",
      adr: l.adr,
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
