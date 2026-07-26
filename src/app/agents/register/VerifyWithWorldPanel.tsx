"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useSignMessage } from "wagmi";
import { parseAbi, type Address } from "viem";
import { appChain } from "@/lib/wagmi";
import { HumanBadge } from "@/app/agents/HumanBadge";
import { CopyBlock } from "@/app/agents/skills/CopyBlock";
import { walletError } from "@/lib/walletError";
import { shortAddr } from "@/lib/format";

const backingAbi = parseAbi([
  "function humanOf(address wallet) view returns (bytes32)",
  "function assuranceOf(address wallet) view returns (uint8)",
  "function walletCount(bytes32 humanId) view returns (uint256)",
]);

const standingAbi = parseAbi([
  "function isBarred(bytes32 humanId) view returns (bool)",
  "function multiplierBpsOf(bytes32 humanId) view returns (uint256)",
]);

const asAddress = (v: string | undefined): Address | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;

const HUMANS = asAddress(process.env.NEXT_PUBLIC_WELL_HUMAN_REGISTRY);
const STANDING = asAddress(process.env.NEXT_PUBLIC_WELL_STANDING_LEDGER);
const ZERO = `0x${"0".repeat(64)}`;

/** `AssuranceTiers.sol`: NONE 0, DEVICE 1, SELFIE 2, ORB 3. */
const TIERS = ["Unverified", "Device", "Selfie", "Orb"] as const;
const tierLabel = (n: number): string => TIERS[n] ?? `tier ${n}`;

interface OnChain {
  humanId: `0x${string}`;
  assurance: number;
  walletCount: number;
  barred: boolean;
  multiplierBps: bigint;
}

/**
 * What the registry said when it was read *after* the receipt confirmed.
 *
 * A union rather than a number, because "the attestation landed but we could not
 * then read the chain" is a real state and has to render as one. Defaulting it to
 * a tier would put a badge on screen that nothing verified.
 */
type ReadBack =
  | { read: true; assurance: number; walletsByThisHuman: number }
  | { read: false; degraded: string };

type Outcome =
  | { state: "attested"; txHash: string; explorer: string; humanId: string; assuranceWritten: number;
      readBack: ReadBack; evidenceHash: string; evidencePreimage: string }
  | { state: "already-attested"; humanId: string; assurance: number; because: string }
  | { state: "no-human"; because: string }
  | { state: "unreachable"; because: string }
  | { state: "not-configured"; because: string }
  | { state: "rebind-refused"; because: string }
  | { state: "failed"; because: string };

/**
 * Linking the agent to the human behind it, and refusing to guess when we cannot.
 *
 * Two chains meet here. AgentBook on World Chain knows a unique human registered
 * this wallet; `HumanBackingRegistry` on Base Sepolia is where the rest of the
 * protocol looks, and pressing the button mirrors the first onto the second with a
 * real transaction paid for by the protocol's attestor.
 *
 * **The badge below is read off the chain, never inferred from the button.** After
 * the receipt confirms, `assuranceOf()` is read again and that is what renders. A
 * tier drawn from "we sent a transaction that said DEVICE" would show a green
 * badge over an attestation that reverted or never landed.
 *
 * **Four outcomes, four different things on screen.** In particular `no-human` and
 * `unreachable` are never merged. AgentKit's own lookup returns `null` for both,
 * and rendering that as "no human is behind this wallet" tells a person they do
 * not exist because someone else's RPC endpoint was busy.
 */
export function VerifyWithWorldPanel({
  agentId,
  wallet,
  worldEnabled,
  attestorReady,
  attestor,
}: {
  agentId: string;
  wallet: string;
  worldEnabled: boolean;
  attestorReady: boolean;
  attestor: string | null;
}) {
  const { address, isConnected } = useAccount();
  const client = usePublicClient({ chainId: appChain.id });
  const { signMessageAsync } = useSignMessage();

  const [chain, setChain] = useState<OnChain | null>(null);
  const [degraded, setDegraded] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const refresh = useCallback(async () => {
    if (!client || !HUMANS) return;
    try {
      const [humanId, assurance] = await Promise.all([
        client.readContract({ address: HUMANS, abi: backingAbi, functionName: "humanOf", args: [wallet as Address] }),
        client.readContract({ address: HUMANS, abi: backingAbi, functionName: "assuranceOf", args: [wallet as Address] }),
      ]);
      const backed = humanId !== ZERO;
      const [walletCount, barred, multiplierBps] = backed
        ? await Promise.all([
            client.readContract({ address: HUMANS, abi: backingAbi, functionName: "walletCount", args: [humanId] }),
            STANDING
              ? client.readContract({ address: STANDING, abi: standingAbi, functionName: "isBarred", args: [humanId] })
              : Promise.resolve(false),
            STANDING
              ? client.readContract({ address: STANDING, abi: standingAbi, functionName: "multiplierBpsOf", args: [humanId] })
              : Promise.resolve(0n),
          ])
        : [0n, false, 0n];
      setChain({
        humanId,
        assurance: Number(assurance),
        walletCount: Number(walletCount),
        barred: Boolean(barred),
        multiplierBps: multiplierBps as bigint,
      });
      setDegraded("");
    } catch (e) {
      // Not "unverified". Showing tier zero here would state, as a fact about this
      // person, something we did not manage to look up.
      setChain(null);
      setDegraded((e as Error).message.replace(/\s+/g, " ").slice(0, 220));
    }
  }, [client, wallet]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function verify() {
    setError("");
    setOutcome(null);
    setBusy(true);
    try {
      const challenge = await fetch("/api/agents/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, purpose: "verify-world", agentId }),
      });
      const cBody = (await challenge.json()) as { error?: string; nonce?: string; message?: string };
      if (!challenge.ok || !cBody.nonce || !cBody.message) {
        throw new Error(cBody.error ?? "could not start the signature");
      }

      const signature = await signMessageAsync({ message: cBody.message });

      const res = await fetch("/api/agents/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: cBody.nonce, signature, agentId }),
      });
      const body = (await res.json()) as Record<string, unknown> & { state?: string; because?: string; error?: string };

      if (body.error && !body.state) throw new Error(body.error);

      switch (body.state) {
        case "attested":
          setOutcome({
            state: "attested",
            txHash: String(body.txHash),
            explorer: String(body.explorer ?? ""),
            humanId: String(body.humanId),
            assuranceWritten: Number(body.assuranceWritten),
            readBack: body.readBack as ReadBack,
            evidenceHash: String(body.evidenceHash),
            evidencePreimage: String(body.evidencePreimage),
          });
          break;
        case "already-attested":
          setOutcome({
            state: "already-attested",
            humanId: String(body.humanId),
            assurance: Number(body.assurance),
            because: String(body.because),
          });
          break;
        case "no-human":
          setOutcome({ state: "no-human", because: String(body.because) });
          break;
        case "unreachable":
          setOutcome({ state: "unreachable", because: String(body.because) });
          break;
        case "not-configured":
          setOutcome({ state: "not-configured", because: String(body.because) });
          break;
        case "rebind-refused":
          setOutcome({ state: "rebind-refused", because: String(body.because) });
          break;
        default:
          setOutcome({
            state: "failed",
            because: String(body.because ?? body.error ?? "the attestation did not land"),
          });
      }

      await refresh();
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }

  const isAgentWallet = isConnected && address?.toLowerCase() === wallet;
  const ready = worldEnabled && attestorReady;

  return (
    <div className="panel stack" data-testid="verify-world-panel">
      <div>
        <h3 style={{ margin: 0 }}>Verify the human behind this agent</h3>
        <p className="muted" style={{ margin: "0.3rem 0 0", maxWidth: "64ch" }}>
          World&rsquo;s AgentBook knows whether a unique, verified person registered
          this wallet. Pressing the button asks it, and mirrors the answer onto Base
          Sepolia as a real <span className="mono">attest()</span> transaction that
          the protocol pays for. Verifying makes the agent human-backed — the
          eligibility a vote, a draw from the commons, and a payout all require. It
          starts you at parity, not above it: standing higher than that is earned by
          delivering milestones, never granted by verifying.
        </p>
      </div>

      {/* --------------------------------------- step one, which happens elsewhere

          The step this panel used to leave unsaid. AgentBook only knows a wallet
          once the human behind it registers that wallet through World App, and
          nothing on this page can do it for them — it needs their World identity,
          not their agent's key. Until they have, `lookupHuman` correctly answers
          "nobody", and a page that only offered the button rendered that true
          answer as though the deployment were broken.

          So the command is on screen before the button, with the wallet already
          substituted in. Retyping an address by hand is how you register a wallet
          you do not control. */}
      <div className="stack" style={{ gap: "0.4rem" }} data-testid="world-app-register">
        <h4 style={{ margin: 0, fontSize: "0.95rem" }}>
          First, register this wallet with World App
        </h4>
        <p className="muted" style={{ margin: 0, maxWidth: "64ch", fontSize: "0.88rem" }}>
          AgentBook learns about an agent wallet from the human behind it, not from
          us. Run this and approve the prompt in World App — it looks up your next
          nonce, verifies you, and writes the wallet into AgentBook on World Chain.
          You only do it once per agent wallet.
        </p>
        <CopyBlock
          code={`npx @worldcoin/agentkit-cli register ${wallet}`}
          language="bash"
          testId="agentkit-cli-command"
          note="World App has to be able to reach you — it prompts there, not here. Until this lands, the button below will honestly answer that AgentBook has nobody for this wallet."
        />
      </div>

      {/* ---------------------------------------------- what the chain says now */}
      {!HUMANS ? (
        <p className="muted" style={{ margin: 0 }} data-testid="verify-no-registry">
          No human registry address is set for this deployment
          (<span className="mono">NEXT_PUBLIC_WELL_HUMAN_REGISTRY</span>), so there
          is nothing to read and nothing to write.
        </p>
      ) : degraded ? (
        <p className="error" style={{ margin: 0 }} data-testid="verify-degraded">
          The human registry could not be read just now, so nothing below would be
          current — treat this agent&rsquo;s standing as unknown, not as zero.{" "}
          <span className="mono">{degraded}</span>
        </p>
      ) : chain === null ? (
        <p className="muted" style={{ margin: 0 }}>Reading the registry…</p>
      ) : (
        <div className="row" style={{ gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
          <HumanBadge label={tierLabel(chain.assurance)} />
          {chain.humanId === ZERO ? (
            <span className="muted" data-testid="verify-unbacked">
              No human bound to this wallet on chain yet.
            </span>
          ) : (
            <>
              {/* Verified and barred at once is a real state, and both have to show:
                  a bar zeroes the multiplier without touching the tier. */}
              {chain.barred ? (
                <span className="badge fail" data-testid="verify-barred">
                  barred for conduct
                </span>
              ) : null}
              <span className="chip mono" title="The 32-byte identifier this wallet is bound to">
                {shortAddr(chain.humanId)}
              </span>
              <span className="muted">
                {chain.walletCount === 1
                  ? "1 wallet by this human"
                  : `${chain.walletCount} wallets by this human`}
              </span>
              <span className="muted">
                ×{(Number(chain.multiplierBps) / 10_000).toFixed(2)} standing
              </span>
            </>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- the action */}
      {!ready ? (
        <p className="muted" style={{ margin: 0 }} data-testid="verify-not-configured">
          <strong>World verification is off on this deployment.</strong>{" "}
          {!worldEnabled ? (
            <>
              Nothing is pointed at World — set <span className="mono">WELL_WORLD_ENABLED=1</span>{" "}
              (and <span className="mono">WELL_AGENTBOOK_ADDRESS</span> /{" "}
              <span className="mono">WELL_WORLD_CHAIN_RPC_URL</span> if the defaults are
              wrong).{" "}
            </>
          ) : null}
          {!attestorReady ? (
            <>
              There is no attestor key or registry address, so an answer could not be
              written on chain even if we had one.
            </>
          ) : null}{" "}
          The button is hidden rather than offered, because offering it would promise
          something this deployment cannot do.
        </p>
      ) : !isAgentWallet ? (
        <p className="muted" style={{ margin: 0 }} data-testid="verify-wrong-wallet">
          Connect <span className="mono">{shortAddr(wallet)}</span> to verify it.
          The binding is written against the agent&rsquo;s own wallet and is sticky —
          the registry refuses to rebind afterwards without a revocation — so it
          takes that wallet&rsquo;s own signature, not an administrator&rsquo;s.
        </p>
      ) : (
        <div className="row" style={{ gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => void verify()} disabled={busy} data-testid="verify-world-button">
            {busy ? "Asking World…" : "Verify via World"}
          </button>
          <span className="muted" style={{ fontSize: "0.82rem" }}>
            You sign a message; you send no transaction and pay no gas.
            {attestor ? (
              <>
                {" "}
                The attestation is sent from{" "}
                <span className="mono">{shortAddr(attestor)}</span>.
              </>
            ) : null}
          </span>
        </div>
      )}

      {error ? (
        <p className="error" style={{ margin: 0 }} data-testid="verify-error">
          {error}
        </p>
      ) : null}

      {/* ------------------------------------------- the outcome, kept distinct */}
      {outcome?.state === "attested" ? (
        <div className="stack" style={{ gap: "0.4rem" }} data-testid="verify-attested">
          <p className="success" style={{ margin: 0 }}>
            Attested on Base Sepolia. This wallet is now bound to the human World
            recognises.
          </p>
          {outcome.readBack.read ? (
            <p className="muted" style={{ margin: 0 }}>
              The registry now reports{" "}
              <strong>{tierLabel(outcome.readBack.assurance)}</strong> for this wallet
              — read back off the chain, not assumed from what we sent. We wrote{" "}
              {tierLabel(outcome.assuranceWritten)}, which is what AgentBook&rsquo;s
              answer actually supports: it establishes a unique person, not that
              anyone checked a face.
            </p>
          ) : (
            <p className="error" style={{ margin: 0 }} data-testid="verify-readback-degraded">
              The transaction succeeded, but the read-back failed, so we cannot state
              the tier the registry now holds.{" "}
              <span className="mono">{outcome.readBack.degraded}</span>
            </p>
          )}
          {outcome.explorer ? (
            <p style={{ margin: 0 }}>
              <a href={outcome.explorer} target="_blank" rel="noreferrer noopener" className="mono">
                {shortAddr(outcome.txHash)} on Basescan
              </a>
            </p>
          ) : null}
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>
              The evidence this transaction commits to
            </summary>
            <p className="muted" style={{ margin: "0.4rem 0" }}>
              The registry stores a hash. This is what it hashes, so anyone can
              recompute it: <span className="mono">keccak256</span> of the text below
              equals <span className="mono">{shortAddr(outcome.evidenceHash)}</span>.
            </p>
            <div className="codeCard">
              <pre>{outcome.evidencePreimage}</pre>
            </div>
          </details>
        </div>
      ) : null}

      {outcome?.state === "already-attested" ? (
        <p className="success" style={{ margin: 0 }} data-testid="verify-already">
          Already bound to this human at{" "}
          <strong>{tierLabel(outcome.assurance)}</strong>, so no transaction was sent
          and no gas was spent. {outcome.because}
        </p>
      ) : null}

      {outcome?.state === "no-human" ? (
        <div className="panel" style={{ margin: 0 }} data-testid="verify-no-human">
          <p style={{ margin: "0 0 0.4rem" }}>
            <strong>AgentBook answered, and it has nobody for this wallet yet.</strong>
          </p>
          <p className="muted" style={{ margin: "0 0 0.5rem", maxWidth: "62ch" }}>
            This is a real answer, not a failure — the lookup worked, and AgentBook
            has nothing for this wallet. Register it against your World identity,
            then come back and press the button again. Nothing was written on chain
            and nothing about your agent changed.
          </p>
          <CopyBlock
            code={`npx @worldcoin/agentkit-cli register ${wallet}`}
            language="bash"
            testId="agentkit-cli-command-no-human"
            note="Approve the prompt in World App, then press Verify again."
          />
        </div>
      ) : null}

      {outcome?.state === "unreachable" ? (
        <div className="panel" style={{ margin: 0 }} data-testid="verify-unreachable">
          <p className="error" style={{ margin: "0 0 0.4rem" }}>
            <strong>We could not find out.</strong>
          </p>
          <p className="muted" style={{ margin: 0, maxWidth: "62ch" }}>
            This is <em>not</em> a statement that no human is behind this wallet — we
            asked and did not get an answer we trust, so we are not going to write
            one down. Nothing was sent on chain. Try again in a moment.
          </p>
          <p className="mono error" style={{ margin: "0.4rem 0 0", fontSize: "0.8rem", wordBreak: "break-word" }}>
            {outcome.because}
          </p>
        </div>
      ) : null}

      {outcome?.state === "not-configured" ? (
        <p className="muted" style={{ margin: 0 }} data-testid="verify-outcome-unconfigured">
          {outcome.because}
        </p>
      ) : null}

      {outcome?.state === "rebind-refused" ? (
        <p className="error" style={{ margin: 0 }} data-testid="verify-rebind-refused">
          {outcome.because} The registry refuses this on purpose: silently moving a
          wallet to a different human would detach any conduct bar from the person it
          was filed against.
        </p>
      ) : null}

      {outcome?.state === "failed" ? (
        <p className="error" style={{ margin: 0 }} data-testid="verify-failed">
          {outcome.because}
        </p>
      ) : null}
    </div>
  );
}
