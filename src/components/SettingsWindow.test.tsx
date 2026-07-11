/**
 * SettingsWindow regression tests — guards against the "Preferences silently
 * wipes user settings" bug.
 *
 * Old behavior: when `invoke("get_settings")` rejected (e.g. cross-machine
 * 401 auth failure between Windows frontend and WSL backend), the catch
 * branch substituted a hardcoded factory-default AppSettings object and
 * rendered the form. The user then either:
 *   (a) saw "wrong" settings (everything reset, no API key, etc.) and assumed
 *       the page was broken; OR
 *   (b) clicked Save anywhere on the form, sending those defaults back to the
 *       backend, which silently overwrote settings.json on disk.
 *
 * New behavior verified here:
 *  - On load failure, the form is NOT rendered.
 *  - The user sees an explicit error message and a Retry button.
 *  - There is NO Save button reachable from the error state (so a
 *    misinterpretation cannot accidentally POST defaults).
 *  - The actual error message text from the backend is shown.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppSettings } from "../types/app";

type RuntimeMock<Return> = (...args: unknown[]) => Promise<Return>;

const invokeMock = vi.fn<RuntimeMock<unknown>>();
const emitMock = vi.fn<RuntimeMock<void>>(async () => {});
const listenMock = vi.fn<RuntimeMock<() => void>>(async () => () => {});

vi.mock("../lib/runtime", () => ({
  invoke: <T,>(...args: unknown[]): Promise<T> => invokeMock(...args) as Promise<T>,
  emit: (...args: unknown[]) => emitMock(...args),
  listen: (...args: unknown[]) => listenMock(...args),
}));

const applyWindowSize = vi.fn(async () => undefined);
vi.mock("../lib/windowSize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/windowSize")>();
  return { ...actual, applyWindowSize };
});

const realSettings: AppSettings = {
  ai_base_url: "http://wsl-backend:5000",
  ai_model: "gpt-5.4",
  ai_api_key: "sk-real-from-wsl",
  active_provider: "custom-provider",
  provider_configs: {
    "custom-provider": {
      endpoint: "http://wsl-backend:5000",
      api_key: "sk-real-from-wsl",
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
  ai_timeout_secs: 240,
  ai_max_tool_iterations: 50,
  ai_max_retry_attempts: 7,
  ai_retry_base_delay_ms: 1500,
  ai_loop_detector_enabled: true,
  theme: "dark",
  hotkey: "Ctrl+Shift+O",
  max_results: 25,
  background_url: "https://example.com/bg.png",
  a2a_connections: [],
  run_mode: "ask",
  backend_url: "http://wsl-backend:1422",
  window_size: "standard",
};

beforeEach(() => {
  invokeMock.mockReset();
  emitMock.mockClear();
  listenMock.mockClear();
  applyWindowSize.mockClear();
  applyWindowSize.mockResolvedValue(undefined);
});

async function importSettingsWindow() {
  const mod = await import("./SettingsWindow");
  return mod.default;
}

describe("SettingsWindow A2A architecture", () => {
  it("presents A2A as client connections to either a hub or direct agent, not server/admin registration", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return realSettings;
      if (cmd === "list_models") return ["gpt-5.4"];
      return undefined;
    });

    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow />);

    fireEvent.click(await screen.findByRole("button", { name: /a2a/i }));

    expect(screen.getByText("A2A Connections")).toBeInTheDocument();
    expect(
      screen.getByText(/connect to omni-agent-hub or direct a2a agents/i),
    ).toBeInTheDocument();
    // Client-side connection list, not server/admin registration.
    expect(screen.queryByText("A2A Server")).not.toBeInTheDocument();
    expect(screen.queryByText(/Hub Admin Key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Auto-register/i)).not.toBeInTheDocument();
  });

  it("adds an A2A connection with an editable endpoint field", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return realSettings;
      if (cmd === "list_models") return ["gpt-5.4"];
      return undefined;
    });

    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow />);

    fireEvent.click(await screen.findByRole("button", { name: /a2a/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /add connection/i }),
    );
    expect(screen.getByLabelText(/endpoint-0/i)).toBeInTheDocument();
  });

  it("does not expose legacy OmniLauncher REST backend settings", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return realSettings;
      if (cmd === "list_models") return ["gpt-5.4"];
      return undefined;
    });

    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow />);

    fireEvent.click(await screen.findByRole("button", { name: /general/i }));

    expect(screen.queryByText("Backend URL")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/1422/)).not.toBeInTheDocument();
  });
});

describe("SettingsWindow load-failure handling", () => {
  it("renders real settings when get_settings succeeds (sanity baseline)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return realSettings;
      if (cmd === "list_models") return ["gpt-5.4", "gpt-4o"];
      return undefined;
    });

    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow />);

    // The Save Settings button is only present when settings loaded.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save settings/i })).toBeInTheDocument(),
    );
    // And the real (non-default) provider URL is displayed.
    expect(screen.getByDisplayValue("http://wsl-backend:5000")).toBeInTheDocument();
  });

  it("does NOT render the Save button when get_settings fails", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") {
        throw new Error("HTTP 401: missing or invalid auth token");
      }
      return undefined;
    });

    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow />);

    // Wait for the load to settle.
    await waitFor(() =>
      expect(
        screen.getByText(/could not load settings/i),
      ).toBeInTheDocument(),
    );

    // No Save button — this is the critical guarantee: the user cannot
    // accidentally trigger a save-of-defaults from the error state.
    expect(
      screen.queryByRole("button", { name: /save settings/i }),
    ).not.toBeInTheDocument();
  });

  it("displays the actual backend error message", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") {
        throw new Error("HTTP 401: missing or invalid auth token");
      }
      return undefined;
    });

    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow />);

    await waitFor(() =>
      expect(
        screen.getByText(/missing or invalid auth token/i),
      ).toBeInTheDocument(),
    );
  });

  it("exposes a Retry button that re-runs get_settings", async () => {
    invokeMock.mockImplementationOnce(async () => {
      throw new Error("HTTP 401");
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return realSettings;
      if (cmd === "list_models") return ["gpt-5.4"];
      return undefined;
    });

    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    // After successful retry, the form renders with real values.
    await waitFor(() =>
      expect(screen.getByDisplayValue("http://wsl-backend:5000")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /save settings/i }),
    ).toBeInTheDocument();
  });

  it("never invokes save_settings_cmd when loading fails", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") {
        throw new Error("HTTP 401");
      }
      return undefined;
    });

    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow />);

    await waitFor(() =>
      expect(
        screen.getByText(/could not load settings/i),
      ).toBeInTheDocument(),
    );

    // Examine every invoke call: none should have been save_settings_cmd.
    const calls = invokeMock.mock.calls.map(([cmd]) => cmd as string);
    expect(calls).not.toContain("save_settings_cmd");
    expect(calls).not.toContain("set_hotkey_cmd");
  });
});

describe("SettingsWindow window size presets", () => {
  beforeEach(() => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return realSettings;
      if (cmd === "list_models") return ["gpt-5.4"];
      return undefined;
    });
  });

  it("previews and saves a window size preset", async () => {
    const user = userEvent.setup();
    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow />);
    await user.click(await screen.findByRole("button", { name: /appearance/i }));
    await user.click(
      screen.getByRole("radio", { name: /compact.*720.*520/i }),
    );
    expect(applyWindowSize).toHaveBeenCalledWith("compact");
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    expect(invokeMock).toHaveBeenCalledWith(
      "save_settings_cmd",
      expect.objectContaining({
        settings: expect.objectContaining({ window_size: "compact" }),
      }),
    );
  });

  it("restores the original size when closed without saving", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow onClose={onClose} />);
    await user.click(await screen.findByRole("button", { name: /appearance/i }));
    await user.click(screen.getByRole("radio", { name: /large.*1280.*720/i }));
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(applyWindowSize).toHaveBeenLastCalledWith("standard");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the previous selection when preview fails", async () => {
    applyWindowSize.mockRejectedValueOnce(new Error("resize failed"));
    const user = userEvent.setup();
    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow />);
    await user.click(await screen.findByRole("button", { name: /appearance/i }));
    await user.click(
      screen.getByRole("radio", { name: /compact.*720.*520/i }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("resize failed");
    expect(
      screen.getByRole("radio", { name: /standard.*960.*640/i }),
    ).toBeChecked();
  });
});
