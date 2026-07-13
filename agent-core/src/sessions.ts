/**
 * Sessions / projects / conversation persistence (port of the state that used
 * to live under src-tauri/src/main.rs). Simple JSON files under the config dir.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./paths.js";
import { atomicWrite } from "./settings.js";

function sessionsDir(): string {
  const p = join(configDir(), "sessions");
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

export interface SessionMeta {
  id: string;
  title?: string;
  created_at: number;
  updated_at: number;
  message_count: number;
}

export function listSessions(): SessionMeta[] {
  const dir = sessionsDir();
  const out: SessionMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        id?: string;
        title?: string;
        created_at?: number;
        updated_at?: number;
        messages?: unknown[];
      };
      out.push({
        id: raw.id ?? name.replace(/\.json$/, ""),
        title: raw.title,
        created_at: raw.created_at ?? raw.updated_at ?? 0,
        updated_at: raw.updated_at ?? 0,
        message_count: Array.isArray(raw.messages) ? raw.messages.length : 0,
      });
    } catch {
      /* skip corrupt */
    }
  }
  // Order by creation time (descending) so opening a session does not reorder the list.
  out.sort((a, b) => b.created_at - a.created_at);
  return out;
}

export function loadSession(id: string): unknown {
  const p = join(sessionsDir(), `${id}.json`);
  if (!existsSync(p)) return { id, messages: [], updated_at: 0 };
  return JSON.parse(readFileSync(p, "utf8"));
}

export function saveSession(id: string, messages: unknown[], title?: string): void {
  const p = join(sessionsDir(), `${id}.json`);
  // Preserve the original creation time so opening/updating a session never changes its order.
  let created_at = Date.now();
  if (existsSync(p)) {
    try {
      const prev = JSON.parse(readFileSync(p, "utf8")) as { created_at?: number; updated_at?: number };
      created_at = prev.created_at ?? prev.updated_at ?? created_at;
    } catch {
      /* fall back to now */
    }
  }
  atomicWrite(p, JSON.stringify({ id, title, messages, created_at, updated_at: Date.now() }, null, 2));
}

export function deleteSession(id: string): boolean {
  const p = join(sessionsDir(), `${id}.json`);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

// --- projects & conversation (single files under config dir) ----------------

function projectsPath(): string {
  return join(configDir(), "projects.json");
}
function conversationPath(): string {
  return join(configDir(), "conversation.json");
}

export function listProjects(): unknown[] {
  if (!existsSync(projectsPath())) return [];
  try {
    return JSON.parse(readFileSync(projectsPath(), "utf8"));
  } catch {
    return [];
  }
}

export function saveProjects(projects: unknown[]): void {
  atomicWrite(projectsPath(), JSON.stringify(projects, null, 2));
}

export function loadConversation(): unknown {
  if (!existsSync(conversationPath())) return { messages: [] };
  try {
    return JSON.parse(readFileSync(conversationPath(), "utf8"));
  } catch {
    return { messages: [] };
  }
}

export function saveConversation(payload: unknown): void {
  atomicWrite(conversationPath(), JSON.stringify(payload, null, 2));
}
