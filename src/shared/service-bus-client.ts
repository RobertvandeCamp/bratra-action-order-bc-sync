import { createHmac } from "node:crypto";
import { getConfig } from "./config";
import type { ActionOrderBatchV1Envelope } from "./types";

/**
 * Generate a SAS token for Azure Service Bus authentication.
 *
 * ResourceUri uses .servicebus.windows.net suffix (RESEARCH.md Pitfall 4).
 * Token TTL: 10 minutes.
 */
export function generateSasToken(
  namespace: string,
  queue: string,
  keyName: string,
  keyValue: string,
): string {
  const resourceUri = `https://${namespace}.servicebus.windows.net/${queue}`;
  const expiry = Math.floor(Date.now() / 1000) + 600; // 10 min TTL
  const stringToSign = encodeURIComponent(resourceUri) + "\n" + expiry;
  const sig = createHmac("sha256", keyValue)
    .update(stringToSign)
    .digest("base64");
  return `SharedAccessSignature sr=${encodeURIComponent(resourceUri)}&sig=${encodeURIComponent(sig)}&se=${expiry}&skn=${keyName}`;
}

/**
 * Send an ActionOrderBatchV1 envelope to Azure Service Bus via HTTP POST.
 *
 * Uses SAS token authentication. Expects HTTP 201 Created.
 * Never logs the SAS token or key value (T-150-02 threat mitigation).
 */
export async function sendToServiceBus(
  envelope: ActionOrderBatchV1Envelope,
): Promise<void> {
  const config = getConfig();
  const token = generateSasToken(
    config.SB_NAMESPACE,
    config.SB_QUEUE,
    config.SB_KEY_NAME,
    config.SB_KEY_VALUE,
  );

  const url = `https://${config.SB_NAMESPACE}.servicebus.windows.net/${config.SB_QUEUE}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      BrokerProperties: JSON.stringify({
        MessageId: envelope.meta.messageId,
        CorrelationId: envelope.meta.correlationId,
        Label: envelope.meta.name,
      }),
    },
    body: JSON.stringify(envelope),
  });

  if (response.status !== 201) {
    const body = await response.text();
    throw new Error(
      `Service Bus send failed (${response.status}): ${body.slice(0, 300)}`,
    );
  }
}
