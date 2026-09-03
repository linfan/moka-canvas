use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use moka_canvas::server::LocalServer;

#[derive(Parser)]
#[command(name = "moka-server", about = "Serve Moka Canvas over localhost")]
struct Args {
    #[arg(long, default_value = "dist")]
    static_dir: PathBuf,
    #[arg(long, default_value_t = 8080)]
    port: u16,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let server = LocalServer::start_on(args.static_dir, args.port, "web").await?;
    println!("Moka Canvas is available at {}", server.url());
    tokio::signal::ctrl_c().await?;
    server.shutdown();
    Ok(())
}
