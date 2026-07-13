/**
 * User-config directory resolution — parity with Rust's `config_dir()` in
 * main.rs: prefer $OMNI_AGENT_HOME, else the platform config dir.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  const env = process.env.OMNI_AGENT_HOME;
  if (env && env.trim().length > 0) return ensureDir(env);
  const home = homedir();
  const dir =
    platform() === "win32"
      ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "omni-agent-desktop")
      : platform() === "darwin"
        ? join(home, "Library", "Application Support", "omni-agent-desktop")
        : join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "omni-agent-desktop");
  return ensureDir(dir);
}

function ensureDir(p: string): string {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

export function settingsPath(): string {
  return join(configDir(), "settings.json");
}

export function legacySettingsPath(): string {
  // Historic location before the app got a dedicated config subdir.
  return join(homedir(), ".omni-agent-desktop.json");
}
