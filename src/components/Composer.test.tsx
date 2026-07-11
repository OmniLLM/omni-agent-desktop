import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import Composer from "./Composer";
import type { AppSettings } from "../types/app";

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ai_base_url: "http://backend",
    ai_model: "gpt-5.4",
    ai_api_key: "sk-x",
    active_provider: "custom-provider",
    provider_configs: {
      "custom-provider": {
        endpoint: "http://backend",
        api_key: "sk-x",
        api_shape: "openai-compatible",
        model: "gpt-5.4",
        manual_models: "",
      },
      "github-copilot": {
        endpoint: "",
        api_key: "",
        api_shape: "openai-compatible",
        model: "",
        manual_models: "",
      },
      "azure-foundry": {
        endpoint: "",
        api_key: "",
        api_shape: "openai-compatible",
        model: "",
        manual_models: "",
      },
    },
    ai_timeout_secs: 120,
    ai_max_tool_iterations: 10,
    ai_max_retry_attempts: 3,
    ai_retry_base_delay_ms: 2000,
    ai_loop_detector_enabled: true,
    theme: "dark",
    hotkey: "Ctrl+Shift+O",
    max_results: 10,
    background_url: "",
    a2a_connections: [],
    run_mode: "ask",
    backend_url: "",
    window_size: "standard",
    ...overrides,
  };
}

describe("Composer", () => {
  it("submits typed text and clears the input", async () => {
    const onSend = vi.fn();
    render(
      <Composer onSend={onSend} disabled={false} settings={makeSettings()} />,
    );
    const textbox = screen.getByRole("textbox");
    await userEvent.type(textbox, "do it");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith("do it");
    expect(textbox).toHaveValue("");
  });

  it("submits on Enter without Shift", async () => {
    const onSend = vi.fn();
    render(
      <Composer onSend={onSend} disabled={false} settings={makeSettings()} />,
    );
    await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("shows the active model and no project/plugins chips", () => {
    render(
      <Composer onSend={vi.fn()} disabled={false} settings={makeSettings()} />,
    );
    expect(screen.getByText("gpt-5.4")).toBeInTheDocument();
    expect(screen.queryByText(/choose project/i)).toBeNull();
    expect(screen.queryByText(/^plugins$/i)).toBeNull();
  });

  it("opens the model picker and switches provider", async () => {
    const onModelChange = vi.fn();
    render(
      <Composer
        onSend={vi.fn()}
        disabled={false}
        settings={makeSettings()}
        onModelChange={onModelChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /gpt-5\.4/i }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("option", { name: /github copilot/i }),
    );
    expect(onModelChange).toHaveBeenCalledWith("github-copilot", "");
  });

  it("filters models as you type in the picker", async () => {
    const user = userEvent.setup();
    render(
      <Composer onSend={vi.fn()} disabled={false} settings={makeSettings()} />,
    );
    await user.click(screen.getByRole("button", { name: /gpt-5\.4/i }));
    const filterBox = screen.getByPlaceholderText(/filter models/i);
    // The active model appears as an option; a matching filter keeps it.
    await user.type(filterBox, "gpt");
    expect(
      screen.getByRole("option", { name: /^gpt-5\.4$/i }),
    ).toBeInTheDocument();
    // A non-matching filter shows the "No matches" empty state.
    await user.clear(filterBox);
    await user.type(filterBox, "zzz");
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
  });

  it("toggles Approve for me and reports the new value", async () => {
    const onToggleApprove = vi.fn();
    render(
      <Composer
        onSend={vi.fn()}
        disabled={false}
        settings={makeSettings()}
        approveForMe={false}
        onToggleApprove={onToggleApprove}
      />,
    );
    const toggle = screen.getByRole("button", { name: /approve for me/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(onToggleApprove).toHaveBeenCalledWith(true);
  });
});
