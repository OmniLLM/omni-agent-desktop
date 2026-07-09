#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde::Deserialize;
use simplelog::{ColorChoice, ConfigBuilder, LevelFilter, TermLogger, TerminalMode, WriteLogger};
use std::{fs, io::Read, path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

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

fn window_pos_path() -> PathBuf {
    let dir = config_dir();
    let _ = fs::create_dir_all(&dir);
    dir.join("window-pos.json")
}

fn frontend_backend_token_path() -> PathBuf {
    let dir = config_dir();
    let _ = fs::create_dir_all(&dir);
    dir.join("backend-token")
}

fn server_token_path() -> PathBuf {
    legacy_omnilauncher_config_dir().join("server-token")
}

fn debug_log_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".omni-agent-desktop")
        .join("desktop.log")
}

#[derive(Debug, Clone, Deserialize)]
struct DesktopSettings {
    #[serde(default)]
    backend_url: String,
    #[serde(default = "default_hotkey")]
    hotkey: String,
}

fn default_hotkey() -> String {
    "Ctrl+Shift+O".to_string()
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            backend_url: String::new(),
            hotkey: default_hotkey(),
        }
    }
}

fn load_desktop_settings() -> DesktopSettings {
    let path = legacy_omnilauncher_config_dir().join("settings.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<DesktopSettings>(&text).ok())
        .unwrap_or_default()
}

fn resolve_backend_url(settings: &DesktopSettings) -> String {
    std::env::var("OMNI_AGENT_BACKEND_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            std::env::var("OMNILAUNCHER_BACKEND_URL")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .unwrap_or_else(|| {
            if settings.backend_url.trim().is_empty() {
                "http://127.0.0.1:1422".to_string()
            } else {
                settings.backend_url.trim().to_string()
            }
        })
}

fn resolve_auth_token() -> String {
    if let Ok(token) = std::env::var("OMNI_AGENT_BACKEND_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(token) = std::env::var("OMNILAUNCHER_AUTH_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    for path in [frontend_backend_token_path(), server_token_path()] {
        if let Ok(token) = fs::read_to_string(path) {
            let trimmed = token.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
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

#[tauri::command]
fn get_server_token() -> String {
    resolve_auth_token()
}

#[tauri::command]
fn get_frontend_backend_token() -> String {
    fs::read_to_string(frontend_backend_token_path()).unwrap_or_default().trim().to_string()
}

#[tauri::command]
fn save_frontend_backend_token(token: String) -> Result<(), String> {
    let path = frontend_backend_token_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, token.trim()).map_err(|e| e.to_string())
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

fn main() {
    let debug = std::env::args().any(|a| a == "--debug");
    init_logging(debug);
    let settings = load_desktop_settings();
    let backend_url = resolve_backend_url(&settings);
    let auth_token = resolve_auth_token();
    let active_shortcut = Arc::new(std::sync::Mutex::new(None::<Shortcut>));

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(move |app| {
            let window = app.get_webview_window("main").expect("main window");
            window
                .eval(format!(
                    "window.__OMNILAUNCHER_BACKEND_URL__ = {}; window.__OMNILAUNCHER_TOKEN__ = {};",
                    serde_json::to_string(&backend_url).unwrap(),
                    serde_json::to_string(&auth_token).unwrap(),
                ))
                .ok();
            window.center().ok();

            let shortcut = parse_shortcut(&settings.hotkey)
                .unwrap_or_else(|| Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyO));
            let shortcut_window = window.clone();
            app.global_shortcut()
                .on_shortcut(shortcut, move |_app, _shortcut, event| {
                    if let ShortcutState::Pressed = event.state() {
                        let visible = shortcut_window.is_visible().unwrap_or(false)
                            && !shortcut_window.is_minimized().unwrap_or(false);
                        if visible {
                            let _ = shortcut_window.hide();
                        } else {
                            let _ = shortcut_window.unminimize();
                            let _ = shortcut_window.show();
                            let _ = shortcut_window.set_focus();
                            let _ = shortcut_window.emit("omnilauncher://shown", String::new());
                        }
                    }
                })
                .map_err(|e| e.to_string())?;
            *active_shortcut.lock().unwrap() = Some(shortcut);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_token,
            get_frontend_backend_token,
            save_frontend_backend_token,
            frontend_log,
            save_window_position,
            set_window_geometry,
            set_window_size_centered,
            capture_vision_screenshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Omni Agent Desktop");
}
