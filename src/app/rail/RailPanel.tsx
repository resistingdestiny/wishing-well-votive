"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { formatEther, isAddress, keccak256, parseAbi, parseEther, stringToHex, type Address } from "viem";
import { hederaChain } from "@/lib/wagmi";
import { ChainGuard } from "@/app/ui/ChainGuard";
import { Field } from "@/app/ui/Field";
import { noteTx } from "@/lib/noteTx";
import { walletError } from "@/lib/walletError";

const railAbi = parseAbi([
  "function registerAgent(address payout)",
  "function postBounty(address votive, bytes32 taskHash, bytes32 capabilityId, uint64 claimWindow, uint64 lifetime) payable returns (uint256)",
  "function claim(uint256 id)",
  "function release(uint256 id, bytes32 milestoneHash, uint256 amount)",
  "function withdraw() returns (uint256)",
  "function bountyCount() view returns (uint256)",
  "function payoutOf(address agent) view returns (address)",
  "function credited(address) view returns (uint256)",
  "function earned(address) view returns (uint256)",
  "function milestonesDelivered(address) view returns (uint256)",
  "function escrowed() view returns (uint256)",
  "struct Bounty { address funder; address agent; address votive; bytes32 taskHash; bytes32 capabilityId; uint256 total; uint256 paid; uint64 claimExpiresAt; uint64 refundableAt; bool closed; }",
  "function bountyOf(uint256 id) view returns (Bounty)",
]);

const asAddress = (v: string | undefined): Address | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;

/**
 * The rail is deployed on Hedera, not on the chain the rest of the app points
 * at, so it gets its own address and its own explorer. Reads go through the
 * wallet's client only when the wallet is on that network — which is why every
 * refusal below names the network rather than just failing.
 */
const RAIL = asAddress(process.env.NEXT_PUBLIC_HEDERA_BOUNTY_RAIL)
  ?? asAddress(process.env.NEXT_PUBLIC_WELL_BOUNTY_RAIL);

const HOUR = 3600n;
const DAY = 86400n;

interface Mine {
  payout: Address;
  credited: bigint;
  earned: bigint;
  delivered: bigint;
}

interface BountyRow {
  id: bigint;
  funder: Address;
  agent: Address;
  total: bigint;
  paid: bigint;
  closed: boolean;
  taskHash: `0x${string}`;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Escrowed payments between a funder and an agent, on Hedera.
 *
 * The shape is deliberate and it is the whole argument for putting this on a
 * payments chain rather than inside the wish:
 *
 *   - money is escrowed up front, so an agent knows the reward is real before
 *     it spends anything doing the work;
 *   - a claim is exclusive and time-limited, so two agents don't both pay for
 *     the same job and then argue about who gets paid, and one that goes quiet
 *     can't sit on it;
 *   - release is gated on an *attested* milestone, so nobody — including the
 *     funder — can move money the attestor hasn't approved;
 *   - earnings are credited, not pushed, so one withdrawal collects however
 *     many milestones it came from.
 */
export function RailPanel() {
  const { address, isConnected, chain } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [mine, setMine] = useState<Mine | null>(null);
  const [bounties, setBounties] = useState<BountyRow[]>([]);
  const [escrowed, setEscrowed] = useState<bigint>(0n);
  const [degraded, setDegraded] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const [payout, setPayout] = useState("");
  const [task, setTask] = useState("");
  const [reward, setReward] = useState("");
  const [votive, setVotive] = useState("");

  const refresh = useCallback(async () => {
    if (!client || !RAIL) return;
    try {
      const [count, held] = await Promise.all([
        client.readContract({ address: RAIL, abi: railAbi, functionName: "bountyCount" }),
        client.readContract({ address: RAIL, abi: railAbi, functionName: "escrowed" }),
      ]);
      setEscrowed(held as bigint);

      // Newest first, and only the last handful: the rail is a ledger, not a
      // feed, and reading all of it would be a request per bounty forever.
      const total = count as bigint;
      const ids: bigint[] = [];
      for (let i = total; i > 0n && ids.length < 8; i--) ids.push(i);
      const rows = await Promise.all(
        ids.map(async (id) => {
          const b = await client.readContract({
            address: RAIL,
            abi: railAbi,
            functionName: "bountyOf",
            args: [id],
          });
          return { ...b, id } as BountyRow;
        }),
      );
      setBounties(rows);

      if (address) {
        const [p, c, e, d] = await Promise.all([
          client.readContract({ address: RAIL, abi: railAbi, functionName: "payoutOf", args: [address] }),
          client.readContract({ address: RAIL, abi: railAbi, functionName: "credited", args: [address] }),
          client.readContract({ address: RAIL, abi: railAbi, functionName: "earned", args: [address] }),
          client.readContract({ address: RAIL, abi: railAbi, functionName: "milestonesDelivered", args: [address] }),
        ]);
        setMine({ payout: p as Address, credited: c as bigint, earned: e as bigint, delivered: d as bigint });
      }
      setDegraded("");
    } catch (e) {
      setDegraded((e as Error).message.slice(0, 180));
    }
  }, [client, address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(label: string, fn: () => Promise<void>) {
    setError("");
    setNote("");
    setBusy(label);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy("");
    }
  }

  const register = () =>
    run("register", async () => {
      if (!RAIL || !address) return;
      const to = (payout.trim() || address) as Address;
      if (!isAddress(to)) throw new Error("That payout address is not an address.");
      const hash = await writeContractAsync({
        address: RAIL,
        abi: railAbi,
        functionName: "registerAgent",
        args: [to],
        chainId: hederaChain.id,
      });
      await client?.waitForTransactionReceipt({ hash });
      setNote(`Registered. Earnings will be credited to ${to}.`);
    });

  const post = () =>
    run("post", async () => {
      if (!RAIL) return;
      const value = parseEther(reward || "0");
      if (value <= 0n) throw new Error("Escrow something. An unfunded bounty is a wish list entry.");
      if (!task.trim()) throw new Error("Describe the task. Its hash is the commitment.");
      const forVotive = (votive.trim() || ZERO) as Address;
      if (!isAddress(forVotive)) throw new Error("That wish address is not an address.");

      // The description lives off chain; only its hash is escrowed against, so
      // the task can be published anywhere and still be provably the same task.
      const taskHash = keccak256(stringToHex(task.trim()));
      const hash = await writeContractAsync({
        address: RAIL,
        abi: railAbi,
        functionName: "postBounty",
        args: [forVotive, taskHash, taskHash, HOUR * 6n, DAY * 7n],
        value,
        chainId: hederaChain.id,
      });
      await client?.waitForTransactionReceipt({ hash });
      noteTx("bounty-posted", hash, {
        chain: "hedera-testnet",
        detail: `${reward} escrowed`,
        contract: RAIL,
      });
      setNote(`Escrowed ${reward}. An agent may claim it now; you get back whatever is never earned.`);
      setReward("");
      setTask("");
    });

  const claim = (id: bigint) =>
    run(`claim-${id}`, async () => {
      if (!RAIL) return;
      const hash = await writeContractAsync({
        address: RAIL,
        abi: railAbi,
        functionName: "claim",
        args: [id],
        chainId: hederaChain.id,
      });
      await client?.waitForTransactionReceipt({ hash });
      setNote(`Bounty #${id} is yours exclusively until the claim window lapses.`);
    });

  const withdraw = () =>
    run("withdraw", async () => {
      if (!RAIL) return;
      const hash = await writeContractAsync({
        address: RAIL,
        abi: railAbi,
        functionName: "withdraw",
        args: [],
        chainId: hederaChain.id,
      });
      await client?.waitForTransactionReceipt({ hash });
      noteTx("earnings-withdrawn", hash, { chain: "hedera-testnet", contract: RAIL, subject: address });
      setNote("Withdrawn — every milestone credited to you, in one call.");
    });

  if (!RAIL) {
    return (
      <div className="panel" data-testid="rail-unconfigured">
        <h3 style={{ marginTop: 0 }}>No rail on this network</h3>
        <p className="muted" style={{ margin: 0 }}>
          This deployment has no bounty rail configured, so there is nothing to
          escrow against.
        </p>
      </div>
    );
  }

  const fmt = (v: bigint) => Number(formatEther(v)).toLocaleString("en-GB", { maximumFractionDigits: 4 });

  return (
    <div className="stack" data-testid="rail-panel">
      <div className="row" style={{ gap: "1.5rem" }}>
        <div className="panel stat">
          <div className="value" data-testid="rail-escrowed">{fmt(escrowed)}</div>
          <div className="label">held in escrow right now</div>
        </div>
        <div className="panel stat">
          <div className="value">{bounties.filter((b) => !b.closed).length}</div>
          <div className="label">bounties open</div>
        </div>
        <div className="panel stat">
          <div className="value">{mine ? fmt(mine.credited) : "—"}</div>
          <div className="label">credited to you, unwithdrawn</div>
        </div>
      </div>

      {degraded ? (
        <p className="error" data-testid="rail-degraded">
          The rail could not be read — most likely your wallet is not on the Hedera
          network this rail is deployed to. Nothing below would be current: {degraded}
        </p>
      ) : null}

      {!isConnected ? (
        <p className="muted">Connect a wallet to post or claim.</p>
      ) : (
        <>
          {/* The rail is the one thing here that is not on Base Sepolia, so this
              is where a visitor is most likely to be on the wrong network — and
              the reads above will already have failed for the same reason. */}
          <ChainGuard
            chainId={hederaChain.id}
            chainName={hederaChain.name}
            action="use the payments rail"
          >
            <span />
          </ChainGuard>
          <div className="panel stack hoverable">
            <div>
              <h3 style={{ margin: 0 }}>Post a bounty</h3>
              <p className="muted" style={{ margin: "0.3rem 0 0" }}>
                Escrow the reward up front. The task description stays off chain;
                only its hash is committed, so it can be published anywhere and
                still be provably the same task. You reclaim whatever is never
                earned once the lifetime is up.
              </p>
            </div>
            <div className="fieldRow">
              <Field label="What the agent must do">
                <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="Describe the task" data-testid="rail-task" />
              </Field>
              <Field label="Reward to escrow">
                <input type="number" min="0" step="any" value={reward} onChange={(e) => setReward(e.target.value)} placeholder="0.0" data-testid="rail-reward" />
              </Field>
              <Field label="For which wish (optional)">
                <input value={votive} onChange={(e) => setVotive(e.target.value)} placeholder="0x…" data-testid="rail-votive" />
              </Field>
              <button onClick={post} disabled={busy !== ""} data-testid="rail-post">
                {busy === "post" ? "Escrowing…" : "Escrow it"}
              </button>
            </div>
          </div>

          <div className="panel stack hoverable">
            <div>
              <h3 style={{ margin: 0 }}>Be paid as an agent</h3>
              <p className="muted" style={{ margin: "0.3rem 0 0" }}>
                Register where you are paid, claim a task exclusively, and collect
                once an attested milestone releases. Standing is checked when you
                take work on, not when you are paid for it — an agent barred after
                delivering has still delivered.
              </p>
            </div>
            <div className="fieldRow">
              <Field label="Payout address (blank = this wallet)">
                <input value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="0x…" data-testid="rail-payout" />
              </Field>
              <button onClick={register} disabled={busy !== ""} data-testid="rail-register">
                {busy === "register" ? "Registering…" : mine?.payout && mine.payout !== ZERO ? "Change payout" : "Register"}
              </button>
              <button
                className="secondary"
                onClick={withdraw}
                disabled={busy !== "" || !mine || mine.credited === 0n}
                data-testid="rail-withdraw"
              >
                {busy === "withdraw" ? "Withdrawing…" : `Withdraw ${mine ? fmt(mine.credited) : "0"}`}
              </button>
            </div>
            {mine && mine.payout !== ZERO ? (
              <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }} data-testid="rail-mine">
                Paid to <span className="mono">{mine.payout}</span> · {fmt(mine.earned)} earned across{" "}
                {String(mine.delivered)} milestone{mine.delivered === 1n ? "" : "s"}.
              </p>
            ) : null}
          </div>
        </>
      )}

      {bounties.length > 0 ? (
        <div className="panel tableWrap" data-testid="rail-table">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Escrowed</th>
                <th>Paid out</th>
                <th>Agent</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bounties.map((b) => (
                <tr key={String(b.id)}>
                  <td className="mono">{String(b.id)}</td>
                  <td>{fmt(b.total)}</td>
                  <td>{fmt(b.paid)}</td>
                  <td className="mono muted">
                    {b.agent === ZERO ? <span className="badge waiting">unclaimed</span> : `${b.agent.slice(0, 10)}…`}
                  </td>
                  <td>
                    {b.closed ? (
                      <span className="muted">closed</span>
                    ) : b.agent === ZERO && isConnected ? (
                      <button onClick={() => claim(b.id)} disabled={busy !== ""} data-testid={`rail-claim-${b.id}`}>
                        {busy === `claim-${b.id}` ? "Claiming…" : "Claim"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : degraded ? null : (
        <p className="muted">No bounties posted yet.</p>
      )}

      {error ? <p className="error" data-testid="rail-error">{error}</p> : null}
      {note ? <p className="success" data-testid="rail-done">{note}</p> : null}
      {chain && RAIL ? (
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          Rail at <span className="mono">{RAIL}</span>. Releasing a milestone needs
          an attestation against the rail, so it is done by the attestor, not from
          this page — nobody, funder included, can move money the attestor has not
          approved.
        </p>
      ) : null}
    </div>
  );
}
