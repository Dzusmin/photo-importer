use std::fs;
use std::path::{Path, PathBuf};

use importer_manifest::ImportManifest;
use serde::{Deserialize, Serialize};

use crate::settings::SettingsService;

const EVENT_MARKER: &str = ".photo-importer-event.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventMarker {
    format_version: u8,
    event_id: String,
    session_id: String,
    event_name: String,
    folder_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportEventSummary {
    event_id: String,
    session_id: String,
    name: String,
    folder_path: PathBuf,
    file_count: usize,
    imported_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ImportEventSort {
    #[default]
    LatestImport,
    EventName,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportEventAttention {
    folder_path: PathBuf,
    reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportEventsResult {
    events: Vec<ImportEventSummary>,
    needs_attention: Vec<ImportEventAttention>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EventCommandError {
    code: &'static str,
    message: String,
    technical_details: String,
}

impl EventCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            code,
            technical_details: message.clone(),
            message,
        }
    }

    fn needs_repair(operation_error: &EventCommandError, rollback_errors: &[String]) -> Self {
        Self {
            code: "eventRenameNeedsRepair",
            message:
                "Nie udało się w pełni wycofać zmiany nazwy wydarzenia. Wydarzenie wymaga naprawy."
                    .to_owned(),
            technical_details: format!(
                "rename failed ({}): {}; rollback failed: {}",
                operation_error.code,
                operation_error.technical_details,
                rollback_errors.join("; ")
            ),
        }
    }

    fn external_rename_sync_failed(operation_error: &EventCommandError) -> Self {
        Self {
            code: "eventExternalRenameSyncFailed",
            message: "Nie udało się zsynchronizować zewnętrznej zmiany nazwy wydarzenia."
                .to_owned(),
            technical_details: format!(
                "external rename synchronization failed ({}): {}",
                operation_error.code, operation_error.technical_details
            ),
        }
    }

    fn external_rename_needs_repair(
        operation_error: &EventCommandError,
        rollback_error: &EventCommandError,
    ) -> Self {
        Self {
            code: "eventExternalRenameNeedsRepair",
            message: "Nie udało się zsynchronizować zewnętrznej zmiany nazwy wydarzenia ani przywrócić markera. Wydarzenie wymaga naprawy."
                .to_owned(),
            technical_details: format!(
                "external rename synchronization failed ({}): {}; marker restore failed ({}): {}",
                operation_error.code,
                operation_error.technical_details,
                rollback_error.code,
                rollback_error.technical_details
            ),
        }
    }
}

#[tauri::command]
pub(crate) fn list_import_events(
    sort: Option<ImportEventSort>,
    settings: tauri::State<'_, SettingsService>,
    manifest: tauri::State<'_, ImportManifest>,
) -> Result<ImportEventsResult, EventCommandError> {
    let root = settings
        .current_settings()
        .map_err(|error| EventCommandError::new("settingsUnavailable", error.message()))?
        .local
        .library_path
        .ok_or_else(|| {
            EventCommandError::new(
                "libraryPathMissing",
                "Katalog biblioteki nie jest ustawiony.",
            )
        })?;
    let mut events = Vec::new();
    let mut needs_attention = Vec::new();
    collect_events(&root, &manifest, &mut events, &mut needs_attention)?;
    sort_events(&mut events, sort.unwrap_or_default());
    needs_attention.sort_by(|left, right| right.folder_path.cmp(&left.folder_path));
    Ok(ImportEventsResult {
        events,
        needs_attention,
    })
}

fn sort_events(events: &mut [ImportEventSummary], sort: ImportEventSort) {
    events.sort_by(|left, right| match sort {
        ImportEventSort::LatestImport => right
            .imported_at_unix_ms
            .cmp(&left.imported_at_unix_ms)
            .then_with(|| left.event_id.cmp(&right.event_id)),
        ImportEventSort::EventName => left
            .name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.event_id.cmp(&right.event_id)),
    });
}

#[tauri::command]
pub(crate) fn rename_import_event(
    event_id: String,
    new_name: String,
    settings: tauri::State<'_, SettingsService>,
    manifest: tauri::State<'_, ImportManifest>,
) -> Result<ImportEventSummary, EventCommandError> {
    let new_name = new_name.trim();
    if new_name.is_empty()
        || new_name == "."
        || new_name == ".."
        || new_name.chars().any(|character| {
            matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        })
    {
        return Err(EventCommandError::new(
            "eventNameInvalid",
            "Nazwa wydarzenia zawiera niedozwolone znaki.",
        ));
    }
    let root = settings
        .current_settings()
        .map_err(|error| EventCommandError::new("settingsUnavailable", error.message()))?
        .local
        .library_path
        .ok_or_else(|| {
            EventCommandError::new(
                "libraryPathMissing",
                "Katalog biblioteki nie jest ustawiony.",
            )
        })?;
    let (marker_path, mut marker) = find_marker(&root, &event_id)?.ok_or_else(|| {
        EventCommandError::new("eventNotFound", "Nie znaleziono katalogu wydarzenia.")
    })?;
    let old_folder = marker_path.parent().unwrap_or(&root).to_path_buf();
    let old_folder_name = old_folder.file_name().unwrap_or_default().to_string_lossy();
    let prefix = old_folder_name
        .strip_suffix(&marker.event_name)
        .unwrap_or("");
    let new_folder_name = format!("{prefix}{new_name}");
    let new_folder = old_folder.parent().unwrap_or(&root).join(&new_folder_name);
    if new_folder != old_folder && new_folder.exists() {
        return Err(EventCommandError::new(
            "eventDestinationExists",
            "Katalog o tej nazwie już istnieje.",
        ));
    }
    let old_name = marker.event_name.clone();
    marker.event_name = new_name.to_owned();
    marker.folder_name = new_folder_name;

    rename_event_transaction(
        &old_folder,
        &new_folder,
        &marker,
        |old_folder, new_folder| {
            manifest
                .rename_import_event_paths(
                    &marker.session_id,
                    &old_name,
                    new_name,
                    old_folder,
                    new_folder,
                )
                .map_err(|error| {
                    EventCommandError::new("eventHistoryUpdateFailed", error.to_string())
                })
        },
        |old_folder, new_folder| {
            manifest
                .rename_import_event_paths(
                    &marker.session_id,
                    new_name,
                    &old_name,
                    new_folder,
                    old_folder,
                )
                .map_err(|error| {
                    EventCommandError::new("eventHistoryRollbackFailed", error.to_string())
                })
        },
    )?;
    summary(&new_folder, &marker, &manifest)
}

fn rename_event_transaction(
    old_folder: &Path,
    new_folder: &Path,
    new_marker: &EventMarker,
    update_history: impl FnOnce(&Path, &Path) -> Result<(), EventCommandError>,
    restore_history: impl FnOnce(&Path, &Path) -> Result<(), EventCommandError>,
) -> Result<(), EventCommandError> {
    let old_marker = read_marker(&old_folder.join(EVENT_MARKER))?;
    let folder_was_renamed = new_folder != old_folder;

    if folder_was_renamed {
        fs::rename(old_folder, new_folder)
            .map_err(|error| EventCommandError::new("eventRenameFailed", error.to_string()))?;
    }

    if let Err(error) = write_marker(&new_folder.join(EVENT_MARKER), new_marker) {
        return rollback_event_rename(
            old_folder,
            new_folder,
            &old_marker,
            folder_was_renamed,
            error,
            Vec::new(),
        );
    }

    if let Err(error) = update_history(old_folder, new_folder) {
        let mut rollback_errors = Vec::new();
        if let Err(rollback_error) = restore_history(old_folder, new_folder) {
            rollback_errors.push(format!(
                "history restore: {}",
                rollback_error.technical_details
            ));
        }
        return rollback_event_rename(
            old_folder,
            new_folder,
            &old_marker,
            folder_was_renamed,
            error,
            rollback_errors,
        );
    }

    Ok(())
}

fn rollback_event_rename(
    old_folder: &Path,
    current_folder: &Path,
    old_marker: &EventMarker,
    folder_was_renamed: bool,
    operation_error: EventCommandError,
    mut rollback_errors: Vec<String>,
) -> Result<(), EventCommandError> {
    if let Err(error) = write_marker(&current_folder.join(EVENT_MARKER), old_marker) {
        rollback_errors.push(format!("marker restore: {}", error.technical_details));
    }
    if folder_was_renamed && let Err(error) = fs::rename(current_folder, old_folder) {
        rollback_errors.push(format!("folder restore: {error}"));
    }

    if rollback_errors.is_empty() {
        Err(operation_error)
    } else {
        Err(EventCommandError::needs_repair(
            &operation_error,
            &rollback_errors,
        ))
    }
}

fn collect_events(
    directory: &Path,
    manifest: &ImportManifest,
    events: &mut Vec<ImportEventSummary>,
    needs_attention: &mut Vec<ImportEventAttention>,
) -> Result<(), EventCommandError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(EventCommandError::new(
                "eventHistoryReadFailed",
                error.to_string(),
            ));
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let marker_path = path.join(EVENT_MARKER);
        if marker_path.is_file() {
            let mut marker = match read_marker(&marker_path) {
                Ok(marker) => marker,
                Err(error) => {
                    needs_attention.push(ImportEventAttention {
                        folder_path: path.clone(),
                        reason: error.message,
                    });
                    collect_events(&path, manifest, events, needs_attention)?;
                    continue;
                }
            };
            let actual_folder_name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if actual_folder_name != marker.folder_name {
                let old_marker = marker.clone();
                let old_name = marker.event_name.clone();
                let prefix = marker
                    .folder_name
                    .strip_suffix(&marker.event_name)
                    .unwrap_or("");
                marker.event_name = actual_folder_name
                    .strip_prefix(prefix)
                    .filter(|name| !name.is_empty())
                    .unwrap_or(&actual_folder_name)
                    .to_owned();
                let old_folder = path.parent().unwrap_or(directory).join(&marker.folder_name);
                marker.folder_name = actual_folder_name;
                sync_external_event_rename(
                    &marker_path,
                    &old_marker,
                    &marker,
                    write_marker,
                    || {
                        manifest
                            .rename_import_event_paths(
                                &marker.session_id,
                                &old_name,
                                &marker.event_name,
                                &old_folder,
                                &path,
                            )
                            .map_err(|error| {
                                EventCommandError::new(
                                    "eventHistoryUpdateFailed",
                                    error.to_string(),
                                )
                            })
                    },
                )?;
            }
            events.push(summary(&path, &marker, manifest)?);
        }
        collect_events(&path, manifest, events, needs_attention)?;
    }
    Ok(())
}

fn sync_external_event_rename(
    marker_path: &Path,
    old_marker: &EventMarker,
    new_marker: &EventMarker,
    mut persist_marker: impl FnMut(&Path, &EventMarker) -> Result<(), EventCommandError>,
    update_history: impl FnOnce() -> Result<(), EventCommandError>,
) -> Result<(), EventCommandError> {
    persist_marker(marker_path, new_marker)
        .map_err(|error| EventCommandError::external_rename_sync_failed(&error))?;

    if let Err(error) = update_history() {
        return match persist_marker(marker_path, old_marker) {
            Ok(()) => Err(EventCommandError::external_rename_sync_failed(&error)),
            Err(rollback_error) => Err(EventCommandError::external_rename_needs_repair(
                &error,
                &rollback_error,
            )),
        };
    }

    Ok(())
}

fn find_marker(
    root: &Path,
    event_id: &str,
) -> Result<Option<(PathBuf, EventMarker)>, EventCommandError> {
    let entries = fs::read_dir(root)
        .map_err(|error| EventCommandError::new("eventHistoryReadFailed", error.to_string()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let marker_path = path.join(EVENT_MARKER);
        if marker_path.is_file()
            && let Ok(marker) = read_marker(&marker_path)
            && marker.event_id == event_id
        {
            return Ok(Some((marker_path, marker)));
        }
        if let Some(found) = find_marker(&path, event_id)? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn read_marker(path: &Path) -> Result<EventMarker, EventCommandError> {
    let contents = fs::read(path)
        .map_err(|error| EventCommandError::new("eventMarkerReadFailed", error.to_string()))?;
    serde_json::from_slice(&contents)
        .map_err(|error| EventCommandError::new("eventMarkerInvalid", error.to_string()))
}

fn write_marker(path: &Path, marker: &EventMarker) -> Result<(), EventCommandError> {
    let contents = serde_json::to_vec_pretty(marker)
        .map_err(|error| EventCommandError::new("eventMarkerInvalid", error.to_string()))?;
    fs::write(path, contents)
        .map_err(|error| EventCommandError::new("eventMarkerWriteFailed", error.to_string()))
}

fn summary(
    folder: &Path,
    marker: &EventMarker,
    manifest: &ImportManifest,
) -> Result<ImportEventSummary, EventCommandError> {
    let file_count = manifest
        .completed_event_file_count(&marker.session_id, &marker.event_name)
        .map_err(|error| EventCommandError::new("eventHistoryReadFailed", error.to_string()))?;
    let imported_at_unix_ms = manifest
        .get_import_session(&marker.session_id)
        .map_err(|error| EventCommandError::new("eventHistoryReadFailed", error.to_string()))?
        .and_then(|session| session.completed_at_unix_ms);
    Ok(ImportEventSummary {
        event_id: marker.event_id.clone(),
        session_id: marker.session_id.clone(),
        name: marker.event_name.clone(),
        folder_path: folder.to_path_buf(),
        file_count,
        imported_at_unix_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn marker(event_name: &str, folder_name: &str) -> EventMarker {
        EventMarker {
            format_version: 1,
            event_id: "event-1".to_owned(),
            session_id: "session-1".to_owned(),
            event_name: event_name.to_owned(),
            folder_name: folder_name.to_owned(),
        }
    }

    fn event(
        event_id: &str,
        name: &str,
        folder: &str,
        imported_at: Option<u64>,
    ) -> ImportEventSummary {
        ImportEventSummary {
            event_id: event_id.to_owned(),
            session_id: "session-1".to_owned(),
            name: name.to_owned(),
            folder_path: folder.into(),
            file_count: 1,
            imported_at_unix_ms: imported_at,
        }
    }

    #[test]
    fn sorts_by_latest_import_by_default_with_a_stable_event_id_tie_breaker() {
        let mut events = vec![
            event("b", "Newest B", "A-folder", Some(20)),
            event("old", "Old", "Z-folder", Some(10)),
            event("a", "Newest A", "Z-folder", Some(20)),
            event("missing", "Missing", "ZZ-folder", None),
        ];

        sort_events(&mut events, ImportEventSort::default());

        assert_eq!(
            events
                .iter()
                .map(|event| event.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b", "old", "missing"]
        );
    }

    #[test]
    fn supports_explicit_event_name_sorting_with_a_stable_event_id_tie_breaker() {
        let mut events = vec![
            event("b", "beta", "A-folder", Some(30)),
            event("z", "Alpha", "Z-folder", Some(10)),
            event("a", "alpha", "B-folder", Some(20)),
        ];

        sort_events(&mut events, ImportEventSort::EventName);

        assert_eq!(
            events
                .iter()
                .map(|event| event.event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "z", "b"]
        );
    }

    #[test]
    fn summary_counts_completed_manifest_files_instead_of_directory_entries() {
        use importer_manifest::{
            ImportSessionOperation, ImportSessionStatus, NewImportOperation, NewImportSession,
            OperationStatus,
        };
        let directory = tempfile::tempdir().unwrap();
        let event_folder = directory.path().join("library/event");
        let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
        let operation = |item: &str, file: &str| NewImportOperation {
            item_key: item.into(),
            event_name: "event".into(),
            source_path: directory.path().join("card").join(file),
            source_relative_path: file.into(),
            destination_path: event_folder.join(file),
            destination_relative_path: std::path::Path::new("event").join(file),
            kind: "jpeg".into(),
            size_bytes: 10,
        };
        let session = manifest
            .create_import_session(&NewImportSession {
                operation: ImportSessionOperation::Copy,
                library_root: directory.path().join("library"),
                source_fingerprint: None,
                source_identity: None,
                move_confirmed: false,
                operations: vec![operation("item-a", "a.jpg"), operation("item-b", "b.jpg")],
            })
            .unwrap();
        manifest
            .mark_operation_status(session.operations[0].id, OperationStatus::Completed, None)
            .unwrap();
        manifest
            .mark_session_status(&session.id, ImportSessionStatus::Completed, None)
            .unwrap();
        fs::create_dir_all(event_folder.join("foreign-directory")).unwrap();
        fs::write(event_folder.join("foreign.txt"), b"not imported").unwrap();
        let event_marker = EventMarker {
            session_id: session.id,
            event_name: "event".into(),
            folder_name: "event".into(),
            ..marker("event", "event")
        };

        let event = summary(&event_folder, &event_marker, &manifest).unwrap();

        assert_eq!(event.file_count, 1);
        assert!(event.imported_at_unix_ms.is_some());
    }

    #[test]
    fn rolls_back_folder_and_marker_when_history_update_fails() {
        let directory = tempfile::tempdir().unwrap();
        let old_folder = directory.path().join("2026-09-14 Old name");
        let new_folder = directory.path().join("2026-09-14 New name");
        fs::create_dir(&old_folder).unwrap();
        let old_marker = marker("Old name", "2026-09-14 Old name");
        let new_marker = marker("New name", "2026-09-14 New name");
        write_marker(&old_folder.join(EVENT_MARKER), &old_marker).unwrap();

        let error = rename_event_transaction(
            &old_folder,
            &new_folder,
            &new_marker,
            |_, _| {
                Err(EventCommandError::new(
                    "eventHistoryUpdateFailed",
                    "database",
                ))
            },
            |_, _| Ok(()),
        )
        .unwrap_err();

        assert_eq!(error.code, "eventHistoryUpdateFailed");
        assert!(old_folder.is_dir());
        assert!(!new_folder.exists());
        let restored_marker = read_marker(&old_folder.join(EVENT_MARKER)).unwrap();
        assert_eq!(restored_marker.event_name, old_marker.event_name);
        assert_eq!(restored_marker.folder_name, old_marker.folder_name);
    }

    #[test]
    fn keeps_all_three_stores_updated_after_success() {
        let directory = tempfile::tempdir().unwrap();
        let old_folder = directory.path().join("2026-09-14 Old name");
        let new_folder = directory.path().join("2026-09-14 New name");
        fs::create_dir(&old_folder).unwrap();
        let old_marker = marker("Old name", "2026-09-14 Old name");
        let new_marker = marker("New name", "2026-09-14 New name");
        write_marker(&old_folder.join(EVENT_MARKER), &old_marker).unwrap();
        let mut history_updated = false;

        rename_event_transaction(
            &old_folder,
            &new_folder,
            &new_marker,
            |history_old_folder, history_new_folder| {
                assert_eq!(history_old_folder, old_folder);
                assert_eq!(history_new_folder, new_folder);
                history_updated = true;
                Ok(())
            },
            |_, _| panic!("history rollback must not run after success"),
        )
        .unwrap();

        assert!(history_updated);
        assert!(!old_folder.exists());
        assert!(new_folder.is_dir());
        let saved_marker = read_marker(&new_folder.join(EVENT_MARKER)).unwrap();
        assert_eq!(saved_marker.event_name, new_marker.event_name);
        assert_eq!(saved_marker.folder_name, new_marker.folder_name);
    }

    #[test]
    fn reports_repair_state_when_compensation_is_incomplete() {
        let directory = tempfile::tempdir().unwrap();
        let old_folder = directory.path().join("Old name");
        let new_folder = directory.path().join("New name");
        fs::create_dir(&old_folder).unwrap();
        let old_marker = marker("Old name", "Old name");
        let new_marker = marker("New name", "New name");
        write_marker(&old_folder.join(EVENT_MARKER), &old_marker).unwrap();

        let error = rename_event_transaction(
            &old_folder,
            &new_folder,
            &new_marker,
            |_, _| {
                fs::create_dir(&old_folder).unwrap();
                fs::write(old_folder.join("blocker"), b"occupied").unwrap();
                Err(EventCommandError::new(
                    "eventHistoryUpdateFailed",
                    "database",
                ))
            },
            |_, _| Ok(()),
        )
        .unwrap_err();

        assert_eq!(error.code, "eventRenameNeedsRepair");
        assert!(error.technical_details.contains("folder restore"));
        assert!(new_folder.is_dir());
        assert_eq!(
            read_marker(&new_folder.join(EVENT_MARKER))
                .unwrap()
                .event_name,
            old_marker.event_name
        );
    }

    #[test]
    fn reports_external_rename_sync_failure_when_marker_write_fails() {
        let old_marker = marker("Old name", "Old name");
        let new_marker = marker("New name", "New name");
        let history_updated = Cell::new(false);

        let error = sync_external_event_rename(
            Path::new("marker.json"),
            &old_marker,
            &new_marker,
            |_, _| {
                Err(EventCommandError::new(
                    "eventMarkerWriteFailed",
                    "read only",
                ))
            },
            || {
                history_updated.set(true);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "eventExternalRenameSyncFailed");
        assert!(error.technical_details.contains("eventMarkerWriteFailed"));
        assert!(!history_updated.get());
    }

    #[test]
    fn restores_marker_when_external_rename_history_update_fails() {
        let directory = tempfile::tempdir().unwrap();
        let marker_path = directory.path().join(EVENT_MARKER);
        let old_marker = marker("Old name", "Old name");
        let new_marker = marker("New name", "New name");
        write_marker(&marker_path, &old_marker).unwrap();

        let error = sync_external_event_rename(
            &marker_path,
            &old_marker,
            &new_marker,
            write_marker,
            || {
                Err(EventCommandError::new(
                    "eventHistoryUpdateFailed",
                    "database",
                ))
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "eventExternalRenameSyncFailed");
        assert!(error.technical_details.contains("eventHistoryUpdateFailed"));
        assert_eq!(
            read_marker(&marker_path).unwrap().event_name,
            old_marker.event_name
        );
    }

    #[test]
    fn collect_events_does_not_return_unsynchronized_external_rename() {
        let directory = tempfile::tempdir().unwrap();
        let event_folder = directory.path().join("New name");
        fs::create_dir(&event_folder).unwrap();
        let old_marker = marker("Old name", "Old name");
        let marker_path = event_folder.join(EVENT_MARKER);
        write_marker(&marker_path, &old_marker).unwrap();

        let database = directory.path().join("manifest.sqlite3");
        let manifest = ImportManifest::open(&database).unwrap();
        fs::rename(&database, directory.path().join("manifest.sqlite3.bak")).unwrap();
        fs::create_dir(&database).unwrap();
        let mut events = Vec::new();

        let mut needs_attention = Vec::new();
        let error = collect_events(
            directory.path(),
            &manifest,
            &mut events,
            &mut needs_attention,
        )
        .unwrap_err();

        assert_eq!(error.code, "eventExternalRenameSyncFailed");
        assert!(events.is_empty());
        assert!(needs_attention.is_empty());
        assert_eq!(read_marker(&marker_path).unwrap().event_name, "Old name");
    }

    #[test]
    fn collect_events_reports_invalid_markers_as_needing_attention() {
        let directory = tempfile::tempdir().unwrap();
        let broken_folder = directory.path().join("Broken event");
        fs::create_dir(&broken_folder).unwrap();
        fs::write(broken_folder.join(EVENT_MARKER), b"not valid json").unwrap();
        let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
        let mut events = Vec::new();
        let mut needs_attention = Vec::new();

        collect_events(
            directory.path(),
            &manifest,
            &mut events,
            &mut needs_attention,
        )
        .unwrap();

        assert!(events.is_empty());
        assert_eq!(needs_attention.len(), 1);
        assert_eq!(needs_attention[0].folder_path, broken_folder);
        assert!(!needs_attention[0].reason.is_empty());
    }
}
