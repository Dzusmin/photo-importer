use serde::Serialize;
use tauri::Manager;

use importer_manifest::ImportManifest;

mod background;
mod imports;
mod scan_jobs;
mod settings;
mod sources;
mod thumbnails;

use background::{
    BackgroundService, acknowledge_pending_source, get_background_status,
    ignore_source_until_disconnect, refresh_background_monitor, start_source_workflow,
};
use imports::{
    ImportService, cancel_import_session, create_import_session, get_import_session,
    list_import_sessions, pause_import_session, retry_import_rollback, start_import_session,
};
use scan_jobs::{
    ScanService, cancel_media_scan, get_media_scan, list_media_scans, start_media_scan,
};

use settings::{
    SettingsService, export_portable_settings, import_portable_settings, load_settings,
    restore_settings_backup, save_settings,
};
use sources::{
    announce_import_plan_ready, build_import_plan_preview, correct_capture_times,
    delete_pending_source_workflow, ensure_media_source_marker, list_media_sources,
    list_pending_source_workflows, list_source_workflows, save_pending_source_workflow,
};
use thumbnails::{ThumbnailService, clear_thumbnail_cache, get_media_thumbnail};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemStatus {
    product_name: &'static str,
    app_version: &'static str,
    operating_system: &'static str,
    architecture: &'static str,
    backend_status: &'static str,
}

#[tauri::command]
fn get_system_status() -> SystemStatus {
    SystemStatus {
        product_name: importer_domain::PRODUCT_NAME,
        app_version: env!("CARGO_PKG_VERSION"),
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        backend_status: "ready",
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
            correct_capture_times,
            build_import_plan_preview,
            create_import_session,
            start_import_session,
            pause_import_session,
            cancel_import_session,
            retry_import_rollback,
            get_import_session,
            list_import_sessions,
            start_media_scan,
            get_media_scan,
            list_media_scans,
            cancel_media_scan,
            get_media_thumbnail,
            clear_thumbnail_cache,
            get_background_status,
            refresh_background_monitor,
            acknowledge_pending_source,
            start_source_workflow,
            ignore_source_until_disconnect,
            list_source_workflows,
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

    #[test]
    fn health_command_reports_ready_backend() {
        let status = get_system_status();

        assert_eq!(status.product_name, "Photo Importer");
        assert_eq!(status.backend_status, "ready");
        assert!(!status.app_version.is_empty());
    }
}
