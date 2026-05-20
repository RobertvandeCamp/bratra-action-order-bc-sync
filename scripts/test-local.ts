/**
 * Lokaal test skeleton voor dispatcher en verifier handlers.
 *
 * Gebruik:
 *   npm run test:local -- dispatcher
 *   npm run test:local -- verifier
 *
 * Vereist .env.local met credentials (zie .env.local.example).
 *
 * Volledige test flow wordt geimplementeerd in Phase 151 (dispatcher) en Phase 152 (verifier).
 */

import * as dotenv from "dotenv";
import * as crypto from "crypto";
import type { ScheduledEvent, Context } from "aws-lambda";

// Laad .env.local VOOR alles -- zodat config.ts process.env kan lezen
dotenv.config({ path: ".env.local" });

const USAGE = `
Usage: npm run test:local -- <handler>

  handler: "dispatcher" of "verifier"

Examples:
  npm run test:local -- dispatcher
  npm run test:local -- verifier
`;

async function main(): Promise<void> {
  const target = process.argv[2];

  if (!target || !["dispatcher", "verifier"].includes(target)) {
    console.log(USAGE.trim());
    process.exit(1);
  }

  // Mock EventBridge ScheduledEvent
  const event: ScheduledEvent = {
    version: "0",
    id: crypto.randomUUID(),
    source: "aws.events",
    account: "123456789012",
    time: new Date().toISOString(),
    region: "eu-central-1",
    resources: ["arn:aws:events:eu-central-1:123456:rule/test"],
    "detail-type": "Scheduled Event",
    detail: {},
  };

  // Mock Lambda Context (minimale velden)
  const context: Context = {
    callbackWaitsForEmptyEventLoop: true,
    functionName: `bc-sync-${target}`,
    functionVersion: "$LATEST",
    invokedFunctionArn: `arn:aws:lambda:eu-central-1:123456:function:bc-sync-${target}`,
    memoryLimitInMB: "256",
    awsRequestId: crypto.randomUUID(),
    logGroupName: `/aws/lambda/bc-sync-${target}`,
    logStreamName: "test-local",
    getRemainingTimeInMillis: () => 300000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };

  console.log(`\n--- test-local: ${target} ---\n`);

  // D-01: Log BC_ENVIRONMENT so user can verify sandbox
  console.log(`BC_ENVIRONMENT: ${process.env.BC_ENVIRONMENT ?? "(not set)"}`);

  try {
    if (target === "dispatcher") {
      const { handler } = await import("../src/dispatcher/handler");
      await handler(event, context);

      // Post-dispatch: query bc_sync_orders for verification
      await showDispatchResults();
    } else {
      const { handler } = await import("../src/verifier/handler");
      await handler(event, context);
    }

    console.log(`\n--- ${target} completed successfully ---\n`);
    process.exit(0);
  } catch (err) {
    console.error(`\n--- ${target} failed ---\n`);
    console.error(err);
    process.exit(1);
  }
}

/**
 * Query bc_sync_orders after dispatcher run and display results.
 * Shows recent tracking records in a readable format.
 */
async function showDispatchResults(): Promise<void> {
  // Import after dotenv.config so env vars are available
  const { getSupabaseClient } = await import("../src/shared/supabase-client");
  const supabase = getSupabaseClient();

  console.log("\n--- bc_sync_orders results ---\n");

  const { data, error } = await supabase
    .from("bc_sync_orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("Failed to query bc_sync_orders:", error.message);
    return;
  }

  if (!data || data.length === 0) {
    console.log("No bc_sync_orders records found.");
    return;
  }

  // Display as readable table
  console.log(
    "po_number".padEnd(15),
    "status".padEnd(10),
    "message_id".padEnd(12),
    "batch_id".padEnd(12),
    "sent_at".padEnd(22),
    "error_message",
  );
  console.log("-".repeat(90));

  type SyncRow = {
    po_number: string;
    status: string;
    message_id: string | null;
    batch_id: string | null;
    sent_at: string | null;
    error_message: string | null;
  };

  for (const row of data as SyncRow[]) {
    console.log(
      (row.po_number ?? "").padEnd(15),
      (row.status ?? "").padEnd(10),
      (row.message_id?.slice(0, 8) ?? "-").padEnd(12),
      (row.batch_id?.slice(0, 8) ?? "-").padEnd(12),
      (row.sent_at ?? "-").padEnd(22),
      row.error_message ?? "",
    );
  }

  // Count by status
  const statusCounts = (data as SyncRow[]).reduce(
    (acc, row) => {
      const s = row.status ?? "unknown";
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const sent = statusCounts["sent"] ?? 0;
  const failed = statusCounts["failed"] ?? 0;
  const pending = statusCounts["pending"] ?? 0;

  console.log(`\nDispatch complete: ${sent} sent, ${failed} failed, ${pending} pending`);
  console.log("Check Azure Service Bus queue for messages");
  console.log("Check Supabase bc_sync_orders table for tracking records");
}

main();
