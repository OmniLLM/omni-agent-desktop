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
  a2a_timeout_secs: 240,
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

describe("SettingsWindow background preview", () => {
  beforeEach(() => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return realSettings;
      if (cmd === "list_models") return ["gpt-5.4"];
      return undefined;
    });
  });

  it("live-previews a valid draft URL via onBackgroundPreview", async () => {
    const user = userEvent.setup();
    const onBackgroundPreview = vi.fn();
    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow onBackgroundPreview={onBackgroundPreview} />);
    await user.click(await screen.findByRole("button", { name: /appearance/i }));
    const input = screen.getByPlaceholderText(/example\.com\/image/i);
    await user.clear(input);
    await user.type(input, "https://cdn.example.com/new.png");
    expect(onBackgroundPreview).toHaveBeenLastCalledWith(
      "https://cdn.example.com/new.png",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an inline error and does not preview an invalid URL", async () => {
    const user = userEvent.setup();
    const onBackgroundPreview = vi.fn();
    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow onBackgroundPreview={onBackgroundPreview} />);
    await user.click(await screen.findByRole("button", { name: /appearance/i }));
    const input = screen.getByPlaceholderText(/example\.com\/image/i);
    await user.clear(input);
    onBackgroundPreview.mockClear();
    await user.type(input, "javascript:alert(1)");
    expect(await screen.findByRole("alert")).toHaveTextContent(/valid/i);
    expect(onBackgroundPreview).not.toHaveBeenCalledWith("javascript:alert(1)");
  });

  it("restores the persisted background when closed without saving", async () => {
    const user = userEvent.setup();
    const onBackgroundPreview = vi.fn();
    const onClose = vi.fn();
    const SettingsWindow = await importSettingsWindow();
    render(
      <SettingsWindow
        onBackgroundPreview={onBackgroundPreview}
        onClose={onClose}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /appearance/i }));
    const input = screen.getByPlaceholderText(/example\.com\/image/i);
    await user.clear(input);
    await user.type(input, "https://cdn.example.com/new.png");
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(onBackgroundPreview).toHaveBeenLastCalledWith(
      "https://example.com/bg.png",
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("retains the previewed background after a successful save, then close does not roll it back", async () => {
    const user = userEvent.setup();
    const onBackgroundPreview = vi.fn();
    const onClose = vi.fn();
    const SettingsWindow = await importSettingsWindow();
    render(
      <SettingsWindow
        onBackgroundPreview={onBackgroundPreview}
        onClose={onClose}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /appearance/i }));
    const input = screen.getByPlaceholderText(/example\.com\/image/i);
    await user.clear(input);
    await user.type(input, "https://cdn.example.com/new.png");
    expect(onBackgroundPreview).toHaveBeenLastCalledWith(
      "https://cdn.example.com/new.png",
    );

    // Save succeeds and persists the new URL.
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_settings_cmd",
        expect.objectContaining({
          settings: expect.objectContaining({
            background_url: "https://cdn.example.com/new.png",
          }),
        }),
      ),
    );

    onBackgroundPreview.mockClear();
    // Closing after a successful save must NOT roll the preview back to the
    // OLD persisted URL — the just-saved URL is now the persisted one.
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
    const rolledBackToOld = onBackgroundPreview.mock.calls.some(
      ([url]) => url === "https://example.com/bg.png",
    );
    expect(rolledBackToOld).toBe(false);
    // If close re-asserts a preview at all, it must be the saved URL.
    for (const [url] of onBackgroundPreview.mock.calls) {
      expect(url).toBe("https://cdn.example.com/new.png");
    }
  });

  it("shows an accessible Saved indicator after persistence succeeds", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return realSettings;
      if (cmd === "list_models") return ["gpt-5.4"];
      return undefined;
    });
    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow />);

    await user.click(
      await screen.findByRole("button", { name: /save settings/i }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(/saved/i);
    expect(screen.getByRole("button", { name: /saved/i })).toBeDisabled();
    expect(invokeMock).toHaveBeenCalledWith(
      "save_settings_cmd",
      expect.objectContaining({
        settings: expect.objectContaining({
          active_provider: "custom-provider",
          provider_configs: realSettings.provider_configs,
        }),
      }),
    );
  });

  it("restores the persisted background when a save fails", async () => {
    const user = userEvent.setup();
    const onBackgroundPreview = vi.fn();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_settings") return realSettings;
      if (cmd === "list_models") return ["gpt-5.4"];
      if (cmd === "save_settings_cmd") throw new Error("save failed");
      return undefined;
    });
    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow onBackgroundPreview={onBackgroundPreview} />);
    await user.click(await screen.findByRole("button", { name: /appearance/i }));
    const input = screen.getByPlaceholderText(/example\.com\/image/i);
    await user.clear(input);
    await user.type(input, "https://cdn.example.com/new.png");
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByText(/save failed/i)).toBeInTheDocument();
    expect(onBackgroundPreview).toHaveBeenLastCalledWith(
      "https://example.com/bg.png",
    );
  });

  it("warns when the background image fails to load at runtime but keeps the draft", async () => {
    const user = userEvent.setup();
    const onBackgroundPreview = vi.fn();
    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow onBackgroundPreview={onBackgroundPreview} />);
    await user.click(await screen.findByRole("button", { name: /appearance/i }));
    const input = screen.getByPlaceholderText(
      /example\.com\/image/i,
    ) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "https://cdn.example.com/broken.png");

    // Simulate the browser failing to load the image at runtime.
    const probe = screen.getByTestId("background-probe") as HTMLImageElement;
    fireEvent.error(probe);

    // A warning is shown…
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
    // …but the draft URL is retained (not cleared).
    expect(input.value).toBe("https://cdn.example.com/broken.png");
  });

  it("clears the runtime load warning once an image loads successfully", async () => {
    const user = userEvent.setup();
    const onBackgroundPreview = vi.fn();
    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow onBackgroundPreview={onBackgroundPreview} />);
    await user.click(await screen.findByRole("button", { name: /appearance/i }));
    const input = screen.getByPlaceholderText(/example\.com\/image/i);
    await user.clear(input);
    await user.type(input, "https://cdn.example.com/broken.png");
    fireEvent.error(screen.getByTestId("background-probe"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);

    await user.clear(input);
    await user.type(input, "https://cdn.example.com/good.png");
    fireEvent.load(screen.getByTestId("background-probe"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Provider-aware AI settings UI (Task 6)
// ---------------------------------------------------------------------------

function providerSettings(): AppSettings {
  return {
    ...realSettings,
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
        api_key_stored: false,
        api_shape: "openai-responses",
        model: "",
        manual_models: "",
      },
      "azure-foundry": {
        endpoint: "https://my.openai.azure.com",
        api_key: "",
        api_key_stored: true,
        api_shape: "openai-responses",
        model: "gpt-4o",
        azure_api_version: "2024-02-01",
        azure_deployments: [{ model: "gpt-4o", deployment: "prod-4o" }],
        manual_models: "",
      },
    },
  };
}

function mockProviderInvoke(overrides: Record<string, unknown> = {}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd in overrides) {
      const v = overrides[cmd];
      return typeof v === "function" ? (v as () => unknown)() : v;
    }
    if (cmd === "get_settings") return providerSettings();
    if (cmd === "list_models") return ["gpt-5.4", "gpt-4o"];
    if (cmd === "get_copilot_auth_status") return { state: "disconnected" };
    return undefined;
  });
}

async function openAiSettings() {
  const SettingsWindow = await importSettingsWindow();
  render(<SettingsWindow />);
  await screen.findByRole("button", { name: /save settings/i });
  return SettingsWindow;
}

describe("SettingsWindow provider selector", () => {
  beforeEach(() => mockProviderInvoke());

  it("shows a provider selector defaulting to the active provider", async () => {
    await openAiSettings();
    const selector = (await screen.findByLabelText(
      /ai provider/i,
    )) as HTMLSelectElement;
    expect(selector.value).toBe("custom-provider");
  });

  it("switching providers preserves each provider's independent draft", async () => {
    const user = userEvent.setup();
    await openAiSettings();
    const selector = (await screen.findByLabelText(
      /ai provider/i,
    )) as HTMLSelectElement;

    const endpoint = screen.getByLabelText(/provider url/i) as HTMLInputElement;
    await user.clear(endpoint);
    await user.type(endpoint, "http://edited-custom:9000");

    await user.selectOptions(selector, "azure-foundry");
    expect(screen.getByLabelText(/^endpoint$/i)).toHaveValue(
      "https://my.openai.azure.com",
    );
    await user.selectOptions(selector, "custom-provider");
    expect(screen.getByLabelText(/provider url/i)).toHaveValue(
      "http://edited-custom:9000",
    );
  });
});

describe("Custom provider fields", () => {
  beforeEach(() => mockProviderInvoke());

  it("renders endpoint, key, api shape and model", async () => {
    const user = userEvent.setup();
    await openAiSettings();
    expect(screen.getByLabelText(/provider url/i)).toHaveValue(
      "http://wsl-backend:5000",
    );
    const shape = screen.getByLabelText(/api shape/i) as HTMLSelectElement;
    expect(shape.value).toBe("openai-compatible");
    await user.selectOptions(shape, "anthropic-messages");
    expect(
      (screen.getByLabelText(/api shape/i) as HTMLSelectElement).value,
    ).toBe("anthropic-messages");
  });

  it("saves custom provider_configs authoritatively", async () => {
    const user = userEvent.setup();
    await openAiSettings();
    const model = screen.getByLabelText(/^model$/i);
    await user.clear(model);
    await user.type(model, "gpt-4o");
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_settings_cmd",
        expect.objectContaining({
          settings: expect.objectContaining({
            active_provider: "custom-provider",
            provider_configs: expect.objectContaining({
              "custom-provider": expect.objectContaining({ model: "gpt-4o" }),
            }),
          }),
        }),
      ),
    );
  });
});

describe("Copilot provider fields", () => {
  async function selectCopilot(user: ReturnType<typeof userEvent.setup>) {
    await openAiSettings();
    await user.selectOptions(
      await screen.findByLabelText(/ai provider/i),
      "github-copilot",
    );
  }

  it("shows disconnected state and starts a device flow", async () => {
    mockProviderInvoke({
      start_copilot_device_flow: {
        state: "awaiting_user",
        flow_id: "f1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_at: Math.floor(Date.now() / 1000) + 900,
      },
    });
    const user = userEvent.setup();
    await selectCopilot(user);
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /connect with github/i }),
    );
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /github\.com\/login\/device/i }),
    ).toBeInTheDocument();
  });

  it("cancels a pending device flow", async () => {
    mockProviderInvoke({
      start_copilot_device_flow: {
        state: "awaiting_user",
        flow_id: "f1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_at: Math.floor(Date.now() / 1000) + 900,
      },
    });
    const user = userEvent.setup();
    await selectCopilot(user);
    await user.click(
      screen.getByRole("button", { name: /connect with github/i }),
    );
    await screen.findByText("ABCD-1234");
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(
          ([c]) => c === "cancel_copilot_device_flow",
        ),
      ).toBe(true),
    );
  });

  it("supports the manual token fallback", async () => {
    mockProviderInvoke({
      connect_copilot_with_token: { state: "connected", login: "octocat" },
    });
    const user = userEvent.setup();
    await selectCopilot(user);
    const tokenInput = screen.getByLabelText(/github token/i);
    await user.type(tokenInput, "ghp_secrettoken");
    await user.click(
      screen.getByRole("button", { name: /connect with token/i }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "connect_copilot_with_token",
        expect.objectContaining({ token: "ghp_secrettoken" }),
      ),
    );
    expect(await screen.findByText(/octocat/i)).toBeInTheDocument();
  });

  it("discovers, selects a model, and disconnects when connected", async () => {
    mockProviderInvoke({
      get_copilot_auth_status: { state: "connected", login: "octocat" },
      list_copilot_models: [
        {
          id: "gpt-4o",
          supported_endpoints: ["/chat/completions"],
          endpoint: "chat_completions",
        },
        {
          id: "o1",
          supported_endpoints: ["/responses"],
          endpoint: "responses",
        },
      ],
    });
    const user = userEvent.setup();
    await selectCopilot(user);
    const modelInput = await screen.findByLabelText("Model");
    await waitFor(() => {
      const options = document.querySelectorAll("#copilot-model-list option");
      expect(Array.from(options, (option) => option.getAttribute("value"))).toContain(
        "o1",
      );
    });
    await user.type(modelInput, "o1");
    expect(modelInput).toHaveValue("o1");
    await user.click(screen.getByRole("button", { name: /disconnect/i }));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(([c]) => c === "disconnect_copilot"),
      ).toBe(true),
    );
  });

  it("shows an error state without leaking a token", async () => {
    mockProviderInvoke({
      get_copilot_auth_status: {
        state: "error",
        message: "device flow expired",
      },
    });
    const user = userEvent.setup();
    await selectCopilot(user);
    expect(await screen.findByText(/device flow expired/i)).toBeInTheDocument();
  });
});

describe("Azure provider fields", () => {
  async function selectAzure(user: ReturnType<typeof userEvent.setup>) {
    await openAiSettings();
    await user.selectOptions(
      await screen.findByLabelText(/ai provider/i),
      "azure-foundry",
    );
  }

  it("renders endpoint, key, api version, and existing mappings", async () => {
    const user = userEvent.setup();
    mockProviderInvoke();
    await selectAzure(user);
    expect(screen.getByLabelText(/^endpoint$/i)).toHaveValue(
      "https://my.openai.azure.com",
    );
    expect(screen.getByLabelText(/api version/i)).toHaveValue("2024-02-01");
    expect(screen.getByLabelText(/azure-model-0/i)).toHaveValue("gpt-4o");
    expect(screen.getByLabelText(/azure-deployment-0/i)).toHaveValue("prod-4o");
  });

  it("adds, edits, and deletes deployment mappings with stable keys", async () => {
    const user = userEvent.setup();
    mockProviderInvoke();
    await selectAzure(user);
    await user.click(screen.getByRole("button", { name: /add mapping/i }));
    await user.type(screen.getByLabelText(/azure-model-1/i), "o1-mini");
    await user.type(screen.getByLabelText(/azure-deployment-1/i), "prod-o1");
    expect(screen.getByLabelText(/azure-model-1/i)).toHaveValue("o1-mini");
    await user.click(screen.getByRole("button", { name: /remove-mapping-0/i }));
    expect(screen.getByLabelText(/azure-model-0/i)).toHaveValue("o1-mini");
  });

  it("shows an inline duplicate error for repeated model names", async () => {
    const user = userEvent.setup();
    mockProviderInvoke();
    await selectAzure(user);
    await user.click(screen.getByRole("button", { name: /add mapping/i }));
    await user.type(screen.getByLabelText(/azure-model-1/i), "gpt-4o");
    await user.type(screen.getByLabelText(/azure-deployment-1/i), "prod-dup");
    expect(await screen.findByRole("alert")).toHaveTextContent(/duplicate/i);
  });

  it("runs Test Connection using the unsaved draft and request key", async () => {
    const user = userEvent.setup();
    mockProviderInvoke({
      test_azure_connection: "Azure connection succeeded",
    });
    await selectAzure(user);
    const key = screen.getByLabelText(/^api key$/i);
    await user.type(key, "azkey-123");
    await user.click(screen.getByRole("button", { name: /test connection/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "test_azure_connection",
        expect.objectContaining({
          draft: expect.objectContaining({
            endpoint: "https://my.openai.azure.com",
          }),
          apiKey: "azkey-123",
        }),
      ),
    );
    expect(
      await screen.findByText(/azure connection succeeded/i),
    ).toBeInTheDocument();
  });

  it("saves azure provider_configs authoritatively on Save", async () => {
    const user = userEvent.setup();
    mockProviderInvoke();
    await selectAzure(user);
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_settings_cmd",
        expect.objectContaining({
          settings: expect.objectContaining({
            active_provider: "azure-foundry",
            provider_configs: expect.objectContaining({
              "azure-foundry": expect.objectContaining({
                azure_api_version: "2024-02-01",
              }),
            }),
          }),
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Spec-review gap fixes (Task 6 follow-up)
// ---------------------------------------------------------------------------

describe("Custom draft-aware model discovery (gap 1)", () => {
  it("discovers models using the current unsaved custom draft, not settings.ai_*", async () => {
    const user = userEvent.setup();
    mockProviderInvoke();
    await openAiSettings();

    const endpoint = screen.getByLabelText(/provider url/i) as HTMLInputElement;
    await user.clear(endpoint);
    await user.type(endpoint, "http://draft-endpoint:7000");
    const key = screen.getByLabelText(/^api key$/i);
    await user.clear(key);
    await user.type(key, "draft-key-xyz");

    invokeMock.mockClear();
    await user.click(screen.getByRole("button", { name: /discover models/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "list_models",
        expect.objectContaining({
          baseUrl: "http://draft-endpoint:7000",
          apiKey: "draft-key-xyz",
        }),
      ),
    );
  });
});

describe("Save-time provider validation guards (gap 2)", () => {
  it("blocks save and shows a field error when the custom endpoint is empty", async () => {
    const user = userEvent.setup();
    mockProviderInvoke();
    await openAiSettings();
    const endpoint = screen.getByLabelText(/provider url/i);
    await user.clear(endpoint);
    invokeMock.mockClear();
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/endpoint/i);
    expect(
      invokeMock.mock.calls.some(([c]) => c === "save_settings_cmd"),
    ).toBe(false);
  });

  it("blocks save for Copilot when not connected", async () => {
    const user = userEvent.setup();
    mockProviderInvoke();
    await openAiSettings();
    await user.selectOptions(
      await screen.findByLabelText(/ai provider/i),
      "github-copilot",
    );
    invokeMock.mockClear();
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/connect/i);
    expect(
      invokeMock.mock.calls.some(([c]) => c === "save_settings_cmd"),
    ).toBe(false);
  });

  it("blocks save for Azure when the selected model is not a mapped model", async () => {
    const user = userEvent.setup();
    mockProviderInvoke();
    await openAiSettings();
    await user.selectOptions(
      await screen.findByLabelText(/ai provider/i),
      "azure-foundry",
    );
    // Remove the only mapping so the selected model "gpt-4o" has no membership.
    await user.click(screen.getByRole("button", { name: /remove-mapping-0/i }));
    invokeMock.mockClear();
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.some(([c]) => c === "save_settings_cmd"),
    ).toBe(false);
  });

  it("preserves drafts and does not close when save is blocked by validation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockProviderInvoke();
    const SettingsWindow = await importSettingsWindow();
    render(<SettingsWindow onClose={onClose} />);
    await screen.findByRole("button", { name: /save settings/i });
    const endpoint = screen.getByLabelText(/provider url/i) as HTMLInputElement;
    await user.clear(endpoint);
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // Draft field retained (still empty as edited), dialog not closed.
    expect(endpoint.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Azure selected-model selector (gap 3)", () => {
  it("constrains the selected model to the normalized mapping models", async () => {
    const user = userEvent.setup();
    mockProviderInvoke();
    await openAiSettings();
    await user.selectOptions(
      await screen.findByLabelText(/ai provider/i),
      "azure-foundry",
    );
    const selector = screen.getByLabelText(
      /selected model/i,
    ) as HTMLSelectElement;
    expect(selector.tagName).toBe("SELECT");
    const optionValues = Array.from(selector.options).map((o) => o.value);
    expect(optionValues).toContain("gpt-4o");
  });
});

describe("Clear stored credential affordance (gap 4)", () => {
  it("retains blank key + stored flag when Azure key left blank on save", async () => {
    const user = userEvent.setup();
    mockProviderInvoke();
    await openAiSettings();
    await user.selectOptions(
      await screen.findByLabelText(/ai provider/i),
      "azure-foundry",
    );
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_settings_cmd",
        expect.objectContaining({
          settings: expect.objectContaining({
            provider_configs: expect.objectContaining({
              "azure-foundry": expect.objectContaining({
                api_key: "",
                api_key_stored: true,
              }),
            }),
          }),
        }),
      ),
    );
  });

  it("clears the stored credential (api_key='' , api_key_stored=false) via Clear", async () => {
    const user = userEvent.setup();
    mockProviderInvoke();
    await openAiSettings();
    await user.selectOptions(
      await screen.findByLabelText(/ai provider/i),
      "azure-foundry",
    );
    await user.click(
      screen.getByRole("button", { name: /clear stored key/i }),
    );
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_settings_cmd",
        expect.objectContaining({
          settings: expect.objectContaining({
            provider_configs: expect.objectContaining({
              "azure-foundry": expect.objectContaining({
                api_key: "",
                api_key_stored: false,
              }),
            }),
          }),
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Quality-review follow-up: validation parity with authoritative Rust
// ---------------------------------------------------------------------------

describe("Quality-review validation parity", () => {
  it("blocks save when the custom API key is empty (parity with Rust)", async () => {
    const user = userEvent.setup();
    mockProviderInvoke();
    await openAiSettings();
    const key = screen.getByLabelText(/^api key$/i);
    await user.clear(key);
    invokeMock.mockClear();
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/api key/i);
    expect(
      invokeMock.mock.calls.some(([c]) => c === "save_settings_cmd"),
    ).toBe(false);
  });

  it("does not label the custom API key as optional", async () => {
    mockProviderInvoke();
    await openAiSettings();
    const key = screen.getByLabelText(/^api key$/i) as HTMLInputElement;
    expect(key.placeholder).not.toMatch(/optional/i);
  });

  it("blocks save for Copilot when connected but no model selected", async () => {
    const user = userEvent.setup();
    mockProviderInvoke({
      get_copilot_auth_status: { state: "connected", login: "octocat" },
    });
    await openAiSettings();
    await user.selectOptions(
      await screen.findByLabelText(/ai provider/i),
      "github-copilot",
    );
    invokeMock.mockClear();
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/model/i);
    expect(
      invokeMock.mock.calls.some(([c]) => c === "save_settings_cmd"),
    ).toBe(false);
  });

  it("ignores a stale custom model-discovery result after switching providers", async () => {
    const user = userEvent.setup();
    let resolveList: (v: string[]) => void = () => {};
    mockProviderInvoke({
      list_models: () =>
        new Promise<string[]>((resolve) => {
          resolveList = resolve;
        }),
    });
    await openAiSettings();
    await user.click(screen.getByRole("button", { name: /discover models/i }));
    await user.selectOptions(
      await screen.findByLabelText(/ai provider/i),
      "azure-foundry",
    );
    resolveList(["late-model-should-not-appear"]);
    await Promise.resolve();
    expect(
      screen.queryByText("late-model-should-not-appear"),
    ).not.toBeInTheDocument();
  });
});
