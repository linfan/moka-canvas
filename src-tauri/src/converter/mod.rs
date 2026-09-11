//! Protocol converter system: Lua scripts bridge neutral generation types and
//! vendor-specific wire formats.
//!
//! [`runtime`] loads and runs Lua scripts. [`api`] registers the functions a
//! script may call. [`registry`] manages the converter directory, its metadata
//! document, and the list of available protocols. [`deploy`] places built-in
//! scripts on first boot or on version upgrade. [`adapter`] wraps the whole
//! thing behind the [`ProviderAdapter`] trait so the rest of the program sees
//! no difference.

mod adapter;
pub mod api;
pub mod deploy;
pub mod registry;
pub mod runtime;

pub use adapter::LuaAdapter;
pub use registry::{protocol_list, ConverterRegistry};