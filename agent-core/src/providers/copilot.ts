/**
 * GitHub Copilot provider: short-lived token acquired via
 *   POST https://api.github.com/copilot_internal/v2/token
 * then chat/completions against https://api.githubcopilot.com.
 *
 * Device-flow login sits alongside in copilot-auth.ts. This module only knows
 * how to refresh the short-lived token against a long-lived one, and how to
 * issue an inference request against the Copilot chat endpoint.
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

async function getShortLivedToken(longLived: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - 60_000 > now) return cachedToken.value;
  const r = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      authorization: `token ${longLived}`,
      "editor-version": "omni-agent-desktop/0.1",
      "editor-plugin-version": "omni-agent-desktop/0.1",
      "user-agent": "omni-agent-desktop/0.1",
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
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "copilot-integration-id": "vscode-chat",
          "editor-version": "omni-agent-desktop/0.1",
          "user-agent": "omni-agent-desktop/0.1",
        },
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
