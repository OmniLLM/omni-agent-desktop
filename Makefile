NPM ?= npm
BUN ?= bun

.DEFAULT_GOAL := build

.PHONY: build start sidecar sidecar-dev sidecar-install

# Build the single native binary → src-tauri/target/release/omni-agent-desktop[.exe]
build: sidecar
	$(NPM) run tauri build

# Run the built binary
start:
	$(NPM) start

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
