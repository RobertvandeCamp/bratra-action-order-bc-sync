// ============================================================================
// ActionOrderBatchV1 Envelope (Service Bus message format)
// ============================================================================

export interface ActionOrderBatchV1Envelope {
  meta: {
    messageId: string;
    correlationId: string;
    name: string;
    version: string;
    source: string;
    legalEntity: string;
    occurredOnUtc: string;
  };
  payload: {
    orders: EnvelopeOrder[];
  };
}

export interface EnvelopeOrder {
  poNumber: string;
  orderType: string;
  contractNumber: string;
  carrier: { code: string; name: string };
  distributionCenter: { code: string; name: string; unloadingLocation: string };
  dates: {
    reqDeliveryDate: string | null;
    expDeliveryDate: string | null;
    reqETD: string | null;
    expETD: string | null;
    eta: string | null;
  };
  shipping: {
    truckProposal: string | null;
    shipId: string | null;
    shipmentStatus: string | null;
    portOfDepartureCode: string | null;
    portOfDeparture: string | null;
    portOfArrivalCode: string | null;
    portOfArrival: string | null;
    containerType: string | null;
  };
  lines: EnvelopeOrderLine[];
}

export interface EnvelopeOrderLine {
  lineNumber: number;
  articleNumberAction: string | null;
  articleNumberSupplier: string | null;
  articleDescription: string | null;
  category: string;
  logisticGroup: string;
  allocation: string | null;
  quantities: {
    reqQuantity: number | null;
    expQuantity: number | null;
    palletPattern: string | null;
    pallets: number | null;
  };
  pricing: {
    unitPrice: number | null;
    currency: string;
  };
  compliance: {
    hg: string;
    adr: string | null;
    icpe: number | null;
  };
}

// ============================================================================
// Sync status type
// ============================================================================

export type SyncStatus =
  | "pending"
  | "sent"
  | "verified"
  | "failed"
  | "dead_letter"
  | "skipped";

// ============================================================================
// bc_sync_orders database types (copied from bratra-data-warehouse)
// ============================================================================

export interface BcSyncOrderRow {
  batch_id: string | null;
  bc_buffer_status: string | null;
  bc_document_no: string | null;
  bc_entry_no: number | null;
  bc_error_message: string | null;
  bc_system_id: string | null;
  company_id: number;
  correlation_id: string | null;
  created_at: string;
  error_message: string | null;
  external_id: string | null;
  failed_at: string | null;
  id: number;
  max_retries: number;
  message_id: string | null;
  order_id: number;
  po_number: string;
  queued_at: string;
  retry_count: number;
  sent_at: string | null;
  status: string;
  updated_at: string;
  verified_at: string | null;
}

export interface BcSyncOrderInsert {
  batch_id?: string | null;
  bc_buffer_status?: string | null;
  bc_document_no?: string | null;
  bc_entry_no?: number | null;
  bc_error_message?: string | null;
  bc_system_id?: string | null;
  company_id: number;
  correlation_id?: string | null;
  created_at?: string;
  error_message?: string | null;
  external_id?: string | null;
  failed_at?: string | null;
  id?: number;
  max_retries?: number;
  message_id?: string | null;
  order_id: number;
  po_number: string;
  queued_at?: string;
  retry_count?: number;
  sent_at?: string | null;
  status?: string;
  updated_at?: string;
  verified_at?: string | null;
}

export interface BcSyncOrderUpdate {
  batch_id?: string | null;
  bc_buffer_status?: string | null;
  bc_document_no?: string | null;
  bc_entry_no?: number | null;
  bc_error_message?: string | null;
  bc_system_id?: string | null;
  company_id?: number;
  correlation_id?: string | null;
  created_at?: string;
  error_message?: string | null;
  external_id?: string | null;
  failed_at?: string | null;
  id?: number;
  max_retries?: number;
  message_id?: string | null;
  order_id?: number;
  po_number?: string;
  queued_at?: string;
  retry_count?: number;
  sent_at?: string | null;
  status?: string;
  updated_at?: string;
  verified_at?: string | null;
}

// ============================================================================
// Warehouse Order types (Supabase nested select result)
// ============================================================================

/** Order with nested relations as returned by Supabase nested select */
export interface WarehouseOrder {
  id: number;
  po_number: string;
  company_id: number;
  carrier_code: string | null;
  carrier: string | null;
  req_delivery_date: string;
  exp_delivery_date: string | null;
  order_type: string | null;
  unloading_location: string | null;
  truck_proposal: string | null;
  ship_id: string | null;
  shipment_status: string | null;
  req_etd: string | null;
  exp_etd: string | null;
  eta: string | null;
  port_of_departure_code: string | null;
  port_of_departure: string | null;
  port_of_arrival_code: string | null;
  port_of_arrival: string | null;
  container_type: string | null;
  // Nested relations from Supabase select
  distribution_centers: {
    code: string | null;
    name: string;
    location: string | null;
  } | null;
  order_lines: WarehouseOrderLine[];
}

export interface WarehouseOrderLine {
  id: number;
  line_number: number | null;
  contract_number: string | null;
  req_quantity: number;
  exp_quantity: number | null;
  price: number;
  pallet_pattern: number | null;
  pallets: number | null;
  category: string | null;
  unit_price_currency: string | null;
  allocation: string | null;
  hazardous_goods: string | null;
  adr: string | null;
  icpe: string | null;
  logistic_group: string | null;
  // Nested relations
  action_articles: {
    article_number: string;
    description: string | null;
  };
  bratra_articles: {
    article_number: string;
  } | null;
}

// ============================================================================
// Legal Entity mapping & batch constants
// ============================================================================

/**
 * Company ID to BC legal entity mapping.
 * Exacte strings nog niet bevestigd door Wesley. Update na bevestiging.
 */
export const LEGAL_ENTITY_MAP: Record<number | string, string> = {
  2: "BRATRA-NONFOOD",
  PP: "BRATRA-PRODUCTS",
};

/** Maximum orders per Service Bus batch message */
export const MAX_ORDERS_PER_BATCH = 10;

/** Maximum envelope size in bytes (200 KiB safety margin for 256 KiB SB limit) */
export const MAX_ENVELOPE_BYTES = 200 * 1024;

// ============================================================================
// BC API types (adapted from bratra-bc-mcp-server)
// ============================================================================

export interface BCListResponse<T> {
  value: T[];
  "@odata.context"?: string;
  "@odata.nextLink"?: string;
  "@odata.count"?: number;
}

export interface BcGetOptions {
  paginate?: boolean;
  maxPages?: number;
}

/**
 * BC data config for API calls.
 *
 * Uses companyId (UUID direct) instead of companyName like the MCP server.
 * No credentials -- authenticateM2M reads those from process.env.
 */
export interface BCConfig {
  tenantId: string;
  environment: string;
  companyId: string;
}
