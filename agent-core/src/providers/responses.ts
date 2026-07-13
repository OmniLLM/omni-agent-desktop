/**
 * OpenAI Responses API helpers (POST /responses). Used by Copilot for
 * responses-only models and available to any openai-responses endpoint.
 *
 * Request body uses `instructions` (system) + `input` (the message list).
 * The response carries assistant text in `output_text` or nested
 * `output[].content[].text`, and tool calls as `output[]` items of type
 * `function_call`.
 */
import type { Msg, ParsedTurn, ToolCall } from "./types.js";

/** Build the `input` array for a Responses request. The system prompt is sent
 * separately as `instructions`, so only user/assistant/tool turns go here. */
export function buildResponsesInput(messages: Msg[]): unknown[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Convert Chat Completions tool schemas to the Responses tool schema.
 *
 * Chat Completions nests the definition under `function`:
 *   { type: "function", function: { name, description, parameters } }
 * Responses expects a FLAT shape with the fields hoisted to the top level:
 *   { type: "function", name, description, parameters }
 *
 * Sending the nested shape to /responses yields HTTP 400
 * `Missing required parameter: 'tools[0].name'`. Tools already in the flat
 * shape (or unknown shapes) are passed through unchanged.
 */
export function toResponsesTools(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    const tool = t as {
      type?: unknown;
      name?: unknown;
      function?: { name?: unknown; description?: unknown; parameters?: unknown };
    };
    // Already flat (has a top-level name) — leave as-is.
    if (typeof tool.name === "string") return t;
    const fn = tool.function;
    if (fn && typeof fn.name === "string") {
      return {
        type: "function",
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: fn.parameters ?? { type: "object", properties: {} },
      };
    }
    return t;
  });
}

/** Parse a Responses payload into assistant text + tool calls. */
export function parseResponses(body: unknown): ParsedTurn {
  const b = body as {
    output_text?: unknown;
    output?: Array<Record<string, unknown>>;
  };

  let text = typeof b.output_text === "string" ? b.output_text : "";
  const toolCalls: ToolCall[] = [];

  for (const item of Array.isArray(b.output) ? b.output : []) {
    const type = typeof item.type === "string" ? item.type : "";

    if (type === "function_call" || type === "tool_call") {
      const rawArgs =
        typeof item.arguments === "string" ? item.arguments : "{}";
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(rawArgs);
      } catch {
        /* empty */
      }
      toolCalls.push({
        id:
          typeof item.call_id === "string"
            ? item.call_id
            : typeof item.id === "string"
              ? item.id
              : "",
        name: typeof item.name === "string" ? item.name : "",
        args,
      });
      continue;
    }

    // Message-style items carry text blocks in `content`.
    if (!text) {
      const content = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : [];
      for (const block of content) {
        if (typeof block.text === "string" && block.text) {
          text = block.text;
          break;
        }
      }
    }
  }

  return { text, tool_calls: toolCalls };
}
