"use client";

import { useState } from "react";
import { useAccount, useConnect } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";

async function fetchWatches(subscriber: string): Promise<{ kind: string; target: string }[]> {
  const res = await fetch(`/api/watch?subscriber=${subscriber}`);
  if (!res.ok) return [];
  return (await res.json()).watches ?? [];
}

export function WatchButton({
  kind,
  target,
  label,
}: {
  kind: "cell" | "capability";
  target: string;
  label?: string;
}) {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const subscriber = address?.toLowerCase();
  const targetLower = target.toLowerCase();

  const { data: watches } = useQuery({
    queryKey: ["watches", subscriber],
    queryFn: () => fetchWatches(subscriber!),
    enabled: !!subscriber,
  });

  const watching = !!watches?.some((w) => w.kind === kind && w.target === targetLower);

  async function toggle() {
    if (!subscriber || busy) return;
    setBusy(true);
    setErr(false);
    try {
      const res = await fetch("/api/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscriber, kind, target: targetLower, watching: !watching }),
      });
      if (!res.ok) throw new Error("watch failed");
      await qc.invalidateQueries({ queryKey: ["watches", subscriber] });
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  }

  if (!isConnected) {
    const c = connectors[0];
    return (
      <button
        className="secondary"
        onClick={() => c && connect({ connector: c })}
        data-testid="watch-button"
      >
        Connect to watch
      </button>
    );
  }

  return (
    <button
      className={watching ? "secondary watching" : "secondary"}
      onClick={toggle}
      disabled={busy}
      title={err ? "Something went wrong. Try again" : undefined}
      data-testid="watch-button"
    >
      {busy ? "…" : watching ? "✓ Watching" : err ? "Retry" : (label ?? "Watch")}
    </button>
  );
}
