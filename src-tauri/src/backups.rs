use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use importer_backup::{
    BackupError, BackupPhase, BackupPlan, BackupProgress, BackupReport, BackupTarget,
    TargetRegistry,
};
use importer_domain::AppSettings;
use importer_media::{SourceDiscovery, SourceVolume, SystemSourceDiscovery};
use serde::Serialize;
use tauri::Emitter;
use uuid::Uuid;

use crate::settings::SettingsService;

const REGISTRY_FILE: &str = "backup-targets.sqlite3";

#[derive(Debug, Clone)]
pub(crate) struct BackupService {
    registry: TargetRegistry,
    jobs: Arc<Mutex<HashMap<String, InternalBackupJob>>>,
}

#[derive(Debug)]
struct InternalBackupJob {
    public: BackupJob,
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BackupJobStatus {
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupJob {
    id: String,
    target_id: Uuid,
    source_path: PathBuf,
    target_path: PathBuf,
    status: BackupJobStatus,
    phase: BackupPhase,
    processed_file_count: usize,
    total_file_count: Option<usize>,
    processed_bytes: u64,
    total_bytes: Option<u64>,
    current_path: Option<PathBuf>,
    pause_requested: bool,
    started_at_unix_ms: u64,
    updated_at_unix_ms: u64,
    error: Option<String>,
    report: Option<BackupReport>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupCommandError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl BackupService {
    pub(crate) fn new(data_directory: impl Into<PathBuf>) -> Result<Self, BackupError> {
        Ok(Self {
            registry: TargetRegistry::open(data_directory.into().join(REGISTRY_FILE))?,
            jobs: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    fn register(
        &self,
        path: PathBuf,
        label: String,
        settings: &AppSettings,
        volumes: &[SourceVolume],
    ) -> Result<BackupTarget, BackupCommandError> {
        if !path.is_dir() {
            return Err(BackupCommandError::new(
                "invalidTargetPath",
                format!(
                    "Cel backupu nie jest dostępnym katalogiem: {}",
                    path.display()
                ),
            ));
        }
        let label = label.trim();
        if label.is_empty() {
            return Err(BackupCommandError::new(
                "invalidTargetLabel",
                "Nazwa celu backupu nie może być pusta.",
            ));
        }
        if volumes.iter().any(|volume| {
            same_directory(&volume.mount_path, &path)
                && importer_background::resolve_connection(volume, settings).is_some()
        }) {
            return Err(BackupCommandError::new(
                "mediaRoleConflict",
                "Ten nośnik jest już przypisany jako karta źródłowa.",
            ));
        }
        self.registry
            .register(path, label)
            .map_err(BackupCommandError::from)
    }

    fn list(&self) -> Result<Vec<BackupTarget>, BackupCommandError> {
        self.registry
            .known_targets()
            .map_err(BackupCommandError::from)
    }

    fn recognize(&self, path: PathBuf) -> Result<Option<BackupTarget>, BackupCommandError> {
        self.registry
            .recognize(path)
            .map(|engine| engine.map(|engine| engine.target().clone()))
            .map_err(BackupCommandError::from)
    }

    fn remove(&self, target_id: &str) -> Result<(), BackupCommandError> {
        let target_id = parse_target_id(target_id)?;
        if !self
            .registry
            .remove(target_id)
            .map_err(BackupCommandError::from)?
        {
            return Err(BackupCommandError::new(
                "targetNotFound",
                "Nie znaleziono konfiguracji celu backupu.",
            ));
        }
        Ok(())
    }

    fn prepare_plan(
        &self,
        target_id: &str,
        target_path: PathBuf,
        source_path: PathBuf,
    ) -> Result<BackupPlan, BackupCommandError> {
        let target_id = parse_target_id(target_id)?;
        self.registry
            .connect(target_id, target_path)
            .and_then(|engine| engine.plan(source_path))
            .map_err(BackupCommandError::from)
    }

    fn update_job(&self, id: &str, update: impl FnOnce(&mut BackupJob)) -> Option<BackupJob> {
        let mut jobs = self.jobs.lock().ok()?;
        let job = &mut jobs.get_mut(id)?.public;
        update(job);
        job.updated_at_unix_ms = now_unix_ms();
        Some(job.clone())
    }

    fn begin_job(
        &self,
        plan: &BackupPlan,
        target_path: PathBuf,
    ) -> Result<
        (
            BackupJob,
            importer_backup::BackupEngine,
            Arc<AtomicBool>,
            Arc<AtomicBool>,
            bool,
        ),
        BackupCommandError,
    > {
        let target_id = plan.target_id;
        let source_path = plan.source_root.clone();
        let engine = self
            .registry
            .connect(target_id, target_path.clone())
            .map_err(BackupCommandError::from)?;
        if !source_path.is_dir() {
            return Err(BackupCommandError::from(BackupError::InvalidSourceRoot(
                source_path,
            )));
        }
        let mut jobs = self.jobs.lock().map_err(|_| {
            BackupCommandError::new("backupStateUnavailable", "Stan backupu jest niedostępny.")
        })?;
        if let Some(existing) = jobs.values().find(|job| {
            job.public.target_id == target_id
                && matches!(
                    job.public.status,
                    BackupJobStatus::Running | BackupJobStatus::Paused
                )
        }) {
            return Ok((
                existing.public.clone(),
                engine,
                Arc::clone(&existing.cancel),
                Arc::clone(&existing.pause),
                false,
            ));
        }
        let id = Uuid::new_v4().to_string();
        let now = now_unix_ms();
        let public = BackupJob {
            id: id.clone(),
            target_id,
            source_path,
            target_path,
            status: BackupJobStatus::Running,
            phase: BackupPhase::Copying,
            processed_file_count: 0,
            total_file_count: Some(plan.operations.len()),
            processed_bytes: 0,
            total_bytes: Some(plan.total_copy_bytes),
            current_path: None,
            pause_requested: false,
            started_at_unix_ms: now,
            updated_at_unix_ms: now,
            error: None,
            report: None,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = Arc::new(AtomicBool::new(false));
        jobs.insert(
            id,
            InternalBackupJob {
                public: public.clone(),
                cancel: Arc::clone(&cancel),
                pause: Arc::clone(&pause),
            },
        );
        Ok((public, engine, cancel, pause, true))
    }

    fn list_jobs(&self) -> Result<Vec<BackupJob>, BackupCommandError> {
        let mut jobs: Vec<_> = self
            .jobs
            .lock()
            .map_err(|_| {
                BackupCommandError::new("backupStateUnavailable", "Stan backupu jest niedostępny.")
            })?
            .values()
            .map(|job| job.public.clone())
            .collect();
        jobs.sort_by_key(|job| std::cmp::Reverse(job.started_at_unix_ms));
        Ok(jobs)
    }

    fn control_job(
        &self,
        id: &str,
        action: BackupControlAction,
    ) -> Result<BackupJob, BackupCommandError> {
        let mut jobs = self.jobs.lock().map_err(|_| {
            BackupCommandError::new("backupStateUnavailable", "Stan backupu jest niedostępny.")
        })?;
        let job = jobs.get_mut(id).ok_or_else(|| {
            BackupCommandError::new("backupJobNotFound", "Zadanie backupu nie istnieje.")
        })?;
        if matches!(
            job.public.status,
            BackupJobStatus::Completed | BackupJobStatus::Failed | BackupJobStatus::Cancelled
        ) {
            return Ok(job.public.clone());
        }
        match action {
            BackupControlAction::Pause => {
                job.pause.store(true, Ordering::Relaxed);
                job.public.pause_requested = true;
            }
            BackupControlAction::Resume => {
                job.pause.store(false, Ordering::Relaxed);
                job.public.pause_requested = false;
                if job.public.status == BackupJobStatus::Paused {
                    job.public.status = BackupJobStatus::Running;
                }
            }
            BackupControlAction::Cancel => job.cancel.store(true, Ordering::Relaxed),
        }
        job.public.updated_at_unix_ms = now_unix_ms();
        Ok(job.public.clone())
    }

    pub(crate) fn validate_source_roles(
        &self,
        settings: &AppSettings,
        volumes: &[SourceVolume],
    ) -> Result<(), BackupCommandError> {
        for volume in volumes {
            if importer_background::resolve_connection(volume, settings).is_some()
                && self.recognize(volume.mount_path.clone())?.is_some()
            {
                return Err(BackupCommandError::new(
                    "mediaRoleConflict",
                    "Ten nośnik jest już zarejestrowanym celem backupu.",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
enum BackupControlAction {
    Pause,
    Resume,
    Cancel,
}

impl BackupCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<BackupError> for BackupCommandError {
    fn from(error: BackupError) -> Self {
        let code = match &error {
            BackupError::InvalidTargetRoot(_) => "invalidTargetPath",
            BackupError::InvalidSourceRoot(_) => "invalidSourcePath",
            BackupError::OverlappingRoots => "overlappingBackupRoots",
            BackupError::WrongTarget { .. } => "wrongBackupTarget",
            BackupError::InvalidMarker { .. } => "invalidTargetMarker",
            BackupError::UnsafeRelativePath(_) => "unsafeBackupPath",
            BackupError::SourceChanged(_) => "backupSourceChanged",
            BackupError::VerificationFailed(_) => "backupVerificationFailed",
            BackupError::WrongPlanTarget => "wrongBackupPlanTarget",
            BackupError::Cancelled => "backupCancelled",
            BackupError::Io { .. }
            | BackupError::Database(_)
            | BackupError::Scan(_)
            | BackupError::ValueTooLarge(_) => "backupIoFailed",
        };
        Self::new(code, error.to_string())
    }
}

fn parse_target_id(value: &str) -> Result<Uuid, BackupCommandError> {
    Uuid::parse_str(value).map_err(|_| {
        BackupCommandError::new(
            "invalidTargetId",
            "Identyfikator celu backupu nie jest poprawnym UUID.",
        )
    })
}

fn same_directory(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

#[tauri::command]
pub(crate) async fn register_backup_target(
    path: PathBuf,
    label: String,
    settings: tauri::State<'_, SettingsService>,
    service: tauri::State<'_, BackupService>,
) -> Result<BackupTarget, BackupCommandError> {
    let settings = settings.current_settings().map_err(|error| {
        BackupCommandError::new("settingsUnavailable", error.message().to_owned())
    })?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let volumes = SystemSourceDiscovery.discover();
        service.register(path, label, &settings, &volumes)
    })
    .await
    .map_err(|error| BackupCommandError::new("backupTaskFailed", error.to_string()))?
}

#[tauri::command]
pub(crate) fn list_backup_targets(
    service: tauri::State<'_, BackupService>,
) -> Result<Vec<BackupTarget>, BackupCommandError> {
    service.list()
}

#[tauri::command]
pub(crate) async fn recognize_backup_target(
    path: PathBuf,
    service: tauri::State<'_, BackupService>,
) -> Result<Option<BackupTarget>, BackupCommandError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.recognize(path))
        .await
        .map_err(|error| BackupCommandError::new("backupTaskFailed", error.to_string()))?
}

#[tauri::command]
pub(crate) fn remove_backup_target(
    target_id: String,
    service: tauri::State<'_, BackupService>,
) -> Result<(), BackupCommandError> {
    service.remove(&target_id)
}

#[tauri::command]
pub(crate) async fn prepare_backup_plan(
    target_id: String,
    target_path: PathBuf,
    source_path: PathBuf,
    service: tauri::State<'_, BackupService>,
) -> Result<BackupPlan, BackupCommandError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.prepare_plan(&target_id, target_path, source_path)
    })
    .await
    .map_err(|error| BackupCommandError::new("backupTaskFailed", error.to_string()))?
}

#[tauri::command]
pub(crate) fn start_backup_job(
    plan: BackupPlan,
    target_path: PathBuf,
    app: tauri::AppHandle,
    service: tauri::State<'_, BackupService>,
) -> Result<BackupJob, BackupCommandError> {
    let (job, engine, cancel, pause, is_new) = service.begin_job(&plan, target_path)?;
    if !is_new {
        return Ok(job);
    }
    let job_id = job.id.clone();
    let worker_service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut was_paused = false;
        let result = engine.execute_with_progress(
            &plan,
            |progress| emit_job_progress(&worker_service, &app, &job_id, progress),
            || {
                while pause.load(Ordering::Relaxed) {
                    if cancel.load(Ordering::Relaxed) {
                        return false;
                    }
                    if !was_paused {
                        was_paused = true;
                        if let Some(job) = worker_service.update_job(&job_id, |job| {
                            job.status = BackupJobStatus::Paused;
                            job.pause_requested = true;
                            job.current_path = None;
                        }) {
                            let _ = app.emit("backup-progress", job);
                        }
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                if was_paused {
                    was_paused = false;
                    if let Some(job) = worker_service.update_job(&job_id, |job| {
                        job.status = BackupJobStatus::Running;
                        job.pause_requested = false;
                    }) {
                        let _ = app.emit("backup-progress", job);
                    }
                }
                !cancel.load(Ordering::Relaxed)
            },
            || cancel.load(Ordering::Relaxed),
        );
        match result {
            Ok(report) => {
                if let Some(job) = worker_service.update_job(&job_id, |job| {
                    job.status = BackupJobStatus::Completed;
                    job.phase = BackupPhase::Finalizing;
                    job.pause_requested = false;
                    job.current_path = None;
                    job.report = Some(report);
                }) {
                    let _ = app.emit("backup-progress", job);
                }
            }
            Err(error) => finish_job_error(&worker_service, &app, &job_id, error),
        }
    });
    Ok(job)
}

#[tauri::command]
pub(crate) fn list_backup_jobs(
    service: tauri::State<'_, BackupService>,
) -> Result<Vec<BackupJob>, BackupCommandError> {
    service.list_jobs()
}

#[tauri::command]
pub(crate) fn get_backup_job(
    job_id: String,
    service: tauri::State<'_, BackupService>,
) -> Result<BackupJob, BackupCommandError> {
    service
        .jobs
        .lock()
        .map_err(|_| {
            BackupCommandError::new("backupStateUnavailable", "Stan backupu jest niedostępny.")
        })?
        .get(&job_id)
        .map(|job| job.public.clone())
        .ok_or_else(|| {
            BackupCommandError::new("backupJobNotFound", "Zadanie backupu nie istnieje.")
        })
}

#[tauri::command]
pub(crate) fn pause_backup_job(
    job_id: String,
    service: tauri::State<'_, BackupService>,
) -> Result<BackupJob, BackupCommandError> {
    service.control_job(&job_id, BackupControlAction::Pause)
}

#[tauri::command]
pub(crate) fn resume_backup_job(
    job_id: String,
    service: tauri::State<'_, BackupService>,
) -> Result<BackupJob, BackupCommandError> {
    service.control_job(&job_id, BackupControlAction::Resume)
}

#[tauri::command]
pub(crate) fn cancel_backup_job(
    job_id: String,
    service: tauri::State<'_, BackupService>,
) -> Result<BackupJob, BackupCommandError> {
    service.control_job(&job_id, BackupControlAction::Cancel)
}

fn emit_job_progress(
    service: &BackupService,
    app: &tauri::AppHandle,
    id: &str,
    progress: BackupProgress,
) {
    if let Some(job) = service.update_job(id, |job| {
        job.phase = progress.phase;
        job.processed_file_count = progress.processed_file_count;
        job.total_file_count = progress.total_file_count;
        job.processed_bytes = progress.processed_bytes;
        job.total_bytes = progress.total_bytes;
        job.current_path = progress.current_path;
    }) {
        let _ = app.emit("backup-progress", job);
    }
}

fn finish_job_error(service: &BackupService, app: &tauri::AppHandle, id: &str, error: BackupError) {
    if let Some(job) = service.update_job(id, |job| {
        job.status = if matches!(&error, BackupError::Cancelled) {
            BackupJobStatus::Cancelled
        } else {
            BackupJobStatus::Failed
        };
        job.pause_requested = false;
        job.current_path = None;
        job.error = (!matches!(&error, BackupError::Cancelled)).then(|| error.to_string());
    }) {
        let _ = app.emit("backup-progress", job);
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use importer_domain::settings::{SourceBehavior, SourceBinding, SourceIdentity};

    use super::*;

    fn service() -> (tempfile::TempDir, BackupService) {
        let directory = tempfile::tempdir().unwrap();
        let service = BackupService::new(directory.path().join("data")).unwrap();
        (directory, service)
    }

    fn volume(path: PathBuf, fingerprint: &str) -> SourceVolume {
        SourceVolume {
            fingerprint: fingerprint.to_owned(),
            marker_uuid: None,
            platform_volume_id: None,
            name: "DISK".to_owned(),
            mount_path: path,
            file_system: "test".to_owned(),
            total_bytes: 1_000,
            available_bytes: 500,
            removable: true,
            read_only: false,
            contains_dcim: false,
            likely_camera_source: true,
        }
    }

    #[test]
    fn commands_register_list_and_recognize_a_target_by_uuid() {
        let (directory, service) = service();
        let disk = directory.path().join("disk");
        fs::create_dir(&disk).unwrap();

        let registered = service
            .register(
                disk.clone(),
                "Archiwum".to_owned(),
                &AppSettings::default(),
                &[],
            )
            .unwrap();

        assert_eq!(service.list().unwrap(), vec![registered.clone()]);
        let recognized = service.recognize(disk).unwrap().unwrap();
        assert_eq!(recognized.id, registered.id);
    }

    #[test]
    fn commands_reject_invalid_paths_and_a_different_disk() {
        let (directory, service) = service();
        let missing = directory.path().join("missing");
        let error = service
            .register(missing, "Archiwum".to_owned(), &AppSettings::default(), &[])
            .unwrap_err();
        assert_eq!(error.code, "invalidTargetPath");

        let disk = directory.path().join("disk");
        let other = directory.path().join("other");
        fs::create_dir(&disk).unwrap();
        fs::create_dir(&other).unwrap();
        let registered = service
            .register(disk, "Archiwum".to_owned(), &AppSettings::default(), &[])
            .unwrap();
        let error = service
            .prepare_plan(
                &registered.id.to_string(),
                other,
                directory.path().to_path_buf(),
            )
            .unwrap_err();
        assert_eq!(error.code, "wrongBackupTarget");
    }

    #[test]
    fn commands_remove_only_the_local_target_configuration() {
        let (directory, service) = service();
        let disk = directory.path().join("disk");
        fs::create_dir(&disk).unwrap();
        let registered = service
            .register(
                disk.clone(),
                "Archiwum".to_owned(),
                &AppSettings::default(),
                &[],
            )
            .unwrap();

        service.remove(&registered.id.to_string()).unwrap();

        assert!(service.list().unwrap().is_empty());
        assert!(service.recognize(disk).unwrap().is_none());
    }

    #[test]
    fn commands_prepare_a_backup_plan() {
        let (directory, service) = service();
        let disk = directory.path().join("disk");
        let source = directory.path().join("library");
        fs::create_dir(&disk).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(source.join("photo.jpg"), b"photo").unwrap();
        let registered = service
            .register(
                disk.clone(),
                "Archiwum".to_owned(),
                &AppSettings::default(),
                &[],
            )
            .unwrap();

        let plan = service
            .prepare_plan(&registered.id.to_string(), disk, source)
            .unwrap();

        assert_eq!(plan.target_id, registered.id);
        assert_eq!(plan.operations.len(), 1);
    }

    #[test]
    fn commands_reject_a_source_card_as_a_backup_target() {
        let (directory, service) = service();
        let disk = directory.path().join("disk");
        fs::create_dir(&disk).unwrap();
        let mut settings = AppSettings::default();
        settings.local.source_bindings.push(SourceBinding {
            id: Uuid::new_v4(),
            source_identity: SourceIdentity {
                marker_uuid: None,
                platform_volume_id: None,
                fallback_fingerprint: "same-disk".to_owned(),
            },
            display_name: "Karta".to_owned(),
            behavior: SourceBehavior::Ask,
            camera_profile_ids: Vec::new(),
            marker_state: Default::default(),
            last_seen_at_unix_ms: None,
        });

        let error = service
            .register(
                disk.clone(),
                "Archiwum".to_owned(),
                &settings,
                &[volume(disk, "same-disk")],
            )
            .unwrap_err();

        assert_eq!(error.code, "mediaRoleConflict");
        assert!(service.list().unwrap().is_empty());
    }

    #[test]
    fn source_assignment_rejects_an_existing_backup_target() {
        let (directory, service) = service();
        let disk = directory.path().join("disk");
        fs::create_dir(&disk).unwrap();
        service
            .register(
                disk.clone(),
                "Archiwum".to_owned(),
                &AppSettings::default(),
                &[],
            )
            .unwrap();
        let mut settings = AppSettings::default();
        settings.local.source_bindings.push(SourceBinding {
            id: Uuid::new_v4(),
            source_identity: SourceIdentity {
                marker_uuid: None,
                platform_volume_id: None,
                fallback_fingerprint: "same-disk".to_owned(),
            },
            display_name: "Karta".to_owned(),
            behavior: SourceBehavior::Ask,
            camera_profile_ids: Vec::new(),
            marker_state: Default::default(),
            last_seen_at_unix_ms: None,
        });

        let error = service
            .validate_source_roles(&settings, &[volume(disk, "same-disk")])
            .unwrap_err();

        assert_eq!(error.code, "mediaRoleConflict");
    }
}
