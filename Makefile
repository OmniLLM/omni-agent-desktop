SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c

APP_NAME := omni-agent-desktop
TAURI_DIR := src-tauri
NPM ?= npm
CARGO ?= cargo
BACKEND_URL ?= http://127.0.0.1:1422
RELEASE_BINARY := $(TAURI_DIR)/target/release/$(APP_NAME)

.DEFAULT_GOAL := help

.PHONY: help deps install dev dev-web build binary build-frontend package dist check check-frontend check-rust \
        test test-frontend test-rust verify-binary clean clean-frontend clean-rust print-artifacts

help: ## Show build/test targets
	@printf '\nOmni Agent Desktop build targets\n\n'
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make <target> [BACKEND_URL=http://127.0.0.1:1422]\n\nTargets:\n"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf '\nCommon:\n  make install\n  make build\n  make verify-binary\n  make package\n\n'

deps: ## Install JavaScript dependencies from package-lock.json
	$(NPM) install

install: deps ## Alias for deps

build: binary ## Build the self-contained release binary with embedded frontend

binary: build-frontend ## Build the release binary; React/Vite assets are embedded by tauri-build
	cd $(TAURI_DIR) && $(CARGO) build --release
	@echo "Built $(RELEASE_BINARY)"

package: ## Build platform bundles/installers via Tauri
	$(NPM) run tauri build

dist: package ## Alias for package

check: check-frontend check-rust ## Run fast frontend and Rust compile checks

check-frontend: ## Type-check and build the frontend
	$(NPM) run build

build-frontend: check-frontend ## Alias for check-frontend

check-rust: ## Run cargo check for the Tauri shell
	cd $(TAURI_DIR) && $(CARGO) check

test: test-frontend test-rust ## Run frontend unit tests and Rust tests

test-frontend: ## Run Vitest once
	$(NPM) test

test-rust: ## Run cargo tests for the Tauri shell
	cd $(TAURI_DIR) && $(CARGO) test

dev: ## Run the full Tauri dev app (Vite + desktop shell)
	OMNI_AGENT_BACKEND_URL="$(BACKEND_URL)" $(NPM) run tauri dev

dev-web: ## Run only the Vite frontend dev server
	$(NPM) run dev

verify-binary: build ## Verify the release binary exists and contains embedded frontend HTML
	@test -x "$(RELEASE_BINARY)"
	@file "$(RELEASE_BINARY)"
	@grep -a -q '<!doctype html>' "$(RELEASE_BINARY)"
	@echo "Verified embedded frontend in $(RELEASE_BINARY)"
	@echo "Note: Linux Tauri binaries still dynamically link system WebKitGTK/GTK libraries."

clean: clean-frontend clean-rust ## Remove frontend and Rust build artifacts

clean-frontend: ## Remove frontend build output
	rm -rf dist

clean-rust: ## Run cargo clean for Tauri artifacts
	cd $(TAURI_DIR) && $(CARGO) clean

print-artifacts: ## Print expected build artifacts
	@printf 'release_binary=%s\npackage_dir=%s\n' '$(RELEASE_BINARY)' '$(TAURI_DIR)/target/release/bundle'
