import { defineConfig } from "@playwright/test";

const port = Number(process.env.MOKA_E2E_PORT ?? 8971);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // A channel is configured against the stand-in provider's address, so it has
  // to be listening before the first page opens, and is stopped after the last.
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 30_000,
  // The server tracks a single current project, so browser tests share one
  // server and must not interleave.
  workers: 1,
  fullyParallel: false,
  use: { baseURL },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: `${baseURL}/api/health`,
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
