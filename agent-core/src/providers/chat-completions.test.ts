import { describe, expect, it } from "bun:test";
import { buildMessages } from "./chat-completions.js";

describe("buildMessages tool-call continuation", () => {
  it("serializes an assistant tool-call turn and a tool-result turn", () => {
    const out = buildMessages("", [
      { role: "user", content: "what time" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_abc", name: "get_time", args: { tz: "utc" } }],
      },
      { role: "tool", content: "12:00", tool_call_id: "call_abc" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "what time" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "get_time", arguments: '{"tz":"utc"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: "12:00" },
    ]);
  });
});

describe("buildMessages multimodal input", () => {
  it("converts user screenshots to OpenAI image_url content blocks", () => {
    expect(
      buildMessages("", [
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
            type: "image_url",
            image_url: { url: "data:image/png;base64,cG5n" },
          },
        ],
      },
    ]);
  });
});
