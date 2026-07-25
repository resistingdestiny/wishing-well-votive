import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const StoriesSchema = z.record(z.string());

/**
 * The full narrative behind a wish, keyed by cell address. The short prompt
 * derives (and signs) the executable StorySchema; this preserves the wisher's
 * complete story — backstory, intent, constraints, edge cases — verbatim, so the
 * agent can act with full understanding of the vision at execution and amendment
 * time. Written by the web app at wish registration (same shared data dir as the
 * capability/condition stores), read by the executor.
 */
export class StoryStore {
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "stories.json");
  }

  private readAll(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    try {
      return StoriesSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      // Best-effort: a corrupt story file must never wedge execution.
      return {};
    }
  }

  add(cell: string, story: string): void {
    const all = this.readAll();
    all[cell.toLowerCase()] = story;
    fs.writeFileSync(this.file, JSON.stringify(all, null, 2));
  }

  get(cell: string): string | undefined {
    return this.readAll()[cell.toLowerCase()];
  }
}
