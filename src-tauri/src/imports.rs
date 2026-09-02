use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use importer_domain::settings::ImportOperation;
use importer_import::ImportExecutor;
use importer_manifest::{
    ImportManifest, ImportSession, ImportSessionOperation, ImportSessionStatus, NewImportOperation,
    NewImportSession, SessionSourceIdentity,
};
use importer_media::{MediaFileKind, SourceDiscovery, SourceVolume, SystemSourceDiscovery};
use importer_plan::{ImportPlan, ImportPlanStatus};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::settings::SettingsService;

#[derive(Debug)]
pub(crate) struct ImportService {
    manifest: ImportManifest,
    executor: ImportExecutor,
    runtime: Arc<Mutex<ImportRuntime>>,
}

#[derive(Debug, Default)]
struct ImportRuntime {
    running: HashSet<String>,
    queued: VecDeque<(String, tauri::AppHandle)>,
    rollback_after_stop: HashSet<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateSessionRequest {
    plan: ImportPlan,
    source_fingerprint: Option<String>,
    source_identity: Option<SessionSourceIdentity>,
    confirm_move: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportCommandError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CancelImportMode {
    KeepCompleted,
    RollbackSession,
}

impl ImportService {
    pub(crate) fn new(manifest: ImportManifest) -> Self {
        Self {
            executor: ImportExecutor::new(manifest.clone()),
            manifest,
            runtime: Arc::new(Mutex::new(ImportRuntime::default())),
        }
    }

    pub(crate) fn has_running_sessions(&self) -> bool {
        self.runtime
            .lock()
            .is_ok_and(|runtime| !runtime.running.is_empty() || !runtime.queued.is_empty())
    }

    pub(crate) fn launch(
        &self,
        session_id: String,
        app: tauri::AppHandle,
        max_concurrent: usize,
    ) -> Result<(), ImportCommandError> {
        let mut runtime = self.runtime.lock().map_err(|_| {
            ImportCommandError::new("importStatePoisoned", "Stan importu jest niedostępny.")
        })?;
        if runtime.running.contains(&session_id)
            || runtime.queued.iter().any(|(id, _)| id == &session_id)
        {
            return Ok(());
        }
        if runtime.running.len() >= max_concurrent {
            self.manifest
                .set_session_queued(&session_id)
                .map_err(manifest_error)?;
            runtime.queued.push_back((session_id, app));
            return Ok(());
        }
        runtime.running.insert(session_id.clone());
        drop(runtime);
        spawn_import_worker(
            self.executor.clone(),
            self.manifest.clone(),
            Arc::clone(&self.runtime),
            session_id,
            app,
            max_concurrent,
        );
        Ok(())
    }
}

fn spawn_import_worker(
    executor: ImportExecutor,
    manifest: ImportManifest,
    runtime: Arc<Mutex<ImportRuntime>>,
    session_id: String,
    app: tauri::AppHandle,
    max_concurrent: usize,
) {
    tauri::async_runtime::spawn_blocking(move || {
        let should_execute = manifest
            .get_import_session(&session_id)
            .ok()
            .flatten()
            .is_some_and(|session| session.status != ImportSessionStatus::Cancelled);
        if should_execute {
            crate::background::announce_import_started(&app);
            let _ = executor.execute_session(&session_id, |session| {
                let _ = app.emit("import-progress", session);
            });
        }
        let should_rollback = runtime
            .lock()
            .is_ok_and(|mut state| state.rollback_after_stop.remove(&session_id));
        if should_rollback {
            let rollback_result = executor.rollback_session(&session_id, |session| {
                let _ = app.emit("rollback-progress", session);
            });
            if let Err(error) = rollback_result {
                let _ = manifest.mark_session_status(
                    &session_id,
                    ImportSessionStatus::RollbackFailed,
                    Some(&error.to_string()),
                );
            }
            if let Ok(Some(session)) = manifest.get_import_session(&session_id) {
                let _ = app.emit("rollback-progress", &session);
            }
        }
        if let Ok(Some(session)) = manifest.get_import_session(&session_id) {
            let _ = app.emit("import-progress", &session);
            if session.status == ImportSessionStatus::FailedRecoverable {
                let _ = app.emit("import-source-unavailable", &session);
            }
            crate::background::announce_import_status(&app, &session);
        }
        let next = runtime.lock().ok().and_then(|mut state| {
            state.running.remove(&session_id);
            if state.running.len() >= max_concurrent {
                return None;
            }
            let next = state.queued.pop_front()?;
            state.running.insert(next.0.clone());
            Some(next)
        });
        if let Some((next_id, next_app)) = next {
            spawn_import_worker(
                executor,
                manifest,
                runtime,
                next_id,
                next_app,
                max_concurrent,
            );
        }
    });
}

impl ImportCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[tauri::command]
pub(crate) fn create_import_session(
    request: CreateSessionRequest,
    settings: tauri::State<'_, SettingsService>,
    service: tauri::State<'_, ImportService>,
) -> Result<ImportSession, ImportCommandError> {
    if request.plan.status != ImportPlanStatus::Ready
        || !request.plan.conflicts.is_empty()
        || request.plan.file_count == 0
    {
        return Err(ImportCommandError::new(
            "planNotReady",
            "Import można rozpocząć wyłącznie dla niepustego planu bez konfliktów.",
        ));
    }
    let settings = settings.current_settings().map_err(|error| {
        ImportCommandError::new("settingsUnavailable", error.message().to_owned())
    })?;
    let configured_library = settings.local.library_path.ok_or_else(|| {
        ImportCommandError::new(
            "libraryPathMissing",
            "Katalog biblioteki nie jest ustawiony.",
        )
    })?;
    if configured_library != request.plan.library_root {
        return Err(ImportCommandError::new(
            "libraryChanged",
            "Katalog biblioteki zmienił się od przygotowania planu. Odśwież plan.",
        ));
    }
    let operation = match settings.portable.import.default_operation {
        ImportOperation::Copy => ImportSessionOperation::Copy,
        ImportOperation::MoveAfterVerification => {
            if !request.confirm_move {
                return Err(ImportCommandError::new(
                    "moveConfirmationRequired",
                    "Przenoszenie wymaga dodatkowego potwierdzenia usuwania źródeł.",
                ));
            }
            ImportSessionOperation::MoveAfterVerification
        }
    };
    let mut operations = Vec::new();
    for event in &request.plan.events {
        for item in &event.items {
            for file in &item.files {
                if !file
                    .destination_path
                    .starts_with(&request.plan.library_root)
                {
                    return Err(ImportCommandError::new(
                        "unsafeDestination",
                        "Plan zawiera ścieżkę poza katalogiem biblioteki.",
                    ));
                }
                operations.push(NewImportOperation {
                    item_key: item.item_key.clone(),
                    event_name: event.event_name.clone(),
                    source_path: file.source_path.clone(),
                    source_relative_path: file.source_relative_path.clone(),
                    destination_path: file.destination_path.clone(),
                    destination_relative_path: file.destination_relative_path.clone(),
                    kind: media_kind_name(file.kind).to_owned(),
                    size_bytes: file.size_bytes,
                });
            }
        }
    }
    service
        .manifest
        .create_import_session(&NewImportSession {
            operation,
            library_root: request.plan.library_root,
            source_fingerprint: request.source_fingerprint,
            source_identity: request.source_identity,
            move_confirmed: request.confirm_move,
            operations,
        })
        .map_err(|error| {
            ImportCommandError::new(
                "createImportSessionFailed",
                format!("Nie można zapisać sesji importu: {error}"),
            )
        })
}

#[tauri::command]
pub(crate) fn start_import_session(
    session_id: String,
    source_root: Option<PathBuf>,
    app: tauri::AppHandle,
    service: tauri::State<'_, ImportService>,
    settings: tauri::State<'_, SettingsService>,
) -> Result<ImportSession, ImportCommandError> {
    let session = get_session(&service, &session_id)?;
    if matches!(
        session.status,
        ImportSessionStatus::Completed | ImportSessionStatus::Cancelled
    ) {
        return Err(ImportCommandError::new(
            "sessionAlreadyFinished",
            "Ta sesja została już zakończona.",
        ));
    }
    if !matches!(
        session.status,
        ImportSessionStatus::Planned
            | ImportSessionStatus::Queued
            | ImportSessionStatus::Paused
            | ImportSessionStatus::Failed
            | ImportSessionStatus::FailedRecoverable
    ) {
        return Err(ImportCommandError::new(
            "sessionNotStartable",
            "Sesji w tym stanie nie można uruchomić jako importu.",
        ));
    }
    let discovered = SystemSourceDiscovery.discover();
    let volume = source_root
        .as_ref()
        .and_then(|root| discovered.iter().find(|volume| &volume.mount_path == root))
        .or_else(|| {
            discovered
                .iter()
                .find(|volume| session_source_matches(&session, volume))
        });
    if session.source_identity.is_some() || source_root.is_some() {
        let volume = volume.ok_or_else(|| {
            ImportCommandError::new("sourceUnavailable", "Właściwa karta nie jest podłączona.")
        })?;
        if !session_source_matches(&session, volume) {
            return Err(ImportCommandError::new(
                "wrongSource",
                "Podłączony nośnik nie odpowiada karcie zapisanej w sesji.",
            ));
        }
        service
            .manifest
            .validate_and_relink_session_source(&session_id, &volume.mount_path)
            .map_err(manifest_error)?;
    }
    let max_concurrent = settings
        .current_settings()
        .map_err(|error| ImportCommandError::new("settingsUnavailable", error.message()))?
        .local
        .max_concurrent_imports;
    service.launch(session_id.clone(), app, usize::from(max_concurrent))?;
    get_session(&service, &session_id)
}

#[tauri::command]
pub(crate) fn pause_import_session(
    session_id: String,
    service: tauri::State<'_, ImportService>,
) -> Result<ImportSession, ImportCommandError> {
    service
        .manifest
        .request_session_pause(&session_id)
        .map_err(manifest_error)?;
    get_session(&service, &session_id)
}

#[tauri::command]
pub(crate) async fn cancel_import_session(
    session_id: String,
    mode: Option<CancelImportMode>,
    app: tauri::AppHandle,
    service: tauri::State<'_, ImportService>,
) -> Result<ImportSession, ImportCommandError> {
    if let Ok(mut runtime) = service.runtime.lock() {
        runtime.queued.retain(|(id, _)| id != &session_id);
    }
    let session = get_session(&service, &session_id)?;
    if matches!(mode, Some(CancelImportMode::RollbackSession)) {
        if session.status == ImportSessionStatus::Running {
            service
                .manifest
                .request_session_pause(&session_id)
                .map_err(manifest_error)?;
            service
                .runtime
                .lock()
                .map_err(|_| {
                    ImportCommandError::new("importStatePoisoned", "Stan importu jest niedostępny.")
                })?
                .rollback_after_stop
                .insert(session_id.clone());
            return get_session(&service, &session_id);
        }
        let executor = service.executor.clone();
        let id = session_id.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            executor.rollback_session(&id, |session| {
                let _ = app.emit("rollback-progress", session);
            })
        })
        .await
        .map_err(|error| ImportCommandError::new("rollbackTaskFailed", error.to_string()))?
        .map_err(|error| {
            let _ = service.manifest.mark_session_status(
                &session_id,
                ImportSessionStatus::RollbackFailed,
                Some(&error.to_string()),
            );
            ImportCommandError::new("rollbackFailed", error.to_string())
        });
    }
    if session.status == ImportSessionStatus::Running {
        service
            .manifest
            .request_session_cancel(&session_id)
            .map_err(manifest_error)?;
    } else if !matches!(
        session.status,
        ImportSessionStatus::Completed | ImportSessionStatus::Cancelled
    ) {
        service
            .manifest
            .mark_session_status(&session_id, ImportSessionStatus::Cancelled, None)
            .map_err(manifest_error)?;
    }
    get_session(&service, &session_id)
}

#[tauri::command]
pub(crate) async fn retry_import_rollback(
    session_id: String,
    app: tauri::AppHandle,
    service: tauri::State<'_, ImportService>,
) -> Result<ImportSession, ImportCommandError> {
    let session = get_session(&service, &session_id)?;
    if !matches!(
        session.status,
        ImportSessionStatus::RollbackFailed
            | ImportSessionStatus::Paused
            | ImportSessionStatus::Failed
    ) {
        return Err(ImportCommandError::new(
            "rollbackNotRetryable",
            "Wycofanie tej sesji nie oczekuje na ponowienie.",
        ));
    }
    cancel_import_session(
        session_id,
        Some(CancelImportMode::RollbackSession),
        app,
        service,
    )
    .await
}

pub(crate) fn session_source_matches(session: &ImportSession, volume: &SourceVolume) -> bool {
    let Some(identity) = &session.source_identity else {
        return session.source_fingerprint.as_deref() == Some(volume.fingerprint.as_str());
    };
    let strong_match = identity.marker_uuid.is_some() && identity.marker_uuid == volume.marker_uuid
        || identity.platform_volume_id.is_some()
            && identity.platform_volume_id == volume.platform_volume_id;
    if identity.marker_uuid.is_some() || identity.platform_volume_id.is_some() {
        strong_match
    } else {
        identity.fallback_fingerprint == volume.fingerprint
    }
}

#[tauri::command]
pub(crate) fn get_import_session(
    session_id: String,
    service: tauri::State<'_, ImportService>,
) -> Result<ImportSession, ImportCommandError> {
    get_session(&service, &session_id)
}

#[tauri::command]
pub(crate) fn list_import_sessions(
    service: tauri::State<'_, ImportService>,
) -> Result<Vec<ImportSession>, ImportCommandError> {
    service
        .manifest
        .list_import_sessions()
        .map_err(manifest_error)
}

fn get_session(service: &ImportService, id: &str) -> Result<ImportSession, ImportCommandError> {
    service
        .manifest
        .get_import_session(id)
        .map_err(manifest_error)?
        .ok_or_else(|| ImportCommandError::new("sessionNotFound", "Sesja importu nie istnieje."))
}

fn manifest_error(error: importer_manifest::ManifestError) -> ImportCommandError {
    ImportCommandError::new(
        "importManifestFailed",
        format!("Błąd historii importu: {error}"),
    )
}

fn media_kind_name(kind: MediaFileKind) -> &'static str {
    match kind {
        MediaFileKind::Jpeg => "jpeg",
        MediaFileKind::Heic => "heic",
        MediaFileKind::Raw => "raw",
        MediaFileKind::Video => "video",
        MediaFileKind::Xmp => "xmp",
    }
}
