/**
 * Agent loop (port of src-tauri/src/agent/mod.rs::run_once).
 *
 * Shared execution path for foreground and scheduled runs. Emits progress
 * events through the RPC event channel and gates mutating/A2A tools by RunMode.
 */
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
  } = input;
  const messages = [...input.messages];
  const max = Math.max(1, input.maxIterations);
  const sessionAllow = new Set<string>();
  let counter = 0;

  for (let iter = 0; iter < max; iter++) {
    const turn: ParsedTurn = await provider.infer(system, messages, toolDefs);
    if (turn.tool_calls.length === 0) {
      return { text: turn.text };
    }
    if (turn.text.trim().length) {
      emit("agent://thought", { text: turn.text });
    }
    for (const call of turn.tool_calls) {
      counter += 1;
      const callId = `call-${counter}`;
      const mutating = isA2A(call.name) || isMutating(call.name);
      emit("agent://tool-call", { call_id: callId, tool: call.name, args: call.args });

      const g = gate(mode, mutating);
      let decision: ApprovalDecision;
      if (g === "auto") {
        decision = "approve";
      } else if (g === "block") {
        messages.push({
          role: "user",
          content: `[tool ${call.name} blocked in plan mode]`,
        });
        emit("agent://tool-result", {
          call_id: callId,
          tool: call.name,
          result: "blocked in plan mode",
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
        role: "user",
        content: `[tool ${call.name} result]\n${result}`,
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
