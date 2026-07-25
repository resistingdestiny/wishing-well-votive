import { ImageResponse } from "next/og";
import { readSignedRunLog } from "@/lib/runlog";
import { buildFrontierReport } from "@/core/frontier/report";

export const runtime = "nodejs";
export const alt = "The Frontier Report · Votive";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

function Stat({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: 84, fontWeight: 700, color }}>{value}</div>
      <div style={{ display: "flex", fontSize: 26, color: "#8ea2c8" }}>{label}</div>
    </div>
  );
}

export default async function Image() {
  let r;
  try {
    r = buildFrontierReport(readSignedRunLog());
  } catch {
    r = null;
  }
  const cleared = String(r?.totals.cleared ?? 0);
  const backlog = String(r?.totals.backlog ?? 0);
  const median = r?.medianSweepsToUnlock != null ? String(r.medianSweepsToUnlock) : "-";
  const latestFlip = r?.flips[0]?.summary;
  const footer = latestFlip ? `Just unlocked: ${latestFlip}` : "Signed, hash-chained, on-chain-attested.";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(135deg, #0b1020 0%, #131a33 100%)",
          color: "#e8ecf6",
          padding: "64px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 30, color: "#8ea2c8" }}>VOTIVE</div>
          <div style={{ display: "flex", fontSize: 68, fontWeight: 700, marginTop: 8 }}>
            The Frontier Report
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "row", gap: 48 }}>
          <Stat value={cleared} label="unlocked" color="#7ee0a2" />
          <Stat value={backlog} label="still out of reach" color="#f0b46b" />
          <Stat value={median} label="median sweeps to unlock" color="#e8ecf6" />
        </div>
        <div style={{ display: "flex", fontSize: 30, color: "#b8c4de" }}>{footer}</div>
      </div>
    ),
    size,
  );
}
