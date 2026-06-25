import { defineConfig } from "vitest/config";

// Unit-test config voor de verifier-modules. Node-omgeving (geen DOM); de
// Supabase-client wordt in de tests met een tiny inline fake gemockt, dus geen
// netwerk/DB. Alleen de testbestanden zelf draaien -- de productie-build gaat
// via esbuild (expliciete entry points) en raakt deze bestanden niet.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
