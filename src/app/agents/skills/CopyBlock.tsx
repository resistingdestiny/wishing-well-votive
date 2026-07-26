"use client";

/**
 * A code block a builder can take away in one click.
 *
 * Copying matters more here than anywhere else on the site: these blocks are
 * install commands and calldata, and a sample retyped by hand is a sample with a
 * typo in it. The button reports what it actually did — a clipboard write can be
 * refused by the browser (insecure origin, denied permission), and a button that
 * says "Copied ✓" over a failed write is a small lie with an expensive
 * consequence.
 */
import { useState } from "react";

type CopyState = "idle" | "copied" | "failed";

export function CopyBlock({
  code,
  title,
  language,
  note,
  testId,
}: {
  code: string;
  title?: string;
  language?: string;
  note?: string;
  testId?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2200);
  }

  return (
    <div className="stack" style={{ gap: "0.4rem" }} data-testid={testId}>
      {title ? (
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <strong style={{ fontSize: "0.85rem" }}>{title}</strong>
          {language ? (
            <span className="mono muted" style={{ fontSize: "0.7rem" }}>
              {language}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="codeCard">
        <button type="button" className="btnGhost btnSm copyBtn" onClick={copy}>
          {state === "copied" ? "Copied ✓" : state === "failed" ? "Copy failed" : "Copy"}
        </button>
        <pre>{code}</pre>
      </div>
      {note ? (
        <p className="muted" style={{ margin: 0, fontSize: "0.8rem", maxWidth: "72ch" }}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
