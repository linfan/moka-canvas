//! Lua script runtime: loads scripts, registers the API surface a converter
//! script can call, and invokes exported functions.
//!
//! Each script exports zero or more of the following functions by capability:
//!
//! | Function | Input | Output | Used by |
//! |---|---|---|---|
//! | `build_request(call, req, inputs)` | 3 tables | `{method, url, headers, body}` | text, image, audio |
//! | `parse_response(status, headers, body)` | number, table, string | `{text, items, usage}` | text, image, audio |
//! | `parse_event(event_json)` | string | `{text, complete, usage}` | text streaming |
//! | `build_task_request(call, req, inputs)` | 3 tables | `{method, url, headers, body}` | video, asr |
//! | `parse_task_response(status, headers, body)` | number, table, string | `{reference, poll_interval_ms}` | video, asr |
//! | `build_poll_request(call, task)` | 2 tables | `{method, url, headers}` | video, asr |
//! | `parse_poll_response(status, headers, body)` | number, table, string | `{status, result, error}` | video, asr |
//!
//! # Asking for another exchange
//!
//! A protocol that needs more than one call per step — an upload before a
//! submit, a document behind a poll — says so instead of the host knowing it.
//! Any hook may return
//!
//! ```lua
//! { request = {method = "GET", url = ..., headers = ..., body = ...},
//!   handler = "parse_something",  -- optional: the hook that reads this answer
//!   state = { ... } }             -- optional: handed to the next handler
//! ```
//!
//! as its reply, or may carry one under `next` beside the rest of what it
//! answers. The host sends that request, calls `handler` with
//! `(status, headers, body, state)`, and repeats until a reply carries no
//! `next`; the reply that ends the chain is that step's answer. Handlers are
//! looked up before each request goes out, so a script that names a function it
//! never wrote is refused rather than sending an upload nobody will read. What
//! one step learns is only what it wrote into `state`: every step runs in a
//! runtime of its own. A chain is capped, so a reply that asks for itself again
//! is an error rather than a loop.
//!
//! A `body` is text, or a form whose file part is one of the inputs the request
//! carried — Lua counts from one:
//!
//! ```lua
//! body = {multipart = {fields = {key = "a-value"}, file = {part = "file", input = 1}}}
//! ```
//!
//! Requests are sent to the address the script named. The credential follows
//! the address rather than the script: an upload host or a link a provider
//! handed back is a different origin from the configured endpoint, and a key
//! sent there would not be going to the provider.

use std::path::Path;

use mlua::{Function, Lua, Result as LuaResult, Value};

use super::api;

/// A handle for interacting with a loaded Lua script.
pub struct ScriptRef {
    _name: String,
}

/// A Lua runtime, held for as long as the one call that made it needs it.
///
/// No lock and no reference count. A runtime is built inside the adapter's
/// `call_lua`, used, and dropped before that function returns, so nothing else
/// can ever reach it; and `Lua` is not `Send` without mlua's `send` feature, so
/// a mutex around it could not make it shareable across threads even if two
/// callers existed. What the pair would add is the pretence of contention.
pub struct LuaRuntime {
    lua: Lua,
}

impl LuaRuntime {
    /// Creates a new runtime with the standard API registered.
    pub fn new() -> Result<Self, mlua::Error> {
        let lua = Lua::new();
        // Safety sandbox: restrict dangerous functions
        lua.globals().set("os", mlua::Value::Nil)?;
        lua.globals().set("io", mlua::Value::Nil)?;
        lua.globals().set("dofile", mlua::Value::Nil)?;
        lua.globals().set("loadfile", mlua::Value::Nil)?;

        api::register(&lua)?;

        Ok(Self { lua })
    }

    /// Loads a script file and returns a reference to it.
    pub fn load(&self, path: &Path) -> Result<ScriptRef, mlua::Error> {
        let source = std::fs::read_to_string(path).map_err(|e| {
            mlua::Error::RuntimeError(format!("cannot read script {}: {e}", path.display()))
        })?;
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        self.load_source(&name, &source)
    }

    /// Loads script text under a name its errors are reported by.
    pub fn load_source(&self, name: &str, source: &str) -> Result<ScriptRef, mlua::Error> {
        let chunk = self.lua.load(source).set_name(name);
        chunk.exec()?;
        Ok(ScriptRef {
            _name: name.to_string(),
        })
    }

    /// Checks whether a loaded script exports the named function.
    pub fn has_function(&self, _script: &ScriptRef, name: &str) -> bool {
        let lua = &self.lua;
        lua.globals()
            .get::<Value>(name)
            .map(|v| matches!(v, Value::Function(_)))
            .unwrap_or(false)
    }

    /// Calls a function on a loaded script and converts the result to a
    /// [`serde_json::Value`].
    pub fn call_json(
        &self,
        _script: &ScriptRef,
        func: &str,
        args: Vec<mlua::Value>,
    ) -> Result<mlua::Value, mlua::Error> {
        let lua = &self.lua;
        let func: Function = lua.globals().get(func)?;
        // A Vec<Value> on its own would convert to one Lua table — a single
        // argument — leaving every parameter after the first nil inside the
        // script. MultiValue is what spreads the elements as arguments.
        let result = func.call::<mlua::Value>(mlua::MultiValue::from_vec(args))?;
        Ok(result)
    }

    /// Calls a function with [`serde_json::Value`] arguments. Converts each
    /// argument to a Lua value, calls the function, and converts the result
    /// back to JSON.
    pub fn call_json_value(
        &self,
        _script: &ScriptRef,
        func: &str,
        args: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value, mlua::Error> {
        let lua = &self.lua;
        let func: Function = lua.globals().get(func)?;
        let lua_args: Result<Vec<mlua::Value>, mlua::Error> =
            args.into_iter().map(|arg| json_to_lua(lua, &arg)).collect();
        // Spread as arguments, not passed as one table: see `call_json`.
        let result = func.call::<mlua::Value>(mlua::MultiValue::from_vec(lua_args?))?;
        Ok(table_to_json(&result))
    }
}

impl Default for LuaRuntime {
    fn default() -> Self {
        Self::new().expect("Lua runtime initialises")
    }
}

/// Converts any Lua value to a [`serde_json::Value`].
pub(crate) fn table_to_json(value: &mlua::Value) -> serde_json::Value {
    use mlua::Value::*;
    match value {
        Nil => serde_json::Value::Null,
        Boolean(b) => serde_json::Value::Bool(*b),
        Integer(i) => serde_json::Value::Number((*i).into()),
        Number(n) => serde_json::Value::Number(
            serde_json::Number::from_f64(*n).unwrap_or_else(|| serde_json::Number::from(0)),
        ),
        String(s) => {
            serde_json::Value::String(s.to_str().map(|s| s.to_string()).unwrap_or_default())
        }
        Table(t) => {
            let len = t.raw_len();
            if len > 0 {
                let mut arr = Vec::with_capacity(len);
                for i in 1..=len {
                    if let Ok(v) = t.raw_get::<mlua::Value>(mlua::Value::Integer(i as i64)) {
                        arr.push(table_to_json(&v));
                    }
                }
                return serde_json::Value::Array(arr);
            }
            let mut map = serde_json::Map::new();
            for (k, v) in t.clone().pairs::<mlua::String, mlua::Value>().flatten() {
                map.insert(
                    k.to_str().map(|s| s.to_string()).unwrap_or_default(),
                    table_to_json(&v),
                );
            }
            serde_json::Value::Object(map)
        }
        _ => serde_json::Value::Null,
    }
}

/// Converts a Rust [`serde_json::Value`] to a Lua value.
pub fn json_to_lua(lua: &Lua, value: &serde_json::Value) -> LuaResult<mlua::Value> {
    match value {
        serde_json::Value::Null => Ok(mlua::Value::Nil),
        serde_json::Value::Bool(b) => Ok(mlua::Value::Boolean(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(mlua::Value::Integer(i))
            } else if let Some(f) = n.as_f64() {
                Ok(mlua::Value::Number(f))
            } else {
                Ok(mlua::Value::String(lua.create_string(n.to_string())?))
            }
        }
        serde_json::Value::String(s) => Ok(mlua::Value::String(lua.create_string(s)?)),
        serde_json::Value::Array(arr) => {
            let table = lua.create_table()?;
            for (i, v) in arr.iter().enumerate() {
                table.set(i + 1, json_to_lua(lua, v)?)?;
            }
            Ok(mlua::Value::Table(table))
        }
        serde_json::Value::Object(obj) => {
            let table = lua.create_table()?;
            for (k, v) in obj {
                table.set(k.as_str(), json_to_lua(lua, v)?)?;
            }
            Ok(mlua::Value::Table(table))
        }
    }
}

/// Converts a Lua value to a string representation.
#[allow(dead_code)]
pub(crate) fn to_lua_string(v: &mlua::Value) -> String {
    match v {
        mlua::Value::String(s) => s.to_str().map(|s| s.to_string()).unwrap_or_default(),
        mlua::Value::Number(n) => n.to_string(),
        mlua::Value::Integer(i) => i.to_string(),
        mlua::Value::Boolean(b) => b.to_string(),
        mlua::Value::Nil => String::new(),
        _ => format!("{v:?}"),
    }
}

/// Builds a Python-like str() representation.
fn _lua_to_string(lua: &Lua, value: mlua::Value) -> LuaResult<String> {
    let tostring: Function = lua.globals().get("tostring")?;
    tostring.call(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_runtime() -> LuaRuntime {
        LuaRuntime::new().expect("runtime builds")
    }

    #[test]
    fn runtime_creates_and_registers_apis() {
        let rt = test_runtime();
        let lua = &rt.lua;
        assert!(lua.globals().get::<mlua::Value>("json").is_ok());
        assert!(lua.globals().get::<mlua::Value>("base64").is_ok());
        assert!(lua.globals().get::<mlua::Value>("log").is_ok());
        assert!(lua.globals().get::<mlua::Value>("util").is_ok());
    }

    #[test]
    fn json_table_to_value_roundtrip() {
        let rt = test_runtime();
        let lua = &rt.lua;
        let tbl = lua.create_table().unwrap();
        tbl.set("a", 1).unwrap();
        let inner = lua.create_table().unwrap();
        inner.set(1, 2).unwrap();
        inner.set(2, 3).unwrap();
        tbl.set("b", inner).unwrap();

        let json = table_to_json(&mlua::Value::Table(tbl));
        assert_eq!(json, serde_json::json!({"a": 1, "b": [2, 3]}));
    }

    #[test]
    fn a_script_function_receives_every_argument() {
        let rt = test_runtime();
        // The bug this pins: a Vec of values converts to one Lua table, so
        // without spreading, `call` was the whole list and `req` was nil —
        // "attempt to index a nil value (local 'req')" at the first field
        // a script read off the request.
        let script = rt
            .load_source(
                "args",
                r#"
                function build_request(call, req, inputs)
                    return {
                        method = "POST",
                        url = call.url .. "/" .. req.prompt .. "/" .. #inputs,
                    }
                end
                "#,
            )
            .unwrap();
        let out = rt
            .call_json_value(
                &script,
                "build_request",
                vec![
                    serde_json::json!({"url": "https://provider.test"}),
                    serde_json::json!({"prompt": "hello", "params": {}}),
                    serde_json::json!([{"role": "firstFrame"}]),
                ],
            )
            .unwrap();
        assert_eq!(out["method"], "POST");
        assert_eq!(out["url"], "https://provider.test/hello/1");
    }

    #[test]
    fn the_bailian_scripts_build_their_requests() {
        let rt = test_runtime();
        let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("converter-scripts");

        // Audio: the non-streaming CosyVoice TTS shape.
        let speech = rt.load(&scripts.join("audio/bailian-speech.lua")).unwrap();
        let out = rt
            .call_json_value(
                &speech,
                "build_request",
                vec![
                    serde_json::json!({"url": "https://ws.test/tts", "model": "cosyvoice-v1"}),
                    serde_json::json!({"prompt": "hello", "params": {"voice": "longxiaochun"}}),
                    serde_json::json!([]),
                ],
            )
            .unwrap();
        assert_eq!(out["url"], "https://ws.test/tts");
        let body: serde_json::Value =
            serde_json::from_str(out["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["model"], "cosyvoice-v1");
        assert_eq!(body["input"]["text"], "hello");
        assert_eq!(body["input"]["voice"], "longxiaochun");

        // Video: the async DashScope task shape.
        let video = rt.load(&scripts.join("video/bailian-video.lua")).unwrap();
        let out = rt
            .call_json_value(
                &video,
                "build_task_request",
                vec![
                    serde_json::json!({"url": "https://ws.test/video-synthesis", "model": "wan2.2-t2v"}),
                    serde_json::json!({"prompt": "a cat", "params": {"seconds": "6", "resolution": "720"}}),
                    serde_json::json!([{"role": "firstFrame", "data_url": "https://img.test/1.png"}]),
                ],
            )
            .unwrap();
        assert_eq!(out["headers"]["X-DashScope-Async"], "enable");
        let body: serde_json::Value =
            serde_json::from_str(out["body"].as_str().unwrap()).expect("a JSON body");
        assert_eq!(body["model"], "wan2.2-t2v");
        assert_eq!(body["input"]["prompt"], "a cat");
        assert_eq!(body["input"]["media"][0]["type"], "first_frame");
        assert_eq!(body["parameters"]["duration"], 6);
        // The API only takes the tiers with a trailing P, so the bare tier the
        // request carries is dressed before it travels.
        assert_eq!(body["parameters"]["resolution"], "720P");
    }

    /// A policy answer as the provider writes one, and the state step one left.
    fn policy() -> serde_json::Value {
        serde_json::json!({
            "data": {
                "upload_host": "https://dashscope-file.oss-cn-beijing.aliyuncs.com",
                "upload_dir": "dashscope-instant/2026/09/22/abc",
                "oss_access_key_id": "LTAm5xxx",
                "policy": "eyJleHBpcmF0aW9u",
                "signature": "Sm/tv7DcZuTZftFVvt5yOoSETsc=",
                "x_oss_object_acl": "private",
                "x_oss_forbid_overwrite": "true"
            }
        })
    }

    /// A transcription document as the provider writes one: two speakers, and
    /// two sentences from the first of them.
    fn transcript() -> serde_json::Value {
        serde_json::json!({
            "transcripts": [{
                "channel_id": 0,
                "text": "Hello world, 这里是阿里巴巴语音实验室。第二句。换人了。",
                "sentences": [
                    {"begin_time": 100, "end_time": 3820, "speaker_id": 0,
                     "text": "Hello world, 这里是阿里巴巴语音实验室。"},
                    {"begin_time": 4000, "end_time": 5200, "speaker_id": 0,
                     "text": "第二句。"},
                    {"begin_time": 6000, "end_time": 7000, "speaker_id": 1,
                     "text": "换人了。"}
                ]
            }]
        })
    }

    #[test]
    fn the_bailian_recognition_script_uploads_submits_and_reads_the_transcript() {
        let rt = test_runtime();
        let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("converter-scripts");
        let asr = rt.load(&scripts.join("asr/bailian-asr.lua")).unwrap();
        let endpoint = "https://ws.test/api/v1/services/audio/asr/transcription";

        // Step one: ask where the audio may be put. What the caller asked for
        // rides along, because nothing after this call can see the request.
        let asked = rt
            .call_json_value(
                &asr,
                "build_task_request",
                vec![
                    serde_json::json!({"url": endpoint, "model": "fun-asr"}),
                    serde_json::json!({"prompt": "", "params": {
                        "language": "zh", "speakerCount": 2, "speakerLabel": "说话人{id}："
                    }}),
                    serde_json::json!([{
                        "role": "controlAudio", "filename": "take-1.wav", "mime": "audio/wav"
                    }]),
                ],
            )
            .unwrap();
        assert_eq!(
            asked["request"]["url"],
            "https://ws.test/api/v1/uploads?action=getPolicy&model=fun-asr"
        );
        assert_eq!(asked["handler"], "parse_policy");
        assert_eq!(asked["state"]["parameters"]["language_hints"][0], "zh");
        assert_eq!(asked["state"]["parameters"]["diarization_enabled"], true);
        assert_eq!(asked["state"]["parameters"]["speaker_count"], 2);

        // Step two: the policy names a host, and the audio goes there as a
        // form whose file part is the input this request carried.
        let upload = rt
            .call_json_value(
                &asr,
                "parse_policy",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::Value::String(policy().to_string()),
                    asked["state"].clone(),
                ],
            )
            .unwrap();
        let out = &upload["next"]["request"];
        assert_eq!(
            out["url"],
            "https://dashscope-file.oss-cn-beijing.aliyuncs.com"
        );
        assert_eq!(out["body"]["multipart"]["file"]["part"], "file");
        assert_eq!(out["body"]["multipart"]["file"]["input"], 1);
        let fields = &out["body"]["multipart"]["fields"];
        assert_eq!(fields["key"], "dashscope-instant/2026/09/22/abc/take-1.wav");
        assert_eq!(fields["success_action_status"], 200);
        assert_eq!(fields["x-oss-forbid-overwrite"], "true");

        // Step three: with the audio uploaded, the job is submitted against
        // the address the provider can fetch it from.
        let submit = rt
            .call_json_value(
                &asr,
                "parse_upload",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::json!(""),
                    upload["state"].clone(),
                ],
            )
            .unwrap();
        let body: serde_json::Value = serde_json::from_str(
            submit["next"]["request"]["body"]
                .as_str()
                .expect("a JSON body"),
        )
        .unwrap();
        assert_eq!(body["model"], "fun-asr");
        assert_eq!(
            body["input"]["file_urls"][0],
            "oss://dashscope-instant/2026/09/22/abc/take-1.wav"
        );
        assert_eq!(body["parameters"]["language_hints"][0], "zh");
        assert_eq!(
            submit["next"]["request"]["headers"]["X-DashScope-OssResourceResolve"],
            "enable"
        );
        assert_eq!(
            submit["next"]["request"]["headers"]["X-DashScope-Async"],
            "enable"
        );

        // The job's answer names the document with the words in it, which is
        // one more call rather than a field of the answer.
        let polled = rt
            .call_json_value(
                &asr,
                "parse_poll_response",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::Value::String(
                        serde_json::json!({"output": {
                            "task_status": "SUCCEEDED",
                            "results": [{"transcription_url": "https://result.test/1.json"}]
                        }})
                        .to_string(),
                    ),
                ],
            )
            .unwrap();
        assert_eq!(polled["next"]["handler"], "parse_transcription");
        assert_eq!(
            polled["next"]["request"]["url"],
            "https://result.test/1.json"
        );

        // And the document becomes a subtitle file, its times measured from
        // the beginning of the audio that was sent.
        let done = rt
            .call_json_value(
                &asr,
                "parse_transcription",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::json!(transcript().to_string()),
                    submit["state"].clone(),
                ],
            )
            .unwrap();
        assert_eq!(done["status"], "succeeded");
        assert_eq!(
            done["result"]["text"],
            "1\n00:00:00,100 --> 00:00:05,200\n\
             说话人1：Hello world, 这里是阿里巴巴语音实验室。 第二句。\n\n\
             2\n00:00:06,000 --> 00:00:07,000\n说话人2：换人了。\n"
        );
    }

    #[test]
    fn a_recognition_without_speakers_gives_one_cue_per_sentence() {
        let rt = test_runtime();
        let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("converter-scripts");
        let asr = rt.load(&scripts.join("asr/bailian-asr.lua")).unwrap();

        let asked = rt
            .call_json_value(
                &asr,
                "build_task_request",
                vec![
                    serde_json::json!({"url": "https://ws.test/asr", "model": "fun-asr"}),
                    serde_json::json!({"prompt": "", "params": {}}),
                    serde_json::json!([{"role": "controlAudio", "filename": "a.wav"}]),
                ],
            )
            .unwrap();
        // Nothing was asked about speakers, so nothing is asked of the
        // recognizer either: a channel list and nothing else.
        assert_eq!(
            asked["state"]["parameters"]["diarization_enabled"],
            serde_json::Value::Null
        );

        let done = rt
            .call_json_value(
                &asr,
                "parse_transcription",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::json!(transcript().to_string()),
                    asked["state"].clone(),
                ],
            )
            .unwrap();
        assert_eq!(
            done["result"]["text"],
            "1\n00:00:00,100 --> 00:00:03,820\nHello world, 这里是阿里巴巴语音实验室。\n\n\
             2\n00:00:04,000 --> 00:00:05,200\n第二句。\n\n\
             3\n00:00:06,000 --> 00:00:07,000\n换人了。\n"
        );
    }

    #[test]
    fn a_recording_with_nothing_said_is_refused_rather_than_answered() {
        let rt = test_runtime();
        let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("converter-scripts");
        let asr = rt.load(&scripts.join("asr/bailian-asr.lua")).unwrap();
        let done = rt
            .call_json_value(
                &asr,
                "parse_transcription",
                vec![
                    serde_json::json!(200),
                    serde_json::json!(""),
                    serde_json::Value::String(
                        serde_json::json!({"transcripts": [{"sentences": []}]}).to_string(),
                    ),
                    serde_json::json!({}),
                ],
            )
            .unwrap();
        assert!(
            done["error"].as_str().unwrap().contains("no speech"),
            "{done}"
        );
    }

    #[test]
    fn base64_encode_decode() {
        let rt = test_runtime();
        let lua = &rt.lua;
        let b64_table: mlua::Table = lua.globals().get("base64").unwrap();
        let encode: Function = b64_table.get("encode").unwrap();
        let decode: Function = b64_table.get("decode").unwrap();

        let encoded: String = encode.call("hello").unwrap();
        assert_eq!(encoded, "aGVsbG8=");

        let decoded: String = decode.call(encoded.clone()).unwrap();
        assert_eq!(decoded, "hello");
    }
}
