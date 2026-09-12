//! Process-wide structured logging, and the shape of what one call to a
//! provider says about itself when it is written down.
//!
//! Request-level events are emitted by the middleware in [`crate::server`];
//! this module owns the subscriber and the generation line. Every line goes to
//! a daily file under the `logs` subdirectory of the platform application data
//! directory — the same root the metadata directory is resolved from, so the
//! logs of a run sit beside the state it wrote. The two runtimes write two
//! files, `moka-app.log.<date>` for the desktop app and
//! `moka-server.log.<date>` for the server binary, so a line in one is never
//! mistaken for a line in the other.
//!
//! The desktop app writes to the file alone: a windowed program has no console
//! to read and a line on stdout or stderr is a line nobody sees, so what the
//! file does not carry is lost. The server binary also keeps the console layer,
//! because it is started from a terminal by somebody watching it.
//!
//! The filter defaults to `info` and `RUST_LOG` overrides it in both runtimes
//! (for example `RUST_LOG=debug`). The desktop app can also be told from the
//! disk it runs on: a `log.level` file beside the `logs` directory —
//! `%APPDATA%\MokaCanvas\log.level` on Windows,
//! `~/Library/Application Support/MokaCanvas/log.level` on
//! macOS, `~/.local/share/mokacanvas/log.level` on Linux (the XDG path is
//! lowercased) —
//! holding one filter directive (such as `debug`) is read at startup,
//! because a program started by a double-click inherits no environment worth
//! setting. `RUST_LOG` wins over the file when both are there.

use crate::domain::Capability;
use crate::generate::adapters::ModelCall;
use crate::generate::GenerateRequest;
use std::fmt;
use std::time::Duration;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

/// Subdirectory of the platform application data directory the log files go
/// into. One file per day per runtime, named `moka-app.log.<date>` or
/// `moka-server.log.<date>`, kept rather than rotated away: a log that deletes
/// itself is one a reader cannot go back to.
pub const LOG_DIR_NAME: &str = "logs";

/// The file, beside [`LOG_DIR_NAME`], that tells the desktop app its filter
/// when `RUST_LOG` is not set — a double-clicked program inherits no
/// environment, so the level it logs at has to be somewhere it can read.
pub const LOG_LEVEL_FILE_NAME: &str = "log.level";

/// The daily file prefix of the desktop app.
const APP_FILE_PREFIX: &str = "moka-app.log";

/// The daily file prefix of the server binary.
const SERVER_FILE_PREFIX: &str = "moka-server.log";

/// The filter nothing else overrides.
const DEFAULT_FILTER: &str = "info";

/// Installs the tracing subscriber for the desktop app: the daily file and
/// nothing else, at the level `RUST_LOG` or the `log.level` file asks for, and
/// a panic hook so a crash is a line in the file rather than a window that
/// closed. Safe to call from more than one runtime entry point: the first call
/// wins and later calls are no-ops.
pub fn init_app() {
    std::panic::set_hook(Box::new(|info| {
        tracing::error!("panic: {info}");
    }));
    install(false, APP_FILE_PREFIX, app_filter());
}

/// Installs the tracing subscriber for the server binary: the console, for the
/// terminal it was started from, and the daily file beside it. `RUST_LOG`
/// overrides the default `info` filter (for example `RUST_LOG=debug`).
pub fn init() {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));
    install(true, SERVER_FILE_PREFIX, filter);
}

/// The filter the desktop app runs under: what the environment says, else what
/// the `log.level` file says, else the default.
fn app_filter() -> EnvFilter {
    if let Ok(filter) = EnvFilter::try_from_default_env() {
        return filter;
    }
    level_file_filter().unwrap_or_else(|| EnvFilter::new(DEFAULT_FILTER))
}

/// The filter the `log.level` file names, or nothing when the file is absent,
/// blank, or says something that is not a filter. A file that cannot be read
/// costs the app nothing: it logs at the default rather than failing over a
/// file that is only there to help.
fn level_file_filter() -> Option<EnvFilter> {
    let root = crate::metadata::paths::platform_default().ok()?;
    let path = root.join(LOG_LEVEL_FILE_NAME);
    let directive = std::fs::read_to_string(&path).ok()?;
    let directive = directive.trim();
    if directive.is_empty() {
        return None;
    }
    match EnvFilter::try_new(directive) {
        Ok(filter) => Some(filter),
        Err(error) => {
            // The file is read before the subscriber exists, so the only place
            // this complaint can go is the console that, on the desktop, nobody
            // is looking at — and the default filter, which is the safe one.
            eprintln!(
                "{} is not a log filter ({error}); logging at {DEFAULT_FILTER}",
                path.display()
            );
            None
        }
    }
}

/// Installs the subscriber: the file always, and the console only where a
/// console is being watched.
fn install(console: bool, file_prefix: &str, filter: EnvFilter) {
    let registry = tracing_subscriber::registry().with(filter);
    match (console, file_writer(file_prefix)) {
        (true, Some((dir, writer))) => {
            let _ = registry
                .with(tracing_subscriber::fmt::layer())
                .with(file_layer(writer))
                .try_init();
            tracing::info!("writing logs to {}", dir.display());
        }
        (false, Some((dir, writer))) => {
            let _ = registry.with(file_layer(writer)).try_init();
            tracing::info!("writing logs to {}", dir.display());
        }
        // A directory that cannot be had costs the server nothing: logging
        // continues on the console where it can rather than failing the process
        // over a disk. For the app it means no log at all, and that is said
        // where the app can still say it — before the window is built, while a
        // stderr redirection is the one channel anybody could have attached.
        (true, None) => {
            let _ = registry.with(tracing_subscriber::fmt::layer()).try_init();
        }
        (false, None) => {
            let _ = registry.try_init();
        }
    }
}

/// The layer that writes the daily file. ANSI escapes are for a terminal; a
/// file wants plain text a reader can grep. Generic over the subscriber it is
/// stacked on, which is whatever the branch that asks for it has built.
fn file_layer<S>(
    writer: tracing_appender::rolling::RollingFileAppender,
) -> tracing_subscriber::fmt::Layer<
    S,
    tracing_subscriber::fmt::format::DefaultFields,
    tracing_subscriber::fmt::format::Format,
    tracing_appender::rolling::RollingFileAppender,
>
where
    S: tracing::Subscriber,
{
    tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(writer)
}

/// The daily log file appender and the directory it writes into, or nothing
/// (with the reason on stderr) when the platform directory cannot be had.
fn file_writer(
    prefix: &str,
) -> Option<(
    std::path::PathBuf,
    tracing_appender::rolling::RollingFileAppender,
)> {
    let root = match crate::metadata::paths::platform_default() {
        Ok(root) => root,
        Err(error) => {
            eprintln!("logs stay on the console only: {error}");
            return None;
        }
    };
    let dir = root.join(LOG_DIR_NAME);
    if let Err(error) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "logs stay on the console only: cannot create {}: {error}",
            dir.display()
        );
        return None;
    }
    private_directory(&dir);
    Some((dir.clone(), tracing_appender::rolling::daily(&dir, prefix)))
}

/// A directory only its owner can read, held the way the metadata and
/// recording directories are: the lines inside name the paths one deployment
/// serves, which is nobody else's business.
#[cfg(unix)]
fn private_directory(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;

    if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)) {
        eprintln!("cannot protect {}: {error}", path.display());
    }
}

#[cfg(not(unix))]
fn private_directory(path: &std::path::Path) {
    let _ = path;
}

/// One call to a provider, as it is worth remembering.
///
/// Every field is a name, a count, a length of time or an outcome. What was
/// asked for and what came back are neither, and that is why the line is built
/// here rather than written at the call: a prompt in a log file is somebody's
/// work left somewhere nobody meant to keep it, and a credential in one is a key
/// that outlived the call it was fetched for. The shape keeps both out, so
/// keeping them out is not something every caller has to remember.
pub struct GenerationNote {
    /// The model configuration the call was placed with.
    pub config: String,
    pub model: String,
    pub capability: Capability,
    pub took: Duration,
    pub bytes: u64,
    pub status: String,
}

impl GenerationNote {
    /// What one call is worth saying, built out of everything the call has to
    /// hand — including the two things that must not be said.
    pub fn of(
        call: &ModelCall,
        request: &GenerateRequest,
        took: Duration,
        bytes: u64,
        status: &str,
    ) -> Self {
        Self {
            config: call.config_id.clone(),
            model: call.model.clone(),
            capability: request.capability,
            took,
            bytes,
            status: status.to_string(),
        }
    }
}

impl fmt::Display for GenerationNote {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "generation config={} model={} capability={} tookMs={} bytes={} status={}",
            self.config,
            self.model,
            self.capability.as_str(),
            self.took.as_millis(),
            self.bytes,
            self.status
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::GenerateConfig;
    use crate::generate::ResolvedModel;
    use crate::metadata::Protocol;

    /// The credential a call carries. It exists for as long as the call does,
    /// which is exactly as long as a log line must not.
    const KEY: &str = "sk-secret-1234567890abcd";

    fn addressed(capability: Capability) -> ModelCall {
        let resolved = ResolvedModel {
            config_id: "painter-config".into(),
            model: "painter-1".into(),
            display_name: "Painter".into(),
            category: capability,
            protocol: Protocol::OpenaiImages,
            url: "https://provider.example/v1/images/generations".into(),
        };
        ModelCall::new(&resolved, KEY.to_string(), GenerateConfig::default())
            .expect("a model is addressed")
    }

    #[test]
    fn a_note_names_the_call_and_carries_none_of_what_it_held() {
        let call = addressed(Capability::Image);
        let request = GenerateRequest {
            capability: Capability::Image,
            prompt: "a paper lantern over a quiet lake".into(),
            system: Some("answer in one sentence".into()),
            ..GenerateRequest::default()
        };
        let note = GenerationNote::of(&call, &request, Duration::from_millis(1204), 184_320, "ok");
        let line = note.to_string();

        for named in [
            "painter-config",
            "painter-1",
            "image",
            "1204",
            "184320",
            "ok",
        ] {
            assert!(line.contains(named), "{line} does not name {named}");
        }
        // What was asked for, what framed it, where it was asked, and what it
        // was asked with: all of it in hand, none of it written down.
        for withheld in [KEY, "paper lantern", "one sentence", "provider.example"] {
            assert!(!line.contains(withheld), "{line} carries {withheld}");
        }
    }

    #[test]
    fn a_failure_is_named_by_its_code_rather_than_by_its_answer() {
        let call = addressed(Capability::Text);
        let request = GenerateRequest {
            capability: Capability::Text,
            prompt: "say something".into(),
            ..GenerateRequest::default()
        };
        let line = GenerationNote::of(
            &call,
            &request,
            Duration::from_secs(30),
            0,
            "PROVIDER_TIMEOUT",
        )
        .to_string();
        assert!(line.contains("PROVIDER_TIMEOUT"), "{line}");
        assert!(line.contains("bytes=0"), "nothing came back: {line}");
        assert!(!line.contains("say something"), "{line}");
    }
}
