import { describe, expect, it } from "bun:test";
import { buildAnthropicMessages } from "./anthropic-http.js";

describe("buildAnthropicMessages tool-call continuation", () => {
  it("emits assistant tool_use then a user tool_result — no two consecutive user turns", () => {
    const out = buildAnthropicMessages([
      { role: "user", content: "what time" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [{ id: "toolu_1", name: "get_time", args: { tz: "utc" } }],
      },
      { role: "tool", content: "12:00", tool_call_id: "toolu_1" },
    ]) as Array<{ role: string; content: unknown }>;
    expect(out).toEqual([
      { role: "user", content: "what time" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "toolu_1", name: "get_time", input: { tz: "utc" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "12:00" },
        ],
      },
    ]);
    // No two consecutive user turns.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].role === "user" && out[i - 1].role === "user").toBe(false);
    }
  });
});

describe("buildAnthropicMessages", () => {
  it("converts data URLs to Anthropic base64 image blocks", () => {
    expect(
      buildAnthropicMessages([
        {
          role: "user",
          content: "Inspect this",
          images: [
            {
              data_url: "data:image/png;base64,cG5n",
              mime_type: "image/png",
              name: "screenshot.png",
            },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "cG5n",
            },
          },
        ],
      },
    ]);
  });
});
