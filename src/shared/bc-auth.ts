import { ConfidentialClientApplication } from "@azure/msal-node";

const SCOPES = ["https://api.businesscentral.dynamics.com/.default"];

function getAuthority(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}`;
}

// --- MSAL Singleton ---
// ConfidentialClientApplication auto-caches tokens internally (~60min TTL).
// Creating a new instance per call destroys the cache. Use singleton.
let msalClient: ConfidentialClientApplication | null = null;
let msalTenantId: string | null = null;

function getMsalClient(tenantId: string): ConfidentialClientApplication {
  if (msalClient && msalTenantId === tenantId) {
    return msalClient;
  }
  if (msalClient && msalTenantId !== tenantId) {
    throw new Error(
      `MSAL client was created for tenant '${msalTenantId}' but called with '${tenantId}'. Multi-tenant switching is not supported.`,
    );
  }
  const clientId = process.env.BC_CLIENT_ID;
  const clientSecret = process.env.BC_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "BC_CLIENT_ID and BC_CLIENT_SECRET must be set in environment variables",
    );
  }
  msalClient = new ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: getAuthority(tenantId),
    },
  });
  msalTenantId = tenantId;
  return msalClient;
}

/**
 * M2M authentication via client credentials (no user login needed).
 * Uses singleton MSAL client for token caching.
 *
 * BC_CLIENT_ID and BC_CLIENT_SECRET are read directly from process.env
 * by getMsalClient -- never passed through the Config type (T-150-03).
 */
export async function authenticateM2M(tenantId: string): Promise<string> {
  const client = getMsalClient(tenantId);
  const result = await client.acquireTokenByClientCredential({
    scopes: SCOPES,
  });
  if (!result?.accessToken) {
    throw new Error("M2M authenticatie mislukt");
  }
  return result.accessToken;
}
