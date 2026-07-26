import { readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Load `.env.local` the way the app does.
 *
 * Without this the suite reads whatever the invoking shell happened to export,
 * so the same command skipped six tests or nine depending on which terminal ran
 * it — and a skip prints in the same green as a pass. A suite whose coverage
 * depends on the shell is a suite that reports more confidence than it has.
 *
 * Hand-parsed rather than pulling in a dependency: this file needs `KEY=value`
 * and nothing else.
 */
for (const file of [".env.local", ".env"]) {
  let text: string;
  try {
    text = readFileSync(new URL(file, import.meta.url), "utf8");
  } catch {
    continue;
  }
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    // First file wins, and an already-exported value beats both — so a one-off
    // `FOO=bar npx playwright test` still overrides.
    if (process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

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
