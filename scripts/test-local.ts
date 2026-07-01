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

import { getConfig } from "../src/shared/config";

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
  status    Toon waar we staan: tellingen per sync-status, laatste verzending,
            DLQ-archief, en een live check op de BC buffer-API (leesrechten)
  happy     Stuur de canonieke happy-path order (verbatim payload uit Leo's
            Postman-collectie) met een VERS PO-nummer naar de Service Bus.
            Optioneel: eigen PO-nummer (arg 1) en legalEntity (arg 2), voor
            duplicaat- en routing-experimenten (open punt 2/3).
  dry-run   Haal 2 orders op, bouw envelope, log alles, stuur NIET naar Service Bus
  live      Stuur 2 orders naar Service Bus sandbox, wacht 30s, verifieer via BC buffer API
  cleanup   Verwijder alle test bc_sync_orders records (batch_id begint met TEST-)
  dlq       Toon huidige DLQ diepte en berichten (peek-only, verwijdert niets)
  error-queue  Peek de bratra-error queue: BC-afgekeurde orders + foutsectie
            (stage/httpStatus/retryable/message). Read-only, verwijdert niets.
  error-queue-process  Draai checkErrorQueue tegen de sandbox-queue: archiveert in
            bc_sync_error_messages, zet gematchte orders op bc_rejected en print de
            geschreven rijen + summary. WAARSCHUWING: consumeert/verwijdert berichten
            (anders dan de read-only error-queue peek).
  events    Dump de laatste bc_sync_events-rijen uit de sandbox (read-only):
            per rij event_type, from->to-status, order_id en detail. Bewijst dat de
            door dispatcher/verifier geschreven events de INSERT + RLS + CHECK passeren.

Examples:
  npm run test:local -- status
  npm run test:local -- happy
  npm run test:local -- happy 4002845777
  npm run test:local -- dry-run
  npm run test:local -- live
  npm run test:local -- cleanup
  npm run test:local -- dlq
`;

// ============================================================================
// Sandbox guard
// ============================================================================

function assertSandbox(): void {
  // Lees de GERESOLVETE BC-omgeving via getConfig() (na dotenv.config +
  // APP_TARGET-resolver), niet langer rauw process.env.BC_ENVIRONMENT. Zo stopt
  // de guard ook hard wanneer een prod-resolved env (bv. APP_TARGET=production)
  // actief is -- de rauwe process.env.BC_ENVIRONMENT kan dan nog sandbox tonen
  // terwijl de echte target production is. Default/sandbox resolvet naar
  // "Sandbox*" en passeert.
  const env = getConfig().BC_ENVIRONMENT;
  if (!env.startsWith("Sandbox")) {
    console.error("\n!!! SANDBOX GUARD: BC_ENVIRONMENT is niet sandbox !!!");
    console.error(`   BC_ENVIRONMENT = "${env}"`);
    console.error("   Deze test mag ALLEEN tegen sandbox draaien.");
    console.error("   Stop.\n");
    process.exit(1);
  }
  console.log(`BC_ENVIRONMENT: ${env} (sandbox OK)`);
}

/**
 * Zachte tegenhanger van assertSandbox() voor de read-only modes (dlq, error-queue,
 * events): stopt NIET, maar waarschuwt luid wanneer de APP_TARGET-resolver een
 * niet-sandbox (mogelijk productie) omgeving oplevert. Sinds de APP_TARGET-resolver
 * (fase 201) schakelt EEN env-flip zowel de BC- als de SB-as naar prod; deze modes
 * raken de (prod) Service Bus / Supabase read-only, dus een blokkade is te streng
 * maar stille prod-toegang is ongewenst.
 */
function warnIfNotSandbox(mode: string): void {
  const env = getConfig().BC_ENVIRONMENT;
  if (!env.startsWith("Sandbox")) {
    console.warn(`\n!!! WAARSCHUWING: APP_TARGET resolvet naar "${env}" (NIET sandbox) !!!`);
    console.warn(`   Mode '${mode}' draait read-only tegen de GERESOLVETE omgeving (mogelijk PRODUCTIE).`);
    console.warn(`   Zet APP_TARGET=sandbox (of laat leeg) als je dit niet bedoelde.\n`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const mode = process.argv[2];

  if (!mode || !["status", "happy", "dry-run", "live", "cleanup", "dlq", "error-queue", "error-queue-process", "events"].includes(mode)) {
    console.log(USAGE.trim());
    process.exit(1);
  }

  // DLQ mode: read-only peek; warnIfNotSandbox() waarschuwt bij een prod-resolved env
  // (de peek raakt de GERESOLVETE Service Bus sinds de APP_TARGET-resolver).
  if (mode === "dlq") {
    await dlqPeek();
    return;
  }

  // Error-queue mode: read-only peek; warnIfNotSandbox() waarschuwt bij prod-resolved env.
  if (mode === "error-queue") {
    await errorQueuePeek();
    return;
  }

  // Error-queue-process mode: DESTRUCTIEF (consumeert/verwijdert berichten + schrijft DB).
  // Harde assertSandbox()-guard binnenin -- mag NOOIT tegen een prod-resolved queue draaien.
  if (mode === "error-queue-process") {
    await errorQueueProcess();
    return;
  }

  // Events mode: read-only Supabase-dump; warnIfNotSandbox() waarschuwt bij prod-resolved env.
  if (mode === "events") {
    await eventsDump();
    return;
  }

  if (mode === "status") {
    await statusOverview();
    return;
  }

  if (mode === "happy") {
    await happyPath(process.argv[3], process.argv[4]);
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

  // Get recent non-food orders (newest first — oldest are vrijwel altijd al getrackt)
  const { data: allOrders, error } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("company_id", COMPANY_ID)
    .order("id", { ascending: false })
    .limit(200);

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

/**
 * Happy-path test: stuur de canonieke testorder uit Leo's Postman-collectie.
 *
 * Leest de payload VERBATIM uit docs/bratra-inbound.postman_collection.json
 * (request 1, "happy path") zodat we gegarandeerd dezelfde, door ERP Company
 * gevalideerde master data sturen (contract, artikel, DC, carrier). Alleen:
 * - meta.messageId / correlationId / occurredOnUtc worden vers gegenereerd
 * - poNumber wordt vervangen door een vers nummer (default: tijdgebaseerd),
 *   want het canned nummer 4002845709 bestaat al in BC ("already exists")
 *
 * Gaat bewust BUITEN onze tracking om (geen bc_sync_orders record): dit test
 * puur de draad Service Bus -> processor -> buffer -> Job Queue, identiek aan
 * de Postman-test uit Leo's guide.
 *
 * Na verzending: wacht 75s en probeer de buffer-rij via de BC API te lezen.
 * Zolang de leesrechten (Table 55001) ontbreken geeft dat 403; dan volgt
 * instructie voor visuele controle in BC.
 */
async function happyPath(poNumberArg?: string, legalEntityArg?: string): Promise<void> {
  assertSandbox();

  const fs = await import("node:fs");
  const pathMod = await import("node:path");

  console.log("\n--- HAPPY PATH: canonieke testorder naar Service Bus ---\n");

  // 1. Canned payload uit de Postman-collectie laden (__dirname = scripts/)
  const repoRoot = pathMod.resolve(__dirname, "..");
  const collectionPath = pathMod.join(repoRoot, "docs", "bratra-inbound.postman_collection.json");
  const collection = JSON.parse(fs.readFileSync(collectionPath, "utf-8"));
  const happyItem = collection.item.find((i: { name: string }) => i.name.includes("happy path"));
  if (!happyItem) {
    console.error("Happy-path request niet gevonden in de Postman-collectie.");
    process.exit(1);
  }
  console.log(`Stap 1: payload geladen uit Postman-collectie ("${happyItem.name}")`);

  // 2. Meta vers genereren (zelfde gedrag als het Postman pre-request script)
  const messageId = randomUUID();
  const correlationId = `robert-happy-${new Date().toISOString().replace(/[:.]/g, "-")}-${messageId.slice(0, 8)}`;
  const occurredOnUtc = new Date().toISOString();
  // Vers PO-nummer: canned 4002845709 bestaat al in BC -> Job Queue "already exists"
  const poNumber = poNumberArg ?? `4002${String(Date.now()).slice(-6)}`;

  const rawBody: string = happyItem.request.body.raw;
  const bodyStr = rawBody
    .replaceAll("{{messageId}}", messageId)
    .replaceAll("{{correlationId}}", correlationId)
    .replaceAll("{{occurredOnUtc}}", occurredOnUtc);

  const envelope = JSON.parse(bodyStr) as import("../src/shared/types").ActionOrderBatchV1Envelope;
  const originalPo = envelope.payload.orders[0].poNumber;
  envelope.payload.orders[0].poNumber = poNumber;
  if (legalEntityArg) {
    envelope.meta.legalEntity = legalEntityArg; // experiment: afwijkende routing testen
  }

  const externalId = `BRA-AC-${messageId}-${poNumber}`;

  console.log("\nStap 2: envelope gereed");
  console.log(`   messageId:      ${messageId}`);
  console.log(`   correlationId:  ${correlationId}`);
  console.log(`   poNumber:       ${poNumber} (canned was ${originalPo})`);
  console.log(`   legalEntity:    ${envelope.meta.legalEntity}`);
  console.log(`   verwachte External ID in BC-buffer: ${externalId}`);

  // 3. Versturen
  console.log("\nStap 3: versturen naar Service Bus...");
  const { sendToServiceBus } = await import("../src/shared/service-bus-client");
  try {
    await sendToServiceBus(envelope);
    console.log("   HTTP 201 Created — Service Bus heeft het bericht geaccepteerd.");
  } catch (err) {
    console.error("   Verzenden MISLUKT:", (err as Error).message);
    process.exit(1);
  }

  console.log("\nVolgens Leo's guide verschijnt binnen ~1s een buffer-rij (status Pending)");
  console.log("en zet de BC Job Queue hem binnen ~1 min op Done (+ Created Document No.).");

  // 4. Wacht en probeer de buffer-rij te lezen
  console.log("\nStap 4: 75 seconden wachten (BC Job Queue draait ~elke minuut)...");
  await sleep(75_000);

  console.log("\nStap 5: buffer-rij opvragen via BC API...");
  try {
    const { authenticateM2M } = await import("../src/shared/bc-auth");
    const { getConfig } = await import("../src/shared/config");
    const config = getConfig();
    const token = await authenticateM2M(config.BC_TENANT_ID);

    const url =
      `https://api.businesscentral.dynamics.com/v2.0/${config.BC_TENANT_ID}/${config.BC_ENVIRONMENT}` +
      `/api/erpcompany/integration/v1.0/companies(${config.BC_COMPANY_ID})/bratraSalesOrderBuffers` +
      `?$filter=externalId eq '${externalId}'`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Data-Access-Intent": "ReadOnly",
      },
    });

    if (response.ok) {
      const data = (await response.json()) as { value?: Array<Record<string, unknown>> };
      const row = data.value?.[0];
      if (row) {
        console.log("   Buffer-rij gevonden:");
        console.log(`   status:              ${row.status ?? "-"}`);
        console.log(`   createdDocumentNo:   ${row.createdDocumentNo ?? row.documentNo ?? "-"}`);
        console.log(`   errorMessage:        ${row.errorMessage ?? "-"}`);
        console.log("\n--- HAPPY PATH RESULTAAT: zie status hierboven (Done = geslaagd) ---");
      } else {
        console.log("   Geen buffer-rij gevonden voor deze externalId.");
        console.log("   Dat is hetzelfde symptoom als open punt 2 — check de DLQ (mode 'dlq')");
        console.log("   en noteer messageId + tijdstip voor ERP Company.");
      }
    } else if (response.status === 403) {
      console.log("   HTTP 403 — leesrechten op Table 55001 ontbreken nog (open punt 1).");
      console.log("\n   VISUELE CONTROLE in BC nodig:");
      console.log("   1. Open de sandbox:");
      console.log(`      https://businesscentral.dynamics.com/${config.BC_TENANT_ID}/${config.BC_ENVIRONMENT}?page=22&noSignUpCheck=1`);
      console.log('   2. Zoek de pagina "Bratra Sales Order Buffers" (zoekterm: Bratra Integration)');
      console.log(`   3. Zoek de rij met External ID: ${externalId}`);
      console.log("   4. Verwacht: status Pending -> Done met Created Document No. (VO26-xxxxx)");
      console.log("      Geen rij? Check de DLQ (mode 'dlq') en meld messageId aan ERP Company.");
    } else {
      const body = await response.text();
      console.log(`   Onverwachte status HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.error("   Buffer-check fout:", (err as Error).message);
  }

  console.log(`\nTraceerbaarheid (voor mail/overleg met Wesley en Leo):`);
  console.log(`   messageId:     ${messageId}`);
  console.log(`   correlationId: ${correlationId}`);
  console.log(`   externalId:    ${externalId}`);
  console.log(`   verzonden om:  ${occurredOnUtc}`);
  console.log();
}

/**
 * Status-overzicht: waar staan we nu.
 *
 * Read-only — wijzigt niets. Toont:
 * 1. Tellingen per status in bc_sync_orders (de tracking-tabel)
 * 2. Laatste verzending naar Service Bus
 * 3. Aantal verwerkte DLQ-berichten (archief)
 * 4. Live check op de BC buffer-API: hebben we al leesrechten op Table 55001?
 */
async function statusOverview(): Promise<void> {
  assertSandbox();

  const { getSupabaseClient } = await import("../src/shared/supabase-client");
  const supabase = getSupabaseClient();

  console.log("\n=== BC Sync status-overzicht ===");
  console.log(`Datum: ${new Date().toISOString()}\n`);

  // 1. Tellingen per status
  console.log("1. Tracking-tabel bc_sync_orders (status per order):");
  const statuses = ["pending", "sent", "verified", "failed", "dead_letter", "skipped"];
  let total = 0;
  for (const s of statuses) {
    const { count, error } = await supabase
      .from("bc_sync_orders")
      .select("*", { count: "exact", head: true })
      .eq("status", s);
    if (error) {
      console.error(`   ${s}: telling mislukt (${error.message})`);
      continue;
    }
    total += count ?? 0;
    console.log(`   ${s.padEnd(13)} ${String(count ?? 0).padStart(5)}`);
  }
  console.log(`   ${"totaal".padEnd(13)} ${String(total).padStart(5)}`);

  // 2. Laatste verzending
  const { data: lastSent } = await supabase
    .from("bc_sync_orders")
    .select("po_number, sent_at, batch_id, status")
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1);

  console.log("\n2. Laatste verzending naar Service Bus:");
  if (lastSent && lastSent.length > 0) {
    const row = lastSent[0];
    console.log(`   ${row.sent_at}  PO ${row.po_number}  (status: ${row.status}, batch: ${row.batch_id})`);
  } else {
    console.log("   Nog geen orders verstuurd.");
  }

  // 3. DLQ-archief
  const { count: dlqCount } = await supabase
    .from("bc_sync_dlq_messages")
    .select("*", { count: "exact", head: true });
  console.log("\n3. DLQ-archief (bc_sync_dlq_messages):");
  console.log(`   ${dlqCount ?? 0} dead-letter-berichten verwerkt en gearchiveerd`);

  // 4. BC buffer-API check (het openstaande leesrechten-punt)
  console.log("\n4. BC buffer-API check (Read op Table 55001, Bratra SO Buffer):");
  try {
    const { authenticateM2M } = await import("../src/shared/bc-auth");
    const { getConfig } = await import("../src/shared/config");
    const config = getConfig();

    const token = await authenticateM2M(config.BC_TENANT_ID);
    console.log("   M2M-authenticatie: OK (token ontvangen van Microsoft Entra)");

    const url =
      `https://api.businesscentral.dynamics.com/v2.0/${config.BC_TENANT_ID}/${config.BC_ENVIRONMENT}` +
      `/api/erpcompany/integration/v1.0/companies(${config.BC_COMPANY_ID})/bratraSalesOrderBuffers?$top=1`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Data-Access-Intent": "ReadOnly",
      },
    });

    if (response.ok) {
      const data = (await response.json()) as { value?: unknown[] };
      console.log(`   Buffer-API: HTTP ${response.status} — leesrechten AANWEZIG`);
      console.log(`   ${data.value?.length ?? 0} record(s) gelezen.`);
      console.log("   >> Open punt 1 is opgelost: de verifier kan de orderstatus terugkoppelen.");
    } else {
      const body = await response.text();
      console.log(`   Buffer-API: HTTP ${response.status}`);
      if (body) console.log(`   ${body.slice(0, 200)}`);
      if (response.status === 403) {
        console.log("   >> OPEN PUNT 1: onze M2M-app mist Read op Table 55001 (Bratra SO Buffer).");
        console.log("      Zolang dit ontbreekt kan de verifier de 'sent'-orders niet naar 'verified' brengen.");
        console.log("      Gevraagd aan ERP Company op 23 mei, herhaald op 4 juni.");
      }
    }
  } catch (err) {
    console.error("   Buffer-check fout:", (err as Error).message);
  }

  console.log("\nOpen punten richting ERP Company:");
  console.log("   1. Read-rechten op de buffer-tabel (Table 55001) voor onze M2M-app — zie check hierboven");
  console.log("   2. Op 4 juni verstuurde orders (11 stuks, HTTP 201, geen DLQ) zijn bij visuele");
  console.log("      controle niet zichtbaar in de buffer-tabel — vraag uitstaand bij Wesley/Leo");
  console.log();
}

async function dlqPeek(): Promise<void> {
  warnIfNotSandbox("dlq");
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

/**
 * Read-only peek op de bratra-error queue (Leo, 15-06-2026).
 *
 * Anders dan de DLQ:
 *  - gewone queue (geen $DeadLetterQueue-subqueue);
 *  - foutinformatie zit in de BODY (error-sectie), niet in response-headers;
 *  - SAS-token scoped op de error-queue. Gebruikt SB_ERROR_KEY_* indien gezet,
 *    valt anders terug op SB_KEY_* (om empirisch te testen of de inbound-key
 *    al toegang heeft -- verwachting: niet, dan komt hier een 401).
 *
 * Peek-lock zonder DELETE: berichten blijven in de queue (lock ~30s).
 */
async function errorQueuePeek(): Promise<void> {
  warnIfNotSandbox("error-queue");
  const { getConfig } = await import("../src/shared/config");
  const { generateSasToken } = await import("../src/shared/service-bus-client");
  const config = getConfig();

  const keyName = config.SB_ERROR_KEY_NAME ?? config.SB_KEY_NAME;
  const keyValue = config.SB_ERROR_KEY_VALUE ?? config.SB_KEY_VALUE;
  const usingFallbackKey = !config.SB_ERROR_KEY_NAME;

  console.log(`\n--- Error-queue Peek: berichten in ${config.SB_ERROR_QUEUE} ---\n`);
  console.log(`   queue:    ${config.SB_ERROR_QUEUE}`);
  console.log(`   SAS-key:  ${keyName}${usingFallbackKey ? " (fallback: inbound-key -- 401 = geen rechten op error-queue)" : ""}\n`);

  const token = generateSasToken(config.SB_NAMESPACE, config.SB_ERROR_QUEUE, keyName, keyValue);

  let count = 0;
  const MAX_PEEK = 20;

  for (let i = 0; i < MAX_PEEK; i++) {
    const url = `https://${config.SB_NAMESPACE}.servicebus.windows.net/${config.SB_ERROR_QUEUE}/messages/head?timeout=2`;
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: token },
    });

    if (response.status === 204) break;
    if (response.status === 401) {
      console.error("HTTP 401 -- geen Listen-rechten op de error-queue met deze SAS-key.");
      console.error("   Vraag ERP Company om een Listen-key op bratra-error (of namespace-level),");
      console.error("   en zet die in .env.local als SB_ERROR_KEY_NAME / SB_ERROR_KEY_VALUE.");
      return;
    }
    if (response.status !== 201) {
      console.error(`Error-queue receive failed: HTTP ${response.status}`);
      const body = await response.text();
      if (body) console.error(`   ${body.slice(0, 300)}`);
      break;
    }

    count++;
    const brokerProps = JSON.parse(response.headers.get("BrokerProperties") ?? "{}");
    const rawBody = await response.text();

    let parsed: import("../src/shared/types").ErrorQueueMessage | null = null;
    try {
      parsed = JSON.parse(rawBody) as import("../src/shared/types").ErrorQueueMessage;
    } catch {
      // body niet parseable -- toon raw preview
    }

    console.log(`Bericht ${count}:`);
    console.log(`   MessageId:      ${brokerProps.MessageId}`);
    console.log(`   SequenceNumber: ${brokerProps.SequenceNumber}`);
    console.log(`   EnqueuedTime:   ${brokerProps.EnqueuedTimeUtc}`);
    if (parsed?.error) {
      console.log(`   poNumber:       ${parsed.order?.poNumber ?? "-"}`);
      console.log(`   correlationId:  ${parsed.meta?.correlationId ?? "-"}`);
      console.log(`   stage:          ${parsed.error.stage}`);
      console.log(`   httpStatus:     ${parsed.error.httpStatus ?? "-"}`);
      console.log(`   retryable:      ${parsed.error.retryable}`);
      console.log(`   failedAtUtc:    ${parsed.error.failedAtUtc ?? "-"}`);
      console.log(`   message:        ${parsed.error.message}`);
    } else {
      console.log(`   Body preview:   ${rawBody.slice(0, 200)}`);
    }
    console.log();

    // Peek-only: geen DELETE -- bericht blijft in de queue (lock ~30s)
  }

  console.log(`Error-queue diepte: minimaal ${count} berichten`);
  if (count === 0) console.log("Error-queue is leeg (of geen toegang -- zie meldingen hierboven).");
  console.log("\nLet op: gepeekte berichten zijn tijdelijk gelocked (~30s). Ze worden automatisch weer beschikbaar.\n");
}

/**
 * Processing-mode tegen de bratra-error queue (D-07).
 *
 * Anders dan errorQueuePeek() (read-only): dit draait de echte checkErrorQueue,
 * die berichten archiveert in bc_sync_error_messages, gematchte orders op
 * 'bc_rejected' zet en de berichten daarna VERWIJDERT uit de queue.
 *
 * Print de meest recente geschreven archief-rijen + de ErrorQueueSummary, zodat
 * een sandbox-run end-to-end te verifieren is. Harde assertSandbox()-guard omdat
 * deze mode destructief is (archiveert + VERWIJDERT queue-berichten): sinds de
 * APP_TARGET-resolver zou APP_TARGET=production anders de PROD-error-queue legen.
 */
async function errorQueueProcess(): Promise<void> {
  // DESTRUCTIEF (consumeert/verwijdert queue-berichten): harde sandbox-guard.
  // Sinds de APP_TARGET-resolver zou APP_TARGET=production hier de PROD-error-queue
  // legen -- assertSandbox() stopt dat vóór enige queue/DB-mutatie.
  assertSandbox();
  const { getConfig } = await import("../src/shared/config");
  const { getSupabaseClient } = await import("../src/shared/supabase-client");
  const { checkErrorQueue } = await import("../src/verifier/error-queue-checker");
  const config = getConfig();
  const supabase = getSupabaseClient();

  console.log(`\n--- Error-queue PROCESS: checkErrorQueue tegen ${config.SB_ERROR_QUEUE} ---\n`);
  console.log("   WAARSCHUWING: deze mode CONSUMEERT/VERWIJDERT berichten uit de queue");
  console.log("   (archiveert ze eerst in bc_sync_error_messages). Anders dan de read-only");
  console.log("   'error-queue' peek. Draai alleen tegen de sandbox.\n");

  const summary = await checkErrorQueue(supabase);

  // Meest recente geschreven archief-rijen tonen
  console.log("\n--- Geschreven bc_sync_error_messages (laatste 10) ---\n");
  const { data: rows, error } = await supabase
    .from("bc_sync_error_messages")
    .select(
      "message_id, po_number, external_id, error_stage, error_message, error_retryable, matched_sync_order_id, received_at",
    )
    .order("received_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error(`   Kon archief-rijen niet ophalen: ${error.message}`);
  } else if (!rows || rows.length === 0) {
    console.log("   Geen rijen in bc_sync_error_messages.");
  } else {
    for (const row of rows) {
      console.log(`messageId:        ${row.message_id}`);
      console.log(`   poNumber:        ${row.po_number ?? "-"}`);
      console.log(`   externalId:      ${row.external_id ?? "-"}`);
      console.log(`   stage:           ${row.error_stage ?? "-"}`);
      console.log(`   retryable:       ${row.error_retryable ?? "-"}`);
      console.log(`   matchedOrderId:  ${row.matched_sync_order_id ?? "-"}`);
      console.log(`   receivedAt:      ${row.received_at ?? "-"}`);
      console.log(`   message:         ${row.error_message ?? "-"}`);
      console.log();
    }
  }

  console.log("--- ErrorQueueSummary ---");
  console.log(`   archived:  ${summary.archived}`);
  console.log(`   matched:   ${summary.matched}`);
  console.log(`   unmatched: ${summary.unmatched}`);
  console.log(`   skipped:   ${summary.skipped}`);
  console.log(`   deleted:   ${summary.deleted}`);
  console.log(`   errors:    ${summary.errors}`);
  console.log();
}

/**
 * Events dump (D-09 #2): read-only SELECT op de laatste bc_sync_events-rijen uit
 * de sandbox-Supabase. Tweede verificatielaag naast de unit-tests: bewijst dat de
 * door dispatcher/verifier geschreven events de echte INSERT + RLS + de
 * event_type/from_status/to_status CHECK-constraints passeren (Pitfall 4 -- de
 * best-effort swallow verbergt een CHECK-violation, een "0 rijen"-discrepantie
 * maakt 'm zichtbaar). Wijzigt niets.
 */
async function eventsDump(): Promise<void> {
  warnIfNotSandbox("events");
  const { getSupabaseClient } = await import("../src/shared/supabase-client");
  const supabase = getSupabaseClient();

  console.log("\n--- Laatste bc_sync_events (laatste 30, nieuwste eerst) ---\n");

  const { data: rows, error } = await supabase
    .from("bc_sync_events")
    .select(
      "id, sync_order_id, order_id, event_type, from_status, to_status, retry_count, detail, occurred_at",
    )
    .order("occurred_at", { ascending: false })
    .limit(30);

  if (error) {
    console.error(`   Kon bc_sync_events niet ophalen: ${error.message}`);
    return;
  }

  if (!rows || rows.length === 0) {
    console.log("   Geen rijen in bc_sync_events.");
    return;
  }

  for (const row of rows) {
    const from = row.from_status ?? "-";
    const to = row.to_status ?? "-";
    console.log(`event_type:       ${row.event_type}`);
    console.log(`   from -> to:      ${from} -> ${to}`);
    console.log(`   orderId:         ${row.order_id ?? "-"} (sync_order_id ${row.sync_order_id ?? "-"})`);
    console.log(`   retryCount:      ${row.retry_count ?? "-"}`);
    console.log(`   occurredAt:      ${row.occurred_at ?? "-"}`);
    console.log(`   detail:          ${JSON.stringify(row.detail)}`);
    console.log();
  }

  console.log(`--- ${rows.length} rij(en) getoond ---\n`);
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
