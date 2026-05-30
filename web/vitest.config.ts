import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // `@/*` path alias used across the app.
      '@': path.resolve(__dirname),
      // Neutralise `server-only` so server modules import cleanly under test.
      'server-only': path.resolve(__dirname, 'test/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Dummy values so modules that build `env` at import time don't throw.
    env: {
      MONGODB_URI: 'mongodb://localhost:27017/test',
      SESSION_SECRET: 'test-session-secret-aaaaaaaaaaaaaaaaaaaaaaaa',
      WORKER_URL: 'http://localhost:8645',
      WORKER_SHARED_SECRET: 'test-worker-secret',
      ADMIN_PATH: 'ctrl-test',
      ADMIN_ACCESS_KEY: 'test-admin-key',
      PAY_TREASURY_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    },
  },
});
