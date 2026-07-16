import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import Composer from "./Composer";
import type { AppSettings } from "../types/app";
import type { SlashContext } from "../lib/slashCommands";

function makeSlash(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    newSession: vi.fn(),
    clearSession: vi.fn(),
    renameSession: vi.fn(),
    openModelMenu: vi.fn(),
    setRunMode: vi.fn(),
    stopRun: vi.fn(),
    compact: vi.fn(),
    openSettings: vi.fn(),
    openHelp: vi.fn(),
    openSkills: vi.fn(),
    captureScreenshot: vi.fn(),
    selectScreenText: vi.fn(),
    notify: vi.fn(),
    toast: vi.fn(),
    loading: false,
    ...overrides,
  };
}

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
        api_key_stored: true,
        api_shape: "openai-compatible",
        model: "gpt-4o",
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
    a2a_timeout_secs: 120,
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
    expect(onModelChange).toHaveBeenCalledWith("github-copilot", "gpt-4o");
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

  it("opens and filters the slash command popup as text is typed", async () => {
    const user = userEvent.setup();
    render(
      <Composer
        onSend={vi.fn()}
        disabled={false}
        settings={makeSettings()}
        slash={makeSlash()}
      />,
    );

    const textbox = screen.getByRole("textbox");
    await user.type(textbox, "/");
    expect(
      screen.getByRole("listbox", { name: /slash commands/i }),
    ).toBeInTheDocument();

    await user.type(textbox, "rena");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("/rename");
  });

  it("shows the slash menu when typing '/' and runs a command instead of sending", async () => {
    const onSend = vi.fn();
    const slash = makeSlash();
    render(
      <Composer
        onSend={onSend}
        disabled={false}
        settings={makeSettings()}
        slash={slash}
      />,
    );
    const textbox = screen.getByRole("textbox");
    await userEvent.type(textbox, "/new");
    expect(screen.getByRole("listbox", { name: /slash commands/i })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(slash.newSession).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(textbox).toHaveValue("");
  });

  it("passes an unknown slash command through to onSend", async () => {
    const onSend = vi.fn();
    render(
      <Composer
        onSend={onSend}
        disabled={false}
        settings={makeSettings()}
        slash={makeSlash()}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "/unknown thing{Enter}");
    expect(onSend).toHaveBeenCalledWith("/unknown thing");
  });

  it("appends recognized text without replacing an existing draft", async () => {
    const onSend = vi.fn();
    const composerRef = createRef<{
      setText: (text: string) => void;
      insertText: (text: string) => void;
      addImage: (image: {
        id: string;
        data_url: string;
        mime_type: string;
        name: string;
      }) => void;
    }>();
    render(
      <Composer
        onSend={onSend}
        disabled={false}
        settings={makeSettings()}
        composerRef={composerRef}
      />,
    );

    act(() => {
      composerRef.current?.setText("Explain this:");
      composerRef.current?.insertText("Selected screen text");
    });
    const textbox = screen.getByRole("textbox");
    expect(textbox).toHaveValue("Explain this:\nSelected screen text");

    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith("Explain this:\nSelected screen text");
  });

  it("shows a captured screenshot in the input box and sends it to the agent", async () => {
    const onSend = vi.fn();
    const composerRef = createRef<{
      setText: (text: string) => void;
      insertText: (text: string) => void;
      addImage: (image: {
        id: string;
        data_url: string;
        mime_type: string;
        name: string;
      }) => void;
    }>();
    const image = {
      id: "shot-1",
      data_url: "data:image/png;base64,cG5n",
      mime_type: "image/png",
      name: "screenshot.png",
    };

    render(
      <Composer
        onSend={onSend}
        disabled={false}
        settings={makeSettings()}
        composerRef={composerRef}
      />,
    );
    composerRef.current?.addImage(image);

    expect(await screen.findByRole("img", { name: "screenshot.png" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox"), "What is wrong here?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSend).toHaveBeenCalledWith("What is wrong here?", [image]);
    expect(screen.queryByRole("img", { name: "screenshot.png" })).toBeNull();
  });
});
