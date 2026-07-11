import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { WindowSizePreset } from "../types/app";

export const WINDOW_SIZE_OPTIONS = [
  { value: "compact", label: "Compact", width: 720, height: 520 },
  { value: "standard", label: "Standard", width: 960, height: 640 },
  { value: "large", label: "Large", width: 1280, height: 720 },
] as const;

export function normalizeWindowSize(value: unknown): WindowSizePreset {
  return value === "compact" || value === "large" ? value : "standard";
}

export async function applyWindowSize(preset: WindowSizePreset): Promise<void> {
  const option = WINDOW_SIZE_OPTIONS.find((item) => item.value === preset)!;
  const win = getCurrentWebviewWindow();
  const monitor = await win.currentMonitor().catch(() => null);
  const scale = monitor?.scaleFactor || 1;
  const maxWidth = monitor
    ? Math.floor(monitor.size.width / scale)
    : option.width;
  const maxHeight = monitor
    ? Math.floor(monitor.size.height / scale)
    : option.height;
  await win.setSize(
    new LogicalSize(
      Math.min(option.width, maxWidth),
      Math.min(option.height, maxHeight),
    ),
  );
}
