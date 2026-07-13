---
name: build-validate
description: Validate that the Omni Agent Desktop build works cross-platform via the project's `make` flow. Use when changing the Makefile, the agent-core sidecar build (agent-core/build.mjs, build:bin), the Tauri build config, or when a user reports `make` errors like "CreateProcess(NULL", "cannot find the file specified", "Access is denied"/"os error 5", "PositionalParameterNotFound", or a build that fails to produce the binary. Also use before shipping any build-system change.
compatibility: Windows 11 (PowerShell) or macOS/Linux (bash); GNU make on PATH, Node.js 20+, Bun, Rust toolchain for the full build
---

# Build validation (cross-platform `make`)

The project builds via `make`, whose default `build` target chains:

```
make build → kill-running → clean-binaries → sidecar → npm run tauri build
```

- **kill-running** — stops any running app/sidecar so its open file handles
  don't lock the outputs (the `Access is denied` / os error 5 failure).
- **clean-binaries** — purges stale sidecar binaries, `agent-core/dist`, the
  previous desktop exe, and `bundle/`.
- **sidecar** — `bun install` then `bun run build:bin` →
  `src-tauri/binaries/agent-core-<triple>[.exe]`.
- **npm run tauri build** — compiles the desktop binary + installers.

## OS-aware shell (why this needs validating)

GNU make spawns recipe commands through the platform's default shell:
**cmd.exe on Windows**, **bash on Unix**. `cmd.exe` has no `rm`, so a naive
`rm -rf` recipe fails with `CreateProcess(NULL … rm …) failed` /
`cannot find the file specified`. The Makefile therefore switches on `$(OS)`:

- **Windows** → PowerShell `Remove-Item` (and `Get-Process | Stop-Process`).
- **Unix** → `rm` (and `pkill`).

Each PowerShell delete ends with `; exit 0` so a missing path doesn't surface
as an ignored error. Validation must confirm these run **clean** on the host OS,
not just that `make` returned 0 (cleanup recipes are `-`-prefixed, so an ignored
failure still yields exit 0).

## Run

From the repository root:

```bash
# Fast: kill-running + clean-binaries + sidecar (no Rust compile)
node scripts/validate-build.mjs

# Full: also runs `make build` (multi-minute Rust release + bundling)
node scripts/validate-build.mjs --full

# Machine-readable
node scripts/validate-build.mjs --json
```

## What it checks

For each `make` stage the validator asserts more than the exit code — it scans
output for hard-failure signatures that `make` would otherwise swallow:

- `CreateProcess(NULL` / `cannot find the file specified` — wrong shell (cmd
  can't find a Unix builtin); the OS-aware macros regressed.
- `PositionalParameterNotFound` — PowerShell `Remove-Item` given bad args.
- `Access is denied` / `os error 5` — a running app/sidecar locked a file
  (kill-running didn't clear it, or the app was relaunched mid-build).

It also verifies the expected artifacts exist:

- after `make sidecar` → `src-tauri/binaries/agent-core-*`
- after `make build` (`--full`) → `src-tauri/target/release/omni-agent-desktop[.exe]`

Exit codes: `0` all stages passed · `1` a stage failed · `2` preflight
(`make` not on PATH).

## Manual spot-checks

```bash
make kill-running     # should print the stop line, no os error
make clean-binaries   # should print deletes, NO "CreateProcess"/"PositionalParameter"
make sidecar          # should compile agent-core-<triple>
make                  # full build; end state: desktop exe + installers under target/release
```

Expected clean output has no `错误`/`error N` parameter-binding or
CreateProcess lines. Ignored-but-benign `error N (ignored)` on a genuinely
missing path is acceptable only when the delete macro's `; exit 0` is present;
if you see raw cmd `rm` invocations, the OS switch broke.

## Troubleshooting

- **`make` errors with `CreateProcess(NULL … rm …)`** — you're on Windows but
  the Makefile used a Unix `rm`. The `ifeq ($(OS),Windows_NT)` branch must route
  deletes through PowerShell `Remove-Item`.
- **`Access is denied` / os error 5 mid-build** — the app or a stray
  `agent-core.exe` is running. Run `make kill-running` (Windows:
  `Get-Process agent-core,omni-agent-desktop | Stop-Process -Force`), then close
  the desktop app, then rebuild.
- **`make` not found** — install GNU make (Windows: `choco install make`;
  macOS: `brew install make`; Linux: `apt install make`).

## When to run

- After any Makefile edit (especially the OS-aware clean/kill macros).
- After changing the sidecar build (`agent-core/build.mjs`, `build:bin`) or the
  Tauri build config.
- Before shipping a build-system change, on each target OS if possible.
