NPM ?= npm
BUN ?= bun

.DEFAULT_GOAL := build

.PHONY: build start sidecar sidecar-dev sidecar-install clean clean-binaries

# Build the single native binary → src-tauri/target/release/omni-agent-desktop[.exe]
# Always purge stale/legacy binaries first so a rebuild can never pick up an
# out-of-date compiled sidecar or a leftover artifact from an earlier layout.
build: clean-binaries sidecar
	$(NPM) run tauri build

# Run the built binary
start:
	$(NPM) start

# Remove legacy/old build artifacts so builds start from a clean slate:
#   - the per-target compiled sidecar (src-tauri/binaries/agent-core-*)
#   - any stray files in binaries/ except the tracked .gitignore / README.md
#   - the agent-core TS build output (dist/)
#   - the previously built desktop exe + installers
# Keeps .gitignore and README.md (the only tracked files under binaries/).
clean-binaries:
	@echo "cleaning legacy binaries…"
	-rm -f src-tauri/binaries/agent-core-*
	-rm -f src-tauri/binaries/*.js src-tauri/binaries/*.js.map
	-rm -rf agent-core/dist
	-rm -f src-tauri/target/release/omni-agent-desktop src-tauri/target/release/omni-agent-desktop.exe
	-rm -rf src-tauri/target/release/bundle

# Full clean (adds the Rust target dir). Use before a from-scratch build.
clean: clean-binaries
	-rm -rf src-tauri/target

# Compile agent-core to a per-target single-file binary
# (src-tauri/binaries/agent-core-<triple>[.exe]) via Bun.
sidecar: sidecar-install
	cd agent-core && $(BUN) run build:bin

sidecar-install:
	cd agent-core && $(BUN) install

# Bun watch mode — the dev fallback in src-tauri/src/sidecar.rs runs
# `bun agent-core/src/index.ts` when the packaged binary is absent, so this
# suffices for `tauri dev`.
sidecar-dev:
	cd agent-core && $(BUN) --watch src/index.ts
