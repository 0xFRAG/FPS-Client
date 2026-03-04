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
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // With the "deep-link" feature, deep link URLs from new instances
            // are automatically forwarded to on_open_url — nothing to do here.
        }))
        .manage(state as transport::SharedState)
        .invoke_handler(tauri::generate_handler![
            transport::connect,
            transport::disconnect,
            transport::set_input,
            transport::send_chat,
        ])
        .setup(|app| {
            use tauri_plugin_deep_link::DeepLinkExt;

            // Register deep link scheme at runtime (dev mode — no installer)
            #[cfg(debug_assertions)]
            {
                let _ = app.deep_link().register_all();
            }

            // Handle URLs received at startup (cold launch via deep link)
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                let handle = app.handle().clone();
                for url in urls {
                    tracing::info!("startup deep link: {url}");
                    let _ = handle.emit("deep-link", url.to_string());
                }
            }

            // Handle URLs received while app is running
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    tracing::info!("deep link received: {url}");
                    let _ = handle.emit("deep-link", url.to_string());
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
