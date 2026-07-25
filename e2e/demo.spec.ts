import { expect, test } from "@playwright/test";
import { injectWallet } from "./wallet";

/**
 * The demo, driven the way it will be driven in front of judges.
 *
 * Every assertion here is about the seam between this app and the contracts —
 * that the pages read our real ABIs, that the numbers on screen are the numbers
 * on chain, and that opening a wish through the UI actually opens one. Nothing is
 * stubbed, so a green run means the demo works rather than that the mocks agree
 * with each other.
 */

const PK = process.env.DEMO_WALLET_PK as `0x${string}` | undefined;
const ADDRESS = process.env.DEMO_WALLET_ADDRESS as `0x${string}` | undefined;
const RPC = process.env.NEXT_PUBLIC_WELL_RPC_URL ?? "https://sepolia.base.org";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_WELL_CHAIN_ID ?? 84532);

test.describe("the pages a judge will be shown", () => {
  test("every route in the demo path loads", async ({ page }) => {
    for (const path of ["/", "/explore", "/create", "/live", "/board", "/frontier"]) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} did not serve`).toBeLessThan(400);
      // A Next error page returns 200, so the status alone proves nothing.
      await expect(page.locator("body")).not.toContainText("Application error", {
        timeout: 10_000,
      });
    }
  });

  test("the live page shows real positions read from the contracts", async ({ page }) => {
    await page.goto("/live");

    await expect(page.getByRole("heading", { name: /actually done/i })).toBeVisible();

    // The positions table is read straight from `factory.allVotives()`. If the
    // ABIs had drifted this would be empty or throw rather than list a state.
    const positions = page.locator("table.grid").first();
    await expect(positions).toContainText(/Waiting|Attempting|Fulfilled/);
    await expect(positions).toContainText("ETH");
  });

  test("the operator panel reflects on-chain standing, not a cached copy", async ({ page }) => {
    await page.goto("/live");
    const body = page.locator("body");

    await expect(body).toContainText("Assurance tier");
    // Standing that has moved off parity can only have come from the ledger.
    await expect(body).toContainText(/% of base/);
    await expect(body).toContainText(/Commons allowance/i);
  });

  test("explore lists wishes with the protocol's own vocabulary", async ({ page }) => {
    await page.goto("/explore");
    const table = page.locator("table").first();
    await expect(table).toBeVisible();
    // "Release on condition" is our VotiveKind[0]. The previous vocabulary called
    // index 0 something else, so this catches a positional mismatch.
    await expect(page.locator("body")).toContainText(
      /Release on condition|Real-world task|Share with everyone/,
    );
  });
});

test.describe("with a wallet connected", () => {
  test.skip(!PK || !ADDRESS, "needs DEMO_WALLET_PK and DEMO_WALLET_ADDRESS");

  test.beforeEach(async ({ page }) => {
    await injectWallet(page, {
      privateKey: PK as `0x${string}`,
      address: ADDRESS as `0x${string}`,
      rpcUrl: RPC,
      chainId: CHAIN_ID,
    });
  });

  /**
   * There is no Connect button to click, and that is the pass condition.
   *
   * wagmi's injected connector reconnects to an already-authorised provider on
   * load, so a wallet the browser exposes is picked up without a click — the
   * header renders the account instead of the prompt. The first version of this
   * test waited for a Connect button and failed for the one reason that meant it
   * was working.
   */
  test("the app picks up the injected wallet without a click", async ({ page }) => {
    await page.goto("/create");

    const shown = `${(ADDRESS as string).slice(0, 6)}`;
    await expect(page.locator("body")).toContainText(new RegExp(shown, "i"), {
      timeout: 30_000,
    });

    // And the app agrees with the wallet about who is connected.
    const account = await page.evaluate(async () => {
      const eth = (window as unknown as { ethereum: { request: (a: unknown) => Promise<string[]> } })
        .ethereum;
      return (await eth.request({ method: "eth_accounts" }))[0];
    });
    expect(account?.toLowerCase()).toBe((ADDRESS as string).toLowerCase());
  });

  test("the wallet can read the chain the app is pointed at", async ({ page }) => {
    await page.goto("/live");

    const chainId = await page.evaluate(async () => {
      const eth = (window as unknown as { ethereum: { request: (a: unknown) => Promise<string> } })
        .ethereum;
      return eth.request({ method: "eth_chainId" });
    });
    expect(Number(chainId)).toBe(CHAIN_ID);

    // A balance the wallet can actually see means the RPC path works end to end.
    const balance = await page.evaluate(async (addr) => {
      const eth = (window as unknown as { ethereum: { request: (a: unknown) => Promise<string> } })
        .ethereum;
      return eth.request({ method: "eth_getBalance", params: [addr, "latest"] });
    }, ADDRESS as string);
    expect(BigInt(balance)).toBeGreaterThan(0n);
  });

  test("a wish page loads its own state for the connected wallet", async ({ page }) => {
    await page.goto("/explore");

    const firstWish = page.locator('a[href^="/wish/0x"]').first();
    await expect(firstWish).toBeVisible();
    await firstWish.click();

    await expect(page).toHaveURL(/\/wish\/0x[0-9a-fA-F]{40}/);
    // These four come from four different view functions on the votive; all of
    // them appearing means the whole cell ABI resolved.
    const body = page.locator("body");
    await expect(body).toContainText(/principal/i);
    await expect(body).toContainText(/parked/i);
    await expect(body).toContainText(/Waiting|Attempting|Fulfilled|Redirected|Escheated/);
  });
});

test.describe("the Aqua position", () => {
  test("is read from Base Sepolia, not written up from a script run", async ({ page }) => {
    await page.goto("/live");

    const heading = page.getByRole("heading", { name: /1inch Aqua/i });
    await expect(heading).toBeVisible();
    // Deployed, not local: the section says which chain it is on, and that claim
    // is the one most worth holding to.
    await expect(heading).toContainText(/Base Sepolia/i);

    const body = page.locator("body");
    // Seven instructions appended to the official set — read from the router, so
    // this fails if the opcode table ever shifted underneath us. It did shift once,
    // when the filler gates and the standing bonus were added, and this caught it.
    await expect(body).toContainText(/7 SwapVM instructions appended/i);
    await expect(body).toContainText(/index 33/);

    // The fee threshold is the votive's own principal, read from the votive.
    await expect(body).toContainText(/Fee threshold/i);
    await expect(body).toContainText(/own principal/i);
  });

  test("reports the gates the VM would actually check", async ({ page }) => {
    await page.goto("/live");
    const body = page.locator("body");

    await expect(body).toContainText(/Capability demonstrated by some model/i);
    await expect(body).toContainText(/This wish attested true/i);
    // Whatever the answer, the page must commit to one rather than hedge.
    await expect(body).toContainText(/Fillable/i);
  });
});

test("the Aqua vault balance is shown on the wish itself, not only on /live", async ({ page }) => {
  const votive = process.env.NEXT_PUBLIC_AQUA_VOTIVE;
  test.skip(!votive, "needs a shipped position");

  await page.goto(`/wish/${votive}`);
  const body = page.locator("body");

  await expect(page.getByRole("heading", { name: /1inch Aqua/i })).toBeVisible();
  // The custodied position — read from Aqua, and previously fetched and dropped
  // on the floor rather than rendered.
  await expect(body).toContainText(/Inventory committed to this strategy/i);
  await expect(body).toContainText(/safeBalances/);
  await expect(body).toContainText(/VDA/);
  await expect(body).toContainText(/VDB/);
});

/**
 * The founder's own controls, driven end to end against Base Sepolia.
 *
 * These send real transactions from the founder's wallet, so they run last and
 * one at a time. What they prove is the thing a script cannot: that a founder can
 * open and close their wish's position from the page, without a terminal.
 */
test.describe("a founder managing their wish's position", () => {
  const FOUNDER_PK = process.env.BASE_SEPOLIA_PK as `0x${string}` | undefined;
  const FOUNDER = process.env.BASE_SEPOLIA_ADDRESS as `0x${string}` | undefined;
  const VOTIVE = process.env.NEXT_PUBLIC_AQUA_VOTIVE;

  test.skip(!FOUNDER_PK || !FOUNDER || !VOTIVE, "needs the founder wallet and a votive");

  test.beforeEach(async ({ page }) => {
    await injectWallet(page, {
      privateKey: FOUNDER_PK as `0x${string}`,
      address: FOUNDER as `0x${string}`,
      rpcUrl: RPC,
      chainId: CHAIN_ID,
    });
  });

  test("the founder sees controls that nobody else does", async ({ page }) => {
    await page.goto(`/wish/${VOTIVE}`);

    // One of the two must be offered: closing if a position is open, opening if
    // not. Which one depends on chain state, and asserting either specifically
    // would make this test depend on the order the suite happens to run in.
    const control = page.getByRole("button", {
      name: /Close the position|Offer this wish as a position/i,
    });
    await expect(control).toBeVisible({ timeout: 30_000 });
  });

  test("closing and reopening the position both work from the page", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/wish/${VOTIVE}`);

    const close = page.getByRole("button", { name: /Close the position/i });
    if (await close.isVisible().catch(() => false)) {
      await close.click();
      await expect(page.locator("body")).toContainText(/allowance .* back to zero/i, {
        timeout: 180_000,
      });
    }

    await page.reload();
    const offerField = page.getByPlaceholder("60");
    await expect(offerField).toBeVisible({ timeout: 30_000 });
    await offerField.fill("40");
    await page.getByPlaceholder("120").fill("80");

    await page.getByRole("button", { name: /Offer this wish as a position/i }).click();
    // The encoding guard runs before anything is sent, so a failure here would
    // say so rather than silently shipping a position nobody could fill.
    await expect(page.locator("body")).toContainText(/now quotable/i, { timeout: 180_000 });
  });
});
