mod transport;

use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::Mutex;
use transport::TransportState;

pub fn run() {
    let state = Arc::new(Mutex::new(TransportState::default()));

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(state as transport::SharedState)
        .invoke_handler(tauri::generate_handler![
            transport::connect,
            transport::disconnect,
            transport::set_input,
            transport::send_chat,
        ])
        .setup(|app| {
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            // Handle URLs received at startup (e.g. app launched via deep link)
            #[cfg(not(target_os = "macos"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let handle = app.handle().clone();
                    for url in urls {
                        let _ = handle.emit("deep-link", url.to_string());
                    }
                }
            }

            // Listen for deep link URLs received while app is running
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let _ = handle.emit("deep-link", url.to_string());
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
