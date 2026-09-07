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
