import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import Composer from "./Composer";

describe("Composer", () => {
  it("submits text with the selected mode", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} disabled={false} />);
    await userEvent.selectOptions(
      screen.getByLabelText(/mode/i),
      "autopilot",
    );
    await userEvent.type(screen.getByRole("textbox"), "do it");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith("do it", "autopilot");
  });
});
