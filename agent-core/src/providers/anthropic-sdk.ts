/**
 * Anthropic Claude Agent SDK provider.
 *
 * Uses `query()` from @anthropic-ai/claude-agent-sdk. Because that SDK runs
 * its own agent loop, we call it with a SINGLE conversation-turn prompt (no
 * multi-iteration) and let OUR outer loop keep iterating: we translate the
 * SDK's message stream into a single `ParsedTurn` with the final text plus any
 * tool calls it emitted so our approval-gated tool executor stays authoritative.
 *
 * For our per-run isolation, each call sets ANTHROPIC_API_KEY from the active
 * provider config (custom-provider is the only place a user-supplied Anthropic
 * key lives — Azure Foundry with Claude uses CLAUDE_CODE_USE_FOUNDRY=1 in env).
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderConfig } from "../settings.js";
import type { Msg, ParsedTurn, Provider, ToolCall } from "./types.js";
import { normalizeEndpoint } from "./chat-completions.js";

export function anthropicSdkProvider(cfg: ProviderConfig): Provider {
  return {
    async infer(system, messages, _tools): Promise<ParsedTurn> {
      // Restore per-call env so multiple provider configs can coexist.
      const prevKey = process.env.ANTHROPIC_API_KEY;
      const prevBase = process.env.ANTHROPIC_BASE_URL;
      if (cfg.api_key) process.env.ANTHROPIC_API_KEY = cfg.api_key;
      if (cfg.endpoint) process.env.ANTHROPIC_BASE_URL = normalizeEndpoint(cfg.endpoint);

      try {
        // Fold the conversation into a single user prompt: SYSTEM + prior turns
        // + the latest user message. The outer loop already tracks history.
        const prompt = renderPrompt(system, messages);
        const stream = query({
          prompt,
          options: {
            model: cfg.model,
            // Disable SDK's own tool exposure — we run tool execution in the
            // outer loop under RunMode gating.
            allowedTools: [],
          },
        });
        let text = "";
        const toolCalls: ToolCall[] = [];
        for await (const msg of stream) {
          // The SDK's public message contract exposes `type` discriminated
          // shapes; capture assistant text and any tool_use blocks.
          const anyMsg = msg as { type?: string; content?: unknown; result?: unknown };
          if (anyMsg.type === "assistant" && Array.isArray(anyMsg.content)) {
            for (const block of anyMsg.content as Array<Record<string, unknown>>) {
              if (block.type === "text" && typeof block.text === "string") text += block.text;
              else if (block.type === "tool_use") {
                toolCalls.push({
                  id: String(block.id ?? ""),
                  name: String(block.name ?? ""),
                  args: (block.input ?? {}) as Record<string, unknown>,
                });
              }
            }
          } else if (anyMsg.type === "result" && typeof anyMsg.result === "string") {
            if (!text) text = anyMsg.result;
          }
        }
        return { text, tool_calls: toolCalls };
      } finally {
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevKey;
        if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
        else process.env.ANTHROPIC_BASE_URL = prevBase;
      }
    },
  };
}

function renderPrompt(system: string, messages: Msg[]): string {
  const parts: string[] = [];
  if (system.trim().length) parts.push(`# System\n${system}`);
  for (const m of messages) {
    parts.push(`# ${m.role}\n${m.content}`);
  }
  return parts.join("\n\n");
}
