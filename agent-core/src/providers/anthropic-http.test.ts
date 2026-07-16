import { describe, expect, it } from "bun:test";
import { buildAnthropicMessages } from "./anthropic-http.js";

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
