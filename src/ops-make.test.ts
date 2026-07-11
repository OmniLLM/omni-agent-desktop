import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();

// Spawning `make -n` recursively is slow on Windows: each nested $(MAKE) forks a
// real child make process to trace the dry-run tree, so `restart` alone takes
// ~4s. Give these make-spawning cases headroom over vitest's 5s default.
const MAKE_TIMEOUT_MS = 30_000;

describe("Make/ops desktop app handling", () => {
  it("build produces the release desktop binary after building frontend assets", () => {
    const output = execFileSync(
      "make",
      ["-n", "build"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(output).toContain("npm run build");
    expect(output).toContain("cargo build --release");
    expect(output).toContain("Built src-tauri/target/release/omni-agent-desktop");
  }, MAKE_TIMEOUT_MS);

  it("build compiles the frontend and release Tauri binary", () => {
    const output = execFileSync("make", ["-n", "build"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(output).toContain("npm run build");
    expect(output).toContain("cargo build --release");
    expect(output).not.toContain("prepare-binaries");
    expect(output).not.toContain("omnilauncher-frontend");
    expect(output).not.toContain("omnilauncher-backend");
  }, MAKE_TIMEOUT_MS);

  it("verify-binary checks that the embedded frontend is present", () => {
    const output = execFileSync("make", ["-n", "verify-binary"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(output).toContain('test -x "src-tauri/target/release/omni-agent-desktop"');
    expect(output).toContain("grep -a -q '<!doctype html>'");
    expect(output).toContain("Verified embedded frontend");
  }, MAKE_TIMEOUT_MS);

  it("bundle icon list includes the Windows .ico and keeps the .png", () => {
    const config = JSON.parse(
      readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
    );
    const icons: string[] = config.bundle.icon;
    expect(icons).toContain("icons/icon.ico");
    expect(icons).toContain("icons/icon.png");
  });
});
