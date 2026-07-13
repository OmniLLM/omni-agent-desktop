/**
 * GitHub Copilot provider: short-lived token acquired via
 *   POST https://api.github.com/copilot_internal/v2/token
 * then chat/completions against https://api.githubcopilot.com.
 *
 * Device-flow login sits alongside in copilot-auth.ts. This module only knows
 * how to refresh the short-lived token against a long-lived one, list models,
 * and issue an inference request against the Copilot chat endpoint.
 */
import { fetch } from "undici";
import type { ProviderConfig } from "../settings.js";
import { buildMessages, parseChatCompletions } from "./chat-completions.js";
import type { ParsedTurn, Provider } from "./types.js";

interface TokenCache {
  value: string;
  expiresAtMs: number;
}
let cachedToken: TokenCache | null = null;

const EDITOR_VERSION = "omni-agent-desktop/0.1";
const EDITOR_PLUGIN_VERSION = "omni-agent-desktop/0.1";
const USER_AGENT = "omni-agent-desktop/0.1";
const GITHUB_API_VERSION = "2025-04-01";

/** Copilot request headers (parity with omni-pilot's createCopilotHeaders). */
function copilotHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
    "copilot-integration-id": "vscode-chat",
    "editor-version": EDITOR_VERSION,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-panel",
    "x-github-api-version": GITHUB_API_VERSION,
    "x-vscode-user-agent-library-version": "electron-fetch",
  };
}

async function getShortLivedToken(longLived: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - 60_000 > now) return cachedToken.value;
  const r = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      authorization: `token ${longLived}`,
      "editor-version": EDITOR_VERSION,
      "editor-plugin-version": EDITOR_PLUGIN_VERSION,
      "user-agent": USER_AGENT,
    },
  });
  if (!r.ok) throw new Error(`copilot token: http ${r.status}`);
  const body = (await r.json()) as { token?: string; expires_at?: number };
  if (!body.token) throw new Error("copilot token: missing `token`");
  cachedToken = {
    value: body.token,
    expiresAtMs: (body.expires_at ?? Math.floor(now / 1000) + 25 * 60) * 1000,
  };
  return cachedToken.value;
}

/**
 * Fetch the model catalog from Copilot. Returns the CopilotModel[] shape the
 * frontend expects (id, supported_endpoints, endpoint). The `endpoint` field
 * picks the preferred route: "responses" if that's supported, else
 * "chat_completions". Parity with omni-pilot's fetchCopilotModels.
 */
export interface CopilotModel {
  id: string;
  supported_endpoints: string[];
  endpoint: "chat_completions" | "responses";
}

export async function listCopilotModels(longLivedToken: string): Promise<CopilotModel[]> {
  const token = await getShortLivedToken(longLivedToken);
  const r = await fetch("https://api.githubcopilot.com/models", {
    headers: copilotHeaders(token),
  });
  if (!r.ok) throw new Error(`copilot /models http ${r.status}: ${await r.text()}`);
  const body = (await r.json()) as {
    data?: Array<Record<string, unknown>>;
    models?: Array<Record<string, unknown>>;
  };
  const raw = body.data ?? body.models ?? [];
  const out: CopilotModel[] = [];
  for (const m of raw) {
    const id = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "";
    if (!id) continue;
    const supported = Array.isArray(m.supported_endpoints)
      ? (m.supported_endpoints as string[])
      : ["chat_completions"];
    const endpoint: CopilotModel["endpoint"] = supported.includes("responses")
      ? "responses"
      : "chat_completions";
    out.push({ id, supported_endpoints: supported, endpoint });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export function copilotProvider(cfg: ProviderConfig, longLivedToken: string | null): Provider {
  return {
    async infer(system, messages, tools): Promise<ParsedTurn> {
      if (!longLivedToken) throw new Error("GitHub Copilot is not connected");
      const token = await getShortLivedToken(longLivedToken);
      const body = {
        model: cfg.model || "gpt-4o",
        messages: buildMessages(system, messages),
        tools: tools.length ? tools : undefined,
      };
      const r = await fetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: copilotHeaders(token),
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`copilot http ${r.status}: ${await r.text()}`);
      return parseChatCompletions((await r.json()) as unknown);
    },
  };
}

/** Discard the cached short-lived token (call on disconnect or 401). */
export function clearCopilotTokenCache(): void {
  cachedToken = null;
}
