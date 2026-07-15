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

/** A2A task states that cannot transition further (polling should stop). */
const TERMINAL_STATES = new Set(["completed", "canceled", "failed", "input-required"]);

interface A2aPart {
  text?: unknown;
  data?: unknown;
}
interface A2aMessage {
  parts?: A2aPart[];
}
interface A2aTask {
  id?: string;
  status?: { state?: string; message?: A2aMessage };
  artifacts?: Array<{ parts?: A2aPart[] }>;
  history?: A2aMessage[];
  message?: A2aMessage;
}

/** Concatenates the text/data of a parts array into a single string. */
export function extractParts(parts: A2aPart[] | undefined): string {
  return (parts ?? [])
    .map((part) => {
      if (typeof part.text === "string") return part.text;
      if (part.data !== undefined) return JSON.stringify(part.data);
      return "";
    })
    .join("");
}

/**
 * Extracts the human-readable output from an A2A result, which may be either an
 * immediate message reply or a Task. For a Task, the answer lives in
 * `status.message.parts`, else in `artifacts[].parts`, else in the last
 * `history` message — checked in that order.
 */
export function extractResultText(result: A2aTask | undefined): string {
  if (!result) return "";
  const direct = extractParts(result.message?.parts);
  if (direct) return direct;
  const statusMsg = extractParts(result.status?.message?.parts);
  if (statusMsg) return statusMsg;
  const artifacts = (result.artifacts ?? [])
    .map((a) => extractParts(a.parts))
    .filter(Boolean)
    .join("\n");
  if (artifacts) return artifacts;
  const history = result.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const t = extractParts(history[i]?.parts);
    if (t) return t;
  }
  return "";
}

/** True once a Task result has reached a terminal state (or is not a Task). */
export function isTerminalResult(result: A2aTask | undefined): boolean {
  const state = result?.status?.state;
  // A plain message reply (no task status) is already final.
  if (!state) return true;
  return TERMINAL_STATES.has(state);
}

/**
 * JSON-RPC message/send, then poll tasks/get until the task is terminal.
 *
 * The hub is asynchronous: message/send returns a Task in state "working" with
 * no output yet. Returning that empty reply makes the calling model see an
 * empty result and retry the same skill forever with reworded prompts. So we
 * poll tasks/get until the task reaches a terminal state, then extract the
 * output. A failed task raises so the model gets a real error, not silence.
 */
export async function delegate(
  tool: A2aTool,
  args: Record<string, unknown>,
  timeoutMs: number = DEFAULT_POLL_TIMEOUT_MS,
): Promise<string> {
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
  const reply = (await r.json()) as { result?: A2aTask; error?: { message?: string } };
  if (reply.error) throw new Error(reply.error.message ?? "a2a error");

  let result = reply.result;
  const taskId = result?.id;

  // Poll to completion when the hub handed back a non-terminal task.
  if (taskId && !isTerminalResult(result)) {
    result = await pollTask(tool, headers, taskId, timeoutMs);
  }

  if (result?.status?.state === "failed") {
    const msg = extractResultText(result) || "task failed";
    throw new Error(`a2a task failed: ${msg}`);
  }
  if (result?.status?.state === "canceled") {
    throw new Error("a2a task was canceled");
  }
  const text = extractResultText(result);
  // A terminal task with no text means the skill produced nothing usable —
  // surface it as an error rather than returning "" (which makes the calling
  // model treat the tool as broken and retry it in a loop).
  if (!text) throw new Error("a2a task completed without a text result");
  return text;
}

const POLL_INTERVAL_MS = 1500;
/** Fallback A2A poll timeout when no configured value is passed. Overridden by
 * `AppSettings.a2a_timeout_secs` via `delegate(..., timeoutMs)`. */
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

/** Polls tasks/get until the task is terminal or the timeout elapses. */
async function pollTask(
  tool: A2aTool,
  headers: Record<string, string>,
  taskId: string,
  timeoutMs: number = DEFAULT_POLL_TIMEOUT_MS,
): Promise<A2aTask | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: A2aTask | undefined;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const body = { jsonrpc: "2.0", id: Date.now(), method: "tasks/get", params: { id: taskId } };
    const r = await fetch(tool.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(a2aHttpErrorMessage(r.status, tool));
    const reply = (await r.json()) as { result?: A2aTask; error?: { message?: string } };
    if (reply.error) throw new Error(reply.error.message ?? "a2a error");
    last = reply.result;
    if (isTerminalResult(last)) return last;
  }
  throw new Error(
    `a2a task ${taskId} did not complete within ${Math.round(timeoutMs / 1000)}s`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
