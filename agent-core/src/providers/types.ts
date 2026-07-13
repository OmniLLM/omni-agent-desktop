/**
 * Provider abstraction shared by all three provider implementations (Claude
 * Agent SDK, Codex SDK, HTTP Chat Completions). Returns a `ParsedTurn`:
 * assistant text + zero-or-more tool_calls.
 */
export interface Msg {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ParsedTurn {
  text: string;
  tool_calls: ToolCall[];
}

/** A provider that can execute one inference turn. */
export interface Provider {
  infer(system: string, messages: Msg[], tools: unknown[]): Promise<ParsedTurn>;
}
