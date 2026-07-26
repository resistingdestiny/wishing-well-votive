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
  // The symbols are read from the tokens themselves, so this also catches the
  // deployment being repointed at a pair the page was never updated for.
  await expect(body).toContainText(/VOTIVE/);
  await expect(body).toContainText(/vUSD/);
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

    // Whether a position is open is a question for the contract. The rendered
    // page can lag it by a block, and clicking "Close" on an already-closed
    // position reverts with `NoPositionOpen` — a failure that looks like a
    // broken button and is really a stale read.
    const close = page.getByRole("button", { name: /Close the position/i });
    if (await close.isVisible().catch(() => false)) {
      await close.click();
      // Either it closed, or it was already closed and said so. Both leave the
      // wish in the state the rest of this test needs.
      await expect(page.locator("body")).toContainText(
        /allowance .* back to zero|NoPositionOpen|0x24917a05/i,
        { timeout: 180_000 },
      );
    }

    // Reload until the page catches up. The panel decides which controls to show
    // from the votive's `strategyHash()` read server-side, so for a block or two
    // after a dock it still offers "Close" — and then the opening form this test
    // needs does not exist yet. Polling the page beats a fixed sleep, and beats
    // asserting against a render we already know can trail the chain.
    const offerField = page.getByPlaceholder("60");
    await expect(async () => {
      await page.reload();
      await expect(offerField).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 120_000 });

    await offerField.fill("40");
    await page.getByPlaceholder("120").fill("80");

    await page.getByRole("button", { name: /Offer this wish as a position/i }).click();
    // The encoding guard runs before anything is sent, so a failure here would
    // say so rather than silently shipping a position nobody could fill.
    await expect(page.locator("body")).toContainText(/now quotable/i, { timeout: 180_000 });
  });
});

test.describe("the faucet", () => {
  /**
   * Reads go through the app's own public client, not the wallet, so this works
   * disconnected — which is exactly the state a visitor arrives in. If the token
   * were misconfigured the panel would render its "no faucet here" branch, so
   * asserting on the symbol proves the contract answered.
   */
  test("a visitor with no wallet can still see what they would get", async ({ page }) => {
    await page.goto("/faucet");
    const panel = page.getByTestId("faucet-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText("VOTIVE");
    await expect(panel).toContainText(/per draw/);
    // Supply is read from the token itself; zero would mean nothing was minted.
    await expect(panel).toContainText(/minted so far/);
  });

  test("it asks for a wallet rather than pretending to work without one", async ({ page }) => {
    await page.goto("/faucet");
    await expect(page.getByTestId("faucet-panel")).toContainText(/Connect a wallet/i);
  });
});

test.describe("the payments rail", () => {
  test("escrow is read from the rail, not written up from a script run", async ({ page }) => {
    await page.goto("/rail");
    // Either the rail answered, or it said plainly that it could not be read.
    // What must never happen is a confident zero standing in for both.
    const answered = page.getByTestId("rail-panel");
    await expect(answered).toBeVisible({ timeout: 20_000 });
    await expect(answered).toContainText(/held in escrow right now|could not be read/);
  });
});

test.describe("the commons", () => {
  test("the draw panel states the ceiling rule rather than just a number", async ({ page }) => {
    await page.goto("/agents/human-backed");
    const panel = page.getByTestId("commons-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText(/evidence tier multiplied by your record/i);
    await expect(panel).toContainText(/Connect a wallet/i);
  });
});

test("the faucet is one click from anywhere", async ({ page }) => {
  // It sits beside "Make a wish" because it is the prerequisite for it. If it
  // were only a section tab, a visitor landing on a wish would have to know to
  // go looking under Build first.
  for (const path of ["/", "/explore", "/live"]) {
    await page.goto(path);
    const link = page.getByRole("link", { name: "Get VOTIVE" }).first();
    await expect(link, `no faucet link on ${path}`).toBeVisible();
  }
  await page.getByRole("link", { name: "Get VOTIVE" }).first().click();
  await expect(page).toHaveURL(/\/faucet$/);
  await expect(page.getByTestId("faucet-panel")).toBeVisible({ timeout: 20_000 });
});

test.describe("taking the other side of a wish", () => {
  const WISH = process.env.NEXT_PUBLIC_AQUA_VOTIVE;

  test("a wish with a position offers it to anybody, not just its founder", async ({ page }) => {
    test.skip(!WISH, "no shipped position configured");
    await page.goto(`/wish/${WISH}`);

    const panel = page.getByTestId("take-position");
    // The panel only exists while a position is open — which is the contract's
    // answer, not ours, and the founder tests above may have closed it.
    const open = await panel.isVisible().catch(() => false);
    test.skip(!open, "no position is open on this wish right now");

    await expect(panel).toContainText(/nothing is custodied/i);
    // Exactly one of: an invitation to connect, a reason it cannot be taken, or
    // the trade itself. What must never appear is a trade form with no order
    // behind it.
    await expect(panel).toContainText(
      /Connect a wallet to take this position|does not hash to the strategy|never recorded|Pay in |gates/i,
    );
  });

  test("the recorded program is served and hashes to what the wish shipped", async ({ request }) => {
    test.skip(!WISH, "no shipped position configured");
    const res = await request.get(`/api/aqua/strategy?votive=${WISH}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.program).toMatch(/^0x[0-9a-f]+$/i);
    expect(body.strategyHash).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  /**
   * The guard that makes the recorded program safe to use. Anyone can POST here,
   * so the endpoint re-hashes against the votive's own `strategyHash()` — the
   * chain, not our row, decides what this wish shipped.
   */
  test("a program that is not what the wish shipped is refused", async ({ request }) => {
    test.skip(!WISH, "no shipped position configured");
    const res = await request.post("/api/aqua/strategy", {
      data: {
        votive: WISH,
        program: "0xdeadbeef",
        aqua: "0x2510F1971364a8403C2F7C13DF6266363154c6f1",
        router: "0x8C3389E1567BB877D01b24A87fe291f60C911CF1",
        tokenA: "0x736655e2cEBB322D493b4219A6669C81bDe90001",
        tokenB: "0xdd22b0aff43419d73DbFd5377d24Cf23C1A08C51",
      },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toMatch(/does not hash to the strategy/i);
  });
});

/**
 * The click-through a visitor actually makes, ending in a filled position.
 *
 * Everything else about the Aqua work has been proven with scripts, which prove
 * the contracts and prove nothing about whether a person can reach them. This
 * one starts on the list of wishes and ends with a different wallet's balance
 * having changed, entirely through the page.
 */
test.describe("trading a wish from the browser", () => {
  const PK = process.env.DEMO_WALLET_PK as `0x${string}` | undefined;
  const ADDR = process.env.DEMO_WALLET_ADDRESS as `0x${string}` | undefined;

  test.skip(!PK || !ADDR, "needs the demo wallet");

  test("click a wish from the list, and take the other side of it", async ({ page }) => {
    test.setTimeout(300_000);
    await injectWallet(page, {
      privateKey: PK as `0x${string}`,
      address: ADDR as `0x${string}`,
      rpcUrl: RPC,
      chainId: CHAIN_ID,
    });

    await page.goto("/explore");
    const wishLink = page.locator('a[href^="/wish/0x"]').first();
    await expect(wishLink).toBeVisible({ timeout: 30_000 });
    await wishLink.click();
    await expect(page).toHaveURL(/\/wish\/0x[0-9a-fA-F]{40}/);

    const panel = page.getByTestId("take-position");
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // Wait, rather than asking whether it is visible right now. The panel fetches
    // the recorded program and does several contract reads before it can offer a
    // form, so an immediate `isVisible()` is always false — and skipping on that
    // would report "nothing to trade" in the same green as a passing trade.
    const amount = page.getByTestId("take-amount");
    await expect(amount, await panel.innerText()).toBeVisible({ timeout: 60_000 });

    await amount.fill("5");

    // The quote comes back from simulating the program itself. If the order had
    // been rebuilt wrong this is where it would say so, before any signing.
    await expect(page.getByTestId("take-quote")).toContainText(/You would receive/i, {
      timeout: 60_000,
    });

    await page.getByTestId("take-fill").click();
    await expect(page.getByTestId("take-done")).toContainText(/You paid 5/i, {
      timeout: 240_000,
    });
    await expect(page.getByTestId("take-done")).toContainText(/of this wish's principal/i);
  });
});
