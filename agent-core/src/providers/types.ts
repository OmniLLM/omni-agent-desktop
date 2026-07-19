/**
 * Provider abstraction shared by all three provider implementations (Claude
 * Agent SDK, Codex SDK, HTTP Chat Completions). Returns a `ParsedTurn`:
 * assistant text + zero-or-more tool_calls.
 */
export interface ImageAttachment {
  id?: string;
  data_url: string;
  mime_type: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Msg {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  images?: ImageAttachment[];
  /** Present on an assistant turn that requested tool calls. Each entry keeps
   * the provider-native tool-call id so results can be correlated. */
  tool_calls?: ToolCall[];
  /** Present on a `role: "tool"` result turn. Matches the `id` of the
   * originating {@link ToolCall} so the provider can pair call ⇄ result. */
  tool_call_id?: string;
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
