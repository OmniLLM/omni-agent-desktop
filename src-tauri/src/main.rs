#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod memory;
mod scheduler;
mod secrets;
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
fn get_settings() -> Result<AppSettings, String> {
    let settings = load_desktop_settings();
    // Return a frontend-safe view: protected secrets are stripped and replaced
    // with a non-secret `api_key_stored` presence flag. Secrets are NEVER sent
    // to React. A keyring failure is surfaced as an operational error (we never
    // log secret values).
    let store = secrets::KeyringSecretStore::new();
    secrets::frontend_view(&settings, &store).map_err(|e| {
        log::error!("keyring read failed while building settings view: {e}");
        format!("Failed to read credential store: {e}")
    })
}

/// Load settings and hydrate protected secrets from the OS keyring for
/// native-only runtime use (agent execution, model discovery). The result
/// carries live credentials and must never cross the Tauri boundary to React.
fn load_settings_with_secrets() -> Result<AppSettings, String> {
    let mut settings = load_desktop_settings();
    let store = secrets::KeyringSecretStore::new();
    secrets::restore_secrets(&mut settings, &store).map_err(|e| {
        log::error!("keyring read failed while hydrating secrets: {e}");
        format!("Failed to read credential store: {e}")
    })?;
    Ok(settings)
}

#[tauri::command]
fn save_settings_cmd(settings: AppSettings) -> Result<AppSettings, String> {
    let store = secrets::KeyringSecretStore::new();
    let connected = copilot_connected(&store);
    let saved = secrets::save_settings_secure(&settings_path(), settings, &store, connected)?;
    // Return the frontend-safe view so React never receives a secret back.
    secrets::frontend_view(&saved, &store).map_err(|e| {
        log::error!("keyring read failed while building settings view: {e}");
        format!("Failed to read credential store: {e}")
    })
}

#[tauri::command]
fn set_hotkey_cmd(app: tauri::AppHandle, slot: State<'_, ShortcutSlot>, settings: AppSettings) -> Result<AppSettings, String> {
    let shortcut = parse_shortcut(&settings.hotkey).ok_or_else(|| format!("Invalid hotkey: {}", settings.hotkey))?;
    register_shortcut(&app, &slot, shortcut)?;
    let store = secrets::KeyringSecretStore::new();
    let connected = copilot_connected(&store);
    let saved = secrets::save_settings_secure(&settings_path(), settings, &store, connected)?;
    secrets::frontend_view(&saved, &store).map_err(|e| {
        log::error!("keyring read failed while building settings view: {e}");
        format!("Failed to read credential store: {e}")
    })
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
// GitHub Copilot authentication
// ---------------------------------------------------------------------------

/// Shared Copilot auth service, managed by Tauri. Holds the device-flow status,
/// the in-memory Copilot token cache, and the injected keyring/transport/clock.
struct CopilotState(Arc<agent::copilot::CopilotAuth>);

fn build_copilot_auth() -> Arc<agent::copilot::CopilotAuth> {
    let transport: Arc<dyn agent::copilot::HttpTransport> =
        Arc::new(agent::copilot::ReqwestTransport::new(http_client()));
    let clock: Arc<dyn agent::copilot::Clock> = Arc::new(agent::copilot::SystemClock);
    let store: Arc<dyn secrets::SecretStore> = Arc::new(secrets::KeyringSecretStore::new());
    Arc::new(agent::copilot::CopilotAuth::new(transport, clock, store))
}

/// Whether a long-lived GitHub Copilot credential exists in the store. Used by
/// settings validation to gate Copilot activation without exposing the token.
fn copilot_connected(store: &dyn secrets::SecretStore) -> bool {
    store
        .get("github-copilot.token")
        .ok()
        .flatten()
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

/// Start the device-code OAuth flow and spawn a background poller that respects
/// GitHub's interval and updates the shared status. Returns the display status.
#[tauri::command]
async fn start_copilot_device_flow(
    copilot: State<'_, CopilotState>,
) -> Result<agent::copilot::CopilotAuthStatus, String> {
    let auth = copilot.0.clone();
    let status = auth.start_device_flow().await?;
    // Background poll loop: honor the server interval, stop on any terminal
    // outcome or cancellation.
    let poller = auth.clone();
    tokio::spawn(async move {
        loop {
            let interval = poller.poll_interval().max(1);
            tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
            match poller.poll_once().await {
                Ok(agent::copilot::PollOutcome::Pending)
                | Ok(agent::copilot::PollOutcome::SlowDown { .. }) => continue,
                _ => break,
            }
        }
    });
    Ok(status)
}

/// Return the current public Copilot auth status (never a token).
#[tauri::command]
fn get_copilot_auth_status(
    copilot: State<'_, CopilotState>,
) -> agent::copilot::CopilotAuthStatus {
    copilot.0.status()
}

/// Cancel an in-flight device-code flow.
#[tauri::command]
fn cancel_copilot_device_flow(copilot: State<'_, CopilotState>) {
    copilot.0.cancel();
}

/// Manual fallback: connect with a user-supplied GitHub token. Returns public
/// status only.
#[tauri::command]
async fn connect_copilot_with_token(
    copilot: State<'_, CopilotState>,
    token: String,
) -> Result<agent::copilot::CopilotAuthStatus, String> {
    copilot.0.connect_with_token(&token).await
}

/// Disconnect Copilot: delete the stored GitHub token and clear cached state.
#[tauri::command]
fn disconnect_copilot(copilot: State<'_, CopilotState>) -> Result<(), String> {
    copilot.0.disconnect()
}

/// List discovered Copilot models with their routing capability. Never returns
/// a token.
#[tauri::command]
async fn list_copilot_models(
    copilot: State<'_, CopilotState>,
) -> Result<Vec<agent::copilot::CopilotModel>, String> {
    copilot.0.list_models().await
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
        // Bound every single request so a slow/dead provider or A2A hub can't
        // hang the agent loop indefinitely (the UI would sit on "Thinking…").
        .timeout(std::time::Duration::from_secs(120))
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

/// Production [`agent::RunBackend`] for the foreground chat command. Wraps the
/// live provider clients (custom / Copilot / Azure), the local + A2A tool
/// registry, and the UI approval channel so the shared `run_once` loop drives
/// real side effects. Scheduled runs supply their own headless backend.
struct ForegroundBackend<'a> {
    client: reqwest::Client,
    config: settings::ProviderConfig,
    system: String,
    use_copilot: bool,
    use_azure: bool,
    copilot_auth: Arc<agent::copilot::CopilotAuth>,
    azure_transport: agent::copilot::ReqwestTransport,
    tool_defs: Vec<serde_json::Value>,
    a2a_tools: Vec<agent::a2a::A2aTool>,
    registry: &'a ApprovalRegistry,
    app: tauri::AppHandle,
}

impl<'a> agent::RunBackend for ForegroundBackend<'a> {
    fn infer<'b>(
        &'b self,
        _system: &'b str,
        messages: &'b [agent::provider::Msg],
        _tools: &'b [serde_json::Value],
    ) -> agent::BoxFut<'b, Result<agent::provider::ParsedTurn, String>> {
        Box::pin(async move {
            if self.use_copilot {
                // GitHub Copilot: short-lived Copilot token, model endpoint,
                // bounded auth/fallback retry. The long-lived token stays in the
                // credential store.
                let convo: Vec<(String, String)> = messages
                    .iter()
                    .map(|m| (m.role.clone(), m.content.clone()))
                    .collect();
                self.copilot_auth
                    .infer(&self.config.model, &self.system, &convo, &self.tool_defs)
                    .await
            } else if self.use_azure {
                // Azure Foundry: deployment remap, `api-key` Responses request
                // (`store: false`), parsed with the real Responses parser.
                let convo: Vec<(String, String)> = messages
                    .iter()
                    .map(|m| (m.role.clone(), m.content.clone()))
                    .collect();
                agent::azure::infer(
                    &self.azure_transport,
                    &self.config,
                    &self.config.model,
                    &self.system,
                    &convo,
                    &self.tool_defs,
                )
                .await
            } else {
                call_provider(&self.client, &self.config, &self.system, messages, &self.tool_defs)
                    .await
            }
        })
    }

    fn run_tool<'b>(
        &'b self,
        name: &'b str,
        args: &'b serde_json::Value,
    ) -> agent::BoxFut<'b, Result<String, String>> {
        Box::pin(async move {
            if let Some(tool) = self.a2a_tools.iter().find(|t| t.tool_name == name) {
                let task = args["task"].as_str().unwrap_or("").to_string();
                agent::a2a::delegate(&self.client, tool, &task).await
            } else {
                agent::tools::execute(name, args)
            }
        })
    }

    fn approve<'b>(
        &'b self,
        call_id: &'b str,
        name: &'b str,
        args: &'b serde_json::Value,
    ) -> agent::BoxFut<'b, agent::ApprovalDecision> {
        Box::pin(async move {
            let (tx, rx) = oneshot::channel();
            if let Ok(mut map) = self.registry.0.lock() {
                map.insert(call_id.to_string(), tx);
            }
            let _ = self.app.emit(
                "agent://tool-approval-request",
                ToolCallEvent {
                    call_id: call_id.to_string(),
                    tool: name.to_string(),
                    args: args.clone(),
                },
            );
            rx.await.unwrap_or(agent::ApprovalDecision::Deny)
        })
    }
}

/// Foreground [`agent::RunEvents`] sink: relays the shared loop's progress to the
/// existing Tauri events the chat UI already listens for.
struct ForegroundEvents {
    app: tauri::AppHandle,
}

impl agent::RunEvents for ForegroundEvents {
    fn thought(&self, text: &str) {
        let _ = self.app.emit("agent://thought", text.to_string());
    }
    fn tool_call(&self, call_id: &str, tool: &str, args: &serde_json::Value) {
        let _ = self.app.emit(
            "agent://tool-call",
            ToolCallEvent {
                call_id: call_id.to_string(),
                tool: tool.to_string(),
                args: args.clone(),
            },
        );
    }
    fn tool_result(&self, call_id: &str, tool: &str, result: &str) {
        let _ = self.app.emit(
            "agent://tool-result",
            serde_json::json!({ "call_id": call_id, "tool": tool, "result": result }),
        );
    }
}

/// Assembled inputs for one shared agent run. Produced by [`prepare_run`] and
/// consumed identically by the foreground command and the headless scheduler so
/// the two paths never duplicate provider selection, memory injection, system
/// assembly, history packing, or A2A tool discovery.
struct RunPrep {
    config: settings::ProviderConfig,
    system: String,
    messages: Vec<agent::provider::Msg>,
    tool_defs: Vec<serde_json::Value>,
    a2a_tools: Vec<agent::a2a::A2aTool>,
    a2a_names: std::collections::HashSet<String>,
    use_copilot: bool,
    use_azure: bool,
    max_iterations: usize,
}

/// Shared run preparation extracted from `agent_run`. Builds the provider config,
/// tool set (local + enabled A2A), system context (base prompt + startup memory),
/// and packed conversation history for a single prompt. `history` is optional
/// prior turns (foreground chat); the scheduler passes `None`.
async fn prepare_run(
    settings: &AppSettings,
    client: &reqwest::Client,
    message: &str,
    history: Option<&[serde_json::Value]>,
) -> RunPrep {
    let configs = settings.effective_provider_configs();
    let config = configs
        .get(settings.active_provider)
        .cloned()
        .unwrap_or_default();

    // Build tool set: local + enabled A2A.
    let mut tool_defs = agent::tools::tool_definitions();
    let mut a2a_tools: Vec<agent::a2a::A2aTool> = Vec::new();
    for conn in settings.a2a_connections.iter().filter(|c| c.enabled) {
        if let Ok(card) = agent::a2a::fetch_card(client, &conn.endpoint, &conn.token).await {
            for t in agent::a2a::tools_from_card(conn, &card) {
                tool_defs.push(agent::a2a::a2a_tool_definition(&t));
                a2a_tools.push(t);
            }
        }
    }

    let base_prompt = "You are Omni Agent, a helpful desktop AI agent with local tools and A2A skills.\n\
        Always format your final answer as clean, well-structured Markdown:\n\
        - Use headings, bold for key figures, and bullet lists for related items.\n\
        - Present tabular or multi-field data as a Markdown table.\n\
        - Put code, commands, paths, and identifiers in backticks or fenced code blocks.\n\
        - Lead with the direct answer, then supporting detail; keep it concise and easy to scan.";

    // Cross-session memory: MEMORY.md + recent daily logs.
    let base = config_dir();
    let startup_memory = memory::read_startup_memory(&base);
    let mut assembler = agent::context::ContextAssembler::new(4000);
    assembler
        .add(0, "system", base_prompt)
        .add(2, "memory", &startup_memory);
    let system = assembler.build();

    // Reconstruct conversation context from prior user/assistant turns.
    let mut prior: Vec<agent::provider::Msg> = Vec::new();
    if let Some(hist) = history {
        for m in hist {
            let role = m["role"].as_str().unwrap_or("");
            let content = m["content"].as_str().unwrap_or("");
            if (role == "user" || role == "assistant") && !content.is_empty() {
                prior.push(agent::provider::Msg {
                    role: role.to_string(),
                    content: content.to_string(),
                });
            }
        }
    }
    prior.push(agent::provider::Msg {
        role: "user".into(),
        content: message.to_string(),
    });
    let messages = agent::context::pack_history(&prior, 16_000, 12);
    let max_iterations = settings.ai_max_tool_iterations.max(1);

    let use_copilot = settings.active_provider == settings::ProviderType::GithubCopilot;
    let use_azure = settings.active_provider == settings::ProviderType::AzureFoundry;
    let a2a_names: std::collections::HashSet<String> =
        a2a_tools.iter().map(|t| t.tool_name.clone()).collect();

    RunPrep {
        config,
        system,
        messages,
        tool_defs,
        a2a_tools,
        a2a_names,
        use_copilot,
        use_azure,
        max_iterations,
    }
}

#[tauri::command]
async fn agent_run(
    app: tauri::AppHandle,
    registry: State<'_, ApprovalRegistry>,
    copilot: State<'_, CopilotState>,
    message: String,
    mode: agent::RunMode,
    history: Option<Vec<serde_json::Value>>,
) -> Result<(), String> {
    // Native runtime path: hydrate protected secrets from the keyring so the
    // provider request carries a live Azure key / Copilot token.
    let settings = load_settings_with_secrets()?;
    let client = http_client();

    // Shared preparation: identical system/history/tool-definition/backend
    // assembly used by BOTH the foreground command and the headless scheduler,
    // so neither path duplicates provider dispatch, memory injection, or A2A
    // tool discovery.
    let prep = prepare_run(&settings, &client, &message, history.as_deref()).await;

    let backend = ForegroundBackend {
        client: client.clone(),
        config: prep.config.clone(),
        system: prep.system.clone(),
        use_copilot: prep.use_copilot,
        use_azure: prep.use_azure,
        copilot_auth: copilot.0.clone(),
        azure_transport: agent::copilot::ReqwestTransport::new(client.clone()),
        tool_defs: prep.tool_defs.clone(),
        a2a_tools: prep.a2a_tools,
        registry: &registry,
        app: app.clone(),
    };
    let events = ForegroundEvents { app: app.clone() };

    // Foreground chat drives the SAME shared execution path scheduled runs use;
    // only the origin, event sink, and approval source differ.
    let outcome = agent::run_once(
        agent::RunOrigin::Foreground,
        mode,
        prep.system,
        prep.messages,
        prep.tool_defs,
        prep.max_iterations,
        move |name: &str| prep.a2a_names.contains(name),
        |name: &str| agent::tools::classify(name) == agent::tools::ToolClass::Mutating,
        &backend,
        &events,
    )
    .await;

    match outcome {
        Ok(out) => {
            // Record the exchange in today's daily log (Tier-1 memory) only on a
            // natural completion, matching the prior foreground behavior which did
            // not log when the run stopped by hitting the iteration cap.
            if out.text != agent::MAX_ITERATIONS_REPLY {
                let logged: String = message.chars().take(120).collect();
                memory::append_daily_log(&config_dir(), &format!("Q: {logged}"));
            }
            let _ = app.emit("agent://done", out.text);
            Ok(())
        }
        Err(e) => {
            let _ = app.emit("agent://error", e.clone());
            Err(e)
        }
    }
}

/// Draft "Test Connection" for Azure Foundry. The `api_key` is request-only: it
/// is moved straight into the native request and is never logged or persisted.
/// A separate Save is what commits the key to the credential store.
///
/// `draft` is the provider profile as edited in the UI (endpoint, api-version,
/// deployment mappings, selected model). When the draft omits a typed key
/// (because it was previously stored and never echoed to React), the explicit
/// `api_key` argument supplies it for this one bounded request.
#[tauri::command]
async fn test_azure_connection(
    draft: settings::ProviderConfig,
    api_key: String,
) -> Result<String, String> {
    // Move the request-only key into the config; prefer an explicitly typed key
    // in the draft, otherwise use the separate argument. Never log either.
    let mut config = draft;
    let typed = config.api_key.trim().to_string();
    let key = if !typed.is_empty() { typed } else { api_key.trim().to_string() };
    config.api_key = key;
    config.api_key_stored = false;

    agent::azure::validate_config(&config)?;

    let client = http_client();
    let transport = agent::copilot::ReqwestTransport::new(client);
    let turn = agent::azure::infer(
        &transport,
        &config,
        &config.model,
        "You are a connection test. Reply with the single word: ok.",
        &[("user".to_string(), "ping".to_string())],
        &[],
    )
    .await?;
    let _ = turn;
    Ok("Azure connection succeeded".to_string())
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

// ---------------------------------------------------------------------------
// Sessions (per-conversation persistence)
// ---------------------------------------------------------------------------

fn sessions_dir() -> PathBuf {
    let dir = config_dir().join("sessions");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn session_path(id: &str) -> PathBuf {
    // Sanitize the id so it can't escape the sessions directory.
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    sessions_dir().join(format!("{safe}.json"))
}

/// A one-line summary from the first user message, for the session list.
fn session_title(messages: &serde_json::Value) -> String {
    messages
        .as_array()
        .and_then(|arr| {
            arr.iter().find(|m| m["role"] == "user").and_then(|m| {
                m["content"].as_str().map(|s| {
                    let t: String = s.trim().chars().take(60).collect();
                    if t.is_empty() { "New conversation".into() } else { t }
                })
            })
        })
        .unwrap_or_else(|| "New conversation".to_string())
}

/// List saved sessions (id, title, message_count), newest file first.
#[tauri::command]
fn list_sessions() -> Vec<serde_json::Value> {
    let dir = sessions_dir();
    let mut entries: Vec<(std::time::SystemTime, serde_json::Value)> = Vec::new();
    if let Ok(read) = fs::read_dir(&dir) {
        for e in read.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let messages: serde_json::Value = fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_else(|| serde_json::json!([]));
            let count = messages.as_array().map(|a| a.len()).unwrap_or(0);
            let modified = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            entries.push((
                modified,
                serde_json::json!({
                    "id": id,
                    "title": session_title(&messages),
                    "message_count": count,
                }),
            ));
        }
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.into_iter().map(|(_, v)| v).collect()
}

/// Load a session's messages by id (empty array if missing).
#[tauri::command]
fn load_session(id: String) -> serde_json::Value {
    fs::read_to_string(session_path(&id))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!([]))
}

/// Save (create or overwrite) a session's messages by id.
#[tauri::command]
fn save_session(id: String, messages: serde_json::Value) -> Result<(), String> {
    settings::atomic_write(&session_path(&id), &messages.to_string())
}

/// Delete a session by id (no error if it doesn't exist).
#[tauri::command]
fn delete_session(id: String) -> Result<(), String> {
    let path = session_path(&id);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Projects (workspace grouping)
// ---------------------------------------------------------------------------

fn projects_path() -> PathBuf {
    config_dir().join("projects.json")
}

/// List saved projects (array of {id, name}), empty if none exist yet.
#[tauri::command]
fn list_projects() -> serde_json::Value {
    fs::read_to_string(projects_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!([]))
}

/// Overwrite the full project list.
#[tauri::command]
fn save_projects(projects: serde_json::Value) -> Result<(), String> {
    settings::atomic_write(&projects_path(), &projects.to_string())
}

// ---------------------------------------------------------------------------
// Scheduled tasks (recurring/one-shot agent prompts)
// ---------------------------------------------------------------------------

fn scheduled_path() -> PathBuf {
    config_dir().join("scheduled.json")
}

/// Managed scheduler service. Owns typed persistence, cadence timers, the
/// per-task run guard, and status events. Shared across commands and the setup
/// driver.
struct SchedulerState(Arc<scheduler::Scheduler>);

/// Headless [`agent::RunBackend`] for scheduled runs. It reuses the SAME
/// `prepare_run` assembly and `run_once` loop as the foreground path — it does
/// not duplicate the agent loop. Its approval resolver ALWAYS returns `Deny`: a
/// scheduled run has no UI to prompt, so it must never block waiting on approval
/// and must never silently perform a mutating/A2A action. Combined with the
/// default `Ask` mode this makes every gated (mutating/A2A) tool a no-op with a
/// "denied" tool result, keeping headless runs safe.
struct HeadlessBackend {
    client: reqwest::Client,
    config: settings::ProviderConfig,
    system: String,
    use_copilot: bool,
    use_azure: bool,
    copilot_auth: Arc<agent::copilot::CopilotAuth>,
    azure_transport: agent::copilot::ReqwestTransport,
    tool_defs: Vec<serde_json::Value>,
    a2a_tools: Vec<agent::a2a::A2aTool>,
}

impl agent::RunBackend for HeadlessBackend {
    fn infer<'b>(
        &'b self,
        _system: &'b str,
        messages: &'b [agent::provider::Msg],
        _tools: &'b [serde_json::Value],
    ) -> agent::BoxFut<'b, Result<agent::provider::ParsedTurn, String>> {
        Box::pin(async move {
            if self.use_copilot {
                let convo: Vec<(String, String)> = messages
                    .iter()
                    .map(|m| (m.role.clone(), m.content.clone()))
                    .collect();
                self.copilot_auth
                    .infer(&self.config.model, &self.system, &convo, &self.tool_defs)
                    .await
            } else if self.use_azure {
                let convo: Vec<(String, String)> = messages
                    .iter()
                    .map(|m| (m.role.clone(), m.content.clone()))
                    .collect();
                agent::azure::infer(
                    &self.azure_transport,
                    &self.config,
                    &self.config.model,
                    &self.system,
                    &convo,
                    &self.tool_defs,
                )
                .await
            } else {
                call_provider(&self.client, &self.config, &self.system, messages, &self.tool_defs)
                    .await
            }
        })
    }

    fn run_tool<'b>(
        &'b self,
        name: &'b str,
        args: &'b serde_json::Value,
    ) -> agent::BoxFut<'b, Result<String, String>> {
        Box::pin(async move {
            if let Some(tool) = self.a2a_tools.iter().find(|t| t.tool_name == name) {
                let task = args["task"].as_str().unwrap_or("").to_string();
                agent::a2a::delegate(&self.client, tool, &task).await
            } else {
                agent::tools::execute(name, args)
            }
        })
    }

    fn approve<'b>(
        &'b self,
        _call_id: &'b str,
        _name: &'b str,
        _args: &'b serde_json::Value,
    ) -> agent::BoxFut<'b, agent::ApprovalDecision> {
        // Headless: never wait on UI; deny every gated tool by default.
        Box::pin(async move { agent::ApprovalDecision::Deny })
    }
}

/// Production [`scheduler::TaskRunner`]: for each scheduled task it hydrates
/// secrets, runs `prepare_run`, and drives the shared `run_once` loop with the
/// headless backend at `Ask` mode (gated tools auto-denied).
struct AgentTaskRunner {
    copilot: Arc<agent::copilot::CopilotAuth>,
}

impl scheduler::TaskRunner for AgentTaskRunner {
    fn run<'a>(
        &'a self,
        task: &'a scheduler::ScheduledTask,
    ) -> agent::BoxFut<'a, Result<String, String>> {
        Box::pin(async move {
            let settings = load_settings_with_secrets()?;
            let client = http_client();
            let prep = prepare_run(&settings, &client, &task.prompt, None).await;
            let backend = HeadlessBackend {
                client: client.clone(),
                config: prep.config.clone(),
                system: prep.system.clone(),
                use_copilot: prep.use_copilot,
                use_azure: prep.use_azure,
                copilot_auth: self.copilot.clone(),
                azure_transport: agent::copilot::ReqwestTransport::new(client.clone()),
                tool_defs: prep.tool_defs.clone(),
                a2a_tools: prep.a2a_tools,
            };
            let events = agent::NullEvents;
            let a2a_names = prep.a2a_names;
            let out = agent::run_once(
                agent::RunOrigin::Scheduled {
                    task_id: task.id.clone(),
                },
                // Ask mode + headless Deny => any mutating/A2A tool is denied,
                // never auto-executed, and the run never blocks on UI.
                agent::RunMode::Ask,
                prep.system,
                prep.messages,
                prep.tool_defs,
                prep.max_iterations,
                move |name: &str| a2a_names.contains(name),
                |name: &str| agent::tools::classify(name) == agent::tools::ToolClass::Mutating,
                &backend,
                &events,
            )
            .await?;
            Ok(out.text)
        })
    }
}

/// A [`scheduler::StatusSink`] that relays task status to the frontend via a
/// Tauri event. Only non-secret, bounded fields cross the boundary.
struct TauriStatusSink {
    app: tauri::AppHandle,
}

impl scheduler::StatusSink for TauriStatusSink {
    fn emit(&self, event: &scheduler::StatusEvent) {
        let _ = self.app.emit("scheduler://status", event.clone());
    }
}

/// Build the managed scheduler service, wiring the file store, system clock,
/// production task runner, and Tauri status sink.
fn build_scheduler(
    app: &tauri::AppHandle,
    copilot: Arc<agent::copilot::CopilotAuth>,
) -> Arc<scheduler::Scheduler> {
    let store: Arc<dyn scheduler::TaskStore> =
        Arc::new(scheduler::FileTaskStore::new(scheduled_path()));
    let clock: Arc<dyn scheduler::Clock> = Arc::new(scheduler::SystemClock);
    let runner: Arc<dyn scheduler::TaskRunner> = Arc::new(AgentTaskRunner { copilot });
    let sink: Arc<dyn scheduler::StatusSink> = Arc::new(TauriStatusSink { app: app.clone() });
    scheduler::Scheduler::new(store, clock, runner, sink)
}

/// List all scheduled tasks (typed).
#[tauri::command]
fn list_scheduled(sched: State<'_, SchedulerState>) -> Vec<scheduler::ScheduledTask> {
    sched.0.list()
}

/// Create a scheduled task from a validated prompt/cadence. Returns the created
/// task; the full list is available via `list_scheduled`.
#[tauri::command]
fn create_scheduled(
    sched: State<'_, SchedulerState>,
    prompt: String,
    cadence: scheduler::Cadence,
    enabled: Option<bool>,
) -> Result<scheduler::ScheduledTask, String> {
    sched.0.create(&prompt, cadence, enabled.unwrap_or(true))
}

/// Update a scheduled task's prompt, cadence, and enabled flag.
#[tauri::command]
fn update_scheduled(
    sched: State<'_, SchedulerState>,
    id: String,
    prompt: String,
    cadence: scheduler::Cadence,
    enabled: bool,
) -> Result<scheduler::ScheduledTask, String> {
    sched.0.update(&id, &prompt, cadence, enabled)
}

/// Delete a scheduled task by id.
#[tauri::command]
fn delete_scheduled(sched: State<'_, SchedulerState>, id: String) -> Result<(), String> {
    sched.0.delete(&id)
}

/// Run a scheduled task immediately (manual trigger). Rejected if the same task
/// is already running.
#[tauri::command]
async fn run_scheduled_now(
    sched: State<'_, SchedulerState>,
    id: String,
) -> Result<scheduler::ScheduledTask, String> {
    sched.0.run_now(&id).await
}

// ---------------------------------------------------------------------------
// Memory (cross-session)
// ---------------------------------------------------------------------------

/// Read the curated long-term memory file (`MEMORY.md`).
#[tauri::command]
fn get_memory() -> String {
    memory::get_memory(&config_dir())
}

/// Overwrite the curated long-term memory file.
#[tauri::command]
fn save_memory(content: String) -> Result<(), String> {
    memory::save_memory(&config_dir(), &content)
}

fn main() {
    let debug = std::env::args().any(|a| a == "--debug");
    init_logging(debug);
    let settings = load_desktop_settings();
    let shortcut_slot = ShortcutSlot(Arc::new(Mutex::new(None::<Shortcut>)));
    // Shared Copilot auth service, used by both the foreground command state and
    // the scheduler's headless task runner.
    let copilot_auth = build_copilot_auth();

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(shortcut_slot.clone())
        .manage(ApprovalRegistry::default())
        .manage(CopilotState(copilot_auth.clone()))
        .setup(move |app| {
            let window = app.get_webview_window("main").expect("main window");
            window.center().ok();

            let shortcut = parse_shortcut(&settings.hotkey)
                .unwrap_or_else(|| Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyO));
            register_shortcut(&app.handle().clone(), &shortcut_slot, shortcut)?;

            // Build and start the persistent scheduler. It keeps running while the
            // window is hidden and the process is alive; the driver performs
            // exactly one startup catch-up before entering its timer loop. The
            // service is managed so commands can reach it; a clone drives the
            // background loop.
            //
            // Spawn via `tauri::async_runtime::spawn`, NOT `tokio::spawn`: this
            // `setup` closure runs synchronously outside an entered Tokio runtime,
            // where a bare `tokio::spawn` would panic. Tauri's runtime handle
            // spawns onto the managed executor regardless of ambient context.
            let sched = build_scheduler(&app.handle().clone(), copilot_auth.clone());
            tauri::async_runtime::spawn(sched.clone().drive());
            app.manage(SchedulerState(sched));
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
            list_sessions,
            load_session,
            save_session,
            delete_session,
            list_projects,
            save_projects,
            list_scheduled,
            create_scheduled,
            update_scheduled,
            delete_scheduled,
            run_scheduled_now,
            start_copilot_device_flow,
            get_copilot_auth_status,
            cancel_copilot_device_flow,
            connect_copilot_with_token,
            disconnect_copilot,
            list_copilot_models,
            test_azure_connection,
            get_memory,
            save_memory,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Omni Agent Desktop")
        .run(|app, event| {
            // Cancel the scheduler's background timers/worker on process exit so
            // it stops when the app stops (it keeps running while the window is
            // merely hidden and the process is alive).
            if let tauri::RunEvent::Exit = event {
                if let Some(sched) = app.try_state::<SchedulerState>() {
                    sched.0.shutdown();
                }
            }
        });
}
