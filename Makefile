SHELL := /bin/sh
CARGO_MANIFEST := src-tauri/Cargo.toml
WINDOWS_CROSS_TARGET := x86_64-pc-windows-gnu

.PHONY: install check check-boundaries test web-build web-serve tauri-dev package-web package-macos package-windows cross-package-windows set-version clean

ifeq (set-version,$(firstword $(MAKECMDGOALS)))
SET_VERSION_ARG := $(word 2,$(MAKECMDGOALS))
ifneq ($(SET_VERSION_ARG),)
$(eval $(SET_VERSION_ARG):;@:)
endif
endif

set-version:
	@test -n "$(SET_VERSION_ARG)" || (printf '%s\n' 'usage: make set-version <semver>  (e.g. make set-version 1.2.3)' >&2; exit 1)
	node scripts/set-version.mjs $(SET_VERSION_ARG)

install:
	npm ci

check: web-build check-boundaries
	npm run format:check
	npm run lint
	npm run typecheck
	npm test
	cargo fmt --manifest-path $(CARGO_MANIFEST) -- --check
	cargo clippy --manifest-path $(CARGO_MANIFEST) --all-targets -- -D warnings
	cargo test --manifest-path $(CARGO_MANIFEST)

# Boundaries that are cheaper to state as a grep than as a test. Each one
# fails the build with the reason, not with a bare non-zero exit.
check-boundaries:
	@! grep -rn "MetadataStore" src-tauri/src/project src-tauri/src/assets src-tauri/src/workflow || \
		(printf '%s\n' 'project content must not reach into the metadata layer' >&2; exit 1)
	@! grep -rn "recent_registry_path\|recentRegistryPath" src-tauri/src src-tauri/tests src-tauri/resources config src || \
		(printf '%s\n' 'the superseded recent-project registry must stay removed' >&2; exit 1)
	@! grep -rn "sqlx\|sea-query\|sea_orm" src-tauri/Cargo.toml src-tauri/src || \
		(printf '%s\n' 'no database dependency while the file backend is the only one' >&2; exit 1)
	@! grep -rn "json.tmp" src-tauri/src || \
		(printf '%s\n' 'documents must go through the single atomic-write implementation' >&2; exit 1)

test:
	npm test
	cargo test --manifest-path $(CARGO_MANIFEST)

web-build:
	npm run build

web-serve: web-build
	cargo run --manifest-path $(CARGO_MANIFEST) --bin moka-server -- --static-dir dist --port 8080

tauri-dev: web-build
	npm run tauri dev

package-web: web-build
	cargo build --release --manifest-path $(CARGO_MANIFEST) --bin moka-server
	node scripts/package-web.mjs

package-macos: web-build
	@test "$$(uname -s)" = "Darwin" || (printf '%s\n' 'package-macos must run on macOS.' >&2; exit 1)
	npm run tauri build -- --bundles dmg
	node scripts/collect-release.mjs

package-windows: web-build
	@case "$$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) printf '%s\n' 'package-windows must run on Windows.' >&2; exit 1;; esac
	npm run tauri build -- --bundles msi,nsis
	node scripts/collect-release.mjs

cross-package-windows: web-build
	@test "$$(uname -s)" = "Darwin" || (printf '%s\n' 'cross-package-windows must run on macOS.' >&2; exit 1)
	@command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 || (printf '%s\n' 'mingw-w64 is required: brew install mingw-w64' >&2; exit 1)
	@command -v makensis >/dev/null 2>&1 || (printf '%s\n' 'makensis is required: brew install makensis' >&2; exit 1)
	@rustup target list --installed | grep -q "$(WINDOWS_CROSS_TARGET)" || rustup target add $(WINDOWS_CROSS_TARGET)
	LC_ALL=en_US.UTF-8 \
	CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc \
	CARGO_TARGET_X86_64_PC_WINDOWS_GNU_AR=x86_64-w64-mingw32-ar \
	npm run tauri build -- --target $(WINDOWS_CROSS_TARGET) --bundles nsis
	node scripts/collect-release.mjs

clean:
	rm -rf dist release src-tauri/target node_modules/.tmp
