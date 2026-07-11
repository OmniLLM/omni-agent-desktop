# Build and Start Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Unix-oriented Make workflow with a small cross-platform interface and document exact development and release commands.

**Architecture:** Make remains the user-facing command index but delegates work to npm scripts. A focused Node script resolves and launches the platform-specific release executable, while another npm script uses Node filesystem APIs for cross-platform frontend cleanup.

**Tech Stack:** GNU Make, npm, Node.js ESM, Tauri 2, Cargo, Vite, Vitest

---

## File Structure

- `Makefile`: public command interface only: help, install, dev, build, start, test, check, clean.
- `package.json`: cross-platform release-start and clean scripts used by Make.
- `scripts/start-release.mjs`: locate and launch the release executable, preserving stdio and exit status.
- `scripts/start-release.test.mjs`: Node unit tests for executable resolution and missing-build behavior.
- `README.md`: prerequisites and copy-paste development/release instructions.

### Task 1: Release Launcher

**Files:**
- Create: `scripts/start-release.mjs`
- Create: `scripts/start-release.test.mjs`

- [ ] **Step 1: Write failing launcher tests**

Create tests using `node:test` that import `getReleaseExecutable` and `validateReleaseExecutable`, assert Windows resolves `src-tauri/target/release/omni-agent-desktop.exe`, non-Windows resolves the suffix-free path, and a missing path throws an error containing `make build`.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test scripts/start-release.test.mjs`
Expected: FAIL because `scripts/start-release.mjs` does not exist.

- [ ] **Step 3: Implement the launcher**

Export pure helpers for path resolution and existence validation. When executed directly, resolve from the repository root, validate the executable, and call `spawnSync(executable, { stdio: "inherit" })`. Print launch errors and set `process.exitCode` to the child status or `1`.

- [ ] **Step 4: Run launcher tests**

Run: `node --test scripts/start-release.test.mjs`
Expected: all tests PASS.

### Task 2: Minimal Make and npm Interface

**Files:**
- Modify: `Makefile`
- Modify: `package.json`

- [ ] **Step 1: Add npm lifecycle scripts**

Add:

```json
"start": "node scripts/start-release.mjs",
"clean": "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\""
```

Preserve all existing scripts.

- [ ] **Step 2: Replace the Makefile interface**

Use only portable variable declarations and these targets:

```make
NPM ?= npm
CARGO ?= cargo
TAURI_DIR := src-tauri

.DEFAULT_GOAL := help

.PHONY: help install dev build start test check clean

help:
	@$(NPM) --silent run make:help

install:
	$(NPM) ci

dev:
	$(NPM) run tauri dev

build:
	$(NPM) run tauri build

start:
	$(NPM) start

test:
	$(NPM) test
	cd $(TAURI_DIR) && $(CARGO) test

check:
	$(NPM) run build
	cd $(TAURI_DIR) && $(CARGO) check

clean:
	$(NPM) run clean
	cd $(TAURI_DIR) && $(CARGO) clean
```

Add a `make:help` npm script that prints the seven commands without relying on `awk` or `printf`.

- [ ] **Step 3: Verify the command interface**

Run: `make help`
Expected: exits zero and lists install, dev, build, start, test, check, and clean.

### Task 3: README Instructions

**Files:**
- Modify: `README.md:82-105`

- [ ] **Step 1: Replace development instructions**

Document prerequisites: Node.js/npm, Rust/Cargo, GNU Make, and Tauri 2 platform prerequisites. Then document:

```bash
make install
make dev
```

Explain that `make dev` opens the desktop app with hot reload.

- [ ] **Step 2: Document release build and startup**

Add:

```bash
make build
make start
```

Explain that `make build` creates platform bundles under `src-tauri/target/release/bundle/` and `make start` runs the built executable from `src-tauri/target/release/`.

- [ ] **Step 3: Document validation**

Add `make check`, `make test`, `make clean`, and `make help` with concise descriptions.

### Task 4: Full Verification

**Files:**
- Test: `scripts/start-release.test.mjs`
- Test: existing frontend and Rust suites

- [ ] **Step 1: Run launcher tests**

Run: `node --test scripts/start-release.test.mjs`
Expected: PASS.

- [ ] **Step 2: Run static checks**

Run: `make check`
Expected: Vite/TypeScript build and `cargo check` both PASS.

- [ ] **Step 3: Run tests**

Run: `make test`
Expected: Vitest and Cargo test suites PASS.

- [ ] **Step 4: Build release application**

Run: `make build`
Expected: Tauri release build succeeds and creates the Windows executable plus bundle output.

- [ ] **Step 5: Exercise release startup**

Launch `make start` as a background process, wait until the desktop process is observed, and terminate only that launched process after confirming it remains running. Expected: launcher finds the `.exe` and the application starts without an immediate error.

- [ ] **Step 6: Review final diff**

Run: `git diff --check` and `git status --short`
Expected: no whitespace errors; only intended files plus pre-existing user changes are reported. Do not commit unless explicitly requested.
