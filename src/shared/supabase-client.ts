import { createClient } from "@supabase/supabase-js";
import { getConfig } from "./config";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActionOrdersClient = ReturnType<typeof createClient<any, "action_orders">>;

let client: ActionOrdersClient | undefined;

/**
 * Supabase client voor de action_orders schema.
 * Singleton -- created once, cached on module scope.
 *
 * Uses service_role key for full server-side access (RLS bypass).
 */
export function getSupabaseClient(): ActionOrdersClient {
  if (!client) {
    const config = getConfig();
    client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "action_orders" },
    });
  }
  return client;
}
