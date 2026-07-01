import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// config.test.ts -- APP_TARGET-resolver over BC- en SB-as.
//
// getConfig() cachet zijn resultaat op module-scope (singleton). Elke case
// resolvet daarom opnieuw via vi.resetModules() + een dynamische import van
// ./config, onder een per-case opgebouwde process.env. Er staan ALLEEN dummy
// UUID/URL-placeholders in dit bestand -- nooit echte secrets (T-201-01).
// ============================================================================

// Alle env-keys die de resolver of het schema raakt. In beforeEach gewist zodat
// geen waarde uit de echte shell-env of een vorige case doorlekt.
const MANAGED_KEYS = [
  "APP_TARGET",
  // Gedeelde (ongeprefixte) keys
  "BC_TENANT_ID",
  "BC_CLIENT_ID",
  "BC_CLIENT_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  // Targeted keys: legacy + SANDBOX_/PROD_-paren
  "BC_ENVIRONMENT",
  "BC_COMPANY_ID",
  "SB_NAMESPACE",
  "SB_QUEUE",
  "SB_KEY_NAME",
  "SB_KEY_VALUE",
  "SB_ERROR_QUEUE",
  "SB_ERROR_KEY_NAME",
  "SB_ERROR_KEY_VALUE",
] as const;

// Dummy placeholders die het Zod-schema passeren (uuid/url-vorm), geen secrets.
const DUMMY = {
  TENANT_ID: "11111111-1111-1111-1111-111111111111",
  CLIENT_ID: "22222222-2222-2222-2222-222222222222",
  CLIENT_SECRET: "dummy-client-secret",
  SUPABASE_URL: "https://dummy.supabase.co",
  SERVICE_ROLE_KEY: "dummy-service-role-key",
  SANDBOX_COMPANY_ID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  PROD_COMPANY_ID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  LEGACY_COMPANY_ID: "cccccccc-cccc-cccc-cccc-cccccccccccc",
};

/** Zet de altijd-ongeprefixte gedeelde keys. */
function setSharedKeys(): void {
  process.env.BC_TENANT_ID = DUMMY.TENANT_ID;
  process.env.BC_CLIENT_ID = DUMMY.CLIENT_ID;
  process.env.BC_CLIENT_SECRET = DUMMY.CLIENT_SECRET;
  process.env.SUPABASE_URL = DUMMY.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = DUMMY.SERVICE_ROLE_KEY;
}

/** Vul een targeted-as voor een gegeven prefix ("", "SANDBOX_", "PROD_"). */
function setTargetedAxis(
  prefix: "" | "SANDBOX_" | "PROD_",
  bcEnvironment: string,
  bcCompanyId: string,
  tag: string,
): void {
  process.env[`${prefix}BC_ENVIRONMENT`] = bcEnvironment;
  process.env[`${prefix}BC_COMPANY_ID`] = bcCompanyId;
  process.env[`${prefix}SB_NAMESPACE`] = `sb-${tag}`;
  process.env[`${prefix}SB_QUEUE`] = `queue-${tag}`;
  process.env[`${prefix}SB_KEY_NAME`] = `key-${tag}`;
  process.env[`${prefix}SB_KEY_VALUE`] = `secret-${tag}`;
  process.env[`${prefix}SB_ERROR_QUEUE`] = `error-${tag}`;
}

/** Verse import van ./config met lege singleton-cache. */
async function importConfig() {
  vi.resetModules();
  return import("./config");
}

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  for (const key of MANAGED_KEYS) {
    delete process.env[key];
  }
  setSharedKeys();
});

afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks();
});

describe("getConfig() APP_TARGET-resolutie", () => {
  it("APP_TARGET=sandbox resolvet de targeted keys uit de SANDBOX_*-paren", async () => {
    process.env.APP_TARGET = "sandbox";
    setTargetedAxis("SANDBOX_", "Sandbox", DUMMY.SANDBOX_COMPANY_ID, "sandbox");
    // PROD_-as bewust ander ingevuld -> mag NOOIT gelezen worden.
    setTargetedAxis("PROD_", "Production", DUMMY.PROD_COMPANY_ID, "prod");

    const { getConfig } = await importConfig();
    const cfg = getConfig();

    expect(cfg.BC_ENVIRONMENT).toBe("Sandbox");
    expect(cfg.BC_COMPANY_ID).toBe(DUMMY.SANDBOX_COMPANY_ID);
    expect(cfg.SB_NAMESPACE).toBe("sb-sandbox");
    expect(cfg.SB_QUEUE).toBe("queue-sandbox");
    expect(cfg.SB_KEY_NAME).toBe("key-sandbox");
    expect(cfg.SB_KEY_VALUE).toBe("secret-sandbox");
    expect(cfg.SB_ERROR_QUEUE).toBe("error-sandbox");
  });

  it("APP_TARGET=production resolvet uit de PROD_*-paren en levert een niet-Sandbox BC_ENVIRONMENT (basis 201-03 guard)", async () => {
    process.env.APP_TARGET = "production";
    setTargetedAxis("SANDBOX_", "Sandbox", DUMMY.SANDBOX_COMPANY_ID, "sandbox");
    setTargetedAxis("PROD_", "Production", DUMMY.PROD_COMPANY_ID, "prod");

    const { getConfig } = await importConfig();
    const cfg = getConfig();

    expect(cfg.BC_ENVIRONMENT).toBe("Production");
    expect(cfg.BC_ENVIRONMENT).not.toBe("Sandbox");
    expect(cfg.BC_COMPANY_ID).toBe(DUMMY.PROD_COMPANY_ID);
    expect(cfg.SB_NAMESPACE).toBe("sb-prod");
    expect(cfg.SB_KEY_VALUE).toBe("secret-prod");
    expect(cfg.SB_ERROR_QUEUE).toBe("error-prod");
  });

  it("APP_TARGET ongezet valt terug op de legacy ongeprefixte keys (default sandbox-gedrag, geen flip)", async () => {
    // Geen APP_TARGET, alleen legacy ongeprefixte keys gezet.
    setTargetedAxis("", "Sandbox", DUMMY.LEGACY_COMPANY_ID, "legacy");
    // Prefixed paren bewust NIET gezet -> bewijst dat de legacy-tak wordt gelezen.

    const { getConfig } = await importConfig();
    const cfg = getConfig();

    expect(cfg.BC_ENVIRONMENT).toBe("Sandbox");
    expect(cfg.BC_COMPANY_ID).toBe(DUMMY.LEGACY_COMPANY_ID);
    expect(cfg.SB_NAMESPACE).toBe("sb-legacy");
    expect(cfg.SB_QUEUE).toBe("queue-legacy");
  });

  it("APP_TARGET=' ' (whitespace) telt als ongezet en valt terug op legacy (geen fail-fast)", async () => {
    process.env.APP_TARGET = "   ";
    setTargetedAxis("", "Sandbox", DUMMY.LEGACY_COMPANY_ID, "legacy");

    const { getConfig } = await importConfig();
    expect(() => getConfig()).not.toThrow();
    expect(getConfig().BC_ENVIRONMENT).toBe("Sandbox");
  });

  it("een gekozen target met een ontbrekende geresolvete waarde faalt fail-fast, zonder terugval naar de andere omgeving", async () => {
    process.env.APP_TARGET = "production";
    // Volledige SANDBOX_-as gezet (zou een stille terugval verbergen)...
    setTargetedAxis("SANDBOX_", "Sandbox", DUMMY.SANDBOX_COMPANY_ID, "sandbox");
    // ...PROD_-as gezet MAAR PROD_SB_NAMESPACE ontbreekt.
    setTargetedAxis("PROD_", "Production", DUMMY.PROD_COMPANY_ID, "prod");
    delete process.env.PROD_SB_NAMESPACE;

    const { getConfig } = await importConfig();
    // Fail-fast: gooit i.p.v. stil terug te vallen op SANDBOX_SB_NAMESPACE.
    expect(() => getConfig()).toThrow();
  });

  it("een niet-lege ongeldige APP_TARGET-waarde faalt fail-fast (strikte enum)", async () => {
    process.env.APP_TARGET = "prod"; // geen geldige enum-waarde
    setTargetedAxis("SANDBOX_", "Sandbox", DUMMY.SANDBOX_COMPANY_ID, "sandbox");

    const { getConfig } = await importConfig();
    expect(() => getConfig()).toThrow();
  });

  it("gedeelde keys (BC_TENANT_ID, SUPABASE_URL) worden altijd ongeprefixt gelezen", async () => {
    process.env.APP_TARGET = "production";
    setTargetedAxis("PROD_", "Production", DUMMY.PROD_COMPANY_ID, "prod");
    // Prefixed varianten van gedeelde keys gezet -> mogen GEEN effect hebben.
    process.env.PROD_BC_TENANT_ID = "99999999-9999-9999-9999-999999999999";
    process.env.PROD_SUPABASE_URL = "https://wrong.supabase.co";

    const { getConfig } = await importConfig();
    const cfg = getConfig();

    expect(cfg.BC_TENANT_ID).toBe(DUMMY.TENANT_ID);
    expect(cfg.SUPABASE_URL).toBe(DUMMY.SUPABASE_URL);
  });
});
