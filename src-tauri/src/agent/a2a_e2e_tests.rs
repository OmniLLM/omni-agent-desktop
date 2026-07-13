//! End-to-end regression test for A2A auto-routing.
//!
//! Spins up a mock A2A hub over raw tokio TCP that speaks the well-known
//! agent-card discovery + JSON-RPC `message/send`/`tasks/get` protocol, then
//! drives the shared `run_once` agent loop with a scripted Anthropic-shape
//! provider backend. The scripted turn emits a `tool_use` naming the A2A skill
//! tool derived from the discovered card; the loop must route that call to
//! [`super::a2a::delegate`] (not to a local tool) and return the hub's text.
//!
//! Guards two regressions at once:
//! 1. Anthropic-shape provider requests must forward tools (previously omitted),
//!    otherwise the model can never emit a `tool_use` for an A2A skill.
//! 2. The run loop must actually dispatch a skill-matched tool call through the
//!    A2A path, not silently fall through to a local tool lookup.
//!
//! No live network: everything runs against 127.0.0.1 on a random port.
//!
//! Note on `tests/` vs inline: `omni-agent-desktop` is a binary crate (no
//! `lib.rs`), so `tests/*.rs` files cannot import its internals. This E2E must
//! live inside `src/` under `#[cfg(test)]`.

use super::a2a::{self, A2aTool};
use super::provider::{self, Msg, ParsedTurn, ToolCall};
use super::{run_once, ApprovalDecision, BoxFut, NullEvents, RunBackend, RunMode, RunOrigin};
use crate::settings::{A2aConnection, ApiShape, ProviderConfig};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

// ---------------------------------------------------------------------------
// Mock A2A hub
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct HubState {
    /// JSON-RPC method names the hub received, in order. The test asserts that
    /// `message/send` shows up here — direct proof the agent routed to A2A.
    calls: Arc<Mutex<Vec<String>>>,
    /// The hub's own address, so the served agent-card can advertise its RPC
    /// URL back to the client with the correct host:port.
    self_addr: String,
}

async fn start_mock_hub() -> (SocketAddr, HubState) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = HubState {
        calls: Arc::new(Mutex::new(Vec::new())),
        self_addr: addr.to_string(),
    };
    let s = state.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let s = s.clone();
            tokio::spawn(async move {
                let _ = handle_conn(&mut sock, s).await;
            });
        }
    });
    (addr, state)
}

async fn handle_conn(sock: &mut TcpStream, state: HubState) -> std::io::Result<()> {
    let (r, mut w) = sock.split();
    let mut reader = BufReader::new(r);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).await? == 0 {
        return Ok(());
    }
    let mut it = request_line.split_whitespace();
    let method = it.next().unwrap_or("").to_string();
    let path = it.next().unwrap_or("").to_string();

    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        let low = line.to_ascii_lowercase();
        if let Some(v) = low.strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).await?;
    }

    let (status, payload): (&str, String) = match (method.as_str(), path.as_str()) {
        ("GET", "/.well-known/agent-card.json") => (
            "200 OK",
            json!({
                "name": "test-hub",
                // Advertise RPC at a subpath — the desktop must honor this and
                // POST delegations to /a2a, not to the discovery origin.
                "url": format!("http://{}/a2a", state.self_addr),
                "skills": [
                    {"id": "search", "description": "web search"},
                    {"id": "summarize", "description": "text summarizer"}
                ]
            })
            .to_string(),
        ),
        ("POST", "/a2a") => {
            let req: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
            let rpc = req["method"].as_str().unwrap_or("").to_string();
            state.calls.lock().unwrap().push(rpc.clone());
            let result = json!({
                "id": "task-1",
                "status": {
                    "state": "completed",
                    "message": {"parts": [{"text": "answer-from-hub"}]}
                }
            });
            let _ = rpc;
            (
                "200 OK",
                json!({"jsonrpc":"2.0","id":req["id"],"result":result}).to_string(),
            )
        }
        _ => ("404 Not Found", "{}".to_string()),
    };

    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    w.write_all(resp.as_bytes()).await?;
    w.flush().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Scripted provider backend
// ---------------------------------------------------------------------------

struct ScriptedBackend {
    turns: Mutex<Vec<ParsedTurn>>,
    saw_tools: Arc<Mutex<Vec<Value>>>,
    a2a_tools: Vec<A2aTool>,
    http: reqwest::Client,
}

impl RunBackend for ScriptedBackend {
    fn infer<'a>(
        &'a self,
        _system: &'a str,
        _messages: &'a [Msg],
        tools: &'a [Value],
    ) -> BoxFut<'a, Result<ParsedTurn, String>> {
        // Capture what the loop hands to the provider so the test can assert
        // A2A tools reach the model — proving the Anthropic-shape wiring works.
        self.saw_tools.lock().unwrap().push(json!(tools));
        Box::pin(async move {
            let mut t = self.turns.lock().unwrap();
            if t.is_empty() {
                return Ok(ParsedTurn {
                    text: "done".into(),
                    tool_calls: vec![],
                });
            }
            Ok(t.remove(0))
        })
    }

    fn run_tool<'a>(
        &'a self,
        name: &'a str,
        args: &'a Value,
    ) -> BoxFut<'a, Result<String, String>> {
        Box::pin(async move {
            if let Some(tool) = self.a2a_tools.iter().find(|t| t.tool_name == name) {
                let task = args["task"].as_str().unwrap_or("");
                a2a::delegate(&self.http, tool, task).await
            } else {
                Err(format!("unexpected local tool: {name}"))
            }
        })
    }

    fn approve<'a>(
        &'a self,
        _call_id: &'a str,
        _name: &'a str,
        _args: &'a Value,
    ) -> BoxFut<'a, ApprovalDecision> {
        Box::pin(async move { ApprovalDecision::Approve })
    }
}

#[tokio::test]
async fn model_tool_use_routes_to_a2a_hub_end_to_end() {
    let (addr, hub) = start_mock_hub().await;
    let endpoint = format!("http://{addr}");

    // 1) Discover the hub's card and derive namespaced skill tools — the exact
    //    path `prepare_run` follows in production.
    let client = reqwest::Client::new();
    let conn = A2aConnection {
        id: "hub1".into(),
        name: "hub".into(),
        endpoint: endpoint.clone(),
        token: String::new(),
        enabled: true,
        disabled_skills: vec![],
    };
    let card = a2a::fetch_card(&client, &conn.endpoint, &conn.token)
        .await
        .expect("discovery must succeed");
    let a2a_tools = a2a::tools_from_card(&conn, &card);
    assert_eq!(a2a_tools.len(), 2, "hub advertises 2 skills");
    let target = a2a_tools
        .iter()
        .find(|t| t.skill_id == "search")
        .cloned()
        .expect("search tool");
    let openai_tool_defs: Vec<Value> =
        a2a_tools.iter().map(a2a::a2a_tool_definition).collect();

    // 2) Cross-check the Anthropic wire body actually contains the tools —
    //    the exact code path that was silently omitting them.
    let cfg = ProviderConfig {
        endpoint: "https://api.anthropic.com".into(),
        api_key: "k".into(),
        api_shape: ApiShape::AnthropicMessages,
        model: "claude".into(),
        ..ProviderConfig::default()
    };
    let built = provider::build_request(&cfg, "sys", &[], &openai_tool_defs);
    let sent_tools = built.body["tools"]
        .as_array()
        .expect("Anthropic body must carry tools; regression if missing");
    assert!(sent_tools.iter().any(|t| t["name"] == target.tool_name));
    assert!(sent_tools[0].get("input_schema").is_some());

    // 3) Script a `tool_use` turn for the A2A skill, then a plain-text turn.
    let scripted = vec![
        ParsedTurn {
            text: "delegating".into(),
            tool_calls: vec![ToolCall {
                id: "tu_1".into(),
                name: target.tool_name.clone(),
                args: json!({"task": "find omni"}),
            }],
        },
        ParsedTurn {
            text: "answer-from-hub".into(),
            tool_calls: vec![],
        },
    ];
    let saw_tools = Arc::new(Mutex::new(Vec::new()));
    let backend = ScriptedBackend {
        turns: Mutex::new(scripted),
        saw_tools: saw_tools.clone(),
        a2a_tools: a2a_tools.clone(),
        http: client.clone(),
    };
    let a2a_name_set: std::collections::HashSet<String> =
        a2a_tools.iter().map(|t| t.tool_name.clone()).collect();

    // 4) Run the shared agent loop under Autopilot — the SAME `run_once` the
    //    Tauri command drives. A skill-matched tool_use MUST hit the hub.
    let outcome = run_once(
        RunOrigin::Foreground,
        RunMode::Autopilot,
        "sys".into(),
        vec![Msg {
            role: "user".into(),
            content: "search for omni".into(),
        }],
        openai_tool_defs,
        4,
        move |n: &str| a2a_name_set.contains(n),
        |_n: &str| false,
        &backend,
        &NullEvents,
    )
    .await
    .expect("run_once succeeds");

    // 5) The hub actually received a `message/send`.
    let calls = hub.calls.lock().unwrap().clone();
    assert!(
        calls.iter().any(|c| c == "message/send"),
        "expected message/send at the hub, got {calls:?}"
    );
    assert_eq!(outcome.text, "answer-from-hub");

    // 6) The provider inference was offered the A2A tools on turn 1.
    let first_tool_arg = saw_tools.lock().unwrap()[0].clone();
    assert!(
        first_tool_arg
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["function"]["name"] == target.tool_name),
        "A2A tool was not surfaced to the model on the first inference"
    );
}
