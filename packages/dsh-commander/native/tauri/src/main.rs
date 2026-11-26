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
const BALL_SIZE: f64 = 76.0;
const EDGE_MARGIN: f64 = 8.0;
const TOP_MARGIN: f64 = 28.0;
/// 常驻球窗口（与历史版本同名，位置文件/集合行为不变）。
const BALL_LABEL: &str = "main";
/// 独立面板窗口：打开面板时显示，收起时隐藏；球窗口始终保留。
const PANEL_LABEL: &str = "panel";
const PANEL_WIDTH: f64 = 420.0;
const PANEL_HEIGHT: f64 = 660.0;
/// 独立气泡窗口：click-through、不抢焦点；只在指挥官忙碌/完成时出现。
const BUBBLE_LABEL: &str = "bubble";
const BUBBLE_WIDTH: f64 = 336.0;
const BUBBLE_HEIGHT: f64 = 76.0;

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
    /// 面板窗口页面是否加载完成；未完成时 set_mode 不 show（由 on_page_load 补显示）。
    panel_ready: AtomicBool,
    /// 气泡窗口页面是否加载完成、当前是否有活动、是否正在被展示。
    bubble_ready: AtomicBool,
    bubble_active: AtomicBool,
    /// 球悬停高亮 + 停留 1.5s 自动唤起快捷输入。
    ball_hover: AtomicBool,
    quick_open: AtomicBool,
    /// 光标离开过球之后才重新允许自动唤起，避免关掉输入后原地反复弹。
    quick_armed: AtomicBool,
    hover_since: Mutex<Option<Instant>>,
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
        panel_ready: AtomicBool::new(false),
        bubble_ready: AtomicBool::new(false),
        bubble_active: AtomicBool::new(false),
        ball_hover: AtomicBool::new(false),
        quick_open: AtomicBool::new(false),
        quick_armed: AtomicBool::new(true),
        hover_since: Mutex::new(None),
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
            if let Err(error) = create_panel_window(app, &setup_config) {
                setup_config.log(&format!("panel window creation failed: {error}"));
            }
            if let Err(error) = create_bubble_window(app, &setup_config) {
                setup_config.log(&format!("bubble window creation failed: {error}"));
            }
            #[cfg(target_os = "macos")]
            spawn_hover_watcher(app.handle().clone());
            register_hotkey(app, &setup_config);
            spawn_stdin_reader(app.handle().clone());
            spawn_parent_watchdog(app.handle().clone(), setup_config.parent_pid);
            send(&OutFrame::Hello {
                protocol: PROTOCOL,
                platform: env::consts::OS.to_string(),
                arch: env::consts::ARCH.to_string(),
                pid: std::process::id(),
                capabilities: vec!["ball".into(), "panel".into(), "bubble".into(), "hotkey".into(), "panel-window".into()],
                hotkey: Some(setup_config.hotkey.clone()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_mode, set_bubble, set_quick_input, set_ball_unread, open_session_window, open_external, quit])
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

/// 在窗口 URL 后追加查询参数（token 已在原 URL 里）。
fn with_query(base: &str, extra: &str) -> String {
    let separator = if base.contains('?') { '&' } else { '?' };
    format!("{base}{separator}{extra}")
}

/// 常驻球窗口：透明置顶 76×76（球 60，四周 8px 透明边给高光/rim/hover）；点击只控制面板窗口，自身永不隐藏。
fn create_window(app: &tauri::App, config: &Config) -> tauri::Result<()> {
    let url = with_query(&config.window_url, "role=ball")
        .parse()
        .map_err(|error| tauri::Error::InvalidUrl(error))?;
    let scale = app.primary_monitor().ok().flatten().map(|monitor| monitor.scale_factor()).unwrap_or(1.0);
    // 重启后固定回主屏右下：旧的 window.json 可能指向已断开的外接屏/屏外坐标，
    // 导致球 visible=true 但落在不可见区域。
    let (x, y) = default_ball_position(app, scale);
    let page_app = app.handle().clone();
    let load_app = page_app.clone();
    let window = WebviewWindowBuilder::new(app, BALL_LABEL, WebviewUrl::External(url))
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
                if let Some(win) = load_app.get_webview_window(BALL_LABEL) {
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
            if let Some(win) = fallback.get_webview_window(BALL_LABEL) {
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
            save_window(&handle);
            if let Some(bubble) = handle.get_webview_window(BUBBLE_LABEL) {
                if bubble.is_visible().unwrap_or(false) {
                    let _ = position_bubble(&handle);
                }
            }
        }
        WindowEvent::Resized(_) => {
            save_window(&handle);
        }
        WindowEvent::Focused(_) => {
            let _ = emit_visibility(&handle);
        }
        WindowEvent::CloseRequested { api, .. } => {
            // 关闭球窗口 = 退出壳，由 Host supervisor 决定是否重启。
            api.prevent_close();
            handle.exit(0);
        }
        _ => {}
    });
    Ok(())
}

/// 面板窗口：页面加载完成前保持隐藏（set_mode 只记录 panel_open），首次打开由 on_page_load 补 show。
fn create_panel_window(app: &tauri::App, config: &Config) -> tauri::Result<()> {
    let url = with_query(&config.window_url, "panel=1&role=panel")
        .parse()
        .map_err(|error| tauri::Error::InvalidUrl(error))?;
    let load_app = app.handle().clone();
    let window = WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::External(url))
        .title("Commander")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(false)
        .skip_taskbar(true)
        .resizable(true)
        .shadow(false)
        .focused(false)
        .accept_first_mouse(true)
        .visible(false)
        .on_page_load(move |_webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let ready = load_app.state::<AppState>();
                ready.panel_ready.store(true, Ordering::SeqCst);
                if let Some(win) = load_app.get_webview_window(PANEL_LABEL) {
                    let _ = win.set_shadow(false);
                    if ready.panel_open.load(Ordering::SeqCst) {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                load_app.state::<AppState>().config.log("panel page loaded");
            }
        })
        .build()?;
    let _ = window.set_shadow(false);
    #[cfg(target_os = "macos")]
    enable_all_spaces(&window);
    let handle = app.handle().clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            record_expanded_frame(&handle);
        }
        WindowEvent::Focused(_) => {
            let _ = emit_visibility(&handle);
        }
        WindowEvent::CloseRequested { api, .. } => {
            // 关闭面板窗口 = 收起面板；球窗口继续驻留，壳不退出。
            api.prevent_close();
            let _ = set_window_mode(&handle, "ball");
        }
        _ => {}
    });
    Ok(())
}

/// 气泡窗口：独立透明窗，click-through，不抢焦点；页面加载完成前保持隐藏。
fn create_bubble_window(app: &tauri::App, config: &Config) -> tauri::Result<()> {
    let url = with_query(&config.window_url, "role=bubble")
        .parse()
        .map_err(|error| tauri::Error::InvalidUrl(error))?;
    let load_app = app.handle().clone();
    let window = WebviewWindowBuilder::new(app, BUBBLE_LABEL, WebviewUrl::External(url))
        .title("Commander")
        .inner_size(BUBBLE_WIDTH, BUBBLE_HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .accept_first_mouse(false)
        .visible(false)
        .on_page_load(move |_webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(win) = load_app.get_webview_window(BUBBLE_LABEL) {
                    let _ = win.set_shadow(false);
                    let _ = win.set_ignore_cursor_events(true);
                }
                let state = load_app.state::<AppState>();
                state.bubble_ready.store(true, Ordering::SeqCst);
                let _ = show_bubble(&load_app);
                state.config.log("bubble page loaded");
            }
        })
        .build()?;
    let _ = window.set_shadow(false);
    let _ = window.set_ignore_cursor_events(true);
    #[cfg(target_os = "macos")]
    enable_all_spaces(&window);
    let handle = app.handle().clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(win) = handle.get_webview_window(BUBBLE_LABEL) {
                let _ = win.hide();
            }
        }
        _ => {}
    });
    Ok(())
}

/// 在球旁边定位气泡窗：优先放在空间足够的一侧，贴边自动翻转，垂直与球心对齐。
fn position_bubble(app: &AppHandle) -> Result<(), String> {
    let Some(ball) = app.get_webview_window(BALL_LABEL) else { return Ok(()) };
    let Some(bubble) = app.get_webview_window(BUBBLE_LABEL) else { return Ok(()) };
    let Ok(scale) = ball.scale_factor() else { return Ok(()) };
    let Ok(position) = ball.outer_position() else { return Ok(()) };
    let Ok(size) = ball.outer_size() else { return Ok(()) };
    let ball_pos = position.to_logical::<f64>(scale);
    let ball_size = size.to_logical::<f64>(scale);
    let (mx, my, mw, mh) = monitor_logical_rect(&ball, scale).unwrap_or((0.0, 0.0, 1280.0, 800.0));
    let margin = 8.0;
    let left_space = ball_pos.x - mx;
    let right_space = mx + mw - (ball_pos.x + ball_size.width);
    let fits_left = left_space >= BUBBLE_WIDTH + margin;
    let fits_right = right_space >= BUBBLE_WIDTH + margin;
    let prefer_left = ball_pos.x + ball_size.width / 2.0 > mx + mw / 2.0;
    let on_left = if prefer_left { fits_left || !fits_right } else { !fits_right && fits_left };
    let x = if on_left { ball_pos.x - BUBBLE_WIDTH } else { ball_pos.x + ball_size.width };
    let y = ball_pos.y + (ball_size.height - BUBBLE_HEIGHT) / 2.0;
    let max_x = (mx + mw - BUBBLE_WIDTH - margin).max(mx + margin);
    let max_y = (my + mh - BUBBLE_HEIGHT - margin).max(my + margin);
    let x = x.clamp(mx + margin, max_x);
    let y = y.clamp(my + margin, max_y);
    bubble
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    let _ = app.emit_to(BUBBLE_LABEL, "commander:bubble-side", if on_left { "left" } else { "right" });
    Ok(())
}

/// 悬停高亮 + 停留 0.8s 自动唤起快捷输入。
///
/// 球窗是 non-key 的 accessory 窗口，WKWebView 不会稳定收到 mouseMoved，CSS :hover
/// 要等第一次点击后才生效。这里用主线程轮询 NSEvent::mouseLocation 和 NSWindow.frame，
/// 自己算光标是否在球圆内，再通过 Tauri event 驱动页面样式；不依赖窗口焦点。
#[cfg(target_os = "macos")]
fn spawn_hover_watcher(app: AppHandle) {
    use objc2_app_kit::{NSEvent, NSWindow};
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(80));
        let handle = app.clone();
        if app
            .run_on_main_thread(move || {
                let Some(window) = handle.get_webview_window(BALL_LABEL) else { return };
                let Ok(pointer) = window.ns_window() else { return };
                let ns = pointer as *mut NSWindow;
                let frame = unsafe { (*ns).frame() };
                let mouse = NSEvent::mouseLocation();
                let cx = frame.origin.x + frame.size.width / 2.0;
                let cy = frame.origin.y + frame.size.height / 2.0;
                let radius = BALL_SIZE / 2.0 - 8.0; // 球体 60px，不含窗口 8px inset
                let inside = (mouse.x - cx).powi(2) + (mouse.y - cy).powi(2) <= radius * radius;
                let state = handle.state::<AppState>();
                let previous = state.ball_hover.swap(inside, Ordering::SeqCst);
                if previous != inside {
                    let _ = handle.emit_to(BALL_LABEL, "commander:ball-hover", inside);
                    // 气泡窗也要知道，用于「空输入 + 光标离开球」时自动收起。
                    let _ = handle.emit_to(BUBBLE_LABEL, "commander:ball-hover", inside);
                }
                if !inside {
                    if let Ok(mut since) = state.hover_since.lock() {
                        *since = None;
                    }
                    state.quick_armed.store(true, Ordering::SeqCst);
                    return;
                }
                if !state.quick_armed.load(Ordering::SeqCst)
                    || state.quick_open.load(Ordering::SeqCst)
                    || state.panel_open.load(Ordering::SeqCst)
                {
                    return;
                }
                let due = {
                    let Ok(mut since) = state.hover_since.lock() else { return };
                    let now = Instant::now();
                    let started = since.get_or_insert(now);
                    now.duration_since(*started) >= Duration::from_millis(800)
                };
                if due {
                    if let Ok(mut since) = state.hover_since.lock() {
                        *since = None;
                    }
                    state.quick_armed.store(false, Ordering::SeqCst);
                    let _ = show_quick_input(&handle);
                }
            })
            .is_err()
        {
            break;
        }
    });
}

/// 快捷输入复用气泡窗：同一个 336×76 透明窗，切到可交互/可聚焦状态。
fn show_quick_input(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.panel_open.load(Ordering::SeqCst) || state.quick_open.load(Ordering::SeqCst) {
        return Ok(());
    }
    if !state.bubble_ready.load(Ordering::SeqCst) {
        return Ok(());
    }
    let Some(window) = app.get_webview_window(BUBBLE_LABEL) else { return Ok(()) };
    state.quick_open.store(true, Ordering::SeqCst);
    if let Err(error) = position_bubble(app) {
        state.quick_open.store(false, Ordering::SeqCst);
        return Err(error);
    }
    let _ = window.set_ignore_cursor_events(false);
    window.show().map_err(|error| error.to_string())?;
    let _ = window.set_focus();
    let _ = app.emit_to(BUBBLE_LABEL, "commander:quick-input", true);
    Ok(())
}

fn close_quick_input(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let was_open = state.quick_open.swap(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(BUBBLE_LABEL) {
        let _ = window.set_ignore_cursor_events(true);
        let _ = window.hide();
    }
    if was_open {
        let _ = app.emit_to(BUBBLE_LABEL, "commander:quick-input", false);
    }
    Ok(())
}

fn show_bubble(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if !state.bubble_active.load(Ordering::SeqCst)
        || !state.bubble_ready.load(Ordering::SeqCst)
        || state.panel_open.load(Ordering::SeqCst)
    {
        return Ok(());
    }
    let Some(window) = app.get_webview_window(BUBBLE_LABEL) else { return Ok(()) };
    position_bubble(app)?;
    window.show().map_err(|error| error.to_string())?;
    let _ = window.set_ignore_cursor_events(true);
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

fn write_window_debug(app: &AppHandle, stage: &str) {
    let Some(window) = app.get_webview_window(BALL_LABEL) else { return };
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

fn ball_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(BALL_LABEL).ok_or_else(|| "main window is not created".to_string())
}

fn panel_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(PANEL_LABEL).ok_or_else(|| "panel window is not created".to_string())
}

fn update_ball_pos(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(window) = ball_window(app) else { return };
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
    let Ok(window) = panel_window(app) else { return };
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
    let state = app.state::<AppState>();
    if expanded {
        let _ = close_quick_input(app);
        if let Some(bubble) = app.get_webview_window(BUBBLE_LABEL) {
            let _ = bubble.hide();
        }
        let window = panel_window(app)?;
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        // 面板位置与球无关：默认屏幕居中；用户本次运行内调整过则沿用内存中的 frame。
        let saved = state
            .expanded_frames
            .lock()
            .ok()
            .and_then(|frames| frames.get(mode_key).copied());
        let (x, y, width, height) = match saved {
            Some((fx, fy, fw, fh)) => (fx, fy, fw, fh),
            None => default_expanded_frame(&window, scale, mode_key),
        };
        let _ = window.set_resizable(true);
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|error| error.to_string())?;
        window
            .set_position(LogicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
        let _ = window.set_always_on_top(false);
        // 球窗口永远置顶常驻：面板打开不隐藏、不移动球（用户反馈：点开后球不能消失）。
        if let Ok(ball) = ball_window(app) {
            let _ = ball.set_always_on_top(true);
        }
        // 页面未就绪时不 show（避免空白窗），由 on_page_load 看到 panel_open=true 后补显示。
        if state.panel_ready.load(Ordering::SeqCst) {
            window.show().map_err(|error| error.to_string())?;
        }
        let _ = window.set_focus();
        // 尺寸/位置变更后系统可能把窗口重新排后；延迟再聚焦一次，确保键盘事件进入 WebView（ESC 可用）。
        let focus_handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            if let Some(win) = focus_handle.get_webview_window(PANEL_LABEL) {
                let _ = win.set_focus();
            }
        });
        if let Ok(after) = window.outer_position() {
            let after_logical = after.to_logical::<f64>(scale);
            let state_dir = state.config.state_dir.clone();
            let _ = fs::create_dir_all(&state_dir);
            let payload = format!(
                "{{\"mode\":\"{}\",\"target\":[{},{}],\"after\":[{},{}],\"size\":[{},{}],\"scale\":{}}}",
                mode, x, y, after_logical.x, after_logical.y, width, height, scale
            );
            let _ = fs::write(state_dir.join("last-mode.json"), payload);
        }
    } else if let Some(window) = app.get_webview_window(PANEL_LABEL) {
        let _ = window.hide();
    }
    state.panel_open.store(expanded, Ordering::SeqCst);
    if let Ok(mut current_mode) = state.current_mode.lock() {
        *current_mode = mode_key;
    };
    let _ = app.emit("commander:mode", expanded);
    emit_visibility(app)?;
    if !expanded {
        save_window(app);
        let _ = show_bubble(app);
    }
    Ok(())
}

fn emit_visibility(app: &AppHandle) -> Result<(), String> {
    let window = ball_window(app)?;
    let panel_open = app.state::<AppState>().panel_open.load(Ordering::SeqCst);
    let panel_focused = app
        .get_webview_window(PANEL_LABEL)
        .map(|win| win.is_focused().unwrap_or(false))
        .unwrap_or(false);
    send(&OutFrame::Visibility {
        visible: window.is_visible().unwrap_or(false),
        panel_open,
        focused: window.is_focused().unwrap_or(false) || panel_focused,
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
    // window.json 只存球的位置；面板/看板 frame 只在内存里记住，重启恢复默认居中。
    let Ok(window) = ball_window(app) else { return };
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
    let window = ball_window(app)?;
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
fn set_bubble(app: AppHandle, visible: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    // 快捷输入打开时由它独占气泡窗；状态气泡的显隐等关闭后再由页面重新驱动。
    if state.quick_open.load(Ordering::SeqCst) {
        return Ok(());
    }
    state.bubble_active.store(visible, Ordering::SeqCst);
    if visible {
        return show_bubble(&app);
    }
    if let Some(window) = app.get_webview_window(BUBBLE_LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_ball_unread(app: AppHandle, unread: bool) -> Result<(), String> {
    let _ = app.emit_to(BALL_LABEL, "commander:ball-unread", unread);
    Ok(())
}

#[tauri::command]
fn set_quick_input(app: AppHandle, open: bool) -> Result<(), String> {
    if open {
        show_quick_input(&app)
    } else {
        close_quick_input(&app)
    }
}

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
