import { describe, expect, it } from "vitest";

import type { BcSyncEventInsert, BcSyncOrderRow } from "../shared/types";
import { buildBufferEvent } from "./bc-buffer-checker";

// ============================================================================
// buildBufferEvent -- pure mapping van een in-scope bc_sync_orders-rij naar een
// BcSyncEventInsert. De 6 buffer-checker-sites roepen deze builder aan; we testen
// hier de event_type<->status-mapping (D-08) + de detail-policy (D-03/D-04)
// deterministisch, met expliciete asserties op de dead_letter-status (Pitfall 2).
// ============================================================================

function makeOrder(overrides: Partial<BcSyncOrderRow> = {}): BcSyncOrderRow {
  return {
    id: 42,
    order_id: 1001,
    company_id: 2,
    po_number: "PO-555",
    retry_count: 1,
    message_id: "msg-abc",
    correlation_id: "corr-xyz",
    batch_id: "batch-1",
    // overige NOT NULL kolommen op BcSyncOrderRow (niet relevant voor het event)
    bc_buffer_status: null,
    bc_document_no: null,
    bc_entry_no: null,
    bc_error_message: null,
    bc_system_id: null,
    created_at: "2026-06-24T00:00:00Z",
    error_message: null,
    external_id: "BRA-AC-msg-abc-PO-555",
    failed_at: null,
    max_retries: 3,
    queued_at: "2026-06-24T00:00:00Z",
    sent_at: "2026-06-24T00:00:00Z",
    status: "sent",
    updated_at: "2026-06-24T00:00:00Z",
    verified_at: null,
    ...overrides,
  };
}

describe("buildBufferEvent", () => {
  it("kopieert de identiteit-velden uit de order-rij en zet from_status sent (D-07)", () => {
    const event = buildBufferEvent(makeOrder(), "verified", "verified", {
      po_number: "PO-555",
    });
    expect(event.sync_order_id).toBe(42);
    expect(event.order_id).toBe(1001);
    expect(event.company_id).toBe(2);
    expect(event.retry_count).toBe(1);
    expect(event.message_id).toBe("msg-abc");
    expect(event.correlation_id).toBe("corr-xyz");
    expect(event.batch_id).toBe("batch-1");
    expect(event.from_status).toBe("sent");
  });

  // event_type -> verwachte to_status mapping (D-08), per buffer-checker-site.
  const cases: Array<{
    site: string;
    event_type: BcSyncEventInsert["event_type"];
    to_status: BcSyncEventInsert["to_status"];
    detail: Record<string, unknown>;
  }> = [
    {
      site: "geen external_id",
      event_type: "dead_lettered",
      to_status: "dead_letter",
      detail: { po_number: "PO-555", reason: "Missing external_id" },
    },
    {
      site: "NotFound > 1u",
      event_type: "dead_lettered",
      to_status: "dead_letter",
      detail: { po_number: "PO-555", bc_buffer_status: "NotFound", age_min: 75 },
    },
    {
      site: "Done -> verified",
      event_type: "verified",
      to_status: "verified",
      detail: { po_number: "PO-555", bc_buffer_status: "Done" },
    },
    {
      site: "Error/Fatal & retry over -> buffer_error",
      event_type: "buffer_error",
      to_status: "failed",
      detail: { po_number: "PO-555", error_message: "BC kapot", bc_buffer_status: "Error" },
    },
    {
      site: "retry uitgeput -> dead_lettered",
      event_type: "dead_lettered",
      to_status: "dead_letter",
      detail: { po_number: "PO-555", bc_buffer_status: "Fatal", error_message: "BC kapot" },
    },
    {
      site: "Cancelled -> dead_lettered",
      event_type: "dead_lettered",
      to_status: "dead_letter",
      detail: { po_number: "PO-555", bc_buffer_status: "Cancelled" },
    },
  ];

  it.each(cases)(
    "mapt site '$site' naar event_type=$event_type / to_status=$to_status",
    ({ event_type, to_status, detail }) => {
      const event = buildBufferEvent(makeOrder(), event_type, to_status, detail);
      expect(event.event_type).toBe(event_type);
      expect(event.to_status).toBe(to_status);
      expect((event.detail as Record<string, unknown>).po_number).toBe("PO-555");
    },
  );

  it("schrijft event_type 'dead_lettered' ALTIJD met to_status 'dead_letter' (Pitfall 2)", () => {
    const deadLetterCases = cases.filter((c) => c.event_type === "dead_lettered");
    expect(deadLetterCases.length).toBeGreaterThanOrEqual(1);
    for (const c of deadLetterCases) {
      const event = buildBufferEvent(makeOrder(), c.event_type, c.to_status, c.detail);
      expect(event.event_type).toBe("dead_lettered");
      expect(event.to_status).toBe("dead_letter");
      // NOOIT de event_type als status
      expect(event.to_status).not.toBe("dead_lettered");
    }
  });
});
