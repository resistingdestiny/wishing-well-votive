"use client";

import { useState } from "react";

export function ShareButton() {
  const [done, setDone] = useState(false);
  return (
    <button
      className="secondary"
      data-testid="share-button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(window.location.href);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {

        }
      }}
    >
      {done ? "✓ Link copied" : "Share"}
    </button>
  );
}
