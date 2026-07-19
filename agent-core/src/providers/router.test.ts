import { afterEach, describe, expect, it, mock } from "bun:test";
import { pickProvider } from "./router.js";
import { defaultSettings, type AppSettings, type ProviderConfig } from "../settings.js";

type FetchCapture = { urls: string[]; bodies: string[] };
const capture: FetchCapture = { urls: [], bodies: [] };
let responseJson: unknown = { output_text: "ok", output: [] };

mock.module("../http.js", () => ({
  httpFetch: async (url: string, init: { body?: unknown } = {}) => {
    capture.urls.push(String(url));
    capture.bodies.push(String(init.body));
    return new Response(JSON.stringify(responseJson), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

afterEach(() => {
  capture.urls.length = 0;
  capture.bodies.length = 0;
  responseJson = { output_text: "ok", output: [] };
});

function settingsWith(cfg: Partial<ProviderConfig>): AppSettings {
  const s = defaultSettings();
  s.active_provider = "custom-provider";
  s.provider_configs!["custom-provider"] = {
    ...s.provider_configs!["custom-provider"],
    endpoint: "https://example.com/v1",
    api_key: "k",
    model: "m",
    ...cfg,
  };
  return s;
}

describe("router openai-responses dispatch", () => {
  it("routes openai-responses to the responses provider (/responses, not /chat/completions)", async () => {
    const provider = pickProvider(settingsWith({ api_shape: "openai-responses" }), null);
    await provider.infer("sys", [{ role: "user", content: "hi" }], []);
    expect(capture.urls).toHaveLength(1);
    expect(capture.urls[0]).toBe("https://example.com/v1/responses");
    expect(capture.urls[0]).not.toContain("/chat/completions");
  });

  it("routes openai-compatible to chat-completions (/chat/completions)", async () => {
    responseJson = { choices: [{ message: { content: "ok" } }] };
    const provider = pickProvider(settingsWith({ api_shape: "openai-compatible" }), null);
    await provider.infer("sys", [{ role: "user", content: "hi" }], []);
    expect(capture.urls[0]).toBe("https://example.com/v1/chat/completions");
  });
});

describe("responses provider tool-call round-trip", () => {
  it("sends function_call + function_call_output items with matching call_id", async () => {
    const provider = pickProvider(settingsWith({ api_shape: "openai-responses" }), null);
    await provider.infer(
      "sys",
      [
        { role: "user", content: "time?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "fc_9", name: "get_time", args: {} }],
        },
        { role: "tool", content: "noon", tool_call_id: "fc_9" },
      ],
      [],
    );
    const sent = JSON.parse(capture.bodies[0]) as { input: Array<Record<string, unknown>> };
    expect(sent.input).toEqual([
      { role: "user", content: "time?" },
      { type: "function_call", call_id: "fc_9", name: "get_time", arguments: "{}" },
      { type: "function_call_output", call_id: "fc_9", output: "noon" },
    ]);
  });
});
