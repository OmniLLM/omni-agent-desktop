import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings, loadSettings } from "./settings.js";

describe("screen text selection settings", () => {
  it("defaults screen text selection to enabled", () => {
    expect(defaultSettings().screen_text_selection_enabled).toBe(true);
  });

  it("backfills missing values and preserves an explicit disabled value", () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-settings-"));
    const settingsPath = join(dir, "settings.json");
    const legacyPath = join(dir, "legacy.json");

    try {
      writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
      expect(
        loadSettings(settingsPath, legacyPath).screen_text_selection_enabled,
      ).toBe(true);

      writeFileSync(
        settingsPath,
        JSON.stringify({ screen_text_selection_enabled: false }),
      );
      expect(
        loadSettings(settingsPath, legacyPath).screen_text_selection_enabled,
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
