use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};

use importer_domain::settings::SourceIdentity;
use importer_manifest::{FileCandidate, ImportManifest, ManifestError, RecognitionProgress};
use importer_media::{
    ScanError, ScanProgress, SourceDiscovery, SystemSourceDiscovery, group_into_events,
    scan_media_parallel_with_progress,
};
use serde::Serialize;
use tauri::Emitter;
use uuid::Uuid;

use crate::settings::SettingsService;
use crate::sources::{
    SourceScanResponse, SourceWorkflowState, aggregate_import_matches, persist_workflow,
    prepare_automatic_workflow,
};

#[derive(Debug, Default)]
pub(crate) struct ScanService {
    jobs: Arc<Mutex<HashMap<String, InternalScanJob>>>,
}

#[derive(Debug)]
struct InternalScanJob {
    public: MediaScanJob,
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MediaScanJobStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MediaScanJobPhase {
    Discovering,
    ReadingMetadata,
    ComparingHistory,
    GroupingEvents,
    Completed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaScanJob {
    id: String,
    path: PathBuf,
    status: MediaScanJobStatus,
    phase: MediaScanJobPhase,
    discovered_file_count: usize,
    processed_file_count: usize,
    total_supported_file_count: Option<usize>,
    current_path: Option<PathBuf>,
    history_bytes_read: u64,
    history_cache_hit_count: usize,
    fully_hashed_file_count: usize,
    timings: ScanJobTimings,
    started_at_unix_ms: u64,
    updated_at_unix_ms: u64,
    error: Option<String>,
    result: Option<SourceScanResponse>,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanJobTimings {
    discovery_ms: u64,
    metadata_ms: u64,
    comparing_history_ms: u64,
    grouping_events_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanJobCommandError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ScanService {
    fn update(&self, id: &str, update: impl FnOnce(&mut MediaScanJob)) -> Option<MediaScanJob> {
        let mut jobs = self.jobs.lock().ok()?;
        let job = &mut jobs.get_mut(id)?.public;
        update(job);
        job.updated_at_unix_ms = now_unix_ms();
        Some(job.clone())
    }

    pub(crate) fn get(&self, id: &str) -> Option<MediaScanJob> {
        self.jobs.lock().ok()?.get(id).map(|job| job.public.clone())
    }
}

impl MediaScanJob {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn status(&self) -> MediaScanJobStatus {
        self.status
    }

    pub(crate) fn imported_candidate_count(&self) -> Option<usize> {
        self.result.as_ref().map(|result| result.scan.items.len())
    }

    pub(crate) fn error_message(&self) -> Option<&str> {
        self.error.as_deref()
    }
}

#[tauri::command]
pub(crate) fn start_media_scan(
    path: PathBuf,
    app: tauri::AppHandle,
    service: tauri::State<'_, ScanService>,
    settings: tauri::State<'_, SettingsService>,
    manifest: tauri::State<'_, ImportManifest>,
) -> Result<MediaScanJob, ScanJobCommandError> {
    start_media_scan_internal(path, app, &service, &settings, &manifest)
}

pub(crate) fn start_media_scan_internal(
    path: PathBuf,
    app: tauri::AppHandle,
    service: &ScanService,
    settings: &SettingsService,
    manifest: &ImportManifest,
) -> Result<MediaScanJob, ScanJobCommandError> {
    let settings_snapshot = settings.current_settings().map_err(|error| {
        ScanJobCommandError::new("settingsUnavailable", error.message().to_owned())
    })?;
    let event_gap_minutes = settings_snapshot.portable.import.event_gap_minutes;
    let mut jobs = service.jobs.lock().map_err(|_| {
        ScanJobCommandError::new("scanStateUnavailable", "Stan skanowania jest niedostępny.")
    })?;
    if let Some(existing) = jobs
        .values()
        .find(|job| job.public.path == path && job.public.status == MediaScanJobStatus::Running)
    {
        return Ok(existing.public.clone());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_unix_ms();
    let public = MediaScanJob {
        id: id.clone(),
        path: path.clone(),
        status: MediaScanJobStatus::Running,
        phase: MediaScanJobPhase::Discovering,
        discovered_file_count: 0,
        processed_file_count: 0,
        total_supported_file_count: None,
        current_path: None,
        history_bytes_read: 0,
        history_cache_hit_count: 0,
        fully_hashed_file_count: 0,
        timings: ScanJobTimings::default(),
        started_at_unix_ms: now,
        updated_at_unix_ms: now,
        error: None,
        result: None,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    jobs.insert(
        id.clone(),
        InternalScanJob {
            public: public.clone(),
            cancel: Arc::clone(&cancel),
        },
    );
    drop(jobs);

    let source_identity = SystemSourceDiscovery
        .discover()
        .into_iter()
        .find(|volume| volume.mount_path == path)
        .map_or_else(
            || {
                format!(
                    "path:{}",
                    path.canonicalize()
                        .unwrap_or_else(|_| path.clone())
                        .display()
                )
            },
            |volume| volume.fingerprint,
        );

    let scan_service = ScanService {
        jobs: Arc::clone(&service.jobs),
    };
    let scan_manifest = manifest.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = scan_media_parallel_with_progress(
            &path,
            |progress| emit_progress(&scan_service, &app, &id, progress),
            || cancel.load(Ordering::Relaxed),
        );
        let scan = match result {
            Ok(scan) => scan,
            Err(error) => {
                finish_error(&scan_service, &app, &id, error);
                return;
            }
        };
        let scan_timings = scan.timings;
        if cancel.load(Ordering::Relaxed) {
            finish_cancelled(&scan_service, &app, &id);
            return;
        }
        emit_phase(
            &scan_service,
            &app,
            &id,
            MediaScanJobPhase::ComparingHistory,
        );
        let comparison_started = Instant::now();
        let candidates: Vec<_> = scan
            .items
            .iter()
            .flat_map(|item| {
                item.files.iter().map(|file| FileCandidate {
                    item_key: item.key.clone(),
                    path: file.path.clone(),
                    size_bytes: file.size_bytes,
                })
            })
            .collect();
        let matches = match scan_manifest.recognize_files_with_progress(
            &candidates,
            Some(&source_identity),
            Some(&path),
            |progress| emit_recognition_progress(&scan_service, &app, &id, progress),
            || cancel.load(Ordering::Relaxed),
        ) {
            Ok(matches) => matches,
            Err(ManifestError::Cancelled) => {
                finish_cancelled(&scan_service, &app, &id);
                return;
            }
            Err(error) => {
                finish_message(&scan_service, &app, &id, error.to_string());
                return;
            }
        };
        let comparing_history_ms = elapsed_ms(comparison_started);
        emit_phase(&scan_service, &app, &id, MediaScanJobPhase::GroupingEvents);
        let grouping_started = Instant::now();
        let import_matches = aggregate_import_matches(&scan.items, &matches);
        let events = group_into_events(scan.items.clone(), event_gap_minutes);
        let grouping_events_ms = elapsed_ms(grouping_started);
        let response = SourceScanResponse {
            scan,
            events,
            timestamp_basis: "embeddedWithFileFallback".to_owned(),
            event_gap_minutes,
            import_matches,
        };
        if let Some(job) = scan_service.update(&id, |job| {
            job.status = MediaScanJobStatus::Completed;
            job.phase = MediaScanJobPhase::Completed;
            job.result = Some(response.clone());
            job.current_path = None;
            job.timings = ScanJobTimings {
                discovery_ms: scan_timings.discovery_ms,
                metadata_ms: scan_timings.metadata_ms,
                comparing_history_ms,
                grouping_events_ms,
            };
        }) {
            let _ = app.emit("scan-progress", job);
        }
        if let Some(volume) = SystemSourceDiscovery
            .discover()
            .into_iter()
            .find(|volume| volume.mount_path == path)
        {
            match prepare_automatic_workflow(&settings_snapshot, &volume, response.clone()) {
                Ok(workflow) => {
                    if let Err(error) = persist_workflow(&scan_manifest, &workflow) {
                        finish_message(&scan_service, &app, &id, error.message);
                        return;
                    }
                    let _ = app.emit("source-workflow-changed", workflow.clone());
                    if workflow.state == SourceWorkflowState::PlanReady {
                        let file_count = workflow.plan.as_ref().map_or(0, |plan| plan.file_count);
                        let _ = app.emit("plan-ready", workflow);
                        crate::background::announce_plan_ready_for_source(
                            &app,
                            &path,
                            &format!("Plan obejmuje {file_count} plików i czeka na zatwierdzenie."),
                        );
                    } else if workflow.state == SourceWorkflowState::AwaitingProfileConfirmation {
                        let _ = app.emit("source-profile-confirmation-required", workflow.clone());
                        crate::background::announce_profile_confirmation_required(&app, &path);
                    }
                }
                Err(error) => {
                    let workflow = crate::sources::PendingSourceWorkflow {
                        source_id: volume
                            .marker_uuid
                            .map_or_else(|| volume.fingerprint.clone(), |id| id.to_string()),
                        source_root: volume.mount_path.clone(),
                        source_identity: Some(SourceIdentity {
                            marker_uuid: volume.marker_uuid,
                            platform_volume_id: volume.platform_volume_id.clone(),
                            fallback_fingerprint: volume.fingerprint.clone(),
                        }),
                        display_name: volume.name.clone(),
                        state: SourceWorkflowState::FailedRecoverable,
                        scan: Some(response.clone()),
                        plan: None,
                        settings_schema_version: settings_snapshot.schema_version,
                        settings_revision: serde_json::to_string(
                            &settings_snapshot.portable.naming,
                        )
                        .unwrap_or_default(),
                        editor: crate::sources::WorkflowEditorState::default(),
                        error: Some(error.message.clone()),
                        updated_at_unix_ms: now_unix_ms(),
                    };
                    let _ = persist_workflow(&scan_manifest, &workflow);
                    let _ = app.emit("source-workflow-changed", workflow);
                    crate::background::announce_workflow_error(&app, &error.message);
                }
            }
        }
    });
    Ok(public)
}

#[tauri::command]
pub(crate) fn get_media_scan(
    scan_id: String,
    service: tauri::State<'_, ScanService>,
) -> Result<MediaScanJob, ScanJobCommandError> {
    service
        .jobs
        .lock()
        .map_err(|_| {
            ScanJobCommandError::new("scanStateUnavailable", "Stan skanowania jest niedostępny.")
        })?
        .get(&scan_id)
        .map(|job| job.public.clone())
        .ok_or_else(|| ScanJobCommandError::new("scanNotFound", "Skan nie istnieje."))
}

#[tauri::command]
pub(crate) fn list_media_scans(
    service: tauri::State<'_, ScanService>,
) -> Result<Vec<MediaScanJob>, ScanJobCommandError> {
    let mut jobs: Vec<_> = service
        .jobs
        .lock()
        .map_err(|_| {
            ScanJobCommandError::new("scanStateUnavailable", "Stan skanowania jest niedostępny.")
        })?
        .values()
        .map(|job| job.public.clone())
        .collect();
    jobs.sort_by_key(|job| std::cmp::Reverse(job.started_at_unix_ms));
    Ok(jobs)
}

#[tauri::command]
pub(crate) fn cancel_media_scan(
    scan_id: String,
    service: tauri::State<'_, ScanService>,
) -> Result<MediaScanJob, ScanJobCommandError> {
    let jobs = service.jobs.lock().map_err(|_| {
        ScanJobCommandError::new("scanStateUnavailable", "Stan skanowania jest niedostępny.")
    })?;
    let job = jobs
        .get(&scan_id)
        .ok_or_else(|| ScanJobCommandError::new("scanNotFound", "Skan nie istnieje."))?;
    job.cancel.store(true, Ordering::Relaxed);
    Ok(job.public.clone())
}

impl ScanJobCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn emit_progress(service: &ScanService, app: &tauri::AppHandle, id: &str, progress: ScanProgress) {
    let phase = match progress.phase {
        importer_media::ScanProgressPhase::Discovering => MediaScanJobPhase::Discovering,
        importer_media::ScanProgressPhase::ReadingMetadata => MediaScanJobPhase::ReadingMetadata,
    };
    if let Some(job) = service.update(id, |job| {
        job.phase = phase;
        job.discovered_file_count = progress.discovered_file_count;
        job.processed_file_count = progress.processed_file_count;
        job.total_supported_file_count = progress.total_supported_file_count;
        job.current_path = progress.current_path;
    }) {
        let _ = app.emit("scan-progress", job);
    }
}

fn emit_recognition_progress(
    service: &ScanService,
    app: &tauri::AppHandle,
    id: &str,
    progress: RecognitionProgress,
) {
    if let Some(job) = service.update(id, |job| {
        job.phase = MediaScanJobPhase::ComparingHistory;
        job.processed_file_count = progress.processed_file_count;
        job.total_supported_file_count = Some(progress.total_file_count);
        job.current_path = progress.current_path;
        job.history_bytes_read = progress.bytes_read;
        job.history_cache_hit_count = progress.cache_hit_count;
        job.fully_hashed_file_count = progress.fully_hashed_file_count;
    }) {
        let _ = app.emit("scan-progress", job);
    }
}

fn emit_phase(service: &ScanService, app: &tauri::AppHandle, id: &str, phase: MediaScanJobPhase) {
    if let Some(job) = service.update(id, |job| {
        job.phase = phase;
        job.current_path = None;
    }) {
        let _ = app.emit("scan-progress", job);
    }
}

fn finish_error(service: &ScanService, app: &tauri::AppHandle, id: &str, error: ScanError) {
    if matches!(error, ScanError::Cancelled) {
        finish_cancelled(service, app, id);
    } else {
        finish_message(service, app, id, error.to_string());
    }
}

fn finish_message(service: &ScanService, app: &tauri::AppHandle, id: &str, message: String) {
    if let Some(job) = service.update(id, |job| {
        job.status = MediaScanJobStatus::Failed;
        job.error = Some(message);
    }) {
        let _ = app.emit("scan-progress", job);
    }
}

fn finish_cancelled(service: &ScanService, app: &tauri::AppHandle, id: &str) {
    if let Some(job) = service.update(id, |job| {
        job.status = MediaScanJobStatus::Cancelled;
        job.error = None;
        job.current_path = None;
    }) {
        let _ = app.emit("scan-progress", job);
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}
