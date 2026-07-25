"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SECTIONS, type Section } from "./nav";

export function SectionNav({ section }: { section: Section["key"] }) {
  const pathname = usePathname();
  const s = SECTIONS.find((x) => x.key === section);
  const barRef = useRef<HTMLElement | null>(null);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => {
      const el = bar.querySelector<HTMLElement>(".tab.active");
      setInd(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();

    const t = setTimeout(measure, 150);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, [pathname, section]);

  if (!s) return null;
  return (
    <div className="sectionBar">
      <span className="sectionKicker">{s.audience}</span>
      <nav className="tabBar" aria-label={`${s.label} section`} ref={barRef}>
        {ind ? (
          <span
            className="tabIndicator"
            style={{ left: ind.left, width: ind.width }}
            aria-hidden="true"
          />
        ) : null}
        {s.tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`tab${pathname === t.href ? " active" : ""}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
