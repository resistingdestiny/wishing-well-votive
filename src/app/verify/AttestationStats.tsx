import type { SignedRunLogEntry } from "@/core/runlog/verify";

export function AttestationStats({ entries }: { entries: SignedRunLogEntry[] }) {
  const models = new Set(entries.map((e) => e.entry.model)).size;
  const capabilities = new Set(
    entries.map((e) => e.entry.capabilityId).filter(Boolean),
  ).size;
  return (
    <div className="kpiRow">
      <div className="panel stat">
        <div className="value" data-count={entries.length}>{entries.length}</div>
        <div className="label">signed checks recorded</div>
      </div>
      <div className="panel stat">
        <div className="value" data-count={models}>{models}</div>
        <div className="label">models on the record</div>
      </div>
      <div className="panel stat">
        <div className="value" data-count={capabilities}>{capabilities}</div>
        <div className="label">capabilities tested</div>
      </div>
    </div>
  );
}
