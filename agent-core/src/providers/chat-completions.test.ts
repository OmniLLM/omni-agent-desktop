import { describe, expect, it } from "bun:test";
import { buildMessages } from "./chat-completions.js";

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
