// vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use a simulated DOM environment
    environment: 'jsdom',
  },
});

  