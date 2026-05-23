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
const configSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SB_NAMESPACE: z.string().min(1),
  SB_QUEUE: z.string().min(1),
  SB_KEY_NAME: z.string().min(1),
  SB_KEY_VALUE: z.string().min(1),
  BC_TENANT_ID: z.string().uuid(),
  BC_CLIENT_ID: z.string().uuid(),
  BC_CLIENT_SECRET: z.string().min(1),
  BC_ENVIRONMENT: z.string().min(1),
  BC_COMPANY_ID: z.string().uuid(),
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
