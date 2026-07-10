import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import App from "./App";

vi.mock("./lib/runtime", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_settings")
      return {
        active_provider: "custom-provider",
        provider_configs: {},
        a2a_connections: [],
        run_mode: "ask",
        ai_base_url: "",
        ai_model: "",
        ai_api_key: "",
        ai_timeout_secs: 120,
        ai_max_tool_iterations: 10,
        ai_max_retry_attempts: 3,
        ai_retry_base_delay_ms: 2000,
        ai_loop_detector_enabled: true,
        theme: "system",
        hotkey: "Ctrl+Shift+O",
        max_results: 10,
        background_url: "",
        backend_url: "",
      };
    return undefined;
  }),
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}));

describe("App", () => {
  it("renders the composer and no launcher search", async () => {
    render(<App />);
    expect(
      await screen.findByPlaceholderText(/ask the agent/i),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
  });
});
