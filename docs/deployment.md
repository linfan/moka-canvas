# Deployment

How to run `moka-server` outside the desktop app, and the constraints that come
with the file-backed metadata store.

## The short version

One server process, one metadata directory, on a local disk. There is no
horizontal scaling and no shared-state mode: the configuration store is a
directory of JSON documents guarded by a per-process advisory lock.

## Running the server

```sh
make package-web
cd release/moka-canvas-web-<version>-<platform>-<arch>
./moka-server --static-dir dist --port 8080
```

| Flag           | Default                            | Effect                                                 |
| -------------- | ---------------------------------- | ------------------------------------------------------ |
| `--config`     | `config/moka.yaml`, if it exists   | YAML configuration file                                |
| `--static-dir` | `server.staticDir` from the config | Built frontend to serve                                |
| `--port`       | `server.bind` from the config      | Overrides the port and pins the address to `127.0.0.1` |

The server starts from built-in defaults and reads nothing else, so a first run
needs no file at all. To tune it, copy the tracked example, which says what every
key means and otherwise agrees with those defaults one for one:

```sh
cp config/moka.example.yaml config/moka.yaml
```

`config/moka.yaml` is what one machine wants — an address, a set of ceilings —
and is ignored by git; `config/moka.example.yaml` is documentation and is
tracked. A path named with `--config` is a different matter: if it is not there,
startup fails rather than serving defaults nobody asked for, because a
deployment that meant to be read should not be quietly unread. Relative paths
inside a configuration file resolve against the working directory.

`--port` always binds loopback. Exposing the server on another interface means
editing `server.bind` in the configuration file, and means accepting that there
is no authentication layer: anyone who can reach the port can read and write
every project the process can open. Put it behind a reverse proxy that handles
identity if you need that at all.

## Metadata directory

Configuration, recent projects, provider channels, encrypted credentials, and
the prompt library live in one directory resolved at startup. The default is the
platform application-data directory (see [security.md](security.md)); override it
per deployment:

| Variable              | Overrides        | Notes                                                                                                                    |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `MOKA_METADATA_DIR`   | `metadata.dir`   | Absolute path required                                                                                                   |
| `MOKA_METADATA_STORE` | `metadata.store` | Only `file` is accepted                                                                                                  |
| `MOKA_METADATA_KEY`   | —                | Base64 of 32 bytes; the server-mode master key. Optional — see [Credentials in server mode](#credentials-in-server-mode) |

Startup refuses the directory when it is relative, when it resolves inside the
executable's directory, the static asset directory, or the working directory, or
when it cannot be created and written. In each case the process exits with the
paths it tried rather than starting in a state where nothing is saved.

### It must be on a local disk

Not a network mount. Two parts of the write protocol degrade in ways that cannot
be detected reliably at runtime:

- `rename` is not atomic on some NFS and SMB configurations, so a reader can
  observe a half-written document;
- advisory lock semantics vary, so two hosts mounting the same share can both
  believe they hold the lock.

The first write probe runs at startup and a failure there is fatal, but a mount
that accepts writes and still breaks atomicity will not be caught. Keep the
directory on local storage.

### One process at a time

The directory holds a `.lock` file containing the owner's pid. A second process
that points at the same directory fails to start with `METADATA_UNAVAILABLE` and
names the pid holding it.

Consequences:

- **Multi-instance deployment is unsupported.** Several replicas sharing one
  directory will not work, and several replicas each with their own directory
  will silently diverge — there is no invalidation broadcast and no merge.
  Serving more than one user from a shared configuration requires a database
  backend, which does not exist yet.
- Running the desktop app and a hand-started `moka-server` against the same
  directory does not work either. The desktop app is already single-instance;
  the lock exists for exactly this combination.
- The lock is released when the process exits, including on `kill -9`, so a
  crash does not strand the directory.

## Containers

No image is published and the repository ships no Dockerfile; build one from
`make package-web` if you need it. Two things have to be true inside the
container:

- `MOKA_METADATA_DIR` points at a **mounted volume**. On a read-only root
  filesystem the process exits at startup without one.
- `MOKA_METADATA_KEY` is present if credentials are stored, or if they will be.
  Without it the first stored credential leaves a `master.key` inside the
  mounted volume — usable, but the weaker tier, and it only survives as long as
  the volume does.

```sh
docker run \
  -e MOKA_METADATA_DIR=/data/metadata \
  -e MOKA_METADATA_KEY="$MOKA_METADATA_KEY" \
  -v moka-metadata:/data \
  -p 127.0.0.1:8080:8080 \
  <your-image> --static-dir dist --port 8080
```

The volume must be local to the host, for the reasons given above — a network
volume reintroduces the atomicity problem.

## Credentials in server mode

The desktop app takes its master key from the OS keychain. A server has no
desktop session, so it reads `MOKA_METADATA_KEY` or falls back to
`<metadata.dir>/master.key`.

If neither is there, the first credential stored creates
`<metadata.dir>/master.key` (`0600`) and the server logs a warning. Nothing is
refused, so a server started without the variable is still usable — but the key
then sits beside the ciphertext it protects and a backup of the directory
carries both. That is fine for a local, single-user server. Export a key for
anything else, and check `secretStorage` in `/api/health`: `file` means the
weaker tier.

If `secrets.json` already holds credentials and no master key is available,
startup fails with `CONFIG_METADATA_KEY_MISSING`. Supply the key that sealed
them rather than deleting the document — deleting it discards every stored
credential, and a key generated now opens none of them.

Generate one with either of:

```sh
openssl rand -base64 32
moka-server --generate-key
```

Treat it like any other production secret: inject it from the orchestrator's
secret store, not from a file in the image. Losing it makes the stored
credentials unrecoverable; there is no reset path that preserves them.

## Backup and restore

Backup is copying the directory:

```sh
cp -a "$MOKA_METADATA_DIR" /backups/moka-metadata-$(date +%F)
```

Copy the whole directory, including `master.key` if that is where the key lives.
Restoring is copying it back with the server stopped.

Note that a directory copied to another machine or another user account carries
the configuration but **not** the ability to decrypt credentials when the master
key sits in the OS keychain — the keychain entry does not travel with the files.
Server deployments that use `MOKA_METADATA_KEY` are portable as long as the key
value moves with the backup through whatever channel keeps it secret.

Project data is not in this directory. Projects live wherever the user put them
and are exported as `.moka` packages; see the release checklist.

## Upgrades and rollbacks

`meta.json` records a schema version. A directory written by a **newer** version
refuses to open: the process exits with `METADATA_MIGRATION_FAILED` and a message
saying the directory was written by a newer build. It never downgrades or
overwrites in place.

Before rolling back the application version, back up the metadata directory
(whole-directory copy, as above). A rollback that hits a newer schema version
leaves the old build unable to start until the directory is restored from a
backup taken before the upgrade or removed entirely.

Changing the bundle identifier changes the resolved directory. Point
`MOKA_METADATA_DIR` at the previous path to keep the existing configuration.

## Probes

| Endpoint          | Status     | Purpose                                                                                                                                                                                                                    |
| ----------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health` | always 200 | Liveness plus metadata diagnostics: store kind, redacted root, schema version, secret-storage tier, and per-document size, revision, and corruption flags. `ok` is false when any document was reset from a damaged state. |
| `GET /api/ready`  | 200 or 503 | Readiness: the static asset directory exists, a full write probe against the metadata directory succeeded, and any open project directory still exists. The body lists each check.                                         |

Neither endpoint reports paths verbatim or any credential material.
