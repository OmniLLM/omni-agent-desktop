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
      await result.current.send("hello");
    });
    expect(invoke).toHaveBeenCalledWith("agent_run", {
      message: "hello",
      mode: "ask",
      history: [],
    });
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      content: "hello",
    });
  });

  it("appends assistant reply on agent://done", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("hi");
    });
    await act(async () => {
      emit("agent://done", "the answer");
    });
    await waitFor(() => {
      const last = result.current.messages[result.current.messages.length - 1];
      expect(last).toMatchObject({ role: "assistant", content: "the answer" });
    });
  });

  it("unwraps object-shaped agent://done payloads ({ text })", async () => {
    // Regression: the sidecar emits `{ text: string }`, not a bare string.
    // If the listener stored the object directly, ChatPane crashed to a blank
    // screen trying to render an object as markdown.
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("hi");
    });
    await act(async () => {
      emit("agent://done", { text: "**bold** reply" });
    });
    await waitFor(() => {
      const last = result.current.messages[result.current.messages.length - 1];
      expect(last).toMatchObject({ role: "assistant", content: "**bold** reply" });
      expect(typeof last.content).toBe("string");
    });
  });

  it("unwraps object-shaped agent://thought payloads ({ text })", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("go");
    });
    await act(async () => {
      emit("agent://thought", { text: "let me think" });
    });
    const thought = result.current.messages.find((m) => m.kind === "thought");
    expect(thought?.content).toBe("let me think");
  });

  it("surfaces approval requests and clears them on decision", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("go");
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

  it("appends thinking and action traces from agent events", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("go");
    });
    await act(async () => {
      emit("agent://thought", "I should list the files first.");
      emit("agent://tool-call", {
        call_id: "c1",
        tool: "ls",
        args: { path: "/home" },
      });
      emit("agent://tool-result", { call_id: "c1", tool: "ls", result: "a\nb" });
    });
    const traces = result.current.messages.filter((m) => m.role === "thinking");
    expect(traces.map((t) => t.kind)).toEqual(["thought", "action", "result"]);
    expect(traces[1].content).toContain("ls");
    expect(traces[1].content).toContain("/home");
  });
});

