pub mod api;
pub mod assets;
pub mod clip;
pub mod config;
pub mod converter;
pub mod domain;
pub mod generate;
pub mod imaging;
pub mod metadata;
pub mod project;
pub mod prompts;
pub mod server;
pub mod telemetry;
pub mod workflow;

use std::{error::Error, sync::Arc};

use config::RuntimeMode;
use server::LocalServer;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

pub fn run() {
    telemetry::init_app();
    let built = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app: &mut tauri::App| -> Result<(), Box<dyn Error>> {
            // The metadata directory is keyed to the product name, not to
            // the bundle identifier Tauri's `app_data_dir()` is derived from:
            // the server binary and the desktop app must land in the same
            // place, and the server has no bundle identifier to ask.
            let app_data = metadata::paths::platform_default()?;
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
        .build(tauri::generate_context!());
    let app = match built {
        Ok(app) => app,
        Err(error) => {
            // A startup that fails has to say so somewhere a reader will look:
            // the file telemetry opened, not a console a windowed program does
            // not have.
            tracing::error!("failed to build Moka Canvas: {error}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            app.state::<Arc<LocalServer>>().shutdown();
        }
    });
}
