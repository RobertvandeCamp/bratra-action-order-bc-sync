/**
 * E2E test voor dispatcher + verifier tegen BC Sandbox.
 *
 * Gebruik:
 *   npm run test:local -- dry-run     # Bouw envelopes, log alles, stuur NIET naar SB
 *   npm run test:local -- live         # Stuur 2 orders naar SB sandbox, verifieer in BC
 *   npm run test:local -- cleanup      # Verwijder test bc_sync_orders records
 *
 * Altijd:
 *   - Valideert dat BC_ENVIRONMENT=Sandbox (hard stop als niet)
 *   - Pakt max 2 random unsynced orders
 *   - Na live test: wacht 30s, draai verifier, toon resultaat
 *   - Cleanup ruimt bc_sync_orders op zodat test herhaalbaar is
 *
 * Vereist .env.local met credentials.
 */

import * as dotenv from "dotenv";
import { randomUUID } from "node:crypto";

dotenv.config({ path: ".env.local" });

// ============================================================================
// Constants
// ============================================================================

const TEST_LIMIT = 2;
const COMPANY_ID = 2; // Non-food
const TEST_BATCH_PREFIX = "TEST-"; // Prefix voor test batch_ids

const USAGE = `
Usage: npm run test:local -- <mode>

Modes:
  dry-run   Haal 2 orders op, bouw envelope, log alles, stuur NIET naar Service Bus
  live      Stuur 2 orders naar Service Bus sandbox, wacht 30s, verifieer via BC buffer API
  cleanup   Verwijder alle test bc_sync_orders records (batch_id begint met TEST-)
  dlq       Toon huidige DLQ diepte en berichten (peek-only, verwijdert niets)

Examples:
  npm run test:local -- dry-run
  npm run test:local -- live
  npm run test:local -- cleanup
  npm run test:local -- dlq
`;

// ============================================================================
// Sandbox guard
// ============================================================================

function assertSandbox(): void {
  const env = process.env.BC_ENVIRONMENT ?? "";
  if (!env.startsWith("Sandbox")) {
    console.error("\n!!! SANDBOX GUARD: BC_ENVIRONMENT is niet sandbox !!!");
    console.error(`   BC_ENVIRONMENT = "${env}"`);
    console.error("   Deze test mag ALLEEN tegen sandbox draaien.");
    console.error("   Stop.\n");
    process.exit(1);
  }
  console.log(`BC_ENVIRONMENT: ${env} (sandbox OK)`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const mode = process.argv[2];

  if (!mode || !["dry-run", "live", "cleanup", "dlq"].includes(mode)) {
    console.log(USAGE.trim());
    process.exit(1);
  }

  // DLQ mode: geen sandbox guard nodig (leest geen BC data)
  if (mode === "dlq") {
    await dlqPeek();
    return;
  }

  assertSandbox();

  const { getSupabaseClient } = await import("../src/shared/supabase-client");
  const supabase = getSupabaseClient();

  if (mode === "cleanup") {
    await cleanup(supabase);
    return;
  }

  const dryRun = mode === "dry-run";
  console.log(`\n--- Mode: ${dryRun ? "DRY-RUN (niet versturen)" : "LIVE (naar Service Bus sandbox)"} ---\n`);

  // 1. Haal 2 random unsynced orders
  console.log(`Stap 1: ${TEST_LIMIT} unsynced orders ophalen (company_id=${COMPANY_ID})...`);
  const orders = await fetchTestOrders(supabase);

  if (orders.length === 0) {
    console.log("Geen unsynced orders gevonden. Draai eerst 'cleanup' als je eerder getest hebt.");
    return;
  }

  console.log(`   Gevonden: ${orders.length} orders`);
  for (const o of orders) {
    const lineCount = o.order_lines?.length ?? 0;
    console.log(`   - PO ${o.po_number} (order_id=${o.id}, ${lineCount} lines)`);
  }

  // 2. Bouw envelope
  console.log("\nStap 2: Envelope bouwen...");
  const { mapOrdersToEnvelope } = await import("../src/dispatcher/envelope-mapper");

  const messageId = randomUUID();
  const correlationId = `test-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const batchId = `${TEST_BATCH_PREFIX}${randomUUID().slice(0, 8)}`;

  // Determine legal entity (same logic as dispatcher)
  const legalEntity = "BRATRA-NL"; // Matches Postman collection examples

  const envelope = mapOrdersToEnvelope(orders, {
    messageId,
    correlationId,
    legalEntity,
  });

  const envelopeJson = JSON.stringify(envelope, null, 2);
  const envelopeSize = Buffer.byteLength(envelopeJson, "utf-8");

  console.log(`   messageId:     ${messageId}`);
  console.log(`   correlationId: ${correlationId}`);
  console.log(`   batchId:       ${batchId}`);
  console.log(`   legalEntity:   ${legalEntity}`);
  console.log(`   orders:        ${envelope.payload.orders.length}`);
  console.log(`   envelope size: ${(envelopeSize / 1024).toFixed(1)} KiB`);

  // 3. Toon envelope (eerste 80 regels)
  console.log("\nStap 3: Envelope preview (eerste 40 regels):");
  const lines = envelopeJson.split("\n");
  for (const line of lines.slice(0, 40)) {
    console.log(`   ${line}`);
  }
  if (lines.length > 40) console.log(`   ... (${lines.length - 40} regels meer)`);

  if (dryRun) {
    console.log("\n--- DRY-RUN COMPLEET ---");
    console.log("Geen bc_sync_orders records aangemaakt, niets verstuurd.");
    console.log("Draai 'npm run test:local -- live' om daadwerkelijk te versturen.\n");
    return;
  }

  // 4. LIVE: Maak tracking records aan
  console.log("\nStap 4: Tracking records aanmaken in bc_sync_orders...");
  const insertRecords = orders.map((order) => ({
    status: "pending",
    company_id: order.company_id,
    order_id: order.id,
    po_number: order.po_number,
    batch_id: batchId,
    message_id: messageId,
    correlation_id: correlationId,
    external_id: `BRA-AC-${messageId}-${order.po_number}`,
  }));

  const { error: insertError } = await supabase
    .from("bc_sync_orders")
    .insert(insertRecords);

  if (insertError) {
    console.error("   INSERT mislukt:", insertError.message);
    console.log("   Tip: draai 'cleanup' als er al records zijn voor deze orders.");
    return;
  }
  console.log(`   ${insertRecords.length} records aangemaakt (status: pending)`);

  // 5. LIVE: Verstuur naar Service Bus
  console.log("\nStap 5: Versturen naar Service Bus...");
  try {
    const { sendToServiceBus } = await import("../src/shared/service-bus-client");
    await sendToServiceBus(envelope);
    console.log("   Verstuurd! (HTTP 201)");

    // Update status -> sent
    await supabase
      .from("bc_sync_orders")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("batch_id", batchId);
    console.log("   Status bijgewerkt naar 'sent'");
  } catch (err) {
    console.error("   Service Bus send MISLUKT:", (err as Error).message);
    await supabase
      .from("bc_sync_orders")
      .update({
        status: "failed",
        error_message: (err as Error).message,
        failed_at: new Date().toISOString(),
      })
      .eq("batch_id", batchId);
    console.log("   Status bijgewerkt naar 'failed'");
    await showResults(supabase, batchId);
    return;
  }

  // 6. Wacht en verifieer
  console.log("\nStap 6: Wachten 30 seconden (BC verwerking)...");
  await sleep(30_000);

  console.log("\nStap 7: Verifier draaien...");
  try {
    const { authenticateM2M } = await import("../src/shared/bc-auth");
    const { checkBufferStatuses } = await import("../src/verifier/bc-buffer-checker");
    const { getConfig } = await import("../src/shared/config");
    const config = getConfig();

    const token = await authenticateM2M(config.BC_TENANT_ID);
    console.log("   M2M auth OK");

    const { data: sentOrders } = await supabase
      .from("bc_sync_orders")
      .select("*")
      .eq("batch_id", batchId)
      .eq("status", "sent");

    if (!sentOrders || sentOrders.length === 0) {
      console.log("   Geen sent orders gevonden voor verificatie.");
    } else {
      const bcConfig = {
        tenantId: config.BC_TENANT_ID,
        environment: config.BC_ENVIRONMENT,
        companyId: config.BC_COMPANY_ID,
      };

      const summary = await checkBufferStatuses(sentOrders, token, bcConfig, supabase);
      console.log("\n   Verifier resultaat:", summary);
    }
  } catch (err) {
    console.error("   Verifier fout:", (err as Error).message);
    console.log("   (Dit kan normaal zijn als BC nog aan het verwerken is)");
  }

  // 8. Toon resultaten
  await showResults(supabase, batchId);

  console.log("\n--- LIVE TEST COMPLEET ---");
  console.log(`Draai 'npm run test:local -- cleanup' om test records op te ruimen.\n`);
}

// ============================================================================
// Helpers
// ============================================================================

const ORDER_SELECT = `
  id, po_number, company_id, carrier_code, carrier,
  req_delivery_date, exp_delivery_date,
  order_type, unloading_location, truck_proposal,
  ship_id, shipment_status,
  req_etd, exp_etd, eta,
  port_of_departure_code, port_of_departure,
  port_of_arrival_code, port_of_arrival,
  container_type,
  distribution_centers (code, name, location),
  order_lines (
    id, line_number, contract_number,
    req_quantity, exp_quantity, price,
    pallet_pattern, pallets,
    category, unit_price_currency, allocation,
    hazardous_goods, adr, icpe, logistic_group,
    action_articles!inner (article_number, description),
    bratra_articles (article_number)
  )
`;

async function fetchTestOrders(supabase: ReturnType<typeof import("../src/shared/supabase-client").getSupabaseClient>) {
  // Get order_ids that already have ANY sync record
  const { data: syncedRows } = await supabase
    .from("bc_sync_orders")
    .select("order_id")
    .eq("company_id", COMPANY_ID);

  const syncedIds = new Set((syncedRows ?? []).map((r: { order_id: number }) => r.order_id));

  // Get all non-food orders
  const { data: allOrders, error } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("company_id", COMPANY_ID)
    .limit(50); // Fetch a small batch to pick from

  if (error) throw new Error(`Failed to fetch orders: ${error.message}`);

  // Filter out already synced, pick first TEST_LIMIT
  // Cast via unknown: Supabase infers distribution_centers as array but FK makes it a single object
  const unsynced = (allOrders ?? []).filter((o: { id: number }) => !syncedIds.has(o.id));
  return unsynced.slice(0, TEST_LIMIT) as unknown as import("../src/shared/types").WarehouseOrder[];
}

async function showResults(supabase: ReturnType<typeof import("../src/shared/supabase-client").getSupabaseClient>, batchId: string) {
  console.log("\n--- Test resultaten ---\n");

  const { data } = await supabase
    .from("bc_sync_orders")
    .select("po_number, status, message_id, external_id, bc_buffer_status, bc_document_no, bc_error_message, sent_at, verified_at, error_message")
    .eq("batch_id", batchId);

  if (!data || data.length === 0) {
    console.log("Geen records gevonden voor deze test batch.");
    return;
  }

  for (const row of data) {
    console.log(`PO: ${row.po_number}`);
    console.log(`   status:           ${row.status}`);
    console.log(`   external_id:      ${row.external_id}`);
    console.log(`   message_id:       ${row.message_id}`);
    console.log(`   sent_at:          ${row.sent_at ?? "-"}`);
    console.log(`   bc_buffer_status: ${row.bc_buffer_status ?? "-"}`);
    console.log(`   bc_document_no:   ${row.bc_document_no ?? "-"}`);
    console.log(`   verified_at:      ${row.verified_at ?? "-"}`);
    if (row.error_message) console.log(`   error_message:    ${row.error_message}`);
    if (row.bc_error_message) console.log(`   bc_error_message: ${row.bc_error_message}`);
    console.log();
  }
}

async function cleanup(supabase: ReturnType<typeof import("../src/shared/supabase-client").getSupabaseClient>) {
  console.log("\n--- Cleanup: test bc_sync_orders records verwijderen ---\n");

  // Delete records where batch_id starts with TEST-
  const { data: testRows } = await supabase
    .from("bc_sync_orders")
    .select("id, po_number, status, batch_id")
    .like("batch_id", `${TEST_BATCH_PREFIX}%`);

  if (!testRows || testRows.length === 0) {
    console.log("Geen test records gevonden (batch_id begint met TEST-).");
    console.log("Niets te doen.\n");
    return;
  }

  console.log(`Gevonden: ${testRows.length} test records`);
  for (const row of testRows) {
    console.log(`   - PO ${row.po_number} (status: ${row.status}, batch: ${row.batch_id})`);
  }

  const ids = testRows.map((r: { id: number }) => r.id);
  const { error } = await supabase
    .from("bc_sync_orders")
    .delete()
    .in("id", ids);

  if (error) {
    console.error(`Cleanup mislukt: ${error.message}`);
    return;
  }

  console.log(`\n${ids.length} records verwijderd. Test is herhaalbaar.\n`);
}

async function dlqPeek(): Promise<void> {
  console.log("\n--- DLQ Peek: berichten in bratra-inbound/$DeadLetterQueue ---\n");

  const { getConfig } = await import("../src/shared/config");
  const { generateSasToken } = await import("../src/shared/service-bus-client");
  const config = getConfig();
  const token = generateSasToken(config.SB_NAMESPACE, config.SB_QUEUE, config.SB_KEY_NAME, config.SB_KEY_VALUE);

  let count = 0;
  const MAX_PEEK = 20;

  for (let i = 0; i < MAX_PEEK; i++) {
    const url = `https://${config.SB_NAMESPACE}.servicebus.windows.net/${config.SB_QUEUE}/$DeadLetterQueue/messages/head?timeout=2`;
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: token },
    });

    if (response.status === 204) break;
    if (response.status !== 201) {
      console.error(`DLQ receive failed: HTTP ${response.status}`);
      const body = await response.text();
      if (body) console.error(`   ${body.slice(0, 300)}`);
      break;
    }

    count++;
    const brokerProps = JSON.parse(response.headers.get("BrokerProperties") ?? "{}");
    const reason = response.headers.get("DeadLetterReason") ?? "Unknown";
    const body = await response.text();

    console.log(`Bericht ${count}:`);
    console.log(`   MessageId:        ${brokerProps.MessageId}`);
    console.log(`   SequenceNumber:   ${brokerProps.SequenceNumber}`);
    console.log(`   DeadLetterReason: ${reason}`);
    console.log(`   EnqueuedTime:     ${brokerProps.EnqueuedTimeUtc}`);
    console.log(`   Body preview:     ${body.slice(0, 200)}`);
    console.log();

    // Bericht is nu gelocked -- geen DELETE (peek-only)
  }

  console.log(`DLQ diepte: minimaal ${count} berichten`);
  if (count === 0) console.log("DLQ is leeg.");
  console.log("\nLet op: gepeekte berichten zijn tijdelijk gelocked (~30s). Ze worden automatisch weer beschikbaar.\n");
}

function sleep(ms: number): Promise<void> {
  const seconds = Math.ceil(ms / 1000);
  process.stdout.write(`   `);
  return new Promise((resolve) => {
    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed++;
      process.stdout.write(`${elapsed}s `);
      if (elapsed >= seconds) {
        clearInterval(interval);
        process.stdout.write("\n");
        resolve();
      }
    }, 1000);
  });
}

main().catch((err) => {
  console.error("\nOnverwachte fout:", err);
  process.exit(1);
});
