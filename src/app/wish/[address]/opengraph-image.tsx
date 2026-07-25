import { ImageResponse } from "next/og";
import { isAddress, getAddress } from "viem";
import { readCell, cellNumber } from "@/lib/chain";
import { prisma } from "@/lib/db";
import { eth } from "@/lib/format";

export const runtime = "nodejs";
export const alt = "A position in Votive";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: { address: string } }) {
  let tag = "A position";
  let summary = "";
  let prose = "";
  let parked = "";
  let state = "";

  if (isAddress(params.address)) {
    try {
      const address = getAddress(params.address);
      const [num, cell, story] = await Promise.all([
        cellNumber(address).catch(() => 0),
        readCell(address),
        prisma.story.findUnique({ where: { cell: address } }).catch(() => null),
      ]);
      tag = num > 0 ? `Position #${String(num).padStart(4, "0")}` : "A position";
      state = cell.stateName;
      parked = eth(cell.balance, 3);
      summary =
        (story?.parsed as { capability?: { summary?: string } })?.capability?.summary ??
        cell.kindName;
      prose = story?.prose ?? "";
    } catch {

    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(135deg, #0b0e14 0%, #101827 60%, #17233b 100%)",
          color: "#f4f5f7",
          padding: "64px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          <div
            style={{
              width: "64px",
              height: "64px",
              borderRadius: "999px",
              background: "linear-gradient(135deg, #dbeafe 0%, #60a5fa 35%, #2563eb 70%, #1e3a8a 100%)",
            }}
          />
          <div style={{ fontSize: "30px", letterSpacing: "2px", color: "#9099a6" }}>
            VOTIVE
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ fontSize: "68px", fontWeight: 700 }}>{tag}</div>
          <div style={{ fontSize: "34px", color: "#cbd5e1" }}>{summary.slice(0, 90)}</div>
          {prose ? (
            <div style={{ fontSize: "26px", color: "#8b95a5" }}>
              {`“${prose.slice(0, 150)}${prose.length > 150 ? "…" : ""}”`}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "16px", fontSize: "30px" }}>
          <div style={{ fontWeight: 700, color: "#60a5fa" }}>{`${parked || "-"} parked`}</div>
          {state ? (
            <div
              style={{
                display: "flex",
                padding: "6px 18px",
                borderRadius: "999px",
                background: "rgba(96,165,250,0.16)",
                color: "#93c5fd",
              }}
            >
              {state}
            </div>
          ) : null}
        </div>
      </div>
    ),
    size,
  );
}
