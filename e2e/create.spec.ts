import { expect, test } from "@playwright/test";
import { injectWallet } from "./wallet";

/**
 * The one claim the whole product rests on: a person can make a wish.
 *
 * Everything else in the suite reads pages that somebody's script already
 * populated. This writes — it walks /create the way a visitor does, sends the two
 * real transactions to Base Sepolia, and then goes looking for the wish on every
 * surface that promises to show it. A green run here means a stranger with a
 * wallet can use this; nothing else in the suite says that.
 */

const PK = process.env.DEMO_WALLET_PK as `0x${string}` | undefined;
const ADDRESS = process.env.DEMO_WALLET_ADDRESS as `0x${string}` | undefined;
const RPC = process.env.NEXT_PUBLIC_WELL_RPC_URL ?? "https://sepolia.base.org";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_WELL_CHAIN_ID ?? 84532);
const TOKEN = process.env.NEXT_PUBLIC_VOTIVE_TOKEN as `0x${string}` | undefined;

const FUND_AMOUNT = "1";

/**
 * A marker that makes this run's wish findable.
 *
 * The prose is hashed on chain as `storyHash`, and `/api/register-wish` refuses a
 * cell whose hash does not match what it was handed. Reusing prose across runs
 * would still pass, but a stamp means the row this run created can be told apart
 * from the row the last run created — which is the difference between proving a
 * wish appeared and proving *a* wish appeared once, long ago.
 */
const STAMP = `e2e-${Date.now()}`;

/** Shared between the tests below, which is why they run serially. */
let created = "";
let openTxHash = "";

test.describe.serial("making a wish and finding it again", () => {
  test.skip(!PK || !ADDRESS || !TOKEN, "needs the demo wallet and a funding token");

  test.beforeEach(async ({ page }) => {
    await injectWallet(page, {
      privateKey: PK as `0x${string}`,
      address: ADDRESS as `0x${string}`,
      rpcUrl: RPC,
      chainId: CHAIN_ID,
    });
  });

  test("a visitor walks /create end to end and lands on the wish they made", async ({ page }) => {
    // Two on-chain sends (approve, then open) against a public testnet RPC, plus
    // a receipt wait on each. The default 180s is not enough on a slow block.
    test.setTimeout(420_000);

    // The app never surfaces the opening tx hash, so the only place it can be
    // read from the browser is the fire-and-forget record it posts to /api/tx.
    // Without this the test could prove a wish exists and still not say which
    // transaction made it.
    page.on("request", (req) => {
      if (!req.url().endsWith("/api/tx") || req.method() !== "POST") return;
      const body = JSON.parse(req.postData() ?? "{}");
      if (body.kind === "wish-opened") openTxHash = body.txHash;
    });

    // Anything the page logs that looks like a failure is worth having in the
    // report, because this flow swallows several classes of error into a state
    // change rather than a message.
    page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[console.error] ${m.text()}`);
    });

    await page.goto("/create");

    // The wallet has to be picked up before anything else matters: the fund
    // button is disabled while disconnected, and a test that filled the form
    // first would fail three steps later for a reason it could have caught here.
    await expect(page.locator("body")).toContainText(new RegExp(ADDRESS as string, "i"), {
      timeout: 30_000,
    });

    // Step 0 — the story. Start from a starter card, because that is the path
    // the page pushes a first-time visitor down.
    const starter = page.getByTestId("starter-gallery").getByRole("button").nth(3);
    await starter.click();
    const story = page.getByTestId("story-input");
    await expect(story).not.toHaveValue("");
    // Prefixed, not appended: /explore truncates the prose it shows to 80
    // characters, so a marker at the end is invisible on the page that has to
    // prove it stored the right story.
    await story.fill(`Reference ${STAMP}. ${await story.inputValue()}`);

    await page.getByTestId("parse-button").click();

    // The schema panel is the gate to everything after it. If the LLM route were
    // down this is where the flow stops, and the page stays on step 0 with an
    // error rather than moving.
    await expect(page.getByTestId("schema-preview")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("p.error")).toHaveCount(0);

    await page.getByTestId("to-funding-button").click();

    // Step 2 — funding. ERC-20 rather than ETH, because the token path is the one
    // with an approval in it, and an approval is the step most likely to be
    // half-wired: it succeeds on chain and then the open reverts on allowance.
    await page.getByTestId("fund-asset").selectOption(TOKEN as string);
    await page.getByTestId("fund-eth-amount").fill(FUND_AMOUNT);

    const fund = page.getByRole("button", { name: /fund wish/i });
    await expect(fund).toBeEnabled();
    await fund.click();

    // Two sends and two receipts, and then the thing this test exists for: a
    // confirmed transaction must take the founder off the form. Leaving them on
    // /create is indistinguishable, from the outside, from the button doing
    // nothing — which is exactly how it was reported.
    //
    // The URL is checked before the error panel, not after: once the route has
    // changed, `p.error` belongs to a different page and reading it would
    // report a failure for the run that worked.
    const failed = page.locator("p.error");
    await expect(async () => {
      if (/\/wish\/0x[0-9a-fA-F]{40}/.test(page.url())) return;
      const errored = await failed.first().isVisible().catch(() => false);
      if (errored) throw new Error(`create failed: ${await failed.first().innerText()}`);
      throw new Error(`still on ${page.url()} after funding`);
    }).toPass({ timeout: 360_000, intervals: [1_000] });

    created = new URL(page.url()).pathname.split("/").pop() as string;
    expect(created).toMatch(/^0x[0-9a-fA-F]{40}$/);
    console.log(`[created] wish=${created} tx=${openTxHash || "(not recorded)"}`);

    // And it is the right wish, not merely some wish page. Principal, symbol and
    // state come from three separate reads on the cell, so all three agreeing
    // with what was typed into the form is what rules out landing on a stale
    // address decoded from the wrong log.
    const body = page.locator("body");
    await expect(body).toContainText(new RegExp(`${FUND_AMOUNT}(\\.0+)?\\s*VOTIVE`, "i"), {
      timeout: 30_000,
    });
    await expect(body).toContainText(/Waiting|Attempting/);
  });

  test("it is listed on /explore, with the story that was typed into the form", async ({ page }) => {
    test.skip(!created, "nothing was created");
    await page.goto("/explore");

    // Reloaded rather than waited on, and that is a finding rather than a
    // convenience: /explore is rendered once per request from a public RPC that
    // can answer from a replica a block or two behind. A founder who lands here
    // seconds after opening a wish can be shown a list without it, and the page
    // has nothing that would ever correct itself. The elapsed time is logged so
    // the size of that window is a number rather than an impression.
    //
    // Case-insensitive because `allVotives()` answers checksummed while parts of
    // the app carry a lowercased address; pinning one casing would fail a page
    // that is working.
    const started = Date.now();
    const row = page.locator(`a[href="/wish/${created}" i]`);
    await expect(async () => {
      await page.reload();
      await expect(row).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000, intervals: [2_000] });
    console.log(`[explore] wish appeared after ${Math.round((Date.now() - started) / 1000)}s`);

    // The stamp is the other half: the link alone only proves the chain read,
    // while the prose can only be there if /api/register-wish accepted the wish
    // and the list joined our row to the cell.
    await expect(page.getByTestId("cells-table")).toContainText(STAMP);
  });

  test("it is listed on /live", async ({ page }) => {
    test.skip(!created, "nothing was created");
    await page.goto("/live");
    const row = page.locator(`a[href="/wish/${created}" i]`);
    await expect(async () => {
      await page.reload();
      await expect(row).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000, intervals: [2_000] });
  });
});
