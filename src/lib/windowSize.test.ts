import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentMonitor } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  applyWindowSize,
  normalizeWindowSize,
  WINDOW_SIZE_OPTIONS,
} from "./windowSize";

const currentWindow = vi.mocked(getCurrentWebviewWindow);
const monitor = vi.mocked(currentMonitor);

describe("windowSize", () => {
  beforeEach(() => {
    currentWindow.mockReturnValue({
      setSize: vi.fn(async () => undefined),
    } as never);
    monitor.mockResolvedValue({
      size: { width: 1920, height: 1080 },
      scaleFactor: 1,
    } as never);
  });

  it("maps the three balanced presets", () => {
    expect(WINDOW_SIZE_OPTIONS).toEqual([
      { value: "compact", label: "Compact", width: 720, height: 520 },
      { value: "standard", label: "Standard", width: 960, height: 640 },
      { value: "large", label: "Large", width: 1280, height: 720 },
    ]);
  });

  it("normalizes unknown values to standard", () => {
    expect(normalizeWindowSize("future-size")).toBe("standard");
    expect(normalizeWindowSize(undefined)).toBe("standard");
  });

  it("passes through custom preset", () => {
    expect(normalizeWindowSize("custom")).toBe("custom");
  });

  it("applies the selected logical size", async () => {
    const win = currentWindow();
    await applyWindowSize("compact");
    expect(win.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 720, height: 520 }),
    );
  });

  it("applies a custom width and height", async () => {
    const win = currentWindow();
    await applyWindowSize("custom", { customWidth: 1280, customHeight: 768 });
    expect(win.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1280, height: 768 }),
    );
  });

  it("clamps a custom size to the allowed bounds", async () => {
    const win = currentWindow();
    await applyWindowSize("custom", { customWidth: 10, customHeight: 10 });
    expect(win.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 480, height: 360 }),
    );
  });

  it("clamps a preset to the monitor work area", async () => {
    const win = currentWindow();
    monitor.mockResolvedValue({
      size: { width: 800, height: 600 },
      scaleFactor: 1,
    } as never);
    await applyWindowSize("large");
    expect(win.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 800, height: 600 }),
    );
  });
});
