//! Local-disk photo backup with stable target identities and version retention.
//!
//! Every destination contains a readable `Photo Backup/Photos` tree. Internal
//! state and older versions live below the hidden-by-convention
//! `Photo Backup/.photo-importer` directory.

use std::collections::{BTreeMap, BTreeSet};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupOperationKind {
    New,
    Changed,
    Repair,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupRunOutcome {
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRun {
    pub id: Uuid,
    pub target_id: Uuid,
    pub source_root: PathBuf,
    pub started_at_unix_ms: u64,
    pub finished_at_unix_ms: Option<u64>,
    pub outcome: BackupRunOutcome,
    pub copied_file_count: usize,
    pub unchanged_file_count: usize,
    pub versioned_file_count: usize,
    pub copied_bytes: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupFileStatus {
    Current,
    New,
    Changed,
    Corrupt,
    MissingInBackup,
    DeletedFromLibrary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileVersion {
    pub id: i64,
    pub relative_path: PathBuf,
    pub content_sha256: String,
    pub version_path: PathBuf,
    pub archived_at_unix_ms: u64,
}

/// Read-only inventory used by the UI today and by a future explicit restore flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileState {
    pub relative_path: PathBuf,
    pub status: BackupFileStatus,
    pub size_bytes: u64,
    pub source_sha256: Option<String>,
    pub backup_sha256: Option<String>,
    pub expected_sha256: Option<String>,
    pub backed_up_at_unix_ms: Option<u64>,
    pub orphaned: bool,
    pub versions: Vec<BackupFileVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshot {
    pub target_id: Uuid,
    pub source_root: PathBuf,
    pub backup_directory: PathBuf,
    pub scanned_at_unix_ms: u64,
    pub last_successful_run: Option<BackupRun>,
    pub files: Vec<BackupFileState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupPhase {
    ScanningLibrary,
    Hashing,
    Copying,
    Verifying,
    Finalizing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    pub phase: BackupPhase,
    pub processed_file_count: usize,
    pub total_file_count: Option<usize>,
    pub processed_bytes: u64,
    pub total_bytes: Option<u64>,
    pub current_path: Option<PathBuf>,
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
    #[error("backup was cancelled")]
    Cancelled,
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

    /// Recognizes a registered target from the persistent marker stored on the
    /// currently mounted disk. Mount paths are deliberately not identities.
    pub fn recognize(
        &self,
        current_root: impl Into<PathBuf>,
    ) -> Result<Option<BackupEngine>, BackupError> {
        let current_root = current_root.into();
        if !current_root.is_dir() {
            return Err(BackupError::InvalidTargetRoot(current_root));
        }
        let marker_path = technical_root(&current_root).join(MARKER_FILE);
        if !marker_path.exists() {
            return Ok(None);
        }
        let marker = read_marker(&marker_path)?;
        if self.get(marker.target_id)?.is_none() {
            return Ok(None);
        }
        self.connect(marker.target_id, current_root).map(Some)
    }

    /// Removes only the local configuration. Backup data and the persistent
    /// disk marker remain intact, so the medium can be registered again.
    pub fn remove(&self, target_id: Uuid) -> Result<bool, BackupError> {
        let deleted = self.connection()?.execute(
            "DELETE FROM backup_targets WHERE id = ?1",
            [target_id.to_string()],
        )?;
        Ok(deleted != 0)
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
    pub fn backup_root(&self) -> PathBuf {
        self.backup_root.clone()
    }

    #[must_use]
    pub fn technical_root(&self) -> PathBuf {
        self.backup_root.join(TECHNICAL_DIRECTORY)
    }

    pub fn plan(&self, source_root: impl Into<PathBuf>) -> Result<BackupPlan, BackupError> {
        self.plan_with_progress(source_root, |_| {}, || false)
    }

    pub fn plan_with_progress(
        &self,
        source_root: impl Into<PathBuf>,
        mut on_progress: impl FnMut(BackupProgress),
        mut is_cancelled: impl FnMut() -> bool,
    ) -> Result<BackupPlan, BackupError> {
        let source_root = source_root.into();
        if !source_root.is_dir() {
            return Err(BackupError::InvalidSourceRoot(source_root));
        }
        reject_overlapping_roots(&source_root, &self.target_root)?;
        let mut files = Vec::new();
        let mut scanned_bytes = 0_u64;
        for entry in WalkDir::new(&source_root).follow_links(false) {
            if is_cancelled() {
                return Err(BackupError::Cancelled);
            }
            let entry = entry?;
            if !entry.file_type().is_file() {
                continue;
            }
            let size_bytes = entry.metadata()?.len();
            scanned_bytes = scanned_bytes.saturating_add(size_bytes);
            files.push((entry.path().to_path_buf(), size_bytes));
            on_progress(BackupProgress {
                phase: BackupPhase::ScanningLibrary,
                processed_file_count: files.len(),
                total_file_count: None,
                processed_bytes: scanned_bytes,
                total_bytes: None,
                current_path: Some(entry.path().to_path_buf()),
            });
        }

        let connection = Connection::open(manifest_path(&self.target_root))?;
        let mut operations = Vec::new();
        let mut unchanged_file_count = 0;
        let mut total_copy_bytes = 0_u64;
        let total_file_count = files.len();
        let mut hashed_bytes = 0_u64;
        for (index, (source_path, size_bytes)) in files.into_iter().enumerate() {
            if is_cancelled() {
                return Err(BackupError::Cancelled);
            }
            let relative_path = source_path
                .strip_prefix(&source_root)
                .map_err(|_| BackupError::UnsafeRelativePath(source_path.clone()))?
                .to_path_buf();
            validate_relative(&relative_path)?;
            let source_sha256 = hash_file_with_cancel(&source_path, &mut is_cancelled)?;
            let previous = current_record(&connection, &relative_path)?;
            let destination_path = self.photos_root().join(&relative_path);
            let destination_hash = if destination_path.is_file() {
                Some(hash_file_with_cancel(&destination_path, &mut is_cancelled)?)
            } else {
                None
            };
            hashed_bytes = hashed_bytes.saturating_add(size_bytes);
            on_progress(BackupProgress {
                phase: BackupPhase::Hashing,
                processed_file_count: index + 1,
                total_file_count: Some(total_file_count),
                processed_bytes: hashed_bytes,
                total_bytes: Some(scanned_bytes),
                current_path: Some(source_path.clone()),
            });
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
                source_path,
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
        self.execute_with_progress(plan, |_| {}, || true, || false)
    }

    pub fn execute_with_progress(
        &self,
        plan: &BackupPlan,
        mut on_progress: impl FnMut(BackupProgress),
        mut wait_between_files: impl FnMut() -> bool,
        mut is_cancelled: impl FnMut() -> bool,
    ) -> Result<BackupReport, BackupError> {
        if plan.target_id != self.target.id {
            return Err(BackupError::WrongPlanTarget);
        }
        let run_id = Uuid::new_v4();
        let started_at = now_ms();
        let connection = Connection::open(manifest_path(&self.target_root))?;
        connection.execute(
            "INSERT INTO backup_runs
                (id, target_id, source_root, started_at_unix_ms, outcome)
             VALUES (?1, ?2, ?3, ?4, 'running')",
            params![
                run_id.to_string(),
                self.target.id.to_string(),
                path_text(&plan.source_root),
                to_i64(started_at)?,
            ],
        )?;
        drop(connection);

        let result = self.execute_with_progress_inner(
            plan,
            &mut on_progress,
            &mut wait_between_files,
            &mut is_cancelled,
        );
        let (outcome, report, error) = match &result {
            Ok(report) => (BackupRunOutcome::Succeeded, Some(report), None),
            Err(BackupError::Cancelled) => (BackupRunOutcome::Cancelled, None, None),
            Err(error) => (BackupRunOutcome::Failed, None, Some(error.to_string())),
        };
        self.finish_run(run_id, outcome, report, error.as_deref())?;
        result
    }

    fn execute_with_progress_inner(
        &self,
        plan: &BackupPlan,
        on_progress: &mut impl FnMut(BackupProgress),
        wait_between_files: &mut impl FnMut() -> bool,
        is_cancelled: &mut impl FnMut() -> bool,
    ) -> Result<BackupReport, BackupError> {
        if plan.target_id != self.target.id {
            return Err(BackupError::WrongPlanTarget);
        }
        let mut report = BackupReport {
            copied_file_count: 0,
            unchanged_file_count: plan.unchanged_file_count,
            versioned_file_count: 0,
            copied_bytes: 0,
        };
        cleanup_staging(&self.technical_root().join("staging"))?;
        let mut connection = Connection::open(manifest_path(&self.target_root))?;
        let total_file_count = plan.operations.len();
        for operation in &plan.operations {
            if !wait_between_files() || is_cancelled() {
                return Err(BackupError::Cancelled);
            }
            validate_relative(&operation.relative_path)?;
            if hash_file_with_cancel(&operation.source_path, &mut *is_cancelled)?
                != operation.source_sha256
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
            let copied_before = report.copied_bytes;
            if let Err(error) = copy_and_sync_with_progress(
                &operation.source_path,
                &temporary,
                |file_bytes| {
                    on_progress(BackupProgress {
                        phase: BackupPhase::Copying,
                        processed_file_count: report.copied_file_count,
                        total_file_count: Some(total_file_count),
                        processed_bytes: copied_before.saturating_add(file_bytes),
                        total_bytes: Some(plan.total_copy_bytes),
                        current_path: Some(operation.relative_path.clone()),
                    });
                },
                &mut *is_cancelled,
            ) {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
            let verified = hash_file_with_progress(
                &temporary,
                |file_bytes| {
                    on_progress(BackupProgress {
                        phase: BackupPhase::Verifying,
                        processed_file_count: report.copied_file_count,
                        total_file_count: Some(total_file_count),
                        processed_bytes: copied_before.saturating_add(file_bytes),
                        total_bytes: Some(plan.total_copy_bytes),
                        current_path: Some(operation.relative_path.clone()),
                    });
                },
                &mut *is_cancelled,
            );
            let verified = match verified {
                Ok(hash) => hash,
                Err(error) => {
                    let _ = fs::remove_file(&temporary);
                    return Err(error);
                }
            };
            if verified != operation.source_sha256 {
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
            on_progress(BackupProgress {
                phase: BackupPhase::Verifying,
                processed_file_count: report.copied_file_count,
                total_file_count: Some(total_file_count),
                processed_bytes: report.copied_bytes,
                total_bytes: Some(plan.total_copy_bytes),
                current_path: None,
            });
        }
        on_progress(BackupProgress {
            phase: BackupPhase::Finalizing,
            processed_file_count: report.copied_file_count,
            total_file_count: Some(total_file_count),
            processed_bytes: report.copied_bytes,
            total_bytes: Some(plan.total_copy_bytes),
            current_path: None,
        });
        Ok(report)
    }

    pub fn history(&self) -> Result<Vec<BackupRun>, BackupError> {
        let connection = Connection::open(manifest_path(&self.target_root))?;
        let mut statement = connection.prepare(
            "SELECT id, target_id, source_root, started_at_unix_ms,
                    finished_at_unix_ms, outcome, copied_file_count,
                    unchanged_file_count, versioned_file_count, copied_bytes, error
             FROM backup_runs ORDER BY started_at_unix_ms DESC, id DESC",
        )?;
        let rows = statement.query_map([], backup_run_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn inspect(&self, source_root: impl Into<PathBuf>) -> Result<BackupSnapshot, BackupError> {
        let source_root = source_root.into();
        if !source_root.is_dir() {
            return Err(BackupError::InvalidSourceRoot(source_root));
        }
        reject_overlapping_roots(&source_root, &self.target_root)?;
        let connection = Connection::open(manifest_path(&self.target_root))?;
        let mut source_files = BTreeMap::new();
        for entry in WalkDir::new(&source_root).follow_links(false) {
            let entry = entry?;
            if entry.file_type().is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(&source_root)
                    .map_err(|_| BackupError::UnsafeRelativePath(entry.path().to_path_buf()))?
                    .to_path_buf();
                validate_relative(&relative)?;
                source_files.insert(
                    relative,
                    (entry.metadata()?.len(), entry.path().to_path_buf()),
                );
            }
        }
        let mut records = BTreeMap::new();
        {
            let mut statement = connection.prepare(
                "SELECT relative_path, content_sha256, size_bytes, backed_up_at_unix_ms
                 FROM current_files",
            )?;
            let rows = statement.query_map([], |row| {
                let size: i64 = row.get(2)?;
                let backed_up: i64 = row.get(3)?;
                Ok((
                    PathBuf::from(row.get::<_, String>(0)?),
                    (
                        row.get::<_, String>(1)?,
                        u64::try_from(size).unwrap_or_default(),
                        u64::try_from(backed_up).unwrap_or_default(),
                    ),
                ))
            })?;
            for row in rows {
                let (path, record) = row?;
                records.insert(path, record);
            }
        }
        let paths: BTreeSet<_> = source_files.keys().chain(records.keys()).cloned().collect();
        let mut files = Vec::with_capacity(paths.len());
        for relative_path in paths {
            let source = source_files.get(&relative_path);
            let record = records.get(&relative_path);
            let source_sha256 = source.map(|(_, path)| hash_file(path)).transpose()?;
            let destination = self.photos_root().join(&relative_path);
            let backup_sha256 = destination
                .is_file()
                .then(|| hash_file(&destination))
                .transpose()?;
            let expected_sha256 = record.map(|record| record.0.clone());
            let status = match (source, record, backup_sha256.as_deref()) {
                (None, Some(_), Some(_)) => BackupFileStatus::DeletedFromLibrary,
                (None, Some(_), None) => BackupFileStatus::MissingInBackup,
                (Some(_), None, _) => BackupFileStatus::New,
                (Some(_), Some(_), None) => BackupFileStatus::MissingInBackup,
                (Some(_), Some((expected, _, _)), Some(actual)) if expected != actual => {
                    BackupFileStatus::Corrupt
                }
                (Some(_), Some((expected, _, _)), Some(_))
                    if source_sha256.as_deref() != Some(expected) =>
                {
                    BackupFileStatus::Changed
                }
                _ => BackupFileStatus::Current,
            };
            let versions = self.versions_for(&connection, &relative_path)?;
            files.push(BackupFileState {
                relative_path,
                status,
                size_bytes: source.map_or_else(|| record.map_or(0, |r| r.1), |s| s.0),
                source_sha256,
                backup_sha256,
                expected_sha256,
                backed_up_at_unix_ms: record.map(|record| record.2),
                orphaned: status == BackupFileStatus::DeletedFromLibrary,
                versions,
            });
        }
        let last_successful_run = self
            .history()?
            .into_iter()
            .find(|run| run.outcome == BackupRunOutcome::Succeeded);
        Ok(BackupSnapshot {
            target_id: self.target.id,
            source_root,
            backup_directory: self.backup_root.clone(),
            scanned_at_unix_ms: now_ms(),
            last_successful_run,
            files,
        })
    }

    fn versions_for(
        &self,
        connection: &Connection,
        relative_path: &Path,
    ) -> Result<Vec<BackupFileVersion>, BackupError> {
        let mut statement = connection.prepare(
            "SELECT id, relative_path, content_sha256, version_path, archived_at_unix_ms
             FROM file_versions WHERE relative_path = ?1 ORDER BY archived_at_unix_ms DESC, id DESC",
        )?;
        let rows = statement.query_map([path_text(relative_path)], |row| {
            let archived: i64 = row.get(4)?;
            Ok(BackupFileVersion {
                id: row.get(0)?,
                relative_path: PathBuf::from(row.get::<_, String>(1)?),
                content_sha256: row.get(2)?,
                version_path: self
                    .backup_root
                    .join(PathBuf::from(row.get::<_, String>(3)?)),
                archived_at_unix_ms: u64::try_from(archived).unwrap_or_default(),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn finish_run(
        &self,
        id: Uuid,
        outcome: BackupRunOutcome,
        report: Option<&BackupReport>,
        error: Option<&str>,
    ) -> Result<(), BackupError> {
        let outcome = match outcome {
            BackupRunOutcome::Running => "running",
            BackupRunOutcome::Succeeded => "succeeded",
            BackupRunOutcome::Failed => "failed",
            BackupRunOutcome::Cancelled => "cancelled",
        };
        let connection = Connection::open(manifest_path(&self.target_root))?;
        connection.execute(
            "UPDATE backup_runs SET finished_at_unix_ms = ?2, outcome = ?3,
                    copied_file_count = ?4, unchanged_file_count = ?5,
                    versioned_file_count = ?6, copied_bytes = ?7, error = ?8
             WHERE id = ?1",
            params![
                id.to_string(),
                to_i64(now_ms())?,
                outcome,
                i64::try_from(report.map_or(0, |r| r.copied_file_count)).unwrap_or(i64::MAX),
                i64::try_from(report.map_or(0, |r| r.unchanged_file_count)).unwrap_or(i64::MAX),
                i64::try_from(report.map_or(0, |r| r.versioned_file_count)).unwrap_or(i64::MAX),
                to_i64(report.map_or(0, |r| r.copied_bytes))?,
                error
            ],
        )?;
        Ok(())
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
         );
         CREATE TABLE IF NOT EXISTS backup_runs (
            id TEXT PRIMARY KEY NOT NULL,
            target_id TEXT NOT NULL,
            source_root TEXT NOT NULL,
            started_at_unix_ms INTEGER NOT NULL,
            finished_at_unix_ms INTEGER,
            outcome TEXT NOT NULL CHECK(outcome IN ('running', 'succeeded', 'failed', 'cancelled')),
            copied_file_count INTEGER NOT NULL DEFAULT 0,
            unchanged_file_count INTEGER NOT NULL DEFAULT 0,
            versioned_file_count INTEGER NOT NULL DEFAULT 0,
            copied_bytes INTEGER NOT NULL DEFAULT 0,
            error TEXT
         );",
    )?;
    Ok(())
}

fn backup_run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BackupRun> {
    let id: String = row.get(0)?;
    let target_id: String = row.get(1)?;
    let started: i64 = row.get(3)?;
    let finished: Option<i64> = row.get(4)?;
    let outcome: String = row.get(5)?;
    Ok(BackupRun {
        id: Uuid::parse_str(&id).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?,
        target_id: Uuid::parse_str(&target_id).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e))
        })?,
        source_root: PathBuf::from(row.get::<_, String>(2)?),
        started_at_unix_ms: u64::try_from(started).unwrap_or_default(),
        finished_at_unix_ms: finished.and_then(|value| u64::try_from(value).ok()),
        outcome: match outcome.as_str() {
            "succeeded" => BackupRunOutcome::Succeeded,
            "failed" => BackupRunOutcome::Failed,
            "cancelled" => BackupRunOutcome::Cancelled,
            _ => BackupRunOutcome::Running,
        },
        copied_file_count: usize::try_from(row.get::<_, i64>(6)?).unwrap_or_default(),
        unchanged_file_count: usize::try_from(row.get::<_, i64>(7)?).unwrap_or_default(),
        versioned_file_count: usize::try_from(row.get::<_, i64>(8)?).unwrap_or_default(),
        copied_bytes: u64::try_from(row.get::<_, i64>(9)?).unwrap_or_default(),
        error: row.get(10)?,
    })
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
    hash_file_with_cancel(path, || false)
}

fn hash_file_with_cancel(
    path: &Path,
    mut is_cancelled: impl FnMut() -> bool,
) -> Result<String, BackupError> {
    hash_file_with_progress(path, |_| {}, &mut is_cancelled)
}

fn hash_file_with_progress(
    path: &Path,
    mut on_progress: impl FnMut(u64),
    mut is_cancelled: impl FnMut() -> bool,
) -> Result<String, BackupError> {
    let file = File::open(path).map_err(|source| io_error(path, source))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut processed = 0_u64;
    loop {
        if is_cancelled() {
            return Err(BackupError::Cancelled);
        }
        let read = reader
            .read(&mut buffer)
            .map_err(|source| io_error(path, source))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        processed = processed.saturating_add(read as u64);
        on_progress(processed);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn copy_and_sync_with_progress(
    source: &Path,
    destination: &Path,
    mut on_progress: impl FnMut(u64),
    mut is_cancelled: impl FnMut() -> bool,
) -> Result<(), BackupError> {
    let input = File::open(source).map_err(|error| io_error(source, error))?;
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| io_error(destination, error))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, input);
    let mut writer = BufWriter::with_capacity(1024 * 1024, output);
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut copied = 0_u64;
    loop {
        if is_cancelled() {
            return Err(BackupError::Cancelled);
        }
        let read = reader
            .read(&mut buffer)
            .map_err(|error| io_error(source, error))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| io_error(destination, error))?;
        copied = copied.saturating_add(read as u64);
        on_progress(copied);
    }
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

fn cleanup_staging(path: &Path) -> Result<(), BackupError> {
    if !path.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(path).map_err(|source| io_error(path, source))?;
    for entry in entries {
        let entry = entry.map_err(|source| io_error(path, source))?;
        let entry_path = entry.path();
        if entry_path.is_file()
            && entry_path.extension().and_then(|value| value.to_str()) == Some("partial")
        {
            fs::remove_file(&entry_path).map_err(|source| io_error(&entry_path, source))?;
        }
    }
    Ok(())
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
