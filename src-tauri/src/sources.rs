use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use importer_domain::settings::{AppSettings, CameraProfile, SourceIdentity};
use importer_manifest::{
    FileImportState, FileRecognition, PhotoUserMetadata, SourceWorkflowRecord,
};
use importer_media::{
    EventGroup, MediaItem, MediaScan, SourceDiscovery, SourceVolume, SystemSourceDiscovery,
    apply_time_correction, ensure_source_marker, group_into_events,
};
use importer_plan::{
    BuildImportPlanRequest, EventPlanInput, ImportPlan, TemplateContext, build_import_plan,
};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::background;
use crate::settings::SettingsService;

/// Stable fingerprint of every setting that can affect an import plan or the
/// import session created from it. Keep this tuple in sync with
/// `importPlanSettingsRevision` in `src/shared/settings.ts`.
pub(crate) fn import_plan_settings_revision(settings: &AppSettings) -> String {
    let camera_profiles = settings
        .portable
        .camera_profiles
        .iter()
        .map(|profile| {
            serde_json::json!([
                profile.id,
                profile.name,
                profile
                    .exif_matchers
                    .iter()
                    .map(|matcher| serde_json::json!([
                        matcher.make,
                        matcher.model,
                        matcher.serial_number
                    ]))
                    .collect::<Vec<_>>(),
                profile.default_time_offset_seconds
            ])
        })
        .collect::<Vec<_>>();
    let source_bindings = settings
        .local
        .source_bindings
        .iter()
        .map(|binding| {
            serde_json::json!([
                [
                    binding.source_identity.marker_uuid,
                    binding.source_identity.platform_volume_id,
                    binding.source_identity.fallback_fingerprint
                ],
                binding.display_name,
                binding.camera_profile_ids
            ])
        })
        .collect::<Vec<_>>();

    serde_json::to_string(&serde_json::json!([
        "import-plan-v1",
        settings.local.library_path,
        settings.portable.import.default_operation,
        settings.portable.import.event_gap_minutes,
        [
            settings.portable.naming.folder_template,
            settings.portable.naming.file_name_template,
            settings.portable.naming.collision_policy
        ],
        camera_profiles,
        source_bindings
    ]))
    .unwrap_or_default()
}

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
    #[serde(default)]
    pub(crate) expanded_event_indexes: Vec<usize>,
}

#[derive(Debug, Clone)]
pub(crate) struct WorkflowEditorSnapshot {
    pub(crate) source_id: String,
    pub(crate) scan: Option<SourceScanResponse>,
    pub(crate) editor: WorkflowEditorState,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhotoUserMetadataUpdate {
    item_key: String,
    rating: u8,
    rejected: bool,
    rotation_degrees: u16,
}

#[tauri::command]
pub(crate) fn list_photo_user_metadata(
    source_root: PathBuf,
    manifest: tauri::State<'_, importer_manifest::ImportManifest>,
) -> Result<Vec<PhotoUserMetadata>, SourceCommandError> {
    manifest
        .list_photo_user_metadata(&source_root)
        .map_err(|error| SourceCommandError::new("metadataLoadFailed", error.to_string()))
}

#[tauri::command]
pub(crate) fn save_photo_user_metadata(
    source_root: PathBuf,
    updates: Vec<PhotoUserMetadataUpdate>,
    manifest: tauri::State<'_, importer_manifest::ImportManifest>,
) -> Result<(), SourceCommandError> {
    let updated_at_unix_ms = now_unix_ms();
    let records = updates
        .into_iter()
        .map(|update| PhotoUserMetadata {
            source_root: source_root.clone(),
            item_key: update.item_key,
            rating: update.rating,
            rejected: update.rejected,
            rotation_degrees: update.rotation_degrees,
            updated_at_unix_ms,
        })
        .collect::<Vec<_>>();
    manifest
        .save_photo_user_metadata(&records)
        .map_err(|error| SourceCommandError::new("metadataSaveFailed", error.to_string()))
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
    technical_details: String,
}

impl SourceCommandError {
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
    background::announce_plan_ready(&app, file_count);
}

#[tauri::command]
pub(crate) fn save_pending_source_workflow(
    mut workflow: PendingSourceWorkflow,
    manifest: tauri::State<'_, importer_manifest::ImportManifest>,
) -> Result<(), SourceCommandError> {
    workflow.source_id =
        canonical_workflow_source_id(&workflow.source_id, workflow.source_identity.as_ref());
    if let Some(existing) = manifest
        .list_source_workflows()
        .map_err(|error| SourceCommandError::new("workflowLoadFailed", error.to_string()))?
        .into_iter()
        .find(|record| record.source_id == workflow.source_id)
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
            source_id: workflow.source_id,
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
    let mut records = manifest
        .list_source_workflows()
        .map_err(|error| SourceCommandError::new("workflowLoadFailed", error.to_string()))?;
    let connected_sources = SystemSourceDiscovery
        .discover()
        .into_iter()
        .map(|volume| {
            let durable_identity = volume_has_durable_identity(&volume);
            (
                source_workflow_id(&volume),
                (volume.mount_path, durable_identity),
            )
        })
        .collect::<HashMap<_, _>>();

    let mut reconciled = Vec::with_capacity(records.len());
    for mut record in records.drain(..) {
        // A manually selected directory or network share has an explicit path-based
        // identity. It is not a removable-volume workflow and must not be reconciled
        // against the currently detected cards.
        if record.source_id.starts_with("directory:") {
            reconciled.push(record);
            continue;
        }
        if let Some((current_root, durable_identity)) = connected_sources.get(&record.source_id) {
            if record.state == "disconnected" && !durable_identity {
                manifest
                    .delete_pending_workflow(&record.source_id)
                    .map_err(|error| {
                        SourceCommandError::new("workflowDeleteFailed", error.to_string())
                    })?;
                continue;
            }
            if record.source_root != *current_root || record.state == "disconnected" {
                let state = if record.state == "disconnected" {
                    "planReady"
                } else {
                    record.state.as_str()
                };
                manifest
                    .update_source_workflow_connection(
                        &record.source_id,
                        current_root,
                        state,
                        record.error.as_deref(),
                        now_unix_ms(),
                    )
                    .map_err(|error| {
                        SourceCommandError::new("workflowSaveFailed", error.to_string())
                    })?;
                record.source_root = current_root.clone();
                record.state = state.to_owned();
            }
            reconciled.push(record);
            continue;
        }

        match missing_workflow_action(&record.state, record_has_durable_identity(&record)) {
            MissingWorkflowAction::Keep => reconciled.push(record),
            MissingWorkflowAction::MarkDisconnected => {
                manifest
                    .update_source_workflow_state(
                        &record.source_id,
                        "disconnected",
                        record.error.as_deref(),
                        now_unix_ms(),
                    )
                    .map_err(|error| {
                        SourceCommandError::new("workflowSaveFailed", error.to_string())
                    })?;
                record.state = "disconnected".to_owned();
                reconciled.push(record);
            }
            MissingWorkflowAction::Delete => {
                manifest
                    .delete_pending_workflow(&record.source_id)
                    .map_err(|error| {
                        SourceCommandError::new("workflowDeleteFailed", error.to_string())
                    })?;
            }
        }
    }

    reconciled
        .into_iter()
        .map(|record| {
            Ok(PendingSourceWorkflow {
                source_id: record.source_id,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MissingWorkflowAction {
    Keep,
    MarkDisconnected,
    Delete,
}

fn missing_workflow_action(state: &str, durable_identity: bool) -> MissingWorkflowAction {
    match state {
        "planReady" if durable_identity => MissingWorkflowAction::MarkDisconnected,
        "disconnected" | "failedRecoverable" if durable_identity => MissingWorkflowAction::Keep,
        _ => MissingWorkflowAction::Delete,
    }
}

fn record_has_durable_identity(record: &SourceWorkflowRecord) -> bool {
    record
        .source_identity_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<SourceIdentity>(json).ok())
        .is_some_and(|identity| {
            identity.marker_uuid.is_some() || identity.platform_volume_id.is_some()
        })
}

#[cfg(test)]
mod workflow_reconciliation_tests {
    use std::path::PathBuf;

    use importer_media::SourceVolume;

    use super::{
        MissingWorkflowAction, canonical_workflow_source_id, missing_workflow_action,
        source_workflow_id,
    };

    #[test]
    fn removes_an_unfinished_decision_for_a_missing_source() {
        assert_eq!(
            missing_workflow_action("awaitingDecision", false),
            MissingWorkflowAction::Delete
        );
    }

    #[test]
    fn preserves_a_ready_plan_as_disconnected() {
        assert_eq!(
            missing_workflow_action("planReady", true),
            MissingWorkflowAction::MarkDisconnected
        );
        assert_eq!(
            missing_workflow_action("disconnected", true),
            MissingWorkflowAction::Keep
        );
    }

    #[test]
    fn discards_an_unverified_plan_instead_of_carrying_it_to_another_observation() {
        assert_eq!(
            missing_workflow_action("planReady", false),
            MissingWorkflowAction::Delete
        );
        assert_eq!(
            missing_workflow_action("disconnected", false),
            MissingWorkflowAction::Delete
        );
    }

    #[test]
    fn colliding_unverified_volumes_have_separate_observation_workflows() {
        let volume = |mount_path: &str| SourceVolume {
            fingerprint: "same-card-layout".to_owned(),
            marker_uuid: None,
            platform_volume_id: None,
            name: "CAMERA".to_owned(),
            mount_path: PathBuf::from(mount_path),
            file_system: "exFAT".to_owned(),
            total_bytes: 64_000,
            available_bytes: 32_000,
            removable: true,
            read_only: false,
            contains_dcim: true,
            likely_camera_source: true,
        };

        assert_ne!(
            source_workflow_id(&volume("E:/")),
            source_workflow_id(&volume("F:/"))
        );
    }

    #[test]
    fn preserves_the_explicit_manual_directory_source_model() {
        assert_eq!(
            canonical_workflow_source_id("directory:C:\\Photos", None),
            "directory:C:\\Photos"
        );
        assert_eq!(
            canonical_workflow_source_id("E:\\", None),
            "unverified:E:\\"
        );
    }
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
            source_id: workflow.source_id.clone(),
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

pub(crate) fn load_workflow_editor_snapshot(
    manifest: &importer_manifest::ImportManifest,
    source_id: &str,
) -> Result<Option<WorkflowEditorSnapshot>, SourceCommandError> {
    let Some(record) = manifest
        .list_source_workflows()
        .map_err(|error| SourceCommandError::new("workflowLoadFailed", error.to_string()))?
        .into_iter()
        .find(|record| record.source_id == source_id)
    else {
        return Ok(None);
    };
    Ok(Some(WorkflowEditorSnapshot {
        source_id: record.source_id,
        scan: serde_json::from_str(&record.scan_json)
            .map_err(|error| SourceCommandError::new("workflowDecodeFailed", error.to_string()))?,
        editor: serde_json::from_str(&record.editor_json)
            .map_err(|error| SourceCommandError::new("workflowDecodeFailed", error.to_string()))?,
    }))
}

pub(crate) fn prepare_automatic_workflow(
    settings: &AppSettings,
    volume: &SourceVolume,
    response: SourceScanResponse,
    previous: Option<&WorkflowEditorSnapshot>,
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
        let preserved_profile = previous
            .and_then(|previous| previous.editor.item_profile_assignments.get(&item.key))
            .and_then(|profile_id| {
                settings
                    .portable
                    .camera_profiles
                    .iter()
                    .find(|profile| profile.id.to_string() == *profile_id)
            });
        let automatically_matched_profile = item.camera_identity.as_ref().and_then(|identity| {
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
        let profile = preserved_profile.or(automatically_matched_profile);
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
    let default_editor = WorkflowEditorState {
        event_names: response
            .events
            .iter()
            .map(|event| (event.index, default_event_name(event.index)))
            .collect(),
        excluded_item_keys: response
            .import_matches
            .iter()
            .filter(|item| item.state == ItemImportState::Imported)
            .map(|item| item.item_key.clone())
            .collect(),
        item_profile_assignments: profile_assignments,
        expanded_event_indexes: Vec::new(),
    };
    let editor = previous.map_or(default_editor.clone(), |previous| {
        merge_workflow_editor(settings, previous, &response, default_editor)
    });
    let mut workflow = PendingSourceWorkflow {
        source_id: source_workflow_id(volume),
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
        settings_revision: import_plan_settings_revision(settings),
        editor: editor.clone(),
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
            name: editor
                .event_names
                .get(&event.index)
                .cloned()
                .unwrap_or_else(|| default_event_name(event.index)),
            event,
        })
        .collect();
    let plan = build_import_plan(BuildImportPlanRequest {
        library_root,
        folder_template: settings.portable.naming.folder_template.clone(),
        file_name_template: settings.portable.naming.file_name_template.clone(),
        collision_policy: settings.portable.naming.collision_policy,
        events,
        excluded_item_keys: editor.excluded_item_keys.iter().cloned().collect(),
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

fn merge_workflow_editor(
    settings: &AppSettings,
    previous: &WorkflowEditorSnapshot,
    response: &SourceScanResponse,
    mut fresh: WorkflowEditorState,
) -> WorkflowEditorState {
    let current_item_keys = response
        .scan
        .items
        .iter()
        .map(|item| item.key.as_str())
        .collect::<BTreeSet<_>>();
    let valid_profile_ids = settings
        .portable
        .camera_profiles
        .iter()
        .map(|profile| profile.id.to_string())
        .collect::<BTreeSet<_>>();

    fresh.excluded_item_keys.extend(
        previous
            .editor
            .excluded_item_keys
            .iter()
            .filter(|key| current_item_keys.contains(key.as_str()))
            .cloned(),
    );
    fresh.excluded_item_keys.sort();
    fresh.excluded_item_keys.dedup();
    for (item_key, profile_id) in &previous.editor.item_profile_assignments {
        if current_item_keys.contains(item_key.as_str())
            && valid_profile_ids.contains(profile_id.as_str())
        {
            fresh
                .item_profile_assignments
                .insert(item_key.clone(), profile_id.clone());
        }
    }

    if let Some(previous_scan) = previous.scan.as_ref() {
        let mut claimed_new_events = BTreeSet::new();
        for (old_index, name) in &previous.editor.event_names {
            let Some(old_event) = previous_scan
                .events
                .iter()
                .find(|event| event.index == *old_index)
            else {
                continue;
            };
            let old_keys = old_event
                .items
                .iter()
                .map(|item| item.key.as_str())
                .collect::<BTreeSet<_>>();
            let mut candidates = response
                .events
                .iter()
                .filter(|event| !claimed_new_events.contains(&event.index))
                .map(|event| {
                    let overlap = event
                        .items
                        .iter()
                        .filter(|item| old_keys.contains(item.key.as_str()))
                        .count();
                    (event.index, overlap)
                })
                .filter(|(_, overlap)| *overlap > 0)
                .collect::<Vec<_>>();
            candidates.sort_by_key(|(_, overlap)| std::cmp::Reverse(*overlap));
            if let Some(&(new_index, best_overlap)) = candidates.first()
                && candidates
                    .get(1)
                    .is_none_or(|(_, overlap)| *overlap < best_overlap)
            {
                fresh.event_names.insert(new_index, name.clone());
                claimed_new_events.insert(new_index);
            }
        }
    }
    let current_event_indexes = response
        .events
        .iter()
        .map(|event| event.index)
        .collect::<BTreeSet<_>>();
    fresh.expanded_event_indexes = previous
        .editor
        .expanded_event_indexes
        .iter()
        .copied()
        .filter(|index| current_event_indexes.contains(index))
        .collect();
    fresh
}

fn default_event_name(index: usize) -> String {
    format!("wydarzenie-{index:02}")
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
    source_id: String,
    app: tauri::AppHandle,
    manifest: tauri::State<'_, importer_manifest::ImportManifest>,
) -> Result<(), SourceCommandError> {
    manifest
        .delete_pending_workflow(&source_id)
        .map_err(|error| SourceCommandError::new("workflowDeleteFailed", error.to_string()))?;
    let _ = app.emit("source-workflows-invalidated", source_id);
    crate::background::refresh_attention_best_effort(&app);
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_disconnected_source_workflows(
    app: tauri::AppHandle,
    manifest: tauri::State<'_, importer_manifest::ImportManifest>,
) -> Result<usize, SourceCommandError> {
    let records = manifest
        .list_source_workflows()
        .map_err(|error| SourceCommandError::new("workflowLoadFailed", error.to_string()))?;
    let disconnected = records
        .into_iter()
        .filter(|record| record.state == "disconnected")
        .collect::<Vec<_>>();
    for record in &disconnected {
        manifest
            .delete_pending_workflow(&record.source_id)
            .map_err(|error| SourceCommandError::new("workflowDeleteFailed", error.to_string()))?;
    }
    let _ = app.emit("source-workflows-invalidated", "disconnected");
    crate::background::refresh_attention_best_effort(&app);
    Ok(disconnected.len())
}

pub(crate) fn source_workflow_id(volume: &SourceVolume) -> String {
    if let Some(id) = volume.marker_uuid {
        return format!("marker:{id}");
    }
    if let Some(id) = volume.platform_volume_id.as_deref() {
        return format!("platform:{id}");
    }
    format!(
        "unverified:{}:{}",
        volume.fingerprint,
        volume.mount_path.display()
    )
}

pub(crate) fn volume_has_durable_identity(volume: &SourceVolume) -> bool {
    volume.marker_uuid.is_some() || volume.platform_volume_id.is_some()
}

fn canonical_workflow_source_id(source_id: &str, identity: Option<&SourceIdentity>) -> String {
    if let Some(id) = identity.and_then(|identity| identity.marker_uuid) {
        return format!("marker:{id}");
    }
    if let Some(id) = identity.and_then(|identity| identity.platform_volume_id.as_deref()) {
        return format!("platform:{id}");
    }
    if source_id.starts_with("unverified:") || source_id.starts_with("directory:") {
        source_id.to_owned()
    } else {
        identity.map_or_else(
            || format!("unverified:{source_id}"),
            |identity| format!("unverified:{}", identity.fallback_fingerprint),
        )
    }
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
            file_name_template: naming.file_name_template,
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
    use importer_domain::settings::CameraProfile;
    use importer_media::{CaptureTimeSource, EventGroup, MediaScan, MediaScanTimings};
    use uuid::Uuid;

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

    fn response(events: Vec<EventGroup>) -> SourceScanResponse {
        let items = events
            .iter()
            .flat_map(|event| event.items.iter().cloned())
            .collect::<Vec<_>>();
        SourceScanResponse {
            scan: MediaScan {
                root: "E:/".into(),
                supported_file_count: items.iter().map(|item| item.files.len()).sum(),
                skipped_file_count: 0,
                total_size_bytes: items.iter().map(|item| item.total_size_bytes).sum(),
                warnings: Vec::new(),
                timings: MediaScanTimings::default(),
                items,
            },
            events,
            timestamp_basis: "embeddedWithFileFallback".to_owned(),
            event_gap_minutes: 120,
            import_matches: Vec::new(),
        }
    }

    fn event(index: usize, items: Vec<MediaItem>) -> EventGroup {
        EventGroup {
            index,
            starts_at_unix_ms: 1,
            ends_at_unix_ms: 1,
            total_size_bytes: items.iter().map(|item| item.total_size_bytes).sum(),
            items,
        }
    }

    #[test]
    fn plan_settings_revision_matches_the_frontend_contract() {
        assert_eq!(
            import_plan_settings_revision(&AppSettings::default()),
            r#"["import-plan-v1",null,"copy",120,["{year}/{date}-{event_name}","{original_name}","ask"],[],[]]"#
        );
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

    #[test]
    fn older_editor_state_defaults_to_all_events_collapsed() {
        let editor: WorkflowEditorState = serde_json::from_str(
            r#"{"eventNames":{"1":"Wakacje"},"excludedItemKeys":[],"itemProfileAssignments":{}}"#,
        )
        .expect("older editor state should remain readable");

        assert!(editor.expanded_event_indexes.is_empty());
    }

    #[test]
    fn default_event_names_use_the_one_based_event_index() {
        assert_eq!(default_event_name(1), "wydarzenie-01");
        assert_eq!(default_event_name(12), "wydarzenie-12");
    }

    #[test]
    fn refreshed_workflow_preserves_only_editor_entries_matching_fresh_items() {
        let retained_profile_id = Uuid::new_v4();
        let removed_profile_id = Uuid::new_v4();
        let mut settings = AppSettings::default();
        settings.portable.camera_profiles.push(CameraProfile {
            id: retained_profile_id,
            name: "Retained camera".to_owned(),
            exif_matchers: Vec::new(),
            default_time_offset_seconds: 0,
            source_behavior: None,
        });
        let old_scan = response(vec![
            event(2, vec![item("retained", 1), item("removed", 1)]),
            event(3, vec![item("gone-event", 1)]),
        ]);
        let previous = WorkflowEditorSnapshot {
            source_id: "marker:card".to_owned(),
            scan: Some(old_scan),
            editor: WorkflowEditorState {
                event_names: BTreeMap::from([
                    (2, "Retained event name".to_owned()),
                    (3, "Removed event name".to_owned()),
                ]),
                excluded_item_keys: vec!["retained".to_owned(), "removed".to_owned()],
                item_profile_assignments: BTreeMap::from([
                    ("retained".to_owned(), retained_profile_id.to_string()),
                    ("removed".to_owned(), retained_profile_id.to_string()),
                    ("new".to_owned(), removed_profile_id.to_string()),
                ]),
                expanded_event_indexes: vec![1, 3],
            },
        };
        let fresh_response = response(vec![event(1, vec![item("retained", 1), item("new", 1)])]);
        let fresh = WorkflowEditorState {
            event_names: BTreeMap::from([(1, "wydarzenie-01".to_owned())]),
            excluded_item_keys: Vec::new(),
            item_profile_assignments: BTreeMap::from([
                ("retained".to_owned(), "unknown".to_owned()),
                ("new".to_owned(), "unknown".to_owned()),
            ]),
            expanded_event_indexes: Vec::new(),
        };

        let merged = merge_workflow_editor(&settings, &previous, &fresh_response, fresh);

        assert_eq!(merged.event_names.len(), 1);
        assert_eq!(merged.event_names[&1], "Retained event name");
        assert_eq!(merged.excluded_item_keys, vec!["retained"]);
        assert_eq!(
            merged.item_profile_assignments["retained"],
            retained_profile_id.to_string()
        );
        assert_eq!(merged.item_profile_assignments["new"], "unknown");
        assert!(!merged.item_profile_assignments.contains_key("removed"));
        assert_eq!(merged.expanded_event_indexes, vec![1]);
    }

    #[test]
    fn refreshed_plan_is_rebuilt_from_the_preserved_matching_edits() {
        let profile_id = Uuid::new_v4();
        let mut settings = AppSettings::default();
        let library = tempfile::tempdir().expect("library should exist");
        settings.local.library_path = Some(library.path().to_path_buf());
        settings.portable.camera_profiles.push(CameraProfile {
            id: profile_id,
            name: "Manual camera".to_owned(),
            exif_matchers: Vec::new(),
            default_time_offset_seconds: 0,
            source_behavior: None,
        });
        let previous = WorkflowEditorSnapshot {
            source_id: "marker:card".to_owned(),
            scan: Some(response(vec![event(
                2,
                vec![item("retained", 1), item("excluded", 1)],
            )])),
            editor: WorkflowEditorState {
                event_names: BTreeMap::from([(2, "Edited event".to_owned())]),
                excluded_item_keys: vec!["excluded".to_owned()],
                item_profile_assignments: BTreeMap::from([(
                    "retained".to_owned(),
                    profile_id.to_string(),
                )]),
                expanded_event_indexes: Vec::new(),
            },
        };
        let fresh = response(vec![event(
            1,
            vec![item("retained", 1), item("excluded", 1), item("new", 1)],
        )]);
        let volume = SourceVolume {
            fingerprint: "fingerprint".to_owned(),
            marker_uuid: Some(Uuid::new_v4()),
            platform_volume_id: Some("volume-id".to_owned()),
            name: "Card".to_owned(),
            mount_path: "E:/".into(),
            file_system: "exFAT".to_owned(),
            total_bytes: 100,
            available_bytes: 50,
            removable: true,
            read_only: false,
            contains_dcim: true,
            likely_camera_source: true,
        };

        let workflow = prepare_automatic_workflow(&settings, &volume, fresh, Some(&previous))
            .expect("fresh plan should be prepared");
        let plan = workflow.plan.expect("fresh plan should exist");

        assert_eq!(workflow.state, SourceWorkflowState::PlanReady);
        assert_eq!(workflow.editor.event_names[&1], "Edited event");
        assert_eq!(workflow.editor.excluded_item_keys, vec!["excluded"]);
        assert_eq!(plan.file_count, 2);
        assert_eq!(plan.excluded_item_count, 1);
        assert!(
            plan.events
                .iter()
                .all(|event| event.event_name == "Edited event")
        );
        let retained = plan
            .events
            .iter()
            .flat_map(|event| &event.items)
            .find(|item| item.item_key == "retained")
            .expect("retained item should remain in the fresh plan");
        assert_eq!(retained.camera_alias.as_deref(), Some("Manual camera"));
    }
}
