import type { Logger } from "pino";
import { FETCH_TIMEOUT_MS } from "./config";
import type { BCListResponse, BcGetOptions, BCConfig } from "./types";

export interface Company {
  id: string;
  name: string;
}

function getBaseUrl(config: BCConfig, apiRoute = "api/v2.0"): string {
  return `https://api.businesscentral.dynamics.com/v2.0/${config.tenantId}/${config.environment}/${apiRoute}`;
}

/**
 * Internal: fetch with retry on HTTP 429 (rate limit).
 * Respects Retry-After header if present, falls back to exponential backoff.
 * Aborts after FETCH_TIMEOUT_MS (30s) via AbortSignal.timeout — RES-01/D-01.
 */
async function fetchWithRetry(
  url: string,
  token: string,
  maxRetries = 3,
  logger?: Logger,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Data-Access-Intent": "ReadOnly",
        },
      });
    } catch (err) {
      // WR-03: maak de 30s-abort observeerbaar in de run-context voordat de
      // TimeoutError/AbortError als opaque per-order error string opduikt.
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        logger?.warn({ url, attempt, timeoutMs: FETCH_TIMEOUT_MS }, "BC API fetch timed out");
      }
      throw err;
    }

    if (response.status === 429) {
      if (attempt === maxRetries) {
        const body = await response.text();
        throw new Error(
          `BC API rate limited after ${maxRetries} retries: ${body.slice(0, 300)}`,
        );
      }
      const retryAfterRaw = response.headers.get("Retry-After");
      const parsed = retryAfterRaw ? parseInt(retryAfterRaw, 10) : NaN;
      const retryAfterSeconds = Number.isNaN(parsed) ? 5 : parsed;
      const baseDelay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      const delay = Math.max(retryAfterSeconds * 1000, baseDelay);
      // WR-03: 429-backoff observeerbaar op debug (loop-verbositeit, D-05) —
      // zonder dit slaapt een 429-storm 1s/2s/4s per order zonder één logregel.
      logger?.debug({ url, attempt, delayMs: delay, retryAfterSeconds }, "BC API 429 -- backing off");
      // Release connection back to pool before sleeping (Node fetch/Undici requirement)
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`BC API ${response.status}: ${body.slice(0, 300)}`);
    }

    return response;
  }
  // Unreachable, but TypeScript needs it
  throw new Error("fetchWithRetry: unreachable");
}

/**
 * GET request to BC API with auto-pagination and retry.
 *
 * - Follows @odata.nextLink for server-driven paging
 * - Retries on HTTP 429 with exponential backoff
 * - Includes Data-Access-Intent: ReadOnly header
 */
export async function bcGet<T = Record<string, unknown>>(
  token: string,
  config: BCConfig,
  endpoint: string,
  options?: BcGetOptions,
  logger?: Logger,
): Promise<BCListResponse<T>> {
  const { paginate = true, maxPages = 10, apiRoute } = options ?? {};
  const baseUrl = getBaseUrl(config, apiRoute);
  const isFullUrl = endpoint.startsWith("https://");
  const url = isFullUrl ? endpoint : `${baseUrl}/${endpoint}`;

  const response = await fetchWithRetry(url, token, 3, logger);
  const data = (await response.json()) as BCListResponse<T>;

  if (!paginate || !data["@odata.nextLink"]) {
    return data;
  }

  // Follow nextLink for remaining pages
  const allValues = [...(data.value ?? [])];
  let nextUrl: string | undefined = data["@odata.nextLink"];
  let pageCount = 1;

  while (nextUrl && pageCount < maxPages) {
    const nextResponse = await fetchWithRetry(nextUrl, token, 3, logger);
    const nextData = (await nextResponse.json()) as BCListResponse<T>;
    allValues.push(...(nextData.value ?? []));
    nextUrl = nextData["@odata.nextLink"];
    pageCount++;
  }

  return {
    ...data,
    value: allValues,
    "@odata.nextLink": nextUrl, // Preserves link if maxPages was hit
  };
}

/**
 * Get the company ID. If config.companyId is already a UUID, return it directly.
 * Otherwise query the BC API to resolve by name.
 */
export async function getCompanyId(
  token: string,
  config: BCConfig,
): Promise<string> {
  // companyId is already a UUID in this project (D-05: BC_COMPANY_ID is z.string().uuid())
  if (config.companyId) {
    return config.companyId;
  }

  const data = await bcGet<Company>(token, config, "companies");
  const company = data.value[0];
  if (!company) {
    throw new Error("No companies found in BC environment");
  }
  return company.id;
}
