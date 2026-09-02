//! Versioned SQLite manifest of files already imported into the library.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

mod sessions;

pub use sessions::{
    ImportOperationRecord, ImportSession, ImportSessionOperation, ImportSessionStatus,
    NewImportOperation, NewImportSession, OperationStatus, SessionControl, SessionSourceIdentity,
};

const CURRENT_SCHEMA_VERSION: i64 = 9;
const QUICK_HASH_CHUNK_BYTES: usize = 128 * 1024;
const PROGRESS_REPORT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ImportManifest {
    database_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileCandidate {
    pub item_key: String,
    pub path: PathBuf,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRecognition {
    pub item_key: String,
    pub path: PathBuf,
    pub state: FileImportState,
    pub content_sha256: Option<String>,
    pub imported_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecognitionProgress {
    pub processed_file_count: usize,
    pub total_file_count: usize,
    pub bytes_read: u64,
    pub current_path: Option<PathBuf>,
    pub cache_hit_count: usize,
    pub fully_hashed_file_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileImportState {
    New,
    Imported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFileRecord {
    pub content_sha256: String,
    pub size_bytes: u64,
    pub original_name: String,
    pub source_relative_path: PathBuf,
    pub imported_path: PathBuf,
    pub imported_at_unix_ms: u64,
    pub source_fingerprint: Option<String>,
    pub event_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceWorkflowRecord {
    pub source_root: PathBuf,
    pub state: String,
    pub source_identity_json: Option<String>,
    pub display_name: String,
    pub scan_json: String,
    pub plan_json: String,
    pub settings_schema_version: u32,
    pub settings_revision: String,
    pub editor_json: String,
    pub error: Option<String>,
    pub updated_at_unix_ms: u64,
}

#[derive(Debug, Error)]
pub enum ManifestError {
    #[error("cannot prepare manifest directory {path}: {source}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("manifest database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("manifest schema version {found} is newer than supported version {supported}")]
    UnsupportedSchema { found: i64, supported: i64 },
    #[error("file value is too large for SQLite: {field}={value}")]
    ValueTooLarge { field: &'static str, value: u64 },
    #[error("cannot hash file {path}: {source}")]
    HashFile {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("file recognition was cancelled")]
    Cancelled,
    #[error("invalid value stored in manifest: {field}={value}")]
    InvalidStoredValue { field: &'static str, value: String },
    #[error("destination already exists: {0}")]
    DestinationConflict(PathBuf),
    #[error("source already has an unfinished import session: {0}")]
    ActiveSourceSession(String),
    #[error("cannot roll back a file changed after import: {0}")]
    RollbackConflict(PathBuf),
    #[error("cannot remove imported file {path}: {source}")]
    RollbackFile {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("source validation failed: {0}")]
    SourceValidation(String),
}

impl ImportManifest {
    pub fn open(database_path: impl Into<PathBuf>) -> Result<Self, ManifestError> {
        let manifest = Self {
            database_path: database_path.into(),
        };
        if let Some(parent) = manifest.database_path.parent() {
            fs::create_dir_all(parent).map_err(|source| ManifestError::CreateDirectory {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let connection = manifest.connection()?;
        migrate(&connection)?;
        manifest.recover_interrupted_sessions()?;
        Ok(manifest)
    }

    #[must_use]
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn record_imports(&self, records: &[ImportedFileRecord]) -> Result<(), ManifestError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        for record in records {
            transaction.execute(
                "INSERT INTO imported_files (
                    content_sha256, size_bytes, original_name, source_relative_path,
                    imported_path, imported_at_unix_ms, source_fingerprint, event_name
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(content_sha256) DO UPDATE SET
                    imported_path = excluded.imported_path,
                    imported_at_unix_ms = excluded.imported_at_unix_ms,
                    source_fingerprint = excluded.source_fingerprint,
                    event_name = excluded.event_name",
                params![
                    record.content_sha256,
                    to_i64(record.size_bytes, "size_bytes")?,
                    record.original_name,
                    record.source_relative_path.to_string_lossy(),
                    record.imported_path.to_string_lossy(),
                    to_i64(record.imported_at_unix_ms, "imported_at_unix_ms")?,
                    record.source_fingerprint,
                    record.event_name,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn recognize_files(
        &self,
        candidates: &[FileCandidate],
    ) -> Result<Vec<FileRecognition>, ManifestError> {
        self.recognize_files_with_progress(candidates, None, None, |_| {}, || false)
    }

    pub fn recognize_files_with_progress(
        &self,
        candidates: &[FileCandidate],
        source_identity: Option<&str>,
        source_root: Option<&Path>,
        mut on_progress: impl FnMut(RecognitionProgress),
        is_cancelled: impl Fn() -> bool,
    ) -> Result<Vec<FileRecognition>, ManifestError> {
        let connection = self.connection()?;
        let known_sizes: HashSet<u64> = {
            let mut statement =
                connection.prepare("SELECT DISTINCT size_bytes FROM imported_files")?;
            statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .filter_map(Result::ok)
                .filter_map(|value| u64::try_from(value).ok())
                .collect()
        };

        let mut progress = RecognitionProgress {
            processed_file_count: 0,
            total_file_count: candidates.len(),
            bytes_read: 0,
            current_path: None,
            cache_hit_count: 0,
            fully_hashed_file_count: 0,
        };
        let mut recognitions = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            if is_cancelled() {
                return Err(ManifestError::Cancelled);
            }
            progress.current_path = Some(candidate.path.clone());
            let recognition = if !known_sizes.contains(&candidate.size_bytes) {
                FileRecognition {
                    item_key: candidate.item_key.clone(),
                    path: candidate.path.clone(),
                    state: FileImportState::New,
                    content_sha256: None,
                    imported_path: None,
                }
            } else {
                let cache_key = source_identity
                    .zip(source_root)
                    .and_then(|(identity, root)| {
                        let relative_path = candidate.path.strip_prefix(root).ok()?;
                        let modified_at_unix_ms = file_modified_at_unix_ms(&candidate.path)?;
                        Some((identity, relative_path, modified_at_unix_ms))
                    });
                let cached = if let Some((identity, relative_path, modified_at_unix_ms)) = cache_key
                {
                    lookup_cached_hash(
                        &connection,
                        identity,
                        relative_path,
                        candidate.size_bytes,
                        modified_at_unix_ms,
                    )?
                } else {
                    None
                };
                let hash = if let Some((cached_quick_hash, cached_hash)) = cached {
                    let (quick_hash, read) = quick_hash_file(&candidate.path, &is_cancelled)?;
                    progress.bytes_read = progress.bytes_read.saturating_add(read);
                    if quick_hash == cached_quick_hash {
                        progress.cache_hit_count += 1;
                        cached_hash
                    } else {
                        let mut last_reported_bytes = progress.bytes_read;
                        let hash = hash_file_with_progress(
                            &candidate.path,
                            |read| {
                                progress.bytes_read = progress.bytes_read.saturating_add(read);
                                if progress.bytes_read.saturating_sub(last_reported_bytes)
                                    >= PROGRESS_REPORT_BYTES
                                {
                                    last_reported_bytes = progress.bytes_read;
                                    on_progress(progress.clone());
                                }
                            },
                            &is_cancelled,
                        )?;
                        progress.fully_hashed_file_count += 1;
                        store_cached_hash(
                            &connection,
                            cache_key,
                            candidate.size_bytes,
                            &quick_hash,
                            &hash,
                        )?;
                        hash
                    }
                } else {
                    let (quick_hash, read) = quick_hash_file(&candidate.path, &is_cancelled)?;
                    progress.bytes_read = progress.bytes_read.saturating_add(read);
                    let mut last_reported_bytes = progress.bytes_read;
                    let hash = hash_file_with_progress(
                        &candidate.path,
                        |read| {
                            progress.bytes_read = progress.bytes_read.saturating_add(read);
                            if progress.bytes_read.saturating_sub(last_reported_bytes)
                                >= PROGRESS_REPORT_BYTES
                            {
                                last_reported_bytes = progress.bytes_read;
                                on_progress(progress.clone());
                            }
                        },
                        &is_cancelled,
                    )?;
                    progress.fully_hashed_file_count += 1;
                    store_cached_hash(
                        &connection,
                        cache_key,
                        candidate.size_bytes,
                        &quick_hash,
                        &hash,
                    )?;
                    hash
                };
                let imported_path = connection
                    .query_row(
                        "SELECT imported_path FROM imported_files WHERE content_sha256 = ?1",
                        [&hash],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;
                FileRecognition {
                    item_key: candidate.item_key.clone(),
                    path: candidate.path.clone(),
                    state: if imported_path.is_some() {
                        FileImportState::Imported
                    } else {
                        FileImportState::New
                    },
                    content_sha256: Some(hash),
                    imported_path: imported_path.map(PathBuf::from),
                }
            };
            recognitions.push(recognition);
            progress.processed_file_count += 1;
            on_progress(progress.clone());
        }
        Ok(recognitions)
    }

    pub fn cache_verified_source_file(
        &self,
        source_identity: &str,
        relative_path: &Path,
        source_path: &Path,
        size_bytes: u64,
        content_sha256: &str,
    ) -> Result<(), ManifestError> {
        let Some(modified_at_unix_ms) = file_modified_at_unix_ms(source_path) else {
            return Ok(());
        };
        let (quick_hash, _) = quick_hash_file(source_path, &|| false)?;
        let connection = self.connection()?;
        store_cached_hash(
            &connection,
            Some((source_identity, relative_path, modified_at_unix_ms)),
            size_bytes,
            &quick_hash,
            content_sha256,
        )
    }

    pub fn save_pending_workflow(
        &self,
        source_root: &Path,
        scan_json: &str,
        plan_json: &str,
        updated_at_unix_ms: u64,
    ) -> Result<(), ManifestError> {
        self.save_source_workflow(&SourceWorkflowRecord {
            source_root: source_root.to_path_buf(),
            state: "planReady".to_owned(),
            source_identity_json: None,
            display_name: source_root
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            scan_json: scan_json.to_owned(),
            plan_json: plan_json.to_owned(),
            settings_schema_version: 0,
            settings_revision: String::new(),
            editor_json: "{}".to_owned(),
            error: None,
            updated_at_unix_ms,
        })
    }

    pub fn save_source_workflow(
        &self,
        workflow: &SourceWorkflowRecord,
    ) -> Result<(), ManifestError> {
        self.connection()?.execute(
            "INSERT INTO pending_source_workflows (
                source_root, scan_json, plan_json, updated_at_unix_ms, state,
                source_identity_json, display_name, settings_schema_version,
                settings_revision, editor_json, error
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(source_root) DO UPDATE SET scan_json = excluded.scan_json,
             plan_json = excluded.plan_json, updated_at_unix_ms = excluded.updated_at_unix_ms,
             state = excluded.state, source_identity_json = excluded.source_identity_json,
             display_name = excluded.display_name,
             settings_schema_version = excluded.settings_schema_version,
             settings_revision = excluded.settings_revision,
             editor_json = excluded.editor_json, error = excluded.error",
            params![
                workflow.source_root.to_string_lossy(),
                workflow.scan_json,
                workflow.plan_json,
                to_i64(workflow.updated_at_unix_ms, "updated_at_unix_ms")?,
                workflow.state,
                workflow.source_identity_json,
                workflow.display_name,
                i64::from(workflow.settings_schema_version),
                workflow.settings_revision,
                workflow.editor_json,
                workflow.error,
            ],
        )?;
        Ok(())
    }

    pub fn list_pending_workflows(&self) -> Result<Vec<(PathBuf, String, String)>, ManifestError> {
        Ok(self
            .list_source_workflows()?
            .into_iter()
            .map(|workflow| (workflow.source_root, workflow.scan_json, workflow.plan_json))
            .collect())
    }

    pub fn list_source_workflows(&self) -> Result<Vec<SourceWorkflowRecord>, ManifestError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT source_root, state, source_identity_json, display_name, scan_json,
                    plan_json, settings_schema_version, settings_revision, editor_json,
                    error, updated_at_unix_ms
             FROM pending_source_workflows ORDER BY updated_at_unix_ms DESC",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, i64>(10)?,
                ))
            })?
            .map(|row| {
                let row = row?;
                Ok(SourceWorkflowRecord {
                    source_root: row.0.into(),
                    state: row.1,
                    source_identity_json: row.2,
                    display_name: row.3,
                    scan_json: row.4,
                    plan_json: row.5,
                    settings_schema_version: u32::try_from(row.6).map_err(|_| {
                        ManifestError::InvalidStoredValue {
                            field: "workflow.settings_schema_version",
                            value: row.6.to_string(),
                        }
                    })?,
                    settings_revision: row.7,
                    editor_json: row.8,
                    error: row.9,
                    updated_at_unix_ms: u64::try_from(row.10).map_err(|_| {
                        ManifestError::InvalidStoredValue {
                            field: "workflow.updated_at_unix_ms",
                            value: row.10.to_string(),
                        }
                    })?,
                })
            })
            .collect()
    }

    pub fn delete_pending_workflow(&self, source_root: &Path) -> Result<(), ManifestError> {
        self.connection()?.execute(
            "DELETE FROM pending_source_workflows WHERE source_root = ?1",
            [source_root.to_string_lossy()],
        )?;
        Ok(())
    }

    pub fn update_source_workflow_state(
        &self,
        source_root: &Path,
        state: &str,
        error: Option<&str>,
        updated_at_unix_ms: u64,
    ) -> Result<usize, ManifestError> {
        self.connection()?
            .execute(
                "UPDATE pending_source_workflows SET state = ?2, error = ?3,
             updated_at_unix_ms = ?4 WHERE source_root = ?1",
                params![
                    source_root.to_string_lossy(),
                    state,
                    error,
                    to_i64(updated_at_unix_ms, "updated_at_unix_ms")?
                ],
            )
            .map_err(Into::into)
    }

    pub(crate) fn connection(&self) -> Result<Connection, ManifestError> {
        let connection = Connection::open(&self.database_path)?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;",
        )?;
        Ok(connection)
    }
}

pub fn hash_file(path: &Path) -> Result<String, ManifestError> {
    hash_file_with_progress(path, |_| {}, || false)
}

pub fn hash_file_with_progress(
    path: &Path,
    mut on_read: impl FnMut(u64),
    is_cancelled: impl Fn() -> bool,
) -> Result<String, ManifestError> {
    let mut file = open_sequential_file(path).map_err(|source| ManifestError::HashFile {
        path: path.to_path_buf(),
        source,
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        if is_cancelled() {
            return Err(ManifestError::Cancelled);
        }
        let read = file
            .read(&mut buffer)
            .map_err(|source| ManifestError::HashFile {
                path: path.to_path_buf(),
                source,
            })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        on_read(u64::try_from(read).unwrap_or(u64::MAX));
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn open_sequential_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_SEQUENTIAL_SCAN: u32 = 0x0800_0000;
        options.custom_flags(FILE_FLAG_SEQUENTIAL_SCAN);
    }
    options.open(path)
}

fn quick_hash_file(
    path: &Path,
    is_cancelled: &impl Fn() -> bool,
) -> Result<(String, u64), ManifestError> {
    let mut file = File::open(path).map_err(|source| ManifestError::HashFile {
        path: path.to_path_buf(),
        source,
    })?;
    let length = file
        .metadata()
        .map_err(|source| ManifestError::HashFile {
            path: path.to_path_buf(),
            source,
        })?
        .len();
    let mut hasher = Sha256::new();
    hasher.update(length.to_le_bytes());
    let mut bytes_read = 0_u64;
    let head_length = usize::try_from(length.min(QUICK_HASH_CHUNK_BYTES as u64))
        .unwrap_or(QUICK_HASH_CHUNK_BYTES);
    let mut head = vec![0_u8; head_length];
    read_exact_for_hash(&mut file, &mut head, path, is_cancelled)?;
    bytes_read = bytes_read.saturating_add(head.len() as u64);
    hasher.update(&head);
    if length > QUICK_HASH_CHUNK_BYTES as u64 {
        let tail_length = usize::try_from(length.min(QUICK_HASH_CHUNK_BYTES as u64))
            .unwrap_or(QUICK_HASH_CHUNK_BYTES);
        file.seek(SeekFrom::End(-(tail_length as i64)))
            .map_err(|source| ManifestError::HashFile {
                path: path.to_path_buf(),
                source,
            })?;
        let mut tail = vec![0_u8; tail_length];
        read_exact_for_hash(&mut file, &mut tail, path, is_cancelled)?;
        bytes_read = bytes_read.saturating_add(tail.len() as u64);
        hasher.update(&tail);
    }
    Ok((format!("{:x}", hasher.finalize()), bytes_read))
}

fn read_exact_for_hash(
    file: &mut File,
    buffer: &mut [u8],
    path: &Path,
    is_cancelled: &impl Fn() -> bool,
) -> Result<(), ManifestError> {
    if is_cancelled() {
        return Err(ManifestError::Cancelled);
    }
    file.read_exact(buffer)
        .map_err(|source| ManifestError::HashFile {
            path: path.to_path_buf(),
            source,
        })
}

fn file_modified_at_unix_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn lookup_cached_hash(
    connection: &Connection,
    source_identity: &str,
    relative_path: &Path,
    size_bytes: u64,
    modified_at_unix_ms: u64,
) -> Result<Option<(String, String)>, ManifestError> {
    connection
        .query_row(
            "SELECT quick_sha256, content_sha256 FROM source_file_cache
             WHERE source_identity = ?1 AND relative_path = ?2
             AND size_bytes = ?3 AND modified_at_unix_ms = ?4",
            params![
                source_identity,
                relative_path.to_string_lossy(),
                to_i64(size_bytes, "size_bytes")?,
                to_i64(modified_at_unix_ms, "modified_at_unix_ms")?,
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(Into::into)
}

fn store_cached_hash(
    connection: &Connection,
    cache_key: Option<(&str, &Path, u64)>,
    size_bytes: u64,
    quick_hash: &str,
    hash: &str,
) -> Result<(), ManifestError> {
    let Some((source_identity, relative_path, modified_at_unix_ms)) = cache_key else {
        return Ok(());
    };
    connection.execute(
        "INSERT INTO source_file_cache (
            source_identity, relative_path, size_bytes, modified_at_unix_ms,
            quick_sha256, content_sha256
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(source_identity, relative_path) DO UPDATE SET
            size_bytes = excluded.size_bytes,
            modified_at_unix_ms = excluded.modified_at_unix_ms,
            quick_sha256 = excluded.quick_sha256,
            content_sha256 = excluded.content_sha256",
        params![
            source_identity,
            relative_path.to_string_lossy(),
            to_i64(size_bytes, "size_bytes")?,
            to_i64(modified_at_unix_ms, "modified_at_unix_ms")?,
            quick_hash,
            hash,
        ],
    )?;
    Ok(())
}

fn migrate(connection: &Connection) -> Result<(), ManifestError> {
    let mut version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(ManifestError::UnsupportedSchema {
            found: version,
            supported: CURRENT_SCHEMA_VERSION,
        });
    }
    if version == 0 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE imported_files (
                content_sha256 TEXT PRIMARY KEY NOT NULL CHECK(length(content_sha256) = 64),
                size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
                original_name TEXT NOT NULL,
                source_relative_path TEXT NOT NULL,
                imported_path TEXT NOT NULL,
                imported_at_unix_ms INTEGER NOT NULL,
                source_fingerprint TEXT,
                event_name TEXT
             );
             CREATE INDEX imported_files_size_idx ON imported_files(size_bytes);
             PRAGMA user_version = 1;
             COMMIT;",
        )?;
        version = 1;
    }
    if version == 1 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE import_sessions (
                id TEXT PRIMARY KEY NOT NULL,
                created_at_unix_ms INTEGER NOT NULL,
                updated_at_unix_ms INTEGER NOT NULL,
                completed_at_unix_ms INTEGER,
                operation TEXT NOT NULL CHECK(operation IN ('copy', 'moveAfterVerification')),
                status TEXT NOT NULL CHECK(status IN ('planned', 'queued', 'running', 'paused', 'completed', 'failed', 'failedRecoverable', 'rollingBack', 'rollbackFailed', 'cancelled')),
                library_root TEXT NOT NULL,
                source_fingerprint TEXT,
                file_count INTEGER NOT NULL CHECK(file_count >= 0),
                total_size_bytes INTEGER NOT NULL CHECK(total_size_bytes >= 0),
                last_error TEXT,
                pause_requested INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0, 1)),
                cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
                move_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(move_confirmed IN (0, 1))
             );
             CREATE TABLE import_operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES import_sessions(id) ON DELETE CASCADE,
                ordinal INTEGER NOT NULL,
                item_key TEXT NOT NULL,
                event_name TEXT NOT NULL,
                source_path TEXT NOT NULL,
                source_relative_path TEXT NOT NULL,
                destination_path TEXT NOT NULL,
                destination_relative_path TEXT NOT NULL,
                kind TEXT NOT NULL,
                size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
                status TEXT NOT NULL CHECK(status IN ('pending', 'copying', 'verifying', 'completed', 'failed')),
                source_sha256 TEXT,
                destination_sha256 TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                source_deleted INTEGER NOT NULL DEFAULT 0 CHECK(source_deleted IN (0, 1)),
                UNIQUE(session_id, ordinal),
                UNIQUE(session_id, destination_path)
             );
             CREATE INDEX import_operations_session_status_idx
                ON import_operations(session_id, status, ordinal);
             PRAGMA user_version = 2;
             COMMIT;",
        )?;
        version = 2;
    }
    if version == 2 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE imported_files ADD COLUMN import_session_id TEXT;
             CREATE INDEX imported_files_session_idx ON imported_files(import_session_id);
             PRAGMA user_version = 3;
             COMMIT;",
        )?;
        version = 3;
    }
    if version == 3 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE pending_source_workflows (
                source_root TEXT PRIMARY KEY NOT NULL,
                scan_json TEXT NOT NULL,
                plan_json TEXT NOT NULL,
                updated_at_unix_ms INTEGER NOT NULL
             );
             PRAGMA user_version = 4;
             COMMIT;",
        )?;
        version = 4;
    }
    if version == 4 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE destination_reservations (
                destination_path TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL REFERENCES import_sessions(id) ON DELETE CASCADE
             );
             CREATE INDEX destination_reservations_session_idx
                ON destination_reservations(session_id);
             PRAGMA user_version = 5;
             COMMIT;",
        )?;
        version = 5;
    }
    if version == 5 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE source_file_cache (
                source_identity TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
                modified_at_unix_ms INTEGER NOT NULL CHECK(modified_at_unix_ms >= 0),
                quick_sha256 TEXT NOT NULL CHECK(length(quick_sha256) = 64),
                content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
                PRIMARY KEY(source_identity, relative_path)
             );
             CREATE INDEX source_file_cache_hash_idx ON source_file_cache(content_sha256);
             PRAGMA user_version = 6;
             COMMIT;",
        )?;
        version = 6;
    }
    if version == 6 {
        connection.execute_batch(
            "PRAGMA foreign_keys = OFF;
             BEGIN IMMEDIATE;
             CREATE TABLE import_sessions_v7 (
                id TEXT PRIMARY KEY NOT NULL,
                created_at_unix_ms INTEGER NOT NULL,
                updated_at_unix_ms INTEGER NOT NULL,
                completed_at_unix_ms INTEGER,
                operation TEXT NOT NULL CHECK(operation IN ('copy', 'moveAfterVerification')),
                status TEXT NOT NULL CHECK(status IN ('planned', 'queued', 'running', 'paused', 'completed', 'failed', 'failedRecoverable', 'rollingBack', 'rollbackFailed', 'cancelled')),
                library_root TEXT NOT NULL,
                source_fingerprint TEXT,
                source_identity_json TEXT,
                file_count INTEGER NOT NULL CHECK(file_count >= 0),
                total_size_bytes INTEGER NOT NULL CHECK(total_size_bytes >= 0),
                last_error TEXT,
                pause_requested INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0, 1)),
                cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
                move_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(move_confirmed IN (0, 1))
             );
             INSERT INTO import_sessions_v7 (
                id, created_at_unix_ms, updated_at_unix_ms, completed_at_unix_ms,
                operation, status, library_root, source_fingerprint, file_count,
                total_size_bytes, last_error, pause_requested, cancel_requested, move_confirmed
             ) SELECT id, created_at_unix_ms, updated_at_unix_ms, completed_at_unix_ms,
                operation, status, library_root, source_fingerprint, file_count,
                total_size_bytes, last_error, pause_requested, cancel_requested, move_confirmed
               FROM import_sessions;
             DROP TABLE import_sessions;
             ALTER TABLE import_sessions_v7 RENAME TO import_sessions;
             PRAGMA user_version = 7;
             COMMIT;
             PRAGMA foreign_keys = ON;",
        )?;
        version = 7;
    }
    if version == 7 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE pending_source_workflows ADD COLUMN state TEXT NOT NULL DEFAULT 'planReady';
             ALTER TABLE pending_source_workflows ADD COLUMN source_identity_json TEXT;
             ALTER TABLE pending_source_workflows ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
             ALTER TABLE pending_source_workflows ADD COLUMN settings_schema_version INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE pending_source_workflows ADD COLUMN error TEXT;
             PRAGMA user_version = 8;
             COMMIT;",
        )?;
        version = 8;
    }
    if version == 8 {
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE pending_source_workflows ADD COLUMN settings_revision TEXT NOT NULL DEFAULT '';
             ALTER TABLE pending_source_workflows ADD COLUMN editor_json TEXT NOT NULL DEFAULT '{}';
             PRAGMA user_version = 9;
             COMMIT;",
        )?;
    }
    Ok(())
}

pub(crate) fn to_i64(value: u64, field: &'static str) -> Result<i64, ManifestError> {
    i64::try_from(value).map_err(|_| ManifestError::ValueTooLarge { field, value })
}
