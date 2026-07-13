/**
 * A2A (agent-to-agent) bridge (port of src-tauri/src/agent/a2a.rs).
 * Discovers remote agent cards, derives one callable tool per skill (namespaced
 * <conn>__<skill>, 64-char safe), and delegates via JSON-RPC message/send.
 */
import { httpFetch as fetch } from "./http.js";
import type { A2aConnection } from "./settings.js";

export interface A2aTool {
  tool_name: string;
  connection_id: string;
  endpoint: string;
  token: string;
  skill_id: string;
  description: string;
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "_");
}

/** FNV-1a 32-bit hash rendered as 8 hex chars. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function makeToolName(connId: string, skillId: string): string {
  const prefix = sanitize(connId).slice(0, 8);
  const skill = sanitize(skillId);
  const name = `${prefix}__${skill}`;
  if (name.length <= 64) return name;
  const hash = shortHash(skillId);
  const headBudget = 64 - prefix.length - 2 - 1 - 8;
  return `${prefix}__${skill.slice(0, headBudget)}_${hash}`;
}

export async function fetchCard(endpoint: string, token: string): Promise<unknown> {
  const url = endpoint.replace(/\/$/, "") + "/.well-known/agent-card.json";
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`agent-card ${r.status}`);
  return r.json();
}

export function toolsFromCard(conn: A2aConnection, card: unknown): A2aTool[] {
  const c = card as { url?: string; endpoint?: string; skills?: Array<Record<string, unknown>> };
  const cardEndpoint =
    typeof c.url === "string" && c.url.trim() ? c.url.trim() :
    typeof c.endpoint === "string" && c.endpoint.trim() ? c.endpoint.trim() :
    conn.endpoint;
  const out: A2aTool[] = [];
  for (const skill of c.skills ?? []) {
    const skillId =
      (typeof skill.id === "string" ? skill.id : undefined) ??
      (typeof skill.name === "string" ? skill.name : undefined) ??
      "";
    if (!skillId || conn.disabled_skills.includes(skillId)) continue;
    out.push({
      tool_name: makeToolName(conn.id, skillId),
      connection_id: conn.id,
      endpoint: cardEndpoint,
      token: conn.token,
      skill_id: skillId,
      description: typeof skill.description === "string" ? skill.description : "",
    });
  }
  return out;
}

export function a2aToolDefinition(tool: A2aTool): unknown {
  return {
    type: "function",
    function: {
      name: tool.tool_name,
      description: `Delegate to A2A skill '${tool.skill_id}'. ${tool.description}`,
      parameters: {
        type: "object",
        properties: { task: { type: "string", description: "Task text for the agent" } },
        required: ["task"],
      },
    },
  };
}

/**
 * Builds an actionable error message for a failed A2A HTTP call. Auth failures
 * (401/403) are the common case when a connection's bearer token is missing or
 * stale — discovery of the agent card is often unauthenticated, so a tool can
 * appear available yet fail at delegate time. Call out the token explicitly so
 * the user knows what to fix instead of seeing an opaque `a2a 401`.
 */
export function a2aHttpErrorMessage(status: number, tool: A2aTool): string {
  if (status === 401 || status === 403) {
    const which = tool.token
      ? "the configured bearer token was rejected"
      : "no bearer token is configured";
    return `a2a ${status}: ${which} for connection '${tool.connection_id}'. Check the A2A connection's token in Settings.`;
  }
  return `a2a ${status}`;
}

/**
 * Builds the JSON-RPC `message/send` request body for a delegate call.
 *
 * The skill id is carried at the params top level as `skillId` (camelCase) —
 * this is the field A2A hubs route on. It is ALSO mirrored into
 * `metadata.skill` for agents that read it there; omitting the top-level
 * `skillId` makes the hub see an empty skill and reply "No route".
 */
export function buildDelegateBody(tool: A2aTool, task: string): unknown {
  return {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "message/send",
    params: {
      skillId: tool.skill_id,
      message: { role: "user", parts: [{ type: "text", text: task }] },
      metadata: { skill: tool.skill_id },
    },
  };
}

/** JSON-RPC message/send. Returns the text extracted from the reply parts. */
export async function delegate(tool: A2aTool, args: Record<string, unknown>): Promise<string> {
  const task = typeof args.task === "string" ? args.task : JSON.stringify(args);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (tool.token) headers.authorization = `Bearer ${tool.token}`;
  const body = buildDelegateBody(tool, task);
  const r = await fetch(tool.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(a2aHttpErrorMessage(r.status, tool));
  const reply = (await r.json()) as { result?: { message?: { parts?: unknown[] } }; error?: { message?: string } };
  if (reply.error) throw new Error(reply.error.message ?? "a2a error");
  const parts = reply.result?.message?.parts ?? [];
  return parts
    .map((p) => {
      const part = p as { text?: unknown; data?: unknown };
      if (typeof part.text === "string") return part.text;
      if (part.data !== undefined) return JSON.stringify(part.data);
      return "";
    })
    .join("");
}
