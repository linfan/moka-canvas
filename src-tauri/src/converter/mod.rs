//! Protocol converter system: Lua scripts bridge neutral generation types and
//! vendor-specific wire formats.
//!
//! [`runtime`] loads and runs Lua scripts. [`api`] registers the functions a
//! script may call. [`registry`] reads the models directory — one directory
//! per converter, each carrying its own `model.json` — as the list of
//! available protocols. [`deploy`] places built-in converters on first boot or
//! on version upgrade. [`adapter`] wraps the whole thing behind the
//! [`ProviderAdapter`] trait so the rest of the program sees no difference.

mod adapter;
pub mod api;
pub mod deploy;
pub mod registry;
pub mod runtime;

pub use adapter::{converter_root, LuaAdapter};
pub use registry::ConverterRegistry;
