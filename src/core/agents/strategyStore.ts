import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AgentStrategySchema, strategyId, type AgentStrategy } from "./strategy.js";

const FileSchema = z.object({ agents: z.array(AgentStrategySchema).default([]) });

export class StrategyStore {
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "agent-strategies.json");
  }

  private read(): AgentStrategy[] {
    if (!fs.existsSync(this.file)) return [];
    return FileSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8"))).agents;
  }

  private write(agents: AgentStrategy[]): void {
    fs.writeFileSync(this.file, JSON.stringify({ agents }, null, 2) + "\n");
  }

  propose(input: Omit<AgentStrategy, "id" | "status">): AgentStrategy {
    const id = strategyId(input.displayName, input.baseModel);
    const record = AgentStrategySchema.parse({ ...input, id, status: "proposed" as const });
    const list = this.read();
    const idx = list.findIndex((a) => a.id === id);
    if (idx >= 0) list[idx] = record;
    else list.push(record);
    this.write(list);
    return record;
  }

  list(): AgentStrategy[] {
    return this.read();
  }

  get(id: string): AgentStrategy | undefined {
    return this.read().find((a) => a.id === id);
  }

  setStatus(id: string, status: AgentStrategy["status"]): AgentStrategy | undefined {
    const list = this.read();
    const a = list.find((x) => x.id === id);
    if (!a) return undefined;
    a.status = status;
    this.write(list);
    return a;
  }
}
