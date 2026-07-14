import { LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { WindowSizePreset } from "../types/app";

export const WINDOW_SIZE_OPTIONS = [
  { value: "compact", label: "Compact", width: 720, height: 520 },
  { value: "standard", label: "Standard", width: 960, height: 640 },
  { value: "large", label: "Large", width: 1280, height: 720 },
] as const;

/** Bounds for the freeform "Custom" size in logical pixels. */
export const CUSTOM_WINDOW_MIN_WIDTH = 480;
export const CUSTOM_WINDOW_MIN_HEIGHT = 360;
export const CUSTOM_WINDOW_MAX_WIDTH = 7680;
export const CUSTOM_WINDOW_MAX_HEIGHT = 4320;
export const DEFAULT_CUSTOM_WINDOW_WIDTH = 1280;
export const DEFAULT_CUSTOM_WINDOW_HEIGHT = 768;

export function normalizeWindowSize(value: unknown): WindowSizePreset {
  return value === "compact" ||
    value === "large" ||
    value === "custom"
    ? value
    : "standard";
}

/** Clamp a raw custom dimension to the allowed range; fall back to default when
 *  the input is missing / non-numeric. Non-integers are floored so the size
 *  round-trips cleanly through JSON storage. */
export function normalizeCustomDimension(
  value: unknown,
  axis: "width" | "height",
): number {
  const min =
    axis === "width" ? CUSTOM_WINDOW_MIN_WIDTH : CUSTOM_WINDOW_MIN_HEIGHT;
  const max =
    axis === "width" ? CUSTOM_WINDOW_MAX_WIDTH : CUSTOM_WINDOW_MAX_HEIGHT;
  const fallback =
    axis === "width"
      ? DEFAULT_CUSTOM_WINDOW_WIDTH
      : DEFAULT_CUSTOM_WINDOW_HEIGHT;
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

export interface ApplyWindowSizeOptions {
  /** Required when preset === "custom". */
  customWidth?: number;
  customHeight?: number;
}

export async function applyWindowSize(
  preset: WindowSizePreset,
  options: ApplyWindowSizeOptions = {},
): Promise<void> {
  let width: number;
  let height: number;
  if (preset === "custom") {
    width = normalizeCustomDimension(options.customWidth, "width");
    height = normalizeCustomDimension(options.customHeight, "height");
  } else {
    const option = WINDOW_SIZE_OPTIONS.find((item) => item.value === preset)!;
    width = option.width;
    height = option.height;
  }
  const win = getCurrentWebviewWindow();
  const monitor = await currentMonitor().catch(() => null);
  const scale = monitor?.scaleFactor || 1;
  const maxWidth = monitor ? Math.floor(monitor.size.width / scale) : width;
  const maxHeight = monitor ? Math.floor(monitor.size.height / scale) : height;
  await win.setSize(
    new LogicalSize(
      Math.min(width, maxWidth),
      Math.min(height, maxHeight),
    ),
  );
}
