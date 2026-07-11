import type { ResolvedTheme } from "../utils/theme";

/**
 * Background URL validation + safe CSS construction.
 *
 * The persisted `background_url` is rendered into an inline `background`
 * CSS value via `url("...")`. Because that string is interpolated into CSS,
 * a hostile or malformed URL could break out of the `url()` token and inject
 * additional declarations (e.g. `"); background: url(javascript:...)`).
 * We therefore validate strictly and only ever embed URLs that cannot contain
 * CSS-significant or control characters, and we serialize the embedded URL
 * with `JSON.stringify` so the quoting/escaping is done by the runtime rather
 * than by hand. (A plain space is allowed — it is legal inside a double-quoted
 * CSS `url("...")` token — but quotes, parens, backslash and control chars,
 * which could terminate the token, are not.)
 */

/** Protocols we allow for backgrounds. */
const HTTPS = "https:";
const HTTP = "http:";
// Tauri/local asset protocols the app already uses to load bundled/local files.
const ASSET_PROTOCOLS = new Set(["asset:", "tauri:"]);

/** Hostnames treated as local (safe over plain http). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "asset.localhost"]);

/**
 * The result of validating a candidate background URL — a discriminated union.
 *
 * - `{ ok: true; value }` for an acceptable URL, or for the empty string
 *   (in which case `value` is "", meaning "no image / use the solid fallback").
 * - `{ ok: false; error }` for a malformed or disallowed URL, where `error`
 *   is a human-readable message suitable for inline display.
 */
export type BackgroundValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Message shown for a malformed/disallowed background URL. */
const INVALID_REASON = "Enter a valid https or local image URL.";

/**
 * Returns true when `url` contains any character that could terminate the
 * `url("...")` token or smuggle in extra CSS: quotes, parentheses, backslash,
 * or any C0/C1/DEL control character. A plain space is intentionally NOT
 * treated as unsafe — it is legal inside a double-quoted url() token.
 */
function hasUnsafeChars(url: string): boolean {
  for (const ch of url) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
    if (
      ch === '"' ||
      ch === "'" ||
      ch === "(" ||
      ch === ")" ||
      ch === "\\"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when `url` is a non-empty, well-formed URL that is safe to embed
 * in a CSS `url("...")` value.
 */
export function isSafeBackgroundUrl(url: string): boolean {
  if (typeof url !== "string" || url === "") return false;
  if (hasUnsafeChars(url)) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const protocol = parsed.protocol;

  if (protocol === HTTPS) return true;

  // Local asset protocols used by Tauri.
  if (ASSET_PROTOCOLS.has(protocol)) return true;

  // Plain http only for local hosts (dev asset server, asset.localhost).
  if (protocol === HTTP) {
    return LOCAL_HOSTS.has(parsed.hostname);
  }

  return false;
}

/**
 * Validate a candidate background URL, distinguishing "empty / no image"
 * (ok, value "") from a malformed or disallowed URL (error). Callers use this
 * to decide whether to live-preview + persist the value or surface an inline
 * error while keeping the last good background on screen.
 */
export function validateBackgroundUrl(url: string): BackgroundValidation {
  if (typeof url !== "string" || url === "") {
    return { ok: true, value: "" };
  }
  if (isSafeBackgroundUrl(url)) {
    return { ok: true, value: url };
  }
  return { ok: false, error: INVALID_REASON };
}

/**
 * Returns the URL unchanged when it is safe, or an empty string otherwise.
 * Callers treat empty as "no image / use the solid fallback".
 */
export function sanitizeBackgroundUrl(url: string): string {
  return isSafeBackgroundUrl(url) ? url : "";
}

/**
 * Builds the `url(...) center top / cover no-repeat` layer for a safe URL, or
 * an empty string when the URL is empty/unsafe. The URL is serialized with
 * `JSON.stringify`, which produces a correctly double-quoted, escaped string
 * literal — so a legal-but-space-bearing URL stays safely inside the token.
 */
export function backgroundImageValue(url: string): string {
  const safe = sanitizeBackgroundUrl(url);
  if (!safe) return "";
  return `url(${JSON.stringify(safe)}) center top / cover no-repeat`;
}

/**
 * Builds the CSS `background` shorthand value for the app shell.
 *
 * - Empty/unsafe URL → theme-appropriate solid or gradient fallback.
 * - Safe URL → the image with a theme-aware overlay gradient on top so text
 *   stays readable in both light and dark modes.
 */
export function buildBackgroundCss(
  url: string,
  theme: ResolvedTheme,
): string {
  const image = backgroundImageValue(url);

  if (!image) {
    return theme === "dark"
      ? "linear-gradient(160deg, #0b1220 0%, #0e1930 52%, #0a1426 100%)"
      : "var(--bg)";
  }

  if (theme === "dark") {
    return `
      linear-gradient(180deg, rgba(6, 12, 24, 0.74) 0%, rgba(8, 14, 28, 0.86) 100%),
      radial-gradient(circle at 18% -6%, color-mix(in srgb, var(--accent) 12%, transparent) 0, transparent 40%),
      ${image}
    `;
  }

  // Light mode: a translucent white wash keeps dark text legible over photos.
  return `
    linear-gradient(180deg, rgba(255, 255, 255, 0.78) 0%, rgba(255, 255, 255, 0.88) 100%),
    ${image}
  `;
}
