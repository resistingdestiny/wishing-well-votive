"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { parseAbi, parseUnits, type Address, type Hex } from "viem";
import { appChain } from "@/lib/wagmi";
import {
  buildVotiveOrder,
  buildVotiveProgram,
  encodeStrategy,
} from "@/lib/aquaProgram";
import { noteTx } from "@/lib/noteTx";

const aquaVotiveAbi = parseAbi([
  "function configureAqua(address aqua, address router)",
  "function shipToAqua(bytes strategy, address quoteToken, uint256 offer, uint256 asking) returns (bytes32)",
  "function dockFromAqua()",
  "function isPositionOpen() view returns (bool)",
  "function offered() view returns (uint256)",
  "function aqua() view returns (address)",
  "function parked() view returns (uint256)",
  "function token() view returns (address)",
  "struct Intent { uint8 kind; address founder; address guardian; address beneficiary; address fallbackTo; bytes32 capabilityId; bytes32 conditionHash; bytes32 storyHash; uint256 expenseBudget; bool irrevocable; }",
  "function intent() view returns (Intent)",
  "function principal() view returns (uint256)",
]);

const routerAbi = parseAbi([
  "struct Order { address maker; uint256 traits; bytes data; }",
  "function hash(Order order) view returns (bytes32)",
]);

const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

interface Props {
  votive: Address;
  founder: Address;
  /** Set when a position is already open, so the panel offers closing instead. */
  positionOpen: boolean;
}

/**
 * Read statically, one name at a time.
 *
 * Next inlines `process.env.NEXT_PUBLIC_*` into client bundles by substituting
 * the literal text, so a dynamic `process.env[key]` is never replaced and reads
 * `undefined` in the browser — while working perfectly on the server. That
 * asymmetry is why the controls rendered in a server test and vanished in a real
 * one.
 */
const asAddress = (v: string | undefined): Address | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;

const ADDRESSES = {
  aqua: asAddress(process.env.NEXT_PUBLIC_AQUA),
  router: asAddress(process.env.NEXT_PUBLIC_AQUA_ROUTER),
  quote: asAddress(process.env.NEXT_PUBLIC_AQUA_TOKEN_B),
  registry: asAddress(process.env.NEXT_PUBLIC_WELL_REGISTRY),
  humans: asAddress(process.env.NEXT_PUBLIC_WELL_HUMAN_REGISTRY),
  standing: asAddress(process.env.NEXT_PUBLIC_WELL_STANDING_LEDGER),
};

/**
 * Opening and closing a wish's Aqua position, from the wish itself.
 *
 * Only the founder sees the controls, because only the founder can use them —
 * shipping grants an allowance over their own principal, and the contract refuses
 * anybody else.
 *
 * The program is encoded in the browser and then **checked against the deployed
 * router before anything is sent**. That guard is not decoration: the encoding is
 * bit-packed, and a subtly wrong order ships perfectly well and can then never be
 * filled. A position nobody can take looks identical to a position nobody wants,
 * which is the kind of failure that survives a demo and is discovered later.
 */
export function AquaActions({ votive, founder, positionOpen }: Props) {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();

  const [offer, setOffer] = useState("");
  const [asking, setAsking] = useState("");
  const [busy, setBusy] = useState<"" | "ship" | "dock">("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const isFounder = isConnected && address?.toLowerCase() === founder.toLowerCase();
  if (!isFounder) return null;

  const {aqua: AQUA, router: ROUTER, quote: QUOTE, registry: REGISTRY} = ADDRESSES;
  const HUMANS = ADDRESSES.humans;
  const STANDING = ADDRESSES.standing;

  if (!AQUA || !ROUTER || !QUOTE || !REGISTRY) {
    return (
      <p className="note">
        No Aqua deployment is configured for this environment, so this wish cannot
        be quoted here.
      </p>
    );
  }

  async function ship() {
    if (!client) return;
    setError("");
    setDone("");
    setBusy("ship");
    try {
      const [intent, principal, parked, token] = await Promise.all([
        client.readContract({ address: votive, abi: aquaVotiveAbi, functionName: "intent" }),
        client.readContract({ address: votive, abi: aquaVotiveAbi, functionName: "principal" }),
        client.readContract({ address: votive, abi: aquaVotiveAbi, functionName: "parked" }),
        client.readContract({ address: votive, abi: aquaVotiveAbi, functionName: "token" }),
      ]);
      const decimals = Number(
        await client.readContract({ address: token as Address, abi: erc20, functionName: "decimals" }),
      );
      const amount = parseUnits(offer || "0", decimals);
      if (amount === 0n) throw new Error("Enter how much of this wish to sell.");
      const askingAmount = parseUnits(asking || "0", decimals);
      if (askingAmount === 0n) {
        // The curve needs a reserve on both sides to quote at all. Without this a
        // position ships perfectly and can never be filled by anybody.
        throw new Error("Enter what you want for it.");
      }
      if (amount > (parked as bigint)) {
        throw new Error("That is more than this wish has parked.");
      }

      const i = intent as { capabilityId: Hex; conditionHash: Hex };
      const program = buildVotiveProgram({
        votive,
        attestations: REGISTRY!,
        capabilityId: i.capabilityId,
        conditionHash: i.conditionHash,
        principal: principal as bigint,
        performanceBps: 8e7, // 8% on SwapVM's 1e9 scale
        treasury: "0x0000000000000000000000000000000000000FEE",
        ...(HUMANS ? { humanRegistry: HUMANS, minAssurance: 1 } : {}),
        ...(HUMANS && STANDING
          ? { standingLedger: STANDING, minStandingBps: 10_000, bonusBps: 5e7 }
          : {}),
        salt: BigInt(Math.floor(Date.now() / 1000)),
      });
      const order = buildVotiveOrder(votive, program);
      const strategy = encodeStrategy(order);

      // The guard. The router hashes the order the same way Aqua will key it, so
      // if our packing is wrong these disagree and nothing is sent.
      const routerHash = (await client.readContract({
        address: ROUTER!,
        abi: routerAbi,
        functionName: "hash",
        args: [order],
      })) as Hex;
      const { keccak256 } = await import("viem");
      if (keccak256(strategy) !== routerHash) {
        throw new Error(
          "The encoded order does not match what the router computes. Refusing to " +
            "ship a position that could never be filled.",
        );
      }

      const configured = (await client.readContract({
        address: votive,
        abi: aquaVotiveAbi,
        functionName: "aqua",
      })) as Address;
      if (/^0x0{40}$/.test(configured)) {
        const cfg = await writeContractAsync({
          address: votive,
          abi: aquaVotiveAbi,
          functionName: "configureAqua",
          args: [AQUA!, ROUTER!],
          chainId: appChain.id,
        });
        await client.waitForTransactionReceipt({ hash: cfg });
      }

      const hash = await writeContractAsync({
        address: votive,
        abi: aquaVotiveAbi,
        functionName: "shipToAqua",
        args: [strategy, QUOTE!, amount, askingAmount],
        chainId: appChain.id,
      });
      await client.waitForTransactionReceipt({ hash });
      noteTx("aqua-position-opened", hash, {
        detail: `${offer} of this wish's own principal offered for sale, asking ${asking}`,
        contract: votive,
        subject: votive,
      });

      // Keep the program bytes where a stranger can find them. Aqua stores only
      // the order's hash, so without this nobody but whoever built the order can
      // reconstruct it — and a position nobody can reconstruct is a position
      // nobody can take. The endpoint re-hashes and refuses anything that is not
      // what this votive actually shipped, so the chain stays the authority.
      const recorded = await fetch("/api/aqua/strategy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          votive,
          program,
          aqua: AQUA,
          router: ROUTER,
          tokenA: token,
          tokenB: QUOTE,
          shippedTx: hash,
        }),
      }).catch(() => null);
      if (!recorded?.ok) {
        // Said out loud rather than swallowed. The position is open either way —
        // that part is on chain — but only the founder could fill it, and a
        // position nobody can take looks exactly like one nobody wants.
        setError(
          "The position is open, but its program could not be recorded, so nobody " +
            "else can reconstruct the order to fill it. Close and reopen it, or " +
            "the fill has to be run from a script.",
        );
      }
      setDone(
        `On the market. ${offer} of this wish can now be bought, at a price that ` +
          `moves with the odds of it coming true.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function dock() {
    if (!client) return;
    setError("");
    setDone("");
    setBusy("dock");
    try {
      const hash = await writeContractAsync({
        address: votive,
        abi: aquaVotiveAbi,
        functionName: "dockFromAqua",
        args: [],
        chainId: appChain.id,
      });
      await client.waitForTransactionReceipt({ hash });
      noteTx("aqua-position-closed", hash, { contract: votive, subject: votive });
      setDone("Position closed. The allowance over this wish's principal is back to zero.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div style={{ marginTop: 14 }}>
      {positionOpen ? (
        <>
          <p className="dim" style={{ fontSize: 13 }}>
            Part of this wish is on the market. Closing takes it off immediately,
            so no more of it can be bought. Nothing else about the wish changes —
            everything has been here the whole time.
          </p>
          <button className="btn" onClick={dock} disabled={busy !== ""}>
            {busy === "dock" ? "Closing…" : "Close the position"}
          </button>
        </>
      ) : (
        <>
          <p className="dim" style={{ fontSize: 13 }}>
            Sell part of this wish. Whoever buys takes on that share of what the
            wish is worth and is paid out of it when it comes true, so you do not
            have to wait out a wish that may take years to get your money back.
          </p>
          <p className="dim" style={{ fontSize: 13 }}>
            You set the opening price; from there it moves with the odds, rising as
            AI closes in on what this wish is waiting for and falling as it looks
            further off. The wish holds everything until the moment of a trade, so
            nothing is custodied, and only a human-backed agent in good standing
            can buy.
          </p>
          <label className="field">
            <span>How much of this wish to sell</span>
            <input
              value={offer}
              onChange={(e) => setOffer(e.target.value)}
              placeholder="60"
              inputMode="decimal"
            />
          </label>
          <label className="field">
            <span>What you want for that share</span>
            <input
              value={asking}
              onChange={(e) => setAsking(e.target.value)}
              placeholder="120"
              inputMode="decimal"
            />
            <small className="dim">
              The two figures together are the price: 60 offered against 120 asked
              quotes about two of the quote token per unit of principal, and less
              than that on a large fill as the curve moves. You never pay the quote
              token yourself — a buyer pays it — but the curve cannot quote at all
              without a figure here.
            </small>
          </label>
          <button
            className="btn"
            onClick={ship}
            disabled={busy !== "" || offer === "" || asking === ""}
          >
            {busy === "ship" ? "Listing…" : "Put this share on the market"}
          </button>
        </>
      )}

      {error ? <p className="note note-warn">{error}</p> : null}
      {done ? <p className="note">{done}</p> : null}
    </div>
  );
}
