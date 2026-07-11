import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import App from "./App";

const applyWindowSize = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./lib/windowSize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/windowSize")>();
  return { ...actual, applyWindowSize };
});

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
        window_size: "compact",
      };
    return undefined;
  }),
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}));

describe("App", () => {
  it("renders the workspace composer and no launcher search", async () => {
    render(<App />);
    expect(
      await screen.findByPlaceholderText(/do anything/i),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
  });

  it("renders the workspace sidebar with New task and Settings", async () => {
    render(<App />);
    expect(
      await screen.findByRole("button", { name: /new task/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^settings$/i }),
    ).toBeInTheDocument();
    expect(document.querySelector(".sidebar")).not.toBeNull();
  });

  it("shows the welcome empty-state when there are no messages", async () => {
    render(<App />);
    expect(
      await screen.findByText(/what should we get done/i),
    ).toBeInTheDocument();
  });

  it("applies the saved window size after settings load", async () => {
    render(<App />);
    await waitFor(() =>
      expect(applyWindowSize).toHaveBeenCalledWith("compact"),
    );
  });
});
