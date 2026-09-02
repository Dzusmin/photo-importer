use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use importer_domain::settings::{AppSettings, CameraProfile, SourceIdentity};
use importer_manifest::{FileImportState, FileRecognition, SourceWorkflowRecord};
use importer_media::{
    EventGroup, MediaItem, MediaScan, SourceDiscovery, SourceVolume, SystemSourceDiscovery,
    apply_time_correction, ensure_source_marker, group_into_events,
};
use importer_plan::{
    BuildImportPlanRequest, EventPlanInput, ImportPlan, TemplateContext, build_import_plan,
};
use serde::{Deserialize, Serialize};

use crate::background;
use crate::settings::SettingsService;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceScanResponse {
    pub(crate) scan: MediaScan,
    pub(crate) events: Vec<EventGroup>,
    pub(crate) timestamp_basis: String,
    pub(crate) event_gap_minutes: u32,
    pub(crate) import_matches: Vec<ItemImportMatch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ItemImportState {
    New,
    PartiallyImported,
    Imported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ItemImportMatch {
    item_key: String,
    state: ItemImportState,
    imported_file_count: usize,
    total_file_count: usize,
    imported_paths: Vec<PathBuf>,
    imported_source_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingSourceWorkflow {
    #[serde(default)]
    pub(crate) source_id: String,
    pub(crate) source_root: PathBuf,
    #[serde(default)]
    pub(crate) source_identity: Option<SourceIdentity>,
    #[serde(default)]
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) state: SourceWorkflowState,
    #[serde(default)]
    pub(crate) scan: Option<SourceScanResponse>,
    #[serde(default)]
    pub(crate) plan: Option<ImportPlan>,
    #[serde(default)]
    pub(crate) settings_schema_version: u32,
    #[serde(default)]
    pub(crate) settings_revision: String,
    #[serde(default)]
    pub(crate) editor: WorkflowEditorState,
    #[serde(default)]
    pub(crate) error: Option<String>,
    #[serde(default)]
    pub(crate) updated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowEditorState {
    #[serde(default)]
    pub(crate) event_names: BTreeMap<usize, String>,
    #[serde(default)]
    pub(crate) excluded_item_keys: Vec<String>,
    #[serde(default)]
    pub(crate) item_profile_assignments: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SourceWorkflowState {
    Detected,
    AwaitingDecision,
    Scanning,
    AwaitingProfileConfirmation,
    PreparingPlan,
    #[default]
    PlanReady,
    Importing,
    Disconnected,
    FailedRecoverable,
    IgnoredUntilDisconnect,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TimeCorrectionResponse {
    items: Vec<MediaItem>,
    events: Vec<EventGroup>,
    changed_item_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportPlanPreviewRequest {
    events: Vec<EventPlanInput>,
    excluded_item_keys: Vec<String>,
    excluded_source_paths: Vec<PathBuf>,
    context: TemplateContext,
    item_contexts: BTreeMap<String, TemplateContext>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceCommandError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl SourceCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[tauri::command]
pub(crate) async fn list_media_sources() -> Result<Vec<SourceVolume>, SourceCommandError> {
    tauri::async_runtime::spawn_blocking(|| SystemSourceDiscovery.discover())
        .await
        .map_err(|error| {
            SourceCommandError::new(
                "sourceDiscoveryFailed",
                format!("Nie można odczytać listy nośników: {error}"),
            )
        })
}

#[tauri::command]
pub(crate) async fn ensure_media_source_marker(
    path: PathBuf,
) -> Result<String, SourceCommandError> {
    tauri::async_runtime::spawn_blocking(move || ensure_source_marker(&path))
        .await
        .map_err(|error| {
            SourceCommandError::new(
                "markerTaskFailed",
                format!("Nie można zapisać znacznika: {error}"),
            )
        })?
        .map(|id| id.to_string())
        .map_err(|error| {
            SourceCommandError::new(
                "markerWriteFailed",
                format!("Karta zostanie zapamiętana bez znacznika UUID: {error}"),
            )
        })
}

#[tauri::command]
pub(crate) fn announce_import_plan_ready(app: tauri::AppHandle, file_count: usize) {
    background::announce_plan_ready(
        &app,
        &format!("Plan obejmuje {file_count} plików i czeka na zatwierdzenie."),
    );
}

#[tauri::command]
pub(crate) fn save_pending_source_workflow(
    mut workflow: PendingSourceWorkflow,
    manifest: tauri::State<'_, importer_manifest::ImportManifest>,
) -> Result<(), SourceCommandError> {
    if let Some(existing) = manifest
        .list_source_workflows()
        .map_err(|error| SourceCommandError::new("workflowLoadFailed", error.to_string()))?
        .into_iter()
        .find(|record| record.source_root == workflow.source_root)
    {
        if workflow.source_identity.is_none() {
            workflow.source_identity = existing
                .source_identity_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|error| {
                    SourceCommandError::new("workflowDecodeFailed", error.to_string())
                })?;
        }
        if workflow.display_name.is_empty() {
            workflow.display_name = existing.display_name;
        }
        if workflow.settings_schema_version == 0 {
            workflow.settings_schema_version = existing.settings_schema_version;
        }
        if workflow.settings_revision.is_empty() {
            workflow.settings_revision = existing.settings_revision;
        }
        if workflow.editor.event_names.is_empty() {
            workflow.editor = serde_json::from_str(&existing.editor_json).unwrap_or_default();
        }
    }
    if workflow.source_id.is_empty() {
        workflow.source_id = workflow.source_root.to_string_lossy().into_owned();
    }
    if workflow.display_name.is_empty() {
        workflow.display_name = workflow
            .source_root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
    }
    if workflow.updated_at_unix_ms == 0 {
        workflow.updated_at_unix_ms = now_unix_ms();
    }
    let scan_json = serde_json::to_string(&workflow.scan)
        .map_err(|error| SourceCommandError::new("workflowSerializeFailed", error.to_string()))?;
    let plan_json = serde_json::to_string(&workflow.plan)
        .map_err(|error| SourceCommandError::new("workflowSerializeFailed", error.to_string()))?;
    let identity_json = workflow
        .source_identity
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| SourceCommandError::new("workflowSerializeFailed", error.to_string()))?;
    manifest
        .save_source_workflow(&SourceWorkflowRecord {
            source_root: workflow.source_root,
            state: workflow_state_name(workflow.state).to_owned(),
            source_identity_json: identity_json,
            display_name: workflow.display_name,
            scan_json,
            plan_json,
            settings_schema_version: workflow.settings_schema_version,
            settings_revision: workflow.settings_revision,
            editor_json: serde_json::to_string(&workflow.editor).map_err(|error| {
                SourceCommandError::new("workflowSerializeFailed", error.to_string())
            })?,
            error: workflow.error,
            updated_at_unix_ms: workflow.updated_at_unix_ms,
        })
        .map_err(|error| SourceCommandError::new("workflowSaveFailed", error.to_string()))
}

#[tauri::command]
pub(crate) fn list_pending_source_workflows(
    manifest: tauri::State<'_, importer_manifest::ImportManifest>,
) -> Result<Vec<PendingSourceWorkflow>, SourceCommandError> {
    manifest
        .list_source_workflows()
        .map_err(|error| SourceCommandError::new("workflowLoadFailed", error.to_string()))?
        .into_iter()
        .map(|record| {
            Ok(PendingSourceWorkflow {
                source_id: record
                    .source_identity_json
                    .clone()
                    .unwrap_or_else(|| record.source_root.to_string_lossy().into_owned()),
                source_root: record.source_root,
                source_identity: record
                    .source_identity_json
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()
                    .map_err(|error| {
                        SourceCommandError::new("workflowDecodeFailed", error.to_string())
                    })?,
                display_name: record.display_name,
                state: parse_workflow_state(&record.state)?,
                scan: serde_json::from_str(&record.scan_json).map_err(|error| {
                    SourceCommandError::new("workflowDecodeFailed", error.to_string())
                })?,
                plan: serde_json::from_str(&record.plan_json).map_err(|error| {
                    SourceCommandError::new("workflowDecodeFailed", error.to_string())
                })?,
                settings_schema_version: record.settings_schema_version,
                settings_revision: record.settings_revision,
                editor: serde_json::from_str(&record.editor_json).unwrap_or_default(),
                error: record.error,
                updated_at_unix_ms: record.updated_at_unix_ms,
            })
        })
        .collect()
}

#[tauri::command]
pub(crate) fn list_source_workflows(
    manifest: tauri::State<'_, importer_manifest::ImportManifest>,
) -> Result<Vec<PendingSourceWorkflow>, SourceCommandError> {
    list_pending_source_workflows(manifest)
}

pub(crate) fn persist_workflow(
    manifest: &importer_manifest::ImportManifest,
    workflow: &PendingSourceWorkflow,
) -> Result<(), SourceCommandError> {
    let scan_json = serde_json::to_string(&workflow.scan)
        .map_err(|error| SourceCommandError::new("workflowSerializeFailed", error.to_string()))?;
    let plan_json = serde_json::to_string(&workflow.plan)
        .map_err(|error| SourceCommandError::new("workflowSerializeFailed", error.to_string()))?;
    let source_identity_json = workflow
        .source_identity
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| SourceCommandError::new("workflowSerializeFailed", error.to_string()))?;
    manifest
        .save_source_workflow(&SourceWorkflowRecord {
            source_root: workflow.source_root.clone(),
            state: workflow_state_name(workflow.state).to_owned(),
            source_identity_json,
            display_name: workflow.display_name.clone(),
            scan_json,
            plan_json,
            settings_schema_version: workflow.settings_schema_version,
            error: workflow.error.clone(),
            settings_revision: workflow.settings_revision.clone(),
            editor_json: serde_json::to_string(&workflow.editor).map_err(|error| {
                SourceCommandError::new("workflowSerializeFailed", error.to_string())
            })?,
            updated_at_unix_ms: workflow.updated_at_unix_ms,
        })
        .map_err(|error| SourceCommandError::new("workflowSaveFailed", error.to_string()))
}

pub(crate) fn prepare_automatic_workflow(
    settings: &AppSettings,
    volume: &SourceVolume,
    response: SourceScanResponse,
) -> Result<PendingSourceWorkflow, SourceCommandError> {
    let identity = SourceIdentity {
        marker_uuid: volume.marker_uuid,
        platform_volume_id: volume.platform_volume_id.clone(),
        fallback_fingerprint: volume.fingerprint.clone(),
    };
    let connection = importer_background::resolve_connection(volume, settings);
    let binding = connection.as_ref().and_then(|connection| {
        settings
            .local
            .source_bindings
            .iter()
            .find(|binding| binding.id == connection.binding_id)
    });
    let approved: BTreeSet<_> = binding
        .into_iter()
        .flat_map(|binding| binding.camera_profile_ids.iter().copied())
        .collect();
    let mut contexts = BTreeMap::new();
    let mut profile_assignments = BTreeMap::new();
    let mut requires_confirmation = false;
    for item in &response.scan.items {
        let profile = item.camera_identity.as_ref().and_then(|identity| {
            let matches: Vec<_> = settings
                .portable
                .camera_profiles
                .iter()
                .filter(|profile| approved.contains(&profile.id))
                .filter_map(|profile| {
                    profile_match_score(profile, identity).map(|score| (profile, score))
                })
                .collect();
            let best = matches.iter().map(|(_, score)| *score).max()?;
            let best_matches: Vec<_> = matches
                .into_iter()
                .filter(|(_, score)| *score == best)
                .collect();
            if best_matches.len() == 1 {
                Some(best_matches[0].0)
            } else {
                None
            }
        });
        if item.camera_identity.is_some() && profile.is_none() && !item.camera_metadata_conflict {
            requires_confirmation = true;
        }
        contexts.insert(
            item.key.clone(),
            TemplateContext {
                camera_make: item
                    .camera_identity
                    .as_ref()
                    .and_then(|identity| identity.make.clone()),
                camera_model: item
                    .camera_identity
                    .as_ref()
                    .and_then(|identity| identity.model.clone()),
                camera_alias: Some(profile.map_or_else(
                    || "Nieznany aparat".to_owned(),
                    |profile| profile.name.clone(),
                )),
                source_alias: Some(volume.name.clone()),
            },
        );
        profile_assignments.insert(
            item.key.clone(),
            profile.map_or_else(|| "unknown".to_owned(), |profile| profile.id.to_string()),
        );
    }
    let mut workflow = PendingSourceWorkflow {
        source_id: binding.map_or_else(
            || volume.fingerprint.clone(),
            |binding| binding.id.to_string(),
        ),
        source_root: volume.mount_path.clone(),
        source_identity: Some(identity),
        display_name: binding.map_or_else(
            || volume.name.clone(),
            |binding| binding.display_name.clone(),
        ),
        state: SourceWorkflowState::AwaitingProfileConfirmation,
        scan: Some(response.clone()),
        plan: None,
        settings_schema_version: settings.schema_version,
        error: None,
        settings_revision: serde_json::to_string(&settings.portable.naming).unwrap_or_default(),
        editor: WorkflowEditorState {
            event_names: response
                .events
                .iter()
                .map(|event| (event.index, format!("wydarzenie-{}", event.index + 1)))
                .collect(),
            excluded_item_keys: response
                .import_matches
                .iter()
                .filter(|item| item.state == ItemImportState::Imported)
                .map(|item| item.item_key.clone())
                .collect(),
            item_profile_assignments: profile_assignments,
        },
        updated_at_unix_ms: now_unix_ms(),
    };
    if requires_confirmation {
        return Ok(workflow);
    }
    let library_root = settings.local.library_path.clone().ok_or_else(|| {
        SourceCommandError::new(
            "libraryPathMissing",
            "Najpierw wybierz katalog biblioteki w ustawieniach.",
        )
    })?;
    let excluded_source_paths = response
        .import_matches
        .iter()
        .flat_map(|item| item.imported_source_paths.iter().cloned())
        .collect();
    let events = response
        .events
        .iter()
        .cloned()
        .map(|event| EventPlanInput {
            name: format!("wydarzenie-{}", event.index + 1),
            event,
        })
        .collect();
    let plan = build_import_plan(BuildImportPlanRequest {
        library_root,
        folder_template: settings.portable.naming.folder_template.clone(),
        collision_policy: settings.portable.naming.collision_policy,
        events,
        excluded_item_keys: BTreeSet::new(),
        excluded_source_paths,
        context: TemplateContext {
            source_alias: Some(volume.name.clone()),
            ..TemplateContext::default()
        },
        item_contexts: contexts,
    })
    .map_err(|error| SourceCommandError::new("importPlanFailed", error.to_string()))?;
    workflow.plan = Some(plan);
    workflow.state = SourceWorkflowState::PlanReady;
    Ok(workflow)
}

fn profile_match_score(
    profile: &CameraProfile,
    identity: &importer_media::CameraIdentity,
) -> Option<u8> {
    profile
        .exif_matchers
        .iter()
        .filter_map(|matcher| {
            if let (Some(expected), Some(actual)) = (
                matcher.serial_number.as_deref(),
                identity.serial_number.as_deref(),
            ) && expected.trim().eq_ignore_ascii_case(actual.trim())
            {
                return Some(2);
            }
            let make = matcher
                .make
                .as_deref()
                .zip(identity.make.as_deref())
                .is_some_and(|(expected, actual)| {
                    expected.trim().eq_ignore_ascii_case(actual.trim())
                });
            let model = matcher
                .model
                .as_deref()
                .zip(identity.model.as_deref())
                .is_some_and(|(expected, actual)| {
                    expected.trim().eq_ignore_ascii_case(actual.trim())
                });
            (make && model).then_some(1)
        })
        .max()
}

fn workflow_state_name(state: SourceWorkflowState) -> &'static str {
    match state {
        SourceWorkflowState::Detected => "detected",
        SourceWorkflowState::AwaitingDecision => "awaitingDecision",
        SourceWorkflowState::Scanning => "scanning",
        SourceWorkflowState::AwaitingProfileConfirmation => "awaitingProfileConfirmation",
        SourceWorkflowState::PreparingPlan => "preparingPlan",
        SourceWorkflowState::PlanReady => "planReady",
        SourceWorkflowState::Importing => "importing",
        SourceWorkflowState::Disconnected => "disconnected",
        SourceWorkflowState::FailedRecoverable => "failedRecoverable",
        SourceWorkflowState::IgnoredUntilDisconnect => "ignoredUntilDisconnect",
    }
}

fn parse_workflow_state(value: &str) -> Result<SourceWorkflowState, SourceCommandError> {
    match value {
        "detected" => Ok(SourceWorkflowState::Detected),
        "awaitingDecision" => Ok(SourceWorkflowState::AwaitingDecision),
        "scanning" => Ok(SourceWorkflowState::Scanning),
        "awaitingProfileConfirmation" => Ok(SourceWorkflowState::AwaitingProfileConfirmation),
        "preparingPlan" => Ok(SourceWorkflowState::PreparingPlan),
        "planReady" => Ok(SourceWorkflowState::PlanReady),
        "importing" => Ok(SourceWorkflowState::Importing),
        "disconnected" => Ok(SourceWorkflowState::Disconnected),
        "failedRecoverable" => Ok(SourceWorkflowState::FailedRecoverable),
        "ignoredUntilDisconnect" => Ok(SourceWorkflowState::IgnoredUntilDisconnect),
        _ => Err(SourceCommandError::new(
            "workflowStateInvalid",
            format!("Nieznany stan workflow: {value}"),
        )),
    }
}

#[tauri::command]
pub(crate) fn delete_pending_source_workflow(
    source_root: PathBuf,
    manifest: tauri::State<'_, importer_manifest::ImportManifest>,
) -> Result<(), SourceCommandError> {
    manifest
        .delete_pending_workflow(&source_root)
        .map_err(|error| SourceCommandError::new("workflowDeleteFailed", error.to_string()))
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

#[tauri::command]
pub(crate) async fn correct_capture_times(
    mut items: Vec<MediaItem>,
    item_keys: Vec<String>,
    offset_seconds: i64,
    settings: tauri::State<'_, SettingsService>,
) -> Result<TimeCorrectionResponse, SourceCommandError> {
    let event_gap_minutes = settings.event_gap_minutes().map_err(|error| {
        SourceCommandError::new("settingsUnavailable", error.message().to_owned())
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let changed_item_count = apply_time_correction(&mut items, &item_keys, offset_seconds);
        let events = group_into_events(items.clone(), event_gap_minutes);
        Ok(TimeCorrectionResponse {
            items,
            events,
            changed_item_count,
        })
    })
    .await
    .map_err(|error| {
        SourceCommandError::new(
            "timeCorrectionFailed",
            format!("Korekta czasu została przerwana: {error}"),
        )
    })?
}

#[tauri::command]
pub(crate) async fn build_import_plan_preview(
    request: ImportPlanPreviewRequest,
    settings: tauri::State<'_, SettingsService>,
) -> Result<ImportPlan, SourceCommandError> {
    let settings = settings.current_settings().map_err(|error| {
        SourceCommandError::new("settingsUnavailable", error.message().to_owned())
    })?;
    let library_root = settings.local.library_path.ok_or_else(|| {
        SourceCommandError::new(
            "libraryPathMissing",
            "Najpierw wybierz katalog biblioteki w ustawieniach.",
        )
    })?;
    let naming = settings.portable.naming;

    tauri::async_runtime::spawn_blocking(move || {
        build_import_plan(BuildImportPlanRequest {
            library_root,
            folder_template: naming.folder_template,
            collision_policy: naming.collision_policy,
            events: request.events,
            excluded_item_keys: request
                .excluded_item_keys
                .into_iter()
                .collect::<BTreeSet<_>>(),
            excluded_source_paths: request
                .excluded_source_paths
                .into_iter()
                .collect::<BTreeSet<_>>(),
            context: request.context,
            item_contexts: request.item_contexts,
        })
        .map_err(|error| {
            SourceCommandError::new(
                "importPlanFailed",
                format!("Nie można przygotować planu importu: {error}"),
            )
        })
    })
    .await
    .map_err(|error| {
        SourceCommandError::new(
            "importPlanTaskFailed",
            format!("Planowanie importu zostało przerwane: {error}"),
        )
    })?
}

pub(crate) fn aggregate_import_matches(
    items: &[MediaItem],
    file_matches: &[FileRecognition],
) -> Vec<ItemImportMatch> {
    let mut matches_by_item: HashMap<&str, Vec<&FileRecognition>> = HashMap::new();
    for recognition in file_matches {
        matches_by_item
            .entry(&recognition.item_key)
            .or_default()
            .push(recognition);
    }

    items
        .iter()
        .map(|item| {
            let matches = matches_by_item.get(item.key.as_str());
            let imported_file_count = matches.map_or(0, |matches| {
                matches
                    .iter()
                    .filter(|recognition| recognition.state == FileImportState::Imported)
                    .count()
            });
            let total_file_count = item.files.len();
            let state = if imported_file_count == 0 {
                ItemImportState::New
            } else if imported_file_count == total_file_count {
                ItemImportState::Imported
            } else {
                ItemImportState::PartiallyImported
            };
            let imported_paths = matches.map_or_else(Vec::new, |matches| {
                matches
                    .iter()
                    .filter_map(|recognition| recognition.imported_path.clone())
                    .collect()
            });
            let imported_source_paths = matches.map_or_else(Vec::new, |matches| {
                matches
                    .iter()
                    .filter(|recognition| recognition.state == FileImportState::Imported)
                    .map(|recognition| recognition.path.clone())
                    .collect()
            });
            ItemImportMatch {
                item_key: item.key.clone(),
                state,
                imported_file_count,
                total_file_count,
                imported_paths,
                imported_source_paths,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use importer_media::CaptureTimeSource;

    fn item(key: &str, file_count: usize) -> MediaItem {
        MediaItem {
            key: key.to_owned(),
            original_captured_at_unix_ms: 1,
            captured_at_unix_ms: 1,
            time_source: CaptureTimeSource::Exif,
            time_correction_seconds: 0,
            total_size_bytes: 0,
            files: (0..file_count)
                .map(|index| importer_media::MediaFile {
                    path: format!("{key}-{index}").into(),
                    relative_path: format!("{key}-{index}").into(),
                    kind: importer_media::MediaFileKind::Jpeg,
                    size_bytes: 1,
                    modified_at_unix_ms: 1,
                    embedded_captured_at_unix_ms: Some(1),
                    embedded_time_source: Some(CaptureTimeSource::Exif),
                    camera_identity: None,
                })
                .collect(),
            has_raw_jpeg_pair: false,
            has_sidecar: false,
            camera_identity: None,
            camera_metadata_conflict: false,
        }
    }

    #[test]
    fn aggregates_partial_imports_per_media_item() {
        let items = vec![item("pair", 2)];
        let files = vec![FileRecognition {
            item_key: "pair".to_owned(),
            path: "pair-0".into(),
            state: FileImportState::Imported,
            content_sha256: Some("hash".to_owned()),
            imported_path: Some("library/pair-0".into()),
        }];

        let result = aggregate_import_matches(&items, &files);

        assert_eq!(result[0].state, ItemImportState::PartiallyImported);
        assert_eq!(result[0].imported_file_count, 1);
        assert_eq!(result[0].total_file_count, 2);
    }
}
