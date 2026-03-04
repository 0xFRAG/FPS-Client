mod transport;

use std::sync::Arc;
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
            // Register deep link scheme at runtime (dev mode only — production
            // uses the NSIS installer to write registry entries)
            #[cfg(debug_assertions)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
