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

/** A provider that can execute one inference turn.
 *
 * `signal` (optional) propagates per-session cancellation: when the caller
 * aborts it, the provider's underlying fetch is aborted and the resulting
 * error should be surfaced as a cancellation (see run.ts `isAbortError`),
 * not an ordinary provider failure. */
export interface Provider {
  infer(
    system: string,
    messages: Msg[],
    tools: unknown[],
    signal?: AbortSignal,
  ): Promise<ParsedTurn>;
}
