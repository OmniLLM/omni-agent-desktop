# Build and Start Workflow Design

## Goal

Provide a small, cross-platform Make interface for installing, developing, building, starting, checking, testing, and cleaning Omni Agent Desktop. Document the exact development and release workflows in the README.

## Command Interface

- `make help` lists the supported commands and is the default target.
- `make install` installs locked JavaScript dependencies with `npm ci`.
- `make dev` launches the complete Tauri development app with Vite hot reload.
- `make build` builds the release application and platform bundles through the Tauri CLI.
- `make start` launches the previously built release executable. It reports a clear error and recommends `make build` when the executable is absent.
- `make test` runs the frontend Vitest suite and Rust tests.
- `make check` type-checks/builds the frontend and runs `cargo check`.
- `make clean` removes Vite and Cargo build output.

## Cross-Platform Boundary

The Makefile delegates lifecycle operations to npm, Tauri, Cargo, and a small Node launcher rather than relying on Bash commands. The release launcher resolves the Windows `.exe` suffix and the Unix executable name from `process.platform`. Cleaning uses Node filesystem APIs for frontend output and `cargo clean` for Rust output.

## Files

- Simplify `Makefile` to expose only the public commands above.
- Add npm scripts in `package.json` only where cross-platform behavior is needed by Make.
- Add a small release launcher under `scripts/` with a single responsibility: locate and run the built application.
- Update `README.md` with prerequisites, development startup, release build/start, and validation commands.

## Error Handling

The release launcher inherits application input/output and exit status. If no release executable exists, it exits nonzero with an actionable `make build` instruction. Child-process launch errors are printed and returned as failures.

## Verification

Run the following checks:

1. `make help` to verify the documented interface.
2. `make check` for frontend type/build checks and Rust compilation.
3. `make test` for frontend and Rust tests.
4. `make build` to produce the platform release artifacts.
5. Exercise `make start` against the built application and confirm the process launches, terminating it after observation so verification does not block.
