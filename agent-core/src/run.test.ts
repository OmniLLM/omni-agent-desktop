import { describe, expect, it } from "bun:test";
import { CancelledError, isAbortError, runOnce } from "./run.js";
import type { ParsedTurn, Provider } from "./providers/types.js";

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
