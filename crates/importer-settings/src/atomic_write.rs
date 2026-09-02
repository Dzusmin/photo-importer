use std::fs;
use std::io::Write;
use std::path::Path;

use tempfile::Builder;

use crate::{FileOperation, SettingsRepositoryError};

pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), SettingsRepositoryError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|source| SettingsRepositoryError::FileSystem {
        operation: FileOperation::CreateDirectory,
        path: parent.to_path_buf(),
        source,
    })?;

    let mut temporary = Builder::new()
        .prefix(".photo-importer-settings-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|source| SettingsRepositoryError::FileSystem {
            operation: FileOperation::CreateTemporaryFile,
            path: parent.to_path_buf(),
            source,
        })?;

    temporary
        .write_all(contents)
        .map_err(|source| SettingsRepositoryError::FileSystem {
            operation: FileOperation::Write,
            path: path.to_path_buf(),
            source,
        })?;
    temporary
        .flush()
        .map_err(|source| SettingsRepositoryError::FileSystem {
            operation: FileOperation::Flush,
            path: path.to_path_buf(),
            source,
        })?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|source| SettingsRepositoryError::FileSystem {
            operation: FileOperation::Flush,
            path: path.to_path_buf(),
            source,
        })?;

    temporary
        .persist(path)
        .map_err(|error| SettingsRepositoryError::FileSystem {
            operation: FileOperation::Replace,
            path: path.to_path_buf(),
            source: error.error,
        })?;

    Ok(())
}
