use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::hash_file;
use crate::{ImportManifest, ImportedFileRecord, ManifestError, to_i64};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportSessionOperation {
    Copy,
    MoveAfterVerification,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportSessionStatus {
    Planned,
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    FailedRecoverable,
    RollingBack,
    RollbackFailed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSourceIdentity {
    pub marker_uuid: Option<Uuid>,
    pub platform_volume_id: Option<String>,
    pub fallback_fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationStatus {
    Pending,
    Copying,
    Verifying,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionControl {
    pub pause_requested: bool,
    pub cancel_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewImportSession {
    pub operation: ImportSessionOperation,
    pub library_root: PathBuf,
    pub source_fingerprint: Option<String>,
    pub source_identity: Option<SessionSourceIdentity>,
    pub move_confirmed: bool,
    pub operations: Vec<NewImportOperation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewImportOperation {
    pub item_key: String,
    pub event_name: String,
    pub source_path: PathBuf,
    pub source_relative_path: PathBuf,
    pub destination_path: PathBuf,
    pub destination_relative_path: PathBuf,
    pub kind: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSession {
    pub id: String,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
    pub completed_at_unix_ms: Option<u64>,
    pub operation: ImportSessionOperation,
    pub status: ImportSessionStatus,
    pub library_root: PathBuf,
    pub source_fingerprint: Option<String>,
    pub source_identity: Option<SessionSourceIdentity>,
    pub file_count: usize,
    pub completed_file_count: usize,
    pub item_count: usize,
    pub completed_item_count: usize,
    pub total_size_bytes: u64,
    pub completed_size_bytes: u64,
    pub last_error: Option<String>,
    pub pause_requested: bool,
    pub cancel_requested: bool,
    pub move_confirmed: bool,
    pub operations: Vec<ImportOperationRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOperationRecord {
    pub id: i64,
    pub ordinal: usize,
    pub item_key: String,
    pub event_name: String,
    pub source_path: PathBuf,
    pub source_relative_path: PathBuf,
    pub destination_path: PathBuf,
    pub destination_relative_path: PathBuf,
    pub kind: String,
    pub size_bytes: u64,
    pub status: OperationStatus,
    pub source_sha256: Option<String>,
    pub destination_sha256: Option<String>,
    pub attempts: u32,
    pub last_error: Option<String>,
    pub source_deleted: bool,
}

impl ImportManifest {
    pub fn create_import_session(
        &self,
        new_session: &NewImportSession,
    ) -> Result<ImportSession, ManifestError> {
        for operation in &new_session.operations {
            if operation.destination_path.exists() {
                return Err(ManifestError::DestinationConflict(
                    operation.destination_path.clone(),
                ));
            }
        }
        if let Some(fingerprint) = &new_session.source_fingerprint {
            let identity_json = new_session
                .source_identity
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| ManifestError::InvalidStoredValue {
                    field: "session.source_identity",
                    value: error.to_string(),
                })?;
            let active = self.connection()?.query_row(
                "SELECT COUNT(*) FROM import_sessions
                 WHERE ((?2 IS NOT NULL AND source_identity_json = ?2)
                    OR (?2 IS NULL AND source_identity_json IS NULL AND source_fingerprint = ?1))
                 AND status IN ('planned', 'queued', 'running', 'paused', 'failed', 'failedRecoverable', 'rollingBack', 'rollbackFailed')",
                params![fingerprint, identity_json],
                |row| row.get::<_, i64>(0),
            )?;
            if active > 0 {
                return Err(ManifestError::ActiveSourceSession(fingerprint.clone()));
            }
        }
        let id = Uuid::new_v4().to_string();
        let now = now_unix_ms();
        let total_size_bytes = new_session.operations.iter().map(|op| op.size_bytes).sum();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO import_sessions (
                id, created_at_unix_ms, updated_at_unix_ms, operation, status,
                library_root, source_fingerprint, source_identity_json, file_count, total_size_bytes, move_confirmed
             ) VALUES (?1, ?2, ?3, ?4, 'planned', ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                to_i64(now, "created_at_unix_ms")?,
                to_i64(now, "updated_at_unix_ms")?,
                new_session.operation.as_str(),
                new_session.library_root.to_string_lossy(),
                new_session.source_fingerprint,
                new_session
                    .source_identity
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(|error| ManifestError::InvalidStoredValue {
                        field: "session.source_identity",
                        value: error.to_string(),
                    })?,
                i64::try_from(new_session.operations.len()).map_err(|_| {
                    ManifestError::ValueTooLarge {
                        field: "file_count",
                        value: u64::MAX,
                    }
                })?,
                to_i64(total_size_bytes, "total_size_bytes")?,
                new_session.move_confirmed,
            ],
        )?;
        for (ordinal, operation) in new_session.operations.iter().enumerate() {
            transaction.execute(
                "INSERT INTO destination_reservations (destination_path, session_id) VALUES (?1, ?2)",
                params![operation.destination_path.to_string_lossy(), id],
            )?;
            transaction.execute(
                "INSERT INTO import_operations (
                    session_id, ordinal, item_key, event_name, source_path,
                    source_relative_path, destination_path, destination_relative_path,
                    kind, size_bytes, status
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending')",
                params![
                    id,
                    i64::try_from(ordinal).unwrap_or(i64::MAX),
                    operation.item_key,
                    operation.event_name,
                    operation.source_path.to_string_lossy(),
                    operation.source_relative_path.to_string_lossy(),
                    operation.destination_path.to_string_lossy(),
                    operation.destination_relative_path.to_string_lossy(),
                    operation.kind,
                    to_i64(operation.size_bytes, "operation.size_bytes")?,
                ],
            )?;
        }
        transaction.commit()?;
        self.get_import_session(&id)?
            .ok_or_else(|| ManifestError::InvalidStoredValue {
                field: "session.id",
                value: id,
            })
    }

    pub fn get_import_session(&self, id: &str) -> Result<Option<ImportSession>, ManifestError> {
        let connection = self.connection()?;
        let row = connection
            .query_row(
                "SELECT id, created_at_unix_ms, updated_at_unix_ms, completed_at_unix_ms,
                        operation, status, library_root, source_fingerprint, source_identity_json, file_count,
                        total_size_bytes, last_error, pause_requested, cancel_requested,
                        move_confirmed,
                        (SELECT COUNT(*) FROM import_operations o WHERE o.session_id = s.id AND o.status = 'completed'),
                        COALESCE((SELECT SUM(size_bytes) FROM import_operations o WHERE o.session_id = s.id AND o.status = 'completed'), 0),
                        (SELECT COUNT(DISTINCT item_key) FROM import_operations o WHERE o.session_id = s.id),
                        (SELECT COUNT(DISTINCT item_key) FROM import_operations o
                         WHERE o.session_id = s.id AND NOT EXISTS (
                            SELECT 1 FROM import_operations pending
                            WHERE pending.session_id = s.id AND pending.item_key = o.item_key
                              AND pending.status != 'completed'
                         ))
                 FROM import_sessions s WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?,
                        row.get::<_, Option<i64>>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, i64>(9)?,
                        row.get::<_, i64>(10)?, row.get::<_, Option<String>>(11)?, row.get::<_, bool>(12)?,
                        row.get::<_, bool>(13)?, row.get::<_, bool>(14)?, row.get::<_, i64>(15)?, row.get::<_, i64>(16)?,
                        row.get::<_, i64>(17)?, row.get::<_, i64>(18)?,
                    ))
                },
            )
            .optional()?;
        let Some(row) = row else {
            return Ok(None);
        };
        let operations = self.list_import_operations(id)?;
        Ok(Some(ImportSession {
            id: row.0,
            created_at_unix_ms: from_i64(row.1, "created_at_unix_ms")?,
            updated_at_unix_ms: from_i64(row.2, "updated_at_unix_ms")?,
            completed_at_unix_ms: row
                .3
                .map(|v| from_i64(v, "completed_at_unix_ms"))
                .transpose()?,
            operation: ImportSessionOperation::parse(&row.4)?,
            status: ImportSessionStatus::parse(&row.5)?,
            library_root: row.6.into(),
            source_fingerprint: row.7,
            source_identity: row
                .8
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|_| {
                    invalid_text(
                        "session.source_identity",
                        row.8.as_deref().unwrap_or_default(),
                    )
                })?,
            file_count: usize::try_from(row.9).map_err(|_| invalid("file_count", row.9))?,
            total_size_bytes: from_i64(row.10, "total_size_bytes")?,
            last_error: row.11,
            pause_requested: row.12,
            cancel_requested: row.13,
            move_confirmed: row.14,
            completed_file_count: usize::try_from(row.15)
                .map_err(|_| invalid("completed_file_count", row.15))?,
            completed_size_bytes: from_i64(row.16, "completed_size_bytes")?,
            item_count: usize::try_from(row.17).map_err(|_| invalid("item_count", row.17))?,
            completed_item_count: usize::try_from(row.18)
                .map_err(|_| invalid("completed_item_count", row.18))?,
            operations,
        }))
    }

    pub fn list_import_sessions(&self) -> Result<Vec<ImportSession>, ManifestError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT id FROM import_sessions ORDER BY created_at_unix_ms DESC")?;
        let ids: Vec<String> = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        ids.iter()
            .map(|id| {
                self.get_import_session(id)
                    .and_then(|session| session.ok_or_else(|| invalid_text("session.id", id)))
            })
            .collect()
    }

    pub fn next_import_operation(
        &self,
        session_id: &str,
    ) -> Result<Option<ImportOperationRecord>, ManifestError> {
        let connection = self.connection()?;
        let id = connection.query_row(
            "SELECT id FROM import_operations WHERE session_id = ?1 AND status IN ('pending', 'failed') ORDER BY ordinal LIMIT 1",
            [session_id], |row| row.get::<_, i64>(0),
        ).optional()?;
        id.map_or(Ok(None), |id| self.get_operation(id))
    }

    pub fn set_session_running(&self, id: &str) -> Result<(), ManifestError> {
        self.connection()?.execute(
            "UPDATE import_sessions SET status = 'running', updated_at_unix_ms = ?2,
             pause_requested = 0, cancel_requested = 0, last_error = NULL WHERE id = ?1",
            params![id, to_i64(now_unix_ms(), "updated_at_unix_ms")?],
        )?;
        Ok(())
    }

    pub fn set_session_queued(&self, id: &str) -> Result<(), ManifestError> {
        self.mark_session_status(id, ImportSessionStatus::Queued, None)
    }

    pub fn request_session_pause(&self, id: &str) -> Result<(), ManifestError> {
        self.connection()?.execute(
            "UPDATE import_sessions SET pause_requested = 1 WHERE id = ?1 AND status = 'running'",
            [id],
        )?;
        Ok(())
    }

    pub fn request_session_cancel(&self, id: &str) -> Result<(), ManifestError> {
        self.connection()?.execute("UPDATE import_sessions SET cancel_requested = 1 WHERE id = ?1 AND status IN ('planned', 'running', 'paused', 'failed')", [id])?;
        Ok(())
    }

    pub fn session_control(&self, id: &str) -> Result<SessionControl, ManifestError> {
        self.connection()?
            .query_row(
                "SELECT pause_requested, cancel_requested FROM import_sessions WHERE id = ?1",
                [id],
                |row| {
                    Ok(SessionControl {
                        pause_requested: row.get(0)?,
                        cancel_requested: row.get(1)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    pub fn mark_session_status(
        &self,
        id: &str,
        status: ImportSessionStatus,
        error: Option<&str>,
    ) -> Result<(), ManifestError> {
        let now = now_unix_ms();
        let completed = matches!(
            status,
            ImportSessionStatus::Completed | ImportSessionStatus::Cancelled
        );
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE import_sessions SET status = ?2, updated_at_unix_ms = ?3,
             completed_at_unix_ms = CASE WHEN ?4 THEN ?3 ELSE completed_at_unix_ms END,
             last_error = ?5 WHERE id = ?1",
            params![
                id,
                status.as_str(),
                to_i64(now, "updated_at_unix_ms")?,
                completed,
                error
            ],
        )?;
        if completed {
            transaction.execute(
                "DELETE FROM destination_reservations WHERE session_id = ?1",
                [id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn mark_operation_status(
        &self,
        id: i64,
        status: OperationStatus,
        error: Option<&str>,
    ) -> Result<(), ManifestError> {
        self.connection()?.execute(
            "UPDATE import_operations SET status = ?2, last_error = ?3,
             attempts = attempts + CASE WHEN ?2 = 'copying' THEN 1 ELSE 0 END WHERE id = ?1",
            params![id, status.as_str(), error],
        )?;
        Ok(())
    }

    pub fn complete_import_operation(
        &self,
        id: i64,
        hash: &str,
        record: &ImportedFileRecord,
    ) -> Result<(), ManifestError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO imported_files (content_sha256, size_bytes, original_name, source_relative_path, imported_path, imported_at_unix_ms, source_fingerprint, event_name, import_session_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, (SELECT session_id FROM import_operations WHERE id = ?9))
             ON CONFLICT(content_sha256) DO UPDATE SET imported_path = excluded.imported_path,
             imported_at_unix_ms = excluded.imported_at_unix_ms, source_fingerprint = excluded.source_fingerprint,
             event_name = excluded.event_name, import_session_id = excluded.import_session_id",
            params![hash, to_i64(record.size_bytes, "size_bytes")?, record.original_name,
                record.source_relative_path.to_string_lossy(), record.imported_path.to_string_lossy(),
                to_i64(record.imported_at_unix_ms, "imported_at_unix_ms")?, record.source_fingerprint, record.event_name, id],
        )?;
        transaction.execute(
            "UPDATE import_operations SET status = 'completed', source_sha256 = ?2,
             destination_sha256 = ?2, last_error = NULL WHERE id = ?1",
            params![id, hash],
        )?;
        transaction.execute(
            "UPDATE import_sessions SET updated_at_unix_ms = ?2
             WHERE id = (SELECT session_id FROM import_operations WHERE id = ?1)",
            params![id, to_i64(now_unix_ms(), "updated_at_unix_ms")?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn item_operations(
        &self,
        session_id: &str,
        item_key: &str,
    ) -> Result<Vec<ImportOperationRecord>, ManifestError> {
        self.list_import_operations(session_id).map(|ops| {
            ops.into_iter()
                .filter(|op| op.item_key == item_key)
                .collect()
        })
    }

    pub fn relink_session_source(
        &self,
        session_id: &str,
        source_root: &Path,
    ) -> Result<(), ManifestError> {
        let operations = self.list_import_operations(session_id)?;
        let connection = self.connection()?;
        for operation in operations {
            if operation
                .source_relative_path
                .components()
                .any(|component| {
                    matches!(
                        component,
                        std::path::Component::ParentDir
                            | std::path::Component::RootDir
                            | std::path::Component::Prefix(_)
                    )
                })
            {
                return Err(invalid_text(
                    "operation.source_relative_path",
                    &operation.source_relative_path.to_string_lossy(),
                ));
            }
            connection.execute(
                "UPDATE import_operations SET source_path = ?2 WHERE id = ?1",
                params![
                    operation.id,
                    source_root
                        .join(&operation.source_relative_path)
                        .to_string_lossy()
                ],
            )?;
        }
        Ok(())
    }

    /// Validates the persisted plan against the reconnected source and the
    /// already published destinations before changing any absolute paths.
    pub fn validate_and_relink_session_source(
        &self,
        session_id: &str,
        source_root: &Path,
    ) -> Result<(), ManifestError> {
        let operations = self.list_import_operations(session_id)?;
        for operation in &operations {
            if operation.status == OperationStatus::Completed {
                let expected = operation.destination_sha256.as_deref().ok_or_else(|| {
                    ManifestError::SourceValidation(format!(
                        "brak sumy kontrolnej ukończonego pliku {}",
                        operation.destination_path.display()
                    ))
                })?;
                if !operation.destination_path.is_file()
                    || hash_file(&operation.destination_path)? != expected
                {
                    return Err(ManifestError::SourceValidation(format!(
                        "ukończony plik docelowy zmienił się: {}",
                        operation.destination_path.display()
                    )));
                }
                continue;
            }
            let candidate = source_root.join(&operation.source_relative_path);
            let actual = std::fs::metadata(&candidate)
                .map_err(|_| {
                    ManifestError::SourceValidation(format!(
                        "brak oczekiwanego pliku źródłowego: {}",
                        operation.source_relative_path.display()
                    ))
                })?
                .len();
            if actual != operation.size_bytes {
                return Err(ManifestError::SourceValidation(format!(
                    "zmienił się rozmiar pliku {} (oczekiwano {}, znaleziono {})",
                    operation.source_relative_path.display(),
                    operation.size_bytes,
                    actual
                )));
            }
        }
        self.relink_session_source(session_id, source_root)
    }

    pub fn mark_source_deleted(&self, operation_id: i64) -> Result<(), ManifestError> {
        self.connection()?.execute(
            "UPDATE import_operations SET source_deleted = 1 WHERE id = ?1",
            [operation_id],
        )?;
        Ok(())
    }

    pub fn remove_imported_record_for_session(
        &self,
        session_id: &str,
        content_sha256: &str,
    ) -> Result<usize, ManifestError> {
        self.connection()?
            .execute(
                "DELETE FROM imported_files WHERE content_sha256 = ?1 AND import_session_id = ?2",
                params![content_sha256, session_id],
            )
            .map_err(Into::into)
    }

    pub fn recover_interrupted_sessions(&self) -> Result<(), ManifestError> {
        let connection = self.connection()?;
        connection.execute("UPDATE import_operations SET status = 'pending', last_error = 'Import przerwany przed zakończeniem pliku.' WHERE status IN ('copying', 'verifying')", [])?;
        connection.execute("UPDATE import_sessions SET status = 'paused', pause_requested = 0, cancel_requested = 0, last_error = 'Import został przerwany przez zamknięcie aplikacji. Można go bezpiecznie wznowić.' WHERE status IN ('running', 'queued')", [])?;
        connection.execute("UPDATE import_sessions SET status = 'rollbackFailed', last_error = 'Wycofanie zostało przerwane przez zamknięcie aplikacji. Można je ponowić.' WHERE status = 'rollingBack'", [])?;
        Ok(())
    }

    fn list_import_operations(
        &self,
        session_id: &str,
    ) -> Result<Vec<ImportOperationRecord>, ManifestError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, ordinal, item_key, event_name, source_path, source_relative_path,
                    destination_path, destination_relative_path, kind, size_bytes, status,
                    source_sha256, destination_sha256, attempts, last_error, source_deleted
             FROM import_operations WHERE session_id = ?1 ORDER BY ordinal",
        )?;
        let rows = statement.query_map([session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, i64>(13)?,
                row.get::<_, Option<String>>(14)?,
                row.get::<_, bool>(15)?,
            ))
        })?;
        rows.map(|row| operation_from_row(row?)).collect()
    }

    fn get_operation(&self, id: i64) -> Result<Option<ImportOperationRecord>, ManifestError> {
        let connection = self.connection()?;
        let row = connection
            .query_row(
                "SELECT id, ordinal, item_key, event_name, source_path, source_relative_path,
                    destination_path, destination_relative_path, kind, size_bytes, status,
                    source_sha256, destination_sha256, attempts, last_error, source_deleted
             FROM import_operations WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, Option<String>>(12)?,
                        row.get::<_, i64>(13)?,
                        row.get::<_, Option<String>>(14)?,
                        row.get::<_, bool>(15)?,
                    ))
                },
            )
            .optional()?;
        row.map(operation_from_row).transpose()
    }
}

type OperationRow = (
    i64,
    i64,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    String,
    Option<String>,
    Option<String>,
    i64,
    Option<String>,
    bool,
);

fn operation_from_row(row: OperationRow) -> Result<ImportOperationRecord, ManifestError> {
    Ok(ImportOperationRecord {
        id: row.0,
        ordinal: usize::try_from(row.1).map_err(|_| invalid("operation.ordinal", row.1))?,
        item_key: row.2,
        event_name: row.3,
        source_path: row.4.into(),
        source_relative_path: row.5.into(),
        destination_path: row.6.into(),
        destination_relative_path: row.7.into(),
        kind: row.8,
        size_bytes: from_i64(row.9, "operation.size_bytes")?,
        status: OperationStatus::parse(&row.10)?,
        source_sha256: row.11,
        destination_sha256: row.12,
        attempts: u32::try_from(row.13).map_err(|_| invalid("operation.attempts", row.13))?,
        last_error: row.14,
        source_deleted: row.15,
    })
}

impl ImportSessionOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Copy => "copy",
            Self::MoveAfterVerification => "moveAfterVerification",
        }
    }
    fn parse(value: &str) -> Result<Self, ManifestError> {
        match value {
            "copy" => Ok(Self::Copy),
            "moveAfterVerification" => Ok(Self::MoveAfterVerification),
            _ => Err(invalid_text("session.operation", value)),
        }
    }
}
impl ImportSessionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::FailedRecoverable => "failedRecoverable",
            Self::RollingBack => "rollingBack",
            Self::RollbackFailed => "rollbackFailed",
            Self::Cancelled => "cancelled",
        }
    }
    fn parse(value: &str) -> Result<Self, ManifestError> {
        match value {
            "planned" => Ok(Self::Planned),
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "paused" => Ok(Self::Paused),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "failedRecoverable" => Ok(Self::FailedRecoverable),
            "rollingBack" => Ok(Self::RollingBack),
            "rollbackFailed" => Ok(Self::RollbackFailed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(invalid_text("session.status", value)),
        }
    }
}
impl OperationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Copying => "copying",
            Self::Verifying => "verifying",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
    fn parse(value: &str) -> Result<Self, ManifestError> {
        match value {
            "pending" => Ok(Self::Pending),
            "copying" => Ok(Self::Copying),
            "verifying" => Ok(Self::Verifying),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            _ => Err(invalid_text("operation.status", value)),
        }
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}
fn from_i64(value: i64, field: &'static str) -> Result<u64, ManifestError> {
    u64::try_from(value).map_err(|_| invalid(field, value))
}
fn invalid(field: &'static str, value: i64) -> ManifestError {
    invalid_text(field, &value.to_string())
}
fn invalid_text(field: &'static str, value: &str) -> ManifestError {
    ManifestError::InvalidStoredValue {
        field,
        value: value.to_owned(),
    }
}

#[allow(dead_code)]
fn _path_is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}
