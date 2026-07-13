//! Omni Agent Desktop — Tauri shell.
//!
//! All app logic (agent loop, providers, tools, A2A, scheduler, memory,
//! settings, secrets) lives in the `agent-core` TypeScript sidecar; this crate
//! now provides ONLY:
//!   * window creation + hotkey registration,
//!   * spawning the sidecar and forwarding its events to the webview,
//!   * a generic `sidecar_call(method, params)` bridge invoked by the frontend
//!     (see `src/lib/sidecar.ts`).
//!
//! The legacy per-feature `#[tauri::command]` surface (agent_run,
//! get_settings, list_scheduled, copilot_*, memory_*, …) is intentionally
//! removed: any frontend code that still expects those must switch to
//! `invoke("sidecar_call", { method, params })`. See docs/sidecar.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use crate::sidecar::Sidecar;
use serde_json::Value;
use simplelog::{ColorChoice, ConfigBuilder, LevelFilter, TermLogger, TerminalMode};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Tauri-managed handle to the running agent-core sidecar.
pub struct SidecarState(pub Arc<Sidecar>);

#[derive(Clone, Default)]
struct ShortcutSlot(Arc<Mutex<Option<Shortcut>>>);

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

/// Round-trip smoke test.
#[tauri::command]
async fn sidecar_ping(
    state: tauri::State<'_, SidecarState>,
    payload: Value,
) -> Result<Value, String> {
    state.0.call("ping", payload).await.map_err(|e| e.to_string())
}

/// Generic sidecar RPC passthrough. The frontend calls
///   invoke("sidecar_call", { method: "agent.run", params: {...} })
/// to reach any method registered by `agent-core/src/index.ts`. Events fire
/// under their original names (`agent://…`, `scheduler://…`) because the
/// sidecar bridge re-emits them verbatim.
#[tauri::command]
async fn sidecar_call(
    state: tauri::State<'_, SidecarState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let params = params.unwrap_or(Value::Null);
    log::debug!(
        "sidecar_call -> {method} params={}",
        preview(&params)
    );
    let res = state.0.call(&method, params).await;
    match &res {
        Ok(v) => log::debug!("sidecar_call <- {method} ok result={}", preview(v)),
        Err(e) => log::warn!("sidecar_call <- {method} FAIL {e}"),
    }
    res.map_err(|e| e.to_string())
}

fn preview(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 300 { format!("{}…({}b)", &s[..300], s.len()) } else { s }
}

/// Legacy frontend logger command — retained because the React shell emits
/// diagnostic messages from many places. Writes to the process log.
#[tauri::command]
fn frontend_log(level: String, message: String) {
    match level.to_lowercase().as_str() {
        "error" => log::error!("[fe] {message}"),
        "warn" => log::warn!("[fe] {message}"),
        "debug" => log::debug!("[fe] {message}"),
        _ => log::info!("[fe] {message}"),
    }
}

// -----------------------------------------------------------------------------
// Hotkey wiring
// -----------------------------------------------------------------------------

fn parse_shortcut(spec: &str) -> Option<Shortcut> {
    let parts: Vec<&str> = spec
        .split('+')
        .map(str::trim)
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
            'A'..='Z' => single_letter(c),
            '0'..='9' => single_digit(c),
            _ => None,
        };
    }
    match t.to_ascii_lowercase().as_str() {
        "space" => Some(Code::Space),
        "enter" | "return" => Some(Code::Enter),
        "escape" | "esc" => Some(Code::Escape),
        "tab" => Some(Code::Tab),
        "backspace" => Some(Code::Backspace),
        "f1" => Some(Code::F1),
        "f2" => Some(Code::F2),
        "f3" => Some(Code::F3),
        "f4" => Some(Code::F4),
        "f5" => Some(Code::F5),
        "f6" => Some(Code::F6),
        "f7" => Some(Code::F7),
        "f8" => Some(Code::F8),
        "f9" => Some(Code::F9),
        "f10" => Some(Code::F10),
        "f11" => Some(Code::F11),
        "f12" => Some(Code::F12),
        _ => None,
    }
}

fn single_letter(c: char) -> Option<Code> {
    Some(match c {
        'A' => Code::KeyA, 'B' => Code::KeyB, 'C' => Code::KeyC, 'D' => Code::KeyD,
        'E' => Code::KeyE, 'F' => Code::KeyF, 'G' => Code::KeyG, 'H' => Code::KeyH,
        'I' => Code::KeyI, 'J' => Code::KeyJ, 'K' => Code::KeyK, 'L' => Code::KeyL,
        'M' => Code::KeyM, 'N' => Code::KeyN, 'O' => Code::KeyO, 'P' => Code::KeyP,
        'Q' => Code::KeyQ, 'R' => Code::KeyR, 'S' => Code::KeyS, 'T' => Code::KeyT,
        'U' => Code::KeyU, 'V' => Code::KeyV, 'W' => Code::KeyW, 'X' => Code::KeyX,
        'Y' => Code::KeyY, 'Z' => Code::KeyZ,
        _ => return None,
    })
}

fn single_digit(c: char) -> Option<Code> {
    Some(match c {
        '0' => Code::Digit0, '1' => Code::Digit1, '2' => Code::Digit2, '3' => Code::Digit3,
        '4' => Code::Digit4, '5' => Code::Digit5, '6' => Code::Digit6, '7' => Code::Digit7,
        '8' => Code::Digit8, '9' => Code::Digit9,
        _ => return None,
    })
}

fn register_shortcut(
    app: &tauri::AppHandle,
    slot: &ShortcutSlot,
    shortcut: Shortcut,
) -> Result<(), String> {
    if let Some(previous) = *slot.0.lock().map_err(|e| e.to_string())? {
        let _ = app.global_shortcut().unregister(previous);
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let win = window.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if let ShortcutState::Pressed = event.state() {
                let visible = win.is_visible().unwrap_or(false) && !win.is_minimized().unwrap_or(false);
                if visible {
                    let _ = win.hide();
                } else {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                    use tauri::Emitter;
                    let _ = win.emit("omnilauncher://shown", String::new());
                }
            }
        })
        .map_err(|e| e.to_string())?;
    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| e.to_string())?;
    *slot.0.lock().map_err(|e| e.to_string())? = Some(shortcut);
    Ok(())
}

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------

/// Initialize logging. `--debug` (or OMNI_AGENT_DEBUG=1) enables Trace level and
/// also flips OMNI_AGENT_VERBOSE=1 so the sidecar echoes every RPC to stderr.
/// The Rust process forwards the sidecar's stderr to its own stderr, so a
/// single `--debug` launch traces the whole stack:
///   frontend log (via frontend_log cmd) -> Rust log -> sidecar RPC trace.
fn init_logging(debug: bool) {
    let level = if debug { LevelFilter::Debug } else { LevelFilter::Info };
    if debug {
        // Propagate to sidecar. Child process env is set at Command::spawn time.
        std::env::set_var("OMNI_AGENT_VERBOSE", "1");
    }
    let _ = TermLogger::init(
        level,
        ConfigBuilder::new().build(),
        TerminalMode::Stderr,
        ColorChoice::Never,
    );
    log::info!("logging initialized at {level:?}");
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

fn main() {
    let debug = std::env::args().any(|a| a == "--debug" || a == "-v" || a == "--verbose")
        || std::env::var("OMNI_AGENT_DEBUG").ok().as_deref() == Some("1");
    // Corporate TLS-inspection proxies re-sign upstream certs with a private CA
    // that the sidecar's bundled trust store rejects ("self signed certificate
    // in certificate chain"), breaking Copilot model discovery and any HTTPS
    // provider. `--insecure-tls` (or OMNI_AGENT_INSECURE_TLS=1) tells the
    // sidecar to relax verification. Set the env BEFORE the sidecar is spawned
    // so it inherits it.
    let insecure_tls = std::env::args().any(|a| a == "--insecure-tls")
        || std::env::var("OMNI_AGENT_INSECURE_TLS").ok().as_deref() == Some("1");
    if insecure_tls {
        std::env::set_var("OMNI_AGENT_INSECURE_TLS", "1");
    }
    init_logging(debug);
    log::info!("omni-agent-desktop starting (debug={debug}, insecure_tls={insecure_tls})");
    let shortcut_slot = ShortcutSlot::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(shortcut_slot.clone())
        .setup(move |app| {
            let window = app.get_webview_window("main").expect("main window");
            window.center().ok();
            window.show().ok();

            // Default hotkey: Ctrl+Shift+O. The sidecar owns settings, so the
            // "user preference" is applied on the frontend by calling
            //   sidecar_call("settings.set_hotkey", { hotkey })
            // and then re-registering; the shell just installs the default here.
            let shortcut = parse_shortcut("Ctrl+Shift+O").unwrap_or_else(|| {
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyO)
            });
            if let Err(e) = register_shortcut(&app.handle().clone(), &shortcut_slot, shortcut) {
                // Another app may own the hotkey (or we launched a second
                // instance). Log and continue — the frontend still runs.
                log::warn!("global hotkey registration failed: {e}");
            }

            // Spawn the agent-core sidecar and pipe its events to the webview.
            match Sidecar::spawn(&app.handle().clone()) {
                Ok(sc) => {
                    sc.forward_events(app.handle().clone());
                    let sc_bg = sc.clone();
                    tauri::async_runtime::spawn(async move {
                        crate::sidecar::handshake(&sc_bg).await;
                    });
                    app.manage(SidecarState(sc));
                }
                Err(e) => log::error!("agent-core sidecar failed to spawn: {e}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_ping,
            sidecar_call,
            frontend_log,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Omni Agent Desktop")
        .run(|_app, _event| {});
}
