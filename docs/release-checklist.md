# Release Checklist

Manual, per-platform verification before publishing a build. Record the
date, build version, and results for each run; a release needs every
critical item passing on every target platform.

Automated coverage (run these first, they gate the release):

```sh
make check        # build + format + lint + typecheck + vitest + cargo tests
npm run test:e2e  # Playwright critical path against the built app
```

## Web (`make package-web`)

1. Run the staged server: `./moka-server --static-dir dist --port 8080`.
2. `GET /api/health` and `GET /api/ready` return 200 with check details.
3. Create a project, add nodes of every kind across two canvases, connect
   them, save, close, reopen — tab order, cameras, and content persist.
4. Import small and large image/audio/video fixtures; preview each, then
   remove them safely (referencing nodes are flagged, never silently
   deleted).
5. Run a valid workflow and an invalid one (validation errors surface on
   the run card); cancel a running workflow; retry a failed one; reopen
   the project and confirm `history/runs/` records are intact.
6. Export a package, import it into a fresh directory, and delete an
   asset file externally before reopening: the self-check dialog offers
   locate-replacement, open-with-missing, and cancel; export without
   restoring offers the incomplete-manifest route.
7. Check the server log: one structured line per API request with request
   id, method, path, status, duration, and error code; no payloads, no
   filesystem internals beyond project paths, no secrets.
8. Open the settings dialog from the launcher and from the editor: add a
   channel from a provider address, edit its models and capabilities,
   run a connectivity test, choose per-capability default models, and
   adjust generation preferences; save, reload, and confirm everything
   persisted. Editing the same channel in two windows at once surfaces a
   conflict notice in the loser instead of silently overwriting.

## macOS (`make package-macos`)

1. Build the DMG; eject any previously mounted copy first (a leftover
   mount makes the bundler fail with a generic `bundle_dmg.sh` error).
2. Mount the DMG read-only, verify the app icon, background, and
   Applications symlink, then eject and clean up the mount the same
   session.
3. Install and launch: Gatekeeper may warn on the unsigned build (first
   launch via right-click → Open).
4. Repeat the web checklist items 3–6 inside the desktop app, including
   native directory pickers (Browse… buttons) and reveal-in-Finder.
5. Double-click a `.moka` file in Finder: it opens in a running instance
   (single-instance) or launches the app with the project open.
6. Audio/video previews play; media blob URLs are allowed by the app CSP.
7. Check the embedded config is used: no `config/` file next to the app
   changes its behavior.

## Windows (`make package-windows` on Windows, or

`make cross-package-windows` on macOS)

1. Verify the installer actually contains the `web/` resource directory
   (`7zz l <setup.exe>`) — an installer built while `dist/` was empty
   silently ships without it and the app exits on launch.
2. Install and launch; SmartScreen may warn on the unsigned build.
3. Repeat the web checklist items 3–6 inside the desktop app.
4. Double-click a `.moka` file in Explorer: the NSIS-registered
   association opens it with the document icon (not the app icon).
5. `.moka` uninstall removes the association (NSIS `APP_UNASSOCIATE`).

## Metadata store (all platforms)

Configuration, recent projects, provider channels, and encrypted credentials
live in the platform application-data directory, never in the program tree. See
[security.md](security.md) and [deployment.md](deployment.md).

1. Record the path from `GET /api/health` (`metadata.root`). It is
   reported with the home directory replaced by a literal `$HOME`;
   expand it and confirm it is the OS application-data location for
   that platform, not the install directory.
2. Confirm no metadata file landed in the program tree: nothing named
   `meta.json`, `recent-projects.json`, `providers.json`,
   `secrets.json`, or `master.key` under the repository `data/`,
   the served `dist/`, or the executable's own directory.
3. Store a real API key through the settings dialog (Channels → Edit →
   API key), then search for it three ways and find nothing —
   `grep -r "sk-"` over the metadata directory, `strings` over every
   file in it, and the captured HTTP responses and server log for
   that session. Only a fingerprint and a masked form may appear.
   The dialog must not echo it either: reopen the channel and
   confirm the key field is empty with the masked form as its
   placeholder. The automated equivalent is
   `cargo test --test metadata_file`.
4. Confirm `secrets.json` is mode `0600` and the metadata directory
   `0700` (macOS and Linux).
5. Confirm `/api/health` reports `secretStorage` and that the value
   fits the runtime: `keyring` for a desktop build with a usable
   keychain, `file` when the master key came from
   `<metadata.dir>/master.key`, `env` for a server started with
   `MOKA_METADATA_KEY`, and `unset` while no credential has ever
   been stored.
6. Hard-kill the process (`kill -9`, or Force Quit / Task Manager),
   then relaunch: `tmp/` is empty, no document is reported
   `corrupt`, channels and the recent-project list are intact, and
   the directory lock was released (no "in use by another process"
   error).
7. Copy the whole metadata directory to another user account or
   another machine and start the app there: channels, defaults,
   preferences, and the prompt library are all present. Stored API
   keys are **not** expected to work unless the master key travelled
   with them — that is the documented behaviour, not a defect.
8. Before installing an **older** build over a newer one, back up the
   metadata directory by copying it whole. A directory written by a
   newer schema version refuses to open and does not downgrade
   itself; the backup is the only way back. Record that the backup
   was taken.
9. Project documents follow the same rule, so copy any open project
   directory too before rolling back. A `.moka` stamped with a canvas
   schema newer than the running build is reported as an unsupported
   version and is never rewritten downwards. Within a schema stamp the
   build does accept, optional fields it does not know — per-node
   generation settings, for instance — are ignored on read instead of
   rejecting the document.

## Performance smoke (reference machine)

1. Open the 200-node/300-edge stress project; pan, zoom, and drag stay
   responsive; frame times stay within the recorded tolerance.
2. A long undo/redo session (30+ operations) neither leaks memory nor
   degrades responsiveness.
3. Autosave never blocks pointer input while a save is in flight.

## Sign-off

| Platform | Build | Date | Result | Notes |
| -------- | ----- | ---- | ------ | ----- |
| Web      |       |      |        |       |
| macOS    |       |      |        |       |
| Windows  |       |      |        |       |
