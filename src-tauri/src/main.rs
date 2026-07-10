#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod settings;

use base64::Engine;
use settings::AppSettings;
use simplelog::{ColorChoice, ConfigBuilder, LevelFilter, TermLogger, TerminalMode, WriteLogger};
use std::collections::HashMap;
use std::{fs, io::Read, path::PathBuf, sync::{Arc, Mutex}};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio::sync::oneshot;

fn config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("omni-agent-desktop")
}

fn legacy_omnilauncher_config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("omnilauncher")
}

fn settings_path() -> PathBuf {
    let dir = config_dir();
    let _ = fs::create_dir_all(&dir);
    dir.join("settings.json")
}

fn conversation_path() -> PathBuf {
    let dir = config_dir();
    let _ = fs::create_dir_all(&dir);
    dir.join("conversation.json")
}

fn window_pos_path() -> PathBuf {
    let dir = config_dir();
    let _ = fs::create_dir_all(&dir);
    dir.join("window-pos.json")
}

fn debug_log_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".omni-agent-desktop")
        .join("desktop.log")
}

#[derive(Clone)]
struct ShortcutSlot(Arc<Mutex<Option<Shortcut>>>);

fn load_desktop_settings() -> AppSettings {
    settings::load_settings(
        &settings_path(),
        &legacy_omnilauncher_config_dir().join("settings.json"),
    )
}

fn init_logging(debug: bool) {
    if debug {
        let path = debug_log_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(file) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = WriteLogger::init(
                LevelFilter::Trace,
                ConfigBuilder::new().set_time_format_rfc3339().build(),
                file,
            );
            return;
        }
    }
    let _ = TermLogger::init(
        LevelFilter::Info,
        ConfigBuilder::new().build(),
        TerminalMode::Stderr,
        ColorChoice::Never,
    );
}

fn parse_shortcut(spec: &str) -> Option<Shortcut> {
    let parts: Vec<&str> = spec
        .split('+')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    let (key_token, mod_tokens) = parts.split_last()?;
    let mut mods = Modifiers::empty();
    for token in mod_tokens {
        match token.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "shift" => mods |= Modifiers::SHIFT,
            "alt" | "option" => mods |= Modifiers::ALT,
            "cmd" | "command" | "super" | "meta" | "win" => mods |= Modifiers::SUPER,
            _ => return None,
        }
    }
    let key = parse_key_code(key_token)?;
    Some(Shortcut::new((!mods.is_empty()).then_some(mods), key))
}

fn parse_key_code(token: &str) -> Option<Code> {
    let t = token.trim();
    if t.len() == 1 {
        let c = t.chars().next()?.to_ascii_uppercase();
        return match c {
            'A' => Some(Code::KeyA), 'B' => Some(Code::KeyB), 'C' => Some(Code::KeyC),
            'D' => Some(Code::KeyD), 'E' => Some(Code::KeyE), 'F' => Some(Code::KeyF),
            'G' => Some(Code::KeyG), 'H' => Some(Code::KeyH), 'I' => Some(Code::KeyI),
            'J' => Some(Code::KeyJ), 'K' => Some(Code::KeyK), 'L' => Some(Code::KeyL),
            'M' => Some(Code::KeyM), 'N' => Some(Code::KeyN), 'O' => Some(Code::KeyO),
            'P' => Some(Code::KeyP), 'Q' => Some(Code::KeyQ), 'R' => Some(Code::KeyR),
            'S' => Some(Code::KeyS), 'T' => Some(Code::KeyT), 'U' => Some(Code::KeyU),
            'V' => Some(Code::KeyV), 'W' => Some(Code::KeyW), 'X' => Some(Code::KeyX),
            'Y' => Some(Code::KeyY), 'Z' => Some(Code::KeyZ),
            '0' => Some(Code::Digit0), '1' => Some(Code::Digit1), '2' => Some(Code::Digit2),
            '3' => Some(Code::Digit3), '4' => Some(Code::Digit4), '5' => Some(Code::Digit5),
            '6' => Some(Code::Digit6), '7' => Some(Code::Digit7), '8' => Some(Code::Digit8),
            '9' => Some(Code::Digit9), _ => None,
        };
    }
    match t.to_ascii_lowercase().as_str() {
        "space" => Some(Code::Space),
        "enter" | "return" => Some(Code::Enter),
        "escape" | "esc" => Some(Code::Escape),
        "tab" => Some(Code::Tab),
        "backspace" => Some(Code::Backspace),
        "f1" => Some(Code::F1), "f2" => Some(Code::F2), "f3" => Some(Code::F3),
        "f4" => Some(Code::F4), "f5" => Some(Code::F5), "f6" => Some(Code::F6),
        "f7" => Some(Code::F7), "f8" => Some(Code::F8), "f9" => Some(Code::F9),
        "f10" => Some(Code::F10), "f11" => Some(Code::F11), "f12" => Some(Code::F12),
        _ => None,
    }
}

fn register_shortcut(app: &tauri::AppHandle, slot: &ShortcutSlot, shortcut: Shortcut) -> Result<(), String> {
    if let Some(previous) = *slot.0.lock().map_err(|e| e.to_string())? {
        let _ = app.global_shortcut().unregister(previous);
    }

    let window = app.get_webview_window("main").ok_or_else(|| "main window not found".to_string())?;
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if let ShortcutState::Pressed = event.state() {
                let visible = window.is_visible().unwrap_or(false)
                    && !window.is_minimized().unwrap_or(false);
                if visible {
                    let _ = window.hide();
                } else {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("omnilauncher://shown", String::new());
                }
            }
        })
        .map_err(|e| e.to_string())?;
    *slot.0.lock().map_err(|e| e.to_string())? = Some(shortcut);
    Ok(())
}

#[tauri::command]
fn get_settings() -> AppSettings {
    load_desktop_settings()
}

#[tauri::command]
fn save_settings_cmd(settings: AppSettings) -> Result<AppSettings, String> {
    settings::save_settings(&settings_path(), settings, false)
}

#[tauri::command]
fn set_hotkey_cmd(app: tauri::AppHandle, slot: State<'_, ShortcutSlot>, settings: AppSettings) -> Result<AppSettings, String> {
    let shortcut = parse_shortcut(&settings.hotkey).ok_or_else(|| format!("Invalid hotkey: {}", settings.hotkey))?;
    register_shortcut(&app, &slot, shortcut)?;
    settings::save_settings(&settings_path(), settings, false)
}

#[tauri::command]
fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("frontend: {message}"),
        "warn" => log::warn!("frontend: {message}"),
        "debug" => log::debug!("frontend: {message}"),
        "trace" => log::trace!("frontend: {message}"),
        _ => log::info!("frontend: {message}"),
    }
}

#[tauri::command]
async fn save_window_position(x: i32, y: i32) -> Result<(), String> {
    let path = window_pos_path();
    let json = serde_json::json!({"x": x, "y": y});
    fs::write(path, json.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_window_geometry(
    window: tauri::WebviewWindow,
    height: f64,
    ai_mode: bool,
    panel_mode: Option<bool>,
) -> Result<bool, String> {
    let width = if ai_mode { 920.0 } else if panel_mode.unwrap_or(false) { 760.0 } else { 640.0 };
    window
        .set_size(tauri::Size::Physical(PhysicalSize::new(width as u32, height.max(56.0) as u32)))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn set_window_size_centered(
    window: tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<bool, String> {
    window
        .set_size(tauri::Size::Physical(PhysicalSize::new(width as u32, height as u32)))
        .map_err(|e| e.to_string())?;
    if let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? {
        let size = monitor.size();
        let pos = monitor.position();
        let x = pos.x + (size.width as i32 - width as i32) / 2;
        let y = pos.y + (size.height as i32 - height as i32) / 4;
        let _ = window.set_position(tauri::Position::Physical(PhysicalPosition::new(x, y)));
    }
    Ok(true)
}

#[tauri::command]
async fn capture_vision_screenshot(window: tauri::WebviewWindow) -> Result<String, String> {
    let _ = window.hide();
    std::thread::sleep(std::time::Duration::from_millis(250));
    let tmp_path = std::env::temp_dir().join("omni_agent_desktop_vision.png");
    let tmp_str = tmp_path.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        let ps = format!(
            r#"Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
Start-Process 'ms-screenclip:';
$deadline=(Get-Date).AddSeconds(60);
do {{ Start-Sleep -Milliseconds 300; $img=[System.Windows.Forms.Clipboard]::GetImage() }} while (-not $img -and (Get-Date) -lt $deadline);
if (-not $img) {{ exit 1 }};
$img.Save('{}');"#,
            tmp_str.replace('\'', "''")
        );
        let status = std::process::Command::new("powershell")
            .args(["-WindowStyle", "Hidden", "-NoProfile", "-Command", &ps])
            .status()
            .map_err(|e| format!("screenshot failed: {e}"))?;
        if !status.success() || !tmp_path.exists() {
            let _ = window.show();
            let _ = window.set_focus();
            return Err("Screenshot was cancelled or failed.".to_string());
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = std::process::Command::new("scrot")
            .args(["-s", "--overwrite", &tmp_str])
            .output()
            .map_err(|e| format!("scrot failed: {e}. Is scrot installed?"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let _ = window.show();
            let _ = window.set_focus();
            return Err(format!("scrot exited with error: {stderr}"));
        }
    }

    let mut file = fs::File::open(&tmp_path).map_err(|e| format!("Failed to open screenshot: {e}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read screenshot: {e}"))?;
    let _ = fs::remove_file(&tmp_path);
    let _ = window.show();
    let _ = window.set_focus();
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

// ---------------------------------------------------------------------------
// Agent runtime commands
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ApprovalRegistry(Mutex<HashMap<String, oneshot::Sender<agent::ApprovalDecision>>>);

#[derive(Clone, serde::Serialize)]
struct ToolCallEvent {
    call_id: String,
    tool: String,
    args: serde_json::Value,
}

#[tauri::command]
async fn approve_tool(
    registry: State<'_, ApprovalRegistry>,
    call_id: String,
    decision: String,
) -> Result<(), String> {
    let sender = registry
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&call_id);
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

/// Build the shared HTTP client. Proxy support is disabled: providers and A2A
/// endpoints are typically local (localhost/127.0.0.1) and must not be routed
/// through a corporate proxy, which is the usual cause of an opaque reqwest
/// "builder error" when HTTP(S)_PROXY is set in the environment.
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
    let mut builder = client.post(&req.url).json(&req.body);
    for (k, v) in &req.headers {
        builder = builder.header(k, v);
    }
    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = body["error"]["message"]
            .as_str()
            .map(|s| format!(": {s}"))
            .unwrap_or_default();
        return Err(format!("provider HTTP {status}{detail}"));
    }
    Ok(agent::provider::parse_response(req.shape, &body))
}

#[tauri::command]
async fn agent_run(
    app: tauri::AppHandle,
    registry: State<'_, ApprovalRegistry>,
    message: String,
    mode: agent::RunMode,
) -> Result<(), String> {
    let settings = load_desktop_settings();
    let client = http_client();
    let configs = settings.effective_provider_configs();
    let config = configs
        .get(settings.active_provider)
        .cloned()
        .unwrap_or_default();

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
    let mut msgs = vec![agent::provider::Msg {
        role: "user".into(),
        content: message,
    }];
    let max = settings.ai_max_tool_iterations.max(1);
    let mut session_allow: std::collections::HashSet<String> = Default::default();
    let mut counter: u64 = 0;

    for _ in 0..max {
        let turn = match call_provider(&client, &config, system, &msgs, &tool_defs).await {
            Ok(t) => t,
            Err(e) => {
                let _ = app.emit("agent://error", e.clone());
                return Err(e);
            }
        };
        if turn.tool_calls.is_empty() {
            let _ = app.emit("agent://done", turn.text.clone());
            return Ok(());
        }
        for call in &turn.tool_calls {
            counter += 1;
            let call_id = format!("call-{counter}");
            let is_a2a = a2a_tools.iter().any(|t| t.tool_name == call.name);
            let mutating = is_a2a
                || agent::tools::classify(&call.name) == agent::tools::ToolClass::Mutating;
            let _ = app.emit(
                "agent://tool-call",
                ToolCallEvent {
                    call_id: call_id.clone(),
                    tool: call.name.clone(),
                    args: call.args.clone(),
                },
            );

            let decision = match agent::gate(mode, mutating) {
                agent::Gate::Auto => agent::ApprovalDecision::Approve,
                agent::Gate::Block => {
                    msgs.push(agent::provider::Msg {
                        role: "user".into(),
                        content: format!("[tool {} blocked in plan mode]", call.name),
                    });
                    continue;
                }
                agent::Gate::Approve => {
                    if session_allow.contains(&call.name) {
                        agent::ApprovalDecision::Approve
                    } else {
                        let (tx, rx) = oneshot::channel();
                        if let Ok(mut map) = registry.0.lock() {
                            map.insert(call_id.clone(), tx);
                        }
                        let _ = app.emit(
                            "agent://tool-approval-request",
                            ToolCallEvent {
                                call_id: call_id.clone(),
                                tool: call.name.clone(),
                                args: call.args.clone(),
                            },
                        );
                        rx.await.unwrap_or(agent::ApprovalDecision::Deny)
                    }
                }
            };

            let result = match decision {
                agent::ApprovalDecision::Deny => format!("[tool {} denied by user]", call.name),
                d => {
                    if d == agent::ApprovalDecision::AllowSession {
                        session_allow.insert(call.name.clone());
                    }
                    if is_a2a {
                        let tool = a2a_tools
                            .iter()
                            .find(|t| t.tool_name == call.name)
                            .unwrap();
                        let task = call.args["task"].as_str().unwrap_or("").to_string();
                        agent::a2a::delegate(&client, tool, &task)
                            .await
                            .unwrap_or_else(|e| format!("error: {e}"))
                    } else {
                        agent::tools::execute(&call.name, &call.args)
                            .unwrap_or_else(|e| format!("error: {e}"))
                    }
                }
            };
            let _ = app.emit(
                "agent://tool-result",
                serde_json::json!({
                    "call_id": call_id, "tool": call.name, "result": result }),
            );
            msgs.push(agent::provider::Msg {
                role: "user".into(),
                content: format!("[tool {} result]\n{result}", call.name),
            });
        }
    }
    let _ = app.emit(
        "agent://done",
        "stopped: max iterations reached".to_string(),
    );
    Ok(())
}

#[tauri::command]
async fn a2a_discover_card(connection_id: String) -> Result<serde_json::Value, String> {
    let settings = load_desktop_settings();
    let conn = settings
        .a2a_connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| "connection not found".to_string())?;
    let client = http_client();
    agent::a2a::fetch_card(&client, &conn.endpoint, &conn.token).await
}

/// Discover models from a provider's `/models` endpoint. Accepts the common
/// `data[].id` (OpenAI-style) and `models[].name`/`models[].id` shapes. Auth is
/// sent as both Bearer and `x-api-key` so it works across OpenAI-compatible and
/// Anthropic-style gateways.
#[tauri::command]
async fn list_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let base = agent::provider::normalize_endpoint(&base_url);
    if base.is_empty() {
        return Err("Provider URL is required".into());
    }
    let client = http_client();
    let key = api_key.trim();
    let mut req = client.get(format!("{base}/models"));
    if !key.is_empty() {
        req = req
            .header("authorization", format!("Bearer {key}"))
            .header("x-api-key", key);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = body["error"]["message"]
            .as_str()
            .map(|s| format!(": {s}"))
            .unwrap_or_default();
        return Err(format!("HTTP {status}{detail}"));
    }

    let mut models: Vec<String> = Vec::new();
    let mut push = |v: &serde_json::Value| {
        if let Some(arr) = v.as_array() {
            for m in arr {
                let id = m["id"]
                    .as_str()
                    .or_else(|| m["name"].as_str())
                    .or_else(|| m.as_str());
                if let Some(id) = id {
                    if !id.is_empty() && !models.iter().any(|x| x == id) {
                        models.push(id.to_string());
                    }
                }
            }
        }
    };
    push(&body["data"]);
    push(&body["models"]);
    push(&body); // bare array response
    if models.is_empty() {
        return Err("No models found in provider response".into());
    }
    models.sort();
    Ok(models)
}

#[tauri::command]
fn load_conversation() -> serde_json::Value {
    std::fs::read_to_string(conversation_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!([]))
}

#[tauri::command]
fn save_conversation(messages: serde_json::Value) -> Result<(), String> {
    settings::atomic_write(&conversation_path(), &messages.to_string())
}

fn main() {
    let debug = std::env::args().any(|a| a == "--debug");
    init_logging(debug);
    let settings = load_desktop_settings();
    let shortcut_slot = ShortcutSlot(Arc::new(Mutex::new(None::<Shortcut>)));

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(shortcut_slot.clone())
        .manage(ApprovalRegistry::default())
        .setup(move |app| {
            let window = app.get_webview_window("main").expect("main window");
            window.center().ok();

            let shortcut = parse_shortcut(&settings.hotkey)
                .unwrap_or_else(|| Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyO));
            register_shortcut(&app.handle().clone(), &shortcut_slot, shortcut)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings_cmd,
            set_hotkey_cmd,
            frontend_log,
            save_window_position,
            set_window_geometry,
            set_window_size_centered,
            capture_vision_screenshot,
            agent_run,
            approve_tool,
            a2a_discover_card,
            list_models,
            load_conversation,
            save_conversation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Omni Agent Desktop");
}
