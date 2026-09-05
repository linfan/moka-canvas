use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use moka_canvas::config::{load_config_file, validate_startup, RuntimeMode};
use moka_canvas::server::LocalServer;

#[derive(Parser)]
#[command(name = "moka-server", about = "Serve Moka Canvas over localhost")]
struct Args {
    /// YAML configuration file. Relative paths inside it resolve against the
    /// current working directory.
    #[arg(long, default_value = "config/moka.example.yaml")]
    config: PathBuf,
    /// Overrides server.staticDir from the configuration file.
    #[arg(long)]
    static_dir: Option<PathBuf>,
    /// Overrides the port in server.bind from the configuration file.
    #[arg(long)]
    port: Option<u16>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mut config = load_config_file(&args.config)?;
    if let Some(static_dir) = args.static_dir {
        config.server.static_dir = static_dir;
    }
    if let Some(port) = args.port {
        config.server.bind = format!("127.0.0.1:{port}");
    }
    validate_startup(&config)?;

    let server = LocalServer::start(config, RuntimeMode::Web).await?;
    println!("Moka Canvas is available at {}", server.url());
    tokio::signal::ctrl_c().await?;
    server.shutdown();
    Ok(())
}
