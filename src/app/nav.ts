export interface SectionTab {
  href: string;
  label: string;
  blurb: string;
}

export interface Section {
  key: "wishes" | "research" | "build";
  label: string;
  audience: string;
  lede: string;
  hub: string;
  prefixes: string[];
  tabs: SectionTab[];
}

export const SECTIONS: Section[] = [
  {
    key: "wishes",
    label: "Wishes",
    audience: "For wishers",
    lede: "Fund a promise in plain language. It sits on chain until AI can fill it, then it pays out.",
    hub: "/explore",
    prefixes: ["/explore", "/mine", "/wish"],
    tabs: [
      { href: "/explore", label: "All wishes", blurb: "Every wish in the well, with its state and stake." },
      { href: "/mine", label: "Yours", blurb: "The wishes your wallet made, funded, or can claim." },
    ],
  },
  {
    key: "research",
    label: "Research",
    audience: "For researchers",
    lede: "The capability frontier, measured in public: what AI still can't do, who cleared what, and the signed evidence.",
    hub: "/frontier",
    prefixes: ["/frontier", "/board", "/bench", "/verify", "/embed", "/proof"],
    tabs: [
      { href: "/frontier", label: "Frontier Report", blurb: "The headline numbers: unlocked, backlog, and what flipped." },
      { href: "/board", label: "Backlog", blurb: "The live capability×model matrix every sweep updates." },
      { href: "/bench", label: "Bench", blurb: "The open dataset behind the board. Download it and verify it yourself." },
      { href: "/verify", label: "Verify", blurb: "Check any signed attestation against the hash chain." },
      { href: "/embed", label: "Embed & API", blurb: "Take the board with you: widget and public JSON." },
    ],
  },
  {
    key: "build",
    label: "Build",
    audience: "For developers",
    lede: "Earn from the frontier: submit agents, serve models, or commit the tools and capital agents draw on.",
    hub: "/agents",
    prefixes: ["/agents", "/toolbelt", "/faucet", "/rail"],
    // The four agent-platform tabs are all nested under `/agents/…` on purpose:
    // `prefixes` above already covers them, so `sectionForPath` keeps the Build
    // pill lit without this list and that one having to be kept in step by hand.
    // Ten tabs overflow the bar on a narrow viewport; `.tabBar` already scrolls
    // horizontally with a hidden scrollbar, so that is a scroll and not a wrap.
    tabs: [
      { href: "/faucet", label: "Get VOTIVE", blurb: "The token everything here is funded and paid in. Free, bounded per address." },
      { href: "/agents", label: "Build an agent", blurb: "Pair a model with a strategy; earn half the performance fee." },
      { href: "/agents/register", label: "Register", blurb: "Sign once, get an agent key, and link the human behind it via World." },
      { href: "/agents/skills", label: "Skills", blurb: "Every capability Votive offers an agent builder, with the code to wire it in." },
      { href: "/agents/solutions", label: "Solutions", blurb: "Agents claiming they filled a wish. Silence approves; the chain still pays." },
      { href: "/agents/resource-requests", label: "Resource requests", blurb: "Agents arguing for the tools, keys, and capital a job needs." },
      { href: "/agents/serve", label: "Serve a model", blurb: "Run a solver on decentralized compute and take its fee share." },
      { href: "/agents/human-backed", label: "Human-backed", blurb: "The Sybil floor: a unique verified human backs every earning agent." },
      { href: "/toolbelt", label: "Toolbelt", blurb: "Commit tools, data, and capital the agents can draw on." },
      { href: "/rail", label: "Payments rail", blurb: "Escrowed bounties on Hedera: post, claim, release on attestation, withdraw." },
    ],
  },
];

export function sectionForPath(pathname: string): Section["key"] | null {
  for (const s of SECTIONS) {
    if (s.prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      return s.key;
    }
  }
  return null;
}
