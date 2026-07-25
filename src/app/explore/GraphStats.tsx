import { graphWellStats } from "@/lib/graph";
import { eth } from "@/lib/format";

export async function GraphStats() {
  const stats = await graphWellStats();
  if (!stats) return null;

  return (
    <div className="panel" data-testid="graph-stats">
      <span className="muted">
        All-time, indexed by The Graph (block #{stats.block}):{" "}
      </span>
      {stats.fulfilledCount} fulfilled · {stats.amendedCount} amended ·{" "}
      {stats.escheatedCount} escheated · {stats.attestationCount} attestations ·{" "}
      {eth(stats.totalStreamFeesCollected, 6)} stream fees collected ·{" "}
      {eth(stats.totalPerfFeesTaken, 6)} performance fees taken
    </div>
  );
}
