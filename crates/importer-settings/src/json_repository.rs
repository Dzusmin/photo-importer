use std::fs;
use std::path::{Path, PathBuf};

use importer_domain::AppSettings;

use crate::atomic_write::atomic_write;
use crate::decoder::decode_settings;
use crate::{
    FileOperation, SettingsLoad, SettingsLoadSource, SettingsRepository, SettingsRepositoryError,
};

pub const SETTINGS_FILE_NAME: &str = "settings.json";
pub const SETTINGS_BACKUP_FILE_NAME: &str = "settings.json.bak";

#[derive(Debug, Clone)]
pub struct JsonSettingsRepository {
    config_directory: PathBuf,
}

impl JsonSettingsRepository {
    #[must_use]
    pub fn new(config_directory: impl Into<PathBuf>) -> Self {
        Self {
            config_directory: config_directory.into(),
        }
    }

    #[must_use]
    pub fn primary_path(&self) -> PathBuf {
        self.config_directory.join(SETTINGS_FILE_NAME)
    }

    #[must_use]
    pub fn backup_path(&self) -> PathBuf {
        self.config_directory.join(SETTINGS_BACKUP_FILE_NAME)
    }

    fn read_file(path: &Path) -> Result<Vec<u8>, SettingsRepositoryError> {
        fs::read(path).map_err(|source| SettingsRepositoryError::FileSystem {
            operation: FileOperation::Read,
            path: path.to_path_buf(),
            source,
        })
    }

    fn backup_is_valid(&self) -> bool {
        let path = self.backup_path();
        fs::read(&path)
            .ok()
            .and_then(|bytes| decode_settings(&bytes, &path).ok())
            .is_some()
    }

    fn serialize(settings: &AppSettings) -> Result<Vec<u8>, SettingsRepositoryError> {
        settings
            .validate()
            .map_err(|source| SettingsRepositoryError::Validation { source })?;

        let mut bytes = serde_json::to_vec_pretty(settings)
            .map_err(|source| SettingsRepositoryError::Serialize { source })?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

impl SettingsRepository for JsonSettingsRepository {
    fn load(&self) -> Result<SettingsLoad, SettingsRepositoryError> {
        let path = self.primary_path();
        if !path.exists() {
            return Ok(SettingsLoad {
                settings: AppSettings::default(),
                source: SettingsLoadSource::Defaults,
            });
        }

        let bytes = Self::read_file(&path)?;
        let settings = decode_settings(&bytes, &path).map_err(|error| {
            SettingsRepositoryError::CorruptedPrimary {
                path: path.clone(),
                backup_available: self.backup_is_valid(),
                reason: error.to_string(),
            }
        })?;

        Ok(SettingsLoad {
            settings,
            source: SettingsLoadSource::PrimaryFile,
        })
    }

    fn save(&self, settings: &AppSettings) -> Result<(), SettingsRepositoryError> {
        let new_contents = Self::serialize(settings)?;
        let primary_path = self.primary_path();

        if primary_path.exists() {
            let current_contents = Self::read_file(&primary_path)?;
            decode_settings(&current_contents, &primary_path).map_err(|error| {
                SettingsRepositoryError::CorruptedPrimary {
                    path: primary_path.clone(),
                    backup_available: self.backup_is_valid(),
                    reason: error.to_string(),
                }
            })?;
            atomic_write(&self.backup_path(), &current_contents)?;
        }

        atomic_write(&primary_path, &new_contents)
    }

    fn load_backup(&self) -> Result<AppSettings, SettingsRepositoryError> {
        let path = self.backup_path();
        if !path.exists() {
            return Err(SettingsRepositoryError::BackupNotFound { path });
        }

        let bytes = Self::read_file(&path)?;
        decode_settings(&bytes, &path).map_err(SettingsRepositoryError::InvalidBackup)
    }

    fn restore_backup(&self) -> Result<AppSettings, SettingsRepositoryError> {
        let path = self.backup_path();
        if !path.exists() {
            return Err(SettingsRepositoryError::BackupNotFound { path });
        }

        let contents = Self::read_file(&path)?;
        let settings =
            decode_settings(&contents, &path).map_err(SettingsRepositoryError::InvalidBackup)?;
        atomic_write(&self.primary_path(), &contents)?;
        Ok(settings)
    }
}
