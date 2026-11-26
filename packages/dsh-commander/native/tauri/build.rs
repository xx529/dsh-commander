fn main() {
    // 自定义命令需要显式生成 ACL 权限（allow-set-mode 等），否则远程页 invoke 会报
    // "Command set_mode not allowed by ACL"。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["set_mode", "set_bubble", "set_quick_input", "set_ball_unread", "open_session_window", "open_external", "quit"]),
        ),
    )
    .expect("tauri-build failed");
}
