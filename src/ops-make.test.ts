import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();

// `make -n` can fork nested child make processes on Windows to trace the
// dry-run tree, so give these cases headroom over vitest's 5s default.
const MAKE_TIMEOUT_MS = 30_000;

function makeDryRun(target: string): string {
  return execFileSync("make", ["-n", target], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("Make/ops desktop app handling", () => {
  it("build delegates to the Tauri bundler", () => {
    expect(makeDryRun("build")).toContain("npm run tauri build");
  }, MAKE_TIMEOUT_MS);

  it("start launches the packaged release app via npm start", () => {
    expect(makeDryRun("start")).toContain("npm start");
  }, MAKE_TIMEOUT_MS);

  it("public target interface drops the retired build/packaging targets", () => {
    const makefile = readFileSync(join(repoRoot, "Makefile"), "utf8");
    const phony = makefile
      .split(/\r?\n/)
      .filter((line) => line.startsWith(".PHONY:"))
      .join(" ");

    for (const retired of ["verify-binary", "package", "dev-web"]) {
      expect(phony).not.toContain(retired);
      // No recipe declares the retired target either.
      expect(makefile).not.toMatch(new RegExp(`^${retired}\\s*:`, "m"));
    }
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
