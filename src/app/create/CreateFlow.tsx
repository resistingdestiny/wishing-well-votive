"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  useAccount,
  useConnect,
  useSwitchChain,
  useWriteContract,
  usePublicClient,
} from "wagmi";
import {
  parseEther,
  parseUnits,
  isAddress,
  getAddress,
  decodeAbiParameters,
} from "viem";
import { factoryAbi, erc20Abi, toIntent, DEFAULT_DEADLINES, ANY_TERMS } from "@/lib/chain";
import {
  appChain,
  FACTORY_ADDRESS,
  FUNDING_TOKENS,
  POSITION_REGISTRY_ADDRESS,
  REGISTRY_ADDRESS,
} from "@/lib/wagmi";
import { FiatFundForm } from "../fund/FiatFundForm";
import { WatchButton } from "@/app/WatchButton";
import { Field } from "@/app/ui/Field";
import { addMyCell } from "@/lib/myCells";
import { noteTx } from "@/lib/noteTx";

const RAIL_STEPS = ["Your wish", "Review & terms", "Fund it", "Done"] as const;

const PARSE_LINES = [
  "Reading your story…",
  "Extracting the capability…",
  "Deriving the resolution condition…",
  "Binding the hashes…",
];

const CONFETTI_COLORS = ["#2563eb", "#c79a3b", "#16a34a", "#8a8e96", "#60a5fa"];
function confettiBits(): React.CSSProperties[] {
  return Array.from({ length: 18 }, (_, i) => {
    const a = (i * 137.5 * Math.PI) / 180;
    const dist = 70 + ((i * 47) % 90);
    return {
      "--cx": `${Math.cos(a) * dist}px`,
      "--cy": `${Math.sin(a) * dist * 0.7 - 40}px`,
      "--cr": `${((i * 97) % 540) - 270}deg`,
      background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      animationDelay: `${(i % 6) * 45}ms`,
    } as React.CSSProperties;
  });
}

function CreateRail({
  step,
  maxStep,
  onNavigate,
}: {
  step: number;
  maxStep: number;
  onNavigate: (n: number) => void;
}) {
  return (
    <div className="guide-rail" data-testid="create-rail" aria-label="Create progress">
      {RAIL_STEPS.map((label, n) => {
        const reachable = n <= maxStep && n !== step && n < RAIL_STEPS.length - 1;
        return (
          <span className="guide-step" key={label}>
            <button
              type="button"
              className={`guide-dot ${n === step ? "current" : n < step ? "done" : ""}`}
              disabled={!reachable}
              onClick={() => onNavigate(n)}
              aria-current={n === step ? "step" : undefined}
            >
              <span className="guide-num">{n < step ? "✓" : n + 1}</span>
              <span className="guide-label">{label}</span>
            </button>
            {n < RAIL_STEPS.length - 1 ? (
              <span className={`guide-connector${n < step ? " done" : ""}`} />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

interface OnchainSchemaJson {
  kind: number;
  wisher: `0x${string}`;
  guardian: `0x${string}`;
  beneficiary: `0x${string}`;
  capabilityId: `0x${string}`;
  conditionHash: `0x${string}`;
  storyHash: `0x${string}`;
  actionBudget: string;
  isSealed: boolean;
  fallbackBeneficiary: `0x${string}`;
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

interface ParsePreview {
  story: {
    kind: string;
    capability: { summary: string };
    condition: { summary: string; canonical: string };
    amendPolicy: { amendAfterDays: number; escheatAfterDays: number };
  } & Record<string, unknown>;
  onchain: OnchainSchemaJson;
  provider: string;
  resolver?: { resolverId: `0x${string}`; params: `0x${string}`; kind: string } | null;
}

const STARTERS: { label: string; prose: string }[] = [
  {
    label: "Hunt bugs when AI out-audits humans",
    prose:
      "When an AI can find exploits better than any human auditor, use these funds to hunt bugs across the top hundred protocols, and pay every bounty into the shared pool.",
  },
  {
    label: "Return my funds when AI masters basic reasoning",
    prose:
      "When an AI can reliably do exact arithmetic and simple factual recall, return my funds to me. Any capable model today should clear this. I want to watch the machine grant a wish end to end.",
  },
  {
    label: "Wait for a model that can plan a real trip",
    prose:
      "Hold my funds until an AI can plan a constrained multi-city itinerary and defend the trade-offs to a human reviewer. Feels about one model generation away. When a reviewer signs off, return everything.",
  },
  {
    label: "An endowment for a machine-checked proof",
    prose:
      "Keep these funds in the well until an AI produces a machine-checked proof of the Riemann hypothesis, accepted by a formal verification pipeline. My grandchildren can collect. I am in no hurry.",
  },
  {
    label: "Translate my grandmother's diaries",
    prose:
      "Hold this until an AI can faithfully translate and annotate my grandmother's handwritten diaries from Polish, preserving idiom and tone, judged by a human translator. Then release it to fund publishing them.",
  },
  {
    label: "Buy my daughter a house when she turns 30",
    prose:
      "Keep these funds until my daughter turns 30, then, if an AI can find and vet a sound home near her work within budget, release everything to her. If I go quiet for two years, my brother may redirect the wish.",
  },
];

export function CreateFlow() {
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors } = useConnect();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();

  const [prose, setProse] = useState("");
  const [fullStory, setFullStory] = useState("");
  const [sealed, setSealed] = useState(false);
  const [tokenize, setTokenize] = useState(false);
  const [fallback, setFallback] = useState("");
  const [manualWisher, setManualWisher] = useState("");
  const [preview, setPreview] = useState<ParsePreview | null>(null);
  const [amount, setAmount] = useState("0.01");

  const [fundAsset, setFundAsset] = useState<string>("ETH");
  const fundToken = FUNDING_TOKENS.find((t) => t.address === fundAsset);
  const [phase, setPhase] = useState<
    "compose" | "parsing" | "preview" | "submitting" | "done"
  >("compose");
  const [error, setError] = useState("");
  const [cellAddress, setCellAddress] = useState("");
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [fundMethod, setFundMethod] = useState<"wallet" | "fiat">("wallet");

  const [parseMsg, setParseMsg] = useState(0);
  const [copied, setCopied] = useState(false);
  const segRef = useRef<HTMLDivElement | null>(null);
  const [segInd, setSegInd] = useState<{ left: number; width: number } | null>(null);

  const wisher = (address ?? manualWisher) as `0x${string}` | "";

  const PLACEHOLDER_WISHER = "0x0000000000000000000000000000000000000001" as const;

  useEffect(() => {
    if (phase !== "parsing") return;
    setParseMsg(0);
    const t = setInterval(() => setParseMsg((m) => (m + 1) % PARSE_LINES.length), 950);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (step !== 2) return;
    const seg = segRef.current;
    if (!seg) return;
    const measure = () => {
      const el = seg.querySelector<HTMLElement>("button.on");
      setSegInd(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    const t = setTimeout(measure, 120);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, [fundMethod, step]);

  function goTo(n: number) {
    setStep(n);
    setMaxStep((m) => Math.max(m, n));
  }

  function editProse(v: string) {
    setProse(v);
    if (preview) {
      setPreview(null);
      setPhase("compose");
      setMaxStep(0);
    }
  }

  async function parse() {
    setError("");
    if (!prose.trim()) {
      setError("Tell Votive your story first.");
      return;
    }

    if (wisher && !isAddress(wisher)) {
      setError("That depositor address isn't valid. Fix or clear it.");
      return;
    }
    const parseWisher = wisher || PLACEHOLDER_WISHER;
    setPhase("parsing");
    try {
      const res = await fetch("/api/parse-story", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prose, wisher: parseWisher }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "parse failed");
      setPreview(body as ParsePreview);
      setPhase("preview");
      goTo(1);
    } catch (e) {
      setError((e as Error).message);
      setPhase("compose");
    }
  }

  const schemaJson = preview
    ? JSON.stringify(
        {
          ...preview.onchain,
          isSealed: sealed,
          fallbackBeneficiary: isAddress(fallback)
            ? getAddress(fallback)
            : preview.onchain.fallbackBeneficiary,
        },
        null,
        2,
      )
    : "";

  async function copySchema() {
    try {
      await navigator.clipboard.writeText(schemaJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {

    }
  }

  async function signAndFund() {
    if (!preview || !FACTORY_ADDRESS || !client) return;
    const factoryAddress = FACTORY_ADDRESS;
    setError("");
    setPhase("submitting");
    try {
      const s = preview.onchain;

      if (fundToken && preview.resolver?.kind === "ERC-20 received") {
        const [condToken] = decodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }],
          preview.resolver.params,
        ) as [`0x${string}`, bigint];
        if (getAddress(condToken) === getAddress(fundToken.address)) {
          throw new Error(
            "This condition watches the same token the wish is funded in. It would resolve immediately. Fund in ETH or a different token.",
          );
        }
      }

      const depositor = address ?? s.wisher;
      const unplaceholder = (a: `0x${string}`): `0x${string}` =>
        a === PLACEHOLDER_WISHER ? depositor : a;

      const beneficiary =
        tokenize && POSITION_REGISTRY_ADDRESS
          ? POSITION_REGISTRY_ADDRESS
          : unplaceholder(s.beneficiary);
      const schemaStruct = {
        kind: s.kind,
        wisher: depositor,

        guardian: sealed ? ZERO_ADDR : unplaceholder(s.guardian),
        beneficiary,
        capabilityId: s.capabilityId,
        conditionHash: s.conditionHash,
        storyHash: s.storyHash,
        actionBudget: BigInt(s.actionBudget),
        isSealed: sealed,
        fallbackBeneficiary: tokenize
          ? ZERO_ADDR
          : isAddress(fallback)
            ? getAddress(fallback)
            : ZERO_ADDR,

        beneficiariesRoot: ("0x" + "0".repeat(64)) as `0x${string}`,
      } as const;
      // Zero on any clock means "use the factory's default", which is what the
      // preview showed the founder — so a policy it did not ask about is not
      // silently overridden here.
      const deadlines = {
        guardianAfter: BigInt(preview.story.amendPolicy.amendAfterDays) * 86400n,
        escheatAfter: BigInt(preview.story.amendPolicy.escheatAfterDays) * 86400n,
        attemptWindow: DEFAULT_DEADLINES.attemptWindow,
      } as const;

      const intent = toIntent(schemaStruct, depositor);

      let hash: `0x${string}`;
      if (fundToken) {
        const amt = parseUnits(amount, fundToken.decimals);
        const approveHash = await writeContractAsync({
          address: fundToken.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [factoryAddress, amt],
          chainId: appChain.id,
        });
        await client.waitForTransactionReceipt({ hash: approveHash });
        hash = await writeContractAsync({
          address: factoryAddress,
          abi: factoryAbi,
          functionName: "openWithToken",
          args: [intent, deadlines, ANY_TERMS, fundToken.address, amt],
          chainId: appChain.id,
        });
      } else {
        hash = await writeContractAsync({
          address: factoryAddress,
          abi: factoryAbi,
          functionName: "open",
          args: [intent, deadlines, ANY_TERMS],
          value: parseEther(amount),
          chainId: appChain.id,
        });
      }
      const receipt = await client.waitForTransactionReceipt({ hash });
      const created = receipt.logs.find(
        (l) => l.address.toLowerCase() === factoryAddress.toLowerCase(),
      );
      const cell = created?.topics[1]
        ? `0x${created.topics[1].slice(26)}`
        : "";
      if (cell) {
        noteTx("wish-opened", hash, {
          detail: `${amount} ${fundToken ? fundToken.symbol : "ETH"} from ${depositor}`,
          contract: factoryAddress,
          subject: cell,
        });
        await fetch("/api/register-wish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cell, prose, wisher, fullStory, parsed: preview.story }),
        });

        // Nothing to bind: our registry attests a condition directly rather than
        // wiring it to a resolver contract, and attesting is the attestor's call
        // to make later — not something a founder does while opening a wish.
      }
      setCellAddress(cell);
      if (cell) addMyCell({ cell, label: prose.slice(0, 80), source: "create" });
      setPhase("done");
      goTo(3);
    } catch (e) {
      setError((e as Error).message);
      setPhase("preview");
    }
  }

  const wordCount = prose.trim() === "" ? 0 : prose.trim().split(/\s+/).length;

  return (
    <div className="stack" style={{ marginTop: "1.5rem" }}>
      <CreateRail step={step} maxStep={maxStep} onNavigate={goTo} />

      <div key={step} className="stepPane animFadeUp">
      {}
      {step === 0 ? (
        <>
          {!isConnected ? (
            <div className="panel stack hoverable">
              <div className="row">
                <span className="muted">Fund from a wallet:</span>
                {connectors.map((c) => (
                  <button key={c.uid} className="secondary" onClick={() => connect({ connector: c })}>
                    Connect {c.name === "Injected" ? "browser wallet" : c.name}
                  </button>
                ))}
              </div>
              <Field
                label="…or just preview with any address"
                hint="A wallet (on Base Sepolia) is only needed to fund a wish. To explore Votive or preview how your story becomes a schema, you don’t need one."
              >
                <input
                  type="text"
                  placeholder="0x…"
                  value={manualWisher}
                  onChange={(e) => setManualWisher(e.target.value)}
                  data-testid="wisher-input"
                />
              </Field>
            </div>
          ) : (
            <p className="muted">
              Depositing as <span className="mono">{address}</span>
            </p>
          )}

          {phase === "compose" && prose.trim() === "" ? (
            <div className="stack" style={{ gap: "0.5rem" }} data-testid="starter-gallery">
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                Not sure where to start? Pick a wish to shape from:
              </span>
              <div className="starterGrid" data-stagger>
                {STARTERS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="starterCard"
                    onClick={() => editProse(s.prose)}
                  >
                    <strong>{s.label}</strong>
                    <span className="muted">{s.prose.slice(0, 96)}…</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="parseHost">
            {phase === "parsing" ? (
              <div className="parseScan" aria-live="polite">
                <span className="parseStatus">{PARSE_LINES[parseMsg]}</span>
              </div>
            ) : null}
            <div className="stack">
              <Field
                label="Your wish"
                hint="Plain language: what to hold, until what, then what happens. The agent parses it into a machine-readable schema you sign; execution only ever runs off that schema."
              >
                <div className="composeWrap">
                  <textarea
                    placeholder="e.g. Hold these funds until an AI can produce a fully verified formal proof of the four-colour theorem in Lean without human help, then return them to me. If I go quiet for two years, my sister Maya may redirect the wish."
                    value={prose}
                    onChange={(e) => editProse(e.target.value)}
                    disabled={phase === "parsing"}
                    data-testid="story-input"
                  />
                </div>
                <div className="wordCount" aria-hidden="true">
                  {wordCount === 0 ? "\u00a0" : `${wordCount} words`}
                </div>
              </Field>

              {prose.trim() !== "" ? (
                <details className="fullStoryBlock" data-testid="full-story-block">
                  <summary>Add the full story &amp; context (optional)</summary>
                  <p className="muted" style={{ margin: "0.4rem 0" }}>
                    The short wish above derives (and signs) the executable schema. Here you
                    can write the <strong>whole vision</strong>: backstory, intent,
                    constraints, edge cases. It&rsquo;s preserved verbatim and handed to the
                    agent as interpretive context when it executes or amends your wish.
                  </p>
                  <textarea
                    placeholder="e.g. My grandmother kept these diaries through the war. Translate them faithfully. Preserve her idiom, don't modernise the tone, and footnote any place names that no longer exist…"
                    value={fullStory}
                    onChange={(e) => setFullStory(e.target.value)}
                    data-testid="full-story-input"
                  />
                </details>
              ) : null}

              {error ? <p className="error">{error}</p> : null}

              <div className="row">
                {preview && phase === "preview" ? (
                  <button onClick={() => goTo(1)}>Continue to review →</button>
                ) : (
                  <button onClick={parse} disabled={phase === "parsing"} data-testid="parse-button">
                    {phase === "parsing" ? "Parsing story…" : "Parse into schema"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {}
      {step === 1 && preview ? (
        <>
          <div className="panel stack rvStagger" data-testid="schema-preview">
            <div>
              <strong>Wish type:</strong> {preview.story.kind}
              <span className="muted"> · parsed by {preview.provider}</span>
            </div>
            <div>
              <strong>Capability the AI must prove:</strong>{" "}
              {preview.story.capability.summary}
            </div>
            <div>
              <strong>Resolves when:</strong> {preview.story.condition.summary}{" "}
              <span className="mono muted">({preview.story.condition.canonical})</span>
            </div>
            <div>
              <strong>Amendment policy:</strong> guardian may redirect after{" "}
              {preview.story.amendPolicy.amendAfterDays} days of silence; escheat after{" "}
              {preview.story.amendPolicy.escheatAfterDays} days.
            </div>
            <div className="codeCard">
              <button type="button" className="btnGhost btnSm copyBtn" onClick={copySchema}>
                {copied ? "Copied ✓" : "Copy"}
              </button>
              <pre className="schema">{schemaJson}</pre>
            </div>
            <label className={`switchCard${sealed ? " on" : ""}`}>
              <input
                type="checkbox"
                className="switch"
                checked={sealed}
                onChange={(e) => setSealed(e.target.checked)}
                data-testid="seal-toggle"
              />
              <span className="switchBody">
                Seal this wish: make it <strong>irrevocable</strong>
                <span className="muted" style={{ display: "block", fontSize: "0.8rem", marginTop: "0.15rem" }}>
                  Optional: a true commitment device (permanently unamendable, enforced on chain).
                </span>
              </span>
            </label>
            {sealed ? (
              <p className="error animSlideDown" style={{ margin: 0 }} data-testid="seal-warning">
                A sealed wish can <strong>never</strong> be amended, redirected, or
                revoked, not by you and not by a guardian (any guardian is removed). It
                can only be fulfilled, or escheated after long inactivity. This is
                permanent and has no undo.
              </p>
            ) : null}
            {POSITION_REGISTRY_ADDRESS && preview.onchain.kind === 0 ? (
              <label className={`switchCard${tokenize ? " on" : ""}`}>
                <input
                  type="checkbox"
                  className="switch"
                  checked={tokenize}
                  onChange={(e) => setTokenize(e.target.checked)}
                  data-testid="tokenize-toggle"
                />
                <span className="switchBody">
                  Make the payout a <strong>transferable NFT</strong> (a tradeable position)
                </span>
              </label>
            ) : null}
            {tokenize ? (
              <p
                className="muted animSlideDown"
                style={{ margin: 0, fontSize: "0.82rem" }}
                data-testid="tokenize-note"
              >
                An ERC-721 “position” is minted to you; whoever holds it is paid when the
                wish is fulfilled. Amendment / ping / guardian control stays with your key.
                The token conveys only the payout right. No fallback beneficiary (the holder
                is the escheat destination too); seal it to make it rug-proof for a buyer.
              </p>
            ) : null}
            {!tokenize ? (
              <Field label="Fallback if abandoned (optional)">
                <input
                  type="text"
                  placeholder="0x… charity / heirs, where funds escheat instead of the platform"
                  value={fallback}
                  onChange={(e) => setFallback(e.target.value)}
                  data-testid="fallback-input"
                />
              </Field>
            ) : null}
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <button className="secondary" onClick={() => goTo(0)}>
              ← Back
            </button>
            <button onClick={() => goTo(2)} data-testid="to-funding-button">
              Continue to funding →
            </button>
          </div>
        </>
      ) : null}

      {}
      {step === 2 && preview ? (
        <>
          <div className="segControl" role="tablist" aria-label="Funding method" ref={segRef}>
            {segInd ? (
              <span
                className="segIndicator"
                style={{ left: segInd.left, width: segInd.width }}
                aria-hidden="true"
              />
            ) : null}
            <button
              className={fundMethod === "wallet" ? "on" : ""}
              onClick={() => setFundMethod("wallet")}
              data-testid="create-fund-wallet"
            >
              Wallet{FUNDING_TOKENS.length > 0 ? " (ETH / tokens)" : " (ETH)"}
            </button>
            <button
              className={fundMethod === "fiat" ? "on" : ""}
              onClick={() => setFundMethod("fiat")}
              data-testid="create-fund-fiat"
            >
              Card or bank
            </button>
          </div>

          {fundMethod === "wallet" ? (
            <div className="panel stack animFadeUp">
              <div className="row" data-testid="fund-row">
                <label>
                  Fund with{" "}
                  <input
                    type="number"
                    min="0.0001"
                    step="0.001"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    style={{ width: "8rem", display: "inline-block" }}
                    className="amountInput"
                    data-testid="fund-eth-amount"
                  />{" "}
                  {FUNDING_TOKENS.length > 0 ? (
                    <select
                      value={fundAsset}
                      onChange={(e) => setFundAsset(e.target.value)}
                      data-testid="fund-asset"
                    >
                      <option value="ETH">ETH</option>
                      {FUNDING_TOKENS.map((t) => (
                        <option key={t.address} value={t.address}>
                          {t.symbol}
                        </option>
                      ))}
                    </select>
                  ) : (
                    "ETH"
                  )}
                </label>
                <button onClick={signAndFund} disabled={phase === "submitting" || !isConnected}>
                  {phase === "submitting"
                    ? "Waiting for wallet…"
                    : fundToken
                      ? `Approve ${fundToken.symbol} & fund wish`
                      : "Sign schema & fund wish"}
                </button>
              </div>
              {!isConnected ? (
                <p className="muted" style={{ margin: 0 }}>
                  Connect a wallet to fund, or pick another method above.
                </p>
              ) : chain && chain.id !== appChain.id ? (
                <p className="muted" style={{ margin: 0 }} data-testid="wrong-network">
                  Your wallet is on <strong>{chain.name}</strong>. Votive runs on{" "}
                  <strong>{appChain.name}</strong>.{" "}
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => switchChain({ chainId: appChain.id })}
                  >
                    Switch to {appChain.name}
                  </button>{" "}
                  (signing will also prompt the switch automatically).
                </p>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  Signing as <span className="mono">{address}</span> on {appChain.name}.
                  This wallet becomes the depositor in the signed schema (hashes are
                  depositor-independent, so your reviewed preview stays valid).
                </p>
              )}
              <p className="muted" style={{ margin: 0 }}>
                Sending this transaction from your depositor address is your signature
                over the schema you reviewed. The contract rejects anyone else.
              </p>
            </div>
          ) : null}

          {fundMethod === "fiat" ? (
            <div className="animFadeUp stack">
              <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
                Heads-up: card/bank funding uses the custodial rail and creates the
                standard manual-confirmation wish in USDC (it resolves when the depositor
                confirms). The parsed schema from the review step applies to wallet
                funding.
              </p>
              <FiatFundForm prefillProse={prose} showCryptoTab={false} />
            </div>
          ) : null}

          {error ? <p className="error">{error}</p> : null}

          <div className="row">
            <button className="secondary" onClick={() => goTo(1)}>
              ← Back to review
            </button>
          </div>
        </>
      ) : null}

      {}
      {step === 3 ? (
        <div className="panel stack celebrateWrap" style={{ gap: "0.75rem" }} data-testid="create-done">
          {confettiBits().map((s, i) => (
            <span key={i} className="confettiBit" style={s} aria-hidden="true" />
          ))}
          <div className="row" style={{ gap: "0.9rem" }}>
            <span className="orb orb-granted doneOrb" aria-hidden="true" />
            <p className="success" style={{ margin: 0, fontSize: "1.1rem" }}>
              Your wish is in Votive.
            </p>
          </div>
          <p style={{ margin: 0 }}>
            <Link href={`/wish/${cellAddress}`} className="mono">
              {cellAddress}
            </Link>{" "}
            is its own segregated cell. The next capability sweep will pick it up.
          </p>
          {cellAddress ? (
            <div className="row">
              <Link href={`/wish/${cellAddress}`} className="pill pillPrimary">
                Open your wish
              </Link>
              <WatchButton kind="cell" target={cellAddress} label="Watch this wish" />
              <Link href="/board" className="pill">
                See it on the board
              </Link>
              <button
                className="secondary"
                onClick={() => {
                  setProse("");
                  setFullStory("");
                  setPreview(null);
                  setCellAddress("");
                  setSealed(false);
                  setTokenize(false);
                  setFallback("");
                  setError("");
                  setPhase("compose");
                  setFundMethod("wallet");
                  setStep(0);
                  setMaxStep(0);
                }}
              >
                Make another wish
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
    </div>
  );
}
