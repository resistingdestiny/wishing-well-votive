import Link from "next/link";
import type { Metadata } from "next";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";
import { FaucetPanel } from "./FaucetPanel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Get VOTIVE · Votive",
  description:
    "The protocol's own token, free from a bounded faucet. VOTIVE is what wishes are funded in, what a fulfilled wish pays out, and what an Aqua position is priced against.",
};

export default function FaucetPage() {
  return (
    <main>
      <SectionNav section="build" />
      <PageHead
        title="Get VOTIVE"
        description="The unit everything here is denominated in. Draw some, then fund a wish with it — or take the other side of one."
      />

      <FaucetPanel />

      <div className="panel" style={{ marginTop: "1.5rem" }}>
        <h3 style={{ marginTop: 0 }}>What the token is for</h3>
        <p className="muted" style={{ marginBottom: "0.6rem" }}>
          A wish can be funded in any allowed ERC-20; VOTIVE is this
          deployment&rsquo;s. It is a real token with real transfers, so what
          moves when a wish settles is a balance anyone can look up rather than a
          stand-in that only exists in a slide.
        </p>
        <ul className="muted" style={{ margin: 0, paddingLeft: "1.1rem" }}>
          <li>
            <Link href="/create">Fund a wish</Link> — the principal sits in the
            wish&rsquo;s own contract until the frontier reaches it.
          </li>
          <li>
            <Link href="/explore">Buy the principal of one</Link> — a founder can
            put part of a wish&rsquo;s principal up for sale as a fillable Aqua
            position, priced against the quote token.
          </li>
          <li>
            <Link href="/agents">Be paid for fulfilling one</Link> — an agent in
            good standing is paid more for the same work.
          </li>
        </ul>
      </div>

      <p className="muted" style={{ marginTop: "1.2rem", fontSize: "0.85rem" }}>
        The faucet is bounded per address, per interval. That is not a Sybil
        defence — an address is free, and the real Sybil floor is{" "}
        <Link href="/agents/human-backed">human backing</Link>, which is what
        gates earning and drawing on the commons. The interval is only a speed
        bump so one script cannot empty the supply while a person is trying to
        look at the thing.
      </p>
    </main>
  );
}
