//! Process-wide structured logging, and the shape of what one call to a
//! provider says about itself when it is written down.
//!
//! Request-level events are emitted by the middleware in [`crate::server`];
//! this module owns the subscriber and the generation line. `RUST_LOG`
//! overrides the default `info` filter (for example `RUST_LOG=debug`).

use crate::domain::Capability;
use crate::generate::adapters::ChannelCall;
use crate::generate::GenerateRequest;
use std::fmt;
use std::time::Duration;
use tracing_subscriber::EnvFilter;

/// Installs the tracing subscriber. Safe to call from more than one runtime
/// entry point: the first call wins and later calls are no-ops.
pub fn init() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
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
    pub channel: String,
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
        call: &ChannelCall,
        request: &GenerateRequest,
        took: Duration,
        bytes: u64,
        status: &str,
    ) -> Self {
        Self {
            channel: call.channel_id.clone(),
            model: call.model_id.clone(),
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
            "generation channel={} model={} capability={} tookMs={} bytes={} status={}",
            self.channel,
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

    fn addressed(capability: Capability) -> ChannelCall {
        let resolved = ResolvedModel {
            reference: "a-channel::painter-1".into(),
            channel_id: "a-channel".into(),
            model_id: "painter-1".into(),
            capability,
            protocol: Protocol::Openai,
            base_url: "https://provider.example".into(),
        };
        ChannelCall::new(&resolved, KEY.to_string(), GenerateConfig::default())
            .expect("a channel is addressed")
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

        for named in ["a-channel", "painter-1", "image", "1204", "184320", "ok"] {
            assert!(line.contains(named), "{line} does not name {named}");
        }
        // What was asked for, what framed it, where it was asked, and what it
        // was asked with: all of it in hand, none of it written down.
        for withheld in [
            KEY,
            "paper lantern",
            "one sentence",
            "provider.example",
            "a-channel::painter-1",
        ] {
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
