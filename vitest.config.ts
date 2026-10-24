import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // End-to-end tests in test/e2e/ spawn real subprocesses for JSON-RPC and CLI
    // round-trips. On Windows a cold-start Node process + MCP handshake can
    // exceed the 5s default, so give every test a generous ceiling; unit tests
    // finish in milliseconds either way.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // Coverage is measured over shipped runtime code. src/types.ts holds only
      // contracts and the strategy vocabulary, so it stays at 100% on its own;
      // scripts/ (live-network CLI) and test/ never appear here because
      // `include` is limited to src/**. The glob stops at .ts on purpose: the
      // v8 provider reports every file `include` matches, and the Markdown
      // docs sitting next to the sources would enter the report as
      // uncovered files instead of being left out.
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 95, functions: 95, branches: 95, statements: 95,
      },
    },
  },
});
