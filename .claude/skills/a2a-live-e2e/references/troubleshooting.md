# Troubleshooting

## Card discovery fails

- Confirm the connection is enabled in `~/.config/omni-agent-desktop/settings.json`.
- Confirm its endpoint is reachable and exposes either `/.well-known/agent-card.json` or `/.well-known/agent.json`.
- Confirm the saved token is current. The runner sends it as a Bearer token but never prints or stores it.
- Corporate proxy behavior may differ from the app. Set `NO_PROXY` for local/private A2A hosts when appropriate.

## No safe skills selected

The runner is intentionally conservative against a live server. Use `--skill <id>` only to narrow selection; it does not override the read-only classifier. Improve the card's description/tags/examples so read-only intent is explicit, or use a staging server and extend the classifier in a reviewed change.

## `tauri-driver` is missing

Install explicitly after reviewing the crate and your environment:

```powershell
cargo install tauri-driver --locked
```

The runner never performs global installs.

## Edge WebDriver is missing or incompatible

Install `msedgedriver.exe` for the installed Microsoft Edge/WebView2 major version and place it on `PATH`. Confirm with:

```powershell
msedgedriver --version
```

A session-creation error usually means the driver and WebView2 versions differ.

## Application binary is missing

Build the real app from the repository root:

```powershell
make
```

The default binary is `src-tauri/target/release/omni-agent-desktop.exe`.

## Window remains hidden

The app starts with `visible: false`. The runner executes the global Tauri window API to show and focus it. If that fails, verify `app.withGlobalTauri` remains enabled in `src-tauri/tauri.conf.json`.

## Answer appears without A2A delegation

This is a failed E2E even if the prose is correct. Inspect `events.jsonl` and the card-derived tool name. Improve the question so it clearly requires the advertised live data, or verify the provider received the discovered tool definition.

## Unexpected approval prompt

A2A delegation is gated in Ask mode because it can affect remote state. The runner approves exactly one request only when its tool name equals the selected, card-derived read-only A2A tool. It never enables “Approve for me.” An approval request for a different/local tool is a failure and must not be approved.

## Timeout or orphan process

The runner uses bounded waits and kills its own app/driver children in `finally`. If an earlier manual run remains, close only the process you started and retry. Do not kill unrelated WebView2 or Edge processes globally.
