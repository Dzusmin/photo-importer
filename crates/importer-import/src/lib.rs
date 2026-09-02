//! Crash-resilient execution of persisted import sessions.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use importer_manifest::{
    ImportManifest, ImportOperationRecord, ImportSession, ImportSessionOperation,
    ImportSessionStatus, ImportedFileRecord, ManifestError, OperationStatus, hash_file,
};
use tempfile::TempPath;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct ImportExecutor {
    manifest: ImportManifest,
}

#[derive(Debug, Error)]
pub enum ImportExecutionError {
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error("import session does not exist: {0}")]
    SessionNotFound(String),
    #[error("source file is unavailable: {0}")]
    SourceUnavailable(PathBuf),
    #[error("source size changed for {path}: expected {expected}, found {actual}")]
    SourceSizeChanged {
        path: PathBuf,
        expected: u64,
        actual: u64,
    },
    #[error("destination appeared after planning: {0}")]
    DestinationConflict(PathBuf),
    #[error("cannot prepare destination directory {path}: {source}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot copy {source_path} to temporary file {temporary_path}: {source}")]
    CopyFile {
        source_path: PathBuf,
        temporary_path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("verification failed for {0}: source and copied content differ")]
    VerificationFailed(PathBuf),
    #[error("cannot publish verified file {path}: {source}")]
    PublishFile {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot remove verified source {path}: {source}")]
    RemoveSource {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("move-after-verification was not explicitly confirmed")]
    MoveNotConfirmed,
    #[error("cannot roll back a moved set after its source was deleted")]
    MoveRollbackUnsafe,
    #[error("cannot roll back a file changed after import: {0}")]
    RollbackConflict(PathBuf),
    #[error("cannot remove imported file {path}: {source}")]
    RollbackFile {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl ImportExecutor {
    #[must_use]
    pub fn new(manifest: ImportManifest) -> Self {
        Self { manifest }
    }

    pub fn execute_session(
        &self,
        session_id: &str,
        mut on_progress: impl FnMut(&ImportSession),
    ) -> Result<ImportSession, ImportExecutionError> {
        let initial = self.session(session_id)?;
        if initial.operation == ImportSessionOperation::MoveAfterVerification
            && !initial.move_confirmed
        {
            return Err(ImportExecutionError::MoveNotConfirmed);
        }
        self.manifest.set_session_running(session_id)?;
        on_progress(&self.session(session_id)?);
        loop {
            let control = self.manifest.session_control(session_id)?;
            if control.cancel_requested {
                self.manifest.mark_session_status(
                    session_id,
                    ImportSessionStatus::Cancelled,
                    None,
                )?;
                break;
            }
            if control.pause_requested {
                self.manifest
                    .mark_session_status(session_id, ImportSessionStatus::Paused, None)?;
                break;
            }
            let Some(operation) = self.manifest.next_import_operation(session_id)? else {
                if initial.operation == ImportSessionOperation::MoveAfterVerification
                    && let Err(error) = self.remove_verified_sources(session_id)
                {
                    let status = if matches!(error, ImportExecutionError::SourceUnavailable(_)) {
                        ImportSessionStatus::FailedRecoverable
                    } else {
                        ImportSessionStatus::Failed
                    };
                    self.manifest.mark_session_status(
                        session_id,
                        status,
                        Some(&error.to_string()),
                    )?;
                    return Err(error);
                }
                self.manifest.mark_session_status(
                    session_id,
                    ImportSessionStatus::Completed,
                    None,
                )?;
                break;
            };
            let item_operations = self
                .manifest
                .item_operations(session_id, &operation.item_key)?;
            for item_operation in item_operations.into_iter().filter(|operation| {
                matches!(
                    operation.status,
                    OperationStatus::Pending | OperationStatus::Failed
                )
            }) {
                if let Err(error) = self.copy_and_verify(session_id, &item_operation) {
                    cleanup_temporary(&item_operation.destination_path, session_id);
                    self.manifest.mark_operation_status(
                        item_operation.id,
                        OperationStatus::Failed,
                        Some(&error.to_string()),
                    )?;
                    let status = if matches!(error, ImportExecutionError::SourceUnavailable(_)) {
                        ImportSessionStatus::FailedRecoverable
                    } else {
                        ImportSessionStatus::Failed
                    };
                    self.manifest.mark_session_status(
                        session_id,
                        status,
                        Some(&error.to_string()),
                    )?;
                    on_progress(&self.session(session_id)?);
                    return Err(error);
                }
                on_progress(&self.session(session_id)?);
            }
        }
        let session = self.session(session_id)?;
        on_progress(&session);
        Ok(session)
    }

    pub fn rollback_session(
        &self,
        session_id: &str,
        mut on_progress: impl FnMut(&ImportSession),
    ) -> Result<ImportSession, ImportExecutionError> {
        let session = self.session(session_id)?;
        if session.operation == ImportSessionOperation::MoveAfterVerification
            && session
                .operations
                .iter()
                .any(|operation| operation.source_deleted)
        {
            return Err(ImportExecutionError::MoveRollbackUnsafe);
        }
        self.manifest
            .mark_session_status(session_id, ImportSessionStatus::RollingBack, None)?;
        on_progress(&self.session(session_id)?);
        for operation in session
            .operations
            .iter()
            .rev()
            .filter(|operation| operation.status == OperationStatus::Completed)
        {
            let expected_hash = operation.destination_sha256.as_deref().ok_or_else(|| {
                ImportExecutionError::RollbackConflict(operation.destination_path.clone())
            })?;
            if operation.destination_path.exists() {
                let current_hash = hash_file(&operation.destination_path)?;
                if current_hash != expected_hash {
                    return Err(ImportExecutionError::RollbackConflict(
                        operation.destination_path.clone(),
                    ));
                }
                fs::remove_file(&operation.destination_path).map_err(|source| {
                    ImportExecutionError::RollbackFile {
                        path: operation.destination_path.clone(),
                        source,
                    }
                })?;
            }
            self.manifest
                .remove_imported_record_for_session(session_id, expected_hash)?;
            self.manifest
                .mark_operation_status(operation.id, OperationStatus::Pending, None)?;
            on_progress(&self.session(session_id)?);
        }
        self.manifest
            .mark_session_status(session_id, ImportSessionStatus::Cancelled, None)?;
        let session = self.session(session_id)?;
        on_progress(&session);
        Ok(session)
    }

    fn copy_and_verify(
        &self,
        session_id: &str,
        operation: &ImportOperationRecord,
    ) -> Result<(), ImportExecutionError> {
        self.manifest
            .mark_operation_status(operation.id, OperationStatus::Copying, None)?;
        let source_metadata = fs::metadata(&operation.source_path)
            .map_err(|_| ImportExecutionError::SourceUnavailable(operation.source_path.clone()))?;
        if source_metadata.len() != operation.size_bytes {
            return Err(ImportExecutionError::SourceSizeChanged {
                path: operation.source_path.clone(),
                expected: operation.size_bytes,
                actual: source_metadata.len(),
            });
        }
        if operation.destination_path.exists() {
            return self.adopt_matching_destination(session_id, operation);
        }
        let parent = operation.destination_path.parent().ok_or_else(|| {
            ImportExecutionError::CreateDirectory {
                path: operation.destination_path.clone(),
                source: io::Error::new(io::ErrorKind::InvalidInput, "destination has no parent"),
            }
        })?;
        fs::create_dir_all(parent).map_err(|source| ImportExecutionError::CreateDirectory {
            path: parent.to_path_buf(),
            source,
        })?;
        let temporary_path = temporary_path(&operation.destination_path, session_id);
        if temporary_path.exists() {
            fs::remove_file(&temporary_path).map_err(|source| ImportExecutionError::CopyFile {
                source_path: operation.source_path.clone(),
                temporary_path: temporary_path.clone(),
                source,
            })?;
        }
        copy_to_temporary(operation, &temporary_path)?;
        self.manifest
            .mark_operation_status(operation.id, OperationStatus::Verifying, None)?;
        let copied_size = fs::metadata(&temporary_path)
            .map_err(|source| ImportExecutionError::CopyFile {
                source_path: operation.source_path.clone(),
                temporary_path: temporary_path.clone(),
                source,
            })?
            .len();
        let destination_hash = hash_file(&temporary_path)?;
        let source_hash = hash_source(&operation.source_path)?;
        if copied_size != operation.size_bytes || destination_hash != source_hash {
            let _ = fs::remove_file(&temporary_path);
            return Err(ImportExecutionError::VerificationFailed(
                operation.source_path.clone(),
            ));
        }
        let temporary = TempPath::try_from_path(temporary_path).map_err(|source| {
            ImportExecutionError::PublishFile {
                path: operation.destination_path.clone(),
                source,
            }
        })?;
        temporary
            .persist_noclobber(&operation.destination_path)
            .map_err(|error| ImportExecutionError::PublishFile {
                path: operation.destination_path.clone(),
                source: error.error,
            })?;
        OpenOptions::new()
            .write(true)
            .open(&operation.destination_path)
            .and_then(|file| file.sync_all())
            .map_err(|source| ImportExecutionError::PublishFile {
                path: operation.destination_path.clone(),
                source,
            })?;
        sync_directory_if_supported(parent);
        self.record_completed(session_id, operation, &source_hash)
    }

    fn adopt_matching_destination(
        &self,
        session_id: &str,
        operation: &ImportOperationRecord,
    ) -> Result<(), ImportExecutionError> {
        let destination_size = fs::metadata(&operation.destination_path)
            .map(|metadata| metadata.len())
            .unwrap_or(u64::MAX);
        let source_hash = hash_source(&operation.source_path)?;
        if destination_size == operation.size_bytes
            && hash_file(&operation.destination_path)? == source_hash
        {
            self.record_completed(session_id, operation, &source_hash)
        } else {
            Err(ImportExecutionError::DestinationConflict(
                operation.destination_path.clone(),
            ))
        }
    }

    fn record_completed(
        &self,
        session_id: &str,
        operation: &ImportOperationRecord,
        hash: &str,
    ) -> Result<(), ImportExecutionError> {
        let session = self.session(session_id)?;
        self.manifest.complete_import_operation(
            operation.id,
            hash,
            &ImportedFileRecord {
                content_sha256: hash.to_owned(),
                size_bytes: operation.size_bytes,
                original_name: operation
                    .source_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                source_relative_path: operation.source_relative_path.clone(),
                imported_path: operation.destination_path.clone(),
                imported_at_unix_ms: now_unix_ms(),
                source_fingerprint: session.source_fingerprint.clone(),
                event_name: Some(operation.event_name.clone()),
            },
        )?;
        if let Some(source_fingerprint) = session.source_fingerprint.as_deref() {
            let _ = self.manifest.cache_verified_source_file(
                source_fingerprint,
                &operation.source_relative_path,
                &operation.source_path,
                operation.size_bytes,
                hash,
            );
        }
        Ok(())
    }

    fn remove_verified_sources(&self, session_id: &str) -> Result<(), ImportExecutionError> {
        let session = self.session(session_id)?;
        let mut item_keys: Vec<_> = session
            .operations
            .iter()
            .map(|operation| operation.item_key.clone())
            .collect();
        item_keys.sort();
        item_keys.dedup();
        for item_key in item_keys {
            let operations = self.manifest.item_operations(session_id, &item_key)?;
            if operations
                .iter()
                .any(|operation| operation.status != OperationStatus::Completed)
            {
                continue;
            }
            for operation in operations {
                if operation.source_deleted {
                    continue;
                }
                match fs::remove_file(&operation.source_path) {
                    Ok(()) => self.manifest.mark_source_deleted(operation.id)?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        self.manifest.mark_source_deleted(operation.id)?
                    }
                    Err(source) => {
                        return Err(ImportExecutionError::RemoveSource {
                            path: operation.source_path,
                            source,
                        });
                    }
                }
            }
        }
        Ok(())
    }

    fn session(&self, id: &str) -> Result<ImportSession, ImportExecutionError> {
        self.manifest
            .get_import_session(id)?
            .ok_or_else(|| ImportExecutionError::SessionNotFound(id.to_owned()))
    }
}

fn copy_to_temporary(
    operation: &ImportOperationRecord,
    temporary_path: &Path,
) -> Result<(), ImportExecutionError> {
    let source = File::open(&operation.source_path).map_err(|source| {
        if matches!(
            source.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::NotConnected
        ) {
            ImportExecutionError::SourceUnavailable(operation.source_path.clone())
        } else {
            copy_error(operation, temporary_path, source)
        }
    })?;
    let destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary_path)
        .map_err(|source| copy_error(operation, temporary_path, source))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, source);
    let mut writer = BufWriter::with_capacity(1024 * 1024, destination);
    io::copy(&mut reader, &mut writer)
        .map_err(|source| copy_error(operation, temporary_path, source))?;
    writer
        .flush()
        .map_err(|source| copy_error(operation, temporary_path, source))?;
    writer
        .into_inner()
        .map_err(|error| copy_error(operation, temporary_path, error.into_error()))?
        .sync_all()
        .map_err(|source| copy_error(operation, temporary_path, source))
}

fn hash_source(path: &Path) -> Result<String, ImportExecutionError> {
    hash_file(path).map_err(|error| match error {
        ManifestError::HashFile { path, source }
            if matches!(
                source.kind(),
                io::ErrorKind::NotFound
                    | io::ErrorKind::NotConnected
                    | io::ErrorKind::UnexpectedEof
            ) =>
        {
            ImportExecutionError::SourceUnavailable(path)
        }
        error => ImportExecutionError::Manifest(error),
    })
}

fn copy_error(
    operation: &ImportOperationRecord,
    temporary_path: &Path,
    source: io::Error,
) -> ImportExecutionError {
    ImportExecutionError::CopyFile {
        source_path: operation.source_path.clone(),
        temporary_path: temporary_path.to_path_buf(),
        source,
    }
}

fn temporary_path(destination: &Path, session_id: &str) -> PathBuf {
    let name = destination
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    destination.with_file_name(format!("{name}.photo-importer-{session_id}.partial"))
}

fn cleanup_temporary(destination: &Path, session_id: &str) {
    let path = temporary_path(destination, session_id);
    if path.is_file() {
        let _ = fs::remove_file(path);
    }
}

fn sync_directory_if_supported(directory: &Path) {
    if let Ok(handle) = File::open(directory) {
        let _ = handle.sync_all();
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}
