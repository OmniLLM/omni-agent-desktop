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
  /** Opaque reasoning state from a Copilot reasoning model. It must be echoed
   * back verbatim on the next request or the model loses its chain of thought
   * and cannot materialize the tool calls it already committed to. */
  reasoning_opaque?: string;
}

export interface ParsedTurn {
  text: string;
  tool_calls: ToolCall[];
  /** See {@link Msg.reasoning_opaque}. Carried so the run loop can echo it on
   * the follow-up request. */
  reasoning_opaque?: string;
  /** Provider-reported stop reason, when supplied. `"tool_calls"` with an empty
   * `tool_calls` array means the model intends to act but has not yet emitted
   * the calls -- the loop must continue rather than end the turn. */
  finish_reason?: string;
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
