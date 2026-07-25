"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface AskResult {
  label: string;
  href?: string;
}
interface AskAnswer {
  answer: string;
  cite?: string;
  results: AskResult[];
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [data, setData] = useState<AskAnswer | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("ask:open", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("ask:open", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ask?q=${encodeURIComponent(q)}`);
        if (res.ok) setData(await res.json());
      } catch {

      }
    }, 180);
    return () => clearTimeout(t);
  }, [q, open]);

  const results = data?.results ?? [];
  useEffect(() => setActive(0), [data]);

  if (!open) return null;

  const go = (href?: string) => {
    if (!href) return;
    setOpen(false);
    router.push(href);
  };

  const activate = (r: AskResult) => {
    if (r.href) go(r.href);
    else setQ(r.label);
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (!results.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + delta + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[Math.min(active, results.length - 1)];
      if (r) activate(r);
    }
  };

  return (
    <div className="paletteBackdrop" onMouseDown={close} data-testid="command-palette">
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="paletteInput"
          placeholder="Ask the well: what's parked? what has a model unlocked?"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onInputKey}
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="palette-results"
          aria-activedescendant={results.length ? `palette-result-${active}` : undefined}
          data-testid="palette-input"
        />
        {data ? (
          <div className="paletteBody">
            <div className="paletteAnswer">{data.answer}</div>
            {data.cite ? <div className="paletteCite">· {data.cite}</div> : null}
            {results.length > 0 ? (
              <ul className="paletteResults" id="palette-results" role="listbox">
                {results.map((r, i) => (
                  <li key={i} id={`palette-result-${i}`} role="option" aria-selected={i === active}>
                    {r.href ? (
                      <button
                        className={`paletteResult${i === active ? " active" : ""}`}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => go(r.href)}
                      >
                        {r.label}
                      </button>
                    ) : (
                      <button
                        className={`paletteResult muted${i === active ? " active" : ""}`}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => setQ(r.label)}
                      >
                        {r.label}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="paletteFoot">Read-only · every answer is grounded in the run log · ↑↓ to choose · Enter to open · Esc to close</div>
      </div>
    </div>
  );
}
