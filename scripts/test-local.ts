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

  try {
    if (target === "dispatcher") {
      const { handler } = await import("../src/dispatcher/handler");
      await handler(event, context);
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

main();
