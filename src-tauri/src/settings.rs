use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use importer_domain::settings::PortableSettings;
use importer_domain::{AppSettings, CURRENT_SETTINGS_SCHEMA_VERSION};
use importer_settings::{
    JsonSettingsRepository, SettingsLoadSource, SettingsRepository, SettingsRepositoryError,
};
use serde::{Deserialize, Serialize};
use tempfile::Builder;

const PORTABLE_SETTINGS_FORMAT: &str = "photo-importer-portable-settings";

#[derive(Debug)]
pub(crate) struct SettingsService {
    repository: JsonSettingsRepository,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsResponse {
    settings: AppSettings,
    source: &'static str,
    backup_available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsCommandError {
    code: &'static str,
    message: String,
    backup_available: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableSettingsFile {
    format: String,
    schema_version: u32,
    portable: PortableSettings,
}

impl SettingsService {
    pub(crate) fn new(config_directory: impl Into<PathBuf>) -> Self {
        Self {
            repository: JsonSettingsRepository::new(config_directory),
        }
    }

    fn load(&self) -> Result<SettingsResponse, SettingsCommandError> {
        let loaded = self.repository.load().map_err(map_repository_error)?;
        Ok(self.response(
            loaded.settings,
            match loaded.source {
                SettingsLoadSource::Defaults => "defaults",
                SettingsLoadSource::PrimaryFile => "primaryFile",
            },
        ))
    }

    pub(crate) fn event_gap_minutes(&self) -> Result<u32, SettingsCommandError> {
        Ok(self
            .repository
            .load()
            .map_err(map_repository_error)?
            .settings
            .portable
            .import
            .event_gap_minutes)
    }

    pub(crate) fn current_settings(&self) -> Result<AppSettings, SettingsCommandError> {
        Ok(self
            .repository
            .load()
            .map_err(map_repository_error)?
            .settings)
    }

    fn save(&self, settings: &AppSettings) -> Result<SettingsResponse, SettingsCommandError> {
        self.repository
            .save(settings)
            .map_err(map_repository_error)?;
        Ok(self.response(settings.clone(), "primaryFile"))
    }

    fn restore_backup(&self) -> Result<SettingsResponse, SettingsCommandError> {
        let settings = self
            .repository
            .restore_backup()
            .map_err(map_repository_error)?;
        Ok(self.response(settings, "primaryFile"))
    }

    fn export_portable(&self, destination: &Path) -> Result<(), SettingsCommandError> {
        let loaded = self.repository.load().map_err(map_repository_error)?;
        let export = PortableSettingsFile {
            format: PORTABLE_SETTINGS_FORMAT.to_owned(),
            schema_version: CURRENT_SETTINGS_SCHEMA_VERSION,
            portable: loaded.settings.portable,
        };
        let mut contents = serde_json::to_vec_pretty(&export).map_err(|error| {
            SettingsCommandError::new(
                "serializeFailed",
                format!("Nie można utworzyć JSON: {error}"),
            )
        })?;
        contents.push(b'\n');
        write_atomically(destination, &contents)
    }

    fn import_portable(&self, source: &Path) -> Result<SettingsResponse, SettingsCommandError> {
        let contents = fs::read(source).map_err(|error| {
            SettingsCommandError::new(
                "importReadFailed",
                format!("Nie można odczytać {}: {error}", source.display()),
            )
        })?;
        let imported: PortableSettingsFile =
            serde_json::from_slice(&contents).map_err(|error| {
                SettingsCommandError::new(
                    "invalidImport",
                    format!("Plik nie jest poprawnym eksportem ustawień: {error}"),
                )
            })?;

        if imported.format != PORTABLE_SETTINGS_FORMAT {
            return Err(SettingsCommandError::new(
                "invalidImportFormat",
                "Plik pochodzi z innego programu lub ma nieobsługiwany format.",
            ));
        }
        if imported.schema_version != CURRENT_SETTINGS_SCHEMA_VERSION {
            return Err(SettingsCommandError::new(
                "unsupportedImportVersion",
                format!(
                    "Wersja eksportu {} nie jest obsługiwana; oczekiwano {}.",
                    imported.schema_version, CURRENT_SETTINGS_SCHEMA_VERSION
                ),
            ));
        }

        let mut settings = self
            .repository
            .load()
            .map_err(map_repository_error)?
            .settings;
        settings.portable = imported.portable;
        self.save(&settings)
    }

    fn response(&self, settings: AppSettings, source: &'static str) -> SettingsResponse {
        SettingsResponse {
            settings,
            source,
            backup_available: self.repository.load_backup().is_ok(),
        }
    }
}

impl SettingsCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            backup_available: None,
        }
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
    }
}

fn map_repository_error(error: SettingsRepositoryError) -> SettingsCommandError {
    match error {
        SettingsRepositoryError::CorruptedPrimary {
            backup_available,
            reason,
            ..
        } => SettingsCommandError {
            code: "corruptedPrimary",
            message: format!("Plik ustawień jest uszkodzony. {reason}"),
            backup_available: Some(backup_available),
        },
        SettingsRepositoryError::BackupNotFound { .. } => SettingsCommandError::new(
            "backupNotFound",
            "Nie znaleziono poprawnej kopii poprzednich ustawień.",
        ),
        SettingsRepositoryError::InvalidBackup(error) => SettingsCommandError::new(
            "invalidBackup",
            format!("Kopia ustawień jest uszkodzona: {error}"),
        ),
        SettingsRepositoryError::Validation { source } => SettingsCommandError::new(
            "validationFailed",
            source
                .errors()
                .iter()
                .map(|error| format!("{}: {}", error.path, error.message))
                .collect::<Vec<_>>()
                .join("; "),
        ),
        other => SettingsCommandError::new("settingsIoFailed", other.to_string()),
    }
}

fn write_atomically(path: &Path, contents: &[u8]) -> Result<(), SettingsCommandError> {
    let parent = path.parent().ok_or_else(|| {
        SettingsCommandError::new(
            "exportWriteFailed",
            "Wybrana ścieżka nie ma katalogu nadrzędnego.",
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        SettingsCommandError::new(
            "exportWriteFailed",
            format!("Nie można utworzyć {}: {error}", parent.display()),
        )
    })?;

    let mut temporary = Builder::new()
        .prefix(".photo-importer-export-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|error| {
            SettingsCommandError::new(
                "exportWriteFailed",
                format!("Nie można utworzyć pliku tymczasowego: {error}"),
            )
        })?;
    temporary.write_all(contents).map_err(|error| {
        SettingsCommandError::new(
            "exportWriteFailed",
            format!("Nie można zapisać eksportu: {error}"),
        )
    })?;
    temporary.as_file().sync_all().map_err(|error| {
        SettingsCommandError::new(
            "exportWriteFailed",
            format!("Nie można bezpiecznie utrwalić eksportu: {error}"),
        )
    })?;
    temporary.persist(path).map_err(|error| {
        SettingsCommandError::new(
            "exportWriteFailed",
            format!("Nie można zastąpić pliku eksportu: {}", error.error),
        )
    })?;
    Ok(())
}

#[tauri::command]
pub(crate) fn load_settings(
    service: tauri::State<'_, SettingsService>,
) -> Result<SettingsResponse, SettingsCommandError> {
    service.load()
}

#[tauri::command]
pub(crate) fn save_settings(
    settings: AppSettings,
    app: tauri::AppHandle,
    service: tauri::State<'_, SettingsService>,
) -> Result<SettingsResponse, SettingsCommandError> {
    let response = service.save(&settings)?;
    crate::background::sync_autostart(&app, settings.local.start_at_login);
    Ok(response)
}

#[tauri::command]
pub(crate) fn restore_settings_backup(
    service: tauri::State<'_, SettingsService>,
) -> Result<SettingsResponse, SettingsCommandError> {
    service.restore_backup()
}

#[tauri::command]
pub(crate) fn export_portable_settings(
    path: PathBuf,
    service: tauri::State<'_, SettingsService>,
) -> Result<(), SettingsCommandError> {
    service.export_portable(&path)
}

#[tauri::command]
pub(crate) fn import_portable_settings(
    path: PathBuf,
    service: tauri::State<'_, SettingsService>,
) -> Result<SettingsResponse, SettingsCommandError> {
    service.import_portable(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_export_omits_local_settings_and_round_trips() {
        let directory = tempfile::tempdir().unwrap();
        let service = SettingsService::new(directory.path().join("config"));
        let mut settings = AppSettings::default();
        settings.local.library_path = Some(PathBuf::from("private-library"));
        settings.portable.import.event_gap_minutes = 75;
        service.save(&settings).unwrap();
        let export_path = directory.path().join("shared.json");

        service.export_portable(&export_path).unwrap();
        let exported = fs::read_to_string(&export_path).unwrap();

        assert!(!exported.contains("private-library"));
        assert!(!exported.contains("libraryPath"));
        assert!(exported.contains(PORTABLE_SETTINGS_FORMAT));

        let mut changed = settings.clone();
        changed.portable.import.event_gap_minutes = 15;
        service.save(&changed).unwrap();
        let imported = service.import_portable(&export_path).unwrap();

        assert_eq!(imported.settings.portable, settings.portable);
        assert_eq!(imported.settings.local, settings.local);
    }

    #[test]
    fn import_rejects_an_unknown_format_without_changing_settings() {
        let directory = tempfile::tempdir().unwrap();
        let service = SettingsService::new(directory.path().join("config"));
        let settings = AppSettings::default();
        service.save(&settings).unwrap();
        let import_path = directory.path().join("foreign.json");
        fs::write(
            &import_path,
            serde_json::json!({
                "format": "foreign-app",
                "schemaVersion": CURRENT_SETTINGS_SCHEMA_VERSION,
                "portable": settings.portable,
            })
            .to_string(),
        )
        .unwrap();

        let error = service.import_portable(&import_path).unwrap_err();

        assert_eq!(error.code, "invalidImportFormat");
        assert_eq!(service.load().unwrap().settings, settings);
    }
}
