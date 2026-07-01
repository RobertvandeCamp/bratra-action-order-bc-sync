import { z } from "zod";

/**
 * Zod schema voor alle Lambda env vars.
 *
 * Validated bij eerste getConfig() aanroep (cold start).
 * Bij missende of ongeldige vars faalt de Lambda meteen met duidelijke Zod error.
 *
 * BC_CLIENT_ID en BC_CLIENT_SECRET worden hier gevalideerd maar NIET in het
 * Config return type opgenomen -- authenticateM2M leest ze direct uit process.env
 * (zelfde patroon als bratra-bc-mcp-server).
 *
 * Let op: dit schema verandert NIET door de APP_TARGET-resolver. Het ontvangt
 * voortaan een door resolveTarget() samengesteld object i.p.v. de hele
 * process.env, maar de veldnamen en het Config-type blijven identiek zodat geen
 * enkele consumer (service-bus-client, supabase-client, dispatcher/verifier)
 * breekt.
 */
const configSchema = z
  .object({
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    SB_NAMESPACE: z.string().min(1),
    SB_QUEUE: z.string().min(1),
    SB_KEY_NAME: z.string().min(1),
    SB_KEY_VALUE: z.string().min(1),
    // Error queue (Leo, 15-06-2026): BC-afgekeurde orders belanden hier verrijkt
    // met een error-sectie. Aparte queue -- geen $DeadLetterQueue-subqueue.
    // SB_ERROR_QUEUE default "bratra-error". De Listen-key kan afwijken van de
    // inbound-key; valt terug op SB_KEY_NAME/VALUE als niet apart gezet.
    SB_ERROR_QUEUE: z.string().min(1).default("bratra-error"),
    SB_ERROR_KEY_NAME: z.string().min(1).optional(),
    SB_ERROR_KEY_VALUE: z.string().min(1).optional(),
    BC_TENANT_ID: z.string().uuid(),
    BC_CLIENT_ID: z.string().uuid(),
    BC_CLIENT_SECRET: z.string().min(1),
    BC_ENVIRONMENT: z.string().min(1),
    BC_COMPANY_ID: z.string().uuid(),
  })
  // Cross-field check (claude Important, PR#5): de error-key is een PAAR. Eén
  // helft zonder de andere mixt SB_ERROR_KEY_NAME met SB_KEY_VALUE (of andersom)
  // -> een kapot SAS-token. Eis beide-gezet of beide-leeg, fail-fast op de grens.
  // De check draait NA resolutie, op de geresolvete error-key-waarden.
  .superRefine((cfg, ctx) => {
    const hasName = cfg.SB_ERROR_KEY_NAME !== undefined;
    const hasValue = cfg.SB_ERROR_KEY_VALUE !== undefined;
    if (hasName !== hasValue) {
      const missing = hasName ? "SB_ERROR_KEY_VALUE" : "SB_ERROR_KEY_NAME";
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [missing],
        message:
          "SB_ERROR_KEY_NAME and SB_ERROR_KEY_VALUE must be set together (both or neither) -- " +
          `${missing} is missing. A half-configured error-key produces a broken SAS token.`,
      });
    }
  });

export type Config = z.infer<typeof configSchema>;

/**
 * APP_TARGET selecteert welke omgeving wordt geresolved over BEIDE assen:
 * de BC-API-as (BC_ENVIRONMENT, BC_COMPANY_ID) EN de Azure Service Bus-as
 * (SB_NAMESPACE, SB_QUEUE, SB_KEY_*, SB_ERROR_*). Strikte enum: alleen
 * "production" of "sandbox". Een lege/whitespace-only waarde wordt als ONGEZET
 * behandeld (legacy-pad), niet als ongeldige waarde -- zie resolveTarget().
 */
const appTargetSchema = z.enum(["production", "sandbox"]);

/**
 * Keys die per target (sandbox/prod) uit prefixed `SANDBOX_*`/`PROD_*`-paren
 * resolven. De gedeelde keys (BC_TENANT_ID, BC_CLIENT_ID, BC_CLIENT_SECRET,
 * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) staan hier BEWUST NIET in: die zijn
 * omgeving-onafhankelijk en worden altijd ongeprefixt gelezen.
 *
 * De resolver leest per key het paar `SANDBOX_<key>` / `PROD_<key>` (de prefix
 * wordt dynamisch samengesteld in resolveTarget()). Het volledige contract:
 *
 *   BC-as:
 *     SANDBOX_BC_ENVIRONMENT  / PROD_BC_ENVIRONMENT
 *     SANDBOX_BC_COMPANY_ID   / PROD_BC_COMPANY_ID
 *   SB-as:
 *     SANDBOX_SB_NAMESPACE    / PROD_SB_NAMESPACE
 *     SANDBOX_SB_QUEUE        / PROD_SB_QUEUE
 *     SANDBOX_SB_KEY_NAME     / PROD_SB_KEY_NAME
 *     SANDBOX_SB_KEY_VALUE    / PROD_SB_KEY_VALUE
 *     SANDBOX_SB_ERROR_QUEUE  / PROD_SB_ERROR_QUEUE
 *     SANDBOX_SB_ERROR_KEY_NAME  / PROD_SB_ERROR_KEY_NAME
 *     SANDBOX_SB_ERROR_KEY_VALUE / PROD_SB_ERROR_KEY_VALUE
 */
const TARGETED_KEYS = [
  // BC-as
  "BC_ENVIRONMENT",
  "BC_COMPANY_ID",
  // SB-as
  "SB_NAMESPACE",
  "SB_QUEUE",
  "SB_KEY_NAME",
  "SB_KEY_VALUE",
  "SB_ERROR_QUEUE",
  "SB_ERROR_KEY_NAME",
  "SB_ERROR_KEY_VALUE",
] as const;

/**
 * Bepaal de env-var-prefix op basis van APP_TARGET.
 *
 * - APP_TARGET=production           -> "PROD_"
 * - APP_TARGET=sandbox              -> "SANDBOX_"
 * - APP_TARGET ongezet/leeg/spaties -> "" (legacy ongeprefixt pad)
 *
 * Cruciaal: APP_TARGET wordt EERST genormaliseerd (trim). Een lege string of
 * whitespace-only waarde -- zoals een nog-niet-gezette repo-variabele die leeg
 * expandeert -- telt als ongezet en valt terug op het legacy-pad ZONDER
 * fail-fast, zodat een deploy met nog-niet-gemigreerde env vars niet breekt en
 * de draaiende default sandbox blijft (scope fence: geen flip). Alleen een
 * niet-lege, niet-toegestane waarde (bv. "prod") faalt fail-fast via de enum.
 */
function resolveTargetPrefix(): "" | "SANDBOX_" | "PROD_" {
  const normalized = process.env.APP_TARGET?.trim();

  // Ongezet / leeg / whitespace-only -> legacy-pad, geen fail-fast.
  if (!normalized) {
    return "";
  }

  // Niet-lege waarde -> strikte enum-validatie (ongeldige waarde gooit -> fail-fast).
  const appTarget = appTargetSchema.parse(normalized);
  return appTarget === "production" ? "PROD_" : "SANDBOX_";
}

/**
 * Resolve de targeted keys (BC- + SB-as) uit de prefixed paren voor de gekozen
 * APP_TARGET. Een ontbrekende geresolvete waarde blijft `undefined` en faalt
 * vervolgens fail-fast via het Zod-schema (min(1)) -- er is GEEN stille terugval
 * naar de andere omgeving, zodat sandbox-creds nooit met een prod-namespace
 * gemengd worden.
 */
function resolveTarget(): Record<string, string | undefined> {
  const prefix = resolveTargetPrefix();
  const resolved: Record<string, string | undefined> = {};
  for (const key of TARGETED_KEYS) {
    resolved[key] = process.env[`${prefix}${key}`];
  }
  return resolved;
}

let cachedConfig: Config | undefined;

/**
 * Get validated config. Singleton -- parsed once, cached on module scope.
 *
 * Op de eerste call resolvet de APP_TARGET-resolver de targeted keys (BC- +
 * SB-as) uit de `SANDBOX_*`/`PROD_*`-paren en combineert die met de altijd
 * ongeprefixte gedeelde keys (BC_TENANT_ID, BC_CLIENT_ID, BC_CLIENT_SECRET,
 * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). Het samengestelde object gaat door
 * Zod; ontbreekt een waarde voor de gekozen target, dan faalt het fail-fast
 * (ZodError) zonder stille terugval naar de andere omgeving. Subsequent calls
 * geven de gecachte config terug zonder her-validatie.
 *
 * Logt nooit secret-waarden (SB_KEY_VALUE, BC_CLIENT_SECRET,
 * SUPABASE_SERVICE_ROLE_KEY) -- die passeren alleen Zod en de consumers.
 */
export function getConfig(): Config {
  if (!cachedConfig) {
    const resolved = resolveTarget();
    cachedConfig = configSchema.parse({
      ...resolved,
      // Gedeelde keys ALTIJD ongeprefixt (omgeving-onafhankelijk).
      BC_TENANT_ID: process.env.BC_TENANT_ID,
      BC_CLIENT_ID: process.env.BC_CLIENT_ID,
      BC_CLIENT_SECRET: process.env.BC_CLIENT_SECRET,
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
  }
  return cachedConfig;
}
