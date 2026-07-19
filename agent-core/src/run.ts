/**
 * Agent loop (port of src-tauri/src/agent/mod.rs::run_once).
 *
 * Shared execution path for foreground and scheduled runs. Emits progress
 * events through the RPC event channel and gates mutating/A2A tools by RunMode.
 */
import { randomUUID } from "node:crypto";
import type { ApprovalDecision } from "./approvals.js";
import { approvals } from "./approvals.js";
import { classify, executeTool, LOCAL_TOOLS } from "./tools.js";
import type { Msg, ParsedTurn, Provider, ToolCall } from "./providers/types.js";
import type { RunMode } from "./settings.js";

export type Gate = "auto" | "approve" | "block";
export function gate(mode: RunMode, mutating: boolean): Gate {
  if (!mutating) return "auto";
  if (mode === "plan") return "block";
  if (mode === "ask") return "approve";
  return "auto"; // autopilot
}

export const MAX_ITERATIONS_REPLY = "stopped: max iterations reached";

/** Marker error used to signal that a run was cancelled (via AbortSignal)
 * rather than failing for an ordinary reason. Callers can catch this to emit a
 * cancellation event instead of an error. */
export class CancelledError extends Error {
  constructor(message = "run cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/** True when `e` is an AbortError (thrown by fetch when its signal aborts) or
 * our own CancelledError. Both mean "the run was cancelled", not "it failed". */
export function isAbortError(e: unknown): boolean {
  if (e instanceof CancelledError) return true;
  if (e instanceof Error && (e.name === "AbortError" || e.name === "CancelledError")) {
    return true;
  }
  // DOMException AbortError (undici/web fetch) may not be an Error instance.
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "AbortError"
  );
}

export type EmitFn = (event: string, data: unknown) => void;

export interface RunToolFn {
  (name: string, args: Record<string, unknown>): Promise<string>;
}

export interface RunOnceInput {
  mode: RunMode;
  system: string;
  messages: Msg[];
  toolDefs: unknown[];
  maxIterations: number;
  isA2A: (name: string) => boolean;
  isMutating: (name: string) => boolean;
  provider: Provider;
  runTool: RunToolFn;
  emit: EmitFn;
  /** Approval timeout in ms; expired requests default to `deny`. */
  approvalTimeoutMs?: number;
  /** Per-session cancellation. When aborted, in-flight inference is aborted
   * and the loop stops by throwing a `CancelledError`. */
  signal?: AbortSignal;
}

export interface RunOutcome {
  text: string;
}

/** The shared agent execution path. */
export async function runOnce(input: RunOnceInput): Promise<RunOutcome> {
  const {
    mode,
    system,
    toolDefs,
    isA2A,
    isMutating,
    provider,
    runTool,
    emit,
    approvalTimeoutMs = 5 * 60_000,
    signal,
  } = input;
  const messages = [...input.messages];
  const max = Math.max(1, input.maxIterations);
  const sessionAllow = new Set<string>();

  const throwIfAborted = () => {
    if (signal?.aborted) throw new CancelledError();
  };

  for (let iter = 0; iter < max; iter++) {
    throwIfAborted();
    let turn: ParsedTurn;
    try {
      turn = await provider.infer(system, messages, toolDefs, signal);
    } catch (e) {
      // A fetch aborted by our signal surfaces as an AbortError; treat it as
      // cancellation (not an ordinary provider failure) so callers can emit a
      // cancelled event rather than an error.
      if (signal?.aborted || isAbortError(e)) throw new CancelledError();
      throw e;
    }
    if (turn.tool_calls.length === 0) {
      return { text: turn.text };
    }
    if (turn.text.trim().length) {
      emit("agent://thought", { text: turn.text });
    }

    // Assign each parsed tool call a stable id: preserve the provider-native id
    // end to end; only mint a uuid when the provider omitted one. This id is
    // carried through the emitted events, the assistant tool-call turn, and the
    // matching tool-result turn so every provider can pair call ⇄ result.
    const calls: ToolCall[] = turn.tool_calls.map((c) => ({
      ...c,
      id: c.id && c.id.length ? c.id : randomUUID(),
    }));

    // Record the assistant turn that REQUESTED the tools. Provider adapters
    // serialize this into their wire shape (chat: assistant + tool_calls;
    // anthropic: assistant tool_use blocks; responses: function_call items).
    messages.push({ role: "assistant", content: turn.text, tool_calls: calls });

    for (const call of calls) {
      throwIfAborted();
      const callId = call.id;
      const mutating = isA2A(call.name) || isMutating(call.name);
      emit("agent://tool-call", { call_id: callId, tool: call.name, args: call.args });

      const g = gate(mode, mutating);
      let decision: ApprovalDecision;
      if (g === "auto") {
        decision = "approve";
      } else if (g === "block") {
        emit("agent://tool-result", {
          call_id: callId,
          tool: call.name,
          result: "blocked in plan mode",
        });
        messages.push({
          role: "tool",
          content: `[tool ${call.name} blocked in plan mode]`,
          tool_call_id: callId,
        });
        continue;
      } else {
        // approve gate
        if (sessionAllow.has(call.name)) {
          decision = "approve";
        } else {
          emit("agent://tool-approval-request", {
            call_id: callId,
            tool: call.name,
            args: call.args,
          });
          decision = await waitApproval(callId, approvalTimeoutMs);
        }
      }

      let result: string;
      if (decision === "deny") {
        result = `[tool ${call.name} denied by user]`;
      } else {
        if (decision === "allow_session") sessionAllow.add(call.name);
        try {
          result = await runTool(call.name, call.args);
        } catch (e) {
          result = `error: ${(e as Error).message}`;
        }
      }
      emit("agent://tool-result", { call_id: callId, tool: call.name, result });
      messages.push({
        role: "tool",
        content: result,
        tool_call_id: callId,
      });
    }
  }
  return { text: MAX_ITERATIONS_REPLY };
}

async function waitApproval(callId: string, timeoutMs: number): Promise<ApprovalDecision> {
  const p = approvals.wait(callId);
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ApprovalDecision>((resolve) => {
    t = setTimeout(() => {
      approvals.resolve(callId, "deny");
      resolve("deny");
    }, timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Convenience: dispatch a tool by name to the local registry or an A2A resolver. */
export function makeToolRunner(a2aExec: (name: string, args: Record<string, unknown>) => Promise<string>): RunToolFn {
  return async (name, args) => {
    if ((LOCAL_TOOLS as readonly string[]).includes(name)) return executeTool(name, args);
    return a2aExec(name, args);
  };
}

/** True when `name` is a local built-in tool. */
export function isLocal(name: string): boolean {
  return (LOCAL_TOOLS as readonly string[]).includes(name);
}

/** Local mutating classifier (write/edit/bash). Excludes A2A. */
export function isMutatingLocal(name: string): boolean {
  return isLocal(name) && classify(name) === "mutating";
}
