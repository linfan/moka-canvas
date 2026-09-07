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

`make check` is the full baseline gate: formatting, lint, typecheck, the production web build, the frontend Vitest suite, Rustfmt, Clippy with warnings denied, and the backend `cargo test` suite. `make test` runs just the two test suites (Vitest and `cargo test`) without the lint/format/build gates.

`package-web` stages the built site and a native `moka-server` binary under `release/`. Native app packaging is intentionally host-native: build macOS artifacts on macOS and Windows installers on Windows. Release signing and macOS notarization require organization-specific credentials and are not part of this baseline.

`cross-package-windows` cross-compiles the Windows NSIS installer (`-setup.exe`) on macOS using the `x86_64-pc-windows-gnu` Rust target. It requires the mingw-w64 toolchain and NSIS (`brew install mingw-w64 makensis`); the Rust target itself is installed automatically if missing. The build sets `LC_ALL=en_US.UTF-8` because makensis crashes with `std::bad_alloc` when a non-UTF-8 locale is active (see NSIS bug 1165). `make clean` removes `dist/`, `release/`, `src-tauri/target/`, and TypeScript build caches.

## Comparison workflow

1. Compare **Component lab** and **Token parity** in a browser and Tauri at the same window size.
2. Resize each runtime and use **Interaction lab** controls to ensure stage destruction/recreation is clean.
3. Test high-DPI scaling and direct navigation to `/showcase`, `/playground`, and `/tokens`.
4. Verify no remote fonts, images, CDN scripts, or Tauri JavaScript APIs are required by the frontend.
