NPM ?= npm

.DEFAULT_GOAL := build

.PHONY: build start

# Build the single native binary → src-tauri/target/release/omni-agent-desktop[.exe]
build:
	$(NPM) run tauri build

# Run the built binary
start:
	$(NPM) start
