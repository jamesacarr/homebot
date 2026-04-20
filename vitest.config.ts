import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    // Allow the scaffold phase to pass; each implementation step after this
    // must ship real tests (see AGENTS.md).
    passWithNoTests: true,
    reporters: ['default'],
  },
});
