//! Lua adapter: wraps the Lua runtime behind the ProviderAdapter trait.
//!
//! This module executes Lua converter scripts to build HTTP requests and parse
//! responses, enabling new vendor protocols without recompiling the backend.
//!
//! A protocol that needs more than one call for one step — an upload before a
//! submit, a document behind a poll — describes the whole conversation to
//! [`LuaAdapter::follow`], which runs it one exchange at a time.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use super::registry::{ConverterRegistry, ProtocolEntry};
use super::runtime::LuaRuntime;
use crate::domain::Capability;
use crate::generate::adapters::{drain, ModelCall, ProviderAdapter};
use crate::generate::error::ProviderError;
use crate::generate::media::{MediaInput, MultipartBody};
use crate::generate::{
    AsyncTask, Cancel, DeltaSink, GenerateRequest, GenerateResult, GeneratedItem, TaskState,
};

/// The ceiling for downloading media from a URL returned by a Lua script.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;

/// How many exchanges one step may take before a script is stopped.
///
/// A protocol needs two or three; the ceiling is here because a reply that
/// names the same handler again is a loop, and a loop would otherwise never
/// end.
const MAX_EXCHANGES: usize = 8;

static CONVERTER_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Sets the converter root directory. Called once during startup after deploy.
pub fn set_converter_root(root: PathBuf) {
    let _ = CONVERTER_ROOT.set(root);
}

/// The models directory, once startup has set it. Model validation reads the
/// registry through it to learn which Lua protocols exist.
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
        let registry = ConverterRegistry::load(root);
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
    ///
    /// A script is told what each input is called and what it holds as well as
    /// the bytes themselves: a protocol that has to leave the recording
    /// somewhere names it, and one that has to describe it says what it is.
    /// The filename is the one a multipart part would carry, so it is safe to
    /// put in a URL.
    fn inputs_to_json(inputs: &[MediaInput]) -> Value {
        let list: Vec<Value> = inputs
            .iter()
            .map(|input| {
                serde_json::json!({
                    "role": input.role.as_str(),
                    "filename": input.filename(),
                    "mime": input.mime,
                    "data_url": input.data_url(),
                })
            })
            .collect();
        Value::Array(list)
    }

    /// Refuses a handler the script does not export, before the request goes
    /// out.
    ///
    /// The script is loaded twice per exchange — once here, once to run the
    /// handler — because nothing may be held across the call in between. What
    /// it buys is that a script naming a function it never wrote is refused
    /// before an upload of tens of megabytes is sent to a provider.
    fn require(entry: &ProtocolEntry, handler: &str) -> Result<(), ProviderError> {
        let root = CONVERTER_ROOT
            .get()
            .ok_or_else(|| ProviderError::invalid("converter root not initialised"))?;
        let runtime = LuaRuntime::new()
            .map_err(|e| ProviderError::invalid(format!("Lua runtime failed: {e}")))?;
        let script = runtime.load(&root.join(&entry.script)).map_err(|e| {
            ProviderError::invalid(format!("failed to load script '{}': {e}", entry.script))
        })?;
        if runtime.has_function(&script, handler) {
            return Ok(());
        }
        Err(ProviderError::invalid(format!(
            "script '{}' does not export '{handler}'",
            entry.script
        )))
    }

    /// Runs the exchanges a build hook asked for, and returns the reply that
    /// ended the chain.
    ///
    /// The hook's reply is the first exchange, either as a request description
    /// or as `{request, handler}` when the answer needs a function of its own
    /// to read; a hook with nothing to ask for says so with `{error}`. From
    /// there, a reply that carries `next` asks for one more exchange, which is
    /// how a protocol needing several calls stays in Lua rather than in this
    /// host. What a reply learned travels in `state`, handed to the next
    /// handler as its fourth argument: each step runs in a runtime of its own,
    /// so a value nobody wrote down is a value nobody has.
    async fn follow(
        entry: &ProtocolEntry,
        asked: &Value,
        fallback: &str,
        call: &ModelCall,
        inputs: &[MediaInput],
        capability: Capability,
        cancel: &Cancel,
    ) -> Result<Value, ProviderError> {
        if let Some(err) = asked.get("error").and_then(Value::as_str) {
            return Err(ProviderError::Rejected(err.to_string()));
        }
        let mut exchange = Exchange::asked(asked, fallback)?;
        let mut state = asked.get("state").cloned().unwrap_or(Value::Null);
        for _ in 0..MAX_EXCHANGES {
            cancel.check()?;
            Self::require(entry, &exchange.handler)?;
            let (status, headers, body) =
                Self::execute(call, &exchange.request, inputs, capability).await?;
            let reply = Self::call_lua(
                entry,
                &exchange.handler,
                vec![
                    Value::Number(serde_json::Number::from(status)),
                    Value::String(headers),
                    Value::String(body),
                    state,
                ],
            )?;
            match exchange.asked_by(&reply) {
                Some(asked) => {
                    exchange = asked?;
                    state = reply.get("state").cloned().unwrap_or(Value::Null);
                }
                None => return Ok(reply),
            }
        }
        Err(ProviderError::invalid(format!(
            "the script asked for more than {MAX_EXCHANGES} exchanges in one step"
        )))
    }

    /// The body a request description asks for, sent as it stands.
    fn described_body(request_def: &Value, inputs: &[MediaInput]) -> Result<Body, ProviderError> {
        match request_def.get("body") {
            None | Some(Value::Null) => Ok(Body::None),
            Some(Value::String(text)) => Ok(Body::Text(text.clone())),
            Some(Value::Object(shape)) => {
                let multipart = shape.get("multipart").ok_or_else(|| {
                    ProviderError::invalid("the script described a body this host cannot send")
                })?;
                let (bytes, content_type) = Self::multipart(multipart, inputs)?;
                Ok(Body::Multipart(bytes, content_type))
            }
            Some(_) => Err(ProviderError::invalid(
                "the script described a body that is neither text nor a multipart form",
            )),
        }
    }

    /// A multipart form: the script's fields, and one of the inputs as the file.
    ///
    /// A script cannot carry bytes, so it says which of the inputs it sent
    /// along belongs in the file part — counting from one, as Lua counts — and
    /// the boundary is this host's business rather than the script's.
    fn multipart(shape: &Value, inputs: &[MediaInput]) -> Result<(Vec<u8>, String), ProviderError> {
        let mut body = MultipartBody::new();
        if let Some(fields) = shape.get("fields").and_then(Value::as_object) {
            for (name, value) in fields {
                if let Some(text) = field_text(value) {
                    body = body.field(name, &text);
                }
            }
        }
        if let Some(file) = shape.get("file").filter(|file| !file.is_null()) {
            let part = file.get("part").and_then(Value::as_str).unwrap_or("file");
            let index = file.get("input").and_then(Value::as_u64).unwrap_or(1);
            let media = inputs
                .get(index.saturating_sub(1) as usize)
                .ok_or_else(|| {
                    ProviderError::invalid(format!(
                        "the script asked for input {index} and the request carried {}",
                        inputs.len()
                    ))
                })?;
            body = body.file(part, media);
        }
        Ok(body.finish())
    }

    /// Executes an HTTP request built from the Lua script's return value.
    ///
    /// The credential follows the address rather than the script: a request to
    /// the configured origin carries it, and one to an upload host or a link
    /// the provider handed back does not.
    async fn execute(
        call: &ModelCall,
        request_def: &Value,
        inputs: &[MediaInput],
        capability: Capability,
    ) -> Result<(u16, String, String), ProviderError> {
        let method = request_def["method"].as_str().unwrap_or("POST");
        let url = request_def["url"]
            .as_str()
            .ok_or_else(|| ProviderError::invalid("Lua script returned no URL"))?;

        let mut builder = call.described(method, url);
        if let Some(headers) = request_def["headers"].as_object() {
            for (key, value) in headers {
                if let Some(val) = value.as_str() {
                    builder = builder.header(key.as_str(), val);
                }
            }
        }

        let builder = match Self::described_body(request_def, inputs)? {
            Body::None => {
                if !method.eq_ignore_ascii_case("GET") {
                    return Err(ProviderError::invalid(
                        "Lua script returned no body for POST",
                    ));
                }
                builder
            }
            Body::Text(text) => builder.body(text),
            // The content type is set after the script's own headers: a
            // boundary a script wrote down itself would not be the one this
            // body was assembled with.
            Body::Multipart(bytes, content_type) => {
                builder.header("Content-Type", content_type).body(bytes)
            }
        };

        let response = builder
            .timeout(call.budgets.timeout_for(capability))
            .send()
            .await
            .map_err(|e| ProviderError::Unreachable(e.to_string()))?;

        let reply = drain(response, call.budgets.max_response_bytes).await?;
        let body_str = String::from_utf8_lossy(&reply.body).to_string();

        Ok((reply.status, format!("{:?}", reply.headers), body_str))
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
        if !(200..300).contains(&status) {
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

/// One exchange: a request a script described, and the function that reads the
/// answer to it.
struct Exchange {
    request: Value,
    handler: String,
}

impl Exchange {
    /// The exchange a hook or a reply asked for.
    ///
    /// The request description can be returned on its own — the shape every
    /// script used before protocols chained calls — or as a `{request,
    /// handler}` pair when the answer needs a function of its own to read it.
    /// Without one, `fallback` reads it.
    fn asked(reply: &Value, fallback: &str) -> Result<Self, ProviderError> {
        let (request, handler) = match reply.get("request") {
            Some(request) if request.is_object() => (
                request.clone(),
                reply.get("handler").and_then(Value::as_str),
            ),
            _ => (reply.clone(), None),
        };
        if !request.is_object() {
            return Err(ProviderError::invalid(
                "the script described no request to send",
            ));
        }
        Ok(Self {
            request,
            handler: handler.unwrap_or(fallback).to_string(),
        })
    }

    /// The exchange a reply asked for next, or none when the chain is over.
    ///
    /// A reply that names no handler is read by the one that read the last
    /// answer, which is what a script paging through one endpoint wants; the
    /// step ceiling is what stops that from being a loop.
    fn asked_by(&self, reply: &Value) -> Option<Result<Self, ProviderError>> {
        reply
            .get("next")
            .map(|next| Self::asked(next, &self.handler))
    }
}

/// What a request description says to send.
enum Body {
    /// Nothing, which only a GET may.
    None,
    /// The text the script wrote.
    Text(String),
    /// A form, with the bytes and the content type that names its boundary.
    Multipart(Vec<u8>, String),
}

/// A form field as text. A script may write a number or a flag where a field is
/// expected, and a form has no types of its own.
fn field_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
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
        let protocol = Self::protocol_name(call)?;
        let entry = Self::lookup_entry(protocol).await?;

        let asked = Self::call_lua(
            &entry,
            "build_request",
            vec![
                Self::call_to_json(call),
                Self::request_to_json(request),
                Self::inputs_to_json(inputs),
            ],
        )?;

        let parsed = Self::follow(
            &entry,
            &asked,
            "parse_response",
            call,
            inputs,
            request.capability,
            cancel,
        )
        .await?;

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
        cancel: &Cancel,
    ) -> Result<AsyncTask, ProviderError> {
        let protocol = Self::protocol_name(call)?;
        let entry = Self::lookup_entry(protocol).await?;

        let asked = Self::call_lua(
            &entry,
            "build_task_request",
            vec![
                Self::call_to_json(call),
                Self::request_to_json(request),
                Self::inputs_to_json(inputs),
            ],
        )?;

        let parsed = Self::follow(
            &entry,
            &asked,
            "parse_task_response",
            call,
            inputs,
            request.capability,
            cancel,
        )
        .await?;

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
            // The capability the request came in on, not the one this adapter
            // was written for: polling resolves the model configuration again,
            // and a handle filed under the wrong category would be answered by
            // whatever model that category happens to hold.
            capability: request.capability,
            model: call.config_id.clone(),
            created_at: crate::domain::now_iso(),
        })
    }

    async fn poll_task(
        &self,
        call: &ModelCall,
        task: &AsyncTask,
        cancel: &Cancel,
    ) -> Result<TaskState, ProviderError> {
        let protocol = Self::protocol_name(call)?;
        let entry = Self::lookup_entry(protocol).await?;

        let task_json = serde_json::json!({
            "id": task.id,
            "reference": task.reference,
        });

        let asked = Self::call_lua(
            &entry,
            "build_poll_request",
            vec![Self::call_to_json(call), task_json],
        )?;

        // No inputs: a poll describes a request about a job rather than one
        // carrying media, so a script that asks for a file part here is told
        // the request carried none.
        let parsed = Self::follow(
            &entry,
            &asked,
            "parse_poll_response",
            call,
            &[],
            task.capability,
            cancel,
        )
        .await?;

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
                let result = parsed.get("result");
                let mut items = Vec::new();
                if let Some(items_val) = result.and_then(|r| r.get("items")) {
                    for (url, mime) in Self::collect_url_items(items_val) {
                        items.push(Self::download_item(call, &url, &mime, task.capability).await?);
                    }
                }
                // Words travel the same way media does. A job that answers with
                // them — a transcript, the point of a recognition job — has
                // nothing to download and everything to say.
                let text = result
                    .and_then(|r| r.get("text"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                Ok(TaskState::Succeeded(GenerateResult {
                    text,
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
