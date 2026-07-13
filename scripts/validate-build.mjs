#!/usr/bin/env node
/**
 * Cross-platform build validation for Omni Agent Desktop.
 *
 * Drives the project's `make` flow and asserts each stage actually succeeds —
 * NOT just that `make` exited 0 (the Makefile prefixes cleanup with `-`, so an
 * ignored failure still returns 0). This catches Windows/PowerShell vs
 * Unix/bash regressions in the OS-aware clean/kill macros, a broken sidecar
 * compile, and a broken Tauri build.
 *
 * Stages:
 *   1. make kill-running   — must exit 0 with no "os error"/"Access is denied".
 *   2. make clean-binaries — must exit 0 with no parameter-binding / cmd errors.
 *   3. make sidecar        — must produce src-tauri/binaries/agent-core-<triple>.
 *   4. make build          — full build; must produce the desktop binary.
 *
 * By default runs the fast stages (1-3). Pass --full to also run stage 4 (the
 * multi-minute Rust release compile + bundling).
 *
 * Usage:
 *   node scripts/validate-build.mjs            # stages 1-3 (fast)
 *   node scripts/validate-build.mjs --full     # + full make build
 *   node scripts/validate-build.mjs --json
 *
 * Exit codes: 0 all stages passed · 1 a stage failed · 2 preflight problem.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";

// Substrings that mean a stage genuinely failed even if make swallowed the
// exit code. Kept broad but specific to the failure classes we've hit.
const HARD_ERRORS = [
  "CreateProcess(NULL",              // cmd.exe can't find `rm` (old Makefile bug)
  "cannot find the file specified",  // e=2 from a missing shell builtin
  "PositionalParameterNotFound",     // PowerShell Remove-Item arg-binding bug
  "Access is denied",                // os error 5 — a running app locked a file
  "os error 5",
  "The system cannot find the path", // genuinely broken path (not a missing target)
];

function parseArgs(argv) {
  const opts = { full: false, json: false };
  for (const a of argv) {
    if (a === "--full") opts.full = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return opts;
}

function runMake(target, extraTimeoutMs) {
  const res = spawnSync("make", [target], {
    cwd: REPO,
    encoding: "utf8",
    shell: IS_WIN, // `make` is a .exe on PATH; shell:true helps resolve it on Windows
    timeout: extraTimeoutMs,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const hard = HARD_ERRORS.filter((needle) => out.includes(needle));
  return {
    exitCode: res.status,
    signal: res.signal,
    spawnError: res.error ? String(res.error.message ?? res.error) : "",
    hardErrors: hard,
    output: out,
  };
}

function agentCoreBinaryExists() {
  const dir = join(REPO, "src-tauri", "binaries");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => f.startsWith("agent-core-"));
}

function desktopBinaryExists() {
  const rel = join(REPO, "src-tauri", "target", "release");
  return (
    existsSync(join(rel, "omni-agent-desktop.exe")) ||
    existsSync(join(rel, "omni-agent-desktop"))
  );
}

function evaluate(name, run, extraOk = true) {
  const problems = [];
  if (run.spawnError) problems.push(`spawn failed: ${run.spawnError}`);
  if (run.signal) problems.push(`killed by signal ${run.signal}`);
  if (run.exitCode !== 0) problems.push(`exit code ${run.exitCode}`);
  if (run.hardErrors.length) problems.push(`errors: ${run.hardErrors.join(", ")}`);
  if (!extraOk) problems.push("expected artifact missing");
  return { name, pass: problems.length === 0, problems };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      "Usage: node scripts/validate-build.mjs [--full] [--json]\n",
    );
    return 0;
  }

  // Preflight: make must be on PATH.
  const probe = spawnSync("make", ["--version"], { shell: IS_WIN, encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      "BLOCKED: `make` not found on PATH. Install GNU make (choco install make / apt install make / brew install make).\n",
    );
    return 2;
  }

  const results = [];

  const kill = runMake("kill-running", 60_000);
  results.push(evaluate("make kill-running", kill));

  const clean = runMake("clean-binaries", 120_000);
  results.push(evaluate("make clean-binaries", clean));

  const sidecar = runMake("sidecar", 300_000);
  results.push(evaluate("make sidecar", sidecar, agentCoreBinaryExists()));

  if (opts.full) {
    const build = runMake("build", 900_000);
    results.push(evaluate("make build", build, desktopBinaryExists()));
  }

  const failed = results.filter((r) => !r.pass);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ platform: process.platform, results }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(`\nBuild validation (${process.platform})\n`);
    process.stdout.write("=".repeat(60) + "\n");
    for (const r of results) {
      process.stdout.write(`[${r.pass ? "PASS" : "FAIL"}] ${r.name}\n`);
      for (const p of r.problems) process.stdout.write(`        ${p}\n`);
    }
    process.stdout.write("=".repeat(60) + "\n");
    process.stdout.write(`${results.length - failed.length}/${results.length} stages passed\n`);
    if (!opts.full) process.stdout.write("(run with --full to also validate `make build`)\n");
  }

  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`ERROR: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
