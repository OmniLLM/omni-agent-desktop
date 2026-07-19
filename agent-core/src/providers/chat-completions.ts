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
  for (const m of messages) {
    // Assistant turn that requested tool calls → Chat Completions `tool_calls`.
    if (m.role === "assistant" && m.tool_calls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      });
      continue;
    }
    // Tool result turn → role:"tool" carrying the originating tool_call_id.
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.tool_call_id ?? "",
        content: m.content,
      });
      continue;
    }
    if (m.role !== "user" || !m.images?.length) {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const content: unknown[] = [];
    if (m.content.trim()) content.push({ type: "text", text: m.content });
    for (const image of m.images) {
      content.push({ type: "image_url", image_url: { url: image.data_url } });
    }
    out.push({ role: m.role, content });
  }
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
