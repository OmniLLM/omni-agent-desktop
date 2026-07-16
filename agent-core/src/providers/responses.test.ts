import { describe, expect, it } from "bun:test";
import { buildResponsesInput, toResponsesTools, parseResponses } from "./responses.js";

describe("buildResponsesInput", () => {
  it("converts user screenshots to Responses input_image blocks", () => {
    expect(
      buildResponsesInput([
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
          { type: "input_text", text: "Inspect this" },
          { type: "input_image", image_url: "data:image/png;base64,cG5n" },
        ],
      },
    ]);
  });
});

describe("toResponsesTools", () => {
  it("flattens Chat Completions tool schema to the Responses shape", () => {
    const chat = [
      {
        type: "function",
        function: {
          name: "get_time",
          description: "Return the current time.",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
    ];
    expect(toResponsesTools(chat)).toEqual([
      {
        type: "function",
        name: "get_time",
        description: "Return the current time.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ]);
  });

  it("passes through tools already in the flat Responses shape", () => {
    const flat = [
      { type: "function", name: "x", description: "d", parameters: { type: "object" } },
    ];
    expect(toResponsesTools(flat)).toEqual(flat);
  });

  it("defaults a missing description/parameters", () => {
    const [out] = toResponsesTools([
      { type: "function", function: { name: "n" } },
    ]);
    expect(out).toEqual({
      type: "function",
      name: "n",
      description: "",
      parameters: { type: "object", properties: {} },
    });
  });
});

describe("parseResponses", () => {
  it("reads output_text", () => {
    expect(parseResponses({ output_text: "hello" })).toEqual({
      text: "hello",
      tool_calls: [],
    });
  });

  it("extracts function_call tool calls from output", () => {
    const turn = parseResponses({
      output: [
        { type: "function_call", call_id: "c1", name: "get_time", arguments: '{"tz":"utc"}' },
      ],
    });
    expect(turn.tool_calls).toEqual([
      { id: "c1", name: "get_time", args: { tz: "utc" } },
    ]);
  });

  it("reads nested message text blocks when output_text is absent", () => {
    const turn = parseResponses({
      output: [{ type: "message", content: [{ text: "nested" }] }],
    });
    expect(turn.text).toBe("nested");
  });
});
