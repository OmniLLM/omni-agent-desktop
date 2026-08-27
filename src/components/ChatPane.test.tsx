import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openExternalUrlMock = vi.fn();

vi.mock("../lib/runtime", () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
}));

import ChatPane from "./ChatPane";

beforeEach(() => {
  openExternalUrlMock.mockReset();
  openExternalUrlMock.mockResolvedValue(undefined);
});

describe("ChatPane external links", () => {
  it.each([
    ["[Documentation](https://example.com/docs)", "Documentation", "https://example.com/docs"],
    ["See https://example.com/help", "https://example.com/help", "https://example.com/help"],
    ["Visit www.example.com", "www.example.com", "https://www.example.com"],
  ])("opens assistant link %s through the runtime helper", (content, label, url) => {
    render(<ChatPane messages={[{ role: "assistant", content }]} />);

    const link = screen.getByRole("link", { name: label });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(openExternalUrlMock).toHaveBeenCalledWith(url);
  });

  it("logs opener failures without an unhandled rejection", async () => {
    const error = new Error("opener unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      openExternalUrlMock.mockRejectedValueOnce(error);
      render(
        <ChatPane
          messages={[{ role: "assistant", content: "[Documentation](https://example.com)" }]}
        />,
      );

      fireEvent.click(screen.getByRole("link", { name: "Documentation" }));

      await waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith("Failed to open external link", error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not render user-provided URLs as clickable HTML", () => {
    render(<ChatPane messages={[{ role: "user", content: "https://example.com" }]} />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
