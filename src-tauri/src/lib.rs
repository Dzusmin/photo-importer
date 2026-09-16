use serde::Serialize;
use tauri::Manager;

use importer_manifest::ImportManifest;

mod background;
mod backups;
mod events;
mod imports;
mod localization;
mod operations;
mod scan_jobs;
mod settings;
mod sources;
mod thumbnails;

use background::{
    BackgroundService, acknowledge_pending_source, get_background_status,
    ignore_source_until_disconnect, refresh_background_monitor, start_source_workflow,
};
use backups::{
    BackupService, cancel_backup_job, cancel_backup_planning_job, get_backup_job, inspect_backup,
    list_backup_history, list_backup_jobs, list_backup_planning_jobs, list_backup_targets,
    open_backup_directory, pause_backup_job, recognize_backup_target, register_backup_target,
    remove_backup_target, resume_backup_job, start_backup_job, start_backup_planning_job,
};
use events::{list_import_events, rename_import_event};
use imports::{
    ImportService, cancel_import_session, create_import_session, list_import_sessions,
    pause_import_session, retry_import_rollback, start_import_session,
};
use operations::list_operations;
use scan_jobs::{ScanService, cancel_media_scan, list_media_scans, start_media_scan};

use settings::{
    SettingsService, export_portable_settings, import_portable_settings, load_settings,
    restore_settings_backup, save_settings,
};
use sources::{
    announce_import_plan_ready, build_import_plan_preview, correct_capture_times,
    delete_disconnected_source_workflows, delete_pending_source_workflow,
    ensure_media_source_marker, list_media_sources, list_pending_source_workflows,
    list_photo_user_metadata, list_source_workflows, save_pending_source_workflow,
    save_photo_user_metadata,
};
use thumbnails::{
    ThumbnailService, allow_original_jpeg_preview, clear_thumbnail_cache, get_media_thumbnail,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemStatus {
    product_name: &'static str,
    app_version: &'static str,
    operating_system: &'static str,
    architecture: &'static str,
    backend_status: &'static str,
    import_engine_status: &'static str,
    import_engine_last_error: Option<String>,
}

#[tauri::command]
fn get_system_status(
    settings: tauri::State<'_, SettingsService>,
    manifest: tauri::State<'_, ImportManifest>,
    imports: tauri::State<'_, ImportService>,
) -> SystemStatus {
    let library_path = settings
        .current_settings()
        .map(|settings| settings.local.library_path)
        .map_err(|_| "Nie można odczytać ustawień biblioteki.".to_owned());
    let sessions = manifest
        .list_import_sessions()
        .map(|sessions| {
            sessions
                .into_iter()
                .filter_map(|session| {
                    let error = session.last_error?;
                    let severity = match session.status {
                        importer_manifest::ImportSessionStatus::Failed
                        | importer_manifest::ImportSessionStatus::RollbackFailed => {
                            EngineHealthSeverity::Error
                        }
                        importer_manifest::ImportSessionStatus::FailedRecoverable
                        | importer_manifest::ImportSessionStatus::Paused => {
                            EngineHealthSeverity::Degraded
                        }
                        _ => return None,
                    };
                    Some(SessionHealthIssue {
                        severity,
                        updated_at_unix_ms: session.updated_at_unix_ms,
                        error,
                    })
                })
                .collect()
        })
        .map_err(|error| format!("Nie można odczytać manifestu importu: {error}"));
    let runtime = imports.runtime_health().map_err(str::to_owned);
    let engine_health = determine_import_engine_health(library_path, sessions, runtime);

    SystemStatus {
        product_name: importer_domain::PRODUCT_NAME,
        app_version: env!("CARGO_PKG_VERSION"),
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        backend_status: "ready",
        import_engine_status: engine_health.severity.as_str(),
        import_engine_last_error: engine_health.last_error,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum EngineHealthSeverity {
    Ready,
    Degraded,
    Error,
}

impl EngineHealthSeverity {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Degraded => "degraded",
            Self::Error => "error",
        }
    }
}

#[derive(Debug)]
struct EngineHealth {
    severity: EngineHealthSeverity,
    last_error: Option<String>,
}

#[derive(Debug)]
struct SessionHealthIssue {
    severity: EngineHealthSeverity,
    updated_at_unix_ms: u64,
    error: String,
}

fn determine_import_engine_health(
    library_path: Result<Option<std::path::PathBuf>, String>,
    sessions: Result<Vec<SessionHealthIssue>, String>,
    runtime: Result<(), String>,
) -> EngineHealth {
    let mut issues = Vec::new();
    match library_path {
        Err(error) => issues.push((EngineHealthSeverity::Error, u64::MAX, error)),
        Ok(None) => {}
        Ok(Some(path)) if !path.is_dir() => issues.push((
            EngineHealthSeverity::Degraded,
            u64::MAX,
            format!(
                "Skonfigurowana biblioteka jest niedostępna: {}",
                path.display()
            ),
        )),
        Ok(Some(_)) => {}
    }
    match sessions {
        Err(error) => issues.push((EngineHealthSeverity::Error, u64::MAX, error)),
        Ok(session_issues) => issues.extend(
            session_issues
                .into_iter()
                .map(|issue| (issue.severity, issue.updated_at_unix_ms, issue.error)),
        ),
    }
    if let Err(error) = runtime {
        issues.push((EngineHealthSeverity::Error, u64::MAX, error));
    }

    let severity = issues
        .iter()
        .map(|(severity, _, _)| *severity)
        .max()
        .unwrap_or(EngineHealthSeverity::Ready);
    let last_error = issues
        .into_iter()
        .filter(|(issue_severity, _, _)| *issue_severity == severity)
        .max_by_key(|(_, updated_at, _)| *updated_at)
        .map(|(_, _, error)| error);
    EngineHealth {
        severity,
        last_error,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg("--background")
                .build(),
        )
        .setup(|app| {
            let config_directory = app.path().app_config_dir()?;
            app.manage(SettingsService::new(config_directory));
            app.manage(ScanService::default());
            app.manage(BackgroundService::default());
            app.manage(background::NotificationRouteState::default());
            app.manage(ThumbnailService::new(app.path().app_cache_dir()?)?);
            let data_directory = app.path().app_data_dir()?;
            app.manage(BackupService::new(&data_directory)?);
            let manifest = ImportManifest::open(data_directory.join("import-manifest.sqlite3"))?;
            app.manage(ImportService::new(manifest.clone()));
            app.manage(manifest);
            background::setup_tray(app)?;
            let start_at_login = app
                .state::<SettingsService>()
                .current_settings()
                .is_ok_and(|settings| settings.local.start_at_login);
            background::sync_autostart(app.handle(), start_at_login);
            app.state::<BackgroundService>().start(app.handle().clone());
            if std::env::args().any(|argument| argument == "--background")
                && app
                    .state::<SettingsService>()
                    .current_settings()
                    .is_ok_and(|settings| settings.local.minimize_to_tray)
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.hide();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                background::handle_close_request(window, api);
            }
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                background::deliver_pending_notification_route(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_system_status,
            list_operations,
            load_settings,
            save_settings,
            restore_settings_backup,
            export_portable_settings,
            import_portable_settings,
            list_media_sources,
            ensure_media_source_marker,
            announce_import_plan_ready,
            save_pending_source_workflow,
            list_pending_source_workflows,
            delete_pending_source_workflow,
            delete_disconnected_source_workflows,
            correct_capture_times,
            list_photo_user_metadata,
            save_photo_user_metadata,
            build_import_plan_preview,
            create_import_session,
            start_import_session,
            pause_import_session,
            cancel_import_session,
            retry_import_rollback,
            list_import_sessions,
            start_media_scan,
            list_media_scans,
            cancel_media_scan,
            get_media_thumbnail,
            allow_original_jpeg_preview,
            clear_thumbnail_cache,
            list_import_events,
            rename_import_event,
            get_background_status,
            refresh_background_monitor,
            acknowledge_pending_source,
            start_source_workflow,
            ignore_source_until_disconnect,
            list_source_workflows,
            register_backup_target,
            list_backup_targets,
            recognize_backup_target,
            remove_backup_target,
            start_backup_planning_job,
            list_backup_planning_jobs,
            cancel_backup_planning_job,
            inspect_backup,
            list_backup_history,
            open_backup_directory,
            start_backup_job,
            get_backup_job,
            list_backup_jobs,
            pause_backup_job,
            resume_backup_job,
            cancel_backup_job,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Photo Importer");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            background::protect_running_import_on_exit(app, &api, code);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn import_engine_health_is_ready_when_dependencies_are_available() {
        let library = tempdir().unwrap();
        let health = determine_import_engine_health(
            Ok(Some(library.path().to_path_buf())),
            Ok(Vec::new()),
            Ok(()),
        );

        assert_eq!(health.severity, EngineHealthSeverity::Ready);
        assert_eq!(health.last_error, None);
    }

    #[test]
    fn import_engine_health_is_ready_before_a_library_is_configured() {
        let health = determine_import_engine_health(Ok(None), Ok(Vec::new()), Ok(()));

        assert_eq!(health.severity, EngineHealthSeverity::Ready);
        assert_eq!(health.last_error, None);
    }

    #[test]
    fn import_engine_health_is_degraded_for_an_unavailable_library() {
        let library = tempdir().unwrap();
        let missing = library.path().join("missing");
        let health =
            determine_import_engine_health(Ok(Some(missing.clone())), Ok(Vec::new()), Ok(()));

        assert_eq!(health.severity, EngineHealthSeverity::Degraded);
        assert!(
            health
                .last_error
                .unwrap()
                .contains(&missing.display().to_string())
        );
    }

    #[test]
    fn import_engine_health_reports_the_latest_error_at_the_highest_severity() {
        let library = tempdir().unwrap();
        let health = determine_import_engine_health(
            Ok(Some(library.path().to_path_buf())),
            Ok(vec![
                SessionHealthIssue {
                    severity: EngineHealthSeverity::Error,
                    updated_at_unix_ms: 10,
                    error: "older fatal error".to_owned(),
                },
                SessionHealthIssue {
                    severity: EngineHealthSeverity::Degraded,
                    updated_at_unix_ms: 30,
                    error: "newer recoverable error".to_owned(),
                },
                SessionHealthIssue {
                    severity: EngineHealthSeverity::Error,
                    updated_at_unix_ms: 20,
                    error: "latest fatal error".to_owned(),
                },
            ]),
            Ok(()),
        );

        assert_eq!(health.severity, EngineHealthSeverity::Error);
        assert_eq!(health.last_error.as_deref(), Some("latest fatal error"));
    }

    #[test]
    fn import_engine_health_reports_manifest_or_runtime_failures_as_errors() {
        let health = determine_import_engine_health(
            Ok(None),
            Err("manifest unavailable".to_owned()),
            Err("runtime unavailable".to_owned()),
        );

        assert_eq!(health.severity, EngineHealthSeverity::Error);
        assert!(matches!(
            health.last_error.as_deref(),
            Some("manifest unavailable" | "runtime unavailable")
        ));
    }
}
