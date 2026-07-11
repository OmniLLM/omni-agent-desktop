import { describe, it, expect } from "vitest";
import {
  isSafeBackgroundUrl,
  sanitizeBackgroundUrl,
  buildBackgroundCss,
  validateBackgroundUrl,
  backgroundImageValue,
} from "./background";

describe("isSafeBackgroundUrl", () => {
  it("rejects the empty string", () => {
    expect(isSafeBackgroundUrl("")).toBe(false);
  });

  it("accepts https URLs", () => {
    expect(
      isSafeBackgroundUrl("https://example.com/bg.png?imwidth=1568&imdensity=1"),
    ).toBe(true);
  });

  it("accepts http URLs only for localhost", () => {
    expect(isSafeBackgroundUrl("http://localhost:1420/bg.png")).toBe(true);
    expect(isSafeBackgroundUrl("http://127.0.0.1:1420/bg.png")).toBe(true);
  });

  it("rejects plain http for remote hosts", () => {
    expect(isSafeBackgroundUrl("http://evil.example.com/bg.png")).toBe(false);
  });

  it("accepts Tauri/local asset protocols the app already uses", () => {
    expect(isSafeBackgroundUrl("asset://localhost/img.png")).toBe(true);
    expect(isSafeBackgroundUrl("https://asset.localhost/img.png")).toBe(true);
    expect(isSafeBackgroundUrl("http://asset.localhost/img.png")).toBe(true);
    expect(isSafeBackgroundUrl("tauri://localhost/img.png")).toBe(true);
  });

  it("rejects unsafe protocols", () => {
    expect(isSafeBackgroundUrl("javascript:alert(1)")).toBe(false);
    expect(
      isSafeBackgroundUrl("data:image/png;base64,AAAA"),
    ).toBe(false);
    expect(isSafeBackgroundUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeBackgroundUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects URLs containing quotes, parens or control characters", () => {
    expect(
      isSafeBackgroundUrl('https://example.com/a".png'),
    ).toBe(false);
    expect(
      isSafeBackgroundUrl("https://example.com/a').png"),
    ).toBe(false);
    expect(
      isSafeBackgroundUrl("https://example.com/a).png"),
    ).toBe(false);
    expect(
      isSafeBackgroundUrl("https://example.com/a(b).png"),
    ).toBe(false);
    expect(
      isSafeBackgroundUrl("https://example.com/a\nb.png"),
    ).toBe(false);
    expect(
      isSafeBackgroundUrl("https://example.com/a\x00b.png"),
    ).toBe(false);
  });

  it("accepts https URLs containing spaces (legal inside a quoted url())", () => {
    expect(isSafeBackgroundUrl("https://example.com/a b.png")).toBe(true);
    // …and the CSS construction keeps the space safely inside the token.
    const css = buildBackgroundCss("https://example.com/a b.png", "dark");
    expect(css).toContain('url("https://example.com/a b.png")');
  });

  it("rejects a CSS-injection attempt that closes url() early", () => {
    expect(
      isSafeBackgroundUrl(
        'https://x/a.png"); background:url(javascript:alert(1)',
      ),
    ).toBe(false);
  });
});

describe("sanitizeBackgroundUrl", () => {
  it("returns the URL when safe", () => {
    expect(sanitizeBackgroundUrl("https://example.com/bg.png")).toBe(
      "https://example.com/bg.png",
    );
  });

  it("returns empty string when unsafe or empty", () => {
    expect(sanitizeBackgroundUrl("")).toBe("");
    expect(sanitizeBackgroundUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeBackgroundUrl('https://x/a".png')).toBe("");
  });
});

describe("buildBackgroundCss", () => {
  it("returns the solid/gradient fallback when there is no image (dark)", () => {
    const css = buildBackgroundCss("", "dark");
    expect(css).not.toContain("url(");
    expect(css).toContain("linear-gradient");
  });

  it("returns the solid fallback when there is no image (light)", () => {
    const css = buildBackgroundCss("", "light");
    expect(css).not.toContain("url(");
    expect(css).toContain("var(--bg)");
  });

  it("embeds a safe image with a dark overlay in dark mode", () => {
    const css = buildBackgroundCss("https://example.com/bg.png", "dark");
    expect(css).toContain('url("https://example.com/bg.png")');
    expect(css).toContain("linear-gradient");
    expect(css).toContain("cover");
  });

  it("embeds a safe image with a readable light overlay in light mode", () => {
    const css = buildBackgroundCss("https://example.com/bg.png", "light");
    expect(css).toContain('url("https://example.com/bg.png")');
    // A whitish overlay keeps text readable over the photo.
    expect(css).toContain("rgba(255, 255, 255");
    expect(css).toContain("cover");
  });

  it("never embeds an unsafe URL — falls back instead", () => {
    const css = buildBackgroundCss("javascript:alert(1)", "dark");
    expect(css).not.toContain("javascript");
    expect(css).not.toContain("url(");
  });
});


describe("validateBackgroundUrl", () => {
  it("treats the empty string as ok with an empty value (no image)", () => {
    expect(validateBackgroundUrl("")).toEqual({ ok: true, value: "" });
  });

  it("returns ok with the url for a safe https URL", () => {
    const r = validateBackgroundUrl("https://example.com/bg.png");
    expect(r).toEqual({ ok: true, value: "https://example.com/bg.png" });
  });

  it("returns not-ok with an error for an unsafe URL", () => {
    const r = validateBackgroundUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/valid/i);
  });
});

describe("backgroundImageValue", () => {
  it("returns an empty string for empty/unsafe URLs", () => {
    expect(backgroundImageValue("")).toBe("");
    expect(backgroundImageValue("javascript:alert(1)")).toBe("");
  });

  it("serializes a safe URL with JSON.stringify quoting", () => {
    const v = backgroundImageValue("https://example.com/bg.png");
    expect(v).toContain('url("https://example.com/bg.png")');
    expect(v).toContain("cover");
    expect(v).toContain("no-repeat");
  });
});
