#!/usr/bin/env bun
/**
 * Bundle agent-core into a single-file native binary via `bun build --compile`.
 *
 * Output: src-tauri/binaries/agent-core-<rustc-host-triple>[.exe]
 * (the triple must match rustc's host triple so Tauri's externalBin picks
 * it up).
 *
 * Requires Bun 1.1+ and `rustc` on PATH.
 */
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, statSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = resolve(repoRoot, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });

const triple = execSync("rustc -vV", { encoding: "utf8" })
  .split("\n")
  .find((l) => l.startsWith("host:"))
  ?.slice("host:".length)
  .trim();
if (!triple) {
  console.error("failed to detect rustc host triple");
  process.exit(1);
}
const exeExt = triple.includes("windows") ? ".exe" : "";
const outFile = resolve(outDir, `agent-core-${triple}${exeExt}`);

// Bun's --compile target flag maps as follows. We pin the target explicitly so
// cross-arch builds are deterministic when invoked from CI.
const bunTarget =
  triple.includes("windows") && triple.includes("x86_64") ? "bun-windows-x64" :
  triple.includes("windows") && triple.includes("aarch64") ? "bun-windows-aarch64" :
  triple.includes("apple") && triple.includes("aarch64") ? "bun-darwin-arm64" :
  triple.includes("apple") ? "bun-darwin-x64" :
  triple.includes("aarch64") ? "bun-linux-arm64" :
  "bun-linux-x64";

console.log(`agent-core -> ${outFile} (${bunTarget})`);

const entry = resolve(here, "src", "index.ts");
const result = spawnSync(
  "bun",
  [
    "build",
    entry,
    "--compile",
    "--minify",
    "--sourcemap",
    "--target", bunTarget,
    "--outfile", outFile,
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);

// Bun may emit `<name>.exe` on Windows when --outfile already ends in .exe;
// nothing to do there. Sanity check the file exists.
try {
  const st = statSync(outFile);
  console.log(`built ${outFile} (${st.size} bytes)`);
} catch (e) {
  console.error(`build succeeded but ${outFile} not found: ${e.message}`);
  process.exit(1);
}
