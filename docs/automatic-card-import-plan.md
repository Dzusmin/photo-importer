# Automatic import preparation when a card is connected

## Goal

After detecting a card, the application should recognize known media, read
camera profiles from EXIF, run a background scan, and prepare an import plan.
The import itself must always require the user to explicitly approve the plan.

This stage covers source cards. Automatic library backup to an external drive
remains a separate, later stage.

## Agreed behavior

- Behavior is configured separately for each card: `ask`, `autoPreparePlan`, or
  `ignore`.
- An unknown card always requires confirmation of the detected camera profiles.
- A profile receives a default name based on `Make` and `Model`, but the user
  can change it before saving.
- Several cards may use the same camera profile.
- One card may contain media from multiple cameras. A single plan is created
  with visible camera sections.
- Unmatched media goes to an “Unknown camera” section and can be assigned
  manually.
- The presence of `DCIM` automatically identifies a potential card. Media
  without `DCIM` can be scanned and remembered manually.
- A system notification opens the application but does not replace the
  persistent pending-card panel. The pending state lasts until scanning begins,
  the card is explicitly ignored, or the medium is disconnected.
- By default, the application does not force the window to appear. The “Show
  window when the plan is ready” option is configurable.
- Pause and cancellation are honored between complete media sets (for example,
  RAW+JPEG+XMP), not between files within one set.
- Disconnecting a card stops the session with a recoverable error.
- Reconnecting the same card identifies the matching session without a full
  rescan.
- After a restart, resumption requires confirmation by default. Users may
  enable automatic resumption.
- Cancellation can either keep completed files or roll back only the files
  added by that session.
- The default concurrent-import limit is 2 and can be increased in settings.
- The feature must work on Windows, macOS, and Linux.

## Domain model and settings migration

### Settings schema v2

Increment `CURRENT_SETTINGS_SCHEMA_VERSION` to 2 and add an explicit v1 → v2
migration. The current decoder rejects every older version, so migration must
operate on the JSON value before deserialization and validation.

`CameraProfile` should describe a camera, not card behavior:

```text
CameraProfile
  id
  name
  exifMatchers[] { make, model, serialNumber }
  defaultTimeOffsetSeconds
```

Remove `onConnect` from the profile. Move the behavior to the local binding for
a specific medium:

```text
SourceBinding
  id
  sourceIdentity
  displayName
  behavior: ask | autoPreparePlan | ignore
  cameraProfileIds[]
  markerState
  lastSeenAtUnixMs
```

`cameraProfileIds` replaces the single `cameraProfileId` because one card may
contain photos from multiple cameras. Binding data remains local and is not
exported with portable settings.

Add the following to `LocalSettings`:

```text
maxConcurrentImports: 2
resumeAfterRestart: ask | automatic
showWindowWhenPlanReady: false
notificationsEnabled: true
```

The migration preserves existing behavior: for every old `SourceBinding`, it
copies `CameraProfile.onConnect` into the new `behavior` and converts the single
profile identifier into a list. The global `knownSourceBehavior` remains only
the default value for a newly registered card or is renamed to
`defaultSourceBehavior`.

### Validation

- The source identifier and `SourceBinding.id` must be unique.
- Every `cameraProfileIds` entry must refer to an existing profile.
- The concurrency limit must be within a safe range, such as 1–8.
- An EXIF profile must contain at least one of: make, model, or serial number.
- The same registered medium cannot be both a source card and a backup target.
  This stage should introduce a shared media-role type; connect the check to the
  `importer-backup` registry when automatic backup is implemented.

## Card identification

Introduce `SourceIdentity`, which stores the available signals instead of a
single fingerprint calculated from the name and capacity:

```text
SourceIdentity
  markerUuid?
  platformVolumeId?
  fallbackFingerprint
```

Matching priority:

1. The UUID from an application marker stored on the card.
2. A stable volume identifier provided by the operating system.
3. The existing fingerprint of the name, filesystem, and capacity as a
   fallback that requires more careful confirmation.

The marker should be a small, versioned file, such as
`.photo-importer/source.json`. Writing it is optional. A read-only card or a
card on which writing fails can still be registered.

Place volume-identifier adapters behind a shared trait in `importer-media`,
with implementations for Windows, macOS, and Linux. Do not base domain logic on
a drive letter or mount path.

After formatting or an identifier change, a card may be presented as probably
known. The application then asks for confirmation again instead of starting
work automatically.

## Reading and matching EXIF

Extend `importer-media::metadata` from `CaptureTimeReader` to a reader for all
metadata required during a scan:

```text
MediaMetadata
  captureTimestamp?
  cameraIdentity? { make, model, serialNumber }
```

Read `Make`, `Model`, and available serial-number tags. Normalize values by
removing redundant whitespace and compare them case-insensitively, while
retaining their original spelling for display.

Every `MediaItem` receives `cameraIdentity` and `cameraProfileId?`. For a
RAW+JPEG+XMP set:

- read metadata from RAW and JPEG,
- let XMP inherit the camera of the set,
- merge matching results,
- mark conflicting results with a warning and assign them to “Unknown camera”
  until the user decides.

Profile matching order:

1. exact serial number, when available,
2. make + model,
3. no unambiguous match → “Unknown camera.”

Do not create profiles without user approval. The registration wizard shows
the item count for each discovered identity, the proposed name, and the EXIF
fields. It allows the user to select an existing profile, create a new one, or
leave the media unknown.

## Card monitor and persistent pending state

Extend `importer-background` so that it monitors:

- known cards,
- unknown potential cards containing `DCIM`,
- manually selected media without `DCIM` when the user chooses to scan them.

`SourceConnection` should return the card binding and per-card behavior instead
of the name of a single profile.

Introduce the following source workflow states:

```text
detected
awaitingDecision
scanning
awaitingProfileConfirmation
preparingPlan
planReady
importing
disconnected
failedRecoverable
ignoredUntilDisconnect
```

The pending-card list should be part of `BackgroundStatus`, not merely a
transient entry in the event history. This allows React to restore the panel
after the window is reopened. After restarting the application, a connected
card is detected again and returns to the appropriate state.

The `ask` mode creates `awaitingDecision`. `autoPreparePlan` starts a scan but
stops at `awaitingProfileConfirmation` when profile changes have not been
approved. `ignore` sets `ignoredUntilDisconnect`.

The “Ignore this time” command never saves a persistent behavior change.

## Automatic plan preparation

After a scan finishes, the automation should use the same domain and IPC path
as a manual scan:

1. compare content with the import manifest,
2. match or confirm camera profiles,
3. create default event names,
4. prepare the plan,
5. save the plan as pending approval,
6. emit a `plan-ready` event and a system notification.

`ImportPlan` must be extended with camera sections or a stable
`cameraProfileId` on each item. The naming-variable context (`camera_make`,
`camera_model`, `camera_alias`) must be calculated per item, rather than once
for the entire scan as it is now.

The plan must not start copying automatically. Users may change camera
assignments, event names, and exclusions; each such change invalidates the
previous plan and requires it to be recalculated.

The ready-plan state must be persisted, preferably in SQLite alongside import
sessions. Do not store it only as a React object or in process memory. The
record should contain the source identity, the scan result needed to restore
the view, the settings/naming version, and the approval status.

## Import sessions, pause, and resilience to disconnection

The current executor records operations per file and checks control requests
before each operation. Change the control unit to `item_key`:

- a started RAW+JPEG+XMP set finishes in full,
- pause or cancellation takes effect before the next `item_key`,
- progress can still be reported per file,
- in move mode, delete a set's source files only after the entire set has been
  verified.

Classify I/O errors. A missing source or changed mount point produces
`sourceUnavailable` and the `failedRecoverable` status rather than a generic
error. A partial target file is not published; on resumption, the current
operation starts over and undergoes full SHA-256 verification.

When a card is reconnected, the monitor looks up incomplete sessions by
`SourceIdentity`, updates the current source root, and checks the following
before resuming:

- all pending relative paths exist,
- sizes match the saved plan,
- completed target files still match the manifest.

Skipping a full rescan does not mean skipping this integrity check.

After application startup, existing `running` sessions continue to be
recovered as paused. The application layer presents a “Resume” decision unless
`resumeAfterRestart = automatic` is set and the correct card is available.

## Cancellation and safe rollback

Extend the cancellation command with a mode:

```text
keepCompleted
rollbackSession
```

Add a link between an imported record and its session to the manifest. A
rollback may delete a file only when:

- it was published by the specified session,
- it is still located at the recorded target path,
- its current SHA-256 matches the value saved after import.

If the user changed a file after import, the application does not delete it and
reports a conflict requiring a manual decision. File and manifest-record
deletion should be recorded in stages so that an interrupted rollback can be
resumed. Do not delete directories unless they are empty and were created by
the session.

For `MoveAfterVerification` mode, rollback cannot promise to restore a file to
the card if the source has already been deleted. The UI must clearly explain
that only deleting the library copy is possible, which would mean losing the
only copy. By default, rollback for such sets should be blocked or require an
additional warning.

## Concurrency and path reservation

Replace direct startup of each session with a queue managed by `ImportService`:

- the global limit comes from `maxConcurrentImports` and defaults to 2,
- one card may have at most one active session,
- different cards may import concurrently,
- changing the limit affects new starts without interrupting sets already in
  progress.

Plans prepared concurrently may point to the same path. Add persistent target
path reservations for active plans/sessions. Plan approval performs an atomic
collision check against the filesystem and reservations held by other
sessions. Release reservations after completion, cancellation, or successful
rollback.

## UX

### Pending-card panel

Add a persistent list of cards requiring attention to the home screen. Each
card shows its name, capacity, mount point, state, and actions appropriate for
that state.

For `awaitingDecision`:

- “Scan and prepare plan,”
- “Ignore this time,”
- “Change this card's behavior.”

For `awaitingProfileConfirmation`:

- a list of discovered cameras and item counts,
- selection of an existing profile or creation of a new one,
- an editable proposed name,
- an “Unknown camera” section.

For `planReady`:

- “Open plan,”
- a short summary of the number of cameras, events, files, and total size.

### Plan

Group results first by camera and then by event. The “Unknown camera” section
has bulk and individual profile-assignment actions. Moving an item between
profiles immediately invalidates the plan.

### Session controls

- The progress bar shows byte and set progress and the current file.
- “Pause” displays “Stopping after the current set…”.
- “Cancel” opens a “Keep completed” / “Roll back this session” choice.
- `sourceUnavailable` shows the expected card's name and a “Resume” button once
  it is reconnected.
- After a restart, the session has a clear “Interrupted when the application
  closed” status.

## System notifications

Send notifications for:

- detection of a known card in `ask` mode,
- required approval of new profiles,
- a ready plan,
- the start of an import running in the background,
- a pause or source disconnection,
- an error, including insufficient space and verification failure,
- completion and the rollback result.

Clicking a notification opens the appropriate tab/panel in the application.
Notifications do not approve a plan or perform destructive actions. Disabling
notifications does not remove information from the persistent panel or event
history.

## Tauri API and events

Target commands:

- `list_source_workflows`
- `start_source_workflow`
- `ignore_source_until_disconnect`
- `confirm_source_profiles`
- `update_source_behavior`
- `get_pending_import_plan`
- `assign_items_to_camera_profile`
- `approve_import_plan`
- `resume_import_session`
- `cancel_import_session { mode }`
- `retry_import_rollback`

Events:

- `source-workflow-changed`
- `source-profile-confirmation-required`
- `plan-ready`
- `import-progress`
- `import-source-unavailable`
- `rollback-progress`

Commands and events should use the same serialized models so that refreshing
the window yields the same state as live updates.

## Implementation order

### Stage 1 — model and migrations

- Settings schema v2 and the v1 → v2 migration.
- Per-card behavior and a profile list per binding.
- New local settings.
- SQLite migrations for persistent plans, record-to-session links, and
  reservations.

Acceptance criterion: an existing `settings.json` and manifest open without
losing settings or import history.

### Stage 2 — media identification

- `SourceIdentity` and matching logic.
- Optional UUID marker.
- System adapters and fallback.
- Recognition of a probably known card after an identifier change.

Acceptance criterion: the same card is recognized after a drive-letter/mount
point change, while two similar cards are not treated as one without
confirmation.

### Stage 3 — EXIF and profiles

- Full `MediaMetadataReader`.
- Camera identity on `MediaItem`.
- Multiple-profile matching and conflict handling.
- Profile confirmation wizard.

Acceptance criterion: scanning a mixed card creates correct camera sections
and “Unknown camera” without automatically saving a profile.

### Stage 4 — automatic scan → plan

- New monitor state machine.
- Persistent panel for cards requiring a decision.
- Automatic plan preparation and persistence.
- Per-item naming context.

Acceptance criterion: automatic mode ends with a ready, unapproved plan even
when the application window is hidden.

### Stage 5 — resilient import session

- Control at `item_key` boundaries.
- Source-disconnection classification.
- Root rebinding after reconnection.
- State verification and resumption after disconnection/restart.

Acceptance criterion: disconnecting during a large set does not publish a
corrupt file, and resumption completes the import with correct hashes.

### Stage 6 — rollback and concurrency

- Two cancellation modes.
- Safe, resumable rollback.
- Import queue, limit, and path reservations.

Acceptance criterion: two cards can import concurrently without collisions,
and rollback does not delete a file changed outside the application.

### Stage 7 — system integration and final UX

- Notifications with navigation to the appropriate panel.
- Autostart, automatic-resume, and show-window settings.
- Refined tray and event history.
- Tests of installed builds on every operating system.

Acceptance criterion: the complete scenario works with a hidden window and
after restarting the application on Windows, macOS, and Linux.

## Test strategy

### Rust — unit tests

- settings migration from v1 → v2,
- per-card behavior and profile validation,
- `SourceIdentity` priorities,
- EXIF normalization and matching,
- mixed cameras and conflicting RAW/JPEG,
- monitor state-machine transitions,
- pause/cancellation only between `item_key` values,
- safe rollback conditions,
- queue limit and path reservations.

### Rust — integration tests

- scan → profile approval → plan → import,
- disconnection through disappearance of the source directory → reconnection
  at another path → resumption,
- restart between copying and verification,
- two concurrent imports into one library,
- collision between plans prepared concurrently,
- full, partial, and interrupted rollback,
- protection of a file changed after import.

### React/Vitest

- the pending-card panel remains after the notification is dismissed,
- “Ignore this time” lasts until disconnection,
- mandatory profile approval,
- multiple-camera sections and manual assignment of unknown items,
- plan invalidation after editing,
- pause, disconnection, resumption, and rollback messages,
- state restoration after remounting the component.

### Platform tests

Test an installed build on every operating system, not only development mode:

- card detection and removal,
- identifier stability after a mount-point change,
- a read-only card,
- notifications and a click that opens the application,
- background autostart,
- system sleep and wake,
- insufficient permissions and insufficient library space.

## Feature completion criteria

The feature is complete when:

1. no automatic path starts an import without plan approval,
2. profiles detected from EXIF are never saved without confirmation,
3. behavior is independent for each card,
4. pause and cancellation do not split a RAW+JPEG+XMP set,
5. disconnection and restart do not result in a corrupt file or one incorrectly
   considered complete,
6. resumption verifies the card identity and integrity of pending data,
7. rollback deletes only unchanged results of the specified session,
8. the concurrency limit and reservations protect the shared library,
9. a state requiring attention is available in the application independently
   of notifications,
10. acceptance scenarios pass on Windows, macOS, and Linux.
