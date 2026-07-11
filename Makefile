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
