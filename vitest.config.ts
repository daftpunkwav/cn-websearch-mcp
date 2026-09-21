import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // End-to-end tests in test/e2e/ spawn real subprocesses for JSON-RPC and CLI
    // round-trips. On Windows a cold-start Node process + MCP handshake can
    // exceed the 5s default, so give every test a generous ceiling; unit tests
    // finish in milliseconds either way.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      // Coverage is measured over shipped runtime code. src/types.ts is a
      // type-only module and scripts/ is a live-network CLI, so both are
      // excluded from the metric.
      include: ["src/**"],
      exclude: ["src/types.ts"],
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
