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
  "function shipToAqua(bytes strategy, address quoteToken, uint256 offer) returns (bytes32)",
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
      if (amount === 0n) throw new Error("Enter how much of the principal to offer.");
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
        args: [strategy, QUOTE!, amount],
        chainId: appChain.id,
      });
      await client.waitForTransactionReceipt({ hash });
      noteTx("aqua-position-opened", hash, {
        detail: `${offer} offered from this wish's own principal`,
        contract: votive,
        subject: votive,
      });
      setDone(`Position open. ${offer} of this wish's principal is now quotable.`);
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
            Closing withdraws the allowance immediately. Nothing else about the wish
            changes — the principal has been here the whole time.
          </p>
          <button className="btn" onClick={dock} disabled={busy !== ""}>
            {busy === "dock" ? "Closing…" : "Close the position"}
          </button>
        </>
      ) : (
        <>
          <p className="dim" style={{ fontSize: 13 }}>
            Offer part of this wish&rsquo;s principal as a fillable position. The
            money does not move: Aqua custodies nothing, and the program refuses
            every fill until the frontier reaches this wish and the filler is an
            agent in good standing.
          </p>
          <label className="field">
            <span>How much of the principal to offer</span>
            <input
              value={offer}
              onChange={(e) => setOffer(e.target.value)}
              placeholder="60"
              inputMode="decimal"
            />
          </label>
          <button className="btn" onClick={ship} disabled={busy !== "" || offer === ""}>
            {busy === "ship" ? "Opening…" : "Offer this wish as a position"}
          </button>
        </>
      )}

      {error ? <p className="note note-warn">{error}</p> : null}
      {done ? <p className="note">{done}</p> : null}
    </div>
  );
}
