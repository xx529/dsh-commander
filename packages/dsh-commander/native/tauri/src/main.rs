//! DSH Commander 原生壳（Tauri 2）。
//!
//! 由 Host 插件 spawn，加载 Host 提供的 `/commander/window` 页面，提供：
//! - 透明无边框置顶的悬浮球窗口（56×56 ↔ 面板 420×660 同窗两态）
//! - 全局热键（默认 Option+Space）
//! - 位置持久化、父进程看门狗
//! - 与 Host 的 stdio NDJSON 控制帧（契约：docs/architecture/native-shell-contract.md §3）
//!
//! stdout 只走协议帧；诊断日志一律 stderr。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const PROTOCOL: u32 = 1;
const BALL_SIZE: f64 = 56.0;
const EDGE_MARGIN: f64 = 8.0;
const TOP_MARGIN: f64 = 28.0;

// ---------------------------------------------------------------- 环境与状态

#[derive(Clone, Debug)]
struct Config {
    window_url: String,
    parent_pid: u32,
    state_dir: PathBuf,
    hotkey: String,
    theme: String,
    locale: String,
    verbose: bool,
}

impl Config {
    fn from_env() -> Option<Self> {
        let window_url = env::var("DSH_COMMANDER_WINDOW_URL").ok()?;
        if window_url.trim().is_empty() {
            return None;
        }
        let parent_pid = env::var("DSH_COMMANDER_PARENT_PID")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0);
        let state_dir = env::var("DSH_COMMANDER_STATE_DIR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_state_dir);
        Some(Self {
            window_url,
            parent_pid,
            state_dir,
            hotkey: env::var("DSH_COMMANDER_HOTKEY").unwrap_or_else(|_| "Alt+Space".into()),
            theme: env::var("DSH_COMMANDER_THEME").unwrap_or_else(|_| "follow".into()),
            locale: env::var("DSH_COMMANDER_LOCALE").unwrap_or_else(|_| "zh".into()),
            verbose: env::var("DSH_COMMANDER_LOG").map(|value| value == "1").unwrap_or(false),
        })
    }
}

impl Config {
    fn log(&self, message: &str) {
        if self.verbose {
            eprintln!("[commander-shell] {message}");
        }
    }
}

fn default_state_dir() -> PathBuf {
    let home = env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".dsh").join("commander").join("native")
}

struct AppState {
    config: Config,
    panel_open: AtomicBool,
    last_save: Mutex<Instant>,
    /// 球的逻辑坐标：展开面板时记住，收起时原样恢复（否则球会漂到面板左上角）。
    ball_pos: Mutex<Option<(f64, f64)>>,
    /// 本次运行内用户调整过的面板/看板 frame（逻辑坐标），重启不持久化。
    expanded_frames: Mutex<HashMap<&'static str, (f64, f64, f64, f64)>>,
    current_mode: Mutex<&'static str>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct SavedWindow {
    /// 逻辑坐标（已除以 scale factor）。
    x: Option<f64>,
    y: Option<f64>,
    panel_open: Option<bool>,
}

// ---------------------------------------------------------------- 协议帧

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum OutFrame {
    #[serde(rename = "hello")]
    Hello {
        protocol: u32,
        platform: String,
        arch: String,
        pid: u32,
        capabilities: Vec<String>,
        hotkey: Option<String>,
    },
    #[serde(rename = "pong")]
    Pong { at: u64 },
    #[serde(rename = "window/visibility")]
    Visibility { visible: bool, panel_open: bool, focused: bool },
    #[serde(rename = "window/bounds")]
    Bounds { x: i32, y: i32, width: u32, height: u32, scale: f64 },
    #[serde(rename = "log")]
    Log { level: String, message: String },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum InFrame {
    #[serde(rename = "ready")]
    Ready {
        #[serde(default)]
        origin: Option<String>,
        #[serde(default)]
        theme: Option<String>,
        #[serde(default)]
        locale: Option<String>,
        #[serde(default)]
        entry_pos: Option<NormalizedPoint>,
        #[serde(default)]
        hotkey: Option<String>,
    },
    #[serde(rename = "ping")]
    Ping { #[serde(default)] at: u64 },
    #[serde(rename = "shutdown")]
    Shutdown,
}

#[derive(Deserialize, Clone, Copy)]
struct NormalizedPoint {
    x: f64,
    y: f64,
}

fn stdout_handle() -> &'static Mutex<std::io::Stdout> {
    static OUT: OnceLock<Mutex<std::io::Stdout>> = OnceLock::new();
    OUT.get_or_init(|| Mutex::new(std::io::stdout()))
}

fn send(frame: &OutFrame) {
    let Ok(line) = serde_json::to_string(frame) else { return };
    if let Ok(mut handle) = stdout_handle().lock() {
        let _ = writeln!(handle, "{line}");
        let _ = handle.flush();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- 主入口

fn acquire_instance_lock(config: &Config) -> bool {
    let path = config.state_dir.join("shell.pid");
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(pid) = text.trim().parse::<i32>() {
            if pid > 0 && unsafe { libc::kill(pid, 0) } == 0 {
                return false;
            }
        }
    }
    let _ = fs::create_dir_all(&config.state_dir);
    let _ = fs::write(&path, std::process::id().to_string());
    true
}

fn main() {
    let Some(config) = Config::from_env() else {
        eprintln!("[commander-shell] missing DSH_COMMANDER_WINDOW_URL; refusing to start");
        std::process::exit(2);
    };
    if !acquire_instance_lock(&config) {
        eprintln!("[commander-shell] another shell instance is already running; exiting");
        std::process::exit(0);
    }
    config.log("starting");
    let state = AppState {
        config: config.clone(),
        panel_open: AtomicBool::new(false),
        last_save: Mutex::new(Instant::now() - Duration::from_secs(5)),
        ball_pos: Mutex::new(None),
        expanded_frames: Mutex::new(HashMap::new()),
        current_mode: Mutex::new("ball"),
    };
    let setup_config = config.clone();
    let result = tauri::Builder::default()
        .manage(state)
        .plugin(build_hotkey_plugin())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            create_window(app, &setup_config)?;
            register_hotkey(app, &setup_config);
            spawn_stdin_reader(app.handle().clone());
            spawn_parent_watchdog(app.handle().clone(), setup_config.parent_pid);
            send(&OutFrame::Hello {
                protocol: PROTOCOL,
                platform: env::consts::OS.to_string(),
                arch: env::consts::ARCH.to_string(),
                pid: std::process::id(),
                capabilities: vec!["ball".into(), "panel".into(), "hotkey".into()],
                hotkey: Some(setup_config.hotkey.clone()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_mode, open_session_window, open_external, quit])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("[commander-shell] fatal: {error}");
        std::process::exit(1);
    }
}

fn build_hotkey_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let open = app.state::<AppState>().panel_open.load(Ordering::SeqCst);
                let _ = set_window_mode(app, if open { "ball" } else { "panel" });
            }
        })
        .build()
}

fn register_hotkey(app: &tauri::App, config: &Config) {
    let shortcut = parse_hotkey(&config.hotkey).unwrap_or_else(|| Shortcut::new(Some(Modifiers::ALT), Code::Space));
    if let Err(error) = app.global_shortcut().register(shortcut) {
        config.log(&format!("hotkey {:?} failed: {error}; falling back to Ctrl+Alt+Space", config.hotkey));
        let fallback = Shortcut::new(Some(Modifiers::ALT | Modifiers::CONTROL), Code::Space);
        let _ = app.global_shortcut().register(fallback);
    }
}

fn parse_hotkey(value: &str) -> Option<Shortcut> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "alt+space" | "option+space" => Some(Shortcut::new(Some(Modifiers::ALT), Code::Space)),
        "ctrl+alt+space" | "control+alt+space" => Some(Shortcut::new(Some(Modifiers::ALT | Modifiers::CONTROL), Code::Space)),
        _ => None,
    }
}

// ---------------------------------------------------------------- 窗口

fn create_window(app: &tauri::App, config: &Config) -> tauri::Result<()> {
    let url = config.window_url.parse().map_err(|error| tauri::Error::InvalidUrl(error))?;
    let scale = app.primary_monitor().ok().flatten().map(|monitor| monitor.scale_factor()).unwrap_or(1.0);
    // 重启后固定回主屏右下：旧的 window.json 可能指向已断开的外接屏/屏外坐标，
    // 导致球 visible=true 但落在不可见区域。
    let (x, y) = default_ball_position(app, scale);
    let page_app = app.handle().clone();
    let load_app = page_app.clone();
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Commander")
        .inner_size(BALL_SIZE, BALL_SIZE)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .accept_first_mouse(true)
        .visible(false)
        .on_page_load(move |_webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(win) = load_app.get_webview_window("main") {
                    let _ = win.set_shadow(false);
                    let _ = win.show();
                }
                write_window_debug(&load_app, "page-loaded");
            }
        })
        .build()?;
    // 无边框透明窗口不要系统阴影（阴影会在桌面留下半透明色块）。
    let _ = window.set_shadow(false);
    // 跨所有 Space + 全屏应用之上（macOS collectionBehavior）；失败不影响置顶。
    #[cfg(target_os = "macos")]
    enable_all_spaces(&window);
    write_window_debug(app.handle(), "created");
    if let Ok(mut slot) = app.state::<AppState>().ball_pos.lock() {
        *slot = Some((x, y));
    };
    // 页面加载失败时 on_page_load 不会触发：1.5s 后兜底显示，避免壳永远不可见。
    let fallback = page_app;
    std::thread::spawn(move || {
        for attempt in 0..6 {
            std::thread::sleep(Duration::from_millis(1_000));
            if let Some(win) = fallback.get_webview_window("main") {
                if !win.is_visible().unwrap_or(false) {
                    let _ = win.show();
                }
                write_window_debug(&fallback, &format!("fallback-{attempt}"));
            }
        }
    });
    let handle = app.handle().clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) => {
            update_ball_pos(&handle);
            record_expanded_frame(&handle);
            save_window(&handle);
        }
        WindowEvent::Resized(_) => {
            record_expanded_frame(&handle);
            save_window(&handle);
        }
        WindowEvent::Focused(_) => {
            let _ = emit_visibility(&handle);
        }
        WindowEvent::CloseRequested { api, .. } => {
            // 关闭窗口 = 退出壳，由 Host supervisor 决定是否重启。
            api.prevent_close();
            handle.exit(0);
        }
        _ => {}
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn enable_all_spaces(window: &WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    let Ok(pointer) = window.ns_window() else {
        return;
    };
    let ns_window = pointer as *mut NSWindow;
    unsafe {
        let current = (*ns_window).collectionBehavior();
        (*ns_window).setCollectionBehavior(
            current
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    }
}

/// 把球限制在某个当前可见显示器内；保存的坐标来自旧显示器/已断开的外接屏时回主屏右下。
fn clamp_ball_position(app: &AppHandle, x: f64, y: f64, scale: f64) -> (f64, f64) {
    let ball = BALL_SIZE;
    if let Ok(monitors) = app.available_monitors() {
        for monitor in monitors {
            let monitor_scale = monitor.scale_factor();
            let position = monitor.position();
            let size = monitor.size();
            let mx = position.x as f64 / monitor_scale;
            let my = position.y as f64 / monitor_scale;
            let mw = size.width as f64 / monitor_scale;
            let mh = size.height as f64 / monitor_scale;
            // 中心点落在该显示器内即视为可见，再夹到安全边距。
            let center_x = x + ball / 2.0;
            let center_y = y + ball / 2.0;
            if center_x >= mx && center_x <= mx + mw && center_y >= my && center_y <= my + mh {
                return (
                    x.clamp(mx + EDGE_MARGIN, (mx + mw - ball - EDGE_MARGIN).max(mx + EDGE_MARGIN)),
                    y.clamp(my + TOP_MARGIN, (my + mh - ball - EDGE_MARGIN).max(my + TOP_MARGIN)),
                );
            }
        }
    }
    default_ball_position_handle(app, scale)
}

fn write_window_debug(app: &AppHandle, stage: &str) {
    let Some(window) = app.get_webview_window("main") else { return };
    let position = window.outer_position().ok();
    let size = window.outer_size().ok();
    let visible = window.is_visible().unwrap_or(false);
    let scale = window.scale_factor().unwrap_or(0.0);
    let state_dir = app.state::<AppState>().config.state_dir.clone();
    let _ = fs::create_dir_all(&state_dir);
    let payload = format!(
        "{{\"stage\":\"{}\",\"visible\":{},\"pos\":[{},{}],\"size\":[{},{}],\"scale\":{}}}",
        stage,
        visible,
        position.map(|value| value.x).unwrap_or(-1),
        position.map(|value| value.y).unwrap_or(-1),
        size.map(|value| value.width).unwrap_or(0),
        size.map(|value| value.height).unwrap_or(0),
        scale
    );
    let _ = fs::write(state_dir.join("startup.json"), payload);
}

fn default_ball_position_handle(app: &AppHandle, scale: f64) -> (f64, f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let position = monitor.position();
        let size = monitor.size();
        let margin = 24.0;
        return (
            (position.x as f64 + size.width as f64) / scale - BALL_SIZE - margin,
            (position.y as f64 + size.height as f64) / scale - BALL_SIZE - margin * 3.0,
        );
    }
    (120.0, 120.0)
}

fn default_ball_position(app: &tauri::App, scale: f64) -> (f64, f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let position = monitor.position();
        let size = monitor.size();
        let margin = 24.0;
        return (
            (position.x as f64 + size.width as f64) / scale - BALL_SIZE - margin,
            (position.y as f64 + size.height as f64) / scale - BALL_SIZE - margin * 3.0,
        );
    }
    (120.0, 120.0)
}

fn window_of(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main").ok_or_else(|| "main window is not created".to_string())
}

fn update_ball_pos(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.panel_open.load(Ordering::SeqCst) {
        return;
    }
    let Ok(window) = window_of(app) else { return };
    let Ok(scale) = window.scale_factor() else { return };
    let Ok(position) = window.outer_position() else { return };
    let logical = position.to_logical::<f64>(scale);
    if let Ok(mut slot) = state.ball_pos.lock() {
        *slot = Some((logical.x, logical.y));
    };
}

fn monitor_logical_rect(window: &WebviewWindow, scale: f64) -> Option<(f64, f64, f64, f64)> {
    let monitor = window.current_monitor().ok().flatten()?;
    let position = monitor.position();
    let size = monitor.size();
    Some((
        position.x as f64 / scale,
        position.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    ))
}

fn default_expanded_frame(window: &WebviewWindow, scale: f64, mode: &str) -> (f64, f64, f64, f64) {
    let (mx, my, mw, mh) = monitor_logical_rect(window, scale).unwrap_or((0.0, 0.0, 1280.0, 800.0));
    let (width_ratio, height_ratio) = if mode == "board" {
        (0.90, 0.82)
    } else {
        (0.46, 0.86)
    };
    let width = (mw * width_ratio).clamp(420.0, (mw - 24.0).max(420.0));
    let height = (mh * height_ratio).clamp(480.0, (mh - 48.0).max(480.0));
    let x = mx + (mw - width) / 2.0;
    let y = my + (mh - height) / 2.0;
    (x, y, width, height)
}

fn record_expanded_frame(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.panel_open.load(Ordering::SeqCst) {
        return;
    }
    let mode = state.current_mode.lock().ok().map(|guard| *guard).unwrap_or("ball");
    if mode == "ball" {
        return;
    }
    let Ok(window) = window_of(app) else { return };
    let Ok(scale) = window.scale_factor() else { return };
    let Ok(position) = window.outer_position() else { return };
    let Ok(size) = window.outer_size() else { return };
    let logical_position = position.to_logical::<f64>(scale);
    let logical_size = size.to_logical::<f64>(scale);
    if let Ok(mut frames) = state.expanded_frames.lock() {
        frames.insert(
            mode,
            (logical_position.x, logical_position.y, logical_size.width, logical_size.height),
        );
    };
}

fn set_window_mode(app: &AppHandle, mode: &str) -> Result<(), String> {
    let mode_key: &'static str = match mode {
        "panel" => "panel",
        "board" => "board",
        "ball" => "ball",
        other => return Err(format!("unknown mode: {other}")),
    };
    let expanded = mode_key != "ball";
    let window = window_of(app)?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let current = window.outer_position().map_err(|error| error.to_string())?;
    let logical = current.to_logical::<f64>(scale);
    let (px, py) = (logical.x, logical.y);
    let was_open = app.state::<AppState>().panel_open.load(Ordering::SeqCst);
    let saved_ball = app.state::<AppState>().ball_pos.lock().ok().and_then(|guard| *guard);
    if expanded && !was_open {
        if let Ok(mut slot) = app.state::<AppState>().ball_pos.lock() {
            *slot = Some((px, py));
        };
    }
    // 展开位置与球无关：默认屏幕居中；用户本次运行内调整过则沿用内存中的 frame。
    let (x, y, width, height) = if expanded {
        let saved = app
            .state::<AppState>()
            .expanded_frames
            .lock()
            .ok()
            .and_then(|frames| frames.get(mode_key).copied());
        match saved {
            Some((fx, fy, fw, fh)) => (fx, fy, fw, fh),
            None => default_expanded_frame(&window, scale, mode_key),
        }
    } else {
        let (bx, by) = saved_ball.unwrap_or((px, py));
        let (bx, by) = clamp_ball_position(app, bx, by, scale);
        (bx, by, BALL_SIZE, BALL_SIZE)
    };
    let _ = window.set_always_on_top(!expanded);
    window
        .set_resizable(expanded)
        .map_err(|error| error.to_string())?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    if expanded {
        let _ = window.set_focus();
        // 尺寸/位置变更后系统可能把窗口重新排后；延迟再聚焦一次，确保键盘事件进入 WebView（ESC 可用）。
        let focus_handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            if let Some(win) = focus_handle.get_webview_window("main") {
                let _ = win.set_focus();
            }
        });
    }
    app.state::<AppState>().panel_open.store(expanded, Ordering::SeqCst);
    if let Ok(mut current_mode) = app.state::<AppState>().current_mode.lock() {
        *current_mode = mode_key;
    };
    let _ = app.emit("commander:mode", expanded);
    emit_visibility(app)?;
    save_window(app);
    if let Ok(after) = window.outer_position() {
        let after_logical = after.to_logical::<f64>(scale);
        let state_dir = app.state::<AppState>().config.state_dir.clone();
        let _ = fs::create_dir_all(&state_dir);
        let payload = format!(
            "{{\"mode\":\"{}\",\"target\":[{},{}],\"after\":[{},{}],\"size\":[{},{}],\"scale\":{}}}",
            mode, x, y, after_logical.x, after_logical.y, width, height, scale
        );
        let _ = fs::write(state_dir.join("last-mode.json"), payload);
    }
    Ok(())
}

fn emit_visibility(app: &AppHandle) -> Result<(), String> {
    let window = window_of(app)?;
    let panel_open = app.state::<AppState>().panel_open.load(Ordering::SeqCst);
    send(&OutFrame::Visibility {
        visible: window.is_visible().unwrap_or(false),
        panel_open,
        focused: window.is_focused().unwrap_or(false),
    });
    if let Ok(position) = window.outer_position() {
        if let Ok(size) = window.outer_size() {
            send(&OutFrame::Bounds {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                scale: window.scale_factor().unwrap_or(1.0),
            });
        }
    }
    Ok(())
}

fn save_window(app: &AppHandle) {
    // 面板/看板的位置与大小只在内存里记住；重启恢复默认居中。
    if app.state::<AppState>().panel_open.load(Ordering::SeqCst) {
        return;
    }
    let Ok(window) = window_of(app) else { return };
    let Ok(scale) = window.scale_factor() else { return };
    let now = Instant::now();
    {
        let state = app.state::<AppState>();
        let mut last = match state.last_save.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if now.duration_since(*last) < Duration::from_millis(300) {
            return;
        }
        *last = now;
    }
    let Ok(position) = window.outer_position() else { return };
    let saved = SavedWindow {
        x: Some(position.x as f64 / scale),
        y: Some(position.y as f64 / scale),
        panel_open: Some(app.state::<AppState>().panel_open.load(Ordering::SeqCst)),
    };
    let state_dir = app.state::<AppState>().config.state_dir.clone();
    let _ = fs::create_dir_all(&state_dir);
    if let Ok(text) = serde_json::to_string_pretty(&saved) {
        let _ = fs::write(state_dir.join("window.json"), text);
    }
}

fn load_window(config: &Config) -> Option<SavedWindow> {
    let text = fs::read_to_string(config.state_dir.join("window.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn apply_entry_pos(app: &AppHandle, point: NormalizedPoint) -> Result<(), String> {
    let window = window_of(app)?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let Ok(Some(monitor)) = window.current_monitor() else {
        return Ok(());
    };
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let mx = monitor_position.x as f64 / scale;
    let my = monitor_position.y as f64 / scale;
    let mw = monitor_size.width as f64 / scale;
    let mh = monitor_size.height as f64 / scale;
    let x = (mx + mw * point.x - BALL_SIZE / 2.0).clamp(mx + EDGE_MARGIN, mx + mw - BALL_SIZE - EDGE_MARGIN);
    let y = (my + mh * point.y - BALL_SIZE / 2.0).clamp(my + TOP_MARGIN, my + mh - BALL_SIZE - EDGE_MARGIN);
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------- stdio 控制面

fn spawn_stdin_reader(app: AppHandle) {
    thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<InFrame>(trimmed) {
                Ok(InFrame::Ping { .. }) => send(&OutFrame::Pong { at: now_ms() }),
                Ok(InFrame::Shutdown) => {
                    app.exit(0);
                    break;
                }
                Ok(InFrame::Ready { theme, locale, entry_pos, hotkey, .. }) => {
                    if let Some(theme) = theme {
                        let _ = app.state::<AppState>().config.theme.clone();
                        let _ = theme;
                    }
                    if let Some(locale) = locale {
                        let _ = locale;
                    }
                    if let Some(hotkey) = hotkey {
                        app.state::<AppState>().config.log(&format!("host hotkey hint: {hotkey}"));
                    }
                    if let Some(point) = entry_pos {
                        let _ = apply_entry_pos(&app, point);
                    }
                    let _ = emit_visibility(&app);
                }
                Err(error) => send(&OutFrame::Log {
                    level: "warn".into(),
                    message: format!("bad frame: {error}"),
                }),
            }
        }
        app.exit(0);
    });
}

// Windows 的父进程检测留 P2（当前返回 true，不做误杀）；macOS/Linux 用 kill(pid, 0)。
fn parent_alive(parent_pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(parent_pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        let _ = parent_pid;
        true
    }
}

fn spawn_parent_watchdog(app: AppHandle, parent_pid: u32) {
    if parent_pid == 0 {
        return;
    }
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(2));
        if !parent_alive(parent_pid) {
            app.exit(0);
            return;
        }
    });
}

// ---------------------------------------------------------------- 前端命令

#[tauri::command]
fn set_mode(app: AppHandle, mode: String) -> Result<(), String> {
    set_window_mode(&app, mode.as_str())
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// 打开一个只读会话窗口（同一个壳进程内，不是跳转 DSH）。
#[tauri::command]
fn open_session_window(app: AppHandle, session_id: String) -> Result<(), String> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return Err("sessionId is required".into());
    }
    let safe: String = trimmed
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' })
        .collect();
    let label = format!("session-{safe}");
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let base = app.state::<AppState>().config.window_url.clone();
    let separator = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{separator}session={}", url_encode(trimmed));
    let parsed = url.parse().map_err(|error| format!("invalid session window url: {error}"))?;
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(parsed))
        .title(format!("会话 {trimmed}"))
        .inner_size(560.0, 760.0)
        .min_inner_size(360.0, 400.0)
        .resizable(true)
        .build()
        .map_err(|error| error.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let allowed = url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:");
    if !allowed {
        return Err("only loopback http URLs are allowed".into());
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(&url).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("cmd").args(["/C", "start", "", &url]).status();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(&url).status();
    status.map_err(|error| error.to_string()).map(|_| ())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}
