export interface MyCell {
  cell: string;
  label: string;
  ts: number;
  source: "fund" | "create";
}

const KEY = "votive.my-cells";
const CAP = 50;

export function readMyCells(): MyCell[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is MyCell =>
        !!x && typeof x === "object" && typeof x.cell === "string" && x.cell.length > 0,
    );
  } catch {
    return [];
  }
}

export function addMyCell(c: Omit<MyCell, "ts">): void {
  if (typeof window === "undefined") return;
  try {
    const cur = readMyCells().filter(
      (x) => x.cell.toLowerCase() !== c.cell.toLowerCase(),
    );
    cur.unshift({ ...c, ts: Date.now() });
    window.localStorage.setItem(KEY, JSON.stringify(cur.slice(0, CAP)));
  } catch {

  }
}
