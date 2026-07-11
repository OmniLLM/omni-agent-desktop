import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SessionToolbar from "./SessionToolbar";

const sessions = [
  { id: "s1", title: "First conversation", updated_at: 2, message_count: 4 },
  { id: "s2", title: "Second conversation", updated_at: 1, message_count: 9 },
];

function renderToolbar(overrides = {}) {
  const props = {
    sessions,
    currentSessionId: "s1",
    onNew: vi.fn(),
    onSwitch: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    ...overrides,
  };
  render(<SessionToolbar {...props} />);
  return props;
}

describe("SessionToolbar", () => {
  it("shows the current title and switches from the dropdown", async () => {
    const user = userEvent.setup();
    const props = renderToolbar();
    await user.click(
      screen.getByRole("button", { name: /first conversation/i }),
    );
    expect(screen.getByText("9 messages")).toBeInTheDocument();
    await user.click(
      screen.getByRole("option", { name: /second conversation/i }),
    );
    expect(props.onSwitch).toHaveBeenCalledWith("s2");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("creates a new chat and closes menus", async () => {
    const user = userEvent.setup();
    const props = renderToolbar();
    await user.click(screen.getByRole("button", { name: /new chat/i }));
    expect(props.onNew).toHaveBeenCalledOnce();
  });

  it("confirms before deleting the current session", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const props = renderToolbar();
    await user.click(
      screen.getByRole("button", { name: /conversation actions/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /delete current/i }));
    expect(confirm).toHaveBeenCalled();
    expect(props.onDelete).toHaveBeenCalledWith("s1");
  });

  it("disables deletion for an unsaved conversation", async () => {
    const user = userEvent.setup();
    renderToolbar({ currentSessionId: null });
    expect(screen.getByText("New conversation")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /conversation actions/i }),
    );
    expect(
      screen.getByRole("menuitem", { name: /delete current/i }),
    ).toBeDisabled();
  });

  it("reports switch failures and keeps the active title", async () => {
    const user = userEvent.setup();
    renderToolbar({
      onSwitch: vi.fn(async () => {
        throw new Error("load failed");
      }),
    });
    await user.click(
      screen.getByRole("button", { name: /first conversation/i }),
    );
    await user.click(
      screen.getByRole("option", { name: /second conversation/i }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("load failed");
    expect(
      screen.getByRole("button", { name: /first conversation/i }),
    ).toBeInTheDocument();
  });

  it("closes an open dropdown with Escape", async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(
      screen.getByRole("button", { name: /first conversation/i }),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("reports deletion failures without changing the active session", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderToolbar({
      onDelete: vi.fn(async () => {
        throw new Error("delete failed");
      }),
    });
    await user.click(
      screen.getByRole("button", { name: /conversation actions/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /delete current/i }));
    expect(await screen.findByRole("status")).toHaveTextContent("delete failed");
    expect(
      screen.getByRole("button", { name: /first conversation/i }),
    ).toBeInTheDocument();
  });
});
