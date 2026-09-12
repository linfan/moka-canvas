# Build Guide

Prerequisites and commands for building and packaging Moka Canvas on each host.

## Common prerequisites

| Tool           | Version | Notes                                             |
| -------------- | ------- | ------------------------------------------------- |
| Node.js        | 22+     | LTS recommended                                   |
| npm            | 10+     | Ships with Node.js                                |
| Rust toolchain | stable  | Includes `cargo` and `rustup`                     |
| Tauri CLI      | 2.x     | Installed as a dev dependency (`@tauri-apps/cli`) |

Platform-specific requirements for native bundling (Xcode CLI tools, WebView2, WiX/NSIS) are documented by [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## Setup

```sh
make install   # npm ci
```

## Verify the toolchain

```sh
make check
```

Runs the frontend build, Prettier/ESLint/TypeScript checks and the Vitest suite, then `cargo fmt --check`, `cargo clippy -D warnings`, and `cargo test` for the Rust server. `make test` runs only the two test suites (Vitest and `cargo test`).

## Local run

```sh
make web-serve   # Build frontend, serve dist/ + API at http://127.0.0.1:8080
make tauri-dev   # Build frontend, run the Tauri desktop app
```

## Versioning

```sh
make set-version 1.2.3
```

Sets the version of all build outputs in one place: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the `moka-canvas` entry in `src-tauri/Cargo.lock`. Windows installer metadata and the DMG/setup filenames derive from these, so run this before packaging a release.

## Package targets

### Web (any host)

```sh
make package-web
```

Builds the frontend, compiles the `moka-server` release binary, and stages a self-contained distribution under `release/moka-canvas-web-<version>-<platform>-<arch>/` containing `dist/`, the native server binary, and a `README.txt`. Run the staged server with:

```sh
./moka-server --static-dir dist --port 8080
```

### macOS DMG (macOS only)

```sh
make package-macos
```

Produces `Moka Canvas_<version>_<arch>.dmg` (`aarch64` on Apple Silicon, `x64` on Intel), copied into `release/` (the tauri-bundler output remains under `src-tauri/target/release/bundle/dmg/`), with the branded background and app/Applications drop slots configured via `bundle.macOS.dmg` in `src-tauri/tauri.conf.json`. The `.app` bundle is ad-hoc signed (`bundle.macOS.signingIdentity` = `"-"`); the DMG itself is left unsigned, which Tauri does deliberately for self-signed identities. Gatekeeper still warns on first launch because ad-hoc signatures are not notarized — right-click and choose Open.

> Rebuilding deletes the previous DMG, so eject any mounted copy before running `make package-macos` again — otherwise the DMG stays mounted as a leftover volume and the Finder styling step fails with a generic `error running bundle_dmg.sh`.

### Windows installers (Windows host)

```sh
make package-windows
```

Produces MSI and NSIS installers under `src-tauri/target/release/bundle/` and copies them into `release/`. Requires Microsoft C++ Build Tools, WebView2, and WiX/NSIS tooling per Tauri's Windows prerequisites.

The NSIS installer is built from a custom template (`src-tauri/installer/installer.nsi`, forked from the Tauri default) that provides branded welcome and finish pages plus header bitmaps from `src-tauri/installer/`; it is selected via `bundle.windows.nsis.template` in `src-tauri/tauri.conf.json`. Because the template is forked, it does not automatically pick up upstream Tauri fixes — re-diff it against the [upstream template](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi) whenever the Tauri CLI is upgraded.

### Windows installer cross-compile (macOS host)

```sh
make cross-package-windows
```

Cross-compiles the NSIS installer (`Moka Canvas_<version>_x64-setup.exe`) from macOS using the `x86_64-pc-windows-gnu` Rust target and mingw-w64, then copies it into `release/`.

Host prerequisites:

```sh
brew install mingw-w64 makensis
```

The Makefile enforces these checks and installs the missing Rust target automatically. The build sets `LC_ALL=en_US.UTF-8` because makensis aborts with `std::bad_alloc` under non-UTF-8 locales ([NSIS bug 1165](https://sourceforge.net/p/nsis/bugs/1165/)).

Caveats:

- The bundled exe is unsigned; Windows SmartScreen may warn.
- The cross-built installer has not been smoke-tested on a physical Windows machine; verify by installing once before distribution.
- Never run `cross-package-windows` concurrently with another package task (`package-macos`, `package-web`, `web-build`). All of them rebuild `dist/`, and vite empties `dist/` at the start of a rebuild. If the bundler resolves resources while `dist/` is empty, Tauri's resource walker silently skips the directory, producing an installer without `web/` — the installed app then exits immediately on launch (the embedded HTTP server requires the `web/` resource directory). If an installed Windows build "does nothing" on double-click, check that the installer actually contains `web/` (`7zz l <setup.exe>`) and rebuild.

### Updating app icons

Windows uses the icon through two independent paths, both sourced from `src-tauri/icons/`:

- The `.rsrc` section of the exe (explorer/shortcut icons), written by tauri-build.
- An RGBA copy embedded at compile time by the `generate_context!()` macro (runtime window/taskbar icon).

`tauri-build` does not emit `rerun-if-changed` for `icons/icon.ico`, so after replacing icons, a stale build cache can keep the old runtime icon even though the source files are new. Force the lib crate to rebuild before packaging:

```sh
touch src-tauri/src/lib.rs
```

or run `make clean` once. Afterwards, Windows may still show the old icon from its shell icon cache — refresh it on the Windows machine by unpinning the app from the taskbar, reinstalling, re-pinning, then running `ie4uinit.exe -show` (or restarting explorer.exe) to flush the icon cache.

### `.moka` file association

`*.moka` documents are registered to open with the app and use their own document icon (the previous app icon design), built as `src-tauri/icons/moka-file.icns` / `moka-file.ico` and shipped via `bundle.resources` in `src-tauri/tauri.conf.json`:

- **macOS**: `src-tauri/Info.plist` (auto-merged into the bundle's Info.plist by Tauri) declares the `app.mokacanvas.moka` UTI and document type with `CFBundleTypeIconFile` = `moka-file`.
- **Windows (NSIS)**: the forked `installer/installer.nsi` hardcodes `APP_ASSOCIATE`/`APP_UNASSOCIATE` for `.moka` with `DefaultIcon` = `$INSTDIR\moka-file.ico`. This replaces the upstream `{{#each file_associations}}` loop, which cannot use a separate document icon — re-apply the divergence when re-diffing against the upstream template.
- The MSI bundle (built by `package-windows` on a Windows host) does **not** register the association; distribute the NSIS setup exe.

## Clean

```sh
make clean
```

Removes `dist/`, `release/`, `src-tauri/target/`, and TypeScript build caches (`node_modules/.tmp`).

## Signing and notarization

### macOS ad-hoc signing (default)

`bundle.macOS.signingIdentity` is set to `"-"` in `src-tauri/tauri.conf.json`, so the bundler ad-hoc signs the `.app` inside out — external binaries such as `moka-server` and any frameworks first, then the bundle itself. Without this the bundle ships with no `_CodeSignature/CodeResources` at all, only the linker-generated ad-hoc signature on each Mach-O, and `codesign --verify` fails with `code has no resources but signature indicates they must be present`. Verify a build with:

```sh
codesign --verify --verbose=3 "Moka Canvas.app"
codesign -dv --verbose=2 "Moka Canvas.app"   # expect Sealed Resources version=2
```

Ad-hoc signing proves the bundle's contents are intact and consistent with each other. It does **not** satisfy Gatekeeper: ad-hoc signatures cannot be notarized, so a downloaded DMG still prompts, and `spctl` keeps rejecting it. It is what a build with no Apple credentials available can honestly claim, and nothing more.

### Developer ID signing and notarization (release)

Release signing (Authenticode for Windows, Developer ID + notarization for macOS) requires organization-specific credentials and is out of scope for this baseline. When they are available, macOS needs no config change: the CLI reads `APPLE_SIGNING_IDENTITY` and lets it win over `signingIdentity`, so a real identity is supplied per-build without editing the tracked config.

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: <org> (<team id>)" make package-macos
```

Notarization is then attempted automatically when `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` (or the `APPLE_API_KEY*` equivalents) are present, and skipped with a warning when they are not. Note that the DMG stays unsigned whenever the identity is `"-"` — Tauri skips self-signed DMGs on purpose — so signing the DMG itself also requires a real identity.
