/**
 * Cross-session memory (port of src-tauri/src/memory.rs).
 * Two-tier: daily logs at memory/YYYY-MM-DD.md, curated MEMORY.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./paths.js";

function memoryDir(base: string): string {
  return join(base, "memory");
}
export function memoryFile(base: string): string {
  return join(base, "MEMORY.md");
}

function ymd(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function dailyLogPath(base: string, daysAgo: number): string {
  return join(memoryDir(base), `${ymd(daysAgo)}.md`);
}

export function appendDailyLog(base: string, entry: string): void {
  const dir = memoryDir(base);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  const path = dailyLogPath(base, 0);
  const now = new Date();
  const hh = now.getUTCHours().toString().padStart(2, "0");
  const mm = now.getUTCMinutes().toString().padStart(2, "0");
  const line = `- ${hh}:${mm} UTC — ${entry.replace(/\n/g, " ")}\n`;
  try {
    if (existsSync(path)) {
      writeFileSync(path, readFileSync(path, "utf8") + line);
    } else {
      writeFileSync(path, `# Daily log ${ymd(0)}\n\n${line}`);
    }
  } catch {
    /* best-effort */
  }
}

export function readStartupMemory(base: string): string {
  const parts: string[] = [];
  try {
    const mem = readFileSync(memoryFile(base), "utf8").trim();
    if (mem.length) parts.push(`# Long-term memory (MEMORY.md)\n${mem}`);
  } catch {
    /* absent */
  }
  for (const daysAgo of [0, 1]) {
    try {
      const log = readFileSync(dailyLogPath(base, daysAgo), "utf8").trim();
      if (log.length) parts.push(log);
    } catch {
      /* absent */
    }
  }
  return parts.join("\n---\n");
}

export function getMemory(base: string = configDir()): string {
  try {
    return readFileSync(memoryFile(base), "utf8");
  } catch {
    return "";
  }
}

export function saveMemory(content: string, base: string = configDir()): void {
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  writeFileSync(memoryFile(base), content);
}
