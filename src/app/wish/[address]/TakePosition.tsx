"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import {
  formatUnits,
  keccak256,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { appChain } from "@/lib/wagmi";
import { buildTakerTraits, buildVotiveOrder, encodeStrategy } from "@/lib/aquaProgram";
import { noteTx } from "@/lib/noteTx";
import { Field } from "@/app/ui/Field";

const routerAbi = parseAbi([
  "struct Order { address maker; uint256 traits; bytes data; }",
  "function swap(Order order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
  "function hash(Order order) view returns (bytes32)",
]);

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const votiveAbi = parseAbi([
  "function strategyHash() view returns (bytes32)",
  "function token() view returns (address)",
  "function quoteToken() view returns (address)",
]);

interface Recorded {
  program: Hex;
  router: Address;
  tokenA: Address;
  tokenB: Address;
}

interface Loaded {
  order: { maker: Address; traits: bigint; data: Hex };
  router: Address;
  /** What the filler pays with. */
  quote: { address: Address; symbol: string; decimals: number; balance: bigint; allowance: bigint };
  /** What the filler receives — the wish's own principal. */
  principal: { address: Address; symbol: string; decimals: number };
}

interface Props {
  votive: Address;
  /** From the wish page's own contract reads; the panel does not re-derive it. */
  positionOpen: boolean;
  fillable: boolean;
  blockerText?: string;
}

/**
 * Taking the other side of a wish.
 *
 * A wish may be waiting on a capability that arrives in a decade. The founder
 * should not have to wait it out to get their money back, and somebody who
 * thinks the frontier will move sooner should be able to say so with money. That
 * is the whole argument for a wish being a position rather than a locked box.
 *
 * What happens when you fill: you pay the quote token in, and a slice of the
 * wish's own principal comes out, priced on the curve against the reserves the
 * founder set. Nothing is custodied by us or by Aqua at any point — the wish
 * holds its principal until the instant of the fill.
 *
 * **The order is reconstructed and then checked against the chain before
 * anything is signed.** Aqua stores only the order's hash, so the program bytes
 * come from our own record; a record is not an authority, and the votive's
 * `strategyHash()` is. If they disagree the panel refuses rather than asking
 * somebody to sign an order the wish never shipped.
 */
export function TakePosition({ votive, positionOpen, fillable, blockerText }: Props) {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState("");
  const [amount, setAmount] = useState("");
  const [expected, setExpected] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(async () => {
    if (!client || !positionOpen) return;
    setProblem("");
    try {
      const res = await fetch(`/api/aqua/strategy?votive=${votive}`);
      if (!res.ok) {
        setProblem(
          "This position's program was never recorded, so its order cannot be " +
            "reconstructed here. It is still open on chain and still fillable from " +
            "a script — reopening it from this page would record it.",
        );
        return;
      }
      const rec = (await res.json()) as Recorded;
      const order = buildVotiveOrder(votive, rec.program);

      // The guard. Everything below asks somebody to spend money on the terms
      // this order encodes, so the order has to be the one the wish shipped —
      // not the one our database remembers.
      const [onChainHash, principalToken, quoteToken] = await Promise.all([
        client.readContract({ address: votive, abi: votiveAbi, functionName: "strategyHash" }),
        client.readContract({ address: votive, abi: votiveAbi, functionName: "token" }),
        client.readContract({ address: votive, abi: votiveAbi, functionName: "quoteToken" }),
      ]);
      if (keccak256(encodeStrategy(order)) !== (onChainHash as Hex)) {
        setProblem(
          "The recorded program does not hash to the strategy this wish has open. " +
            "Refusing to put an order in front of you that the wish never shipped.",
        );
        return;
      }

      const quoteAddr = quoteToken as Address;
      const principalAddr = principalToken as Address;
      const [qSymbol, qDecimals, pSymbol, pDecimals] = await Promise.all([
        client.readContract({ address: quoteAddr, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address: quoteAddr, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({ address: principalAddr, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address: principalAddr, abi: erc20Abi, functionName: "decimals" }),
      ]);
      const [balance, allowance] = address
        ? await Promise.all([
            client.readContract({ address: quoteAddr, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
            client.readContract({ address: quoteAddr, abi: erc20Abi, functionName: "allowance", args: [address, rec.router] }),
          ])
        : [0n, 0n];

      setLoaded({
        order,
        router: rec.router,
        quote: { address: quoteAddr, symbol: qSymbol as string, decimals: Number(qDecimals), balance, allowance },
        principal: { address: principalAddr, symbol: pSymbol as string, decimals: Number(pDecimals) },
      });
    } catch (e) {
      setProblem((e as Error).message.slice(0, 200));
    }
  }, [client, votive, address, positionOpen]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * What this fill would pay out, from the VM itself.
   *
   * Simulated rather than computed here. Re-implementing the curve in the
   * browser would give a number that is right until an instruction changes and
   * then quietly wrong — and the bonus instruction means the answer depends on
   * *who* is asking, which a client-side formula would have no way to know.
   */
  const requote = useCallback(async () => {
    if (!client || !loaded || !address || !amount) {
      setExpected(null);
      return;
    }
    let amt: bigint;
    try {
      amt = parseUnits(amount, loaded.quote.decimals);
    } catch {
      setExpected(null);
      return;
    }
    if (amt <= 0n) {
      setExpected(null);
      return;
    }
    setQuoting(true);
    try {
      const { result } = await client.simulateContract({
        address: loaded.router,
        abi: routerAbi,
        functionName: "swap",
        args: [loaded.order, loaded.quote.address, loaded.principal.address, amt, buildTakerTraits()],
        account: address,
      });
      setExpected((result as readonly bigint[])[1]);
    } catch {
      // A refusal here is usually one of the seven gates, and the gate text is
      // already on screen above. Showing nothing beats showing a made-up number.
      setExpected(null);
    } finally {
      setQuoting(false);
    }
  }, [client, loaded, address, amount]);

  useEffect(() => {
    const id = setTimeout(() => void requote(), 400);
    return () => clearTimeout(id);
  }, [requote]);

  async function fill() {
    setError("");
    setDone("");
    setBusy("fill");
    try {
      if (!client || !loaded || !address) throw new Error("Connect a wallet first.");
      const amt = parseUnits(amount || "0", loaded.quote.decimals);
      if (amt <= 0n) throw new Error("Enter how much to pay in.");
      if (amt > loaded.quote.balance) {
        throw new Error(`You only hold ${formatUnits(loaded.quote.balance, loaded.quote.decimals)} ${loaded.quote.symbol}.`);
      }

      // Simulate once more immediately before sending, and use the result as the
      // floor. Between the quote on screen and the transaction landing, another
      // fill can move the reserves; without a floor you would take whatever price
      // the curve had drifted to.
      const { result } = await client.simulateContract({
        address: loaded.router,
        abi: routerAbi,
        functionName: "swap",
        args: [loaded.order, loaded.quote.address, loaded.principal.address, amt, buildTakerTraits()],
        account: address,
      });
      const out = (result as readonly bigint[])[1];
      if (out === 0n) throw new Error("This fill would pay out nothing.");
      const floor = (out * 99n) / 100n; // one percent of room, then it reverts

      if (loaded.quote.allowance < amt) {
        setBusy("approve");
        const approval = await writeContractAsync({
          address: loaded.quote.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [loaded.router, amt],
          chainId: appChain.id,
        });
        await client.waitForTransactionReceipt({ hash: approval });
      }

      setBusy("fill");
      const hash = await writeContractAsync({
        address: loaded.router,
        abi: routerAbi,
        functionName: "swap",
        args: [
          loaded.order,
          loaded.quote.address,
          loaded.principal.address,
          amt,
          buildTakerTraits({ minAmountOut: floor }),
        ],
        chainId: appChain.id,
      });
      await client.waitForTransactionReceipt({ hash });
      noteTx("aqua-position-filled", hash, {
        detail: `${amount} ${loaded.quote.symbol} in, ~${formatUnits(out, loaded.principal.decimals)} ${loaded.principal.symbol} out`,
        contract: loaded.router,
        subject: votive,
      });
      setDone(
        `Filled. You paid ${amount} ${loaded.quote.symbol} and took ` +
          `${formatUnits(out, loaded.principal.decimals)} ${loaded.principal.symbol} of this wish's principal.`,
      );
      setAmount("");
      await load();
    } catch (e) {
      setError((e as Error).message.slice(0, 300));
    } finally {
      setBusy("");
    }
  }

  if (!positionOpen) return null;

  return (
    <div className="panel stack hoverable" style={{ marginTop: 14 }} data-testid="take-position">
      <div>
        <h3 style={{ margin: 0 }}>Take the other side</h3>
        <p className="muted" style={{ margin: "0.3rem 0 0" }}>
          This wish is a position, not a locked box. Pay the quote token in and a
          slice of the wish&rsquo;s own principal comes out, priced on the curve
          against the reserves its founder set. The wish holds its principal the
          entire time — nothing is custodied here or by Aqua.
        </p>
      </div>

      {problem ? (
        <p className="error" style={{ margin: 0 }} data-testid="take-problem">{problem}</p>
      ) : !fillable ? (
        <p className="muted" style={{ margin: 0 }} data-testid="take-blocked">
          {blockerText ??
            "The program refuses every fill right now — one of its gates is closed."}{" "}
          You can still see the terms above; nothing will be signed while it is shut.
        </p>
      ) : !isConnected ? (
        <p className="muted" style={{ margin: 0 }}>Connect a wallet to take this position.</p>
      ) : loaded === null ? (
        <p className="muted" style={{ margin: 0 }}>Reconstructing the order…</p>
      ) : (
        <>
          <div className="fieldRow">
            <Field
              label={`Pay in ${loaded.quote.symbol}`}
              hint={`You hold ${Number(formatUnits(loaded.quote.balance, loaded.quote.decimals)).toLocaleString("en-GB", { maximumFractionDigits: 4 })}`}
            >
              <input
                type="number"
                min="0"
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.0"
                data-testid="take-amount"
              />
            </Field>
            <button onClick={fill} disabled={busy !== "" || amount === ""} data-testid="take-fill">
              {busy === "approve"
                ? "Approving…"
                : busy === "fill"
                  ? "Filling…"
                  : "Take it"}
            </button>
          </div>

          <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }} data-testid="take-quote">
            {quoting ? (
              "Asking the VM…"
            ) : expected !== null ? (
              <>
                You would receive{" "}
                <strong>
                  {Number(formatUnits(expected, loaded.principal.decimals)).toLocaleString("en-GB", {
                    maximumFractionDigits: 4,
                  })}{" "}
                  {loaded.principal.symbol}
                </strong>
                . Quoted by running the program itself, not by a formula copied
                into the browser — the standing bonus means the answer depends on
                who is asking.
              </>
            ) : amount ? (
              "The VM would refuse this fill. Check the gates above."
            ) : (
              "Enter an amount to see what the program quotes you."
            )}
          </p>
        </>
      )}

      {error ? <p className="error" style={{ margin: 0 }} data-testid="take-error">{error}</p> : null}
      {done ? <p className="success" style={{ margin: 0 }} data-testid="take-done">{done}</p> : null}
    </div>
  );
}
