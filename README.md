# Moka Canvas

A React + LeaferJS visual consistency lab delivered through the same Rust localhost server in browsers and a Tauri desktop WebView.

## Prerequisites

- Node.js 22+ and npm
- Rust stable and Cargo
- Tauri platform requirements for the native target you build
  - macOS: Xcode command-line tools
  - Windows: Microsoft C++ Build Tools, WebView2, and WiX/NSIS as required by Tauri

## Run locally

```sh
make install
make web-serve
```

Open `http://127.0.0.1:8080`. The server provides the built React application, SPA fallback, `/api/health`, and `/api/runtime` from one origin.

For the desktop container:

```sh
make tauri-dev
```

Tauri bundles the built `dist/` directory as a resource, starts the same Axum server on an ephemeral loopback port, and points its WebView to that URL.

## Configuration and data

Application-level state — provider channels, encrypted API keys, defaults and preferences, the recent-project list, and the prompt library — lives in one directory under the platform application-data location, never inside the program tree. Startup rejects a directory that resolves next to the executable, inside the served assets, or inside the working directory.

Three environment variables override the resolved values: `MOKA_METADATA_DIR` (location), `MOKA_METADATA_STORE` (only `file` is accepted), and `MOKA_METADATA_KEY` (the server-mode master key, base64 of 32 bytes). The directory must be on a local disk and must be used by one process at a time; a second process pointing at it fails to start and names the pid holding the lock.

Each project document carries its own canvas schema stamp. A document written by an older schema is migrated forward when it opens — every node's ports are reconciled against the current port table — while a document stamped with a newer schema is refused as an unsupported version instead of being partially read. Documents are never rewritten downwards, so read [docs/release-checklist.md](docs/release-checklist.md) before installing an older build over a newer one.

`GET /api/health` reports the store kind, the redacted root, the schema version, the secret-storage tier, and per-document state. `GET /api/ready` answers 503 until the assets are present, a write probe against the metadata directory succeeds, and any open project directory still exists.

Provider channels, default models, and generation preferences are edited in the settings dialog, opened from the **Settings** button on both the launcher and the editor. A channel carries its base URL, protocol, and a per-capability model list; connectivity tests and provider model listing run from the channel row and the channel editor. API keys are written to the local server once and never sent back: the dialog shows only the masked form, and leaving the key field blank keeps whatever is stored.

`POST /api/v1/generate/{text,image,audio,video}` asks a configured channel for one answer. The endpoint names the capability, so a body that disagrees with it is ignored. An answer arrives as one document carrying the text and any media base64-encoded beside its mime type, kind, and dimensions — nothing is written into a project by these endpoints, so a caller decides what to keep. A text request with `params.stream: true` instead answers `text/event-stream`: repeated `delta` frames, then a closing `done` frame with the whole answer. A stream has already sent its status line by the time it can fail, so a failure travels inside that closing frame rather than as a status. Video is the exception — it starts as a handle and is polled at `GET /api/v1/generate/tasks/{id}` until it ends, and a handle the server never issued is missing rather than merely unfinished. Every failure answers the same problem document with the same code in the body and in an `x-error-code` header, and a caller never receives a provider's raw response body — only its message, with any credential that message echoed replaced by the masked form.

See [docs/security.md](docs/security.md) for how credentials are protected and what that protection does not cover, and [docs/deployment.md](docs/deployment.md) for running the standalone server.

## Quality and packaging

```sh
make check
make test
make package-web
make package-macos
make package-windows
make cross-package-windows
make clean
```

`make check` is the full baseline gate: formatting, lint, typecheck, the production web build, the frontend Vitest suite, Rustfmt, Clippy with warnings denied, and the backend `cargo test` suite. `make test` runs just the two test suites (Vitest and `cargo test`) without the lint/format/build gates. `npm run test:e2e` drives the built application in a real browser through Playwright: the launcher-to-editor critical path, missing-asset recovery, and a provider-settings round trip, each against a server started with a temporary metadata directory.

`package-web` stages the built site and a native `moka-server` binary under `release/`. Native app packaging is intentionally host-native: build macOS artifacts on macOS and Windows installers on Windows. Release signing and macOS notarization require organization-specific credentials and are not part of this baseline.

`cross-package-windows` cross-compiles the Windows NSIS installer (`-setup.exe`) on macOS using the `x86_64-pc-windows-gnu` Rust target. It requires the mingw-w64 toolchain and NSIS (`brew install mingw-w64 makensis`); the Rust target itself is installed automatically if missing. The build sets `LC_ALL=en_US.UTF-8` because makensis crashes with `std::bad_alloc` when a non-UTF-8 locale is active (see NSIS bug 1165). `make clean` removes `dist/`, `release/`, `src-tauri/target/`, and TypeScript build caches.

## Comparison workflow

1. Compare **Component lab** and **Token parity** in a browser and Tauri at the same window size.
2. Resize each runtime and use **Interaction lab** controls to ensure stage destruction/recreation is clean.
3. Test high-DPI scaling and direct navigation to `/showcase`, `/playground`, and `/tokens`.
4. Verify no remote fonts, images, CDN scripts, or Tauri JavaScript APIs are required by the frontend.
