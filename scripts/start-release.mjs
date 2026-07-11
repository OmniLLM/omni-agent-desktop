import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXECUTABLE_BASENAME = "omni-agent-desktop";

/**
 * Resolve the absolute path to the built release executable for a platform.
 *
 * @param {string} repoRoot Absolute path to the repository root.
 * @param {NodeJS.Platform} [platform] Platform identifier, defaults to the host.
 * @returns {string} Absolute path to the release executable.
 */
export function getReleaseExecutable(repoRoot, platform = process.platform) {
  const suffix = platform === "win32" ? ".exe" : "";
  return join(
    repoRoot,
    "src-tauri",
    "target",
    "release",
    `${EXECUTABLE_BASENAME}${suffix}`,
  );
}

/**
 * Ensure the release executable exists and is a regular file.
 *
 * @param {string} executable Absolute path to the release executable.
 * @returns {string} The validated executable path.
 * @throws {Error} If the executable is missing; message recommends `make build`.
 */
export function validateReleaseExecutable(executable) {
  let stats;
  try {
    stats = statSync(executable);
  } catch {
    throw new Error(
      `Release executable not found at ${executable}. Run \`make build\` first.`,
    );
  }
  if (!stats.isFile()) {
    throw new Error(
      `Release executable not found at ${executable}. Run \`make build\` first.`,
    );
  }
  return executable;
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let executable;
  try {
    executable = validateReleaseExecutable(getReleaseExecutable(repoRoot));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const result = spawnSync(executable, { stdio: "inherit" });
  if (result.error) {
    console.error(`Failed to launch ${executable}: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
