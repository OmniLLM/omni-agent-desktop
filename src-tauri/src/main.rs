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
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use simplelog::{ColorChoice, ConfigBuilder, LevelFilter, TermLogger, TerminalMode};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(windows)]
fn set_taskbar_icon(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadImageW, SendMessageW, IMAGE_ICON, LR_DEFAULTSIZE, WM_SETICON,
    };

    const ICON_BIG: usize = 1;
    // tauri-build embeds bundle.icon with this winres resource ID.
    const APP_ICON_RESOURCE_ID: usize = 32512;

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let module = unsafe { GetModuleHandleW(None) }.map_err(|error| error.to_string())?;
    let icon = unsafe {
        LoadImageW(
            Some(module.into()),
            PCWSTR(APP_ICON_RESOURCE_ID as *const u16),
            IMAGE_ICON,
            0,
            0,
            LR_DEFAULTSIZE,
        )
    }
    .map_err(|error| error.to_string())?;

    unsafe {
        SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_BIG)),
            Some(LPARAM(icon.0 as isize)),
        );
    }

    Ok(())
}

/// Tauri-managed handle to the running agent-core sidecar.
pub struct SidecarState(pub Arc<Sidecar>);

#[derive(Clone, Default)]
struct ShortcutSlot(Arc<Mutex<Option<Shortcut>>>);

#[derive(Default)]
struct ScreenCaptureCleanupState {
    next_token: AtomicU64,
    pending: Mutex<HashMap<String, HashSet<isize>>>,
}

impl ScreenCaptureCleanupState {
    fn remember(&self, existing_windows: HashSet<isize>) -> String {
        const MAX_PENDING_CAPTURES: usize = 8;

        let token_number = self.next_token.fetch_add(1, Ordering::Relaxed);
        let token = token_number.to_string();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(token.clone(), existing_windows);
            if pending.len() > MAX_PENDING_CAPTURES {
                let oldest = pending
                    .keys()
                    .filter_map(|value| value.parse::<u64>().ok())
                    .min();
                if let Some(oldest) = oldest {
                    pending.remove(&oldest.to_string());
                }
            }
        }
        token
    }

    fn take(&self, token: &str) -> Option<HashSet<isize>> {
        self.pending.lock().ok()?.remove(token)
    }
}

struct CapturedRegion {
    path: PathBuf,
    cleanup_token: Option<String>,
}

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotCapture {
    data_url: String,
    mime_type: String,
    name: String,
    cleanup_token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextCapture {
    text: String,
    cleanup_token: Option<String>,
}

fn encode_png_data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", BASE64_STANDARD.encode(bytes))
}

fn screenshot_temp_path() -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    std::env::temp_dir().join(format!(
        "omni-agent-screenshot-{}-{stamp}.png",
        std::process::id()
    ))
}

#[cfg(target_os = "linux")]
fn tool_exists(name: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {name} >/dev/null 2>&1")])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn capture_area_to_path(path: &Path) -> Result<(), String> {
    let path = path
        .to_str()
        .ok_or_else(|| "temporary screenshot path is not valid UTF-8".to_string())?;
    let (program, args): (&str, Vec<&str>) = if tool_exists("gnome-screenshot") {
        ("gnome-screenshot", vec!["-a", "-f", path])
    } else if tool_exists("spectacle") {
        ("spectacle", vec!["-r", "-b", "-n", "-o", path])
    } else if tool_exists("scrot") {
        ("scrot", vec!["-s", path])
    } else if tool_exists("import") {
        ("import", vec![path])
    } else {
        return Err(
            "No screenshot selector found. Install gnome-screenshot, spectacle, scrot, or ImageMagick."
                .to_string(),
        );
    };
    let status = Command::new(program)
        .args(args)
        .status()
        .map_err(|error| format!("failed to launch {program}: {error}"))?;
    if !status.success() || !Path::new(path).is_file() {
        return Err("Screenshot selection was cancelled.".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn capture_area_to_path(path: &Path) -> Result<(), String> {
    let status = Command::new("screencapture")
        .arg("-i")
        .arg(path)
        .status()
        .map_err(|error| format!("failed to launch screencapture: {error}"))?;
    if !status.success() || !path.is_file() {
        return Err("Screenshot selection was cancelled.".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn top_level_windows() -> HashSet<isize> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetAncestor, GetWindowTextLengthW, IsWindowVisible, GA_ROOTOWNER,
    };

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            if IsWindowVisible(hwnd).as_bool()
                && GetWindowTextLengthW(hwnd) > 0
                && GetAncestor(hwnd, GA_ROOTOWNER) == hwnd
            {
                let windows = &mut *(lparam.0 as *mut HashSet<isize>);
                windows.insert(hwnd.0 as isize);
            }
            BOOL(1)
        }
    }

    let mut windows = HashSet::new();
    unsafe {
        let _ = EnumWindows(
            Some(collect),
            LPARAM((&mut windows as *mut HashSet<isize>) as isize),
        );
    }
    windows
}

#[cfg(target_os = "windows")]
fn is_snipping_tool_window(handle: isize) -> bool {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let mut process_id = 0;
    unsafe {
        GetWindowThreadProcessId(HWND(handle as *mut _), Some(&mut process_id));
    }
    if process_id == 0 {
        return false;
    }
    let Ok(process) = (unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
    }) else {
        return false;
    };

    let mut path = [0u16; 1024];
    let mut path_len = path.len() as u32;
    let image_name = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_FORMAT(0),
            PWSTR(path.as_mut_ptr()),
            &mut path_len,
        )
    }
    .ok()
    .map(|_| String::from_utf16_lossy(&path[..path_len as usize]));
    unsafe {
        let _ = CloseHandle(process);
    }

    image_name
        .as_deref()
        .and_then(|value| Path::new(value).file_name())
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("SnippingTool.exe")
                || value.eq_ignore_ascii_case("ScreenSketch.exe")
        })
}

fn new_window_handles(before: &HashSet<isize>, after: &HashSet<isize>) -> Vec<isize> {
    after.difference(before).copied().collect()
}

#[cfg(target_os = "windows")]
fn dismiss_new_snipping_tool_windows(before: &HashSet<isize>) {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};

    // The editor window can appear a moment after the clipboard image arrives.
    // Wait briefly so cleanup does not lose that race, but stop as soon as the
    // newly-created window is found.
    for _ in 0..15 {
        let handles = new_window_handles(before, &top_level_windows());
        let snipping_tool_handles: Vec<_> = handles
            .into_iter()
            .filter(|handle| is_snipping_tool_window(*handle))
            .collect();
        if !snipping_tool_handles.is_empty() {
            for handle in snipping_tool_handles {
                unsafe {
                    let _ =
                        PostMessageW(Some(HWND(handle as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
                }
            }
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[cfg(not(target_os = "windows"))]
fn dismiss_new_snipping_tool_windows(_before: &HashSet<isize>) {}

fn dismiss_capture_cleanup(state: &ScreenCaptureCleanupState, cleanup_token: Option<&str>) {
    if let Some(before) = cleanup_token.and_then(|token| state.take(token)) {
        dismiss_new_snipping_tool_windows(&before);
    }
}

#[tauri::command]
async fn dismiss_screen_capture(
    state: tauri::State<'_, ScreenCaptureCleanupState>,
    cleanup_token: String,
) -> Result<(), String> {
    if let Some(before) = state.take(&cleanup_token) {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            dismiss_new_snipping_tool_windows(&before)
        })
        .await;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn capture_area_to_path(path: &Path) -> Result<(), String> {
    let quoted_path = path
        .to_str()
        .ok_or_else(|| "temporary screenshot path is not valid UTF-8".to_string())?
        .replace('\'', "''");
    let script = format!(
        r#"Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
[System.Windows.Forms.Clipboard]::Clear();
Start-Process 'ms-screenclip:';
$deadline = [DateTime]::UtcNow.AddSeconds(120);
while ([DateTime]::UtcNow -lt $deadline) {{
  Start-Sleep -Milliseconds 200;
  if ([System.Windows.Forms.Clipboard]::ContainsImage()) {{
    $image = [System.Windows.Forms.Clipboard]::GetImage();
    $image.Save('{quoted_path}', [System.Drawing.Imaging.ImageFormat]::Png);
    $image.Dispose();
    exit 0;
  }}
}}
exit 2;"#
    );
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-STA",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .status()
        .map_err(|error| format!("failed to launch Windows screen snip: {error}"))?;
    if !status.success() || !path.is_file() {
        return Err("Screenshot selection was cancelled.".to_string());
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn capture_area_to_path(_path: &Path) -> Result<(), String> {
    Err("Screenshot capture is not supported on this platform.".to_string())
}

async fn capture_region_file(
    app: &tauri::AppHandle,
    cleanup_state: &ScreenCaptureCleanupState,
) -> Result<CapturedRegion, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.hide().map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    let existing_windows = top_level_windows();
    #[cfg(not(target_os = "windows"))]
    let existing_windows = HashSet::new();

    let task = tauri::async_runtime::spawn_blocking(|| {
        std::thread::sleep(std::time::Duration::from_millis(180));
        let path = screenshot_temp_path();
        if let Err(error) = capture_area_to_path(&path) {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        Ok(path)
    })
    .await;

    let _ = window.show();
    let _ = window.set_focus();
    let path = task.map_err(|error| format!("screenshot task failed: {error}"))??;
    let cleanup_token =
        cfg!(target_os = "windows").then(|| cleanup_state.remember(existing_windows));
    Ok(CapturedRegion {
        path,
        cleanup_token,
    })
}

/// Hide the app, let the OS draw its native region-selection overlay, and
/// return the selected PNG inline so it can be attached to a multimodal turn.
#[tauri::command]
async fn capture_vision_screenshot(
    app: tauri::AppHandle,
    cleanup_state: tauri::State<'_, ScreenCaptureCleanupState>,
) -> Result<ScreenshotCapture, String> {
    let CapturedRegion {
        path,
        cleanup_token,
    } = capture_region_file(&app, &cleanup_state).await?;
    let captured = (|| {
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("failed to read captured screenshot: {error}"))?;
        if bytes.is_empty() {
            return Err("Captured screenshot is empty.".to_string());
        }
        Ok(ScreenshotCapture {
            data_url: encode_png_data_url(&bytes),
            mime_type: "image/png".to_string(),
            name: "screenshot.png".to_string(),
            cleanup_token: cleanup_token.clone(),
        })
    })();
    let _ = std::fs::remove_file(path);
    if captured.is_err() {
        dismiss_capture_cleanup(&cleanup_state, cleanup_token.as_deref());
    }
    captured
}

#[cfg(windows)]
fn recognize_text(path: &Path) -> Result<String, String> {
    use windows::core::HSTRING;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    let path = path
        .to_str()
        .ok_or_else(|| "temporary screenshot path is not valid UTF-8".to_string())?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
        .map_err(|error| format!("failed to open screenshot for OCR: {error}"))?
        .get()
        .map_err(|error| format!("failed to open screenshot for OCR: {error}"))?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|error| format!("failed to read screenshot for OCR: {error}"))?
        .get()
        .map_err(|error| format!("failed to read screenshot for OCR: {error}"))?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|error| format!("failed to decode screenshot for OCR: {error}"))?
        .get()
        .map_err(|error| format!("failed to decode screenshot for OCR: {error}"))?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|error| format!("failed to prepare screenshot for OCR: {error}"))?
        .get()
        .map_err(|error| format!("failed to prepare screenshot for OCR: {error}"))?;
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|error| format!("Windows OCR is unavailable: {error}"))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|error| format!("failed to recognize screen text: {error}"))?
        .get()
        .map_err(|error| format!("failed to recognize screen text: {error}"))?;
    let lines = result
        .Lines()
        .map_err(|error| format!("failed to read OCR result: {error}"))?;
    let mut text = Vec::new();
    for line in lines {
        let value = line
            .Text()
            .map_err(|error| format!("failed to read OCR text: {error}"))?;
        let value = value.to_string();
        let value = value.trim();
        if !value.is_empty() {
            text.push(value.to_string());
        }
    }
    Ok(text.join("\n"))
}

#[cfg(not(windows))]
fn recognize_text(_path: &Path) -> Result<String, String> {
    Err("Screen text selection is currently supported on Windows only.".to_string())
}

/// Select a screen region and recognize its text with the local OS OCR engine.
#[tauri::command]
async fn capture_region_text(
    app: tauri::AppHandle,
    cleanup_state: tauri::State<'_, ScreenCaptureCleanupState>,
) -> Result<TextCapture, String> {
    let CapturedRegion {
        path,
        cleanup_token,
    } = capture_region_file(&app, &cleanup_state).await?;
    let ocr_path = path.clone();
    let task = tauri::async_runtime::spawn_blocking(move || recognize_text(&ocr_path)).await;
    let _ = std::fs::remove_file(path);
    let captured = task
        .map_err(|error| format!("OCR task failed: {error}"))?
        .map(|text| TextCapture {
            text,
            cleanup_token: cleanup_token.clone(),
        });
    if captured.is_err() {
        dismiss_capture_cleanup(&cleanup_state, cleanup_token.as_deref());
    }
    captured
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
        .manage(ScreenCaptureCleanupState::default())
        .setup(move |app| {
            let window = app.get_webview_window("main").expect("main window");
            // Ensure the taskbar / window icon is set at runtime. In unbundled or
            // dev runs the embedded window icon may be missing, leaving a blank
            // taskbar entry, so apply it explicitly from the bundled PNG.
            match tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")) {
                Ok(icon) => {
                    if let Err(e) = window.set_icon(icon) {
                        log::warn!("failed to set window icon: {e}");
                    }
                }
                Err(e) => log::warn!("failed to decode window icon: {e}"),
            }
            #[cfg(windows)]
            if let Err(e) = set_taskbar_icon(&window) {
                log::warn!("failed to set taskbar icon: {e}");
            }
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
            capture_vision_screenshot,
            capture_region_text,
            dismiss_screen_capture,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Omni Agent Desktop")
        .run(|_app, _event| {});
}

#[cfg(test)]
mod tests {
    use super::{encode_png_data_url, new_window_handles};
    use std::collections::HashSet;

    #[test]
    fn encodes_png_bytes_as_a_data_url() {
        assert_eq!(encode_png_data_url(b"png"), "data:image/png;base64,cG5n");
    }

    #[test]
    fn finds_only_new_window_handles() {
        let before = HashSet::from([10, 20]);
        let after = HashSet::from([10, 20, 30]);

        assert_eq!(new_window_handles(&before, &after), vec![30]);
    }

    #[test]
    fn preserves_preexisting_windows_when_no_new_window_appears() {
        let before = HashSet::from([10, 20]);
        let after = HashSet::from([10, 20]);

        assert!(new_window_handles(&before, &after).is_empty());
    }
}
