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
}

#[tauri::command]
pub(crate) fn list_import_events(
    settings: tauri::State<'_, SettingsService>,
    manifest: tauri::State<'_, ImportManifest>,
) -> Result<Vec<ImportEventSummary>, EventCommandError> {
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
    collect_events(&root, &manifest, &mut events)?;
    events.sort_by(|left, right| right.folder_path.cmp(&left.folder_path));
    Ok(events)
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
    if new_folder != old_folder {
        fs::rename(&old_folder, &new_folder)
            .map_err(|error| EventCommandError::new("eventRenameFailed", error.to_string()))?;
    }
    let old_name = marker.event_name.clone();
    marker.event_name = new_name.to_owned();
    marker.folder_name = new_folder_name;
    write_marker(&new_folder.join(EVENT_MARKER), &marker)?;
    manifest
        .rename_import_event_paths(
            &marker.session_id,
            &old_name,
            new_name,
            &old_folder,
            &new_folder,
        )
        .map_err(|error| EventCommandError::new("eventHistoryUpdateFailed", error.to_string()))?;
    Ok(summary(&new_folder, &marker))
}

fn collect_events(
    directory: &Path,
    manifest: &ImportManifest,
    events: &mut Vec<ImportEventSummary>,
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
            if let Ok(mut marker) = read_marker(&marker_path) {
                let actual_folder_name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                if actual_folder_name != marker.folder_name {
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
                    let _ = write_marker(&marker_path, &marker);
                    let _ = manifest.rename_import_event_paths(
                        &marker.session_id,
                        &old_name,
                        &marker.event_name,
                        &old_folder,
                        &path,
                    );
                }
                events.push(summary(&path, &marker));
            }
        }
        collect_events(&path, manifest, events)?;
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

fn summary(folder: &Path, marker: &EventMarker) -> ImportEventSummary {
    let file_count = fs::read_dir(folder)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .file_name()
                .is_some_and(|name| name != EVENT_MARKER)
        })
        .count();
    ImportEventSummary {
        event_id: marker.event_id.clone(),
        session_id: marker.session_id.clone(),
        name: marker.event_name.clone(),
        folder_path: folder.to_path_buf(),
        file_count,
    }
}
