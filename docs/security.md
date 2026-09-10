# Security

What the application does to protect credentials and configuration, and — just
as importantly — what it does not.

## Metadata directory

Application-level configuration lives in a single directory outside the program
tree, resolved at startup:

| Runtime | macOS                                                 | Windows                           | Linux                                  |
| ------- | ----------------------------------------------------- | --------------------------------- | -------------------------------------- |
| Desktop | `~/Library/Application Support/<identifier>/metadata` | `%APPDATA%\<identifier>\metadata` | `~/.local/share/<identifier>/metadata` |
| Server  | same                                                  | same                              | same                                   |

`<identifier>` is the bundle identifier from `src-tauri/tauri.conf.json`. Both
runtimes derive it from one constant so that the desktop app and a hand-started
`moka-server` on the same machine see the same configuration.

Placing the directory inside the executable's directory, the static asset
directory, or the working directory is rejected at startup with
`CONFIG_METADATA_DIR_INVALID` rather than warned about. Project content never
goes through this layer: canvases, assets, and run history stay inside the
project directory.

Override the location with `MOKA_METADATA_DIR` (see
[deployment.md](deployment.md)).

## API keys

A provider API key is written to disk only as ciphertext:

```
base64( nonce(12 bytes) ‖ AES-256-GCM(master key, plaintext, aad = channel id) )
```

The channel id is bound as additional authenticated data, so copying one
channel's ciphertext under another channel's entry fails to decrypt rather than
silently leaking a key to the wrong provider.

`providers.json` carries no key field of any kind — not an empty one, not a
placeholder. Credentials live in `secrets.json`, which is written `0600` inside a
`0700` directory on Unix.

### Master key

| Runtime | Sources, in order                                                          |
| ------- | -------------------------------------------------------------------------- |
| Desktop | OS keychain, then `<metadata.dir>/master.key` (`0600`)                     |
| Server  | `MOKA_METADATA_KEY` (base64 of 32 bytes), then `<metadata.dir>/master.key` |

Neither source has to exist beforehand. When the first credential is stored and
no key can be found, one is generated: into the keychain on a desktop, into
`<metadata.dir>/master.key` (`0600`) on a server. A server started without an
exported key therefore still accepts an API key instead of failing the moment
someone types one — at the cost of landing on the weakest tier, where the key
sits beside the ciphertext it protects and a copy of the directory carries
both. Export `MOKA_METADATA_KEY` for anything beyond a local, single-user
deployment; `moka-server --generate-key` prints a value.

`/api/health` and every `/api/v1/providers` response report which tier is in
use as `secretStorage` (`keyring`, `env`, `file`, or `unset` while nothing has
been stored), and the settings page repeats it next to the API key field, so
the current level is visible without exposing the key.

If credentials are already on disk and no master key can be found, server
startup fails with `CONFIG_METADATA_KEY_MISSING` rather than generating a key
that would open none of them. Starting anyway would produce the confusing state
where configuration looks complete but every generation request is rejected by
the provider.

### What encryption does and does not buy

The honest positioning, and the one the UI must not overstate:

- **It does** keep plaintext keys out of the metadata directory, out of logs,
  out of HTTP responses, and out of exported project packages. With the key in
  the keychain or exported through the environment it also keeps them out of
  backups of that directory; with a file-held key the backup carries the key
  alongside the ciphertext, so that part of the guarantee is only as strong as
  the tier in use. A misconfigured sync client that uploads the directory does
  not upload usable keys unless it also uploads a file-held master key with
  them.
- **It does not** defend against malware running as the same user. Such a
  process can read the keychain entry or `master.key` and can call the running
  application's own API. This is encryption at rest against accidental exposure,
  not a sandbox.

Never describe stored keys as "secure" or "encrypted, safe" in product copy.
Describe where they are and what they are protected from.

### Redaction

Only two derived forms of a key may leave this layer:

- `fingerprint` — the first 8 hex characters of `sha256(key)`, for matching a
  key across sessions without revealing it;
- `masked` — the first 3 and last 4 characters, for confirming in the UI which
  key is stored.

Both come from one module (`src-tauri/src/metadata/redact.rs`); telemetry and the
HTTP layer reuse it rather than formatting keys themselves. Plaintext keys are
never logged, never serialised into a response body, and never included in an
error message.

Rotation replaces the entry for a channel and updates `rotatedAt`. Previous
ciphertext is not retained, so an old copy of `secrets.json` cannot be used to
recover a superseded key.

### Where a key is allowed to travel

A key leaves this process only towards the host it belongs to, and the rules
around that are deliberately narrow:

- It goes out on a generation request, on a connectivity probe, on a listing of
  what a channel offers, and on an inspection of an address that is not a
  channel yet. Nothing else carries one.
- An inspected credential is used for that one request and dropped. It is not
  written to the metadata store, not returned in the answer — which reports the
  provider's own complaint, never the key that provoked it — and not logged, the
  request log carrying the method, the path, and the status only. That is why
  asking an address what it offers is a separate call from importing it: a wrong
  address or a wrong key must not leave a channel behind holding them.
- The plaintext is decrypted at send time and lives only inside that one
  in-flight request. Configuration holds ciphertext, the gateway decrypts once
  per call, and the task registry holds no credential at all — polling a video
  job resolves and decrypts afresh rather than reusing the key that started it.
- It is sent only to the channel's own host. That includes an address a provider
  hands back for a finished file: it is fetched with the credential only when it
  resolves to the same origin, and without one otherwise, because an image left
  on a third-party CDN is public by nature and a key following it would not be.
- The channel's protocol decides which header carries it. It is never a query
  parameter, so it cannot survive in a proxy log or a browser history.
- A provider's failure is reduced to its message: the envelope around it is
  dropped, a credential the message echoes back is replaced with the masked
  form, and what remains is truncated. Some providers repeat parts of a request
  in a failure, and a response must not become a way of reading a key out.

## Exported packages

A project package (`.moka`, a ZIP) can never contain application metadata:

- credential names — `secrets.json`, `master.key`, and any `*.corrupt.*`
  quarantine copy — are excluded at **any** depth in the tree;
- the other metadata documents (`meta.json`, `recent-projects.json`,
  `providers.json`, `prompts/sources.json`) are excluded at the **project root**
  only, so a project that legitimately contains its own `assets/meta.json` still
  ships it.

Because the metadata directory is structurally outside every project directory,
these guards are a second line of defence rather than the only one. The
exclusion rules appear in the package manifest, so an importer can see what was
left out.

What the two kinds of package differ in is whose machine they describe, and that
is personal data rather than a credential. The package of the work — what an
export makes unless asked otherwise — takes the record of the run that made each
generated asset out of the document, so the asset still says what it was asked
for and with which parameters, but not which run answered on which machine. A
full backup keeps those records, which means it carries every prompt this
machine asked and the name of every model that answered, an internal channel
alias included. That is a choice the export dialog puts to the user, off by
default and saying what it keeps; it is not a leak, but it is a reason to think
about where a full backup is sent.

## Damaged documents

A document that fails to parse is renamed `<name>.corrupt.<timestamp>.json` and
the layer starts from an empty one. Nothing is silently zeroed:

- `/api/health` reports the affected documents with `corrupt: true` and sets
  `ok: false`, which names what was lost and lets the UI distinguish "reset
  because it was damaged" from "empty because it is new";
- a damaged `providers.json` or `secrets.json` never causes `open_project` to
  fail. Project work continues; the channels have to be entered again.

The quarantine copy is preserved so the user can inspect what was lost. It is
excluded from exports under the credential rule above.

## Known limitations

- On Windows the atomic write protocol fsyncs the file but not the parent
  directory; `std` exposes no equivalent API. A power loss immediately after a
  successful write can therefore leave the rename uncommitted.
- The directory lock is advisory and per process. Two processes must not share
  one metadata directory — see [deployment.md](deployment.md).
- Changing the bundle identifier changes the metadata directory. Existing
  configuration is not migrated automatically; set `MOKA_METADATA_DIR` to the old
  path to keep using it.
