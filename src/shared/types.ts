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
    palletPattern: number | null;
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
// TIJDELIJK alles op BRATRA-NL: de enige door ERP Company bevestigd werkende
// waarde (Postman-collectie, guide, happy-test 2026-06-11). De waarden per
// Bratra-bedrijf (non-food/PP/food) zijn op 20 mei gevraagd maar nog niet
// bevestigd — zie open punt 3 in docs/test-overzicht-bc-sync.md.
export const LEGAL_ENTITY_MAP: Record<number | string, string> = {
  2: "BRATRA-NL",
  PP: "BRATRA-NL",
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
  /** Custom API route override. Default: "api/v2.0" (standard BC API).
   *  For ERP Company custom pages: "api/erpcompany/integration/v1.0" */
  apiRoute?: string;
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

// ============================================================================
// BC Buffer types (bratraSalesOrderBuffers API response)
// ============================================================================

/**
 * Mogelijke statuses van een bratraSalesOrderBuffers record in BC.
 * Bron: bratra-integration-architecture.pdf section 6.1, table 50100.
 */
export type BcBufferStatus =
  | "Pending"
  | "Processing"
  | "Done"
  | "Error"
  | "Fatal"
  | "Cancelled";

/**
 * Eén record uit de BC bratraSalesOrderBuffers API page.
 *
 * BC OData v2.0 API retourneert camelCase property namen.
 *
 * NOTE: Exacte OData property namen (met name salesDocumentNo) moeten
 * geverifieerd worden bij de eerste test-local run (Assumption A2 uit
 * RESEARCH.md). Als de werkelijke response afwijkt, pas dit interface aan.
 */
export interface BcBufferRecord {
  /** BC system UUID */
  systemId: string;
  /** Ons formaat: BRA-AC-{messageId}-{poNumber} */
  externalId: string;
  /** Verwerkingsstatus in BC */
  status: BcBufferStatus;
  /** Sales Order nummer, gevuld bij status Done */
  salesDocumentNo: string;
  /** Error details bij status Error/Fatal */
  errorMessage: string;
  /** BC entry nummer */
  entryNo: number;
}

// ============================================================================
// DLQ types (Phase 152.1)
// ============================================================================

/** Summary van DLQ verwerking per verifier run */
export interface DlqSummary {
  /** Aantal berichten verwerkt en uit queue verwijderd */
  processed: number;
  /** Aantal berichten gematcht aan bc_sync_orders */
  matched: number;
  /** Aantal berichten zonder match maar wel opgeslagen */
  unmatched: number;
  /** Aantal berichten al eerder verwerkt (idempotent) */
  skipped: number;
  /** Aantal verwerkingsfouten */
  errors: number;
}

/** Service Bus BrokerProperties header uit DLQ bericht */
export interface DlqBrokerProperties {
  MessageId: string;
  SequenceNumber: number;
  LockToken: string;
  DeliveryCount: number;
  EnqueuedTimeUtc: string;
  EnqueuedSequenceNumber: number;
  Label?: string;
  CorrelationId?: string;
}

/** Enkel DLQ bericht zoals ontvangen van Service Bus REST API */
export interface DlqMessage {
  brokerProperties: DlqBrokerProperties;
  deadLetterReason: string;
  deadLetterErrorDescription: string;
  /** Raw envelope JSON body */
  body: string;
  lockToken: string;
  /** Location header voor DELETE URL (complete bericht) */
  locationUrl: string | null;
}

// ============================================================================
// SQS Trigger types (Phase 152.2)
// ============================================================================

/**
 * SQS message body sent by bratra-action-orders-importer after successful import.
 * Triggers the dispatcher to process unsynced orders for the specified company.
 */
export interface SqsTriggerMessage {
  /** Company ID to dispatch orders for */
  companyId: number;
  /** ISO timestamp of when the import completed (optional, for logging) */
  timestamp?: string;
}

// ============================================================================
// Error queue types (Leo, 15-06-2026) -- bratra-error
// ============================================================================

/**
 * Foutsectie die ERP Company aan het bericht toevoegt voordat het naar de
 * `bratra-error` queue gaat. Contract afgeleid uit Leo's voorbeeldbericht
 * (docs/BC sync error queue.md). Verifieer tegen echte berichten.
 */
export interface ErrorQueueErrorSection {
  /** Waar het misging, bv. "BcBufferWrite" of "FunctionError" */
  stage: string;
  /** BC HTTP-status (bv. 400, 422, 5xx) */
  httpStatus?: number;
  /** Foutmelding van Business Central */
  message: string;
  /** Aantal pogingen voor het naar de error queue ging */
  attempts?: number;
  /** true = transient, veilig te replayen; false = permanente data/validatiefout */
  retryable: boolean;
  /** ISO-timestamp van de definitieve fout */
  failedAtUtc?: string;
  /** Correlatie-ID voor App Insights-tracing */
  correlationId?: string;
}

/**
 * Berichtstructuur op de `bratra-error` queue: oorspronkelijke meta + de
 * afgekeurde order + de toegevoegde error-sectie. Let op: anders dan de DLQ
 * zit de foutinformatie in de BODY, niet in response-headers. Eén order per
 * bericht (`order`, niet `payload.orders[]`).
 */
export interface ErrorQueueMessage {
  meta: ActionOrderBatchV1Envelope["meta"];
  order: EnvelopeOrder;
  error: ErrorQueueErrorSection;
}
