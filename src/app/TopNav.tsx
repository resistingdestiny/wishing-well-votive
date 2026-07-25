"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NotificationBell } from "./NotificationBell";
import { ConnectButton } from "./ConnectButton";
import { AskTrigger } from "./AskTrigger";
import { SECTIONS, sectionForPath } from "./nav";
import { LogoMark } from "./Logo";

export function TopNav() {
  const pathname = usePathname();
  const active = sectionForPath(pathname);
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <nav className={`topbar${scrolled ? " scrolled" : ""}`}>
      <div className="topbarInner">
        <div className="navPill">
          <Link href="/" className="brand">
            <span className="logoMark">
              <LogoMark size={22} />
            </span>
            <span className="brandName">votive</span>
          </Link>
          <div className="navLinks">
            <Link
              href="/guide"
              className={`navItem${pathname === "/guide" ? " active" : ""}`}
            >
              How it works
            </Link>
            {SECTIONS.map((s) => (
              <Link
                key={s.key}
                href={s.hub}
                className={`navItem${active === s.key ? " active" : ""}`}
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="navPill navActions">
          <AskTrigger pill />
          <NotificationBell />
          <ConnectButton />
          {/* Before the primary call to action, because it is the prerequisite for
              it: a wish is funded in VOTIVE, and an empty wallet cannot make one. */}
          <Link
            href="/faucet"
            className={`pill navFaucet${pathname === "/faucet" ? " active" : ""}`}
          >
            Get VOTIVE
          </Link>
          <Link href="/create" className="pill pillPrimary">
            Make a wish
          </Link>
          <button
            type="button"
            className={`menuBtn${menuOpen ? " open" : ""}`}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </div>
      {menuOpen ? (
        <div className="mobileMenu">
          <Link href="/create" className="pill pillPrimary mobileMenuCta">
            Make a wish
          </Link>
          <Link
            href="/faucet"
            className={`mobileMenuLink${pathname === "/faucet" ? " active" : ""}`}
          >
            Get VOTIVE
          </Link>
          <Link
            href="/guide"
            className={`mobileMenuLink${pathname === "/guide" ? " active" : ""}`}
          >
            How it works
          </Link>
          {SECTIONS.map((s) => (
            <div className="mobileMenuGroup" key={s.key}>
              <div className="mobileMenuKicker">{s.audience}</div>
              <Link
                href={s.hub}
                className={`mobileMenuLink section${active === s.key ? " active" : ""}`}
              >
                {s.label}
              </Link>
              {s.tabs.map((t) => (
                <Link
                  key={t.href}
                  href={t.href}
                  className={`mobileMenuLink sub${pathname === t.href ? " active" : ""}`}
                >
                  {t.label}
                </Link>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
