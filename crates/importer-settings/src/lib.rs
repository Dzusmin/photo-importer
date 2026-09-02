//! Durable JSON persistence for Photo Importer settings.
//!
//! The caller supplies the configuration directory. This keeps platform-specific
//! path discovery in the application shell and makes persistence easy to test.

mod atomic_write;
mod decoder;
mod error;
mod json_repository;
mod repository;

pub use decoder::SettingsDecodeError;
pub use error::{FileOperation, SettingsRepositoryError};
pub use json_repository::{JsonSettingsRepository, SETTINGS_BACKUP_FILE_NAME, SETTINGS_FILE_NAME};
pub use repository::{SettingsLoad, SettingsLoadSource, SettingsRepository};
