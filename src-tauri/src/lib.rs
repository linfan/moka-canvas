pub mod assets;
pub mod config;
pub mod domain;
pub mod project;
pub mod server;

use std::{error::Error, sync::Arc};

use server::LocalServer;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

pub fn run() {
    tauri::Builder::default()
        .setup(|app: &mut tauri::App| -> Result<(), Box<dyn Error>> {
            let static_dir = app.path().resource_dir()?.join("web");
            let server = Arc::new(tauri::async_runtime::block_on(LocalServer::start(
                static_dir, "tauri",
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
