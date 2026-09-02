use std::path::PathBuf;

use importer_domain::settings::SettingsValidationErrors;
use thiserror::Error;

use crate::SettingsDecodeError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileOperation {
    CreateDirectory,
    Read,
    CreateTemporaryFile,
    Write,
    Flush,
    Replace,
}

impl std::fmt::Display for FileOperation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            Self::CreateDirectory => "create directory",
            Self::Read => "read",
            Self::CreateTemporaryFile => "create temporary file",
            Self::Write => "write",
            Self::Flush => "flush",
            Self::Replace => "replace",
        };
        formatter.write_str(name)
    }
}

#[derive(Debug, Error)]
pub enum SettingsRepositoryError {
    #[error("cannot {operation} settings path {path}: {source}")]
    FileSystem {
        operation: FileOperation,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot serialize settings: {source}")]
    Serialize {
        #[source]
        source: serde_json::Error,
    },
    #[error("refusing to save invalid settings: {source}")]
    Validation {
        #[source]
        source: SettingsValidationErrors,
    },
    #[error("cannot load settings: {0}")]
    Decode(#[from] SettingsDecodeError),
    #[error(
        "primary settings file {path} is corrupt; backup available: {backup_available}; {reason}"
    )]
    CorruptedPrimary {
        path: PathBuf,
        backup_available: bool,
        reason: String,
    },
    #[error("settings backup does not exist at {path}")]
    BackupNotFound { path: PathBuf },
    #[error("settings backup is invalid: {0}")]
    InvalidBackup(SettingsDecodeError),
}
