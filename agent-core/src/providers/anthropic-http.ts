/**
 * Direct Anthropic Messages HTTP provider (`POST <base>/v1/messages`).
 *
 * Used for OmniLLM-style custom endpoints that speak the Anthropic Messages
 * wire format but aren't the official Anthropic API — the Claude Agent SDK
 * hard-codes some paths and spawns a `claude` binary, which is overkill for
 * this shape. This module just does `fetch()`.
 */
import { httpFetch as fetch } from "../http.js";
import type { ProviderConfig } from "../settings.js";
import type { Msg, ParsedTurn, Provider, ToolCall } from "./types.js";
import { normalizeEndpoint } from "./chat-completions.js";

export function anthropicMessagesProvider(cfg: ProviderConfig): Provider {
  return {
    async infer(system, messages, tools): Promise<ParsedTurn> {
      const url = `${normalizeEndpoint(cfg.endpoint)}/messages`;
      const body: Record<string, unknown> = {
        model: cfg.model,
        system,
        messages: messages.map((m: Msg) => ({ role: m.role, content: m.content })),
        max_tokens: 4096,
      };
      if (tools.length > 0) body.tools = toAnthropicTools(tools);
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": cfg.api_key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`anthropic http ${r.status}: ${await r.text()}`);
      return parseAnthropic((await r.json()) as unknown);
    },
  };
}

function toAnthropicTools(tools: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const t of tools) {
    const tool = t as { function?: { name?: string; description?: string; parameters?: unknown } };
    const fn = tool.function ?? (t as { name?: string; description?: string; parameters?: unknown });
    const name = (fn as { name?: string }).name;
    if (!name) continue;
    out.push({
      name,
      description: (fn as { description?: string }).description ?? "",
      input_schema: (fn as { parameters?: unknown }).parameters ?? {
        type: "object",
        properties: {},
      },
    });
  }
  return out;
}

function parseAnthropic(body: unknown): ParsedTurn {
  const b = body as { content?: Array<Record<string, unknown>> };
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of b.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "",
        args: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return { text, tool_calls: toolCalls };
}
