//! Lua adapter: wraps the Lua runtime behind the ProviderAdapter trait.
//!
//! This module delegates generation calls to Lua converter scripts. The
//! adapter reads which protocol the model uses, finds the matching script,
//! and calls its exported functions to build HTTP requests and parse
//! responses.

use async_trait::async_trait;

use crate::generate::adapters::{for_protocol, ModelCall, ProviderAdapter};
use crate::generate::error::ProviderError;
use crate::generate::media::MediaInput;
use crate::generate::{AsyncTask, Cancel, DeltaSink, GenerateRequest, GenerateResult, TaskState};

/// The shared instance returned by [`for_protocol`] for Lua-backed protocols.
pub(super) static LUA_ADAPTER: LuaAdapter = LuaAdapter;

pub struct LuaAdapter;

impl LuaAdapter {
    /// Returns a reference to the shared adapter instance.
    pub fn get() -> &'static Self {
        &LUA_ADAPTER
    }
}

#[async_trait]
impl ProviderAdapter for LuaAdapter {
    async fn generate(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        for_protocol(call.protocol.clone())
            .generate(call, request, inputs, cancel)
            .await
    }

    async fn generate_stream(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        sink: &DeltaSink,
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        for_protocol(call.protocol.clone())
            .generate_stream(call, request, inputs, sink, cancel)
            .await
    }

    async fn create_task(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        cancel: &Cancel,
    ) -> Result<AsyncTask, ProviderError> {
        for_protocol(call.protocol.clone())
            .create_task(call, request, inputs, cancel)
            .await
    }

    async fn poll_task(
        &self,
        call: &ModelCall,
        task: &AsyncTask,
        cancel: &Cancel,
    ) -> Result<TaskState, ProviderError> {
        for_protocol(call.protocol.clone())
            .poll_task(call, task, cancel)
            .await
    }
}