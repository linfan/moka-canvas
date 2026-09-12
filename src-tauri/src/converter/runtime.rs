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
//! | `build_task_request(call, req, inputs)` | 3 tables | `{method, url, headers, body}` | video |
//! | `parse_task_response(status, headers, body)` | number, table, string | `{reference, poll_interval_ms}` | video |
//! | `build_poll_request(call, task)` | 2 tables | `{method, url, headers}` | video |
//! | `parse_poll_response(status, headers, body)` | number, table, string | `{status, result, error}` | video |

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
                    serde_json::json!({"prompt": "a cat", "params": {"seconds": "6"}}),
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
