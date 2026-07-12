import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotAuthStatus, ProviderConfig } from "../../types/app";

const invokeMock = vi.fn();
const openExternalUrlMock = vi.fn();

vi.mock("../../lib/runtime", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
}));

import CopilotProviderFields, {
  isSafeCopilotVerificationUri,
} from "./CopilotProviderFields";

const draft: ProviderConfig = {
  endpoint: "",
  api_key: "",
  api_shape: "openai-compatible",
  model: "",
  manual_models: "",
};

const awaiting: CopilotAuthStatus = {
  state: "awaiting_user",
  flow_id: "device-code-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_at: 9_999_999,
};

function renderFields(
  options: {
    draft?: ProviderConfig;
    update?: (patch: Partial<ProviderConfig>) => void;
  } = {},
) {
  const update = options.update ?? vi.fn();
  return {
    update,
    ...render(
      <CopilotProviderFields
        draft={options.draft ?? draft}
        update={update}
        rowStyle={() => ({})}
        rowLabelStyle={{}}
      />,
    ),
  };
}

describe("CopilotProviderFields device-flow handoff", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    invokeMock.mockReset();
    openExternalUrlMock.mockReset();
    writeText.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_copilot_auth_status") {
        return { state: "disconnected" } satisfies CopilotAuthStatus;
      }
      if (command === "start_copilot_device_flow") return awaiting;
      return undefined;
    });
    writeText.mockResolvedValue(undefined);
    openExternalUrlMock.mockResolvedValue(undefined);
  });

  it("copies the public code and opens GitHub after starting a device flow", async () => {
    renderFields();

    fireEvent.click(
      await screen.findByRole("button", { name: /connect with github/i }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith("ABCD-EFGH");
      expect(openExternalUrlMock).toHaveBeenCalledTimes(1);
      expect(openExternalUrlMock).toHaveBeenCalledWith(
        "https://github.com/login/device",
      );
    });
    expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/copied/i);
  });

  it("does not let a stale initial status overwrite a newly started flow", async () => {
    let statusReadStarted = false;
    let resolveInitial: (status: CopilotAuthStatus) => void = () => {};
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_copilot_auth_status") {
        statusReadStarted = true;
        return new Promise<CopilotAuthStatus>((resolve) => {
          resolveInitial = resolve;
        });
      }
      if (command === "start_copilot_device_flow") return Promise.resolve(awaiting);
      return Promise.resolve(undefined);
    });
    renderFields();
    await waitFor(() => expect(statusReadStarted).toBe(true));

    fireEvent.click(
      await screen.findByRole("button", { name: /connect with github/i }),
    );
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();

    resolveInitial({ state: "disconnected" });
    await Promise.resolve();
    expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument();
    expect(screen.getByText(/waiting for github authorization/i)).toBeInTheDocument();
  });

  it("keeps manual retry controls when automatic handoff fails", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    openExternalUrlMock.mockRejectedValueOnce(new Error("opener unavailable"));
    renderFields();

    fireEvent.click(
      await screen.findByRole("button", { name: /connect with github/i }),
    );

    expect(await screen.findByRole("button", { name: /copy code/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /open github/i })).toBeEnabled();
    expect(screen.getByRole("link", { name: awaiting.verification_uri })).toHaveAttribute(
      "href",
      awaiting.verification_uri,
    );
  });

  it("never auto-opens an untrusted verification URI", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_copilot_auth_status") {
        return { state: "disconnected" } satisfies CopilotAuthStatus;
      }
      if (command === "start_copilot_device_flow") {
        return { ...awaiting, verification_uri: "https://evil.example/login/device" };
      }
      return undefined;
    });
    renderFields();

    fireEvent.click(
      await screen.findByRole("button", { name: /connect with github/i }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCD-EFGH"));
    expect(openExternalUrlMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /open github/i })).toBeDisabled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("https://evil.example/login/device")).toBeInTheDocument();
  });

  it("accepts only GitHub's HTTPS device-login URL", () => {
    expect(isSafeCopilotVerificationUri("https://github.com/login/device")).toBe(true);
    expect(isSafeCopilotVerificationUri("http://github.com/login/device")).toBe(false);
    expect(isSafeCopilotVerificationUri("https://github.com.evil.test/login/device")).toBe(false);
    expect(isSafeCopilotVerificationUri("https://github.com/login/oauth")).toBe(false);
    expect(isSafeCopilotVerificationUri("not a URL")).toBe(false);
  });
});

describe("CopilotProviderFields model selection", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openExternalUrlMock.mockReset();
  });

  it("automatically discovers models for an already-connected account", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_copilot_auth_status") {
        return { state: "connected", login: "octocat" } satisfies CopilotAuthStatus;
      }
      if (command === "list_copilot_models") {
        return [{ id: "gpt-5.4" }, { id: "claude-sonnet-4.5" }];
      }
      return undefined;
    });
    renderFields();

    const modelInput = await screen.findByLabelText("Model");
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_copilot_models");
      const options = document.querySelectorAll("#copilot-model-list option");
      expect(Array.from(options, (option) => option.getAttribute("value"))).toEqual([
        "gpt-5.4",
        "claude-sonnet-4.5",
      ]);
    });
    expect(modelInput).toHaveAttribute("list", "copilot-model-list");
  });

  it("updates the selected Copilot model directly from the selector", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_copilot_auth_status") {
        return { state: "connected", login: "octocat" } satisfies CopilotAuthStatus;
      }
      if (command === "list_copilot_models") return [{ id: "gpt-5.4" }];
      return undefined;
    });
    const update = vi.fn();
    renderFields({ update });

    const modelInput = await screen.findByLabelText("Model");
    fireEvent.change(modelInput, { target: { value: "gpt-5.4" } });
    expect(update).toHaveBeenCalledWith({ model: "gpt-5.4" });
  });

  it("does not discover models while disconnected", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_copilot_auth_status") {
        return { state: "disconnected" } satisfies CopilotAuthStatus;
      }
      return undefined;
    });
    renderFields();

    await screen.findByRole("button", { name: /connect with github/i });
    expect(
      invokeMock.mock.calls.some(([command]) => command === "list_copilot_models"),
    ).toBe(false);
  });

  it("ignores a model response that resolves after unmount", async () => {
    let resolveModels: (models: { id: string }[]) => void = () => {};
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_copilot_auth_status") {
        return Promise.resolve({
          state: "connected",
          login: "octocat",
        } satisfies CopilotAuthStatus);
      }
      if (command === "list_copilot_models") {
        return new Promise((resolve) => {
          resolveModels = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    const { unmount } = renderFields();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("list_copilot_models"),
    );

    unmount();
    resolveModels([{ id: "stale-model" }]);
    await Promise.resolve();
    expect(screen.queryByDisplayValue("stale-model")).toBeNull();
  });
});
