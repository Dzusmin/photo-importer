//! Local-disk photo backup with stable target identities and version retention.
//!
//! Every destination contains a readable `Photo Backup/Photos` tree. Internal
//! state and older versions live below the hidden-by-convention
//! `Photo Backup/.photo-importer` directory.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use walkdir::WalkDir;

pub const BACKUP_DIRECTORY: &str = "Photo Backup";
pub const PHOTOS_DIRECTORY: &str = "Photos";
pub const TECHNICAL_DIRECTORY: &str = ".photo-importer";

const MARKER_FILE: &str = "target.json";
const MANIFEST_FILE: &str = "manifest.sqlite3";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTarget {
    pub id: Uuid,
    pub label: String,
    pub last_known_root: PathBuf,
    pub created_at_unix_ms: u64,
    pub last_seen_at_unix_ms: u64,
}

#[derive(Debug, Clone)]
pub struct TargetRegistry {
    database_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct BackupEngine {
    target: BackupTarget,
    target_root: PathBuf,
    backup_root: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupOperationKind {
    New,
    Changed,
    Repair,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupOperation {
    pub relative_path: PathBuf,
    pub source_path: PathBuf,
    pub destination_path: PathBuf,
    pub kind: BackupOperationKind,
    pub size_bytes: u64,
    pub source_sha256: String,
    pub previous_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPlan {
    pub target_id: Uuid,
    pub source_root: PathBuf,
    pub operations: Vec<BackupOperation>,
    pub unchanged_file_count: usize,
    pub total_copy_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    pub copied_file_count: usize,
    pub unchanged_file_count: usize,
    pub versioned_file_count: usize,
    pub copied_bytes: u64,
}

#[derive(Debug, Error)]
pub enum BackupError {
    #[error("backup target root is not an existing directory: {0}")]
    InvalidTargetRoot(PathBuf),
    #[error("source root is not an existing directory: {0}")]
    InvalidSourceRoot(PathBuf),
    #[error("source and backup destination overlap")]
    OverlappingRoots,
    #[error("backup target {expected} is not mounted at {path} (found {found:?})")]
    WrongTarget {
        expected: Uuid,
        found: Option<Uuid>,
        path: PathBuf,
    },
    #[error("target marker at {path} is invalid: {source}")]
    InvalidMarker {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("cannot access {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("cannot scan source: {0}")]
    Scan(#[from] walkdir::Error),
    #[error("unsafe relative path: {0}")]
    UnsafeRelativePath(PathBuf),
    #[error("source changed while backing up: {0}")]
    SourceChanged(PathBuf),
    #[error("SHA-256 verification failed for {0}")]
    VerificationFailed(PathBuf),
    #[error("backup plan belongs to a different target")]
    WrongPlanTarget,
    #[error("numeric value is too large for SQLite: {0}")]
    ValueTooLarge(u64),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetMarker {
    format_version: u32,
    target_id: Uuid,
    created_at_unix_ms: u64,
}

impl TargetRegistry {
    pub fn open(database_path: impl Into<PathBuf>) -> Result<Self, BackupError> {
        let database_path = database_path.into();
        if let Some(parent) = database_path.parent() {
            create_dir_all(parent)?;
        }
        let registry = Self { database_path };
        let connection = registry.connection()?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS backup_targets (
                id TEXT PRIMARY KEY NOT NULL,
                label TEXT NOT NULL,
                last_known_root TEXT NOT NULL,
                created_at_unix_ms INTEGER NOT NULL,
                last_seen_at_unix_ms INTEGER NOT NULL
             );",
        )?;
        Ok(registry)
    }

    /// Registers a new disk, or re-attaches a disk that already has our marker.
    pub fn register(
        &self,
        target_root: impl Into<PathBuf>,
        label: impl Into<String>,
    ) -> Result<BackupTarget, BackupError> {
        let target_root = target_root.into();
        if !target_root.is_dir() {
            return Err(BackupError::InvalidTargetRoot(target_root));
        }
        let label = label.into();
        let technical_root = technical_root(&target_root);
        create_dir_all(&technical_root)?;
        let marker_path = technical_root.join(MARKER_FILE);
        let marker = if marker_path.exists() {
            read_marker(&marker_path)?
        } else {
            let marker = TargetMarker {
                format_version: 1,
                target_id: Uuid::new_v4(),
                created_at_unix_ms: now_ms(),
            };
            write_new_marker(&marker_path, &marker)?;
            marker
        };
        let seen = now_ms();
        let target = BackupTarget {
            id: marker.target_id,
            label,
            last_known_root: target_root,
            created_at_unix_ms: marker.created_at_unix_ms,
            last_seen_at_unix_ms: seen,
        };
        self.upsert(&target)?;
        initialize_manifest(&manifest_path(&target.last_known_root))?;
        create_dir_all(&photos_root(&target.last_known_root))?;
        create_dir_all(&versions_root(&target.last_known_root))?;
        Ok(target)
    }

    pub fn known_targets(&self) -> Result<Vec<BackupTarget>, BackupError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, label, last_known_root, created_at_unix_ms, last_seen_at_unix_ms
             FROM backup_targets ORDER BY label COLLATE NOCASE, id",
        )?;
        let rows = statement.query_map([], target_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Opens a registered target at its current mount point. This identity check
    /// prevents silently writing to a different disk reusing the same drive path.
    pub fn connect(
        &self,
        target_id: Uuid,
        current_root: impl Into<PathBuf>,
    ) -> Result<BackupEngine, BackupError> {
        let current_root = current_root.into();
        if !current_root.is_dir() {
            return Err(BackupError::InvalidTargetRoot(current_root));
        }
        let registered = self.get(target_id)?.ok_or(BackupError::WrongTarget {
            expected: target_id,
            found: None,
            path: current_root.clone(),
        })?;
        let marker_path = technical_root(&current_root).join(MARKER_FILE);
        let found = if marker_path.is_file() {
            Some(read_marker(&marker_path)?.target_id)
        } else {
            None
        };
        if found != Some(target_id) {
            return Err(BackupError::WrongTarget {
                expected: target_id,
                found,
                path: current_root,
            });
        }
        let mut target = BackupTarget {
            last_known_root: current_root.clone(),
            last_seen_at_unix_ms: now_ms(),
            ..registered
        };
        self.upsert(&target)?;
        initialize_manifest(&manifest_path(&current_root))?;
        target.last_known_root = current_root.clone();
        Ok(BackupEngine {
            target,
            target_root: current_root.clone(),
            backup_root: current_root.join(BACKUP_DIRECTORY),
        })
    }

    fn get(&self, id: Uuid) -> Result<Option<BackupTarget>, BackupError> {
        self.connection()?
            .query_row(
                "SELECT id, label, last_known_root, created_at_unix_ms, last_seen_at_unix_ms
                 FROM backup_targets WHERE id = ?1",
                [id.to_string()],
                target_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    fn upsert(&self, target: &BackupTarget) -> Result<(), BackupError> {
        self.connection()?.execute(
            "INSERT INTO backup_targets
                (id, label, last_known_root, created_at_unix_ms, last_seen_at_unix_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET label = excluded.label,
                last_known_root = excluded.last_known_root,
                last_seen_at_unix_ms = excluded.last_seen_at_unix_ms",
            params![
                target.id.to_string(),
                target.label,
                target.last_known_root.to_string_lossy(),
                to_i64(target.created_at_unix_ms)?,
                to_i64(target.last_seen_at_unix_ms)?,
            ],
        )?;
        Ok(())
    }

    fn connection(&self) -> Result<Connection, BackupError> {
        Ok(Connection::open(&self.database_path)?)
    }
}

impl BackupEngine {
    #[must_use]
    pub fn target(&self) -> &BackupTarget {
        &self.target
    }

    #[must_use]
    pub fn photos_root(&self) -> PathBuf {
        self.backup_root.join(PHOTOS_DIRECTORY)
    }

    #[must_use]
    pub fn technical_root(&self) -> PathBuf {
        self.backup_root.join(TECHNICAL_DIRECTORY)
    }

    pub fn plan(&self, source_root: impl Into<PathBuf>) -> Result<BackupPlan, BackupError> {
        let source_root = source_root.into();
        if !source_root.is_dir() {
            return Err(BackupError::InvalidSourceRoot(source_root));
        }
        reject_overlapping_roots(&source_root, &self.target_root)?;
        let connection = Connection::open(manifest_path(&self.target_root))?;
        let mut operations = Vec::new();
        let mut unchanged_file_count = 0;
        let mut total_copy_bytes = 0_u64;
        for entry in WalkDir::new(&source_root).follow_links(false) {
            let entry = entry?;
            if !entry.file_type().is_file() {
                continue;
            }
            let relative_path = entry
                .path()
                .strip_prefix(&source_root)
                .map_err(|_| BackupError::UnsafeRelativePath(entry.path().to_path_buf()))?
                .to_path_buf();
            validate_relative(&relative_path)?;
            let source_sha256 = hash_file(entry.path())?;
            let size_bytes = entry.metadata()?.len();
            let previous = current_record(&connection, &relative_path)?;
            let destination_path = self.photos_root().join(&relative_path);
            let destination_hash = if destination_path.is_file() {
                Some(hash_file(&destination_path)?)
            } else {
                None
            };
            if previous.as_ref().map(|record| record.0.as_str()) == Some(&source_sha256)
                && destination_hash.as_deref() == Some(&source_sha256)
            {
                unchanged_file_count += 1;
                continue;
            }
            let kind = match (&previous, &destination_hash) {
                (None, None) => BackupOperationKind::New,
                (Some((hash, _)), Some(destination))
                    if hash == &source_sha256 && destination != &source_sha256 =>
                {
                    BackupOperationKind::Repair
                }
                _ => BackupOperationKind::Changed,
            };
            total_copy_bytes = total_copy_bytes.saturating_add(size_bytes);
            operations.push(BackupOperation {
                relative_path,
                source_path: entry.path().to_path_buf(),
                destination_path,
                kind,
                size_bytes,
                source_sha256,
                previous_sha256: previous.map(|record| record.0),
            });
        }
        operations.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(BackupPlan {
            target_id: self.target.id,
            source_root,
            operations,
            unchanged_file_count,
            total_copy_bytes,
        })
    }

    pub fn execute(&self, plan: &BackupPlan) -> Result<BackupReport, BackupError> {
        if plan.target_id != self.target.id {
            return Err(BackupError::WrongPlanTarget);
        }
        let mut report = BackupReport {
            copied_file_count: 0,
            unchanged_file_count: plan.unchanged_file_count,
            versioned_file_count: 0,
            copied_bytes: 0,
        };
        let mut connection = Connection::open(manifest_path(&self.target_root))?;
        for operation in &plan.operations {
            validate_relative(&operation.relative_path)?;
            if hash_file(&operation.source_path)? != operation.source_sha256
                || fs::metadata(&operation.source_path)
                    .map_err(|source| io_error(&operation.source_path, source))?
                    .len()
                    != operation.size_bytes
            {
                return Err(BackupError::SourceChanged(operation.source_path.clone()));
            }
            let expected_destination = self.photos_root().join(&operation.relative_path);
            let expected_source = plan.source_root.join(&operation.relative_path);
            if operation.destination_path != expected_destination
                || operation.source_path != expected_source
            {
                return Err(BackupError::UnsafeRelativePath(
                    operation.relative_path.clone(),
                ));
            }
            let parent = expected_destination
                .parent()
                .ok_or_else(|| BackupError::UnsafeRelativePath(operation.relative_path.clone()))?;
            create_dir_all(parent)?;
            let staging = self.technical_root().join("staging");
            create_dir_all(&staging)?;
            let temporary = staging.join(format!("{}.partial", Uuid::new_v4()));
            if let Err(error) = copy_and_sync(&operation.source_path, &temporary) {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
            if hash_file(&temporary)? != operation.source_sha256 {
                let _ = fs::remove_file(&temporary);
                return Err(BackupError::VerificationFailed(
                    operation.destination_path.clone(),
                ));
            }

            let version_path = if operation.destination_path.exists() {
                let old_hash = hash_file(&operation.destination_path)?;
                let path = self.version_path(&operation.relative_path, &old_hash);
                if let Some(parent) = path.parent() {
                    create_dir_all(parent)?;
                }
                fs::rename(&operation.destination_path, &path)
                    .map_err(|source| io_error(&operation.destination_path, source))?;
                Some(path)
            } else {
                None
            };
            if let Err(source) = fs::rename(&temporary, &operation.destination_path) {
                if let Some(version) = &version_path {
                    let _ = fs::rename(version, &operation.destination_path);
                }
                let _ = fs::remove_file(&temporary);
                return Err(io_error(&operation.destination_path, source));
            }
            if hash_file(&operation.destination_path)? != operation.source_sha256 {
                return Err(BackupError::VerificationFailed(
                    operation.destination_path.clone(),
                ));
            }
            let transaction = connection.transaction()?;
            if let Some(version_path) = &version_path {
                transaction.execute(
                    "INSERT INTO file_versions
                        (relative_path, content_sha256, version_path, archived_at_unix_ms)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        path_text(&operation.relative_path),
                        hash_file(version_path)?,
                        path_text(
                            version_path
                                .strip_prefix(&self.backup_root)
                                .unwrap_or(version_path)
                        ),
                        to_i64(now_ms())?,
                    ],
                )?;
            }
            transaction.execute(
                "INSERT INTO current_files
                    (relative_path, content_sha256, size_bytes, backed_up_at_unix_ms)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(relative_path) DO UPDATE SET
                    content_sha256 = excluded.content_sha256,
                    size_bytes = excluded.size_bytes,
                    backed_up_at_unix_ms = excluded.backed_up_at_unix_ms",
                params![
                    path_text(&operation.relative_path),
                    operation.source_sha256,
                    to_i64(operation.size_bytes)?,
                    to_i64(now_ms())?,
                ],
            )?;
            transaction.commit()?;
            report.copied_file_count += 1;
            report.copied_bytes = report.copied_bytes.saturating_add(operation.size_bytes);
            if version_path.is_some() {
                report.versioned_file_count += 1;
            }
        }
        Ok(report)
    }

    fn version_path(&self, relative_path: &Path, hash: &str) -> PathBuf {
        let parent = relative_path.parent().unwrap_or_else(|| Path::new(""));
        let name = relative_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        self.technical_root()
            .join("versions")
            .join(parent)
            .join(name.as_ref())
            .join(format!("{}-{}-{}", now_ms(), &hash[..12], Uuid::new_v4()))
            .join(name.as_ref())
    }
}

fn initialize_manifest(path: &Path) -> Result<(), BackupError> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent)?;
    }
    Connection::open(path)?.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         CREATE TABLE IF NOT EXISTS current_files (
            relative_path TEXT PRIMARY KEY NOT NULL,
            content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
            size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
            backed_up_at_unix_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS file_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            relative_path TEXT NOT NULL,
            content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
            version_path TEXT NOT NULL UNIQUE,
            archived_at_unix_ms INTEGER NOT NULL
         );",
    )?;
    Ok(())
}

fn current_record(
    connection: &Connection,
    relative_path: &Path,
) -> Result<Option<(String, u64)>, BackupError> {
    connection
        .query_row(
            "SELECT content_sha256, size_bytes FROM current_files WHERE relative_path = ?1",
            [path_text(relative_path)],
            |row| {
                let size: i64 = row.get(1)?;
                Ok((row.get(0)?, u64::try_from(size).unwrap_or_default()))
            },
        )
        .optional()
        .map_err(Into::into)
}

fn hash_file(path: &Path) -> Result<String, BackupError> {
    let file = File::open(path).map_err(|source| io_error(path, source))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|source| io_error(path, source))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn copy_and_sync(source: &Path, destination: &Path) -> Result<(), BackupError> {
    let input = File::open(source).map_err(|error| io_error(source, error))?;
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| io_error(destination, error))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, input);
    let mut writer = BufWriter::with_capacity(1024 * 1024, output);
    io::copy(&mut reader, &mut writer).map_err(|error| io_error(destination, error))?;
    writer
        .flush()
        .map_err(|error| io_error(destination, error))?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|error| io_error(destination, error))?;
    Ok(())
}

fn validate_relative(path: &Path) -> Result<(), BackupError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(BackupError::UnsafeRelativePath(path.to_path_buf()));
    }
    Ok(())
}

fn reject_overlapping_roots(source: &Path, destination: &Path) -> Result<(), BackupError> {
    let source = fs::canonicalize(source).map_err(|error| io_error(source, error))?;
    let destination =
        fs::canonicalize(destination).map_err(|error| io_error(destination, error))?;
    if source.starts_with(&destination) || destination.starts_with(&source) {
        return Err(BackupError::OverlappingRoots);
    }
    Ok(())
}

fn read_marker(path: &Path) -> Result<TargetMarker, BackupError> {
    let bytes = fs::read(path).map_err(|source| io_error(path, source))?;
    serde_json::from_slice(&bytes).map_err(|source| BackupError::InvalidMarker {
        path: path.to_path_buf(),
        source,
    })
}

fn write_new_marker(path: &Path, marker: &TargetMarker) -> Result<(), BackupError> {
    let bytes = serde_json::to_vec_pretty(marker).expect("target marker is serializable");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| io_error(path, source))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|source| io_error(path, source))
}

fn target_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BackupTarget> {
    let id: String = row.get(0)?;
    let created: i64 = row.get(3)?;
    let seen: i64 = row.get(4)?;
    Ok(BackupTarget {
        id: Uuid::parse_str(&id).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        label: row.get(1)?,
        last_known_root: PathBuf::from(row.get::<_, String>(2)?),
        created_at_unix_ms: u64::try_from(created).unwrap_or_default(),
        last_seen_at_unix_ms: u64::try_from(seen).unwrap_or_default(),
    })
}

fn photos_root(root: &Path) -> PathBuf {
    root.join(BACKUP_DIRECTORY).join(PHOTOS_DIRECTORY)
}

fn technical_root(root: &Path) -> PathBuf {
    root.join(BACKUP_DIRECTORY).join(TECHNICAL_DIRECTORY)
}

fn versions_root(root: &Path) -> PathBuf {
    technical_root(root).join("versions")
}

fn manifest_path(root: &Path) -> PathBuf {
    technical_root(root).join(MANIFEST_FILE)
}

fn create_dir_all(path: &Path) -> Result<(), BackupError> {
    fs::create_dir_all(path).map_err(|source| io_error(path, source))
}

fn io_error(path: &Path, source: io::Error) -> BackupError {
    BackupError::Io {
        path: path.to_path_buf(),
        source,
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn to_i64(value: u64) -> Result<i64, BackupError> {
    i64::try_from(value).map_err(|_| BackupError::ValueTooLarge(value))
}
