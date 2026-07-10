import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAgent } from "./useAgent";

const handlers: Record<string, (e: any) => void> = {};
vi.mock("../lib/runtime", () => ({
  invoke: vi.fn(async () => undefined),
  listen: vi.fn(async (name: string, cb: (e: any) => void) => {
    handlers[name] = cb;
    return () => {
      delete handlers[name];
    };
  }),
}));
import { invoke } from "../lib/runtime";

function emit(name: string, payload: any) {
  handlers[name]?.({ payload });
}

describe("useAgent", () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k];
    vi.clearAllMocks();
  });

  it("sends a message and appends a user turn", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("hello", "ask");
    });
    expect(invoke).toHaveBeenCalledWith("agent_run", {
      message: "hello",
      mode: "ask",
    });
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      content: "hello",
    });
  });

  it("appends assistant reply on agent://done", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("hi", "ask");
    });
    await act(async () => {
      emit("agent://done", "the answer");
    });
    await waitFor(() => {
      const last = result.current.messages[result.current.messages.length - 1];
      expect(last).toMatchObject({ role: "assistant", content: "the answer" });
    });
  });

  it("surfaces approval requests and clears them on decision", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("go", "ask");
    });
    await act(async () => {
      emit("agent://tool-approval-request", {
        call_id: "c1",
        tool: "bash",
        args: { command: "ls" },
      });
    });
    expect(result.current.pendingApproval).toMatchObject({
      call_id: "c1",
      tool: "bash",
    });
    await act(async () => {
      await result.current.decide("approve");
    });
    expect(invoke).toHaveBeenCalledWith("approve_tool", {
      call_id: "c1",
      decision: "approve",
    });
    expect(result.current.pendingApproval).toBeNull();
  });
});
