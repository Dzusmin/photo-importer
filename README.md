# Photo Importer

A cross-platform application for safely importing photos, grouping them into
events, and creating verified backups.

The project has a working application foundation and a complete settings
vertical: the domain model, validation, atomic persistence, recovery backup,
Tauri commands, and a React screen.

## Baseline status

As of September 2, 2026, the functional baseline includes:

- a Tauri desktop application with a React interface for configuration, source
  detection and scanning, grouping media into events, and thumbnail previews,
- deterministic planning and resumable import execution with collision
  handling, SHA-256 checksums, and a persistent SQLite manifest,
- memory-card monitoring, system tray operation, autostart, and notifications,
- local, versioned, and verified library backups,
- frontend unit and integration tests and tests for every Rust crate, also run
  by the `ci` service in Docker Compose.

Current limitations: HEIC files and videos use a placeholder instead of a
generated thumbnail; Docker verifies the application on Linux but does not
create native installers; and NAS and network-share support has not yet been
implemented. Runtime data (settings, manifest, and thumbnail cache) is created
in the operating system's application directories, not in the repository.

## Windows requirements

- Node.js 24
- Rust 1.98 through `rustup`
- Visual Studio with the **Desktop development with C++** workload
- WebView2 Runtime (normally included with Windows 10/11)

After installing Rust for the first time, open a new terminal so that Cargo is
available in `PATH`.

## Running the application

```powershell
npm ci
npm run desktop:dev
```

## Quality checks

```powershell
npm run check
npm run test:coverage
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo bench -p importer-thumbnails --bench thumbnail_pipeline
```

The benchmark methodology and reference result are documented in
[`docs/thumbnail-performance.md`](docs/thumbnail-performance.md).

Frontend tests use Vitest, Testing Library, and mocked Tauri IPC. The HTML
report is written to `coverage/`; coverage thresholds are enforced by
`npm run check` and the CI workflow. Rust tests cover the individual crates and
the complete `scan → group → plan → import → manifest rediscovery` flow.

## Docker

The container runs frontend and Rust tests in a Linux environment:

```powershell
docker compose run --build --rm ci
```

The command uses the `package-lock.json` and `Cargo.lock` lockfiles and the
pinned Rust 1.98 toolchain, making the baseline reproducible.

Docker does not build installers for every platform. Windows, macOS, and Linux
artifacts must be built by native runners for the respective operating systems.
The workflow in `.github/workflows/ci.yml` runs Rust checks on all three.

## Architecture

- `src/` — the React/TypeScript interface
- `src-tauri/` — a thin integration layer between the application and the OS
- `crates/importer-domain/` — business rules independent of Tauri and the OS
- `crates/importer-background/` — media-monitor state and decisions independent of Tauri
- `crates/importer-backup/` — drive registry and versioned, verified local backups
- `crates/importer-import/` — transactional copying, verification, and session resumption
- `crates/importer-manifest/` — import history and content recognition
- `crates/importer-media/` — media detection, file scanning, and event grouping
- `crates/importer-plan/` — safe, deterministic planning of import paths
- `crates/importer-settings/` — versioned loading and atomic saving of JSON settings
- `crates/importer-thumbnails/` — a versioned, disposable JPEG preview cache

The settings repository receives its configuration directory from the
application layer. On the second and every subsequent save, the previous valid
`settings.json` is moved to `settings.json.bak`. A corrupt primary file is not
overwritten automatically; recovering data from the backup requires an
explicit restore operation.

The settings screen configures the library, import behavior, event splitting,
folder names, camera profiles, time adjustments, and local preferences. The
exported JSON contains only portable settings—it omits local paths, autostart,
minimization, and media identifiers. Imported settings are validated and saved
using the same safe mechanism as regular edits.

The home screen refreshes the media list every five seconds, detects removable
cards and volumes containing `DCIM`, and allows users to scan directories they
select manually. The scanner recognizes common JPEG, HEIC, RAW, video, and XMP
files. RAW+JPEG files and their sidecars are combined into a single item, and
items are assigned to events according to the user-configured time gap. Capture
time is read from EXIF or video metadata, with a controlled fallback to the
file modification time. Scan results allow the user to adjust the time of one
or more items and immediately regroup the events.

`crates/importer-manifest/` stores a versioned SQLite database of files that
have already been imported. Comparisons begin with file size and use the
content's SHA-256 hash for possible matches. Renaming a file or using another
card therefore does not cause the same media to be imported again.
EXIF is read by a bounded pool of 2–4 workers, each with its own parser. Results
preserve discovery order. Full hashing on a single medium remains sequential
and uses the sequential-read hint on Windows. After a file is verified, the
manifest stores a cache entry tied to the media identity, path, size,
modification time, and SHA-256 hashes of the first and last 128 KiB. As a
result, rescanning an unchanged source does not require reading the entire file
again.

After scanning, users can name events, exclude complete events or individual
items, and prepare an import plan without writing anything to the library. The
planner expands the folder template, sanitizes names that are invalid on
Windows/macOS/Linux, rejects absolute paths and `..`, skips files recognized in
the manifest, and shows the exact path for every file. Collisions either stop
planning or receive one shared next sequence number for the entire
RAW+JPEG+XMP group, according to the user's setting.

A completed plan can be saved as a persistent import session and started. Each
file is copied to a session-owned `.partial` file, synchronized, compared with
the original by SHA-256, and published without overwriting an existing path.
The manifest is updated only after successful verification. Progress, errors,
and pause and cancellation requests are stored in SQLite, so an interrupted
import can be resumed after restarting the application. Move mode deletes
source files only after all planned copies have been verified and requires an
additional confirmation.

Scanning runs as a job that reports successive phases. During file discovery,
the interface shows an animated progress bar; once the number of supported
files is known, it switches to exact percentage progress. The job can be
cancelled, and a second scan of the same source is not run concurrently.
The history-comparison stage also reports the number of bytes read from the
medium, cache hits, and full reads. Scan results include file-discovery and
metadata-reading durations, making it possible to compare performance on real
cards.

Thumbnails are generated on demand only for items approaching the visible
area, including previews of results arriving during a scan. They are stored as
JPEG files in the application's system cache directory under `thumbnails/v3`,
alongside a local `index.sqlite3`. The cache has a 5 GB limit and evicts the
least recently used entries. The queue deduplicates identical requests, runs
up to four jobs concurrently, and prioritizes the full preview. JPEG files use
the embedded EXIF thumbnail first and otherwise are decoded with downscaling.
For RAW files, the application first obtains an embedded thumbnail or preview
through `rawler`, without decoding the sensor data. Cache files are exposed to
the WebView without the expensive serialization of bytes to JSON. Unsupported
HEIC files and videos receive a placeholder without affecting scanning or
importing. The cache can be safely cleared from the settings screen. Clicking a
JPEG opens the original file directly as a full preview; for RAW files, a
1600 px preview is generated from the image embedded in the container.

The media monitor runs in a separate job even when the main window is hidden.
Every five seconds it compares volume snapshots, responds only when a known
card is actually connected, and permits another response only after it has
been disconnected. The `ask`, `scan automatically`, or `ignore` behavior comes
from the camera profile assigned to the media fingerprint. An automatic scan
uses the same queue, deduplication, and progress bar as a manual scan. A panel
on the home screen shows the automation status, card count, active scans, and
latest event.

The application has a system tray icon with actions to show the window, check
media immediately, and quit. Closing the window hides it when minimize to tray
is enabled; when disabled, it exits the application. An active import session
prevents accidental closure so that copying is not interrupted halfway through
a file. The autostart setting is synchronized with the operating system, and
startup at login uses the `--background` argument so the window stays hidden
when minimization is enabled. System notifications report a known card waiting
for a decision and the result of an automatic scan. On Windows, full
identification and the notification icon are available in an installed build;
in development mode, the system may display the name PowerShell.

The backup engine registers drives under a persistent UUID stored both in the
local registry and on the medium. This prevents a backup from being written to
a different drive that happens to receive the same drive letter. The library
is mirrored in the readable `Photo Backup/Photos` directory, while the SQLite
manifest, drive marker, and older versions are kept in
`Photo Backup/.photo-importer`. The plan compares the SHA-256 hashes of the
source, manifest, and current backup, so it skips unchanged files and detects
backup corruption. New content is written to a temporary file, synchronized,
and verified before publication; the replaced version is moved to a hidden
archive and is not deleted.

NAS and network-share adapters are planned for the next stage.

Further engine components will be added as independent crates so they can also
be tested without launching the desktop interface.
