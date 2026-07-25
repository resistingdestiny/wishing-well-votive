"use client";

import Link from "next/link";
import { SECTIONS } from "./nav";

export function AppFooter() {
  return (
    <footer className="appFooter" data-testid="app-footer">
      <div className="footerGrid">
        <div className="footerCol">
          <div className="footerHead">Product</div>
          <Link href="/create">Make a wish</Link>
          <Link href="/fund">Fund with money</Link>
          <Link href="/guide">How it works</Link>
        </div>
        {SECTIONS.map((s) => (
          <div className="footerCol" key={s.key}>
            <div className="footerHead">{s.audience}</div>
            {s.tabs.map((t) => (
              <Link key={t.href} href={t.href}>
                {t.label}
              </Link>
            ))}
          </div>
        ))}
        <div className="footerCol">
          <div className="footerHead">Votive</div>
          <p className="footerFine">
            2%/yr streams on parked funds · 8% of realised proceeds above principal,
            at resolution, both encoded on chain. No other charges.
            <br />
            Base Sepolia testnet, no real funds.
          </p>
        </div>
      </div>
    </footer>
  );
}
