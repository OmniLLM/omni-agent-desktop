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
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// FNV-1a 32-bit hash rendered as 8 hex chars. Deterministic and dependency-free.
fn short_hash(s: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// Build a callable tool name within the 64-char limit that providers
/// (OpenAI/GitHub Copilot) impose on function names. Uses a short connection
/// prefix plus the sanitized skill id; when that overflows, it truncates the
/// skill part and appends a hash so distinct skills never collide.
fn make_tool_name(conn_id: &str, skill_id: &str) -> String {
    let prefix: String = sanitize(conn_id).chars().take(8).collect();
    let skill = sanitize(skill_id);
    let name = format!("{prefix}__{skill}");
    if name.len() <= 64 {
        return name;
    }
    let hash = short_hash(skill_id); // 8 chars
    // budget = 64 - prefix - "__"(2) - "_"(1) - hash(8)
    let head_budget = 64 - prefix.len() - 2 - 1 - 8;
    let skill_head: String = skill.chars().take(head_budget).collect();
    format!("{prefix}__{skill_head}_{hash}")
}

/// Derive callable tools from a connection's agent card, skipping disabled skills.
pub fn tools_from_card(conn: &A2aConnection, card: &Value) -> Vec<A2aTool> {
    let mut out = Vec::new();
    if let Some(skills) = card["skills"].as_array() {
        for skill in skills {
            let skill_id = skill["id"]
                .as_str()
                .or_else(|| skill["name"].as_str())
                .unwrap_or("")
                .to_string();
            if skill_id.is_empty() || conn.disabled_skills.iter().any(|d| d == &skill_id) {
                continue;
            }
            out.push(A2aTool {
                tool_name: make_tool_name(&conn.id, &skill_id),
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

const TERMINAL: [&str; 5] = ["completed", "failed", "canceled", "rejected", "input-required"];

fn parts_text(parts: &Value) -> String {
    parts
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    if let Some(t) = p["text"].as_str() {
                        Some(t.to_string())
                    } else if !p["data"].is_null() {
                        Some(p["data"].to_string())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Extract text from an A2A task result (status message, history, or artifacts).
pub fn extract_text(task: &Value) -> String {
    let s = parts_text(&task["status"]["message"]["parts"]);
    if !s.is_empty() {
        return s;
    }
    if let Some(hist) = task["history"].as_array() {
        for turn in hist.iter().rev() {
            let t = parts_text(&turn["parts"]);
            if !t.is_empty() {
                return t;
            }
        }
    }
    if let Some(arts) = task["artifacts"].as_array() {
        let joined: Vec<String> = arts
            .iter()
            .map(|a| parts_text(&a["parts"]))
            .filter(|s| !s.is_empty())
            .collect();
        if !joined.is_empty() {
            return joined.join("\n");
        }
    }
    String::new()
}

fn is_terminal(state: &str) -> bool {
    TERMINAL.contains(&state)
}

fn normalize(endpoint: &str) -> String {
    endpoint.trim().trim_end_matches('/').to_string()
}

async fn post_rpc(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    body: Value,
) -> Result<Value, String> {
    let mut req = client.post(format!("{}/", normalize(endpoint))).json(&body);
    if !token.trim().is_empty() {
        req = req.header("authorization", format!("Bearer {}", token.trim()));
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let val: Value = resp.json().await.map_err(|e| e.to_string())?;
    if !val["error"].is_null() {
        return Err(val["error"]["message"]
            .as_str()
            .unwrap_or("A2A error")
            .to_string());
    }
    Ok(val["result"].clone())
}

/// Delegate a task to an A2A endpoint; poll until terminal; return text.
pub async fn delegate(
    client: &reqwest::Client,
    tool: &A2aTool,
    task: &str,
) -> Result<String, String> {
    let params = json!({"message": {"role": "user",
        "messageId": format!("desktop-{}", tool.skill_id),
        "parts": [{"type": "text", "text": task}]},
        "skillId": tool.skill_id});
    let initial = post_rpc(
        client,
        &tool.endpoint,
        &tool.token,
        json!({
            "jsonrpc": "2.0", "id": "message-send-1", "method": "message/send",
            "params": params}),
    )
    .await?;
    let text = extract_text(&initial);
    let state = initial["status"]["state"].as_str().unwrap_or("");
    if !text.is_empty() && (state.is_empty() || is_terminal(state)) {
        return Ok(text);
    }
    let task_id = initial["id"].as_str().unwrap_or("").to_string();
    if task_id.is_empty() {
        return Err("A2A task returned no id or text".into());
    }
    // Poll until the task reaches a terminal state, bounded by elapsed wall time
    // rather than a fixed attempt count so long-running skills (e.g. a cloud
    // inventory scan across hundreds of projects) have time to finish.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
    let mut attempt: u64 = 0;
    while std::time::Instant::now() < deadline {
        let got = post_rpc(
            client,
            &tool.endpoint,
            &tool.token,
            json!({
                "jsonrpc": "2.0", "id": format!("tasks-get-{attempt}"),
                "method": "tasks/get", "params": {"id": task_id}}),
        )
        .await?;
        let st = got["status"]["state"].as_str().unwrap_or("").to_string();
        if is_terminal(&st) {
            let t = extract_text(&got);
            if st == "completed" {
                return Ok(t);
            }
            return Err(if t.is_empty() {
                format!("A2A ended in {st}")
            } else {
                t
            });
        }
        attempt += 1;
        // Gentle backoff: 500ms early, easing to 2s for long-running tasks.
        let delay_ms = if attempt < 20 { 500 } else { 2000 };
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }
    Err("A2A task did not reach terminal state within 10 minutes".into())
}

/// Fetch an agent card from the well-known discovery paths.
pub async fn fetch_card(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
) -> Result<Value, String> {
    let base = normalize(endpoint);
    if base.is_empty() {
        return Err("A2A endpoint is required".into());
    }
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
            Ok(r) => last = format!("{path}: HTTP {}", r.status()),
            Err(e) => last = format!("{path}: {}", describe_reqwest_error(&e)),
        }
    }
    Err(format!("A2A discovery failed: {last}"))
}

/// Produce an actionable message from a reqwest error, walking its source chain
/// so opaque wrappers like "builder error" surface their real cause.
fn describe_reqwest_error(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut parts = vec![e.to_string()];
    let mut src = e.source();
    while let Some(s) = src {
        let msg = s.to_string();
        if !parts.contains(&msg) {
            parts.push(msg);
        }
        src = s.source();
    }
    parts.join(": ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> A2aConnection {
        A2aConnection {
            id: "hub-1".into(),
            name: "Hub".into(),
            endpoint: "https://hub.test".into(),
            token: "t".into(),
            enabled: true,
            disabled_skills: vec!["hidden".into()],
        }
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

    #[test]
    fn tool_names_stay_within_64_chars() {
        // A real UUID connection id plus a long skill id would overflow the
        // provider's 64-char function-name limit without truncation.
        let uuid = "332cd3c0-d77a-4ea9-94e1-5c342c33d402";
        let long = "omnilauncher.skill:slack_markdown_formatter_extra_long_name";
        let name = make_tool_name(uuid, long);
        assert!(name.len() <= 64, "name too long: {} ({})", name, name.len());
    }

    #[test]
    fn truncated_tool_names_are_unique_per_skill() {
        let uuid = "332cd3c0-d77a-4ea9-94e1-5c342c33d402";
        let a = make_tool_name(uuid, "omnilauncher.skill:aws_very_long_suffix_number_one");
        let b = make_tool_name(uuid, "omnilauncher.skill:aws_very_long_suffix_number_two");
        assert_ne!(a, b);
        assert!(a.len() <= 64 && b.len() <= 64);
    }

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
