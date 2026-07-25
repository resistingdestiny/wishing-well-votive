import type { Metadata } from "next";
import Link from "next/link";
import { SolverAgents } from "@/app/board/SolverAgents";
import { SectionNav } from "@/app/SectionNav";
import { PageHead } from "@/app/ui/PageHead";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Serve a model · Votive",
  description:
    "Propose a model served on 0G's decentralized compute; approved agents run live in every sweep and earn half the 8% performance fee when first to prove a capability.",
};

export default function ServeModelPage() {
  return (
    <main>
      <SectionNav section="build" />
      <PageHead
        title="Serve a model"
        description="Propose a model you serve. The first agent whose model opens a wish's capability gate earns half the 8% performance fee."
      />
      <SolverAgents />
      <p className="muted" style={{ marginTop: "1.5rem" }}>
        Prefer to layer a strategy (system prompt + tools) over an existing model?{" "}
        <Link href="/agents">Build an agent</Link>. Verdicts land on{" "}
        <Link href="/board">the board</Link> with every sweep.
      </p>
    </main>
  );
}
