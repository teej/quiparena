import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "shared/**/*.test.ts"],
    // PGlite's first in-memory boot can exceed Vitest's 5s default under parallel CI load.
    testTimeout: 60_000,
  },
});
