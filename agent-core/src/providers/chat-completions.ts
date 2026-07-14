/**
 * OpenAI Chat Completions HTTP provider (the fallback for everything not
 * routed to Claude Agent SDK / Codex SDK). Handles OpenAI-compatible custom
 * endpoints, plus serves as the shared building block for Azure and Copilot.
 */
import { httpFetch as fetch } from "../http.js";
import type { ProviderConfig } from "../settings.js";
import type { Msg, ParsedTurn, Provider, ToolCall } from "./types.js";

export function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  const afterScheme = trimmed.split("://")[1] ?? trimmed;
  const hasPath = afterScheme.includes("/");
  return hasPath ? trimmed : `${trimmed}/v1`;
}

export function chatCompletionsProvider(cfg: ProviderConfig): Provider {
  return {
    async infer(system, messages, tools, signal): Promise<ParsedTurn> {
      const url = `${normalizeEndpoint(cfg.endpoint)}/chat/completions`;
      const body = {
        model: cfg.model,
        messages: buildMessages(system, messages),
        tools: tools.length ? tools : undefined,
      };
      const r = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.api_key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!r.ok) throw new Error(`http ${r.status}: ${await r.text()}`);
      return parseChatCompletions((await r.json()) as unknown);
    },
  };
}

export function buildMessages(system: string, messages: Msg[]): unknown[] {
  const out: unknown[] = [];
  if (system.trim().length) out.push({ role: "system", content: system });
  for (const m of messages) out.push({ role: m.role, content: m.content });
  return out;
}

export function parseChatCompletions(body: unknown): ParsedTurn {
  const b = body as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown[] } }> };
  const msg = b.choices?.[0]?.message ?? {};
  const text = typeof msg.content === "string" ? msg.content : "";
  const toolCalls: ToolCall[] = [];
  for (const c of msg.tool_calls ?? []) {
    const call = c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const rawArgs = typeof call.function?.arguments === "string" ? call.function.arguments : "{}";
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs);
    } catch {
      /* empty */
    }
    toolCalls.push({
      id: typeof call.id === "string" ? call.id : "",
      name: typeof call.function?.name === "string" ? call.function.name : "",
      args,
    });
  }
  return { text, tool_calls: toolCalls };
}
