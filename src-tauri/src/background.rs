use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use importer_background::{MonitorChange, SourceSnapshot, resolve_connection};
use importer_domain::settings::{
    ImportOperation, ResumeAfterRestart, SourceBehavior, SourceIdentity,
};
use importer_manifest::{
    ImportManifest, ImportSessionStatus, SessionSourceIdentity, SourceWorkflowRecord,
};
use importer_media::{SourceDiscovery, SystemSourceDiscovery};
use importer_plan::{ImportPlan, ImportPlanStatus};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

use crate::imports::{
    CreateSessionRequest, ImportService, create_import_session_internal, session_source_matches,
};
use crate::localization::{
    NativeText as Nt, app_language, app_text, card_ready, imported_file_count, plan_file_count,
    scan_result, text,
};
use crate::scan_jobs::{MediaScanJobStatus, ScanService, start_media_scan_internal};
use crate::settings::SettingsService;
use crate::sources::{PendingSourceWorkflow, SourceWorkflowState, persist_workflow};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const IDLE_TICK: Duration = Duration::from_millis(500);
const MAX_EVENTS: usize = 30;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationRoute {
    view: &'static str,
    source_path: Option<PathBuf>,
}

#[derive(Debug, Default)]
pub(crate) struct NotificationRouteState(Mutex<Option<NotificationRoute>>);

pub(crate) struct TrayTextState {
    show: MenuItem<tauri::Wry>,
    refresh: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundStatus {
    running: bool,
    last_checked_at_unix_ms: Option<u64>,
    connected_known_source_count: usize,
    active_auto_scan_count: usize,
    start_at_login_enabled: bool,
    last_error: Option<String>,
    events: Vec<BackgroundEvent>,
    pending_sources: Vec<PendingSource>,
    attention_required: Vec<BackgroundAttention>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundAttention {
    source_id: String,
    source_path: PathBuf,
    display_name: String,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingSource {
    fingerprint: String,
    name: String,
    source_path: PathBuf,
    state: SourceWorkflowState,
    probable_match: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundEvent {
    id: u64,
    occurred_at_unix_ms: u64,
    kind: BackgroundEventKind,
    title: String,
    detail: String,
    source_path: Option<PathBuf>,
    scan_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum BackgroundEventKind {
    SourceConnected,
    SourceDisconnected,
    ScanStarted,
    ScanCompleted,
    ScanFailed,
}

#[derive(Debug)]
struct AutoScanContext {
    profile_name: String,
    source_path: PathBuf,
    auto_import: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RestoredWorkflowAction {
    PreservePlan,
    RefreshForAutoImport,
}

#[derive(Debug, Clone, Copy)]
struct AutomaticImportGates {
    has_marker_uuid: bool,
    settings_are_current: bool,
    operation_is_copy: bool,
    workflow_is_ready: bool,
    plan_is_ready: bool,
    has_fresh_scan: bool,
}

fn automatic_import_blocking_reason(gates: AutomaticImportGates) -> Option<&'static str> {
    if !gates.has_marker_uuid {
        Some("Automatyczny import wymaga jednoznacznego identyfikatora UUID karty.")
    } else if !gates.settings_are_current {
        Some("Ustawienia wpływające na plan importu zmieniły się. Przelicz plan ponownie.")
    } else if !gates.operation_is_copy {
        Some("Automatyczne przenoszenie plików wymaga ręcznego potwierdzenia.")
    } else if !gates.workflow_is_ready || !gates.plan_is_ready {
        Some("Plan zawiera konflikt lub wymaga decyzji użytkownika.")
    } else if !gates.has_fresh_scan {
        Some("Wynik skanowania jest niedostępny.")
    } else {
        None
    }
}

fn restored_workflow_action(behavior: SourceBehavior) -> RestoredWorkflowAction {
    match behavior {
        SourceBehavior::AutoImport => RestoredWorkflowAction::RefreshForAutoImport,
        SourceBehavior::Ask | SourceBehavior::AutoPreparePlan | SourceBehavior::Ignore => {
            RestoredWorkflowAction::PreservePlan
        }
    }
}

#[derive(Debug)]
pub(crate) struct BackgroundService {
    status: Arc<Mutex<BackgroundStatus>>,
    refresh_requested: Arc<AtomicBool>,
    refresh_progress: Arc<(Mutex<RefreshProgress>, Condvar)>,
}

#[derive(Debug)]
struct RefreshProgress {
    requested_generation: u64,
    completed_generation: u64,
}

impl Default for BackgroundService {
    fn default() -> Self {
        Self {
            status: Arc::new(Mutex::new(BackgroundStatus {
                running: true,
                last_checked_at_unix_ms: None,
                connected_known_source_count: 0,
                active_auto_scan_count: 0,
                start_at_login_enabled: false,
                last_error: None,
                events: Vec::new(),
                pending_sources: Vec::new(),
                attention_required: Vec::new(),
            })),
            refresh_requested: Arc::new(AtomicBool::new(true)),
            refresh_progress: Arc::new((
                Mutex::new(RefreshProgress {
                    requested_generation: 1,
                    completed_generation: 0,
                }),
                Condvar::new(),
            )),
        }
    }
}

impl BackgroundService {
    pub(crate) fn start(&self, app: tauri::AppHandle) {
        let status = Arc::clone(&self.status);
        let refresh_requested = Arc::clone(&self.refresh_requested);
        let refresh_progress = Arc::clone(&self.refresh_progress);
        tauri::async_runtime::spawn_blocking(move || {
            let mut snapshot = SourceSnapshot::default();
            let mut scans = HashMap::<String, AutoScanContext>::new();
            let mut last_poll = Instant::now() - POLL_INTERVAL;

            loop {
                let refresh_generation =
                    take_refresh_generation(&refresh_requested, &refresh_progress);
                if refresh_generation.is_some() || last_poll.elapsed() >= POLL_INTERVAL {
                    poll_sources(&app, &status, &mut snapshot, &mut scans);
                    last_poll = Instant::now();
                    if let Some(generation) = refresh_generation {
                        complete_refresh(&refresh_progress, generation);
                    }
                }
                finish_auto_scans(&app, &status, &mut scans);
                std::thread::sleep(IDLE_TICK);
            }
        });
    }

    pub(crate) fn request_refresh(&self) -> Result<u64, BackgroundCommandError> {
        let (progress, _) = &*self.refresh_progress;
        let generation = {
            let mut progress = progress.lock().map_err(|_| {
                BackgroundCommandError::new(
                    "backgroundStateUnavailable",
                    "Stan automatu jest niedostępny.",
                )
            })?;
            progress.requested_generation = progress.requested_generation.saturating_add(1);
            progress.requested_generation
        };
        self.refresh_requested.store(true, Ordering::Relaxed);
        Ok(generation)
    }

    fn current(&self) -> Result<BackgroundStatus, BackgroundCommandError> {
        current_status(&self.status)
    }

    pub(crate) fn update_autostart(&self, enabled: bool, error: Option<String>) {
        update_status(&self.status, |status| {
            status.start_at_login_enabled = enabled;
            status.last_error = error;
        });
    }

    fn acknowledge(&self, path: &std::path::Path) {
        update_status(&self.status, |status| {
            status
                .pending_sources
                .retain(|source| source.source_path != path);
        });
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundCommandError {
    code: &'static str,
    message: String,
    technical_details: String,
}

impl BackgroundCommandError {
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
pub(crate) fn get_background_status(
    service: tauri::State<'_, BackgroundService>,
    manifest: tauri::State<'_, ImportManifest>,
) -> Result<BackgroundStatus, BackgroundCommandError> {
    refresh_attention(&manifest, &service.status)?;
    service.current()
}

#[tauri::command]
pub(crate) async fn refresh_background_monitor(
    service: tauri::State<'_, BackgroundService>,
) -> Result<BackgroundStatus, BackgroundCommandError> {
    let generation = service.request_refresh()?;
    let progress = Arc::clone(&service.refresh_progress);
    let status = Arc::clone(&service.status);
    tauri::async_runtime::spawn_blocking(move || wait_for_refresh(&progress, generation))
        .await
        .map_err(|error| {
            BackgroundCommandError::new(
                "backgroundRefreshFailed",
                format!("Nie udało się zaczekać na odświeżenie automatu: {error}"),
            )
        })??;
    current_status(&status)
}

#[tauri::command]
pub(crate) fn acknowledge_pending_source(
    path: PathBuf,
    app: tauri::AppHandle,
    service: tauri::State<'_, BackgroundService>,
) -> Result<BackgroundStatus, BackgroundCommandError> {
    service.acknowledge(&path);
    emit_status(&app, &service.status);
    service.current()
}

#[tauri::command]
pub(crate) fn start_source_workflow(
    path: PathBuf,
    app: tauri::AppHandle,
    background: tauri::State<'_, BackgroundService>,
    scans: tauri::State<'_, ScanService>,
    settings: tauri::State<'_, SettingsService>,
    manifest: tauri::State<'_, ImportManifest>,
) -> Result<crate::scan_jobs::MediaScanJob, BackgroundCommandError> {
    let volume = SystemSourceDiscovery
        .discover()
        .into_iter()
        .find(|volume| volume.mount_path == path)
        .ok_or_else(|| {
            BackgroundCommandError::new("sourceUnavailable", "Karta nie jest podłączona.")
        })?;
    background.acknowledge(&path);
    let _ = persist_volume_state(&app, &volume, SourceWorkflowState::Scanning, None);
    let job = start_media_scan_internal(path, app.clone(), &scans, &settings, &manifest)
        .map_err(|error| BackgroundCommandError::new(error.code, error.message))?;
    emit_status(&app, &background.status);
    Ok(job)
}

#[tauri::command]
pub(crate) fn ignore_source_until_disconnect(
    path: PathBuf,
    app: tauri::AppHandle,
    service: tauri::State<'_, BackgroundService>,
) -> Result<BackgroundStatus, BackgroundCommandError> {
    let volume = SystemSourceDiscovery
        .discover()
        .into_iter()
        .find(|volume| volume.mount_path == path)
        .ok_or_else(|| {
            BackgroundCommandError::new("sourceUnavailable", "Karta nie jest podłączona.")
        })?;
    service.acknowledge(&path);
    let _ = persist_volume_state(
        &app,
        &volume,
        SourceWorkflowState::IgnoredUntilDisconnect,
        None,
    );
    emit_status(&app, &service.status);
    service.current()
}

pub(crate) fn sync_autostart(app: &tauri::AppHandle, desired: bool) {
    let result = if desired {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    let actual = app.autolaunch().is_enabled().unwrap_or(false);
    let service = app.state::<BackgroundService>();
    service.update_autostart(actual, result.err().map(|error| error.to_string()));
    emit_status(app, &service.status);
}

pub(crate) fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let language = app
        .state::<SettingsService>()
        .current_settings()
        .map_or(importer_domain::settings::UiLanguage::En, |settings| {
            settings.local.ui_language
        });
    let show = MenuItem::with_id(
        app,
        "show",
        text(language, Nt::TrayShow),
        true,
        None::<&str>,
    )?;
    let refresh = MenuItem::with_id(
        app,
        "refresh",
        text(language, Nt::TrayRefresh),
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        text(language, Nt::TrayQuit),
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&show, &refresh, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip(text(language, Nt::TrayTooltip))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "refresh" => {
                let _ = app.state::<BackgroundService>().request_refresh();
            }
            "quit" => request_app_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    app.manage(TrayTextState {
        show,
        refresh,
        quit,
    });
    Ok(())
}

pub(crate) fn refresh_tray_text(app: &tauri::AppHandle) {
    let language = app_language(app);
    let state = app.state::<TrayTextState>();
    let _ = state.show.set_text(text(language, Nt::TrayShow));
    let _ = state.refresh.set_text(text(language, Nt::TrayRefresh));
    let _ = state.quit.set_text(text(language, Nt::TrayQuit));
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(text(language, Nt::TrayTooltip)));
    }
}

pub(crate) fn handle_close_request(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    if window.state::<ImportService>().has_running_sessions() {
        api.prevent_close();
        show_main_window(window.app_handle());
        notify(
            window.app_handle(),
            app_text(window.app_handle(), Nt::ImportStillRunning),
            app_text(window.app_handle(), Nt::CloseRunningImport),
        );
        return;
    }
    let minimize = window
        .state::<SettingsService>()
        .current_settings()
        .is_ok_and(|settings| settings.local.minimize_to_tray);
    if minimize {
        api.prevent_close();
        let _ = window.hide();
    } else {
        api.prevent_close();
        window.app_handle().exit(0);
    }
}

pub(crate) fn protect_running_import_on_exit(
    app: &tauri::AppHandle,
    api: &tauri::ExitRequestApi,
    code: Option<i32>,
) {
    if code.is_none() && app.state::<ImportService>().has_running_sessions() {
        api.prevent_exit();
        show_main_window(app);
        notify(
            app,
            app_text(app, Nt::ImportStillRunning),
            app_text(app, Nt::CloseRunningImport),
        );
    }
}

fn request_app_exit(app: &tauri::AppHandle) {
    if app.state::<ImportService>().has_running_sessions() {
        show_main_window(app);
        notify(
            app,
            app_text(app, Nt::ImportStillRunning),
            app_text(app, Nt::QuitRunningImport),
        );
    } else {
        app.exit(0);
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn announce_plan_ready(app: &tauri::AppHandle, file_count: usize) {
    let settings = app.state::<SettingsService>().current_settings().ok();
    let language = settings
        .as_ref()
        .map_or(importer_domain::settings::UiLanguage::En, |settings| {
            settings.local.ui_language
        });
    let detail = plan_file_count(language, file_count);
    if settings
        .as_ref()
        .is_none_or(|settings| settings.local.notifications_enabled)
    {
        notify(app, text(language, Nt::PlanReady), &detail);
    }
    if settings.is_some_and(|settings| settings.local.show_window_when_plan_ready) {
        show_main_window(app);
    }
}

pub(crate) fn announce_plan_ready_for_source(
    app: &tauri::AppHandle,
    source_path: &std::path::Path,
    file_count: usize,
) {
    let settings = app.state::<SettingsService>().current_settings().ok();
    let language = settings
        .as_ref()
        .map_or(importer_domain::settings::UiLanguage::En, |settings| {
            settings.local.ui_language
        });
    let detail = plan_file_count(language, file_count);
    if settings
        .as_ref()
        .is_none_or(|settings| settings.local.notifications_enabled)
    {
        notify_routed(
            app,
            text(language, Nt::PlanReady),
            &detail,
            Some(source_path.to_path_buf()),
        );
    }
    if settings.is_some_and(|settings| settings.local.show_window_when_plan_ready) {
        show_main_window(app);
    }
}

pub(crate) fn deliver_pending_notification_route(app: &tauri::AppHandle) {
    let route = app
        .state::<NotificationRouteState>()
        .0
        .lock()
        .ok()
        .and_then(|mut route| route.take());
    if let Some(route) = route {
        let _ = app.emit("notification-route", route);
    }
}

pub(crate) fn announce_profile_confirmation_required(
    app: &tauri::AppHandle,
    source_path: &std::path::Path,
) {
    notify_routed(
        app,
        app_text(app, Nt::CameraConfirmation),
        app_text(app, Nt::CameraConfirmationBody),
        Some(source_path.to_path_buf()),
    );
}

pub(crate) fn announce_workflow_error(app: &tauri::AppHandle, _technical_detail: &str) {
    notify(
        app,
        app_text(app, Nt::WorkflowFailed),
        app_text(app, Nt::WorkflowFailedBody),
    );
}

pub(crate) fn announce_import_status(
    app: &tauri::AppHandle,
    session: &importer_manifest::ImportSession,
) {
    let language = app_language(app);
    let (title, detail) = match session.status {
        ImportSessionStatus::Running => (
            text(language, Nt::ImportStarted),
            text(language, Nt::ImportStartedBody).to_owned(),
        ),
        ImportSessionStatus::Paused => (
            text(language, Nt::ImportPaused),
            text(language, Nt::ImportPausedBody).to_owned(),
        ),
        ImportSessionStatus::FailedRecoverable => (
            text(language, Nt::CardDisconnected),
            text(language, Nt::CardDisconnectedBody).to_owned(),
        ),
        ImportSessionStatus::Failed => (
            text(language, Nt::ImportFailed),
            text(language, Nt::ImportFailedBody).to_owned(),
        ),
        ImportSessionStatus::Completed => (
            text(language, Nt::ImportCompleted),
            imported_file_count(language, session.completed_file_count),
        ),
        ImportSessionStatus::RollingBack => (
            text(language, Nt::ImportRollingBack),
            text(language, Nt::ImportRollingBackBody).to_owned(),
        ),
        ImportSessionStatus::RollbackFailed => (
            text(language, Nt::RollbackNeedsAttention),
            text(language, Nt::RollbackNeedsAttentionBody).to_owned(),
        ),
        ImportSessionStatus::Cancelled => (
            text(language, Nt::ImportCancelled),
            text(language, Nt::ImportCancelledBody).to_owned(),
        ),
        ImportSessionStatus::Planned | ImportSessionStatus::Queued => return,
    };
    notify(app, title, &detail);
}

pub(crate) fn announce_import_started(app: &tauri::AppHandle) {
    notify(
        app,
        app_text(app, Nt::ImportStarted),
        app_text(app, Nt::ImportStartedBody),
    );
}

fn poll_sources(
    app: &tauri::AppHandle,
    status: &Arc<Mutex<BackgroundStatus>>,
    snapshot: &mut SourceSnapshot,
    scans: &mut HashMap<String, AutoScanContext>,
) {
    let settings = match app.state::<SettingsService>().current_settings() {
        Ok(settings) => settings,
        Err(error) => {
            update_status(status, |state| {
                state.last_checked_at_unix_ms = Some(now_unix_ms());
                state.last_error = Some(error.message().to_owned());
            });
            emit_status(app, status);
            return;
        }
    };
    let language = settings.local.ui_language;
    let volumes = SystemSourceDiscovery.discover();
    let connected_count = volumes
        .iter()
        .filter(|volume| resolve_connection(volume, &settings).is_some())
        .count();
    let changes = snapshot.update(volumes, &settings);

    update_status(status, |state| {
        state.last_checked_at_unix_ms = Some(now_unix_ms());
        state.connected_known_source_count = connected_count;
        state.last_error = None;
    });

    for change in changes {
        match change {
            MonitorChange::BecameKnown(connection) => {
                push_event(
                    status,
                    BackgroundEventKind::SourceConnected,
                    text(language, Nt::CardRemembered),
                    connection.profile_name,
                    Some(connection.volume.mount_path),
                    None,
                );
            }
            MonitorChange::UnknownConnected(volume) => {
                update_status(status, |state| {
                    if !state.pending_sources.iter().any(|source| {
                        source.fingerprint == volume.fingerprint
                            && source.source_path == volume.mount_path
                    }) {
                        state.pending_sources.push(PendingSource {
                            fingerprint: volume.fingerprint.clone(),
                            name: volume.name.clone(),
                            source_path: volume.mount_path.clone(),
                            state: SourceWorkflowState::AwaitingDecision,
                            probable_match: false,
                        });
                    }
                });
                push_event(
                    status,
                    BackgroundEventKind::SourceConnected,
                    text(language, Nt::NewCardDetected),
                    volume.name.clone(),
                    Some(volume.mount_path.clone()),
                    None,
                );
                notify(
                    app,
                    text(language, Nt::NewCardNotification),
                    text(language, Nt::NewCardNotificationBody),
                );
                let _ =
                    persist_volume_state(app, &volume, SourceWorkflowState::AwaitingDecision, None);
            }
            MonitorChange::Disconnected(volume) => {
                update_status(status, |state| {
                    state.pending_sources.retain(|source| {
                        source.fingerprint != volume.fingerprint
                            || source.source_path != volume.mount_path
                    });
                });
                let manifest = app.state::<ImportManifest>();
                let source_id = crate::sources::source_workflow_id(&volume);
                let existing = manifest.list_source_workflows().ok().and_then(|workflows| {
                    workflows
                        .into_iter()
                        .find(|workflow| workflow.source_id == source_id)
                });
                if crate::sources::volume_has_durable_identity(&volume)
                    && existing
                        .as_ref()
                        .is_some_and(|workflow| workflow.state == "planReady")
                {
                    let _ = manifest.update_source_workflow_state(
                        &source_id,
                        "disconnected",
                        Some(text(language, Nt::CardDisconnectedWorkflow)),
                        now_unix_ms(),
                    );
                } else if !crate::sources::volume_has_durable_identity(&volume)
                    || !existing
                        .as_ref()
                        .is_some_and(|workflow| workflow.state == "failedRecoverable")
                {
                    let _ = manifest.delete_pending_workflow(&source_id);
                }
                let _ = app.emit("source-workflows-invalidated", source_id);
                push_event(
                    status,
                    BackgroundEventKind::SourceDisconnected,
                    text(language, Nt::MediaDisconnected),
                    volume.name,
                    Some(volume.mount_path),
                    None,
                );
            }
            MonitorChange::Connected(connection) => {
                let path = connection.volume.mount_path.clone();
                let profile = connection.profile_name.clone();
                let source_id = crate::sources::source_workflow_id(&connection.volume);
                let restored_plan = crate::sources::volume_has_durable_identity(&connection.volume)
                    && app
                        .state::<ImportManifest>()
                        .list_source_workflows()
                        .ok()
                        .and_then(|workflows| {
                            workflows
                                .into_iter()
                                .find(|workflow| workflow.source_id == source_id)
                        })
                        .is_some_and(|workflow| workflow.state == "disconnected");
                let restored_action =
                    restored_plan.then(|| restored_workflow_action(connection.behavior));
                if restored_action == Some(RestoredWorkflowAction::PreservePlan) {
                    let _ = app
                        .state::<ImportManifest>()
                        .update_source_workflow_connection(
                            &source_id,
                            &path,
                            "planReady",
                            None,
                            now_unix_ms(),
                        );
                    let _ = app.emit("source-workflows-invalidated", source_id.clone());
                }
                push_event(
                    status,
                    BackgroundEventKind::SourceConnected,
                    text(language, Nt::KnownCardDetected),
                    format!("{} · {}", profile, path.display()),
                    Some(path.clone()),
                    None,
                );
                if crate::sources::volume_has_durable_identity(&connection.volume)
                    && settings.local.resume_after_restart == ResumeAfterRestart::Automatic
                    && let Ok(sessions) = app.state::<ImportManifest>().list_import_sessions()
                {
                    for session in sessions.into_iter().filter(|session| {
                        matches!(
                            session.status,
                            ImportSessionStatus::Paused | ImportSessionStatus::FailedRecoverable
                        ) && session_source_matches(session, &connection.volume)
                    }) {
                        match app
                            .state::<ImportManifest>()
                            .validate_and_relink_session_source(
                                &session.id,
                                &connection.volume.mount_path,
                            ) {
                            Ok(()) => {
                                let _ = app.state::<ImportService>().launch(
                                    session.id,
                                    app.clone(),
                                    usize::from(settings.local.max_concurrent_imports),
                                );
                            }
                            Err(error) => {
                                let _ = app.state::<ImportManifest>().mark_session_status(
                                    &session.id,
                                    ImportSessionStatus::FailedRecoverable,
                                    Some(&error.to_string()),
                                );
                            }
                        }
                    }
                }
                if let Some(action) = restored_action {
                    if action == RestoredWorkflowAction::RefreshForAutoImport {
                        if connection.volume.marker_uuid.is_some() {
                            start_automatic_scan(app, status, scans, path, profile, true);
                        } else {
                            let reason = "Automatyczny import wymaga identyfikatora UUID zapisanego na karcie.";
                            if let Err(error) = app
                                .state::<ImportManifest>()
                                .update_source_workflow_connection(
                                    &source_id,
                                    &path,
                                    "failedRecoverable",
                                    Some(reason),
                                    now_unix_ms(),
                                )
                            {
                                record_runtime_attention(
                                    status,
                                    source_id.clone(),
                                    path,
                                    profile,
                                    format!("{reason} Nie udało się zapisać alarmu: {error}"),
                                );
                            }
                            let _ = app.emit("source-workflows-invalidated", source_id);
                        }
                    }
                    continue;
                }
                match connection.behavior {
                    SourceBehavior::Ask => {
                        update_status(status, |state| {
                            if !state.pending_sources.iter().any(|source| {
                                source.fingerprint == connection.volume.fingerprint
                                    && source.source_path == connection.volume.mount_path
                            }) {
                                state.pending_sources.push(PendingSource {
                                    fingerprint: connection.volume.fingerprint.clone(),
                                    name: profile.clone(),
                                    source_path: path.clone(),
                                    state: SourceWorkflowState::AwaitingDecision,
                                    probable_match: connection.probable_match,
                                });
                            }
                        });
                        notify(
                            app,
                            text(language, Nt::CardDetected),
                            &card_ready(language, &profile),
                        );
                        let _ = persist_volume_state(
                            app,
                            &connection.volume,
                            SourceWorkflowState::AwaitingDecision,
                            None,
                        );
                    }
                    SourceBehavior::AutoPreparePlan => {
                        start_automatic_scan(app, status, scans, path, profile, false);
                    }
                    SourceBehavior::AutoImport => {
                        if connection.volume.marker_uuid.is_some() {
                            start_automatic_scan(app, status, scans, path, profile, true);
                        } else {
                            if let Err(error) = persist_volume_state(
                                app,
                                &connection.volume,
                                SourceWorkflowState::FailedRecoverable,
                                Some("Automatyczny import wymaga identyfikatora UUID zapisanego na karcie.".to_owned()),
                            ) {
                                record_runtime_attention(
                                    status,
                                    source_id,
                                    path,
                                    profile,
                                    format!("Automatyczny import wymaga identyfikatora UUID zapisanego na karcie. Nie udało się zapisać alarmu: {error}"),
                                );
                            }
                        }
                    }
                    SourceBehavior::Ignore => {}
                }
            }
        }
    }
    update_status(status, |state| {
        state.active_auto_scan_count = scans.len();
    });
    refresh_attention_best_effort(app);
    emit_status(app, status);
}

fn start_automatic_scan(
    app: &tauri::AppHandle,
    status: &Arc<Mutex<BackgroundStatus>>,
    scans: &mut HashMap<String, AutoScanContext>,
    source_path: PathBuf,
    profile_name: String,
    auto_import: bool,
) {
    let language = app_language(app);
    if let Some(volume) = SystemSourceDiscovery
        .discover()
        .into_iter()
        .find(|volume| volume.mount_path == source_path)
        && let Err(error) = persist_scanning_state(app, &volume)
    {
        record_runtime_attention(
            status,
            crate::sources::source_workflow_id(&volume),
            source_path.clone(),
            profile_name.clone(),
            format!("Nie udało się zapisać stanu automatycznego skanu: {error}"),
        );
    }
    let scan_service = app.state::<ScanService>();
    let settings = app.state::<SettingsService>();
    let manifest = app.state::<ImportManifest>();
    match start_media_scan_internal(
        source_path.clone(),
        app.clone(),
        &scan_service,
        &settings,
        &manifest,
    ) {
        Ok(job) => {
            let scan_id = job.id().to_owned();
            let registered = register_auto_scan(
                scans,
                scan_id.clone(),
                AutoScanContext {
                    profile_name: profile_name.clone(),
                    source_path: source_path.clone(),
                    auto_import,
                },
            );
            if registered {
                push_event(
                    status,
                    BackgroundEventKind::ScanStarted,
                    text(language, Nt::AutoScanStarted),
                    profile_name,
                    Some(source_path),
                    Some(scan_id),
                );
            }
        }
        Err(error) => {
            persist_automatic_failure(app, status, &source_path, &profile_name, &error.message);
            push_event(
                status,
                BackgroundEventKind::ScanFailed,
                text(language, Nt::AutoScanStartFailed),
                text(language, Nt::ScanProblemBody),
                Some(source_path),
                None,
            );
        }
    }
}

fn register_auto_scan(
    scans: &mut HashMap<String, AutoScanContext>,
    scan_id: String,
    context: AutoScanContext,
) -> bool {
    match scans.entry(scan_id) {
        std::collections::hash_map::Entry::Vacant(entry) => {
            entry.insert(context);
            true
        }
        std::collections::hash_map::Entry::Occupied(mut entry) => {
            entry.get_mut().auto_import |= context.auto_import;
            false
        }
    }
}

fn persist_scanning_state(
    app: &tauri::AppHandle,
    volume: &importer_media::SourceVolume,
) -> Result<(), String> {
    let source_id = crate::sources::source_workflow_id(volume);
    let manifest = app.state::<ImportManifest>();
    let existing = manifest
        .list_source_workflows()
        .map_err(|error| error.to_string())?
        .into_iter()
        .any(|workflow| workflow.source_id == source_id);
    if existing {
        manifest
            .update_source_workflow_connection(
                &source_id,
                &volume.mount_path,
                "scanning",
                None,
                now_unix_ms(),
            )
            .map_err(|error| error.to_string())?;
        app.emit("source-workflows-invalidated", source_id)
            .map_err(|error| error.to_string())
    } else {
        persist_volume_state(app, volume, SourceWorkflowState::Scanning, None)
    }
}

fn finish_auto_scans(
    app: &tauri::AppHandle,
    status: &Arc<Mutex<BackgroundStatus>>,
    scans: &mut HashMap<String, AutoScanContext>,
) {
    let language = app_language(app);
    let scan_service = app.state::<ScanService>();
    let finished: Vec<_> = scans
        .keys()
        .filter_map(|id| {
            let job = scan_service.get(id)?;
            (job.status() != MediaScanJobStatus::Running).then_some((id.clone(), job))
        })
        .collect();

    let had_finished = !finished.is_empty();
    for (id, job) in finished {
        let Some(context) = scans.remove(&id) else {
            continue;
        };
        match job.status() {
            MediaScanJobStatus::Completed => {
                let count = job.imported_candidate_count().unwrap_or(0);
                let detail = scan_result(language, &context.profile_name, count);
                push_event(
                    status,
                    BackgroundEventKind::ScanCompleted,
                    text(language, Nt::AutoScanCompleted),
                    detail,
                    Some(context.source_path.clone()),
                    Some(id),
                );
                if context.auto_import {
                    start_automatic_import(app, &context.source_path, job.result());
                }
            }
            MediaScanJobStatus::Failed | MediaScanJobStatus::Cancelled => {
                let detail = if job.status() == MediaScanJobStatus::Cancelled {
                    text(language, Nt::ScanCancelled)
                } else {
                    text(language, Nt::ScanProblemBody)
                }
                .to_owned();
                push_event(
                    status,
                    BackgroundEventKind::ScanFailed,
                    text(language, Nt::AutoScanIncomplete),
                    detail.clone(),
                    Some(context.source_path.clone()),
                    Some(id),
                );
                if job.status() == MediaScanJobStatus::Failed {
                    persist_automatic_failure(
                        app,
                        status,
                        &context.source_path,
                        &context.profile_name,
                        &detail,
                    );
                }
                notify(
                    app,
                    text(language, Nt::ScanProblem),
                    text(language, Nt::ScanProblemBody),
                );
            }
            MediaScanJobStatus::Running => {}
        }
    }
    if !scans.is_empty() || had_finished {
        update_status(status, |state| {
            state.active_auto_scan_count = scans.len();
        });
        emit_status(app, status);
    }
}

fn start_automatic_import(
    app: &tauri::AppHandle,
    source_path: &std::path::Path,
    scan: Option<&crate::sources::SourceScanResponse>,
) {
    let Some(volume) = SystemSourceDiscovery
        .discover()
        .into_iter()
        .find(|volume| volume.mount_path == source_path)
    else {
        let status = &app.state::<BackgroundService>().status;
        record_runtime_attention(
            status,
            source_path.to_string_lossy().into_owned(),
            source_path.to_path_buf(),
            source_path.display().to_string(),
            "Automatyczny import nie został uruchomiony, ponieważ źródło przestało być dostępne. Nie udało się zapisać alarmu bez tożsamości źródła.".to_owned(),
        );
        emit_status(app, status);
        return;
    };
    let source_id = crate::sources::source_workflow_id(&volume);
    let manifest = app.state::<ImportManifest>();
    let record = match manifest.list_source_workflows() {
        Ok(records) => records
            .into_iter()
            .find(|record| record.source_id == source_id),
        Err(error) => {
            record_runtime_attention(
                &app.state::<BackgroundService>().status,
                source_id,
                source_path.to_path_buf(),
                volume.name,
                format!(
                    "Automatyczny import nie został uruchomiony, bo nie udało się odczytać workflow. Nie udało się zapisać alarmu: {error}"
                ),
            );
            emit_status(app, &app.state::<BackgroundService>().status);
            return;
        }
    };
    let Some(record) = record else {
        persist_automatic_failure(
            app,
            &app.state::<BackgroundService>().status,
            source_path,
            &volume.name,
            "Automatyczny import nie został uruchomiony, ponieważ nie znaleziono przygotowanego workflow.",
        );
        return;
    };
    let plan = serde_json::from_str::<Option<ImportPlan>>(&record.plan_json)
        .ok()
        .flatten();
    let settings_service = app.state::<SettingsService>();
    let settings = settings_service.current_settings().ok();
    let blocking_reason = automatic_import_blocking_reason(AutomaticImportGates {
        has_marker_uuid: volume.marker_uuid.is_some(),
        settings_are_current: settings.as_ref().is_some_and(|settings| {
            record.settings_revision == crate::sources::import_plan_settings_revision(settings)
        }),
        operation_is_copy: settings.as_ref().is_some_and(|settings| {
            settings.portable.import.default_operation == ImportOperation::Copy
        }),
        workflow_is_ready: record.state == "planReady",
        plan_is_ready: plan.as_ref().is_some_and(|plan| {
            plan.status == ImportPlanStatus::Ready
                && plan.conflicts.is_empty()
                && plan.file_count > 0
        }),
        has_fresh_scan: scan.is_some(),
    });
    if let Some(reason) = blocking_reason {
        if let Err(error) = manifest.update_source_workflow_state(
            &source_id,
            "failedRecoverable",
            Some(reason),
            now_unix_ms(),
        ) {
            record_runtime_attention(
                &app.state::<BackgroundService>().status,
                source_id.clone(),
                source_path.to_path_buf(),
                record.display_name.clone(),
                format!("{reason} Nie udało się zapisać alarmu: {error}"),
            );
        }
        let _ = app.emit("source-workflows-invalidated", source_id);
        refresh_attention_best_effort(app);
        return;
    }
    let Some(plan) = plan else { return };
    let service = app.state::<ImportService>();
    let session = create_import_session_internal(
        CreateSessionRequest {
            plan,
            source_fingerprint: Some(volume.fingerprint.clone()),
            source_identity: Some(SessionSourceIdentity {
                marker_uuid: volume.marker_uuid,
                platform_volume_id: volume.platform_volume_id.clone(),
                fallback_fingerprint: volume.fingerprint.clone(),
            }),
            confirm_move: false,
        },
        &settings_service,
        &service,
    );
    match session {
        Ok(session) => {
            let max_concurrent = settings.map_or(1, |settings| {
                usize::from(settings.local.max_concurrent_imports)
            });
            match service.launch(session.id.clone(), app.clone(), max_concurrent) {
                Ok(()) => {
                    if let Err(error) = manifest.delete_pending_workflow(&source_id) {
                        record_runtime_attention(
                            &app.state::<BackgroundService>().status,
                            source_id.clone(),
                            source_path.to_path_buf(),
                            record.display_name.clone(),
                            format!(
                                "Import uruchomiono, ale nie udało się zamknąć workflow: {error}"
                            ),
                        );
                    }
                    let _ = app.emit("source-workflows-invalidated", source_id);
                }
                Err(error) => persist_automatic_failure(
                    app,
                    &app.state::<BackgroundService>().status,
                    source_path,
                    &record.display_name,
                    &error.message,
                ),
            }
            refresh_attention_best_effort(app);
        }
        Err(error) => {
            if let Err(save_error) = manifest.update_source_workflow_state(
                &source_id,
                "failedRecoverable",
                Some(&error.message),
                now_unix_ms(),
            ) {
                record_runtime_attention(
                    &app.state::<BackgroundService>().status,
                    source_id.clone(),
                    source_path.to_path_buf(),
                    record.display_name,
                    format!(
                        "{} Nie udało się zapisać alarmu: {save_error}",
                        error.message
                    ),
                );
            }
            let _ = app.emit("source-workflows-invalidated", source_id);
            refresh_attention_best_effort(app);
        }
    }
}

fn persist_volume_state(
    app: &tauri::AppHandle,
    volume: &importer_media::SourceVolume,
    state: SourceWorkflowState,
    error: Option<String>,
) -> Result<(), String> {
    let workflow = PendingSourceWorkflow {
        source_id: crate::sources::source_workflow_id(volume),
        source_root: volume.mount_path.clone(),
        source_identity: Some(SourceIdentity {
            marker_uuid: volume.marker_uuid,
            platform_volume_id: volume.platform_volume_id.clone(),
            fallback_fingerprint: volume.fingerprint.clone(),
        }),
        display_name: volume.name.clone(),
        state,
        scan: None,
        plan: None,
        settings_schema_version: app
            .state::<SettingsService>()
            .current_settings()
            .map_or(0, |settings| settings.schema_version),
        settings_revision: app
            .state::<SettingsService>()
            .current_settings()
            .ok()
            .map(|settings| crate::sources::import_plan_settings_revision(&settings))
            .unwrap_or_default(),
        editor: crate::sources::WorkflowEditorState::default(),
        error,
        updated_at_unix_ms: now_unix_ms(),
    };
    persist_workflow(&app.state::<ImportManifest>(), &workflow).map_err(|error| error.message)?;
    app.emit("source-workflow-changed", workflow)
        .map_err(|error| error.to_string())
}

fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    if app
        .state::<SettingsService>()
        .current_settings()
        .is_ok_and(|settings| !settings.local.notifications_enabled)
    {
        return;
    }
    notify_routed(app, title, body, None);
}

fn notify_routed(app: &tauri::AppHandle, title: &str, body: &str, source_path: Option<PathBuf>) {
    if let Ok(mut route) = app.state::<NotificationRouteState>().0.lock() {
        *route = Some(NotificationRoute {
            view: "home",
            source_path,
        });
    }
    let _ = app.notification().builder().title(title).body(body).show();
}

fn push_event(
    status: &Arc<Mutex<BackgroundStatus>>,
    kind: BackgroundEventKind,
    title: impl Into<String>,
    detail: impl Into<String>,
    source_path: Option<PathBuf>,
    scan_id: Option<String>,
) {
    update_status(status, |state| {
        let mut events: VecDeque<_> = state.events.drain(..).collect();
        let id = events.front().map_or(1, |event| event.id.saturating_add(1));
        events.push_front(BackgroundEvent {
            id,
            occurred_at_unix_ms: now_unix_ms(),
            kind,
            title: title.into(),
            detail: detail.into(),
            source_path,
            scan_id,
        });
        events.truncate(MAX_EVENTS);
        state.events = events.into();
    });
}

fn attention_from_workflows(records: Vec<SourceWorkflowRecord>) -> Vec<BackgroundAttention> {
    let mut attention = records
        .into_iter()
        .filter(|record| record.state == "failedRecoverable")
        .map(|record| BackgroundAttention {
            source_id: record.source_id,
            source_path: record.source_root,
            display_name: record.display_name,
            detail: record
                .error
                .unwrap_or_else(|| "Automatyczne działanie nie zostało ukończone.".to_owned()),
        })
        .collect::<Vec<_>>();
    attention.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    attention
}

fn refresh_attention(
    manifest: &ImportManifest,
    status: &Arc<Mutex<BackgroundStatus>>,
) -> Result<(), BackgroundCommandError> {
    let mut attention =
        attention_from_workflows(manifest.list_source_workflows().map_err(|error| {
            BackgroundCommandError::new(
                "backgroundAttentionUnavailable",
                format!("Nie udało się odczytać workflow wymagających uwagi: {error}"),
            )
        })?);
    update_status(status, |state| {
        for runtime in state.attention_required.iter().filter(|item| {
            item.detail.contains("Nie udało się zapisać alarmu")
                || item.detail.contains("nie udało się zamknąć workflow")
                || item.detail.contains("Nie udało się zapisać stanu")
        }) {
            if !attention
                .iter()
                .any(|item| item.source_id == runtime.source_id)
            {
                attention.push(runtime.clone());
            }
        }
        state.attention_required = attention;
    });
    Ok(())
}

pub(crate) fn refresh_attention_best_effort(app: &tauri::AppHandle) {
    let service = app.state::<BackgroundService>();
    if let Err(error) = refresh_attention(&app.state::<ImportManifest>(), &service.status) {
        update_status(&service.status, |state| {
            state.last_error = Some(error.message);
        });
    }
    emit_status(app, &service.status);
}

fn record_runtime_attention(
    status: &Arc<Mutex<BackgroundStatus>>,
    source_id: String,
    source_path: PathBuf,
    display_name: String,
    detail: String,
) {
    update_status(status, |state| {
        state
            .attention_required
            .retain(|attention| attention.source_id != source_id);
        state.attention_required.push(BackgroundAttention {
            source_id,
            source_path,
            display_name,
            detail,
        });
    });
}

fn persist_automatic_failure(
    app: &tauri::AppHandle,
    status: &Arc<Mutex<BackgroundStatus>>,
    source_path: &std::path::Path,
    display_name: &str,
    detail: &str,
) {
    let volume = SystemSourceDiscovery
        .discover()
        .into_iter()
        .find(|volume| volume.mount_path == source_path);
    let source_id = volume.as_ref().map_or_else(
        || source_path.to_string_lossy().into_owned(),
        crate::sources::source_workflow_id,
    );
    let manifest = app.state::<ImportManifest>();
    let save_result = manifest
        .list_source_workflows()
        .map_err(|error| error.to_string())
        .and_then(|records| {
            if records.iter().any(|record| record.source_id == source_id) {
                manifest
                    .update_source_workflow_state(
                        &source_id,
                        "failedRecoverable",
                        Some(detail),
                        now_unix_ms(),
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            } else if let Some(volume) = volume.as_ref() {
                persist_volume_state(
                    app,
                    volume,
                    SourceWorkflowState::FailedRecoverable,
                    Some(detail.to_owned()),
                )
            } else {
                Err("źródło nie jest już dostępne".to_owned())
            }
        });
    if let Err(error) = save_result {
        record_runtime_attention(
            status,
            source_id.clone(),
            source_path.to_path_buf(),
            display_name.to_owned(),
            format!("{detail} Nie udało się zapisać alarmu: {error}"),
        );
    }
    let _ = app.emit("source-workflows-invalidated", source_id);
    refresh_attention_best_effort(app);
}

fn update_status(
    status: &Arc<Mutex<BackgroundStatus>>,
    update: impl FnOnce(&mut BackgroundStatus),
) {
    if let Ok(mut state) = status.lock() {
        update(&mut state);
    }
}

fn current_status(
    status: &Arc<Mutex<BackgroundStatus>>,
) -> Result<BackgroundStatus, BackgroundCommandError> {
    status.lock().map(|status| status.clone()).map_err(|_| {
        BackgroundCommandError::new(
            "backgroundStateUnavailable",
            "Stan automatu jest niedostępny.",
        )
    })
}

fn take_refresh_generation(
    requested: &AtomicBool,
    progress: &Arc<(Mutex<RefreshProgress>, Condvar)>,
) -> Option<u64> {
    if !requested.swap(false, Ordering::Relaxed) {
        return None;
    }
    progress
        .0
        .lock()
        .ok()
        .map(|progress| progress.requested_generation)
}

fn complete_refresh(progress: &Arc<(Mutex<RefreshProgress>, Condvar)>, generation: u64) {
    let (state, completed) = &**progress;
    if let Ok(mut state) = state.lock() {
        state.completed_generation = state.completed_generation.max(generation);
        completed.notify_all();
    }
}

fn wait_for_refresh(
    progress: &Arc<(Mutex<RefreshProgress>, Condvar)>,
    generation: u64,
) -> Result<(), BackgroundCommandError> {
    let (state, completed) = &**progress;
    let mut state = state.lock().map_err(|_| {
        BackgroundCommandError::new(
            "backgroundStateUnavailable",
            "Stan automatu jest niedostępny.",
        )
    })?;
    while state.completed_generation < generation {
        state = completed.wait(state).map_err(|_| {
            BackgroundCommandError::new(
                "backgroundStateUnavailable",
                "Stan automatu jest niedostępny.",
            )
        })?;
    }
    Ok(())
}

fn emit_status(app: &tauri::AppHandle, status: &Arc<Mutex<BackgroundStatus>>) {
    if let Ok(state) = status.lock() {
        let _ = app.emit("background-status", state.clone());
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
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn service_starts_with_refresh_requested_and_safe_empty_status() {
        let service = BackgroundService::default();

        assert!(service.refresh_requested.swap(false, Ordering::Relaxed));
        let status = service.current().expect("status should be available");
        assert!(status.running);
        assert_eq!(status.connected_known_source_count, 0);
        assert_eq!(status.active_auto_scan_count, 0);
        assert!(status.events.is_empty());
        assert!(status.attention_required.is_empty());

        service
            .request_refresh()
            .expect("refresh should be requested");
        assert!(service.refresh_requested.load(Ordering::Relaxed));
    }

    #[test]
    fn restored_auto_import_refreshes_while_other_behaviors_preserve_the_plan() {
        assert_eq!(
            restored_workflow_action(SourceBehavior::AutoImport),
            RestoredWorkflowAction::RefreshForAutoImport
        );
        for behavior in [
            SourceBehavior::Ask,
            SourceBehavior::AutoPreparePlan,
            SourceBehavior::Ignore,
        ] {
            assert_eq!(
                restored_workflow_action(behavior),
                RestoredWorkflowAction::PreservePlan
            );
        }
    }

    #[test]
    fn automatic_import_requires_every_safety_gate() {
        let safe = AutomaticImportGates {
            has_marker_uuid: true,
            settings_are_current: true,
            operation_is_copy: true,
            workflow_is_ready: true,
            plan_is_ready: true,
            has_fresh_scan: true,
        };
        assert_eq!(automatic_import_blocking_reason(safe), None);

        for unsafe_gates in [
            AutomaticImportGates {
                has_marker_uuid: false,
                ..safe
            },
            AutomaticImportGates {
                settings_are_current: false,
                ..safe
            },
            AutomaticImportGates {
                operation_is_copy: false,
                ..safe
            },
            AutomaticImportGates {
                workflow_is_ready: false,
                ..safe
            },
            AutomaticImportGates {
                plan_is_ready: false,
                ..safe
            },
            AutomaticImportGates {
                has_fresh_scan: false,
                ..safe
            },
        ] {
            assert!(automatic_import_blocking_reason(unsafe_gates).is_some());
        }
    }

    #[test]
    fn reconnect_registers_one_scan_and_upgrades_it_to_auto_import() {
        let mut scans = HashMap::new();
        let context = |auto_import| AutoScanContext {
            profile_name: "Camera".to_owned(),
            source_path: PathBuf::from("E:/"),
            auto_import,
        };

        assert!(register_auto_scan(
            &mut scans,
            "same-scan".to_owned(),
            context(false)
        ));
        assert!(!register_auto_scan(
            &mut scans,
            "same-scan".to_owned(),
            context(true)
        ));

        assert_eq!(scans.len(), 1);
        assert!(scans["same-scan"].auto_import);
    }

    #[test]
    fn manual_refresh_waits_for_the_requested_monitoring_cycle() {
        let service = BackgroundService::default();
        let initial_generation =
            take_refresh_generation(&service.refresh_requested, &service.refresh_progress)
                .expect("initial refresh should be pending");
        complete_refresh(&service.refresh_progress, initial_generation);

        let requested_generation = service
            .request_refresh()
            .expect("manual refresh should be requested");
        let claimed_generation =
            take_refresh_generation(&service.refresh_requested, &service.refresh_progress)
                .expect("manual refresh should be claimed");
        assert_eq!(claimed_generation, requested_generation);

        let progress = Arc::clone(&service.refresh_progress);
        let (finished_tx, finished_rx) = mpsc::channel();
        let waiter = std::thread::spawn(move || {
            wait_for_refresh(&progress, requested_generation)
                .expect("waiting for refresh should succeed");
            finished_tx.send(()).expect("result should be observed");
        });

        assert!(finished_rx.try_recv().is_err());
        complete_refresh(&service.refresh_progress, claimed_generation);
        finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("waiter should finish after the cycle completes");
        waiter.join().expect("waiter should not panic");
    }

    #[test]
    fn event_history_is_newest_first_monotonic_and_bounded() {
        let service = BackgroundService::default();
        for index in 0..(MAX_EVENTS + 5) {
            push_event(
                &service.status,
                BackgroundEventKind::SourceConnected,
                format!("event-{index}"),
                "details",
                Some(PathBuf::from(format!("source-{index}"))),
                None,
            );
        }

        let status = service.current().expect("status should be available");
        assert_eq!(status.events.len(), MAX_EVENTS);
        assert_eq!(status.events[0].id, (MAX_EVENTS + 5) as u64);
        assert_eq!(status.events[0].title, format!("event-{}", MAX_EVENTS + 4));
        assert_eq!(status.events[MAX_EVENTS - 1].id, 6);
        assert!(status.events.windows(2).all(|pair| pair[0].id > pair[1].id));
    }

    #[test]
    fn only_recoverable_workflow_failures_become_durable_attention() {
        let record = |source_id: &str, state: &str, error: Option<&str>| SourceWorkflowRecord {
            source_id: source_id.to_owned(),
            source_root: PathBuf::from(format!("{source_id}-root")),
            state: state.to_owned(),
            source_identity_json: None,
            display_name: format!("Card {source_id}"),
            scan_json: "null".to_owned(),
            plan_json: "null".to_owned(),
            settings_schema_version: 1,
            settings_revision: "revision".to_owned(),
            editor_json: "{}".to_owned(),
            error: error.map(str::to_owned),
            updated_at_unix_ms: 1,
        };

        let attention = attention_from_workflows(vec![
            record("failed", "failedRecoverable", Some("scan failed")),
            record("cancelled", "scanning", Some("user cancelled")),
            record("ready", "planReady", None),
        ]);

        assert_eq!(attention.len(), 1);
        assert_eq!(attention[0].source_id, "failed");
        assert_eq!(attention[0].detail, "scan failed");
    }

    #[test]
    fn attention_is_restored_from_manifest_and_cleared_with_workflow() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3"))
            .expect("manifest should open");
        manifest
            .save_source_workflow(&SourceWorkflowRecord {
                source_id: "marker:card-29".to_owned(),
                source_root: PathBuf::from("E:\\"),
                state: "failedRecoverable".to_owned(),
                source_identity_json: None,
                display_name: "Card 29".to_owned(),
                scan_json: "null".to_owned(),
                plan_json: "null".to_owned(),
                settings_schema_version: 1,
                settings_revision: "revision".to_owned(),
                editor_json: "{}".to_owned(),
                error: Some("automatic import failed".to_owned()),
                updated_at_unix_ms: 1,
            })
            .expect("failed workflow should persist");
        let service = BackgroundService::default();

        refresh_attention(&manifest, &service.status)
            .expect("attention should be restored from manifest");
        let restored = service.current().expect("status should be readable");
        assert_eq!(restored.attention_required.len(), 1);
        assert_eq!(restored.attention_required[0].source_id, "marker:card-29");

        manifest
            .delete_pending_workflow("marker:card-29")
            .expect("workflow should be removable");
        refresh_attention(&manifest, &service.status)
            .expect("attention should refresh after workflow removal");
        assert!(
            service
                .current()
                .expect("status should be readable")
                .attention_required
                .is_empty()
        );
    }
}
