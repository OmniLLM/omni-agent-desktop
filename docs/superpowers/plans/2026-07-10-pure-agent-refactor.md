# Pure Agent Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Omni Agent Desktop into a pure desktop AI agent: a native Rust agent loop with seven local tools and A2A tools, three run modes, provider requests, single-conversation persistence, and a thin React chat shell with launcher heritage removed.

**Architecture:** Rust (`src-tauri`) owns the agent loop, provider HTTP client, local tool registry, A2A client, and run-mode gating; it streams events to a thin React chat UI. All launcher/search/favorites/plugin/skill/session code is deleted. No OmniLauncher HTTP backend.

**Tech Stack:** Tauri 2, Rust (reqwest + tokio for async HTTP, serde_json, glob, walkdir, regex), React 18 + Vite + Vitest.

---

## File Structure

Rust (`src-tauri/src/`):
- `main.rs` — wiring: commands, event emission, hotkey (modify).
- `settings.rs` — extend with `a2a_connections` and `run_mode` default (modify).
- `agent/mod.rs` — agent loop, run-mode gating, message types.
- `agent/provider.rs` — provider request build + response parse (OpenAI-compatible, Anthropic Messages) + `/models`.
- `agent/tools.rs` — local tool registry: read/write/edit/ls/glob/grep/bash; JSON-schema defs + executors + classification.
- `agent/a2a.rs` — native agent-card discovery, skill→tool derivation, JSON-RPC delegation.

Frontend (`src/`):
- Delete launcher heritage (hooks/components/config).
- `App.tsx` — chat + settings orchestration (rewrite).
- `components/ChatPane.tsx`, `components/Composer.tsx`, `components/ToolApprovalPrompt.tsx` (new).
- `hooks/useAgent.ts` (new) — drives `agent_run`/events/approval.
- `components/SettingsWindow.tsx` — add A2A tab (modify).
- `types/app.ts` — trim launcher types, add agent/run-mode/A2A types (modify).

---

## Task 1: Add Rust async HTTP + utility deps

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add dependencies**

In `[dependencies]` add:

```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time", "process"] }
glob = "0.3"
walkdir = "2"
regex = "1"
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: PASS (downloads crates, no code errors).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "chore: add async http and fs utility deps"
```

---

## Task 2: Local tool registry — types and classification

**Files:**
- Create: `src-tauri/src/agent/mod.rs`
- Create: `src-tauri/src/agent/tools.rs`
- Modify: `src-tauri/src/main.rs` (add `mod agent;`)

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/agent/tools.rs`:

```rust
//! Local tool registry: definitions, classification, and native executors.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Whether a tool mutates local state (files/process) or is read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolClass {
    ReadOnly,
    Mutating,
}

/// The seven built-in local tools.
pub const LOCAL_TOOLS: [&str; 7] =
    ["read", "ls", "glob", "grep", "write", "edit", "bash"];

pub fn classify(tool: &str) -> ToolClass {
    match tool {
        "read" | "ls" | "glob" | "grep" => ToolClass::ReadOnly,
        _ => ToolClass::Mutating,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_splits_read_and_mutating() {
        assert_eq!(classify("read"), ToolClass::ReadOnly);
        assert_eq!(classify("grep"), ToolClass::ReadOnly);
        assert_eq!(classify("write"), ToolClass::Mutating);
        assert_eq!(classify("bash"), ToolClass::Mutating);
        assert_eq!(classify("edit"), ToolClass::Mutating);
    }
}
```

In `src-tauri/src/agent/mod.rs`:

```rust
pub mod tools;
```

In `src-tauri/src/main.rs`, after `mod settings;` add:

```rust
mod agent;
```

- [ ] **Step 2: Run test to verify it fails/compiles**

Run: `cd src-tauri && cargo test agent::tools::tests::classification_splits_read_and_mutating`
Expected: PASS (this task is a pure function; it should pass once it compiles).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agent src-tauri/src/main.rs
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: add local tool classification"
```

---

## Task 3: Tool JSON-schema definitions

**Files:**
- Modify: `src-tauri/src/agent/tools.rs`

- [ ] **Step 1: Write the failing test**

Add to `tools.rs`:

```rust
/// JSON-schema tool definitions in OpenAI `tools` array format.
pub fn tool_definitions() -> Vec<Value> {
    fn def(name: &str, desc: &str, props: Value, required: Vec<&str>) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": name,
                "description": desc,
                "parameters": {
                    "type": "object",
                    "properties": props,
                    "required": required,
                }
            }
        })
    }
    vec![
        def("read", "Read a UTF-8 text file.",
            json!({"path": {"type": "string"}}), vec!["path"]),
        def("ls", "List entries in a directory.",
            json!({"path": {"type": "string"}}), vec!["path"]),
        def("glob", "List files matching a glob pattern.",
            json!({"pattern": {"type": "string"}}), vec!["pattern"]),
        def("grep", "Search files for a regex; returns matching lines.",
            json!({"pattern": {"type": "string"}, "path": {"type": "string"}}),
            vec!["pattern", "path"]),
        def("write", "Create or overwrite a file with content.",
            json!({"path": {"type": "string"}, "content": {"type": "string"}}),
            vec!["path", "content"]),
        def("edit", "Replace the first occurrence of old_string with new_string in a file.",
            json!({"path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}}),
            vec!["path", "old_string", "new_string"]),
        def("bash", "Run a shell command and return combined stdout/stderr.",
            json!({"command": {"type": "string"}}), vec!["command"]),
    ]
}

#[cfg(test)]
mod def_tests {
    use super::*;
    #[test]
    fn definitions_cover_all_local_tools() {
        let defs = tool_definitions();
        let names: Vec<String> = defs.iter()
            .map(|d| d["function"]["name"].as_str().unwrap().to_string())
            .collect();
        for t in LOCAL_TOOLS { assert!(names.contains(&t.to_string()), "missing {t}"); }
        assert_eq!(defs.len(), 7);
    }
}
```

- [ ] **Step 2: Run test**

Run: `cd src-tauri && cargo test agent::tools::def_tests`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agent/tools.rs
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: add local tool json-schema definitions"
```

---

## Task 4: Tool executors (read/ls/glob/grep/write/edit/bash)

**Files:**
- Modify: `src-tauri/src/agent/tools.rs`

- [ ] **Step 1: Write the failing tests**

Add to `tools.rs`:

```rust
use std::fs;
use std::path::Path;

/// Execute a local tool. Returns Ok(result_text) or Err(error_text). Errors are
/// returned to the model as tool results, never as fatal loop errors.
pub fn execute(tool: &str, args: &Value) -> Result<String, String> {
    match tool {
        "read" => exec_read(args),
        "ls" => exec_ls(args),
        "glob" => exec_glob(args),
        "grep" => exec_grep(args),
        "write" => exec_write(args),
        "edit" => exec_edit(args),
        "bash" => exec_bash(args),
        other => Err(format!("unknown tool: {other}")),
    }
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key).and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing string arg: {key}"))
}

fn exec_read(args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path")?;
    fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

fn exec_ls(args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path")?;
    let mut names: Vec<String> = fs::read_dir(&path)
        .map_err(|e| format!("ls {path}: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    Ok(names.join("\n"))
}

fn exec_glob(args: &Value) -> Result<String, String> {
    let pattern = arg_str(args, "pattern")?;
    let mut out = Vec::new();
    for entry in glob::glob(&pattern).map_err(|e| format!("glob: {e}"))? {
        if let Ok(p) = entry { out.push(p.to_string_lossy().to_string()); }
    }
    Ok(out.join("\n"))
}

fn exec_grep(args: &Value) -> Result<String, String> {
    let pattern = arg_str(args, "pattern")?;
    let path = arg_str(args, "path")?;
    let re = regex::Regex::new(&pattern).map_err(|e| format!("bad regex: {e}"))?;
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() { continue; }
        let p = entry.path();
        if let Ok(text) = fs::read_to_string(p) {
            for (i, line) in text.lines().enumerate() {
                if re.is_match(line) {
                    out.push(format!("{}:{}:{}", p.display(), i + 1, line));
                }
            }
        }
    }
    Ok(out.join("\n"))
}

fn exec_write(args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path")?;
    let content = arg_str(args, "content")?;
    if let Some(parent) = Path::new(&path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, &content).map_err(|e| format!("write {path}: {e}"))?;
    Ok(format!("wrote {} bytes to {path}", content.len()))
}

fn exec_edit(args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path")?;
    let old = arg_str(args, "old_string")?;
    let new = arg_str(args, "new_string")?;
    let text = fs::read_to_string(&path).map_err(|e| format!("edit {path}: {e}"))?;
    if !text.contains(&old) {
        return Err(format!("old_string not found in {path}"));
    }
    let updated = text.replacen(&old, &new, 1);
    fs::write(&path, updated).map_err(|e| format!("edit {path}: {e}"))?;
    Ok(format!("edited {path}"))
}

fn exec_bash(args: &Value) -> Result<String, String> {
    let command = arg_str(args, "command")?;
    let output = if cfg!(target_os = "windows") {
        std::process::Command::new("cmd").args(["/C", &command]).output()
    } else {
        std::process::Command::new("sh").args(["-c", &command]).output()
    }
    .map_err(|e| format!("bash spawn: {e}"))?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    let err = String::from_utf8_lossy(&output.stderr);
    if !err.is_empty() { combined.push_str(&err); }
    Ok(combined)
}

#[cfg(test)]
mod exec_tests {
    use super::*;
    use serde_json::json;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("omni-tools-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn write_then_read_roundtrips() {
        let d = tmp();
        let f = d.join("a.txt");
        let fp = f.to_string_lossy().to_string();
        execute("write", &json!({"path": fp, "content": "hello"})).unwrap();
        let got = execute("read", &json!({"path": fp})).unwrap();
        assert_eq!(got, "hello");
    }

    #[test]
    fn edit_replaces_first_occurrence() {
        let d = tmp();
        let f = d.join("b.txt");
        let fp = f.to_string_lossy().to_string();
        execute("write", &json!({"path": fp, "content": "foo foo"})).unwrap();
        execute("edit", &json!({"path": fp, "old_string": "foo", "new_string": "bar"})).unwrap();
        let got = execute("read", &json!({"path": fp})).unwrap();
        assert_eq!(got, "bar foo");
    }

    #[test]
    fn edit_missing_string_errors() {
        let d = tmp();
        let f = d.join("c.txt");
        let fp = f.to_string_lossy().to_string();
        execute("write", &json!({"path": fp, "content": "x"})).unwrap();
        assert!(execute("edit", &json!({"path": fp, "old_string": "zzz", "new_string": "y"})).is_err());
    }

    #[test]
    fn ls_and_glob_list_files() {
        let d = tmp();
        let fp = d.join("only.txt");
        std::fs::write(&fp, "1").unwrap();
        let ls = execute("ls", &json!({"path": d.to_string_lossy()})).unwrap();
        assert!(ls.contains("only.txt"));
        let g = execute("glob", &json!({"pattern": d.join("*.txt").to_string_lossy()})).unwrap();
        assert!(g.contains("only.txt"));
    }

    #[test]
    fn grep_finds_matching_line() {
        let d = tmp();
        std::fs::write(d.join("g.txt"), "alpha\nbeta\n").unwrap();
        let out = execute("grep", &json!({"pattern": "bet", "path": d.to_string_lossy()})).unwrap();
        assert!(out.contains("beta"));
    }

    #[test]
    fn bash_echoes() {
        let out = execute("bash", &json!({"command": "echo hi"})).unwrap();
        assert!(out.contains("hi"));
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test agent::tools::exec_tests`
Expected: PASS (all 6).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agent/tools.rs
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: implement local tool executors"
```

---

## Task 5: Provider request builder + response parser

**Files:**
- Create: `src-tauri/src/agent/provider.rs`
- Modify: `src-tauri/src/agent/mod.rs` (add `pub mod provider;`)

- [ ] **Step 1: Write the failing tests**

In `provider.rs`:

```rust
//! Build provider HTTP requests and parse responses by API shape.
use crate::settings::{ApiShape, ProviderConfig};
use serde_json::{json, Value};

pub struct BuiltRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
    pub shape: ApiShape,
}

/// Normalize an endpoint: strip trailing slashes; append `/v1` only when the URL
/// has no path segment. Never duplicate `/v1`.
pub fn normalize_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() { return trimmed.to_string(); }
    let after_scheme = trimmed.splitn(2, "://").nth(1).unwrap_or(trimmed);
    let has_path = after_scheme.contains('/');
    if has_path { trimmed.to_string() } else { format!("{trimmed}/v1") }
}

/// A normalized chat message.
#[derive(Debug, Clone)]
pub struct Msg { pub role: String, pub content: String }

pub fn build_request(
    config: &ProviderConfig,
    system: &str,
    messages: &[Msg],
    tools: &[Value],
) -> BuiltRequest {
    let base = normalize_endpoint(&config.endpoint);
    match config.api_shape {
        ApiShape::AnthropicMessages => {
            let msgs: Vec<Value> = messages.iter()
                .map(|m| json!({"role": m.role, "content": m.content})).collect();
            BuiltRequest {
                url: format!("{base}/messages"),
                headers: vec![
                    ("x-api-key".into(), config.api_key.clone()),
                    ("anthropic-version".into(), "2023-06-01".into()),
                    ("content-type".into(), "application/json".into()),
                ],
                body: json!({"model": config.model, "system": system,
                    "messages": msgs, "max_tokens": 4096}),
                shape: ApiShape::AnthropicMessages,
            }
        }
        ApiShape::OpenaiResponses => {
            let mut input = vec![json!({"role": "system", "content": system})];
            for m in messages { input.push(json!({"role": m.role, "content": m.content})); }
            BuiltRequest {
                url: format!("{base}/responses"),
                headers: bearer(config),
                body: json!({"model": config.model, "input": input, "tools": tools}),
                shape: ApiShape::OpenaiResponses,
            }
        }
        ApiShape::OpenaiCompatible => {
            let mut msgs = vec![json!({"role": "system", "content": system})];
            for m in messages { msgs.push(json!({"role": m.role, "content": m.content})); }
            BuiltRequest {
                url: format!("{base}/chat/completions"),
                headers: bearer(config),
                body: json!({"model": config.model, "messages": msgs, "tools": tools}),
                shape: ApiShape::OpenaiCompatible,
            }
        }
    }
}

fn bearer(config: &ProviderConfig) -> Vec<(String, String)> {
    vec![
        ("authorization".into(), format!("Bearer {}", config.api_key)),
        ("content-type".into(), "application/json".into()),
    ]
}

/// A parsed assistant turn: text plus any tool calls.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedTurn {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall { pub id: String, pub name: String, pub args: Value }

pub fn parse_response(shape: ApiShape, body: &Value) -> ParsedTurn {
    match shape {
        ApiShape::AnthropicMessages => parse_anthropic(body),
        _ => parse_openai_chat(body),
    }
}

fn parse_openai_chat(body: &Value) -> ParsedTurn {
    let msg = &body["choices"][0]["message"];
    let text = msg["content"].as_str().unwrap_or("").to_string();
    let mut calls = Vec::new();
    if let Some(arr) = msg["tool_calls"].as_array() {
        for c in arr {
            let name = c["function"]["name"].as_str().unwrap_or("").to_string();
            let raw = c["function"]["arguments"].as_str().unwrap_or("{}");
            let args = serde_json::from_str(raw).unwrap_or(json!({}));
            calls.push(ToolCall { id: c["id"].as_str().unwrap_or("").to_string(), name, args });
        }
    }
    ParsedTurn { text, tool_calls: calls }
}

fn parse_anthropic(body: &Value) -> ParsedTurn {
    let mut text = String::new();
    let mut calls = Vec::new();
    if let Some(arr) = body["content"].as_array() {
        for block in arr {
            match block["type"].as_str() {
                Some("text") => text.push_str(block["text"].as_str().unwrap_or("")),
                Some("tool_use") => calls.push(ToolCall {
                    id: block["id"].as_str().unwrap_or("").to_string(),
                    name: block["name"].as_str().unwrap_or("").to_string(),
                    args: block["input"].clone(),
                }),
                _ => {}
            }
        }
    }
    ParsedTurn { text, tool_calls: calls }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(shape: ApiShape) -> ProviderConfig {
        ProviderConfig { endpoint: "https://api.test.com".into(), api_key: "k".into(),
            api_shape: shape, model: "m".into(), manual_models: String::new() }
    }

    #[test]
    fn normalize_adds_v1_only_without_path() {
        assert_eq!(normalize_endpoint("https://api.test.com/"), "https://api.test.com/v1");
        assert_eq!(normalize_endpoint("https://api.test.com/v1"), "https://api.test.com/v1");
        assert_eq!(normalize_endpoint("https://api.test.com/openai"), "https://api.test.com/openai");
    }

    #[test]
    fn openai_request_targets_chat_completions_with_bearer() {
        let r = build_request(&cfg(ApiShape::OpenaiCompatible), "sys", &[], &[]);
        assert_eq!(r.url, "https://api.test.com/v1/chat/completions");
        assert!(r.headers.iter().any(|(k, v)| k == "authorization" && v == "Bearer k"));
    }

    #[test]
    fn anthropic_request_uses_x_api_key_and_messages() {
        let r = build_request(&cfg(ApiShape::AnthropicMessages), "sys", &[], &[]);
        assert_eq!(r.url, "https://api.test.com/v1/messages");
        assert!(r.headers.iter().any(|(k, v)| k == "x-api-key" && v == "k"));
    }

    #[test]
    fn parse_openai_extracts_text_and_tool_call() {
        let body = json!({"choices":[{"message":{"content":"hi",
            "tool_calls":[{"id":"c1","function":{"name":"read","arguments":"{\"path\":\"x\"}"}}]}}]});
        let t = parse_response(ApiShape::OpenaiCompatible, &body);
        assert_eq!(t.text, "hi");
        assert_eq!(t.tool_calls[0].name, "read");
        assert_eq!(t.tool_calls[0].args["path"], "x");
    }

    #[test]
    fn parse_anthropic_extracts_text_and_tool_use() {
        let body = json!({"content":[{"type":"text","text":"ok"},
            {"type":"tool_use","id":"t1","name":"bash","input":{"command":"ls"}}]});
        let t = parse_response(ApiShape::AnthropicMessages, &body);
        assert_eq!(t.text, "ok");
        assert_eq!(t.tool_calls[0].name, "bash");
        assert_eq!(t.tool_calls[0].args["command"], "ls");
    }
}
```

Add `pub mod provider;` to `agent/mod.rs`.

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test agent::provider::tests`
Expected: PASS (5).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agent/provider.rs src-tauri/src/agent/mod.rs
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: add provider request builder and response parser"
```

---

## Task 6: Run-mode gating

**Files:**
- Modify: `src-tauri/src/agent/mod.rs`

- [ ] **Step 1: Write the failing test**

In `agent/mod.rs`:

```rust
pub mod provider;
pub mod tools;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunMode { Plan, Ask, Autopilot }

impl Default for RunMode {
    fn default() -> Self { RunMode::Ask }
}

/// Decision for a tool call under a run mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Run immediately.
    Auto,
    /// Ask the user first.
    Approve,
    /// Refuse; return a not-permitted result to the model.
    Block,
}

/// Gate a tool by its class and the active run mode. A2A tools are treated as
/// mutating (`is_mutating = true`).
pub fn gate(mode: RunMode, is_mutating: bool) -> Gate {
    match (mode, is_mutating) {
        (_, false) => Gate::Auto,
        (RunMode::Plan, true) => Gate::Block,
        (RunMode::Ask, true) => Gate::Approve,
        (RunMode::Autopilot, true) => Gate::Auto,
    }
}

#[cfg(test)]
mod gate_tests {
    use super::*;
    #[test]
    fn read_only_always_auto() {
        for m in [RunMode::Plan, RunMode::Ask, RunMode::Autopilot] {
            assert_eq!(gate(m, false), Gate::Auto);
        }
    }
    #[test]
    fn mutating_gated_by_mode() {
        assert_eq!(gate(RunMode::Plan, true), Gate::Block);
        assert_eq!(gate(RunMode::Ask, true), Gate::Approve);
        assert_eq!(gate(RunMode::Autopilot, true), Gate::Auto);
    }
    #[test]
    fn default_mode_is_ask() {
        assert_eq!(RunMode::default(), RunMode::Ask);
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test agent::gate_tests`
Expected: PASS (3).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agent/mod.rs
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: add run-mode tool gating"
```

---

## Task 7: A2A native client — card parsing + skill→tool derivation

**Files:**
- Create: `src-tauri/src/agent/a2a.rs`
- Modify: `src-tauri/src/agent/mod.rs` (add `pub mod a2a;`)
- Modify: `src-tauri/src/settings.rs` (add `A2aConnection` + field)

- [ ] **Step 1: Add settings type & field (with test)**

In `settings.rs`, add near the provider structs:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct A2aConnection {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub endpoint: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub enabled: bool,
    /// Skill ids explicitly disabled by the user.
    #[serde(default)]
    pub disabled_skills: Vec<String>,
}
```

In `AppSettings` struct add:

```rust
    #[serde(default)]
    pub a2a_connections: Vec<A2aConnection>,
    #[serde(default)]
    pub run_mode: crate::agent::RunMode,
```

In `AppSettings::default()` add:

```rust
            a2a_connections: Vec::new(),
            run_mode: crate::agent::RunMode::default(),
```

Add test in `settings.rs` tests module:

```rust
    #[test]
    fn a2a_connections_default_empty_and_roundtrip() {
        let s: AppSettings = serde_json::from_str("{}").unwrap();
        assert!(s.a2a_connections.is_empty());
        assert_eq!(s.run_mode, crate::agent::RunMode::Ask);
    }
```

- [ ] **Step 2: Write the failing A2A test**

In `a2a.rs`:

```rust
//! Native A2A: agent-card discovery, skill→tool derivation, JSON-RPC delegation.
use crate::settings::A2aConnection;
use serde_json::{json, Value};

/// A tool derived from an A2A skill. `tool_name` is namespaced `<conn>__<skill>`.
#[derive(Debug, Clone, PartialEq)]
pub struct A2aTool {
    pub tool_name: String,
    pub connection_id: String,
    pub endpoint: String,
    pub token: String,
    pub skill_id: String,
    pub description: String,
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect()
}

/// Derive callable tools from a connection's agent card, skipping disabled skills.
pub fn tools_from_card(conn: &A2aConnection, card: &Value) -> Vec<A2aTool> {
    let mut out = Vec::new();
    if let Some(skills) = card["skills"].as_array() {
        for skill in skills {
            let skill_id = skill["id"].as_str()
                .or_else(|| skill["name"].as_str()).unwrap_or("").to_string();
            if skill_id.is_empty() || conn.disabled_skills.iter().any(|d| d == &skill_id) {
                continue;
            }
            out.push(A2aTool {
                tool_name: format!("{}__{}", sanitize(&conn.id), sanitize(&skill_id)),
                connection_id: conn.id.clone(),
                endpoint: conn.endpoint.clone(),
                token: conn.token.clone(),
                skill_id: skill_id.clone(),
                description: skill["description"].as_str().unwrap_or("").to_string(),
            });
        }
    }
    out
}

/// OpenAI tool definition for an A2A tool. The single argument is a task string.
pub fn a2a_tool_definition(tool: &A2aTool) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.tool_name,
            "description": format!("Delegate to A2A skill '{}'. {}", tool.skill_id, tool.description),
            "parameters": {
                "type": "object",
                "properties": {"task": {"type": "string", "description": "Task text for the agent"}},
                "required": ["task"],
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> A2aConnection {
        A2aConnection { id: "hub-1".into(), name: "Hub".into(),
            endpoint: "https://hub.test".into(), token: "t".into(),
            enabled: true, disabled_skills: vec!["hidden".into()] }
    }

    #[test]
    fn derives_namespaced_tools_and_skips_disabled() {
        let card = json!({"skills":[
            {"id":"search","description":"web search"},
            {"id":"hidden","description":"nope"}]});
        let tools = tools_from_card(&conn(), &card);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].tool_name, "hub_1__search");
        assert_eq!(tools[0].skill_id, "search");
    }

    #[test]
    fn tool_definition_has_task_param() {
        let card = json!({"skills":[{"id":"search","description":"d"}]});
        let tools = tools_from_card(&conn(), &card);
        let def = a2a_tool_definition(&tools[0]);
        assert_eq!(def["function"]["name"], "hub_1__search");
        assert_eq!(def["function"]["parameters"]["required"][0], "task");
    }
}
```

Add `pub mod a2a;` to `agent/mod.rs`.

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test agent::a2a::tests && cargo test settings::tests::a2a_connections_default_empty_and_roundtrip`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/agent/a2a.rs src-tauri/src/agent/mod.rs src-tauri/src/settings.rs
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: add a2a settings and skill-to-tool derivation"
```

---

## Task 8: A2A delegation HTTP + text extraction

**Files:**
- Modify: `src-tauri/src/agent/a2a.rs`

- [ ] **Step 1: Write the failing test (pure text extraction)**

Add to `a2a.rs`:

```rust
const TERMINAL: [&str; 5] = ["completed", "failed", "canceled", "rejected", "input-required"];

fn parts_text(parts: &Value) -> String {
    parts.as_array().map(|arr| arr.iter().filter_map(|p| {
        if let Some(t) = p["text"].as_str() { Some(t.to_string()) }
        else if !p["data"].is_null() { Some(p["data"].to_string()) }
        else { None }
    }).collect::<Vec<_>>().join("\n")).unwrap_or_default().trim().to_string()
}

/// Extract text from an A2A task result (status message, history, or artifacts).
pub fn extract_text(task: &Value) -> String {
    let s = parts_text(&task["status"]["message"]["parts"]);
    if !s.is_empty() { return s; }
    if let Some(hist) = task["history"].as_array() {
        for turn in hist.iter().rev() {
            let t = parts_text(&turn["parts"]);
            if !t.is_empty() { return t; }
        }
    }
    if let Some(arts) = task["artifacts"].as_array() {
        let joined: Vec<String> = arts.iter().map(|a| parts_text(&a["parts"]))
            .filter(|s| !s.is_empty()).collect();
        if !joined.is_empty() { return joined.join("\n"); }
    }
    String::new()
}

fn is_terminal(state: &str) -> bool { TERMINAL.contains(&state) }

#[cfg(test)]
mod delegate_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_status_message_text() {
        let task = json!({"status":{"message":{"parts":[{"text":"answer"}]}}});
        assert_eq!(extract_text(&task), "answer");
    }
    #[test]
    fn falls_back_to_artifacts() {
        let task = json!({"status":{"state":"completed"},
            "artifacts":[{"parts":[{"text":"from-artifact"}]}]});
        assert_eq!(extract_text(&task), "from-artifact");
    }
    #[test]
    fn terminal_states_detected() {
        assert!(is_terminal("completed"));
        assert!(!is_terminal("working"));
    }
}
```

- [ ] **Step 2: Add async delegate (compiles; covered by integration later)**

Add to `a2a.rs`:

```rust
fn normalize(endpoint: &str) -> String {
    endpoint.trim().trim_end_matches('/').to_string()
}

async fn post_rpc(client: &reqwest::Client, endpoint: &str, token: &str, body: Value)
    -> Result<Value, String> {
    let mut req = client.post(format!("{}/", normalize(endpoint))).json(&body);
    if !token.trim().is_empty() {
        req = req.header("authorization", format!("Bearer {}", token.trim()));
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let val: Value = resp.json().await.map_err(|e| e.to_string())?;
    if !val["error"].is_null() {
        return Err(val["error"]["message"].as_str().unwrap_or("A2A error").to_string());
    }
    Ok(val["result"].clone())
}

/// Delegate a task to an A2A endpoint; poll until terminal; return text.
pub async fn delegate(client: &reqwest::Client, tool: &A2aTool, task: &str)
    -> Result<String, String> {
    let params = json!({"message": {"role": "user",
        "messageId": format!("desktop-{}", tool.skill_id),
        "parts": [{"type": "text", "text": task}]},
        "skillId": tool.skill_id});
    let initial = post_rpc(client, &tool.endpoint, &tool.token, json!({
        "jsonrpc": "2.0", "id": "message-send-1", "method": "message/send",
        "params": params})).await?;
    let text = extract_text(&initial);
    let state = initial["status"]["state"].as_str().unwrap_or("");
    if !text.is_empty() && (state.is_empty() || is_terminal(state)) { return Ok(text); }
    let task_id = initial["id"].as_str().unwrap_or("").to_string();
    if task_id.is_empty() {
        return Err("A2A task returned no id or text".into());
    }
    for attempt in 0..120 {
        let got = post_rpc(client, &tool.endpoint, &tool.token, json!({
            "jsonrpc": "2.0", "id": format!("tasks-get-{attempt}"),
            "method": "tasks/get", "params": {"id": task_id}})).await?;
        let st = got["status"]["state"].as_str().unwrap_or("").to_string();
        if is_terminal(&st) {
            let t = extract_text(&got);
            if st == "completed" { return Ok(t); }
            return Err(if t.is_empty() { format!("A2A ended in {st}") } else { t });
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err("A2A task did not reach terminal state".into())
}

/// Fetch an agent card from the well-known discovery paths.
pub async fn fetch_card(client: &reqwest::Client, endpoint: &str, token: &str)
    -> Result<Value, String> {
    let base = normalize(endpoint);
    let mut last = String::new();
    for path in ["/.well-known/agent-card.json", "/.well-known/agent.json"] {
        let mut req = client.get(format!("{base}{path}"));
        if !token.trim().is_empty() {
            req = req.header("authorization", format!("Bearer {}", token.trim()));
        }
        match req.send().await {
            Ok(r) if r.status().is_success() => {
                return r.json::<Value>().await.map_err(|e| e.to_string());
            }
            Ok(r) => last = format!("HTTP {}", r.status()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("A2A discovery failed: {last}"))
}
```

- [ ] **Step 3: Run tests + check**

Run: `cd src-tauri && cargo test agent::a2a && cargo check`
Expected: PASS (extraction tests) and clean compile.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/agent/a2a.rs
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: add a2a delegation and card fetch"
```

---

## Task 9: Agent loop with approval channel

**Files:**
- Modify: `src-tauri/src/agent/mod.rs`

- [ ] **Step 1: Write the failing test (loop with fake provider)**

Add to `agent/mod.rs`. The loop is generic over an async provider call so tests inject a scripted responder:

```rust
use serde_json::{json, Value};
use std::collections::HashSet;

/// One message in the running conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConvMsg { pub role: String, pub content: String }

/// Outcome of a completed run.
#[derive(Debug, Clone, PartialEq)]
pub struct RunResult { pub reply: String, pub tools_used: Vec<String> }

/// A decision source for gated tools. In production this waits on the UI; in
/// tests it returns a fixed decision.
pub trait Approver {
    fn approve(&mut self, tool: &str, args: &Value) -> ApprovalDecision;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision { Approve, Deny, AllowSession }

/// Run the agent loop. `provider_call` maps the message list to a parsed turn.
/// `run_tool` executes a resolved tool (local or A2A) and returns a result text.
pub fn run_loop<P, T, A>(
    mode: RunMode,
    max_iterations: usize,
    mut messages: Vec<ConvMsg>,
    is_mutating: impl Fn(&str) -> bool,
    mut provider_call: P,
    mut run_tool: T,
    approver: &mut A,
) -> RunResult
where
    P: FnMut(&[ConvMsg]) -> provider::ParsedTurn,
    T: FnMut(&str, &Value) -> Result<String, String>,
    A: Approver,
{
    let mut tools_used = Vec::new();
    let mut session_allow: HashSet<String> = HashSet::new();
    for _ in 0..max_iterations {
        let turn = provider_call(&messages);
        if turn.tool_calls.is_empty() {
            return RunResult { reply: turn.text, tools_used };
        }
        for call in &turn.tool_calls {
            let mutating = is_mutating(&call.name);
            let decision = match gate(mode, mutating) {
                Gate::Auto => ApprovalDecision::Approve,
                Gate::Block => {
                    messages.push(ConvMsg { role: "tool".into(),
                        content: format!("{}: not permitted in plan mode", call.name) });
                    continue;
                }
                Gate::Approve => {
                    if session_allow.contains(&call.name) {
                        ApprovalDecision::Approve
                    } else {
                        approver.approve(&call.name, &call.args)
                    }
                }
            };
            match decision {
                ApprovalDecision::Deny => {
                    messages.push(ConvMsg { role: "tool".into(),
                        content: format!("{}: denied by user", call.name) });
                }
                ApprovalDecision::AllowSession | ApprovalDecision::Approve => {
                    if decision == ApprovalDecision::AllowSession {
                        session_allow.insert(call.name.clone());
                    }
                    tools_used.push(call.name.clone());
                    let result = run_tool(&call.name, &call.args)
                        .unwrap_or_else(|e| format!("error: {e}"));
                    messages.push(ConvMsg { role: "tool".into(), content: result });
                }
            }
        }
    }
    RunResult { reply: "stopped: max iterations reached".into(), tools_used }
}

#[cfg(test)]
mod loop_tests {
    use super::*;
    use super::provider::{ParsedTurn, ToolCall};

    struct AutoApprove;
    impl Approver for AutoApprove {
        fn approve(&mut self, _t: &str, _a: &Value) -> ApprovalDecision { ApprovalDecision::Approve }
    }
    struct DenyAll;
    impl Approver for DenyAll {
        fn approve(&mut self, _t: &str, _a: &Value) -> ApprovalDecision { ApprovalDecision::Deny }
    }

    fn scripted(turns: Vec<ParsedTurn>) -> impl FnMut(&[ConvMsg]) -> ParsedTurn {
        let mut i = 0;
        move |_m| { let t = turns[i.min(turns.len()-1)].clone(); i += 1; t }
    }

    #[test]
    fn returns_text_when_no_tool_calls() {
        let mut approver = AutoApprove;
        let r = run_loop(RunMode::Ask, 5, vec![],
            |_| false,
            scripted(vec![ParsedTurn { text: "done".into(), tool_calls: vec![] }]),
            |_, _| Ok(String::new()), &mut approver);
        assert_eq!(r.reply, "done");
    }

    #[test]
    fn executes_read_only_tool_then_finishes() {
        let mut approver = AutoApprove;
        let turns = vec![
            ParsedTurn { text: String::new(), tool_calls: vec![
                ToolCall { id: "1".into(), name: "read".into(), args: json!({"path":"x"}) }] },
            ParsedTurn { text: "answer".into(), tool_calls: vec![] },
        ];
        let r = run_loop(RunMode::Plan, 5, vec![],
            |_| false,
            scripted(turns),
            |name, _| Ok(format!("ran {name}")), &mut approver);
        assert_eq!(r.reply, "answer");
        assert_eq!(r.tools_used, vec!["read"]);
    }

    #[test]
    fn plan_mode_blocks_mutating_tool() {
        let mut approver = AutoApprove;
        let mut ran = false;
        let turns = vec![
            ParsedTurn { text: String::new(), tool_calls: vec![
                ToolCall { id: "1".into(), name: "write".into(), args: json!({}) }] },
            ParsedTurn { text: "fin".into(), tool_calls: vec![] },
        ];
        let r = run_loop(RunMode::Plan, 5, vec![],
            |n| n == "write",
            scripted(turns),
            |_, _| { ran = true; Ok(String::new()) }, &mut approver);
        assert_eq!(r.reply, "fin");
        assert!(!ran, "mutating tool must not run in plan mode");
        assert!(r.tools_used.is_empty());
    }

    #[test]
    fn ask_mode_denied_tool_does_not_run() {
        let mut approver = DenyAll;
        let mut ran = false;
        let turns = vec![
            ParsedTurn { text: String::new(), tool_calls: vec![
                ToolCall { id: "1".into(), name: "bash".into(), args: json!({}) }] },
            ParsedTurn { text: "end".into(), tool_calls: vec![] },
        ];
        let r = run_loop(RunMode::Ask, 5, vec![],
            |n| n == "bash",
            scripted(turns),
            |_, _| { ran = true; Ok(String::new()) }, &mut approver);
        assert!(!ran);
        assert_eq!(r.reply, "end");
    }

    #[test]
    fn stops_at_max_iterations() {
        let mut approver = AutoApprove;
        let r = run_loop(RunMode::Autopilot, 2, vec![],
            |_| false,
            scripted(vec![ParsedTurn { text: String::new(), tool_calls: vec![
                ToolCall { id: "1".into(), name: "read".into(), args: json!({}) }] }]),
            |_, _| Ok("x".into()), &mut approver);
        assert!(r.reply.contains("max iterations"));
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test agent::loop_tests`
Expected: PASS (5).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agent/mod.rs
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: add agent loop with run-mode gating and approval"
```

---

## Task 10: Wire commands + events into main.rs

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add async provider HTTP + agent commands**

Add to `main.rs` (after existing commands). This wires the pieces into a real run using a channel-based approver bridged to the UI. Register a shared `reqwest::Client` and a pending-approvals map.

```rust
use std::collections::HashMap;
use tokio::sync::oneshot;

#[derive(Default)]
struct ApprovalRegistry(Mutex<HashMap<String, oneshot::Sender<agent::ApprovalDecision>>>);

#[derive(Clone, serde::Serialize)]
struct ToolCallEvent { call_id: String, tool: String, args: serde_json::Value }

#[tauri::command]
async fn approve_tool(
    registry: State<'_, ApprovalRegistry>,
    call_id: String,
    decision: String,
) -> Result<(), String> {
    let sender = registry.0.lock().map_err(|e| e.to_string())?.remove(&call_id);
    if let Some(tx) = sender {
        let d = match decision.as_str() {
            "approve" => agent::ApprovalDecision::Approve,
            "allow_session" => agent::ApprovalDecision::AllowSession,
            _ => agent::ApprovalDecision::Deny,
        };
        let _ = tx.send(d);
    }
    Ok(())
}

async fn call_provider(
    client: &reqwest::Client,
    config: &settings::ProviderConfig,
    system: &str,
    messages: &[agent::provider::Msg],
    tools: &[serde_json::Value],
) -> Result<agent::provider::ParsedTurn, String> {
    let req = agent::provider::build_request(config, system, messages, tools);
    let mut builder = client.post(&req.url).json(&req.body);
    for (k, v) in &req.headers { builder = builder.header(k, v); }
    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("provider HTTP {status}"));
    }
    Ok(agent::provider::parse_response(req.shape, &body))
}
```

Because the loop in Task 9 is synchronous but provider/A2A calls are async, implement the real run as an async function that manually mirrors the loop (reusing `gate`, `classify`, `execute`, `a2a`), emitting `agent://token`, `agent://tool-call`, `agent://tool-result`, `agent://done`, `agent://error`, and awaiting approvals via oneshot. Add:

```rust
#[tauri::command]
async fn agent_run(
    app: tauri::AppHandle,
    registry: State<'_, ApprovalRegistry>,
    message: String,
    mode: agent::RunMode,
) -> Result<(), String> {
    let settings = load_desktop_settings();
    let client = reqwest::Client::new();
    let configs = settings.effective_provider_configs();
    let config = configs.get(settings.active_provider).cloned().unwrap_or_default();

    // Build tool set: local + enabled A2A.
    let mut tool_defs = agent::tools::tool_definitions();
    let mut a2a_tools: Vec<agent::a2a::A2aTool> = Vec::new();
    for conn in settings.a2a_connections.iter().filter(|c| c.enabled) {
        if let Ok(card) = agent::a2a::fetch_card(&client, &conn.endpoint, &conn.token).await {
            for t in agent::a2a::tools_from_card(conn, &card) {
                tool_defs.push(agent::a2a::a2a_tool_definition(&t));
                a2a_tools.push(t);
            }
        }
    }

    let system = "You are Omni Agent, a helpful desktop AI agent with local tools.";
    let mut msgs = vec![agent::provider::Msg { role: "user".into(), content: message }];
    let max = settings.ai_max_tool_iterations.max(1);
    let mut session_allow: std::collections::HashSet<String> = Default::default();
    let mut counter: u64 = 0;

    for _ in 0..max {
        let turn = match call_provider(&client, &config, system, &msgs, &tool_defs).await {
            Ok(t) => t,
            Err(e) => { let _ = app.emit("agent://error", e.clone()); return Err(e); }
        };
        if turn.tool_calls.is_empty() {
            let _ = app.emit("agent://done", turn.text.clone());
            return Ok(());
        }
        for call in &turn.tool_calls {
            counter += 1;
            let call_id = format!("call-{counter}");
            let is_a2a = a2a_tools.iter().any(|t| t.tool_name == call.name);
            let mutating = is_a2a || agent::tools::classify(&call.name) == agent::tools::ToolClass::Mutating;
            let _ = app.emit("agent://tool-call", ToolCallEvent {
                call_id: call_id.clone(), tool: call.name.clone(), args: call.args.clone() });

            let decision = match agent::gate(mode, mutating) {
                agent::Gate::Auto => agent::ApprovalDecision::Approve,
                agent::Gate::Block => {
                    msgs.push(agent::provider::Msg { role: "user".into(),
                        content: format!("[tool {} blocked in plan mode]", call.name) });
                    continue;
                }
                agent::Gate::Approve => {
                    if session_allow.contains(&call.name) {
                        agent::ApprovalDecision::Approve
                    } else {
                        let (tx, rx) = oneshot::channel();
                        registry.0.lock().unwrap().insert(call_id.clone(), tx);
                        let _ = app.emit("agent://tool-approval-request", ToolCallEvent {
                            call_id: call_id.clone(), tool: call.name.clone(), args: call.args.clone() });
                        rx.await.unwrap_or(agent::ApprovalDecision::Deny)
                    }
                }
            };

            let result = match decision {
                agent::ApprovalDecision::Deny =>
                    format!("[tool {} denied by user]", call.name),
                d => {
                    if d == agent::ApprovalDecision::AllowSession {
                        session_allow.insert(call.name.clone());
                    }
                    if is_a2a {
                        let tool = a2a_tools.iter().find(|t| t.tool_name == call.name).unwrap();
                        let task = call.args["task"].as_str().unwrap_or("").to_string();
                        agent::a2a::delegate(&client, tool, &task).await
                            .unwrap_or_else(|e| format!("error: {e}"))
                    } else {
                        agent::tools::execute(&call.name, &call.args)
                            .unwrap_or_else(|e| format!("error: {e}"))
                    }
                }
            };
            let _ = app.emit("agent://tool-result", serde_json::json!({
                "call_id": call_id, "tool": call.name, "result": result }));
            msgs.push(agent::provider::Msg { role: "user".into(),
                content: format!("[tool {} result]\n{result}", call.name) });
        }
    }
    let _ = app.emit("agent://done", "stopped: max iterations reached".to_string());
    Ok(())
}
```

Register in the builder: add `.manage(ApprovalRegistry::default())` and add `agent_run, approve_tool` to `generate_handler!`. Add `use tauri::async_runtime` is not needed; Tauri v2 provides an async runtime for async commands. Remove the obsolete `set_window_geometry` `ai_mode` launcher width branch is out of scope — leave as is.

- [ ] **Step 2: Verify it compiles + existing tests pass**

Run: `cd src-tauri && cargo check && cargo test`
Expected: PASS (all Rust tests green).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/main.rs
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: wire native agent_run and approve_tool commands"
```

---

## Task 11: Frontend types — trim launcher, add agent/A2A

**Files:**
- Modify: `src/types/app.ts`

- [ ] **Step 1: Replace launcher types**

Remove `QueryResult`, `AiResponse`, `AiSessionInfo`, `PluginInfo`, `RuntimeDependency`, `RuntimeProgressEvent`, `SkillInfo`. Keep provider types. Add:

```ts
export type RunMode = "plan" | "ask" | "autopilot";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  tools_used?: string[];
  isStreaming?: boolean;
}

export interface A2aConnection {
  id: string;
  name: string;
  endpoint: string;
  token: string;
  enabled: boolean;
  disabled_skills: string[];
}

export interface ToolCallEvent {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
}
```

Update `AppSettings`: remove `max_results`, `background_url`; add:

```ts
  a2a_connections: A2aConnection[];
  run_mode: RunMode;
```

Keep `ConversationTurn` as an alias of `ChatMessage` for any transitional imports:

```ts
export type ConversationTurn = ChatMessage;
```

- [ ] **Step 2: Type-check**

Run: `npm run build` (expect errors in files that will be deleted next — that's fine; the goal here is the types file is valid TS).
Better: `npx tsc --noEmit src/types/app.ts` is not standalone; instead proceed to Task 12 which deletes consumers, then type-check.

- [ ] **Step 3: Commit**

```bash
git add src/types/app.ts
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "refactor: trim types to agent + a2a"
```

---

## Task 12: Delete launcher heritage files

**Files (delete):**
- `src/hooks/useSearch.ts`, `useFavorites.ts`, `useAiSessions.ts`, `useInputHistory.ts`, `useSubmitAndExecute.ts`, `useAiQuery.ts`, `useAppBootstrap.ts`, `useLayoutGeometry.ts`, `useGlobalKeyboard.ts`
- `src/components/SearchBar.tsx`, `LauncherResults.tsx`, `ResultList.tsx`, `ResultList.test.tsx`, `FavoritesList.tsx`, `PluginManager.tsx`, `SkillManager.tsx`, `CheatSheetModal.tsx`, `SessionPicker.tsx`, `QueuedPromptBubble.tsx`, `LauncherBody.tsx`, `AiTopBar.tsx`, `ExportToast.tsx`, `ResizeGrip.tsx`, `FormattedSubtitle.tsx`
- `src/launcherConfig.ts`, `src/features/launcher/` (whole dir), `src/features/ai/toolIcon.ts`
- `src/App.test.tsx` (will be rewritten), `src/skill-demo.tsx`, `src/ops-make.test.ts` if launcher-specific

- [ ] **Step 1: Delete**

```bash
cd /c/Users/jzhu/repos/omni-agent-desktop
git rm src/hooks/useSearch.ts src/hooks/useFavorites.ts src/hooks/useAiSessions.ts \
  src/hooks/useInputHistory.ts src/hooks/useSubmitAndExecute.ts src/hooks/useAiQuery.ts \
  src/hooks/useAppBootstrap.ts src/hooks/useLayoutGeometry.ts src/hooks/useGlobalKeyboard.ts \
  src/components/SearchBar.tsx src/components/LauncherResults.tsx src/components/ResultList.tsx \
  src/components/ResultList.test.tsx src/components/FavoritesList.tsx src/components/PluginManager.tsx \
  src/components/SkillManager.tsx src/components/CheatSheetModal.tsx src/components/SessionPicker.tsx \
  src/components/QueuedPromptBubble.tsx src/components/LauncherBody.tsx src/components/AiTopBar.tsx \
  src/components/ExportToast.tsx src/components/ResizeGrip.tsx src/components/FormattedSubtitle.tsx \
  src/launcherConfig.ts src/skill-demo.tsx
git rm -r src/features
```

(Skip any path that doesn't exist; adjust after `git status`.)

- [ ] **Step 2: Commit**

```bash
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "refactor: remove launcher heritage"
```

---

## Task 13: `useAgent` hook

**Files:**
- Create: `src/hooks/useAgent.ts`
- Create: `src/hooks/useAgent.test.ts`

- [ ] **Step 1: Write the failing test**

`src/hooks/useAgent.test.ts` (mock `../lib/runtime`):

```ts
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAgent } from "./useAgent";

const handlers: Record<string, (e: any) => void> = {};
vi.mock("../lib/runtime", () => ({
  invoke: vi.fn(async () => undefined),
  listen: vi.fn(async (name: string, cb: (e: any) => void) => {
    handlers[name] = cb;
    return () => { delete handlers[name]; };
  }),
}));
import { invoke } from "../lib/runtime";

function emit(name: string, payload: any) {
  handlers[name]?.({ payload });
}

describe("useAgent", () => {
  beforeEach(() => { for (const k of Object.keys(handlers)) delete handlers[k]; vi.clearAllMocks(); });

  it("sends a message and appends a user turn", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => { await result.current.send("hello", "ask"); });
    expect(invoke).toHaveBeenCalledWith("agent_run", { message: "hello", mode: "ask" });
    expect(result.current.messages[0]).toMatchObject({ role: "user", content: "hello" });
  });

  it("appends assistant reply on agent://done", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => { await result.current.send("hi", "ask"); });
    await act(async () => { emit("agent://done", "the answer"); });
    await waitFor(() => {
      const last = result.current.messages.at(-1);
      expect(last).toMatchObject({ role: "assistant", content: "the answer" });
    });
  });

  it("surfaces approval requests and clears them on decision", async () => {
    const { result } = renderHook(() => useAgent());
    await act(async () => { await result.current.send("go", "ask"); });
    await act(async () => { emit("agent://tool-approval-request",
      { call_id: "c1", tool: "bash", args: { command: "ls" } }); });
    expect(result.current.pendingApproval).toMatchObject({ call_id: "c1", tool: "bash" });
    await act(async () => { await result.current.decide("approve"); });
    expect(invoke).toHaveBeenCalledWith("approve_tool", { call_id: "c1", decision: "approve" });
    expect(result.current.pendingApproval).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useAgent.test.ts`
Expected: FAIL ("useAgent is not a function").

- [ ] **Step 3: Implement**

`src/hooks/useAgent.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "../lib/runtime";
import type { ChatMessage, RunMode, ToolCallEvent } from "../types/app";

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ToolCallEvent | null>(null);
  const cleanupRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    let active = true;
    (async () => {
      const un: Array<() => void> = [];
      un.push(await listen<string>("agent://done", (e) => {
        setMessages((prev) => [...prev, { role: "assistant", content: e.payload }]);
        setLoading(false);
        setPendingApproval(null);
      }));
      un.push(await listen<string>("agent://error", (e) => {
        setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${e.payload}` }]);
        setLoading(false);
        setPendingApproval(null);
      }));
      un.push(await listen<ToolCallEvent>("agent://tool-approval-request", (e) => {
        setPendingApproval(e.payload);
      }));
      if (active) cleanupRef.current = un; else un.forEach((f) => f());
    })();
    return () => { active = false; cleanupRef.current.forEach((f) => f()); };
  }, []);

  const send = useCallback(async (text: string, mode: RunMode) => {
    if (!text.trim()) return;
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);
    await invoke("agent_run", { message: text, mode });
  }, []);

  const decide = useCallback(async (decision: "approve" | "deny" | "allow_session") => {
    const call = pendingApproval;
    setPendingApproval(null);
    if (call) await invoke("approve_tool", { call_id: call.call_id, decision });
  }, [pendingApproval]);

  return { messages, loading, pendingApproval, send, decide };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useAgent.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useAgent.ts src/hooks/useAgent.test.ts
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: add useAgent hook"
```

---

## Task 14: Composer + ToolApprovalPrompt + ChatPane

**Files:**
- Create: `src/components/Composer.tsx`, `src/components/ToolApprovalPrompt.tsx`, `src/components/ChatPane.tsx`
- Create: `src/components/Composer.test.tsx`

- [ ] **Step 1: Write the failing test**

`src/components/Composer.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import Composer from "./Composer";

describe("Composer", () => {
  it("submits text with the selected mode", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} disabled={false} />);
    await userEvent.selectOptions(screen.getByLabelText(/mode/i), "autopilot");
    await userEvent.type(screen.getByRole("textbox"), "do it");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith("do it", "autopilot");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/Composer.test.tsx`
Expected: FAIL (no Composer).

- [ ] **Step 3: Implement the three components**

`src/components/Composer.tsx`:

```tsx
import { useState } from "react";
import type { RunMode } from "../types/app";

export default function Composer({ onSend, disabled }: {
  onSend: (text: string, mode: RunMode) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<RunMode>("ask");
  const submit = () => { if (text.trim()) { onSend(text, mode); setText(""); } };
  return (
    <div className="composer">
      <label>
        Mode
        <select value={mode} onChange={(e) => setMode(e.target.value as RunMode)}>
          <option value="plan">Plan</option>
          <option value="ask">Ask</option>
          <option value="autopilot">Autopilot</option>
        </select>
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        placeholder="Ask the agent…"
      />
      <button onClick={submit} disabled={disabled}>Send</button>
    </div>
  );
}
```

`src/components/ToolApprovalPrompt.tsx`:

```tsx
import type { ToolCallEvent } from "../types/app";

export default function ToolApprovalPrompt({ call, onDecide }: {
  call: ToolCallEvent;
  onDecide: (d: "approve" | "deny" | "allow_session") => void;
}) {
  return (
    <div className="approval" role="dialog" aria-label="Tool approval">
      <p><strong>{call.tool}</strong> wants to run:</p>
      <pre>{JSON.stringify(call.args, null, 2)}</pre>
      <button onClick={() => onDecide("approve")}>Approve</button>
      <button onClick={() => onDecide("allow_session")}>Always this session</button>
      <button onClick={() => onDecide("deny")}>Deny</button>
    </div>
  );
}
```

`src/components/ChatPane.tsx`:

```tsx
import type { ChatMessage } from "../types/app";

export default function ChatPane({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="chat-pane">
      {messages.map((m, i) => (
        <div key={i} className={`bubble ${m.role}`}>
          <div className="role">{m.role}</div>
          <div className="content">{m.content}</div>
          {m.tools_used?.length ? <div className="tools">tools: {m.tools_used.join(", ")}</div> : null}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/Composer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/Composer.tsx src/components/ToolApprovalPrompt.tsx src/components/ChatPane.tsx src/components/Composer.test.tsx
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: add chat pane, composer, and approval prompt"
```

---

## Task 15: Rewrite App.tsx + App.test.tsx

**Files:**
- Modify: `src/App.tsx`
- Create: `src/App.test.tsx`

- [ ] **Step 1: Write the failing test**

`src/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import App from "./App";

vi.mock("./lib/runtime", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_settings") return {
      active_provider: "custom-provider",
      provider_configs: {}, a2a_connections: [], run_mode: "ask",
      ai_base_url: "", ai_model: "", ai_api_key: "",
      ai_timeout_secs: 120, ai_max_tool_iterations: 10,
      ai_max_retry_attempts: 3, ai_retry_base_delay_ms: 2000,
      ai_loop_detector_enabled: true, theme: "system", hotkey: "Ctrl+Shift+O",
      backend_url: "",
    };
    return undefined;
  }),
  listen: vi.fn(async () => () => {}),
}));

describe("App", () => {
  it("renders the composer and no launcher search", async () => {
    render(<App />);
    expect(await screen.findByPlaceholderText(/ask the agent/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL (App still references deleted launcher hooks).

- [ ] **Step 3: Rewrite App.tsx**

```tsx
import { useEffect, useRef, useState } from "react";
import { invoke } from "./lib/runtime";
import ChatPane from "./components/ChatPane";
import Composer from "./components/Composer";
import ToolApprovalPrompt from "./components/ToolApprovalPrompt";
import SettingsWindow from "./components/SettingsWindow";
import GlobalKeyframes from "./components/GlobalKeyframes";
import AppShell from "./components/AppShell";
import { useAgent } from "./hooks/useAgent";
import { useTheme } from "./hooks/useTheme";
import type { AppSettings } from "./types/app";

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const { resolvedTheme, setTheme } = useTheme();
  const { messages, loading, pendingApproval, send, decide } = useAgent();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setSettings(s);
      if (s?.theme) setTheme(s.theme);
    }).catch(() => {});
  }, [setTheme]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  return (
    <>
      <GlobalKeyframes />
      <AppShell resolvedTheme={resolvedTheme} backgroundUrl="" isCompactMode={false} isAiMode={true}>
        <div className="agent-root">
          <button className="settings-toggle" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? "Close settings" : "Settings"}
          </button>
          {showSettings ? (
            <SettingsWindow onClose={() => setShowSettings(false)} />
          ) : (
            <div className="agent-main" ref={scrollRef}>
              <ChatPane messages={messages} />
              {pendingApproval ? (
                <ToolApprovalPrompt call={pendingApproval} onDecide={decide} />
              ) : null}
              <Composer onSend={send} disabled={loading} />
            </div>
          )}
        </div>
      </AppShell>
    </>
  );
}
```

(If `SettingsWindow` requires different props, adapt the call in Task 16.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/App.test.tsx
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "refactor: rewrite App as pure agent shell"
```

---

## Task 16: A2A settings tab

**Files:**
- Modify: `src/components/SettingsWindow.tsx`
- Modify: `src/components/SettingsWindow.test.tsx`

- [ ] **Step 1: Read current SettingsWindow to match its props/shape**

Run: `git show HEAD:src/components/SettingsWindow.tsx | head -80` (inspect before editing).

- [ ] **Step 2: Write the failing test**

Add to `SettingsWindow.test.tsx` a test that, after switching to an "A2A" tab, an "Add connection" button appears and adding one shows an endpoint input. (Exact queries depend on current markup; write against the tab label `A2A Agents` and button `Add connection`.)

```tsx
it("adds an A2A connection", async () => {
  render(<SettingsWindow onClose={() => {}} />);
  await userEvent.click(await screen.findByRole("tab", { name: /a2a/i }));
  await userEvent.click(screen.getByRole("button", { name: /add connection/i }));
  expect(screen.getByLabelText(/endpoint/i)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/components/SettingsWindow.test.tsx -t "adds an A2A connection"`
Expected: FAIL.

- [ ] **Step 4: Implement the A2A tab**

Add a tab that renders `settings.a2a_connections`, an "Add connection" button that appends `{ id: crypto.randomUUID(), name: "", endpoint: "", token: "", enabled: true, disabled_skills: [] }`, editable endpoint/token/name/enabled fields, a remove button, and a "Discover" button calling `invoke("a2a_discover_card", { connectionId })` (add that command in Task 17). Persist through the existing save path (which calls `save_settings_cmd`).

- [ ] **Step 5: Run to verify it passes + full frontend suite**

Run: `npx vitest run`
Expected: PASS (all frontend tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsWindow.tsx src/components/SettingsWindow.test.tsx
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: add a2a agents settings tab"
```

---

## Task 17: A2A discovery command + persistence of conversation

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add discovery command**

```rust
#[tauri::command]
async fn a2a_discover_card(connection_id: String) -> Result<serde_json::Value, String> {
    let settings = load_desktop_settings();
    let conn = settings.a2a_connections.iter().find(|c| c.id == connection_id)
        .ok_or_else(|| "connection not found".to_string())?;
    let client = reqwest::Client::new();
    agent::a2a::fetch_card(&client, &conn.endpoint, &conn.token).await
}
```

Register `a2a_discover_card` in `generate_handler!`.

- [ ] **Step 2: Add conversation persistence commands**

```rust
fn conversation_path() -> PathBuf { config_dir().join("conversation.json") }

#[tauri::command]
fn load_conversation() -> serde_json::Value {
    std::fs::read_to_string(conversation_path()).ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!([]))
}

#[tauri::command]
fn save_conversation(messages: serde_json::Value) -> Result<(), String> {
    settings::atomic_write(&conversation_path(), &messages.to_string())
}
```

Register both. In `useAgent`, load on mount via `invoke("load_conversation")` and save on every `messages` change via `invoke("save_conversation", { messages })`. (Add a small effect; keep it out of the approval test path by guarding empty writes.)

- [ ] **Step 3: Verify compile + tests**

Run: `cd src-tauri && cargo check && cargo test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/main.rs
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "feat: add a2a discovery and conversation persistence commands"
```

---

## Task 18: Update Tauri capabilities allowlist

**Files:**
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Ensure new commands are permitted**

Confirm the capability file allows `core:event:default` (for `emit`/`listen`) and that custom commands are invocable (Tauri v2 allows invoking app commands by default unless restricted). If the file enumerates permissions, add event permissions. Inspect:

Run: `cat src-tauri/capabilities/default.json`

Add any missing event/window permissions needed by `agent://*` events.

- [ ] **Step 2: Commit (if changed)**

```bash
git add src-tauri/capabilities/default.json
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "chore: allow agent event permissions"
```

---

## Task 19: Full validation

- [ ] **Step 1: Rust**

Run: `cd src-tauri && cargo test`
Expected: all pass.

- [ ] **Step 2: Frontend**

Run: `npm run build && npx vitest run`
Expected: type-check clean, all tests pass.

- [ ] **Step 3: App boots**

Run: `npm run tauri dev` (smoke: window opens, composer visible, settings opens). Terminate after visual confirmation.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "test: validate pure agent build"
```

---

## Notes / Deferred

- **GitHub Copilot device-flow auth** (multi-provider spec §GitHub Copilot Authentication) is deferred: Custom Provider and Azure Foundry work via API key; Copilot can be driven by pasting a token into the Custom Provider profile with the Copilot endpoint until native device flow lands. Track as a follow-on task.
- **Streaming token deltas** (`agent://token`): the loop currently emits full replies via `agent://done`; per-token streaming is a later enhancement (requires provider streaming/SSE).
- **Loop detector** (`ai_loop_detector_enabled`) is carried in settings but not yet enforced in the native loop; add if repeated identical tool calls appear.
