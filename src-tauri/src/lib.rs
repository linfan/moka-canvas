pub mod api;
pub mod assets;
pub mod config;
pub mod domain;
pub mod generate;
pub mod imaging;
pub mod metadata;
pub mod project;
pub mod server;
pub mod telemetry;
pub mod workflow;

use std::{error::Error, sync::Arc};

use config::RuntimeMode;
use server::LocalServer;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

pub fn run() {
    telemetry::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app: &mut tauri::App| -> Result<(), Box<dyn Error>> {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let resource_dir = app.path().resource_dir()?;
            let config = config::load_native_config(&app_data, &resource_dir)?;
            let metadata_root =
                config::validate_startup(&config, RuntimeMode::Native, Some(&app_data))?;
            let server = Arc::new(tauri::async_runtime::block_on(LocalServer::start(
                config,
                RuntimeMode::Native,
                &metadata_root,
            ))?);
            let url = WebviewUrl::External(server.url().parse()?);

            WebviewWindowBuilder::new(app, "main", url)
                .title("Moka Canvas")
                .inner_size(1280.0, 840.0)
                .min_inner_size(960.0, 640.0)
                .build()?;
            app.manage(server);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Moka Canvas")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                app.state::<Arc<LocalServer>>().shutdown();
            }
        });
}
