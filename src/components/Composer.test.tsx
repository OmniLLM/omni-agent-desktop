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

  it("has no run-mode selector", () => {
    render(<Composer onSend={vi.fn()} disabled={false} />);
    expect(screen.queryByLabelText(/mode/i)).toBeNull();
  });
});
