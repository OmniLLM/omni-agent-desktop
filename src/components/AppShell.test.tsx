import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import AppShell from "./AppShell";

function shellStyle(container: HTMLElement): string {
  const el = container.firstElementChild as HTMLElement;
  return el.getAttribute("style") ?? "";
}

describe("AppShell background", () => {
  it("renders the dark gradient fallback when there is no background", () => {
    const { container } = render(
      <AppShell
        resolvedTheme="dark"
        backgroundUrl=""
        isCompactMode={false}
        isAiMode
      >
        <div>child</div>
      </AppShell>,
    );
    const style = shellStyle(container);
    expect(style).not.toContain("url(");
    expect(style).toContain("linear-gradient");
  });

  it("embeds a safe image with an overlay in dark mode", () => {
    const { container } = render(
      <AppShell
        resolvedTheme="dark"
        backgroundUrl="https://example.com/bg.png"
        isCompactMode={false}
        isAiMode
      >
        <div>child</div>
      </AppShell>,
    );
    const style = shellStyle(container);
    expect(style).toContain("https://example.com/bg.png");
    expect(style).toContain("linear-gradient");
  });

  it("embeds a safe image with a light overlay in light mode", () => {
    const { container } = render(
      <AppShell
        resolvedTheme="light"
        backgroundUrl="https://example.com/bg.png"
        isCompactMode={false}
        isAiMode
      >
        <div>child</div>
      </AppShell>,
    );
    const style = shellStyle(container);
    expect(style).toContain("https://example.com/bg.png");
    expect(style).toContain("rgba(255, 255, 255");
  });

  it("never embeds an unsafe URL", () => {
    const { container } = render(
      <AppShell
        resolvedTheme="dark"
        backgroundUrl="javascript:alert(1)"
        isCompactMode={false}
        isAiMode
      >
        <div>child</div>
      </AppShell>,
    );
    const style = shellStyle(container);
    expect(style).not.toContain("javascript");
    expect(style).not.toContain("url(");
  });

  it("renders its children", () => {
    const { getByText } = render(
      <AppShell
        resolvedTheme="light"
        backgroundUrl=""
        isCompactMode={false}
        isAiMode={false}
      >
        <div>hello-shell</div>
      </AppShell>,
    );
    expect(getByText("hello-shell")).toBeInTheDocument();
  });
});
