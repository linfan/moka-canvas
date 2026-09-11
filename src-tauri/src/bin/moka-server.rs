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
    /// current working directory.
    #[arg(long, default_value = "config/moka.example.yaml")]
    config: PathBuf,
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
    /// prompt and the whole answer — into a directory, for diagnosing an answer
    /// that arrived and was the wrong thing. Takes an optional directory; without
    /// one, recordings go to <metadata.dir>/llm-debug.
    ///
    /// This writes prompts and, unless generate.debug.redactCredentials is set
    /// otherwise, masked credentials to the disk. See docs/security.md.
    #[arg(long, num_args = 0..=1, value_name = "DIR")]
    llm_debug: Option<Option<PathBuf>>,
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
    if let Some(dir) = args.llm_debug {
        moka_canvas::generate::debug::from_cli(dir);
    }
    let mut config = load_config_file(&args.config)?;
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
