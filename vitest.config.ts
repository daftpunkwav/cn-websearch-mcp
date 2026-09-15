import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
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
