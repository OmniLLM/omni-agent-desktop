//! End-to-end harness: drive the real agent core (provider + A2A + tools + gate)
//! against the live omnillm provider and A2A hub, using the desktop's saved
//! settings. Auto-approves mutating/A2A tools so it runs non-interactively.
//!
//! Run: cargo run --example e2e -- "how many VM in alibaba now"

#[path = "../src/settings.rs"]
mod settings;
#[path = "../src/agent/mod.rs"]
mod agent;

use std::collections::HashSet;

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn call_provider(
    client: &reqwest::Client,
    config: &settings::ProviderConfig,
    system: &str,
    messages: &[agent::provider::Msg],
    tools: &[serde_json::Value],
) -> Result<agent::provider::ParsedTurn, String> {
    let req = agent::provider::build_request(config, system, messages, tools);
    let mut b = client.post(&req.url).json(&req.body);
    for (k, v) in &req.headers {
        b = b.header(k, v);
    }
    let resp = b.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("provider HTTP {status}: {}", body));
    }
    Ok(agent::provider::parse_response(req.shape, &body))
}

#[tokio::main]
async fn main() {
    let query = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "how many VM in alibaba now".to_string());

    // Load the same settings the desktop app uses.
    let home = dirs::home_dir().unwrap();
    let path = home.join(".config/omni-agent-desktop/settings.json");
    let text = std::fs::read_to_string(&path).expect("read settings");
    let s: settings::AppSettings = serde_json::from_str(&text).expect("parse settings");
    let s = s.migrated();
    let configs = s.effective_provider_configs();
    let config = configs.get(s.active_provider).cloned().unwrap_or_default();
    println!("[e2e] provider endpoint={} model={} shape={:?}", config.endpoint, config.model, config.api_shape);

    let client = http_client();

    // Build tool set: local + enabled A2A (mirrors main.rs agent_run).
    let mut tool_defs = agent::tools::tool_definitions();
    let mut a2a_tools: Vec<agent::a2a::A2aTool> = Vec::new();
    for conn in s.a2a_connections.iter().filter(|c| c.enabled) {
        match agent::a2a::fetch_card(&client, &conn.endpoint, &conn.token).await {
            Ok(card) => {
                let tools = agent::a2a::tools_from_card(conn, &card);
                println!("[e2e] A2A '{}' -> {} skills", conn.name, tools.len());
                for t in tools {
                    tool_defs.push(agent::a2a::a2a_tool_definition(&t));
                    a2a_tools.push(t);
                }
            }
            Err(e) => println!("[e2e] A2A '{}' discovery failed: {e}", conn.name),
        }
    }
    println!("[e2e] total tools sent to model: {}", tool_defs.len());
    // Report the longest tool name (OpenAI rejects names > 64 chars).
    let longest = tool_defs
        .iter()
        .filter_map(|d| d["function"]["name"].as_str())
        .max_by_key(|n| n.len())
        .unwrap_or("");
    println!("[e2e] longest tool name = {} chars: {}", longest.len(), longest);

    let system = "You are Omni Agent, a helpful desktop AI agent with local tools and A2A skills. Use the alibaba skill to answer cloud questions.";
    let mut msgs = vec![agent::provider::Msg { role: "user".into(), content: query.clone() }];
    let max = s.ai_max_tool_iterations.max(1);
    let mut session_allow: HashSet<String> = Default::default();
    // Ask mode mirrors the app default. A2A tools are non-mutating (auto-run);
    // only local file/shell tools would prompt (auto-approved here for CI).
    let mode = agent::RunMode::Ask;

    println!("\n[e2e] >>> query: {query}\n");

    for iter in 0..max {
        let turn = match call_provider(&client, &config, system, &msgs, &tool_defs).await {
            Ok(t) => t,
            Err(e) => {
                println!("[e2e] PROVIDER ERROR: {e}");
                std::process::exit(1);
            }
        };
        if turn.tool_calls.is_empty() {
            println!("\n[e2e] ===== FINAL ANSWER (iter {iter}) =====\n{}\n", turn.text);
            println!("[e2e] SUCCESS");
            return;
        }
        if !turn.text.trim().is_empty() {
            println!("[e2e] 💭 thought: {}", turn.text.trim());
        }
        for call in &turn.tool_calls {
            let is_a2a = a2a_tools.iter().any(|t| t.tool_name == call.name);
            // Mirror main.rs: A2A is non-mutating (auto-run).
            let mutating = !is_a2a
                && agent::tools::classify(&call.name) == agent::tools::ToolClass::Mutating;
            let decision = match agent::gate(mode, mutating) {
                agent::Gate::Auto => agent::ApprovalDecision::Approve,
                agent::Gate::Block => {
                    println!("[e2e] tool {} blocked in plan mode", call.name);
                    continue;
                }
                // In this harness we auto-approve prompts (no interactive UI).
                agent::Gate::Approve => agent::ApprovalDecision::Approve,
            };
            let _ = decision;
            let _ = session_allow.insert(call.name.clone());
            println!("[e2e] ⚡ action: {} args={}", call.name, call.args);
            let result = if is_a2a {
                let tool = a2a_tools.iter().find(|t| t.tool_name == call.name).unwrap();
                let task = call.args["task"].as_str().unwrap_or("").to_string();
                agent::a2a::delegate(&client, tool, &task)
                    .await
                    .unwrap_or_else(|e| format!("error: {e}"))
            } else {
                agent::tools::execute(&call.name, &call.args)
                    .unwrap_or_else(|e| format!("error: {e}"))
            };
            let preview: String = result.chars().take(500).collect();
            println!("[e2e] ↳ result: {preview}");
            msgs.push(agent::provider::Msg {
                role: "user".into(),
                content: format!("[tool {} result]\n{result}", call.name),
            });
        }
    }
    println!("[e2e] stopped: max iterations reached");
}
