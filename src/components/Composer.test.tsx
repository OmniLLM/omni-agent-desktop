import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import Composer from "./Composer";

describe("Composer", () => {
  it("submits typed text and clears the input", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} disabled={false} />);
    const textbox = screen.getByRole("textbox");
    await userEvent.type(textbox, "do it");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith("do it");
    expect(textbox).toHaveValue("");
  });

  it("submits on Enter without Shift", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} disabled={false} />);
    await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("shows the active model and Choose project by default", () => {
    render(<Composer onSend={vi.fn()} disabled={false} model="gpt-5.4" />);
    expect(screen.getByText("gpt-5.4")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /choose project/i }),
    ).toBeInTheDocument();
  });

  it("toggles Approve for me and reports the new value", async () => {
    const onToggleApprove = vi.fn();
    render(
      <Composer
        onSend={vi.fn()}
        disabled={false}
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
