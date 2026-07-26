"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { formatEther, isAddress, parseAbi, parseEther, type Address } from "viem";
import { appChain } from "@/lib/wagmi";
import { ChainGuard } from "@/app/ui/ChainGuard";
import { Field } from "@/app/ui/Field";
import { noteTx } from "@/lib/noteTx";
import { walletError } from "@/lib/walletError";

const commonsAbi = parseAbi([
  "function draw(uint256 amount, address payee) returns (bytes32)",
  "function ceilingOf(address wallet) view returns (uint256)",
  "function remainingOf(address wallet) view returns (uint256)",
  "function quote(address wallet, uint256 amount, address payee) view returns (bool allowed, uint8 reason, uint256 ceiling, uint256 remaining)",
]);

const backingAbi = parseAbi([
  "function humanOf(address wallet) view returns (bytes32)",
  "function assuranceOf(address wallet) view returns (uint8)",
]);

const standingAbi = parseAbi([
  "function multiplierBpsOf(bytes32 humanId) view returns (uint256)",
  "function isBarred(bytes32 humanId) view returns (bool)",
]);

const asAddress = (v: string | undefined): Address | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;

const COMMONS = asAddress(process.env.NEXT_PUBLIC_WELL_COMMONS_POOL);
const HUMANS = asAddress(process.env.NEXT_PUBLIC_WELL_HUMAN_REGISTRY);
const STANDING = asAddress(process.env.NEXT_PUBLIC_WELL_STANDING_LEDGER);

/**
 * The contract's own refusal reasons, in the contract's own order.
 *
 * Worth spelling out rather than surfacing a bare revert: every one of these is
 * a different thing the operator has to go and do, and "reverted" tells them
 * none of it.
 */
const REFUSALS = [
  "",
  "This wallet has no live human backing it. Bind it to a verified human first.",
  "The human behind this wallet is barred for conduct. Drawing is closed to them.",
  "The evidence backing this wallet is weaker than this deployment accepts.",
  "Past the step-up threshold. Draws this large need the strongest evidence (Orb).",
  "This human's allowance for the current epoch is used up. It refills next epoch.",
  "The pool itself is short of funds right now.",
  "Zero, or a payee that cannot be paid.",
];

interface Standing {
  humanId: `0x${string}`;
  assurance: number;
  multiplierBps: bigint;
  barred: boolean;
  ceiling: bigint;
  remaining: bigint;
}

/**
 * Drawing shared capital, and the thing that decides how much.
 *
 * This is where the two halves meet. Human backing (World) says an agent is a
 * real person's, and only once. Standing says what that person's record is
 * worth. The ceiling is the product: better evidence and a better record buy a
 * larger claim on the commons, and a barred human's multiplier is zero, which
 * closes the tap without a special case for it.
 *
 * `payee` is separate from the caller on purpose — an agent settles its supplier
 * directly rather than routing the money through its own balance first.
 */
export function CommonsDrawPanel() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [state, setState] = useState<Standing | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [amount, setAmount] = useState("");
  const [payee, setPayee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    if (!client || !address || !COMMONS || !HUMANS || !STANDING) return;
    try {
      const [humanId, assurance, ceiling, remaining] = await Promise.all([
        client.readContract({ address: HUMANS, abi: backingAbi, functionName: "humanOf", args: [address] }),
        client.readContract({ address: HUMANS, abi: backingAbi, functionName: "assuranceOf", args: [address] }),
        client.readContract({ address: COMMONS, abi: commonsAbi, functionName: "ceilingOf", args: [address] }),
        client.readContract({ address: COMMONS, abi: commonsAbi, functionName: "remainingOf", args: [address] }),
      ]);
      const unbacked = (humanId as string) === `0x${"0".repeat(64)}`;
      const [multiplierBps, barred] = unbacked
        ? [0n, false]
        : await Promise.all([
            client.readContract({ address: STANDING, abi: standingAbi, functionName: "multiplierBpsOf", args: [humanId] }),
            client.readContract({ address: STANDING, abi: standingAbi, functionName: "isBarred", args: [humanId] }),
          ]);
      setState({
        humanId: humanId as `0x${string}`,
        assurance: Number(assurance),
        multiplierBps: multiplierBps as bigint,
        barred: barred as boolean,
        ceiling: ceiling as bigint,
        remaining: remaining as bigint,
      });
      setDegraded(false);
    } catch {
      // Rendering zeros here would read as "you may draw nothing", which is a
      // statement about the operator rather than about the node.
      setDegraded(true);
    }
  }, [client, address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function draw() {
    setError("");
    setNote("");
    setBusy(true);
    try {
      if (!client || !address || !COMMONS) throw new Error("No commons deployed here.");
      const amt = parseEther(amount || "0");
      if (amt <= 0n) throw new Error("Enter an amount to draw.");
      const to = (payee.trim() || address) as Address;
      if (!isAddress(to)) throw new Error("That payee is not an address.");

      // Ask before sending. `draw` runs exactly this quote, so a refusal here is
      // the refusal that would happen — with a reason attached instead of a
      // failed transaction the operator has to go and decode.
      const [allowed, reason] = (await client.readContract({
        address: COMMONS,
        abi: commonsAbi,
        functionName: "quote",
        args: [address, amt, to],
      })) as [boolean, number, bigint, bigint];
      if (!allowed) throw new Error(REFUSALS[reason] ?? "The commons refused this draw.");

      const hash = await writeContractAsync({
        address: COMMONS,
        abi: commonsAbi,
        functionName: "draw",
        args: [amt, to],
        chainId: appChain.id,
      });
      await client.waitForTransactionReceipt({ hash });
      noteTx("commons-drawn", hash, {
        detail: `${amount} drawn to ${to}`,
        contract: COMMONS,
        subject: address,
      });
      setNote(`Drawn. ${amount} went to ${to === address ? "your wallet" : to}.`);
      setAmount("");
      await refresh();
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!COMMONS || !HUMANS || !STANDING) return null;

  const unbacked = state !== null && state.humanId === `0x${"0".repeat(64)}`;

  return (
    <div className="panel stack hoverable" data-testid="commons-panel">
      <div>
        <h3 style={{ margin: 0 }}>Draw from the commons</h3>
        <p className="muted" style={{ margin: "0.3rem 0 0" }}>
          Shared capital an agent spends to do the job — inference, data, whatever
          the work costs. What you may draw is your evidence tier multiplied by
          your record, so a better track record is worth more than an assertion
          about it.
        </p>
      </div>

      {!isConnected ? (
        <p className="muted" style={{ margin: 0 }}>Connect a wallet to see your ceiling.</p>
      ) : degraded ? (
        <p className="error" style={{ margin: 0 }} data-testid="commons-degraded">
          The commons could not be read just now, so nothing below would be true.
        </p>
      ) : state === null ? (
        <p className="muted" style={{ margin: 0 }}>Reading your standing…</p>
      ) : (
        <>
          <div className="row" style={{ gap: "1.5rem" }}>
            <div>
              <div className="stat value" style={{ fontSize: "1.4rem" }} data-testid="commons-ceiling">
                {Number(formatEther(state.ceiling)).toFixed(4)}
              </div>
              <div className="label muted">your ceiling this epoch</div>
            </div>
            <div>
              <div className="stat value" style={{ fontSize: "1.4rem" }} data-testid="commons-remaining">
                {Number(formatEther(state.remaining)).toFixed(4)}
              </div>
              <div className="label muted">left of it</div>
            </div>
            <div>
              <div className="stat value" style={{ fontSize: "1.4rem" }} data-testid="commons-multiplier">
                {(Number(state.multiplierBps) / 10_000).toFixed(2)}×
              </div>
              <div className="label muted">standing multiplier</div>
            </div>
          </div>

          {unbacked ? (
            <p className="muted" style={{ margin: 0 }} data-testid="commons-unbacked">
              This wallet has no human behind it, so its ceiling is zero. Bind it to
              a verified human and the ceiling follows.
            </p>
          ) : state.barred ? (
            <p className="error" style={{ margin: 0 }} data-testid="commons-barred">
              The human behind this wallet is barred for conduct. The multiplier is
              zero, so the ceiling is zero — no separate switch had to be thrown.
            </p>
          ) : (
            <div className="fieldRow">
              <Field label="Amount to draw">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.0"
                  data-testid="commons-amount"
                />
              </Field>
              <Field label="Pay to (blank = you)" hint="Settle a supplier directly.">
                <input
                  value={payee}
                  onChange={(e) => setPayee(e.target.value)}
                  placeholder="0x…"
                  data-testid="commons-payee"
                />
              </Field>
              <ChainGuard
                chainId={appChain.id}
                chainName={appChain.name}
                action="draw from the commons"
              >
                <button onClick={draw} disabled={busy} data-testid="commons-draw-button">
                  {busy ? "Drawing…" : "Draw"}
                </button>
              </ChainGuard>
            </div>
          )}
        </>
      )}

      {error ? <p className="error" style={{ margin: 0 }} data-testid="commons-error">{error}</p> : null}
      {note ? <p className="success" style={{ margin: 0 }} data-testid="commons-done">{note}</p> : null}
    </div>
  );
}
