mod transport;

use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::Mutex;
use transport::TransportState;

#[tauri::command]
fn capture_mouse(window: tauri::WebviewWindow) -> Result<(), String> {
    window.set_cursor_grab(true).map_err(|e| e.to_string())?;
    window.set_cursor_visible(false).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn release_mouse(window: tauri::WebviewWindow) -> Result<(), String> {
    window.set_cursor_grab(false).map_err(|e| e.to_string())?;
    window.set_cursor_visible(true).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    // Write panics to a crash log next to the executable
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("{info}\n");
        let path = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("crash.log")))
            .unwrap_or_else(|| std::path::PathBuf::from("crash.log"));
        let _ = std::fs::write(&path, &msg);
        eprintln!("{msg}");
    }));

    tracing_subscriber::fmt::init();

    let state = Arc::new(Mutex::new(TransportState::default()));

    let mut app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(state as transport::SharedState)
        .invoke_handler(tauri::generate_handler![
            transport::connect,
            transport::disconnect,
            transport::set_input,
            transport::send_chat,
            capture_mouse,
            release_mouse,
        ])
        .build(tauri::generate_context!())
        .expect("error building tauri application");

    app.set_device_event_filter(tauri::DeviceEventFilter::Never);

    app.run(|app_handle, event| {
        if let tauri::RunEvent::MouseMotion { dx, dy, .. } = event {
            let _ = app_handle.emit("mouse-delta", serde_json::json!({"dx": dx, "dy": dy}));
        }
    });
}
