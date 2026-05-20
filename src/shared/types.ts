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
