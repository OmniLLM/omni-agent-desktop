import { describe, expect, it } from "bun:test";
import {
  isCopilotResponsesOnlyModel,
  selectCopilotShape,
} from "./copilot-model-shapes.js";

describe("selectCopilotShape", () => {
  it("routes known chat models to chat", () => {
    expect(selectCopilotShape("gpt-4o")).toBe("chat");
    expect(selectCopilotShape("claude-opus-4.8")).toBe("chat");
    expect(selectCopilotShape("gpt-5.4")).toBe("chat");
  });

  it("routes known responses-only models to responses", () => {
    expect(selectCopilotShape("gpt-5.5")).toBe("responses");
    expect(selectCopilotShape("gpt-5.4-mini")).toBe("responses");
    expect(selectCopilotShape("mai-code-1-flash-picker")).toBe("responses");
  });

  it("is case-insensitive on the map lookup", () => {
    expect(selectCopilotShape("GPT-4O")).toBe("chat");
    expect(selectCopilotShape("GPT-5.5")).toBe("responses");
  });

  it("falls back by family for unknown models", () => {
    // Unknown gpt-* → responses (the bug report: gpt-5.6-terra)
    expect(selectCopilotShape("gpt-5.6-terra")).toBe("responses");
    expect(selectCopilotShape("claude-future")).toBe("messages");
    expect(selectCopilotShape("gemini-9")).toBe("gemini");
    expect(selectCopilotShape("something-else")).toBe("chat");
  });

  it("defaults empty input to chat", () => {
    expect(selectCopilotShape("")).toBe("chat");
  });
});

describe("isCopilotResponsesOnlyModel", () => {
  it("is true only for the responses shape", () => {
    expect(isCopilotResponsesOnlyModel("gpt-5.6-terra")).toBe(true);
    expect(isCopilotResponsesOnlyModel("gpt-4o")).toBe(false);
    // 'messages'/'gemini' are not responses-only.
    expect(isCopilotResponsesOnlyModel("claude-future")).toBe(false);
    expect(isCopilotResponsesOnlyModel("gemini-9")).toBe(false);
  });
});
