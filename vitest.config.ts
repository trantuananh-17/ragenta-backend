import { defineConfig } from "vitest/config"

/**
 * Unit tests only, and deliberately so.
 *
 * Nothing here starts Postgres, Redis, MinIO or Qdrant, and nothing calls a
 * provider. The suite runs in the same `check` job as the compiler, on a runner
 * with none of those, so a test that needs one would either be skipped — which
 * is a test that lies — or would make the gate depend on infrastructure the gate
 * exists to protect.
 *
 * What belongs here is the logic that is pure and currently unproven: schema
 * validation, message mapping, normalisation, pricing arithmetic.
 */
export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
})
