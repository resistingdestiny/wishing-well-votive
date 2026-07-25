import { entryCostUsd } from "../models/costLedger.js";
import type { ModelRegistry } from "../models/registry.js";
import type { RunLogEntry } from "../runlog/verify.js";

export interface ResourceAttribution {
  id: string;

  consults: number;

  cells: string[];

  usd: number;
}

interface AttemptDetail {
  resourceIds?: unknown;
}
interface ConsultNoteDetail {
  resourcesConsulted?: unknown;
}

function idsFrom(entry: RunLogEntry): string[] {
  const d = entry.detail as AttemptDetail | null | undefined;
  if (!d || !Array.isArray(d.resourceIds)) return [];
  return d.resourceIds.filter((x): x is string => typeof x === "string");
}

function idsFromConsultNote(entry: RunLogEntry): string[] {
  const d = entry.detail as ConsultNoteDetail | null | undefined;
  if (!d || !Array.isArray(d.resourcesConsulted)) return [];
  return (d.resourcesConsulted as unknown[])
    .map((x) => (x && typeof x === "object" ? (x as { id?: unknown }).id : undefined))
    .filter((x): x is string => typeof x === "string");
}

export function computeResourceAttribution(
  entries: RunLogEntry[],
  opts?: {
    registry?: ModelRegistry;

    strategyResources?: (model: string) => string[] | undefined;
  },
): Map<string, ResourceAttribution> {
  const out = new Map<string, ResourceAttribution>();
  const touch = (id: string, cell?: string): ResourceAttribution => {
    let a = out.get(id);
    if (!a) {
      a = { id, consults: 0, cells: [], usd: 0 };
      out.set(id, a);
    }
    a.consults += 1;
    if (cell && !a.cells.includes(cell)) a.cells.push(cell);
    return a;
  };

  for (const e of entries) {
    if (e.kind === "fulfilment-attempt") {
      let ids = idsFrom(e);
      if (!ids.length && opts?.strategyResources) {
        ids = opts.strategyResources(e.model) ?? [];
      }
      if (!ids.length) continue;
      const share = entryCostUsd(e, opts?.registry) / ids.length;
      for (const id of ids) {
        const a = touch(id, e.cell);
        a.usd += share;
      }
    } else if (e.kind === "sweep-note") {
      for (const id of idsFromConsultNote(e)) touch(id, e.cell);
    }
  }
  return out;
}
