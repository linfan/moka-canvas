//! Process-wide structured logging, and the shape of what one call to a
//! provider says about itself when it is written down.
//!
//! Request-level events are emitted by the middleware in [`crate::server`];
//! this module owns the subscriber and the generation line. Every line goes to
//! the console and to a daily file under the `logs` subdirectory of the
//! platform application data directory — the same root the metadata directory
//! is resolved from, so the logs of a run sit beside the state it wrote.
//! `RUST_LOG` overrides the default `info` filter (for example
//! `RUST_LOG=debug`).

use crate::domain::Capability;
use crate::generate::adapters::ModelCall;
use crate::generate::GenerateRequest;
use std::fmt;
use std::time::Duration;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

/// Subdirectory of the platform application data directory the log files go
/// into. One file per day, named `moka.log.<date>`, kept rather than rotated
/// away: a log that deletes itself is one a reader cannot go back to.
pub const LOG_DIR_NAME: &str = "logs";

/// Installs the tracing subscriber. Safe to call from more than one runtime
/// entry point: the first call wins and later calls are no-ops.
pub fn init() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let registry = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer());
    match file_writer() {
        // ANSI escapes are for a terminal; a file wants plain text a reader can
        // grep.
        Some((dir, writer)) => {
            let file = tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer);
            let _ = registry.with(file).try_init();
            tracing::info!("writing logs to {}", dir.display());
        }
        // A directory that cannot be had costs the console nothing: logging
        // continues where it can rather than failing the process over a disk.
        None => {
            let _ = registry.try_init();
        }
    }
}

/// The daily log file appender and the directory it writes into, or nothing
/// (with the reason on stderr) when the platform directory cannot be had.
fn file_writer() -> Option<(
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
    Some((
        dir.clone(),
        tracing_appender::rolling::daily(&dir, "moka.log"),
    ))
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
