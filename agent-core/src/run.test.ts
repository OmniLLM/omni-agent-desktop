import { describe, expect, it } from "bun:test";
import { CancelledError, isAbortError, runOnce } from "./run.js";
import type { Msg, ParsedTurn, Provider } from "./providers/types.js";
import { buildMessages } from "./providers/chat-completions.js";
import { buildAnthropicMessages } from "./providers/anthropic-http.js";

function provider(
  impl: (signal?: AbortSignal) => Promise<ParsedTurn>,
): Provider & { lastSignal?: AbortSignal } {
  const result: Provider & { lastSignal?: AbortSignal } = {
    async infer(_system, _messages, _tools, signal) {
      result.lastSignal = signal;
      return impl(signal);
    },
  };
  return result;
}

const baseInput = {
  mode: "autopilot" as const,
  system: "s",
  messages: [{ role: "user" as const, content: "hi" }],
  toolDefs: [],
  maxIterations: 5,
  isA2A: () => false,
  isMutating: () => false,
  runTool: async () => "",
  emit: () => {},
};

describe("isAbortError", () => {
  it("recognizes cancellation errors", () => {
    expect(isAbortError(new CancelledError())).toBe(true);
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(isAbortError(error)).toBe(true);
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError(new Error("boom"))).toBe(false);
  });
});

describe("runOnce cancellation", () => {
  it("passes the signal to provider inference", async () => {
    const controller = new AbortController();
    const mockProvider = provider(async () => ({ text: "done", tool_calls: [] }));
    await runOnce({
      ...baseInput,
      provider: mockProvider,
      signal: controller.signal,
    });
    expect(mockProvider.lastSignal).toBe(controller.signal);
  });

  it("rejects when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runOnce({
        ...baseInput,
        provider: provider(async () => ({ text: "done", tool_calls: [] })),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it("maps provider AbortError and preserves ordinary errors", async () => {
    const aborted = provider(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(runOnce({ ...baseInput, provider: aborted })).rejects.toBeInstanceOf(
      CancelledError,
    );

    const failed = provider(async () => {
      throw new Error("http 500");
    });
    await expect(runOnce({ ...baseInput, provider: failed })).rejects.toThrow(
      "http 500",
    );
  });
});

describe("runOnce tool-call continuation", () => {
  /** Capture the message history the provider sees on the 2nd inference. */
  function recordingProvider(firstTurn: ParsedTurn): {
    provider: Provider;
    secondCallMessages: Msg[] | null;
  } {
    const state: { provider: Provider; secondCallMessages: Msg[] | null } = {
      secondCallMessages: null,
      provider: {
        async infer(_system, messages) {
          // First call: return the tool-call turn. Follow-up call (after tool
          // results are appended): capture the history and finish.
          const hasToolTurn = messages.some((m) => m.role === "tool");
          if (hasToolTurn) {
            state.secondCallMessages = [...messages];
            return { text: "final answer", tool_calls: [] };
          }
          return firstTurn;
        },
      },
    };
    return state;
  }

  it("preserves the provider-native id and records assistant + tool turns (chat-completions)", async () => {
    const rec = recordingProvider({
      text: "let me check",
      tool_calls: [{ id: "call_native_1", name: "get_time", args: { tz: "utc" } }],
    });
    await runOnce({
      ...baseInput,
      provider: rec.provider,
      runTool: async () => "12:00",
    });
    const msgs = rec.secondCallMessages!;
    // user, assistant(tool_calls), tool
    const assistant = msgs.find((m) => m.role === "assistant")!;
    const tool = msgs.find((m) => m.role === "tool")!;
    expect(assistant.tool_calls?.[0]?.id).toBe("call_native_1");
    expect(tool.tool_call_id).toBe("call_native_1");
    expect(tool.content).toBe("12:00");

    // Chat Completions wire shape: assistant.tool_calls[].id === tool.tool_call_id.
    const wire = buildMessages("s", msgs) as Array<Record<string, unknown>>;
    const wAssistant = wire.find((m) => m.role === "assistant") as {
      tool_calls: Array<{ id: string }>;
    };
    const wTool = wire.find((m) => m.role === "tool") as { tool_call_id: string };
    expect(wAssistant.tool_calls[0].id).toBe(wTool.tool_call_id);
    expect(wAssistant.tool_calls[0].id).toBe("call_native_1");
  });

  it("produces no two consecutive user turns on the anthropic-http path", async () => {
    const rec = recordingProvider({
      text: "",
      tool_calls: [{ id: "toolu_native", name: "get_time", args: {} }],
    });
    await runOnce({
      ...baseInput,
      provider: rec.provider,
      runTool: async () => "noon",
    });
    const wire = buildAnthropicMessages(rec.secondCallMessages!) as Array<{ role: string }>;
    for (let i = 1; i < wire.length; i++) {
      expect(wire[i].role === "user" && wire[i - 1].role === "user").toBe(false);
    }
    // The assistant tool_use id matches the tool_result id.
    const asst = wire.find((m) => m.role === "assistant") as {
      content: Array<{ type: string; id?: string }>;
    };
    const usr = wire.find(
      (m) => m.role === "user" && Array.isArray((m as { content: unknown }).content),
    ) as { content: Array<{ type: string; tool_use_id?: string }> };
    const useId = asst.content.find((b) => b.type === "tool_use")!.id;
    const resId = usr.content.find((b) => b.type === "tool_result")!.tool_use_id;
    expect(useId).toBe("toolu_native");
    expect(resId).toBe("toolu_native");
  });

  it("mints a stable uuid when the provider omits a tool-call id", async () => {
    const rec = recordingProvider({
      text: "",
      tool_calls: [{ id: "", name: "get_time", args: {} }],
    });
    await runOnce({
      ...baseInput,
      provider: rec.provider,
      runTool: async () => "x",
    });
    const msgs = rec.secondCallMessages!;
    const id = msgs.find((m) => m.role === "assistant")!.tool_calls![0].id;
    expect(id.length).toBeGreaterThan(0);
    expect(msgs.find((m) => m.role === "tool")!.tool_call_id).toBe(id);
  });
});
