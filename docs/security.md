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

`/api/health` reports which tier is in use as `secretStorage` so the current
level is visible without exposing the key.

If credentials are on disk and no master key can be found, server startup fails
with `CONFIG_METADATA_KEY_MISSING`. Starting anyway would produce the confusing
state where configuration looks complete but every generation request is
rejected by the provider.

### What encryption does and does not buy

The honest positioning, and the one the UI must not overstate:

- **It does** keep plaintext keys out of the metadata directory, out of backups
  of that directory, out of logs, out of HTTP responses, and out of exported
  project packages. A misconfigured sync client that uploads the directory does
  not upload usable keys.
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
