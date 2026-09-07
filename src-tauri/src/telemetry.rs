//! Process-wide structured logging for the local HTTP server.
//!
//! Request-level events are emitted by the middleware in [`crate::server`];
//! this module only owns the subscriber. `RUST_LOG` overrides the default
//! `info` filter (for example `RUST_LOG=debug`).

use tracing_subscriber::EnvFilter;

/// Installs the tracing subscriber. Safe to call from more than one runtime
/// entry point: the first call wins and later calls are no-ops.
pub fn init() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}
