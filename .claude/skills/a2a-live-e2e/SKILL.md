---
name: a2a-live-e2e
description: Verify this project's A2A integration against live servers through the real Tauri desktop UI. Use this skill whenever the user asks to test an A2A server, retrieve or validate an agent card, prove A2A skill delegation, run live A2A E2E tests, or mimic user questions in the desktop app—even when they do not explicitly say “skill.” It discovers cards before launching the UI, executes only clearly read-only skills, captures delegation evidence, and rejects browser/mock-only substitutes.
compatibility: Windows 11, Node.js 20+, built Omni Agent Desktop binary, tauri-driver, Microsoft Edge WebDriver/WebView2, configured provider and enabled A2A connections in ~/.config/omni-agent-desktop/settings.json
---

# Live A2A E2E verification

Verify the complete path a user experiences:

`agent card → model tool discovery → Composer prompt → A2A tool call/result → rendered answer`

A browser-only Vite session is not evidence: without the Tauri runtime, `agent_run` and A2A commands use mocks. Drive the native WebView2 application through `tauri-driver`.

## Run

From the repository root:

```powershell
node .claude/skills/a2a-live-e2e/scripts/run.mjs --dry-run
node .claude/skills/a2a-live-e2e/scripts/run.mjs
```

Useful filters:

```powershell
node .claude/skills/a2a-live-e2e/scripts/run.mjs --connection "inventory" --skill "list-assets"
node .claude/skills/a2a-live-e2e/scripts/run.mjs --question "List the current non-sensitive inventory summary"
node .claude/skills/a2a-live-e2e/scripts/run.mjs --binary "src-tauri/target/release/omni-agent-desktop.exe" --timeout 180
```

`--dry-run` retrieves and saves redacted cards, derives safe questions, and checks the app configuration without launching or invoking a skill.

## Required workflow

1. Run the discovery dry run first. Do not launch the app until at least one card was retrieved.
2. Review the selected questions and skipped skills. The runner only selects skills whose metadata clearly describes read/query/list/get/describe/search/inspect/show/count/status behavior. It skips ambiguous or mutating skills.
3. If the binary is absent, build it with `make`. Do not silently install `tauri-driver` or Edge WebDriver; report the preflight remediation instead.
4. Run the full command. It launches `tauri-driver`, attaches to the real app, installs `agent://*` event listeners, types into `textarea[placeholder="Message the agent"]`, and submits with Enter.
5. Inspect the generated `report.md`, `result.json`, `events.jsonl`, transcript, and screenshots under `.artifacts/a2a-live-e2e/<run-id>/`.
6. Report PASS only when every tested question has:
   - an `agent://tool-call` matching the card-derived A2A tool name,
   - a corresponding non-error `agent://tool-result`,
   - a non-empty `agent://done`, and
   - a visible assistant response in `.bubble.assistant`.
7. Always preserve failure evidence and ensure the runner closes the WebDriver session and child processes.

## Safety

- Treat the configured server as live production unless told otherwise.
- Never invoke skills whose name, description, tags, or examples suggest create, update, delete, deploy, stop, start, restart, write, modify, terminate, scale, purge, send, or execute behavior.
- Keep “Approve for me” disabled. When the selected card-derived A2A tool requests approval, the runner clicks **Approve** once through the visible UI. Any approval request for a different/local tool fails the run.
- Never print or save A2A tokens, provider keys, authorization headers, or raw settings. Cards are recursively redacted before writing.
- Do not modify saved settings. Use `--connection` and `--skill` only as filters.
- A final answer without matching A2A delegation is a failure, even if the answer sounds plausible.

## Evidence report

Return a concise summary:

```markdown
## A2A live E2E
**Verdict:** PASS | FAIL | BLOCKED
**Cards retrieved first:** <count and connection names>
**Native UI:** <binary and driver>

| Question | A2A tool | Tool result | Visible answer | Verdict |
|---|---|---|---|---|

**Skipped unsafe/ambiguous skills:** ...
**Artifacts:** <path>
**Failure/remediation:** ...
```

Read `references/troubleshooting.md` only when preflight, driver startup, discovery, delegation, or cleanup fails.
