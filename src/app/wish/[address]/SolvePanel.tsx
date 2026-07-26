"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { appChain } from "@/lib/wagmi";
import { walletError } from "@/lib/walletError";
import { noteTx } from "@/lib/noteTx";

/**
 * Read statically, one name at a time — the same asymmetry AquaActions documents:
 * Next only substitutes a *literal* `process.env.NEXT_PUBLIC_X`, so a dynamic
 * `process.env[key]` reads `undefined` in the browser while working on the server.
 */
const asAddress = (v: string | undefined): Address | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;

const REGISTRY = asAddress(process.env.NEXT_PUBLIC_WELL_REGISTRY);
const FACTORY = asAddress(process.env.NEXT_PUBLIC_WELL_FACTORY);

// Exactly the four calls this panel makes, and the two reads that decide whether
// the connected wallet is allowed to make them.
const registryAbi = parseAbi([
  "function attestCapability(bytes32,bytes32,bool,bytes32)",
  "function attestCondition(address,bytes32,bool,bytes32)",
  "function attestor() view returns (address)",
]);
const factoryAbi = parseAbi(["function executor() view returns (address)"]);
const votiveAbi = parseAbi(["function beginAttempt()", "function fulfil()"]);

interface SolvingAgent {
  id: string;
  displayName: string;
  baseModel: string;
}

/** The shape /api/solve returns on success. */
interface SolveResult {
  agent: SolvingAgent;
  question: string;
  answer: string;
  expected: string;
  passed: boolean;
  capabilitySummary: string;
}

interface Props {
  votive: Address;
  capabilityId: Hex;
  conditionHash: Hex;
  /** Snapshotted from the registry at page render; skip the attest if already so. */
  capabilityOpen: boolean;
  conditionMet: boolean;
}

type Step = "attest-cap" | "attest-cond" | "begin" | "fulfil";

const STEP_LABEL: Record<Step, string> = {
  "attest-cap": "Opening the capability gate…",
  "attest-cond": "Attesting the release condition…",
  begin: "Beginning the attempt…",
  fulfil: "Fulfilling…",
};

/**
 * Solving a wish, live, from the browser.
 *
 * The two halves are deliberately split by trust. Running the agent is pure
 * server-side compute — anyone may do it, no wallet required — so the eval's
 * verdict is not something the operator can talk their way past. Settling it is
 * on-chain and only the operator can do it, because only the operator holds the
 * key that is *both* the registry's attestor and the factory's executor. This
 * demo wallet holds both roles, so one person can carry a Waiting wish all the
 * way to Fulfilled: open the capability gate, attest the release condition, then
 * begin the attempt and fulfil.
 *
 * Every write is awaited to its receipt before the next is sent. The four calls
 * are ordered dependencies — the cell refuses `fulfil` before `beginAttempt`, and
 * `beginAttempt` before its gates are open — so firing them without waiting would
 * simply revert the later ones against state that had not landed yet.
 */
export function SolvePanel({ votive, capabilityId, conditionHash, capabilityOpen, conditionMet }: Props) {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [result, setResult] = useState<SolveResult | null>(null);

  const [roles, setRoles] = useState<{ attestor?: Address; executor?: Address }>({});
  const [busy, setBusy] = useState<Step | "">("");
  const [txs, setTxs] = useState<{ label: string; hash: Hex }[]>([]);
  const [settleError, setSettleError] = useState("");
  const [done, setDone] = useState(false);

  // Who is allowed to settle. Read once; if the reads fail the settle path simply
  // never offers itself rather than presenting a button that would revert.
  useEffect(() => {
    if (!client || !REGISTRY || !FACTORY) return;
    let cancelled = false;
    (async () => {
      try {
        const [attestor, executor] = await Promise.all([
          client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "attestor" }),
          client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "executor" }),
        ]);
        if (!cancelled) setRoles({ attestor: attestor as Address, executor: executor as Address });
      } catch {
        // Left unset; isOperator stays false.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const isOperator =
    isConnected &&
    eq(address, roles.attestor) &&
    eq(roles.attestor, roles.executor) &&
    eq(address, roles.executor);

  const explorer = appChain.blockExplorers?.default.url ?? "";

  async function run() {
    setRunError("");
    setResult(null);
    setSettleError("");
    setDone(false);
    setTxs([]);
    setRunning(true);
    try {
      const res = await fetch("/api/solve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ votive }),
      });
      const data = (await res.json()) as SolveResult & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "the agent could not be run");
      setResult(data);
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function settle() {
    if (!client || !result || !REGISTRY) return;
    setSettleError("");
    setDone(false);
    // A single evidence tag ties every attestation for this wish to this solve.
    const evidence = keccak256(toHex(`solve:${votive}`));
    try {
      if (!capabilityOpen) {
        setBusy("attest-cap");
        const hash = await writeContractAsync({
          address: REGISTRY,
          abi: registryAbi,
          functionName: "attestCapability",
          args: [capabilityId, keccak256(toHex(result.agent.baseModel)), true, evidence],
          chainId: appChain.id,
        });
        await client.waitForTransactionReceipt({ hash });
        noteTx("capability-attested", hash, { contract: REGISTRY, subject: votive });
        setTxs((p) => [...p, { label: "Capability gate opened", hash }]);
      }
      if (!conditionMet) {
        setBusy("attest-cond");
        const hash = await writeContractAsync({
          address: REGISTRY,
          abi: registryAbi,
          functionName: "attestCondition",
          args: [votive, conditionHash, true, evidence],
          chainId: appChain.id,
        });
        await client.waitForTransactionReceipt({ hash });
        noteTx("condition-attested", hash, { contract: REGISTRY, subject: votive });
        setTxs((p) => [...p, { label: "Release condition attested", hash }]);
      }

      setBusy("begin");
      const beginHash = await writeContractAsync({
        address: votive,
        abi: votiveAbi,
        functionName: "beginAttempt",
        args: [],
        chainId: appChain.id,
      });
      await client.waitForTransactionReceipt({ hash: beginHash });
      noteTx("attempt-begun", beginHash, { contract: votive, subject: votive });
      setTxs((p) => [...p, { label: "Attempt begun", hash: beginHash }]);

      setBusy("fulfil");
      const fulfilHash = await writeContractAsync({
        address: votive,
        abi: votiveAbi,
        functionName: "fulfil",
        args: [],
        chainId: appChain.id,
      });
      await client.waitForTransactionReceipt({ hash: fulfilHash });
      noteTx("wish-fulfilled", fulfilHash, { contract: votive, subject: votive });
      setTxs((p) => [...p, { label: "Wish fulfilled — paid out", hash: fulfilHash }]);

      setDone(true);
    } catch (e) {
      setSettleError(walletError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="panel stack" data-testid="solve-panel" style={{ marginTop: 14 }}>
      <div>
        <h3 style={{ margin: 0 }}>Solve this wish</h3>
        <p className="muted" style={{ margin: "0.3rem 0 0" }}>
          An agent attempts the wish&rsquo;s capability. If it passes, the operator settles
          it on-chain — opening the gate, attesting the condition, then beginning and
          fulfilling the attempt — and the wish pays out.
        </p>
      </div>

      <div className="row">
        <button className="btn" onClick={run} disabled={running} data-testid="solve-run">
          {running ? "Running…" : "Run the agent"}
        </button>
        {running ? (
          <span className="muted">The agent is attempting the capability…</span>
        ) : null}
      </div>

      {runError ? <p className="error" style={{ margin: 0 }}>{runError}</p> : null}

      {result ? (
        <div className="stack" data-testid="solve-result" style={{ gap: "0.5rem" }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <span>
              <strong>{result.agent.displayName}</strong>{" "}
              <span className="muted">on {result.agent.baseModel}</span>
            </span>
            <span className={`badge ${result.passed ? "pass" : "fail"}`}>
              {result.passed ? "PASS" : "FAIL"}
            </span>
          </div>
          {result.capabilitySummary ? (
            <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
              {result.capabilitySummary}
            </p>
          ) : null}
          <div>
            <div className="muted" style={{ fontSize: "0.8rem" }}>Question</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{result.question}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: "0.8rem" }}>The agent answered</div>
            <div className="mono" style={{ whiteSpace: "pre-wrap" }}>{result.answer}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: "0.8rem" }}>Expected</div>
            <div className="mono" style={{ whiteSpace: "pre-wrap" }}>{result.expected}</div>
          </div>
          {result.passed ? (
            <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
              Passed the capability check — 3 consecutive passes required, all clear.
            </p>
          ) : null}
        </div>
      ) : null}

      {result?.passed && isOperator ? (
        <div className="stack" style={{ gap: "0.5rem" }}>
          <button
            className="btn"
            onClick={settle}
            disabled={busy !== "" || done}
            data-testid="solve-settle"
          >
            {busy !== "" ? STEP_LABEL[busy] : "Settle on-chain →"}
          </button>
          {txs.length > 0 ? (
            <ul className="muted" style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.85rem" }}>
              {txs.map((t) => (
                <li key={t.hash}>
                  {t.label} —{" "}
                  {explorer ? (
                    <a href={`${explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer">
                      {t.hash.slice(0, 12)}…
                    </a>
                  ) : (
                    <span className="mono">{t.hash.slice(0, 12)}…</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : result?.passed && !isOperator ? (
        <p className="muted" style={{ margin: 0 }}>
          Connect the operator wallet (the attestation/executor key) to settle this on-chain.
        </p>
      ) : null}

      {settleError ? <p className="error" style={{ margin: 0 }}>{settleError}</p> : null}
      {done ? (
        <p className="success" style={{ margin: 0 }} data-testid="solve-done">
          Solved. The agent cleared the capability, and this wish is now Fulfilled and paid out.
          Refresh to see it settle.
        </p>
      ) : null}
    </div>
  );
}
