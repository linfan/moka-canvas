//! Talking to generation providers.
//!
//! [`providers`] is the configuration domain — channels, model references,
//! and what may be disclosed about a stored credential. [`error`] names what
//! can go wrong on the provider side, which is a different thing from what
//! can go wrong on the storage side: the client recovers from the first by
//! opening Settings and from the second by retrying.

pub mod error;
pub mod providers;

pub use error::ProviderError;
pub use providers::{ProviderRepo, ResolvedModel};
