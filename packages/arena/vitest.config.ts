import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite startup is CPU-heavy; parallel database files can exceed Vitest's
    // default per-test timeout even though each suite is fast in isolation.
    fileParallelism: false,
  },
});

