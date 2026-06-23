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

let cachedConfig: Config | undefined;

/**
 * Get validated config. Singleton -- parsed once, cached on module scope.
 *
 * On first call: validates all 11 env vars via Zod. If any are missing or invalid,
 * throws ZodError with all validation failures listed. Subsequent calls return
 * the cached config without re-validation.
 */
export function getConfig(): Config {
  if (!cachedConfig) {
    cachedConfig = configSchema.parse(process.env);
  }
  return cachedConfig;
}
