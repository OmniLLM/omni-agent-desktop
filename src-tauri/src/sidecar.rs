//! Bridge to the `agent-core` Node sidecar over stdio JSON-RPC.
//!
//! Wire format: one JSON object per line.
//! - request:  { "id": u64, "method": "...", "params": ... }
//! - response: { "id": u64, "result": ... } | { "id": u64, "error": { code, message, data? } }
//! - event:    { "event": "...", "data": ... }   (no id)
//!
//! Rust re-emits every event through the Tauri webview under the same name
//! the frontend already listens for (e.g. `agent://thought`, `scheduler://status`).
//!
//! Callers:
//!   let sc = Sidecar::spawn(app.handle())?;
//!   let out: Value = sc.call("settings.get", json!({})).await?;
//!   sc.forward_events(app.handle());   // fire-and-forget re-emit task

use std::collections::HashMap;
use std::io;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

/// Sidecar binary basename resolved from `sidecar/agent-core` via Tauri's
/// externalBin mechanism (Cargo builds prepend the target triple at package
/// time; in dev we look for the file next to the built Rust binary).
const SIDECAR_BIN: &str = "agent-core";

#[derive(Debug, Serialize)]
struct RpcRequest<'a> {
    id: u64,
    method: &'a str,
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RpcInbound {
    Response {
        id: u64,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        error: Option<RpcError>,
    },
    Event {
        event: String,
        data: Value,
    },
}

#[derive(Debug, Deserialize, Clone)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "rpc error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

pub struct Sidecar {
    next_id: AtomicU64,
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    /// Consumed exactly once by `forward_events`.
    events_rx: Mutex<Option<mpsc::UnboundedReceiver<(String, Value)>>>,
    _child: Child,
}

impl Sidecar {
    /// Spawn the sidecar binary. Resolves it in this order:
    ///   1. `OMNI_AGENT_CORE_BIN` env var (dev override).
    ///   2. `<exe_dir>/agent-core[.exe]` (packaged: Tauri externalBin drop).
    ///   3. `<exe_dir>/../../../agent-core/dist/index.js` invoked with `node` (dev fallback).
    pub fn spawn(app: &AppHandle) -> io::Result<Arc<Self>> {
        let mut cmd = build_command(app)?;
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn()?;
        let pid = child.id().unwrap_or(0);
        log::info!("agent-core sidecar spawned (pid={pid})");
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events_tx, events_rx) = mpsc::unbounded_channel::<(String, Value)>();

        // Reader task: parses one JSON message per line, routes responses to
        // their oneshot and events to the broadcast queue.
        let pending_r = pending.clone();
        let events_tx_r = events_tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break, // sidecar exited
                    Ok(_) => {}
                    Err(e) => {
                        log::error!("sidecar stdout read failed: {e}");
                        break;
                    }
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<RpcInbound>(trimmed) {
                    Ok(RpcInbound::Response { id, result, error }) => {
                        let mut map = pending_r.lock().await;
                        if let Some(tx) = map.remove(&id) {
                            let payload = match (result, error) {
                                (_, Some(err)) => Err(err),
                                (Some(v), None) => Ok(v),
                                (None, None) => Ok(Value::Null),
                            };
                            let _ = tx.send(payload);
                        } else {
                            log::warn!("sidecar reply for unknown id {id}");
                        }
                    }
                    Ok(RpcInbound::Event { event, data }) => {
                        if events_tx_r.send((event, data)).is_err() {
                            // no consumer yet; drop silently
                        }
                    }
                    Err(e) => {
                        log::warn!("sidecar produced non-JSON line: {e}: {trimmed}");
                    }
                }
            }
            log::info!("sidecar reader task exiting");
        });

        Ok(Arc::new(Self {
            next_id: AtomicU64::new(1),
            stdin: Mutex::new(stdin),
            pending,
            events_rx: Mutex::new(Some(events_rx)),
            _child: child,
        }))
    }

    /// Fire-and-forget: drain the event queue and re-emit every event through
    /// the Tauri webview under its original name. Call once at startup.
    pub fn forward_events(self: &Arc<Self>, app: AppHandle) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut rx = match this.events_rx.lock().await.take() {
                Some(rx) => rx,
                None => return, // already forwarding
            };
            while let Some((event, data)) = rx.recv().await {
                if let Err(e) = app.emit(&event, &data) {
                    log::warn!("failed to emit {event} to webview: {e}");
                }
            }
        });
    }

    /// Call an RPC method and await the response.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let req = RpcRequest { id, method, params };
        let line = match serde_json::to_string(&req) {
            Ok(s) => s,
            Err(e) => {
                self.pending.lock().await.remove(&id);
                return Err(RpcError { code: -32700, message: e.to_string(), data: None });
            }
        };
        {
            let mut stdin = self.stdin.lock().await;
            if let Err(e) = stdin.write_all(line.as_bytes()).await {
                self.pending.lock().await.remove(&id);
                return Err(RpcError { code: -32001, message: format!("stdin write: {e}"), data: None });
            }
            if let Err(e) = stdin.write_all(b"\n").await {
                self.pending.lock().await.remove(&id);
                return Err(RpcError { code: -32001, message: format!("stdin write: {e}"), data: None });
            }
            let _ = stdin.flush().await;
        }
        match rx.await {
            Ok(payload) => payload,
            Err(_) => Err(RpcError {
                code: -32002,
                message: "sidecar dropped before responding".into(),
                data: None,
            }),
        }
    }
}

fn build_command(app: &AppHandle) -> io::Result<Command> {
    // 1. env override
    if let Ok(explicit) = std::env::var("OMNI_AGENT_CORE_BIN") {
        return Ok(Command::new(explicit));
    }

    let exe_dir = app
        .path()
        .resource_dir()
        .ok()
        .or_else(|| std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())))
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    // 2. packaged externalBin sitting next to the main exe
    let bin_name = if cfg!(windows) { format!("{SIDECAR_BIN}.exe") } else { SIDECAR_BIN.to_string() };
    let packaged = exe_dir.join(&bin_name);
    if packaged.exists() {
        return Ok(Command::new(packaged));
    }

    // 3. dev fallback: bun <repo>/agent-core/src/index.ts
    let mut walker = exe_dir.clone();
    for _ in 0..6 {
        let candidate = walker.join("agent-core").join("src").join("index.ts");
        if candidate.exists() {
            let mut cmd = Command::new("bun");
            cmd.arg(candidate);
            return Ok(cmd);
        }
        if !walker.pop() {
            break;
        }
    }

    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "agent-core sidecar not found. Set OMNI_AGENT_CORE_BIN, place {bin_name} next to the app, or run `make sidecar` (requires Bun)."
        ),
    ))
}

/// Convenience: JSON literal → typed call. Reserved for phase-2+ helpers.
#[allow(dead_code)]
pub async fn call_json<T: serde::de::DeserializeOwned>(
    sc: &Sidecar,
    method: &str,
    params: Value,
) -> Result<T, String> {
    let v = sc.call(method, params).await.map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| format!("decode {method} result: {e}"))
}

/// Round-trip smoke test used by main.rs at startup — swallow errors, just log.
pub async fn handshake(sc: &Sidecar) {
    match sc.call("hello", json!({})).await {
        Ok(v) => log::info!("sidecar hello: {v}"),
        Err(e) => log::error!("sidecar hello failed: {e}"),
    }
}
