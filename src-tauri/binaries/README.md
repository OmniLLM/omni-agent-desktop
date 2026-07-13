# src-tauri/binaries/

Tauri `externalBin` drop-in for the compiled **agent-core** sidecar.

Build with:

    make sidecar                    # or: cd agent-core && npm run build:bin

which emits `agent-core-<rustc-host-triple>[.exe]` here. Tauri's bundler and
build script both require the file to exist — `cargo check` will fail without
it. In CI, run `make sidecar` before any `cargo` / `tauri` command.
