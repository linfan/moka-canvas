//! Lua adapter: wraps the Lua runtime behind the ProviderAdapter trait.
//!
//! This module executes Lua converter scripts to build HTTP requests and parse
//! responses, enabling new vendor protocols without recompiling the backend.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use super::registry::{ConverterRegistry, ProtocolEntry};
use super::runtime::LuaRuntime;
use crate::domain::Capability;
use crate::generate::adapters::{ModelCall, ProviderAdapter};
use crate::generate::error::ProviderError;
use crate::generate::media::MediaInput;
use crate::generate::{
    AsyncTask, Cancel, DeltaSink, GenerateRequest, GenerateResult, GeneratedItem, TaskState,
};

/// The ceiling for downloading media from a URL returned by a Lua script.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;

static CONVERTER_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Sets the converter root directory. Called once during startup after deploy.
pub fn set_converter_root(root: PathBuf) {
    let _ = CONVERTER_ROOT.set(root);
}

/// The converter root directory, once startup has set it. Model validation
/// reads the registry through it to learn which Lua protocols exist.
pub fn converter_root() -> Option<&'static Path> {
    CONVERTER_ROOT.get().map(PathBuf::as_path)
}

/// The shared instance returned by [`for_protocol`] for Lua-backed protocols.
pub(super) static LUA_ADAPTER: LuaAdapter = LuaAdapter;

pub struct LuaAdapter;

impl LuaAdapter {
    /// Returns a reference to the shared adapter instance.
    pub fn get() -> &'static Self {
        &LUA_ADAPTER
    }

    /// Returns the protocol name from a LuaScript protocol.
    fn protocol_name(call: &ModelCall) -> Result<&str, ProviderError> {
        match &call.protocol {
            crate::metadata::Protocol::LuaScript(name) => Ok(name),
            _ => Err(ProviderError::invalid("not a Lua-backed protocol")),
        }
    }

    /// Looks up the protocol entry from the converter registry.
    async fn lookup_entry(protocol: &str) -> Result<ProtocolEntry, ProviderError> {
        let root = CONVERTER_ROOT
            .get()
            .ok_or_else(|| ProviderError::invalid("converter root not initialised"))?;
        let registry = ConverterRegistry::load(root).await;
        registry.find(protocol).cloned().ok_or_else(|| {
            ProviderError::invalid(format!("no converter script for protocol '{protocol}'"))
        })
    }

    /// Runs a Lua function synchronously. The runtime is created, the script is
    /// loaded, the function is called, and everything is dropped before return,
    /// so this can live inside an async fn without holding non-Send state
    /// across an await point.
    fn call_lua(
        entry: &ProtocolEntry,
        func: &str,
        args: Vec<Value>,
    ) -> Result<Value, ProviderError> {
        let root = CONVERTER_ROOT
            .get()
            .ok_or_else(|| ProviderError::invalid("converter root not initialised"))?;
        let script_path = root.join(&entry.script);
        let runtime = LuaRuntime::new()
            .map_err(|e| ProviderError::invalid(format!("Lua runtime failed: {e}")))?;
        let script = runtime.load(&script_path).map_err(|e| {
            ProviderError::invalid(format!("failed to load script '{}': {e}", entry.script))
        })?;
        runtime
            .call_json_value(&script, func, args)
            .map_err(|e| ProviderError::invalid(format!("Lua '{func}' failed: {e}")))
    }

    /// Converts a `ModelCall` to a JSON value the Lua scripts understand.
    fn call_to_json(call: &ModelCall) -> Value {
        serde_json::json!({
            "url": call.url,
            "model": call.model,
        })
    }

    /// Converts a `GenerateRequest` to a JSON value.
    fn request_to_json(request: &GenerateRequest) -> Value {
        serde_json::json!({
            "prompt": request.prompt,
            "params": request.params,
        })
    }

    /// Converts `MediaInput`s to a JSON array.
    fn inputs_to_json(inputs: &[MediaInput]) -> Value {
        let list: Vec<Value> = inputs
            .iter()
            .map(|input| {
                serde_json::json!({
                    "role": input.role.as_str(),
                    "data_url": input.data_url(),
                })
            })
            .collect();
        Value::Array(list)
    }

    /// Executes an HTTP request built from the Lua script's return value.
    async fn execute(
        call: &ModelCall,
        request_def: &Value,
    ) -> Result<(u16, String, String), ProviderError> {
        let method = request_def["method"].as_str().unwrap_or("POST");
        let url = request_def["url"]
            .as_str()
            .ok_or_else(|| ProviderError::invalid("Lua script returned no URL"))?;
        let headers = request_def["headers"].as_object();

        let builder = match method {
            "GET" => call.get(url),
            _ => call.post_at(url),
        };

        let mut builder = builder;
        if let Some(hdrs) = headers {
            for (key, value) in hdrs {
                if let Some(val) = value.as_str() {
                    builder = builder.header(key.as_str(), val);
                }
            }
        }

        let builder = if method != "GET" {
            if let Some(body) = request_def["body"].as_str() {
                builder.body(body.to_string())
            } else {
                return Err(ProviderError::invalid(
                    "Lua script returned no body for POST",
                ));
            }
        } else {
            builder
        };

        let response = builder
            .timeout(call.budgets.timeout_for(Capability::Audio))
            .send()
            .await
            .map_err(|e| ProviderError::Unreachable(e.to_string()))?;

        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let body_bytes = response
            .bytes()
            .await
            .map_err(|e| ProviderError::Unreachable(e.to_string()))?
            .to_vec();
        let body_str = String::from_utf8_lossy(&body_bytes).to_string();

        Ok((status, format!("{headers:?}"), body_str))
    }

    /// Downloads a single item from a URL.
    async fn download_item(
        call: &ModelCall,
        url: &str,
        mime: &str,
        kind: Capability,
    ) -> Result<GeneratedItem, ProviderError> {
        let response = call
            .fetch(url)
            .timeout(DOWNLOAD_TIMEOUT)
            .send()
            .await
            .map_err(|e| ProviderError::Unreachable(e.to_string()))?;
        let status = response.status().as_u16();
        if status < 200 || status >= 300 {
            return Err(ProviderError::Rejected(format!(
                "download from '{url}' returned status {status}"
            )));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| ProviderError::Unreachable(e.to_string()))?
            .to_vec();
        if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err(ProviderError::TooLarge(format!(
                "downloaded media exceeds {MAX_DOWNLOAD_BYTES} bytes"
            )));
        }
        Ok(GeneratedItem {
            bytes,
            mime: mime.to_string(),
            kind,
            width: None,
            height: None,
            duration_ms: None,
        })
    }

    /// Extracts URL-based items from a Lua parse_response result.
    fn collect_url_items(items_val: &Value) -> Vec<(String, String)> {
        let items = match items_val {
            Value::Array(list) => list,
            _ => return Vec::new(),
        };
        items
            .iter()
            .filter_map(|item| {
                let obj = item.as_object()?;
                let url = obj.get("url")?.as_str()?;
                let mime = obj
                    .get("mime")
                    .and_then(|v| v.as_str())
                    .unwrap_or("audio/mpeg");
                Some((url.to_string(), mime.to_string()))
            })
            .collect()
    }
}

#[async_trait]
impl ProviderAdapter for LuaAdapter {
    async fn generate(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        _cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        let protocol = Self::protocol_name(call)?;
        let entry = Self::lookup_entry(protocol).await?;

        // Call build_request — LuaRuntime is dropped here, no Send issue.
        let req_def = Self::call_lua(
            &entry,
            "build_request",
            vec![
                Self::call_to_json(call),
                Self::request_to_json(request),
                Self::inputs_to_json(inputs),
            ],
        )?;

        let (status, headers, body) = Self::execute(call, &req_def).await?;

        let parsed = Self::call_lua(
            &entry,
            "parse_response",
            vec![
                Value::Number(serde_json::Number::from(status)),
                Value::String(headers),
                Value::String(body),
            ],
        )?;

        if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
            return Err(ProviderError::Rejected(err.to_string()));
        }

        let kind = request.capability;
        let mut items = Vec::new();
        if let Some(items_val) = parsed.get("items") {
            for (url, mime) in Self::collect_url_items(items_val) {
                items.push(Self::download_item(call, &url, &mime, kind).await?);
            }
        }

        let text = parsed
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        Ok(GenerateResult {
            text,
            items,
            usage: None,
        })
    }

    async fn generate_stream(
        &self,
        _call: &ModelCall,
        _request: &GenerateRequest,
        _inputs: &[MediaInput],
        _sink: &DeltaSink,
        _cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        Err(ProviderError::invalid(
            "Lua-backed protocols do not support streaming yet",
        ))
    }

    async fn create_task(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        _cancel: &Cancel,
    ) -> Result<AsyncTask, ProviderError> {
        let protocol = Self::protocol_name(call)?;
        let entry = Self::lookup_entry(protocol).await?;

        let req_def = Self::call_lua(
            &entry,
            "build_task_request",
            vec![
                Self::call_to_json(call),
                Self::request_to_json(request),
                Self::inputs_to_json(inputs),
            ],
        )?;

        let (status, _headers, body) = Self::execute(call, &req_def).await?;

        let parsed = Self::call_lua(
            &entry,
            "parse_task_response",
            vec![
                Value::Number(serde_json::Number::from(status)),
                Value::String(String::new()),
                Value::String(body),
            ],
        )?;

        if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
            return Err(ProviderError::Rejected(err.to_string()));
        }

        let reference = parsed
            .get("reference")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ProviderError::NoOutput("no task reference in response".to_string()))?
            .to_string();

        Ok(AsyncTask {
            id: crate::domain::new_id(),
            reference,
            protocol: call.protocol.clone(),
            capability: Capability::Video,
            model: call.config_id.clone(),
            created_at: crate::domain::now_iso(),
        })
    }

    async fn poll_task(
        &self,
        call: &ModelCall,
        task: &AsyncTask,
        _cancel: &Cancel,
    ) -> Result<TaskState, ProviderError> {
        let protocol = Self::protocol_name(call)?;
        let entry = Self::lookup_entry(protocol).await?;

        let task_json = serde_json::json!({
            "id": task.id,
            "reference": task.reference,
        });

        let req_def = Self::call_lua(
            &entry,
            "build_poll_request",
            vec![Self::call_to_json(call), task_json],
        )?;

        let (status, _headers, body) = Self::execute(call, &req_def).await?;

        let parsed = Self::call_lua(
            &entry,
            "parse_poll_response",
            vec![
                Value::Number(serde_json::Number::from(status)),
                Value::String(String::new()),
                Value::String(body),
            ],
        )?;

        if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
            match parsed.get("status").and_then(|v| v.as_str()) {
                Some("expired") => {
                    return Err(ProviderError::TaskExpired {
                        task: task.id.clone(),
                    })
                }
                _ => return Err(ProviderError::Rejected(err.to_string())),
            }
        }

        match parsed.get("status").and_then(|v| v.as_str()) {
            Some("succeeded") => {
                let mut items = Vec::new();
                if let Some(items_val) = parsed.get("result").and_then(|r| r.get("items")) {
                    for (url, mime) in Self::collect_url_items(items_val) {
                        items
                            .push(Self::download_item(call, &url, &mime, Capability::Video).await?);
                    }
                }
                Ok(TaskState::Succeeded(GenerateResult {
                    text: None,
                    items,
                    usage: None,
                }))
            }
            Some("pending") | None => {
                let interval_ms = parsed
                    .get("poll_interval_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(15000);
                Ok(TaskState::Pending {
                    retry_after_ms: interval_ms,
                })
            }
            Some("failed") => Err(ProviderError::Rejected(
                parsed
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("job failed")
                    .to_string(),
            )),
            Some(other) => Err(ProviderError::Rejected(format!(
                "unexpected status: {other}"
            ))),
        }
    }
}
