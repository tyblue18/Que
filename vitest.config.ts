import { defineConfig } from 'vitest/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the "@/..." path alias the app uses so tests can import lib modules.
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': root },
  },
  test: {
    environment: 'node',
    // lib/ holds the pure-engine tests; app/api/ holds route-handler tests
    // (e.g. the food-parse grounding contract).
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
  },
});
