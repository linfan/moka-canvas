# Build Guide

Prerequisites and commands for building and packaging Moka Canvas on each host.

## Common prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22+ | LTS recommended |
| npm | 10+ | Ships with Node.js |
| Rust toolchain | stable | Includes `cargo` and `rustup` |
| Tauri CLI | 2.x | Installed as a dev dependency (`@tauri-apps/cli`) |

Platform-specific requirements for native bundling (Xcode CLI tools, WebView2, WiX/NSIS) are documented by [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## Setup

```sh
make install   # npm ci
```

## Verify the toolchain

```sh
make check
```

Runs the frontend build, Prettier/ESLint/TypeScript checks, then `cargo fmt --check`, `cargo clippy -D warnings`, and `cargo test` for the Rust server.

## Local run

```sh
make web-serve   # Build frontend, serve dist/ + API at http://127.0.0.1:8080
make tauri-dev   # Build frontend, run the Tauri desktop app
```

## Package targets

### Web (any host)

```sh
make package-web
```

Builds the frontend, compiles the `moka-server` release binary, and stages a self-contained distribution under `release/moka-canvas-web-<version>-<platform>-<arch>/` containing `dist/`, the native server binary, and a `README.txt`. Run the staged server with:

```sh
./moka-server --static-dir dist --port 8080
```

### macOS app (macOS only)

```sh
make package-macos
```

Produces `Moka Canvas.app` under `src-tauri/target/release/bundle/macos/`. Unsigned; Gatekeeper may warn on first launch.

### Windows installers (Windows host)

```sh
make package-windows
```

Produces MSI and NSIS installers under `src-tauri/target/release/bundle/`. Requires Microsoft C++ Build Tools, WebView2, and WiX/NSIS tooling per Tauri's Windows prerequisites.

### Windows installer cross-compile (macOS host)

```sh
make cross-package-windows
```

Cross-compiles the NSIS installer (`Moka Canvas_<version>_x64-setup.exe`) from macOS using the `x86_64-pc-windows-gnu` Rust target and mingw-w64.

Host prerequisites:

```sh
brew install mingw-w64 makensis
```

The Makefile enforces these checks and installs the missing Rust target automatically. The build sets `LC_ALL=en_US.UTF-8` because makensis aborts with `std::bad_alloc` under non-UTF-8 locales ([NSIS bug 1165](https://sourceforge.net/p/nsis/bugs/1165/)).

Caveats:

- The bundled exe is unsigned; Windows SmartScreen may warn.
- The cross-built installer has not been smoke-tested on a physical Windows machine; verify by installing once before distribution.

## Clean

```sh
make clean
```

Removes `dist/`, `release/`, `src-tauri/target/`, and TypeScript build caches (`node_modules/.tmp`).

## Signing and notarization

Release signing (Authenticode for Windows, Developer ID + notarization for macOS) requires organization-specific credentials and is out of scope for this baseline.
