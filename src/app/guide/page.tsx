import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/app/ui/PageHead";
import { SECTIONS } from "@/app/nav";

export const metadata: Metadata = {
  title: "How Votive works",
  description:
    "Park crypto against a job today's AI can't do yet, and set up your first wish in four steps.",
};

export default function GuidePage() {
  return (
    <main>
      <PageHead
        title="How Votive works"
        description="Give an AI agent two things: a story, and the resources to act on it. If it can act today, it starts. If it can't, the wish goes dormant in its own segregated cell and tests itself against every major model release. The moment it passes, it wakes and executes with your resources plus the well's shared pool of capital, compute, and API keys."
      />
      <p className="feeNote">
        2% a year on parked funds · 8% of realised proceeds above principal, at
        resolution · no other charges, enforced by your wish&rsquo;s own cell
        contract. v1 runs on Base Sepolia (testnet).
      </p>

      <div className="guide-points">
        <div className="guide-point">
          <div className="chip">✎</div>
          <strong>Say it in plain language</strong>
          <p>The agent parses your story into a signed schema. You fund exactly that schema. Execution never runs off raw prose.</p>
        </div>
        <div className="guide-point">
          <div className="chip">◇</div>
          <strong>The frontier keeps trying</strong>
          <p>Every capability sweep tests the newest models against your wish. It fulfils only when one passes on three consecutive sweeps.</p>
        </div>
        <div className="guide-point">
          <div className="chip">▨</div>
          <strong>Your own segregated cell</strong>
          <p>One contract per wish. Funds are never pooled; fees can never exceed the schedule; you can amend or reclaim per your policy.</p>
        </div>
      </div>

      <h2>Set up a wish, step by step</h2>
      <p className="muted" style={{ maxWidth: "62ch", marginTop: "-0.4rem" }}>
        This is the real <Link href="/create">Make a wish</Link> flow: four steps,
        about two minutes plus one wallet confirmation.
      </p>
      <div className="guide-points">
        <div className="guide-point">
          <strong>1 · Your wish</strong>
          <p>
            Say it in plain language: what to hold, until what, then what happens. Stuck?
            Pick a starter wish and shape it. The agent parses your story into a
            machine-readable schema.
          </p>
        </div>
        <div className="guide-point">
          <strong>2 · Review &amp; terms</strong>
          <p>
            Check what the agent derived (the capability to prove, the resolution
            condition, the amendment policy) and set the terms: seal it irrevocable,
            make the payout a transferable NFT, or name a fallback heir.
          </p>
        </div>
        <div className="guide-point">
          <strong>3 · Fund it</strong>
          <p>
            From a wallet in ETH or a whitelisted token, or with ordinary money
            by card or bank transfer. No wallet needed for the last one.
          </p>
        </div>
        <div className="guide-point">
          <strong>4 · The wait</strong>
          <p>
            Your wish sits in its own segregated cell. Every new model release re-tests
            it, free and automatic. It fulfils the moment one passes on three
            consecutive sweeps.
          </p>
        </div>
      </div>
      <div className="row" style={{ marginTop: "1.25rem" }}>
        <Link href="/create" className="pill pillPrimary">
          Make a wish →
        </Link>
      </div>

      <h2>Two ways to fund</h2>
      <div className="guide-points">
        <div className="guide-point">
          <strong>With a wallet</strong>
          <p>
            Fund with ETH or a whitelisted token like USDC from a browser wallet on Base Sepolia.
            You sign the schema by sending the funding transaction yourself.{" "}
            <Link href="/create">Make a wish →</Link>
          </p>
        </div>
        <div className="guide-point">
          <strong>With ordinary money</strong>
          <p>
            No wallet? Fund by simulated bank transfer or card. It lands as USDC in a segregated
            cell held behind your email. No keys to manage.{" "}
            <Link href="/fund">Fund with money →</Link>
          </p>
        </div>
      </div>

      <h2>After you fund</h2>
      <div className="guide-points">
        <div className="guide-point">
          <strong>It waits, and you watch</strong>
          <p>
            Follow your wish on its cell page or under <Link href="/mine">Your wishes</Link>,
            and see the whole frontier move on the <Link href="/board">backlog board</Link> and the{" "}
            <Link href="/frontier">Frontier Report</Link>.
          </p>
        </div>
        <div className="guide-point">
          <strong>You stay in control</strong>
          <p>
            Amend the schema with your signature at any time, or a named guardian can redirect it
            after a long silence. Nothing moves outside the policy you signed.
          </p>
        </div>
        <div className="guide-point">
          <strong>When it resolves</strong>
          <p>
            Proceeds go where your story says: back to you, to named beneficiaries who claim their
            share with a private invitation, or an off-chain action, net of the transparent fees.
          </p>
        </div>
      </div>

      <h2>Where to go from here</h2>
      <div className="pathGrid" data-stagger>
        {SECTIONS.map((s) => (
          <Link key={s.key} href={s.hub} className="pathCard">
            <span className="pathName">
              {s.label}
              <span className="pathArrow" aria-hidden="true">
                →
              </span>
            </span>
            <p>
              <strong>{s.audience}.</strong> {s.lede}
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}
