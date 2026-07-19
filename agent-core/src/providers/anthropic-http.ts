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
    async infer(system, messages, tools, signal): Promise<ParsedTurn> {
      const url = `${normalizeEndpoint(cfg.endpoint)}/messages`;
      const body: Record<string, unknown> = {
        model: cfg.model,
        system,
        messages: buildAnthropicMessages(messages),
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
        signal,
      });
      if (!r.ok) throw new Error(`anthropic http ${r.status}: ${await r.text()}`);
      return parseAnthropic((await r.json()) as unknown);
    },
  };
}

export function buildAnthropicMessages(messages: Msg[]): unknown[] {
  return messages.map((m) => {
    // Assistant turn that requested tool calls → assistant `tool_use` blocks.
    if (m.role === "assistant" && m.tool_calls?.length) {
      const content: unknown[] = [];
      if (m.content.trim()) content.push({ type: "text", text: m.content });
      for (const c of m.tool_calls) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      }
      return { role: "assistant", content };
    }
    // Tool result turn → a USER message carrying a `tool_result` block. This is
    // the Anthropic-correct shape and avoids two consecutive user text turns.
    if (m.role === "tool") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id ?? "",
            content: m.content,
          },
        ],
      };
    }
    if (m.role !== "user" || !m.images?.length) {
      return { role: m.role, content: m.content };
    }
    const content: unknown[] = [];
    if (m.content.trim()) content.push({ type: "text", text: m.content });
    for (const image of m.images) {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(image.data_url);
      if (!match) continue;
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: match[1] || image.mime_type,
          data: match[2],
        },
      });
    }
    return { role: m.role, content };
  });
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
