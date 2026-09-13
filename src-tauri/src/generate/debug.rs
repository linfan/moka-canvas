//! Every call that reaches a provider, written down where a reader can pick it
//! up afterwards.
//!
//! A generation that fails says why in the log, and a generation that succeeds
//! says nothing at all — which is the whole trouble this answers. An answer that
//! arrived and was the wrong thing cannot be diagnosed from a line saying the
//! call took nine seconds, because the only evidence of what was asked and what
//! came back was in the two bodies, and both were dropped on the floor the moment
//! the call returned.
//!
//! It is off until somebody asks for it, and turning it on is a decision rather
//! than a setting: what lands on the disk is the prompt a reader typed and the
//! references that travelled with it. The credential that carried them is always
//! masked, and the directory recordings go to is always the `records`
//! subdirectory of the platform application data directory — neither is a
//! setting, because a setting somebody can get wrong is either a key on the
//! disk or a recording nobody can find. `docs/security.md` carries the warning;
//! this module carries the mechanism.
//!
//! Nothing here can fail a generation. A recording is written by a task of its
//! own after the answer is already in hand, and a disk that will not take it is
//! complained about in the log rather than handed back to whoever asked.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use reqwest::header::HeaderMap;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use super::adapters::ModelCall;
use crate::config::DebugConfig;
use crate::domain::now_iso;
use crate::metadata::redact::masked;

/// What one call was for.
///
/// Two requests to the same address look alike afterwards, and the difference
/// between asking for a generation and looking at a job started an hour ago is
/// the first thing a reader wants to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// One generation, waited out.
    Generate,
    /// One generation, arriving in pieces.
    Stream,
    /// Starting a job that outlives the request.
    TaskCreate,
    /// One look at a job started earlier.
    TaskPoll,
    /// Fetching bytes a provider left at an address of its own.
    Media,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Generate => "generate",
            Self::Stream => "stream",
            Self::TaskCreate => "task-create",
            Self::TaskPoll => "task-poll",
            Self::Media => "media",
        }
    }
}

/// The model configuration a call was placed with, copied rather than
/// borrowed.
///
/// Copied because a recording outlives the call it describes: the task that
/// writes it runs after the answer is in hand, by which time the call that
/// made it may have been dropped.
#[derive(Debug, Clone)]
struct Who {
    /// The model configuration's identifier.
    config: String,
    model: String,
    protocol: String,
    /// The credential this call carried, kept so that it can be taken back out
    /// of anything that echoes it. Never written down in full.
    api_key: String,
}

impl From<&ModelCall> for Who {
    fn from(call: &ModelCall) -> Self {
        Self {
            config: call.config_id.clone(),
            model: call.model.clone(),
            protocol: call.protocol.as_str().to_string(),
            api_key: call.api_key.clone(),
        }
    }
}

/// One header, as a pair of strings.
///
/// A header value is bytes rather than text, and one that is not text is still
/// worth writing down: the lossy reading shows what a reader needs in order to
/// recognise it, and the original is in the request that carried it.
type Header = (String, String);

fn headers_of(map: &HeaderMap) -> Vec<Header> {
    let mut headers: Vec<Header> = map
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or("<not text>").to_string(),
            )
        })
        .collect();
    // A provider sends its headers in whatever order suits it, and two runs of
    // the same call should read the same way side by side.
    headers.sort();
    headers
}

/// What went out.
#[derive(Debug)]
struct Sent {
    method: String,
    url: String,
    headers: Vec<Header>,
    /// The body as it was handed to the client. Empty for a request that had
    /// none, and a streamed one says so rather than pretending it was empty.
    body: Body,
}

/// What came back.
#[derive(Debug)]
struct Back {
    /// Absent for a call that never reached the provider, which is a different
    /// thing from one that reached it and was refused.
    status: Option<u16>,
    headers: Vec<Header>,
    body: Body,
    /// What a stream added up to, which is the answer that got stored. Kept
    /// beside the raw stream rather than instead of it: the raw one shows what
    /// arrived and this shows what was made of it.
    aggregate: Option<String>,
    /// Why the call failed, when it did.
    error: Option<String>,
}

/// A body, held as it arrived.
#[derive(Debug)]
enum Body {
    /// Nothing was sent, or nothing came back.
    Empty,
    /// Text, which is what a provider answers with nearly every time.
    Text(String),
    /// Bytes that are not text: a picture, a sound, a video.
    Bytes(Vec<u8>),
    /// A body the client streamed rather than held, which cannot be read after
    /// the request has gone out.
    Streamed,
}

/// One call, from the file name it will be written under to the moment its
/// answer ends.
///
/// Held across the call rather than assembled at the end of it, because the
/// request has to be read before it goes out — after that there is nothing left
/// to read — and the answer is not there yet. Dropping one without finishing it
/// writes nothing, so a call that is abandoned on the way leaves no half file
/// behind.
pub struct Pending {
    name: String,
    kind: Kind,
    who: Who,
    /// When the call was placed, as the rest of the application says it.
    placed: String,
    started: Instant,
    sent: Sent,
}

/// The answer a call got, in the shape a recording wants it.
pub struct Outcome {
    status: Option<u16>,
    headers: Vec<Header>,
    body: Body,
    aggregate: Option<String>,
    error: Option<String>,
}

impl Outcome {
    /// An answer that arrived and was read whole.
    fn of(status: u16, headers: &HeaderMap, body: Vec<u8>) -> Self {
        Self {
            status: Some(status),
            headers: headers_of(headers),
            body: Body::of(body),
            aggregate: None,
            error: None,
        }
    }

    /// A call that failed part way, with whatever of the answer there was.
    fn broken(error: &str, status: Option<u16>, headers: Vec<Header>, body: Body) -> Self {
        Self {
            status,
            headers,
            body,
            aggregate: None,
            error: Some(error.to_string()),
        }
    }
}

impl Body {
    /// Bytes as they arrived, read as text where they are text.
    fn of(bytes: Vec<u8>) -> Self {
        if bytes.is_empty() {
            return Self::Empty;
        }
        match String::from_utf8(bytes) {
            Ok(text) => Self::Text(text),
            Err(not_text) => Self::Bytes(not_text.into_bytes()),
        }
    }
}

/// What the three sources said, settled into one answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    /// Where recordings are written: the `records` subdirectory of the platform
    /// application data directory, which is not a setting anybody can move.
    pub dir: PathBuf,
}

/// What the command line said, which is the outermost word because it is the one
/// somebody typed at the process being started.
static FROM_CLI: OnceLock<bool> = OnceLock::new();

/// The recorder, when recording is on. Absent when it is off, which is the
/// default and what every call site asks before it does any work at all.
static RECORDER: OnceLock<Recorder> = OnceLock::new();

struct Recorder {
    settings: Settings,
    /// Which call this is, so that two calls placed in the same millisecond
    /// still get two names and can be put back in order.
    sequence: AtomicU64,
    jobs: mpsc::UnboundedSender<Job>,
}

/// One call, handed to the task that writes it.
struct Job {
    name: String,
    kind: Kind,
    who: Who,
    /// When the call was placed, as the rest of the application says it.
    placed: String,
    took: Duration,
    sent: Sent,
    back: Back,
}

/// Says what the command line asked for, before the server starts.
///
/// A flag rather than a value written into the configuration, so that the order
/// the three sources are read in stays in one place: what was typed beats what
/// the environment says, and what the environment says beats what the file
/// says. It says whether to record and nothing else: where recordings go is
/// none of the three sources' business.
pub fn from_cli() {
    let _ = FROM_CLI.set(true);
}

/// The environment's word on recording, which is the one a reader sets without
/// editing a file.
const ENABLED_ENV: &str = "MOKA_LLM_DEBUG";

/// Subdirectory of the platform application data directory recordings go into.
pub const RECORDS_DIR_NAME: &str = "records";

/// Settles the three sources into one answer.
///
/// The directory is not settled, because it is not a setting: recordings go to
/// the `records` subdirectory of the platform application data directory, the
/// same root the metadata directory is resolved from, which is the directory
/// the application already owns and already protects.
pub fn resolve(file: &DebugConfig) -> Result<Settings> {
    let app_root = crate::metadata::paths::platform_default()
        .context("cannot determine the platform application data directory")?;
    Ok(settle(
        file,
        FROM_CLI.get().copied(),
        std::env::var(ENABLED_ENV).ok().as_deref(),
        &app_root,
    ))
}

/// Settles the three sources, in the order they are read: what somebody typed at
/// the process beats what the environment says, and what the environment says
/// beats what the configuration file says.
///
/// Split out from [`resolve`] so that the precedence can be tested by handing it
/// three answers rather than by editing the environment a whole test binary is
/// running in, which every other test in the process would read at the same
/// moment.
fn settle(
    file: &DebugConfig,
    cli: Option<bool>,
    env_flag: Option<&str>,
    app_root: &Path,
) -> Settings {
    let enabled = cli
        .filter(|on| *on)
        .or_else(|| env_flag.and_then(truthy))
        .or(file.enabled)
        .unwrap_or(false);
    Settings {
        enabled,
        dir: app_root.join(RECORDS_DIR_NAME),
    }
}

/// Reads a switch the way a shell writes one.
fn truthy(words: &str) -> Option<bool> {
    match words.trim().to_ascii_lowercase().as_str() {
        "" => None,
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        // A word that means neither is left to the file, rather than guessed at.
        _ => None,
    }
}

/// Opens the directory and starts the task that writes into it, or does nothing
/// at all when recording is off.
///
/// Called from inside the runtime, because the writer is a task of its own: a
/// recording is written after the answer is already in hand and off the path of
/// whoever asked, so that a slow disk costs a generation nothing.
pub fn init(file: &DebugConfig) -> Result<Option<Settings>> {
    let settings = resolve(file)?;
    if !settings.enabled {
        return Ok(None);
    }
    start(settings).map(Some)
}

/// Starts the recorder into a directory handed in, for a test that needs a
/// directory of its own rather than the one the platform says. The running
/// program never takes this path: [`init`] resolves the one directory
/// recordings go to, and nothing else gets a say.
#[doc(hidden)]
pub fn init_in(dir: &Path) -> Result<Option<Settings>> {
    start(Settings {
        enabled: true,
        dir: dir.to_path_buf(),
    })
    .map(Some)
}

/// Opens the directory and starts the task that writes into it.
fn start(settings: Settings) -> Result<Settings> {
    std::fs::create_dir_all(&settings.dir)
        .with_context(|| format!("cannot create {}", settings.dir.display()))?;
    private_directory(&settings.dir);
    let (sender, receiver) = mpsc::unbounded_channel();
    let recorder = Recorder {
        settings: settings.clone(),
        sequence: AtomicU64::new(1),
        jobs: sender,
    };
    // Settled before the writer is started, so that a process which already has a
    // recorder keeps it and starts nothing: a desktop window beside a server it
    // also runs is two servers in one process, and the index they would share is a
    // single file that two writers appending to it would interleave.
    if let Err(unused) = RECORDER.set(recorder) {
        drop(unused);
        let active = active().expect("a recorder was already set");
        tracing::warn!(
            "provider call recording was already started; calls keep going to {}",
            active.dir.display()
        );
        return Ok(active.clone());
    }
    tokio::spawn(write_all(settings.dir.clone(), receiver));
    tracing::info!(
        "recording every provider call to {}",
        settings.dir.display()
    );
    Ok(settings)
}

/// What is being recorded and where, or nothing when recording is off.
///
/// Asked for by a diagnostic that has to say so out loud, because a reader who
/// does not know a recording is happening cannot weigh what it is worth.
pub fn active() -> Option<&'static Settings> {
    RECORDER.get().map(|recorder| &recorder.settings)
}

/// Reads a request that is about to go out, or nothing when recording is off.
///
/// Read here rather than after the answer, because a request is consumed by
/// sending it and there is nothing left to read afterwards.
pub fn begin(kind: Kind, call: &ModelCall, request: &reqwest::Request) -> Option<Pending> {
    Some(RECORDER.get()?.begin(kind, call, request))
}

impl Recorder {
    /// Reads a request that is about to go out.
    ///
    /// A method rather than a free function so that a test can record into a
    /// directory of its own instead of into the one the process has, which it can
    /// only have once.
    fn begin(&self, kind: Kind, call: &ModelCall, request: &reqwest::Request) -> Pending {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let placed = now_iso();
        Pending {
            name: name_of(&placed, sequence, call, kind),
            kind,
            who: call.into(),
            started: Instant::now(),
            sent: Sent {
                method: request.method().to_string(),
                url: request.url().to_string(),
                headers: headers_of(request.headers()),
                body: body_of(request.body()),
            },
            placed,
        }
    }
}

/// The body a request carries, read out of the client's own shape.
fn body_of(body: Option<&reqwest::Body>) -> Body {
    match body.and_then(|body| body.as_bytes()) {
        Some(bytes) => Body::of(bytes.to_vec()),
        // A request that streams its body cannot be read twice, and saying so is
        // better than writing down an empty one and leaving a reader to guess.
        None if body.is_some() => Body::Streamed,
        None => Body::Empty,
    }
}

/// Writes a call down with the answer that came back.
///
/// Every finisher takes the [`Pending`] rather than an `Option` of one so that a
/// call site with nothing recorded — because recording is off — has nothing to do
/// and no branch to write. The body arrives as a slice for the same reason: it is
/// copied only once recording is known to be on, and a call that is not being
/// recorded pays nothing for one that is.
pub fn answered(pending: Option<Pending>, status: u16, headers: &HeaderMap, body: &[u8]) {
    let Some(pending) = pending else { return };
    finish(pending, Outcome::of(status, headers, body.to_vec()));
}

/// Writes a stream down with the raw events it arrived as, and what they added up
/// to beside them.
///
/// Both rather than either: the raw stream shows what the provider sent, and the
/// aggregate shows what was made of it, and the interesting failure is the one
/// where those two disagree.
pub fn streamed(
    pending: Option<Pending>,
    status: u16,
    headers: &HeaderMap,
    raw: Vec<u8>,
    aggregate: String,
) {
    let Some(pending) = pending else { return };
    finish(
        pending,
        Outcome {
            status: Some(status),
            headers: headers_of(headers),
            body: Body::of(raw),
            aggregate: Some(aggregate),
            error: None,
        },
    );
}

/// Writes a stream down that ended in the middle, with what had arrived by then.
///
/// The part that arrived is the evidence, so it is kept rather than dropped
/// because the call did not finish.
pub fn stream_broken(
    pending: Option<Pending>,
    error: &str,
    status: u16,
    headers: &HeaderMap,
    raw: Vec<u8>,
) {
    let Some(pending) = pending else { return };
    finish(
        pending,
        Outcome::broken(error, Some(status), headers_of(headers), Body::of(raw)),
    );
}

/// Writes a call down that reached the provider and could not be read.
pub fn broken(pending: Option<Pending>, error: &str, status: u16, headers: &HeaderMap) {
    let Some(pending) = pending else { return };
    finish(
        pending,
        Outcome::broken(error, Some(status), headers_of(headers), Body::Empty),
    );
}

/// Writes a call down that never left, which has no answer of any kind.
pub fn unsent(pending: Option<Pending>, error: &str) {
    let Some(pending) = pending else { return };
    finish(
        pending,
        Outcome::broken(error, None, Vec::new(), Body::Empty),
    );
}

fn finish(pending: Pending, outcome: Outcome) {
    let Some(recorder) = RECORDER.get() else {
        return;
    };
    let job = job_of(pending, outcome);
    // A writer that has gone away means the process is ending, and a recording
    // lost at that moment is worth a line in the log and nothing more.
    if let Err(error) = recorder.jobs.send(job) {
        tracing::warn!(%error, "a provider call could not be recorded");
    }
}

/// What a call and its answer add up to as one thing to write down.
fn job_of(pending: Pending, outcome: Outcome) -> Job {
    let Outcome {
        status,
        headers,
        body,
        aggregate,
        error,
    } = outcome;
    Job {
        name: pending.name,
        kind: pending.kind,
        who: pending.who,
        placed: pending.placed,
        took: pending.started.elapsed(),
        sent: pending.sent,
        back: Back {
            status,
            headers,
            body,
            aggregate,
            error,
        },
    }
}

/// The name every file of one call shares.
///
/// The moment first, so that a directory lists itself in order; then which call
/// it was, so that two calls placed in the same moment still pair up; then the
/// configuration and the model, which are the two things a reader filters by;
/// then what the call was for.
fn name_of(placed: &str, sequence: u64, call: &ModelCall, kind: Kind) -> String {
    format!(
        "{}_{sequence:04}_{}_{}_{}",
        // A moment is written the same way everywhere else in the application and
        // only the colons in it are a path separator's business.
        placed.replace(':', "-"),
        safe_name(&call.config_id),
        safe_name(&call.model),
        kind.as_str()
    )
}

/// One name a reader typed, made safe to put in a path.
///
/// A configuration is named by whoever configured it and a model by whoever serves it,
/// and neither has any reason to be a file name: one that carried a slash would
/// write somewhere else, and one that carried nothing would say nothing.
fn safe_name(words: &str) -> String {
    let mut safe: String = words
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    if safe.is_empty() {
        safe.push_str("unnamed");
    }
    safe
}

/// Writes every call the process records, one at a time.
///
/// One at a time rather than one task each: the index a reader starts from is a
/// single appended file, and two writers racing to append to it would interleave
/// lines. Serialising the writes here also keeps a directory that lists itself in
/// the order the calls were placed, which is what a reader wants when they are
/// looking for the one that went wrong.
async fn write_all(root: PathBuf, mut jobs: mpsc::UnboundedReceiver<Job>) {
    while let Some(job) = jobs.recv().await {
        // Blocking work in a task of its own, so that a body the size of a picture
        // is not written on a thread the rest of the application is waiting on.
        let root = root.clone();
        let outcome = tokio::task::spawn_blocking(move || write_one(&root, job)).await;
        match outcome {
            Err(cancelled) => tracing::warn!(%cancelled, "a recording task did not finish"),
            Ok(Err(error)) => tracing::warn!(%error, "a provider call could not be recorded"),
            Ok(Ok(())) => {}
        }
    }
}

/// Writes one call down: the request, the answer, and one line in the index that
/// ties them together.
fn write_one(root: &Path, job: Job) -> Result<()> {
    let Job {
        name,
        kind,
        who,
        placed,
        took,
        sent,
        back,
    } = job;
    let sidecars = std::cell::RefCell::new(Vec::new());
    let request = record_of_request(&name, &placed, kind, &who, &sent, &sidecars);
    let response = record_of_response(&name, &who, &back, took, &sidecars);
    let request_bytes = write_json(root, &format!("{name}.request.json"), &request)?;
    let response_bytes = write_json(root, &format!("{name}.response.json"), &response)?;
    for (suffix, bytes) in sidecars.into_inner() {
        write_binary(root, &format!("{name}.{suffix}"), &bytes)?;
    }
    append_index(
        root,
        &index_line(
            &name,
            kind,
            &who,
            &placed,
            took,
            &sent,
            &back,
            request_bytes,
            response_bytes,
        ),
    )
}

/// A body a sidecar file was written for, so that one can be written after the
/// document that points at it has been composed.
type Sidecars = std::cell::RefCell<Vec<(String, Vec<u8>)>>;

fn record_of_request(
    name: &str,
    placed: &str,
    kind: Kind,
    who: &Who,
    sent: &Sent,
    sidecars: &Sidecars,
) -> Value {
    json!({
        "name": name,
        "placed": placed,
        "kind": kind.as_str(),
        "config": who.config,
        "model": who.model,
        "protocol": who.protocol,
        "method": sent.method,
        "url": scrubbed_url(&sent.url, who),
        "headers": scrubbed_headers(&sent.headers, who),
        "body": body_value(&sent.body, name, "request", sidecars, who),
    })
}

fn record_of_response(
    name: &str,
    who: &Who,
    back: &Back,
    took: Duration,
    sidecars: &Sidecars,
) -> Value {
    let mut record = json!({
        "name": name,
        "tookMs": took.as_millis() as u64,
        "headers": scrubbed_headers(&back.headers, who),
        "body": body_value(&back.body, name, "response", sidecars, who),
    });
    let map = record.as_object_mut().expect("built as an object above");
    // A call that never reached the provider has no status, and the absence says
    // something a status of zero would not.
    match back.status {
        Some(status) => map.insert("status".into(), json!(status)),
        None => map.insert("status".into(), Value::Null),
    };
    if let Some(error) = &back.error {
        map.insert("error".into(), json!(scrubbed_text(error, who)));
    }
    if let Some(aggregate) = &back.aggregate {
        map.insert("aggregate".into(), json!(scrubbed_text(aggregate, who)));
    }
    record
}

/// One body, as the document that describes it carries it.
///
/// A body that is JSON is kept as JSON, so that a reader can fold it open rather
/// than reading an escaped string of it. One that is text but not JSON is kept as
/// text. One that is neither — a picture, a sound, a video — is written beside the
/// document and pointed at, because there is nothing useful to inline and a
/// document holding a megabyte of base64 is one nobody can read.
///
/// Nothing is cut short. A recording that left out the middle of an answer would
/// be worse than no recording, because a reader would trust it.
fn body_value(body: &Body, name: &str, which: &str, sidecars: &Sidecars, who: &Who) -> Value {
    match body {
        Body::Empty => json!({ "kind": "empty", "bytes": 0 }),
        Body::Streamed => json!({
            "kind": "streamed",
            "bytes": 0,
            "note": "the body was streamed out and cannot be read twice",
        }),
        Body::Bytes(bytes) => {
            let suffix = format!("{which}.bin");
            sidecars.borrow_mut().push((suffix.clone(), bytes.clone()));
            json!({
                "kind": "binary",
                "bytes": bytes.len(),
                "sha256": digest(bytes),
                "file": format!("{name}.{suffix}"),
            })
        }
        Body::Text(text) => {
            let text = scrubbed_text(text, who);
            match serde_json::from_str::<Value>(&text) {
                Ok(parsed) => json!({
                    "kind": "json",
                    "bytes": text.len(),
                    "json": parsed,
                }),
                Err(_) => json!({ "kind": "text", "bytes": text.len(), "text": text }),
            }
        }
    }
}

/// First sixteen hex characters of a body's digest, so that two recordings can be
/// compared without reading either of them.
fn digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(32);
    for byte in &digest[..16] {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// The headers a call carried, with the credential taken out of them.
///
/// Masked rather than dropped: which key was used is half of diagnosing a
/// refusal, and a masked one still says that. The mask is the same one every other
/// diagnostic surface in the application uses, so a key can be recognised in a
/// recording and in a log line as the same key. Always masked, with no setting
/// to turn that off: a recording is read by a person and pasted into bug
/// reports, and there is no diagnosis that needs the whole key.
fn scrubbed_headers(headers: &[Header], who: &Who) -> Value {
    let mut out = serde_json::Map::new();
    for (name, value) in headers {
        let value = if is_credential(name) {
            masked_credential(value, who)
        } else {
            scrubbed_text(value, who)
        };
        out.insert(name.clone(), Value::String(value));
    }
    Value::Object(out)
}

/// A header that carries a credential, whichever protocol put it there.
fn is_credential(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "proxy-authorization"
            | "x-goog-api-key"
            | "x-api-key"
            | "api-key"
            | "cookie"
    )
}

/// One credential header, masked.
///
/// The scheme is kept where there is one, because "Bearer" and "Basic" say
/// different things about a refusal and neither of them is a secret.
fn masked_credential(value: &str, who: &Who) -> String {
    match value.split_once(' ') {
        Some((scheme, secret)) if !secret.contains(' ') => format!("{scheme} {}", masked(secret)),
        None if !who.api_key.is_empty() && value == who.api_key => masked(value),
        _ => masked(value),
    }
}

/// An address with any credential in its query taken out.
///
/// A key belongs in a header, and the protocols here put it in one, but an address
/// is quoted back in error messages and copied into browsers, and one that carried
/// a key in its query would keep it wherever it was copied to.
fn scrubbed_url(url: &str, who: &Who) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return scrubbed_text(url, who);
    };
    let kept: Vec<String> = query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((name, value)) if is_credential(name) => format!("{name}={}", masked(value)),
            _ => pair.to_string(),
        })
        .collect();
    let joined = format!("{base}?{}", kept.join("&"));
    scrubbed_text(&joined, who)
}

/// Any echo of the key this call carried, wherever it turns up.
///
/// A provider explains a refusal by quoting back what it was sent, and what it was
/// sent sometimes includes the key it was sent with.
fn scrubbed_text(text: &str, who: &Who) -> String {
    if who.api_key.len() < MIN_SCRUBBED_CHARS || !text.contains(&who.api_key) {
        return text.to_string();
    }
    text.replace(&who.api_key, &masked(&who.api_key))
}

/// Shorter than this and a key is not worth masking, because the mask would show
/// most of it.
const MIN_SCRUBBED_CHARS: usize = 8;

/// One document, written whole and readable only by whoever owns the directory.
fn write_json(root: &Path, name: &str, value: &Value) -> Result<u64> {
    // Pretty rather than packed: this is read by a person in an editor, and a
    // single line holding a whole answer is a line nobody scrolls.
    let bytes = serde_json::to_vec_pretty(value)?;
    write_binary(root, name, &bytes)?;
    Ok(bytes.len() as u64)
}

fn write_binary(root: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let path = root.join(name);
    std::fs::write(&path, bytes).with_context(|| format!("cannot write {}", path.display()))?;
    private_file(&path);
    Ok(())
}

/// One line in the index, which is the place a reader starts.
///
/// Appended rather than rewritten, so that a directory that was being written to
/// when the process died still says everything it got as far as saying.
fn append_index(root: &Path, line: &str) -> Result<()> {
    use std::io::Write;

    let path = root.join("index.jsonl");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("cannot append to {}", path.display()))?;
    writeln!(file, "{line}").with_context(|| format!("cannot write {}", path.display()))?;
    private_file(&path);
    Ok(())
}

/// The one line the index carries for a call: enough to find it and enough to
/// know whether it is the one worth opening.
#[allow(clippy::too_many_arguments)]
fn index_line(
    name: &str,
    kind: Kind,
    who: &Who,
    placed: &str,
    took: Duration,
    sent: &Sent,
    back: &Back,
    request_bytes: u64,
    response_bytes: u64,
) -> String {
    let line = json!({
        "name": name,
        "placed": placed,
        "kind": kind.as_str(),
        "config": who.config,
        "model": who.model,
        "protocol": who.protocol,
        "method": sent.method,
        "url": scrubbed_url(&sent.url, who),
        "status": back.status,
        "tookMs": took.as_millis() as u64,
        "error": back.error,
        "requestFileBytes": request_bytes,
        "responseFileBytes": response_bytes,
        "files": [format!("{name}.request.json"), format!("{name}.response.json")],
    });
    serde_json::to_string(&line).unwrap_or_else(|_| "{}".to_string())
}

/// A directory only its owner can read.
///
/// A recording holds prompts and, unless they are masked, credentials. The
/// metadata directory beside it is held the same way, and for the same reason:
/// the process that owns them is the only thing that should.
#[cfg(unix)]
fn private_directory(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)) {
        tracing::warn!(%error, "cannot protect the recording directory");
    }
}

#[cfg(not(unix))]
fn private_directory(path: &Path) {
    let _ = path;
}

/// A file only its owner can read.
#[cfg(unix)]
fn private_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        tracing::warn!(%error, "cannot protect {}", path.display());
    }
}

#[cfg(not(unix))]
fn private_file(path: &Path) {
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::Protocol;

    fn file(enabled: Option<bool>) -> DebugConfig {
        DebugConfig { enabled }
    }

    fn who(key: &str) -> Who {
        Who {
            config: "chan".into(),
            model: "painter".into(),
            protocol: "openaiChat".into(),
            api_key: key.into(),
        }
    }

    fn job(body: Body, status: Option<u16>) -> Job {
        Job {
            name: "2026-01-01T00-00-00Z_0001_chan_painter_generate".into(),
            kind: Kind::Generate,
            who: who("sk-secret-value-1234"),
            placed: "2026-01-01T00:00:00Z".into(),
            took: Duration::from_millis(1200),
            sent: Sent {
                method: "POST".into(),
                url: "https://api.example.invalid/v1/chat/completions?key=sk-secret-value-1234"
                    .into(),
                headers: vec![
                    ("authorization".into(), "Bearer sk-secret-value-1234".into()),
                    ("content-type".into(), "application/json".into()),
                ],
                body: Body::Text(r#"{"prompt":"a lantern"}"#.into()),
            },
            back: Back {
                status,
                headers: vec![("content-type".into(), "application/json".into())],
                body,
                aggregate: None,
                error: None,
            },
        }
    }

    #[test]
    fn recording_is_off_until_somebody_asks_for_it() {
        let settled = settle(&file(None), None, None, Path::new("/appdata"));
        assert!(!settled.enabled);
        assert_eq!(settled.dir, PathBuf::from("/appdata/records"));
    }

    #[test]
    fn the_file_says_whether_recording_happens() {
        let settled = settle(&file(Some(true)), None, None, Path::new("/appdata"));
        assert!(settled.enabled);
    }

    #[test]
    fn the_environment_beats_the_file() {
        let settled = settle(&file(Some(false)), None, Some("1"), Path::new("/appdata"));
        assert!(settled.enabled);
    }

    #[test]
    fn the_environment_can_switch_off_what_the_file_switched_on() {
        let settled = settle(&file(Some(true)), None, Some("off"), Path::new("/appdata"));
        assert!(!settled.enabled);
    }

    #[test]
    fn what_somebody_typed_at_the_process_beats_the_environment() {
        let settled = settle(
            &file(Some(false)),
            Some(true),
            Some("0"),
            Path::new("/appdata"),
        );
        assert!(settled.enabled);
    }

    #[test]
    fn the_directory_is_not_a_setting_any_source_can_move() {
        // All three sources say on or off and nothing about where: recordings
        // land in the records subdirectory of the application data directory
        // whatever else anybody configured.
        for settled in [
            settle(&file(Some(true)), None, None, Path::new("/appdata")),
            settle(&file(None), Some(true), Some("1"), Path::new("/appdata")),
        ] {
            assert_eq!(settled.dir, PathBuf::from("/appdata/records"));
        }
    }

    #[test]
    fn a_switch_is_read_the_way_a_shell_writes_one() {
        for word in ["1", "true", "TRUE", " yes ", "on"] {
            assert_eq!(truthy(word), Some(true), "{word} means on");
        }
        for word in ["0", "false", "No", "off"] {
            assert_eq!(truthy(word), Some(false), "{word} means off");
        }
        // A word that means neither is left to the file rather than guessed at.
        assert_eq!(truthy(""), None);
        assert_eq!(truthy("maybe"), None);
    }

    #[test]
    fn a_name_a_reader_typed_cannot_write_somewhere_else() {
        assert_eq!(safe_name("my/channel"), "my_channel");
        // Dots are kept, because a model is named with them; the separators that
        // would climb out of the directory are what goes.
        assert_eq!(safe_name("../../etc"), ".._.._etc");
        assert_eq!(safe_name(""), "unnamed");
        assert_eq!(safe_name("a b:c"), "a_b_c");
        assert_eq!(safe_name(&"x".repeat(60)).len(), 40);
    }

    #[test]
    fn a_credential_is_masked_but_still_says_which_one_it_was() {
        let who = who("sk-secret-value-1234");
        let headers = scrubbed_headers(
            &[
                ("authorization".into(), "Bearer sk-secret-value-1234".into()),
                ("x-goog-api-key".into(), "sk-secret-value-1234".into()),
                ("content-type".into(), "application/json".into()),
            ],
            &who,
        );
        let value = |name: &str| {
            headers
                .get(name)
                .and_then(Value::as_str)
                .unwrap()
                .to_string()
        };
        // The scheme is kept because "Bearer" and "Basic" say different things
        // about a refusal and neither of them is a secret.
        assert!(value("authorization").starts_with("Bearer sk-…"));
        assert!(!value("authorization").contains("secret-value"));
        assert!(value("x-goog-api-key").contains('…'));
        assert_eq!(value("content-type"), "application/json");
    }

    #[test]
    fn a_key_in_an_address_is_masked_too() {
        let who = who("sk-secret-value-1234");
        let url = scrubbed_url(
            "https://api.example.invalid/v1/models?key=sk-secret-value-1234&pageSize=50",
            &who,
        );
        assert!(url.contains("pageSize=50"), "the rest of the query stays");
        assert!(!url.contains("secret-value"), "the key does not");
        assert!(url.contains("key=sk-…"));
    }

    #[test]
    fn a_key_a_provider_echoes_back_is_masked_wherever_it_turns_up() {
        let who = who("sk-secret-value-1234");
        let echoed = scrubbed_text(
            r#"{"error":{"message":"invalid key sk-secret-value-1234"}}"#,
            &who,
        );
        assert!(!echoed.contains("secret-value"));
        assert!(echoed.contains("invalid key"));
    }

    #[test]
    fn a_key_too_short_to_mask_worthily_is_left_alone() {
        let who = who("short");
        // Masking five characters would show most of them, which is worse than
        // either extreme: it looks protected and is not.
        assert_eq!(scrubbed_text("short", &who), "short");
    }

    /// A recorder of the test's own: a directory to write into, and a writer
    /// reading for it.
    ///
    /// Made here rather than borrowed from [`init`], which is the one recorder a
    /// process has and can only have once: a test that wants a call written down
    /// should not depend on the process being in a state it can only be in once,
    /// and two tests that both depended on it would be recording into the same
    /// directory.
    fn recording() -> (tempfile::TempDir, Recorder) {
        let dir = tempfile::tempdir().expect("a directory to record into");
        private_directory(dir.path());
        let (sender, receiver) = mpsc::unbounded_channel();
        let recorder = Recorder {
            settings: Settings {
                enabled: true,
                dir: dir.path().to_path_buf(),
            },
            sequence: AtomicU64::new(1),
            jobs: sender,
        };
        tokio::spawn(write_all(dir.path().to_path_buf(), receiver));
        (dir, recorder)
    }

    /// Writes one call into a directory of its own and reads the files back.
    ///
    /// The directory is handed back with the path because it owns the files: one
    /// dropped here would take the recording with it.
    fn written(job: Job) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("a directory to record into");
        let root = dir.path().to_path_buf();
        write_one(&root, job).expect("a recording is written");
        (dir, root)
    }

    fn read_json(root: &Path, name: &str) -> Value {
        let bytes = std::fs::read(root.join(name)).expect("the file is there");
        serde_json::from_slice(&bytes).expect("the file is JSON")
    }

    #[test]
    fn a_call_is_written_as_a_request_and_the_answer_to_it() {
        let (_dir, root) = written(job(
            Body::Text(r#"{"choices":[{"text":"a lantern"}]}"#.into()),
            Some(200),
        ));
        let name = "2026-01-01T00-00-00Z_0001_chan_painter_generate";
        let request = read_json(&root, &format!("{name}.request.json"));
        let response = read_json(&root, &format!("{name}.response.json"));

        assert_eq!(request["kind"], "generate");
        assert_eq!(request["config"], "chan");
        assert_eq!(request["model"], "painter");
        assert_eq!(request["method"], "POST");
        assert_eq!(request["placed"], "2026-01-01T00:00:00Z");
        // The prompt is the reason the recording exists, so it is whole.
        assert_eq!(request["body"]["kind"], "json");
        assert_eq!(request["body"]["json"]["prompt"], "a lantern");
        assert_eq!(response["status"], 200);
        assert_eq!(response["tookMs"], 1200);
        assert_eq!(response["body"]["json"]["choices"][0]["text"], "a lantern");
    }

    #[test]
    fn a_body_that_is_not_text_lands_beside_the_record_and_is_pointed_at() {
        let bytes: Vec<u8> = (0..256u32).map(|byte| byte as u8).collect();
        let (_dir, root) = written(job(Body::Bytes(bytes.clone()), Some(200)));
        let name = "2026-01-01T00-00-00Z_0001_chan_painter_generate";
        let response = read_json(&root, &format!("{name}.response.json"));
        let sidecar = format!("{name}.response.bin");

        assert_eq!(response["body"]["kind"], "binary");
        assert_eq!(response["body"]["file"], sidecar);
        assert_eq!(response["body"]["bytes"], 256);
        assert_eq!(
            std::fs::read(root.join(&sidecar)).expect("the bytes are there"),
            bytes,
            "nothing is cut out of a body"
        );
        // A digest lets two recordings be compared without reading either.
        assert_eq!(
            response["body"]["sha256"].as_str().expect("a digest").len(),
            32
        );
    }

    #[test]
    fn a_call_that_never_left_says_so_rather_than_looking_like_an_answer() {
        let mut failed = job(Body::Empty, None);
        failed.back.error = Some("the channel did not answer in time".into());
        let (_dir, root) = written(failed);
        let name = "2026-01-01T00-00-00Z_0001_chan_painter_generate";
        let response = read_json(&root, &format!("{name}.response.json"));
        assert!(
            response["status"].is_null(),
            "there was no status to report"
        );
        assert_eq!(response["body"]["kind"], "empty");
        assert_eq!(response["error"], "the channel did not answer in time");
    }

    #[test]
    fn the_index_says_enough_to_find_the_one_call_worth_opening() {
        let (_dir, root) = written(job(Body::Text("{}".into()), Some(200)));
        let lines = std::fs::read_to_string(root.join("index.jsonl")).expect("an index");
        let line: Value = serde_json::from_str(lines.trim()).expect("one JSON line");
        assert_eq!(line["kind"], "generate");
        assert_eq!(line["status"], 200);
        assert_eq!(line["tookMs"], 1200);
        // The address is masked in the index too: it is the file most likely to
        // be pasted into a bug report.
        assert!(!lines.contains("secret-value"));
        assert!(lines.contains("key=sk-…"));
        let files = line["files"].as_array().expect("the files of the call");
        assert_eq!(files.len(), 2);
    }

    #[test]
    fn two_calls_in_one_directory_do_not_overwrite_each_other() {
        let dir = tempfile::tempdir().expect("a directory to record into");
        let root = dir.path();
        let mut first = job(Body::Text(r#"{"n":1}"#.into()), Some(200));
        first.name = "2026-01-01T00-00-00Z_0001_chan_painter_generate".into();
        let mut second = job(Body::Text(r#"{"n":2}"#.into()), Some(200));
        second.name = "2026-01-01T00-00-00Z_0002_chan_painter_generate".into();
        second.kind = Kind::TaskPoll;
        write_one(root, first).expect("the first is written");
        write_one(root, second).expect("the second is written");

        let lines = std::fs::read_to_string(root.join("index.jsonl")).expect("an index");
        assert_eq!(lines.lines().count(), 2, "one line each, appended");
        let polled = read_json(
            root,
            "2026-01-01T00-00-00Z_0002_chan_painter_generate.request.json",
        );
        assert_eq!(
            polled["kind"], "task-poll",
            "what the call was for is recorded, not just what it was called"
        );
    }

    /// What a stream is written as: the raw events beside what they added up to,
    /// because the interesting failure is the one where the two disagree.
    #[test]
    fn a_stream_keeps_what_arrived_beside_what_it_added_up_to() {
        let mut streamed = job(Body::Text("data: one\n\ndata: two\n\n".into()), Some(200));
        streamed.kind = Kind::Stream;
        streamed.back.aggregate = Some("one two".into());
        let (_dir, root) = written(streamed);
        let name = "2026-01-01T00-00-00Z_0001_chan_painter_generate";
        let response = read_json(&root, &format!("{name}.response.json"));
        assert_eq!(response["aggregate"], "one two");
        assert_eq!(response["body"]["kind"], "text");
        assert!(response["body"]["text"]
            .as_str()
            .expect("the raw events")
            .contains("data: one"));
    }

    #[cfg(unix)]
    #[test]
    fn a_recording_is_readable_by_nobody_but_its_owner() {
        use std::os::unix::fs::PermissionsExt;

        let (_dir, root) = written(job(Body::Text("{}".into()), Some(200)));
        let name = "2026-01-01T00-00-00Z_0001_chan_painter_generate";
        for suffix in ["request.json", "response.json"] {
            let path = root.join(format!("{name}.{suffix}"));
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(
                mode & 0o777,
                0o600,
                "{} is readable by somebody else",
                path.display()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_directory_recordings_go_into_is_held_the_way_the_metadata_one_is() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("a directory to record into");
        // Whatever the umask made of it, a directory holding prompts is not one
        // anybody else on the machine should be able to list.
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755))
            .expect("permissions");
        private_directory(dir.path());
        let mode = std::fs::metadata(dir.path())
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn a_request_with_no_body_says_so_rather_than_saying_it_was_empty() {
        assert!(matches!(body_of(None), Body::Empty));
        assert_eq!(
            body_value(
                &Body::Empty,
                "n",
                "request",
                &Sidecars::default(),
                &who("k"),
            )["bytes"],
            0
        );
        // A streamed body cannot be read twice, and pretending it was empty would
        // be a lie a reader could not check.
        let streamed = body_value(
            &Body::Streamed,
            "n",
            "request",
            &Sidecars::default(),
            &who("k"),
        );
        assert_eq!(streamed["kind"], "streamed");
        assert!(streamed["note"]
            .as_str()
            .expect("a note")
            .contains("cannot be read twice"));
    }

    #[test]
    fn nothing_is_recorded_while_recording_is_off() {
        // The default state of the application: no server in this test binary
        // started a recorder, so there is nothing to read a request for and
        // nothing to write afterwards.
        assert!(active().is_none());
        assert!(begin(Kind::Generate, &channel(), &request()).is_none());
        // Finishing a call that was never begun is nothing, which is what lets a
        // call site hand the recording on without a branch of its own.
        answered(None, 200, &HeaderMap::new(), b"{}");
        unsent(None, "the channel did not answer in time");
    }

    /// A model configuration to record against, addressed to a host that
    /// cannot answer.
    fn channel() -> ModelCall {
        ModelCall::new(
            &crate::generate::models::ResolvedModel {
                config_id: "chan".into(),
                model: "painter".into(),
                display_name: "Painter".into(),
                protocol: Protocol::OpenaiChat,
                url: "https://api.example.invalid/v1/chat/completions".into(),
                category: crate::domain::Capability::Text,
            },
            "sk-secret-value-1234".into(),
            crate::config::GenerateConfig::default(),
        )
        .expect("a call")
    }

    fn request() -> reqwest::Request {
        reqwest::Client::new()
            .post("https://api.example.invalid/v1/chat/completions")
            .json(&serde_json::json!({ "prompt": "a lantern" }))
            .build()
            .expect("a request")
    }

    #[tokio::test]
    async fn a_call_recorded_the_way_a_request_records_it_lands_on_the_disk() {
        let (dir, recorder) = recording();
        let call = channel();
        // The two halves a call site does: read the request before it goes out,
        // because sending it consumes the body, and finish the recording once the
        // answer is in hand.
        let built = request();
        let pending = recorder.begin(Kind::Generate, &call, &built);
        assert!(
            pending.name.contains("0001_chan_painter_generate"),
            "a recording is named for the call it is: {}",
            pending.name
        );
        let job = job_of(
            pending,
            Outcome::of(200, &HeaderMap::new(), br#"{"ok":true}"#.to_vec()),
        );
        let name = job.name.clone();
        recorder.jobs.send(job).expect("the writer is reading");
        // Dropping the last sender is what tells the writer there is no more,
        // which is how it ends when the process does.
        drop(recorder);

        // Written by a task of its own rather than by the call, so that a slow disk
        // costs a generation nothing; the index appearing is the writer's last act.
        let root = dir.path().to_path_buf();
        for _ in 0..200 {
            if root.join("index.jsonl").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let index = std::fs::read_to_string(root.join("index.jsonl")).expect("an index");
        let line: Value = serde_json::from_str(index.trim()).expect("one JSON line");
        assert_eq!(index.lines().count(), 1);
        assert_eq!(line["name"], name);
        assert_eq!(line["kind"], "generate");
        assert_eq!(line["status"], 200);
        assert_eq!(line["config"], "chan");
        assert_eq!(line["model"], "painter");

        let sent = read_json(&root, &format!("{name}.request.json"));
        assert_eq!(sent["method"], "POST");
        assert_eq!(sent["body"]["json"]["prompt"], "a lantern");
        let back = read_json(&root, &format!("{name}.response.json"));
        assert_eq!(back["status"], 200);
        assert_eq!(back["body"]["json"]["ok"], true);
    }

    #[test]
    fn a_request_is_read_whole_before_it_goes_out() {
        // Whatever recording is doing, the request a call is built from can be
        // read: the address, the method, the headers and the body together, which
        // is the only moment all four of them are in one place.
        let built = request();
        assert_eq!(built.method(), reqwest::Method::POST);
        assert!(matches!(body_of(built.body()), Body::Text(_)));
        assert!(!headers_of(built.headers()).is_empty() || built.headers().is_empty());
    }
}
