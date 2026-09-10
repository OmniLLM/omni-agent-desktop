import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getReleaseExecutable,
  getLaunchCommand,
  validateReleaseExecutable,
} from "./start-release.mjs";

const ROOT = "/repo/root";

test("getReleaseExecutable resolves the Windows .exe path", () => {
  const executable = getReleaseExecutable(ROOT, "win32");
  assert.equal(
    executable,
    join(ROOT, "src-tauri", "target", "release", "omni-agent-desktop.exe"),
  );
});

test("getReleaseExecutable resolves the suffix-free path on Linux", () => {
  for (const platform of ["linux"]) {
    const executable = getReleaseExecutable(ROOT, platform);
    assert.equal(
      executable,
      join(ROOT, "src-tauri", "target", "release", "omni-agent-desktop"),
    );
  }
});

test("macOS launches the app bundle through Launch Services and forwards arguments", () => {
  const bundle = join(ROOT, "src-tauri", "target", "release", "bundle", "macos", "Omni Agent Desktop.app");
  const executable = getReleaseExecutable(ROOT, "darwin");
  assert.equal(executable, join(bundle, "Contents", "MacOS", "omni-agent-desktop"));
  assert.deepEqual(getLaunchCommand(executable, "darwin", ["--debug"]), {
    command: "/usr/bin/open",
    args: ["-W", bundle, "--args", "--debug"],
  });
});

test("Windows and Linux launch their executable directly with arguments", () => {
  for (const platform of ["win32", "linux"]) {
    const executable = getReleaseExecutable(ROOT, platform);
    assert.deepEqual(getLaunchCommand(executable, platform, ["--debug"]), {
      command: executable, args: ["--debug"],
    });
  }
});

test("validateReleaseExecutable returns the path when the file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "start-release-"));
  try {
    const exePath = join(dir, "omni-agent-desktop");
    writeFileSync(exePath, "");
    assert.equal(validateReleaseExecutable(exePath), exePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateReleaseExecutable throws with 'make build' when missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "start-release-"));
  try {
    const missing = join(dir, "does-not-exist");
    assert.throws(
      () => validateReleaseExecutable(missing),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /make build/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateReleaseExecutable rejects a directory as not a runnable file", () => {
  const dir = mkdtempSync(join(tmpdir(), "start-release-"));
  try {
    const subdir = join(dir, "release");
    mkdirSync(subdir);
    assert.throws(
      () => validateReleaseExecutable(subdir),
      (error) => {
        assert.match(error.message, /make build/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
