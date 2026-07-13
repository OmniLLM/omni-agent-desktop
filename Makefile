NPM ?= npm
BUN ?= bun

.DEFAULT_GOAL := build

.PHONY: build start sidecar sidecar-dev sidecar-install clean clean-binaries kill-running

# --- OS-aware shell helpers -------------------------------------------------
# On Windows, GNU make spawns commands through cmd.exe, which has no `rm`. Route
# deletes through PowerShell (Remove-Item). On Linux/macOS use plain bash `rm`.
# RM_F   <files…>  : delete files, ignore missing.
# RM_RF  <dir>     : delete a directory tree, ignore missing.
# KILL_APP         : free file locks held by a running app/sidecar (Windows only).
ifeq ($(OS),Windows_NT)
  PS := powershell -NoProfile -NonInteractive -Command
  RM_F  = $(PS) "Remove-Item -Force -ErrorAction SilentlyContinue $(1); exit 0"
  RM_RF = $(PS) "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $(1); exit 0"
  KILL_APP = $(PS) "Get-Process agent-core,omni-agent-desktop -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0"
else
  RM_F  = rm -f $(1)
  RM_RF = rm -rf $(1)
  KILL_APP = pkill -f agent-core 2>/dev/null || true; pkill -f omni-agent-desktop 2>/dev/null || true
endif

# Build the single native binary → src-tauri/target/release/omni-agent-desktop[.exe]
# Free any file locks and purge stale/legacy binaries first so a rebuild can
# never pick up an out-of-date compiled sidecar or a leftover artifact.
build: kill-running clean-binaries sidecar
	$(NPM) run tauri build

# Run the built binary
start:
	$(NPM) start

# Terminate a running app/sidecar so its open file handles don't block the
# clean/overwrite steps below (the "Access is denied" / os error 5 failure).
kill-running:
	@echo "stopping any running app/sidecar..."
	-$(KILL_APP)

# Remove legacy/old build artifacts so builds start from a clean slate:
#   - the per-target compiled sidecar (src-tauri/binaries/agent-core-*)
#   - any stray files in binaries/ except the tracked .gitignore / README.md
#   - the agent-core TS build output (dist/)
#   - the previously built desktop exe + installers
# Keeps .gitignore and README.md (the only tracked files under binaries/).
clean-binaries:
	@echo "cleaning legacy binaries..."
	-$(call RM_F,src-tauri/binaries/agent-core-*)
	-$(call RM_F,src-tauri/binaries/*.js)
	-$(call RM_F,src-tauri/binaries/*.js.map)
	-$(call RM_RF,agent-core/dist)
	-$(call RM_F,src-tauri/target/release/omni-agent-desktop)
	-$(call RM_F,src-tauri/target/release/omni-agent-desktop.exe)
	-$(call RM_RF,src-tauri/target/release/bundle)

# Full clean (adds the Rust target dir). Use before a from-scratch build.
clean: clean-binaries
	-$(call RM_RF,src-tauri/target)

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
