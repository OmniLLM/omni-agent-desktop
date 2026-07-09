export interface AgentCardSkill {
  id?: string;
  name?: string;
  description?: string;
  tags?: string[];
  inputSchema?: unknown;
  input_schema?: unknown;
}

export interface AgentCard {
  name?: string;
  description?: string;
  url?: string;
  skills?: AgentCardSkill[];
  [key: string]: unknown;
}

export interface A2aConnection {
  id: string;
  name: string;
  endpoint: string;
  token?: string;
  enabled?: boolean;
  agentCard?: AgentCard | null;
}

export interface DelegateA2aTaskArgs {
  endpoint: string;
  token?: string;
  /** Human-readable task text. Used as the text part unless `data` is provided. */
  task: string;
  /** Optional structured A2A data part for plugin/tool calls through a hub. */
  data?: unknown;
  skillId?: string;
  contextId?: string;
  messageId?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected", "input-required"]);

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

function a2aHeaders(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}),
  };
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `HTTP ${response.status}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function fetchAgentCard(endpoint: string, token?: string): Promise<AgentCard> {
  const base = normalizeEndpoint(endpoint);
  if (!base) throw new Error("A2A endpoint is required");

  const paths = ["/.well-known/agent-card.json", "/.well-known/agent.json"];
  let lastError = "";
  for (const path of paths) {
    try {
      const response = await fetch(`${base}${path}`, { headers: a2aHeaders(token) });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const card = await readJson(response);
      if (!card || typeof card !== "object") {
        throw new Error("Agent card response was not an object");
      }
      return card as AgentCard;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`A2A discovery failed for ${base}: ${lastError || "no supported discovery path responded"}`);
}

async function postJsonRpc(endpoint: string, token: string | undefined, body: unknown): Promise<any> {
  const response = await fetch(`${normalizeEndpoint(endpoint)}/`, {
    method: "POST",
    headers: a2aHeaders(token),
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  if (payload?.error) {
    const detail = payload.error.data ? `: ${JSON.stringify(payload.error.data)}` : "";
    throw new Error(`${payload.error.message || "A2A JSON-RPC error"}${detail}`);
  }
  return payload?.result;
}

function extractTaskId(task: any): string {
  return String(task?.id || task?.taskId || task?.task_id || "").trim();
}

function extractTextFromParts(parts: any[]): string {
  return parts
    .map((part) => {
      if (typeof part?.text === "string") return part.text;
      if (part?.data !== undefined) return JSON.stringify(part.data);
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function extractA2aText(task: any): string {
  const statusParts = task?.status?.message?.parts;
  if (Array.isArray(statusParts)) {
    const text = extractTextFromParts(statusParts);
    if (text) return text;
  }
  if (Array.isArray(task?.history)) {
    for (let i = task.history.length - 1; i >= 0; i -= 1) {
      const text = extractTextFromParts(task.history[i]?.parts || []);
      if (text) return text;
    }
  }
  if (Array.isArray(task?.artifacts)) {
    const text = task.artifacts
      .map((artifact: any) => extractTextFromParts(artifact?.parts || []))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollTask(
  endpoint: string,
  token: string | undefined,
  taskId: string,
  maxPollAttempts: number,
  pollIntervalMs: number,
): Promise<any> {
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    const task = await postJsonRpc(endpoint, token, {
      jsonrpc: "2.0",
      id: `tasks-get-${attempt + 1}`,
      method: "tasks/get",
      params: { id: taskId },
    });
    const state = String(task?.status?.state || "");
    if (TERMINAL_STATES.has(state)) return task;
    await sleep(pollIntervalMs);
  }
  throw new Error(`A2A task ${taskId} did not reach a terminal state`);
}

export async function delegateA2aTask(args: DelegateA2aTaskArgs): Promise<string> {
  const endpoint = normalizeEndpoint(args.endpoint);
  if (!endpoint) throw new Error("A2A endpoint is required");
  const task = args.task.trim();
  if (!task) throw new Error("A2A task is required");

  const params: Record<string, unknown> = {
    message: {
      role: "user",
      messageId: args.messageId || `desktop-${Date.now()}`,
      parts: [
        args.data !== undefined ? { type: "data", data: args.data } : { type: "text", text: task },
      ],
    },
  };
  if (args.skillId?.trim()) params.skillId = args.skillId.trim();
  if (args.contextId?.trim()) params.contextId = args.contextId.trim();

  const initial = await postJsonRpc(endpoint, args.token, {
    jsonrpc: "2.0",
    id: "message-send-1",
    method: "message/send",
    params,
  });

  const immediate = extractA2aText(initial);
  const state = String(initial?.status?.state || "");
  if (immediate && (!state || TERMINAL_STATES.has(state))) return immediate;

  const taskId = extractTaskId(initial);
  if (!taskId) throw new Error("A2A task did not include a task id or text result");

  const completed = await pollTask(
    endpoint,
    args.token,
    taskId,
    args.maxPollAttempts ?? 120,
    args.pollIntervalMs ?? 500,
  );
  const completedState = String(completed?.status?.state || "");
  const text = extractA2aText(completed);
  if (completedState !== "completed") {
    throw new Error(text || `A2A task ended in ${completedState || "unknown"} state`);
  }
  if (!text) throw new Error("A2A task completed without text result");
  return text;
}
