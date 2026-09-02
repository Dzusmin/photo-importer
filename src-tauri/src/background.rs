use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use importer_background::{MonitorChange, SourceSnapshot, resolve_connection};
use importer_domain::settings::{ResumeAfterRestart, SourceBehavior, SourceIdentity};
use importer_manifest::{ImportManifest, ImportSessionStatus};
use importer_media::{SourceDiscovery, SystemSourceDiscovery};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

use crate::imports::{ImportService, session_source_matches};
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
}

#[derive(Debug)]
pub(crate) struct BackgroundService {
    status: Arc<Mutex<BackgroundStatus>>,
    refresh_requested: Arc<AtomicBool>,
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
            })),
            refresh_requested: Arc::new(AtomicBool::new(true)),
        }
    }
}

impl BackgroundService {
    pub(crate) fn start(&self, app: tauri::AppHandle) {
        let status = Arc::clone(&self.status);
        let refresh_requested = Arc::clone(&self.refresh_requested);
        tauri::async_runtime::spawn_blocking(move || {
            let mut snapshot = SourceSnapshot::default();
            let mut scans = HashMap::<String, AutoScanContext>::new();
            let mut last_poll = Instant::now() - POLL_INTERVAL;

            loop {
                if refresh_requested.swap(false, Ordering::Relaxed)
                    || last_poll.elapsed() >= POLL_INTERVAL
                {
                    poll_sources(&app, &status, &mut snapshot, &mut scans);
                    last_poll = Instant::now();
                }
                finish_auto_scans(&app, &status, &mut scans);
                std::thread::sleep(IDLE_TICK);
            }
        });
    }

    pub(crate) fn request_refresh(&self) {
        self.refresh_requested.store(true, Ordering::Relaxed);
    }

    fn current(&self) -> Result<BackgroundStatus, BackgroundCommandError> {
        self.status
            .lock()
            .map(|status| status.clone())
            .map_err(|_| {
                BackgroundCommandError::new(
                    "backgroundStateUnavailable",
                    "Stan automatu jest niedostępny.",
                )
            })
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
}

impl BackgroundCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[tauri::command]
pub(crate) fn get_background_status(
    service: tauri::State<'_, BackgroundService>,
) -> Result<BackgroundStatus, BackgroundCommandError> {
    service.current()
}

#[tauri::command]
pub(crate) fn refresh_background_monitor(
    service: tauri::State<'_, BackgroundService>,
) -> Result<BackgroundStatus, BackgroundCommandError> {
    service.request_refresh();
    service.current()
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
    persist_volume_state(&app, &volume, SourceWorkflowState::Scanning, None);
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
    persist_volume_state(
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
    let show = MenuItem::with_id(app, "show", "Pokaż Photo Importer", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Sprawdź nośniki teraz", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Zakończ", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &refresh, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Photo Importer — monitor nośników działa")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "refresh" => app.state::<BackgroundService>().request_refresh(),
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
    Ok(())
}

pub(crate) fn handle_close_request(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    if window.state::<ImportService>().has_running_sessions() {
        api.prevent_close();
        show_main_window(window.app_handle());
        notify(
            window.app_handle(),
            "Import nadal trwa",
            "Najpierw wstrzymaj lub anuluj import, a następnie zamknij aplikację.",
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
            "Import nadal trwa",
            "Najpierw wstrzymaj lub anuluj import, a następnie zamknij aplikację.",
        );
    }
}

fn request_app_exit(app: &tauri::AppHandle) {
    if app.state::<ImportService>().has_running_sessions() {
        show_main_window(app);
        notify(
            app,
            "Import nadal trwa",
            "Najpierw wstrzymaj lub anuluj import, a następnie zakończ aplikację.",
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

pub(crate) fn announce_plan_ready(app: &tauri::AppHandle, detail: &str) {
    let settings = app.state::<SettingsService>().current_settings().ok();
    if settings
        .as_ref()
        .is_none_or(|settings| settings.local.notifications_enabled)
    {
        notify(app, "Plan importu jest gotowy", detail);
    }
    if settings.is_some_and(|settings| settings.local.show_window_when_plan_ready) {
        show_main_window(app);
    }
}

pub(crate) fn announce_plan_ready_for_source(
    app: &tauri::AppHandle,
    source_path: &std::path::Path,
    detail: &str,
) {
    let settings = app.state::<SettingsService>().current_settings().ok();
    if settings
        .as_ref()
        .is_none_or(|settings| settings.local.notifications_enabled)
    {
        notify_routed(
            app,
            "Plan importu jest gotowy",
            detail,
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
        "Wymagane potwierdzenie aparatu",
        "Na karcie wykryto nowy profil EXIF. Otwórz aplikację, aby go zatwierdzić.",
        Some(source_path.to_path_buf()),
    );
}

pub(crate) fn announce_workflow_error(app: &tauri::AppHandle, detail: &str) {
    notify(app, "Nie udało się przygotować planu", detail);
}

pub(crate) fn announce_import_status(
    app: &tauri::AppHandle,
    session: &importer_manifest::ImportSession,
) {
    let (title, detail) = match session.status {
        ImportSessionStatus::Running => ("Import rozpoczęty", "Import działa w tle.".to_owned()),
        ImportSessionStatus::Paused => (
            "Import wstrzymany",
            "Sesję można bezpiecznie wznowić.".to_owned(),
        ),
        ImportSessionStatus::FailedRecoverable => (
            "Karta została odłączona",
            session
                .last_error
                .clone()
                .unwrap_or_else(|| "Podłącz właściwą kartę i wybierz Wznów.".to_owned()),
        ),
        ImportSessionStatus::Failed => (
            "Błąd importu",
            session
                .last_error
                .clone()
                .unwrap_or_else(|| "Import nie został ukończony.".to_owned()),
        ),
        ImportSessionStatus::Completed => (
            "Import zakończony",
            format!("Zaimportowano {} plików.", session.completed_file_count),
        ),
        ImportSessionStatus::RollingBack => (
            "Wycofywanie importu",
            "Usuwane są wyłącznie niezmienione pliki tej sesji.".to_owned(),
        ),
        ImportSessionStatus::RollbackFailed => (
            "Wycofanie wymaga uwagi",
            session
                .last_error
                .clone()
                .unwrap_or_else(|| "Wycofanie można ponowić.".to_owned()),
        ),
        ImportSessionStatus::Cancelled => (
            "Import anulowany",
            "Zakończono wycofanie lub zachowano ukończone pliki.".to_owned(),
        ),
        ImportSessionStatus::Planned | ImportSessionStatus::Queued => return,
    };
    notify(app, title, &detail);
}

pub(crate) fn announce_import_started(app: &tauri::AppHandle) {
    notify(app, "Import rozpoczęty", "Import działa w tle.");
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
                    "Karta została zapamiętana",
                    connection.profile_name,
                    Some(connection.volume.mount_path),
                    None,
                );
            }
            MonitorChange::UnknownConnected(volume) => {
                update_status(status, |state| {
                    if !state
                        .pending_sources
                        .iter()
                        .any(|source| source.fingerprint == volume.fingerprint)
                    {
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
                    "Wykryto nową kartę",
                    volume.name.clone(),
                    Some(volume.mount_path.clone()),
                    None,
                );
                notify(
                    app,
                    "Wykryto nową kartę pamięci",
                    "Otwórz aplikację, aby przeskanować kartę i zatwierdzić aparat z EXIF.",
                );
                persist_volume_state(app, &volume, SourceWorkflowState::AwaitingDecision, None);
            }
            MonitorChange::Disconnected(volume) => {
                update_status(status, |state| {
                    state
                        .pending_sources
                        .retain(|source| source.fingerprint != volume.fingerprint);
                });
                let manifest = app.state::<ImportManifest>();
                let existing = manifest.list_source_workflows().ok().and_then(|workflows| {
                    workflows
                        .into_iter()
                        .find(|workflow| workflow.source_root == volume.mount_path)
                });
                if existing
                    .as_ref()
                    .is_some_and(|workflow| workflow.state == "planReady")
                {
                    let _ = manifest.update_source_workflow_state(
                        &volume.mount_path,
                        "disconnected",
                        Some("Karta została odłączona. Podłącz ją ponownie, aby rozpocząć import."),
                        now_unix_ms(),
                    );
                } else {
                    let _ = manifest.delete_pending_workflow(&volume.mount_path);
                }
                push_event(
                    status,
                    BackgroundEventKind::SourceDisconnected,
                    "Odłączono nośnik",
                    volume.name,
                    Some(volume.mount_path),
                    None,
                );
            }
            MonitorChange::Connected(connection) => {
                let path = connection.volume.mount_path.clone();
                let profile = connection.profile_name.clone();
                push_event(
                    status,
                    BackgroundEventKind::SourceConnected,
                    "Wykryto znaną kartę",
                    format!("{} · {}", profile, path.display()),
                    Some(path.clone()),
                    None,
                );
                if settings.local.resume_after_restart == ResumeAfterRestart::Automatic
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
                match connection.behavior {
                    SourceBehavior::Ask => {
                        update_status(status, |state| {
                            if !state
                                .pending_sources
                                .iter()
                                .any(|source| source.fingerprint == connection.volume.fingerprint)
                            {
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
                            "Wykryto kartę pamięci",
                            &format!(
                                "{profile} jest gotowy. Otwórz aplikację, aby rozpocząć skan."
                            ),
                        );
                        persist_volume_state(
                            app,
                            &connection.volume,
                            SourceWorkflowState::AwaitingDecision,
                            None,
                        );
                    }
                    SourceBehavior::AutoPreparePlan => {
                        start_automatic_scan(app, status, scans, path, profile);
                    }
                    SourceBehavior::Ignore => {}
                }
            }
        }
    }
    update_status(status, |state| {
        state.active_auto_scan_count = scans.len();
    });
    emit_status(app, status);
}

fn start_automatic_scan(
    app: &tauri::AppHandle,
    status: &Arc<Mutex<BackgroundStatus>>,
    scans: &mut HashMap<String, AutoScanContext>,
    source_path: PathBuf,
    profile_name: String,
) {
    if let Some(volume) = SystemSourceDiscovery
        .discover()
        .into_iter()
        .find(|volume| volume.mount_path == source_path)
    {
        persist_volume_state(app, &volume, SourceWorkflowState::Scanning, None);
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
            scans.entry(scan_id.clone()).or_insert(AutoScanContext {
                profile_name: profile_name.clone(),
                source_path: source_path.clone(),
            });
            push_event(
                status,
                BackgroundEventKind::ScanStarted,
                "Automatyczny skan rozpoczęty",
                profile_name,
                Some(source_path),
                Some(scan_id),
            );
        }
        Err(error) => {
            push_event(
                status,
                BackgroundEventKind::ScanFailed,
                "Nie udało się uruchomić skanu",
                format!("{error:?}"),
                Some(source_path),
                None,
            );
        }
    }
}

fn finish_auto_scans(
    app: &tauri::AppHandle,
    status: &Arc<Mutex<BackgroundStatus>>,
    scans: &mut HashMap<String, AutoScanContext>,
) {
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
                let detail = format!("{}: znaleziono {count} pozycji", context.profile_name);
                push_event(
                    status,
                    BackgroundEventKind::ScanCompleted,
                    "Automatyczny skan zakończony",
                    detail,
                    Some(context.source_path),
                    Some(id),
                );
            }
            MediaScanJobStatus::Failed | MediaScanJobStatus::Cancelled => {
                let detail = job
                    .error_message()
                    .unwrap_or("Skan został anulowany.")
                    .to_owned();
                push_event(
                    status,
                    BackgroundEventKind::ScanFailed,
                    "Automatyczny skan nie został ukończony",
                    detail.clone(),
                    Some(context.source_path),
                    Some(id),
                );
                notify(app, "Problem podczas skanowania karty", &detail);
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

fn persist_volume_state(
    app: &tauri::AppHandle,
    volume: &importer_media::SourceVolume,
    state: SourceWorkflowState,
    error: Option<String>,
) {
    let workflow = PendingSourceWorkflow {
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
            .and_then(|settings| serde_json::to_string(&settings.portable.naming).ok())
            .unwrap_or_default(),
        editor: crate::sources::WorkflowEditorState::default(),
        error,
        updated_at_unix_ms: now_unix_ms(),
    };
    let _ = persist_workflow(&app.state::<ImportManifest>(), &workflow);
    let _ = app.emit("source-workflow-changed", workflow);
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

fn update_status(
    status: &Arc<Mutex<BackgroundStatus>>,
    update: impl FnOnce(&mut BackgroundStatus),
) {
    if let Ok(mut state) = status.lock() {
        update(&mut state);
    }
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

    #[test]
    fn service_starts_with_refresh_requested_and_safe_empty_status() {
        let service = BackgroundService::default();

        assert!(service.refresh_requested.swap(false, Ordering::Relaxed));
        let status = service.current().expect("status should be available");
        assert!(status.running);
        assert_eq!(status.connected_known_source_count, 0);
        assert_eq!(status.active_auto_scan_count, 0);
        assert!(status.events.is_empty());

        service.request_refresh();
        assert!(service.refresh_requested.load(Ordering::Relaxed));
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
}
