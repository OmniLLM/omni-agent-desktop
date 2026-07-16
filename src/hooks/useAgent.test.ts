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
    (invoke as any).mockImplementation(async (cmd: string) => {
      if (cmd === "agent_compact") {
        return { summary: "Provider-generated durable summary", compacted: 1 };
      }
      return undefined;
    });
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
      session: expect.anything(),
    });
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      content: "hello",
    });
  });

  it("sends screenshot attachments with the user turn and agent run", async () => {
    const image = {
      id: "shot-1",
      data_url: "data:image/png;base64,cG5n",
      mime_type: "image/png",
      name: "screenshot.png",
    };
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("inspect this", "ask", [image]);
    });
    expect(invoke).toHaveBeenCalledWith("agent_run", {
      message: "inspect this",
      mode: "ask",
      history: [],
      images: [image],
      session: expect.anything(),
    });
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      content: "inspect this",
      images: [image],
    });
  });

  it("ignores a second send while a run is active", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("first");
      await result.current.send("second");
    });
    const runCalls = (invoke as any).mock.calls.filter(
      (call: any[]) => call[0] === "agent_run",
    );
    expect(runCalls).toHaveLength(1);
    expect(result.current.messages.filter((message) => message.role === "user")).toHaveLength(1);
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

  it("does not inject a run's events into a session switched to mid-run", async () => {
    // Regression: switching to another chat while a run is in flight must not
    // interleave that run's thoughts/answer into the newly shown session.
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("run in session A");
    });
    // Capture the session that owns the in-flight run.
    const runCall = (invoke as any).mock.calls.find(
      (c: any[]) => c[0] === "agent_run",
    );
    const ownerSession = runCall[1].session;

    // User switches to a different chat before the run finishes.
    await act(async () => {
      await result.current.switchSession("some-other-session");
    });
    const afterSwitch = result.current.messages.length;

    // Late events from the original run arrive, tagged with its session.
    await act(async () => {
      emit("agent://thought", { text: "late thought", session: ownerSession });
      emit("agent://done", { text: "late answer", session: ownerSession });
    });

    // The now-visible session is untouched by the other run's stream.
    expect(result.current.messages.length).toBe(afterSwitch);
    expect(
      result.current.messages.some((m) => m.content === "late answer"),
    ).toBe(false);
  });

  it("stop cancels the active run and clears loading", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("do work");
    });
    const runCall = (invoke as any).mock.calls.find(
      (c: any[]) => c[0] === "agent_run",
    );
    const ownerSession = runCall[1].session;
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await result.current.stop();
    });
    expect(invoke).toHaveBeenCalledWith("agent_cancel", {
      session: ownerSession,
    });
    expect(result.current.loading).toBe(false);

    // Late events from the cancelled run are dropped.
    await act(async () => {
      emit("agent://done", { text: "too late", session: ownerSession });
    });
    expect(
      result.current.messages.some((m) => m.content === "too late"),
    ).toBe(false);
  });

  it("stop is a no-op when nothing is running", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.stop();
    });
    expect(
      (invoke as any).mock.calls.some((c: any[]) => c[0] === "agent_cancel"),
    ).toBe(false);
  });

  it("renameSession persists a manual title that survives auto-persist", async () => {
    const { result } = renderHook(() => useAgent());
    // Create a live session with a message so an id exists.
    await act(async () => {
      await result.current.send("original question");
    });
    const id = result.current.currentSessionId!;

    await act(async () => {
      await result.current.renameSession(id, "My custom title");
    });
    expect(invoke).toHaveBeenCalledWith(
      "save_session",
      expect.objectContaining({ id, title: "My custom title" }),
    );

    // A subsequent live turn triggers auto-persist; the manual title must win
    // over the derived first-turn title.
    (invoke as any).mockClear();
    await act(async () => {
      emit("agent://done", { text: "an answer" });
    });
    await waitFor(() => {
      const saveCall = (invoke as any).mock.calls.find(
        (c: any[]) => c[0] === "save_session",
      );
      expect(saveCall?.[1].title).toBe("My custom title");
    });
  });

  it("restores a manual title when switching to a saved session", async () => {
    (invoke as any).mockImplementation(async (cmd: string) => {
      if (cmd === "load_session") {
        return {
          id: "saved-1",
          title: "Human Named",
          messages: [{ role: "user", content: "hello there" }],
        };
      }
      return undefined;
    });
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.switchSession("saved-1");
    });
    // A live turn on the restored session must re-persist under the manual title.
    (invoke as any).mockClear();
    await act(async () => {
      await result.current.send("follow up");
    });
    await act(async () => {
      emit("agent://done", { text: "reply" });
    });
    await waitFor(() => {
      const saveCall = (invoke as any).mock.calls.find(
        (c: any[]) => c[0] === "save_session",
      );
      expect(saveCall?.[1].title).toBe("Human Named");
    });
  });

  it("compact collapses older turns into a durable summary and persists", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("q1");
    });
    const id = result.current.currentSessionId!;
    // Build a transcript with more than the retained recent window.
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        emit("agent://done", { text: `a${i}` });
      });
      await act(async () => {
        await result.current.send(`q${i + 2}`);
      });
    }
    const before = result.current.messages.length;

    await act(async () => {
      await result.current.compact();
    });

    const compactCall = (invoke as any).mock.calls.find(
      (c: any[]) => c[0] === "agent_compact",
    );
    expect(compactCall).toBeTruthy();
    expect(compactCall[1].history.length).toBeGreaterThan(0);
    const first = result.current.messages[0];
    expect(first.role).toBe("assistant");
    expect(first.content).toContain("compacted summary");
    expect(result.current.messages.length).toBeLessThan(before);
  });

  it("compact leaves the transcript intact on backend failure", async () => {
    (invoke as any).mockImplementation(async (cmd: string) => {
      if (cmd === "agent_compact") throw new Error("disk full");
      return undefined;
    });
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("q1");
    });
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        emit("agent://done", { text: `a${i}` });
      });
      await act(async () => {
        await result.current.send(`q${i + 2}`);
      });
    }
    const convoBefore = result.current.messages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    ).length;

    await act(async () => {
      await result.current.compact();
    });

    // No silent truncation: original turns remain, plus an error note.
    const convoAfter = result.current.messages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    expect(convoAfter.length).toBeGreaterThanOrEqual(convoBefore);
    expect(
      convoAfter.some((m) => m.content.includes("failed to compact")),
    ).toBe(true);
  });

  it("compact is a no-op for a short transcript", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => {
      await result.current.send("only question");
    });
    await act(async () => {
      await result.current.compact();
    });
    expect(
      (invoke as any).mock.calls.some((c: any[]) => c[0] === "agent_compact"),
    ).toBe(false);
  });
});

