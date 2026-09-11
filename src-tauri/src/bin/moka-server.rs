use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use moka_canvas::config::{load_config_file, validate_startup, RuntimeMode};
use moka_canvas::metadata::crypto;
use moka_canvas::server::LocalServer;

#[derive(Parser)]
#[command(name = "moka-server", about = "Serve Moka Canvas over localhost")]
struct Args {
    /// YAML configuration file. Relative paths inside it resolve against the
    /// current working directory. Without this flag, `config/moka.yaml` is read
    /// if it is there and every value stays at its default if it is not; a path
    /// named here has to exist.
    #[arg(long)]
    config: Option<PathBuf>,
    /// Overrides server.staticDir from the configuration file.
    #[arg(long)]
    static_dir: Option<PathBuf>,
    /// Overrides the port in server.bind from the configuration file.
    #[arg(long)]
    port: Option<u16>,
    /// Prints a fresh MOKA_METADATA_KEY value on stdout and exits without
    /// starting the server.
    #[arg(long)]
    generate_key: bool,
    /// Records every call that reaches a provider — the address, the headers, the
    /// prompt and the whole answer — for diagnosing an answer that arrived and
    /// was the wrong thing. Recordings always go to the `records` subdirectory
    /// of the platform application data directory, and credentials in them are
    /// always masked.
    ///
    /// This writes prompts to the disk. See docs/security.md.
    #[arg(long)]
    llm_debug: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    moka_canvas::telemetry::init();
    let args = Args::parse();
    if args.generate_key {
        // The value alone goes to stdout so that it can be captured
        // (`MOKA_METADATA_KEY=$(moka-server --generate-key)`); what to do with
        // it goes to stderr so a pipeline never swallows the instructions.
        let key = crypto::generate_encoded();
        eprintln!(
            "Export this before starting the server, and keep it with the backups \
of the metadata directory:\n\n  export MOKA_METADATA_KEY='{key}'\n\nWithout it \
the server stores a master key in <metadata.dir>/master.key instead, which \
anything able to read that directory can read."
        );
        println!("{key}");
        return Ok(());
    }
    // Settled before anything reads the configuration, so that the three sources
    // are read in one order: what was typed here beats what the environment says,
    // and what the environment says beats what the file says.
    if args.llm_debug {
        moka_canvas::generate::debug::from_cli();
    }
    // A file named on the command line has to be there; the one this program
    // picked for itself may be missing, and then every value stays at its
    // default. The difference is said out loud rather than left to be noticed in
    // an answer that looks like a configuration nobody wrote.
    let typed_config = args.config.is_some();
    let config_path = args
        .config
        .unwrap_or_else(|| PathBuf::from(moka_canvas::config::DEFAULT_CONFIG_PATH));
    let mut config = load_config_file(&config_path, typed_config)?;
    if !typed_config && !config_path.exists() {
        tracing::info!(
            "no configuration file at {}; every value is at its default",
            config_path.display()
        );
    }
    if let Some(static_dir) = args.static_dir {
        config.server.static_dir = static_dir;
    }
    if let Some(port) = args.port {
        config.server.bind = format!("127.0.0.1:{port}");
    }
    let metadata_root = validate_startup(&config, RuntimeMode::Web, None)?;

    let server = LocalServer::start(config, RuntimeMode::Web, &metadata_root).await?;
    println!("Moka Canvas is available at {}", server.url());
    tokio::signal::ctrl_c().await?;
    server.shutdown();
    Ok(())
}
