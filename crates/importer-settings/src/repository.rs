use importer_domain::AppSettings;

use crate::SettingsRepositoryError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsLoadSource {
    Defaults,
    PrimaryFile,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsLoad {
    pub settings: AppSettings,
    pub source: SettingsLoadSource,
}

pub trait SettingsRepository {
    fn load(&self) -> Result<SettingsLoad, SettingsRepositoryError>;

    fn save(&self, settings: &AppSettings) -> Result<(), SettingsRepositoryError>;

    fn load_backup(&self) -> Result<AppSettings, SettingsRepositoryError>;

    fn restore_backup(&self) -> Result<AppSettings, SettingsRepositoryError>;
}
