import { defineConfig, devices } from "@playwright/test";

/**
 * The app is driven against the real Base Sepolia deployment, not a mock.
 *
 * That makes the suite slower and makes it depend on a public endpoint, both of
 * which are real costs. They are worth paying: the thing most likely to be broken
 * on demo day is the seam between this app and the contracts, and a test that
 * stubs the chain is a test that cannot see that seam at all.
 */
export default defineConfig({
  testDir: "./e2e",
  // One at a time: several tests sending from one wallet collide on the nonce,
  // and the failure looks like a contract bug rather than a test-harness one.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.APP_URL ?? "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
