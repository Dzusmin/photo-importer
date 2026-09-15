use std::collections::HashMap;
use std::path::Path;

use importer_manifest::{ImportSession, ImportSessionStatus};
use serde::Serialize;
use tauri::Emitter;

use crate::backups::{
    BackupJob, BackupJobStatus, BackupPlanningJob, BackupPlanningJobStatus, BackupService,
};
use crate::imports::ImportService;
use crate::scan_jobs::{MediaScanJob, MediaScanJobStatus, ScanService};

pub(crate) const OPERATIONS_CHANGED_EVENT: &str = "operations://changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationKind {
    Scan,
    Import,
    BackupPlanning,
    Backup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationStatus {
    Queued,
    Running,
    Paused,
    Attention,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationProgress {
    completed_items: usize,
    total_items: Option<usize>,
    completed_bytes: Option<u64>,
    total_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum OperationRoute {
    Scan { scan_id: String },
    Import { import_session_id: String },
    BackupPlanning { job_id: String, target_id: String },
    Backup { job_id: String, target_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationSummary {
    kind: OperationKind,
    id: String,
    status: OperationStatus,
    updated_at_unix_ms: u64,
    label: String,
    context: Option<String>,
    progress: OperationProgress,
    error: Option<String>,
    attention: bool,
    route: OperationRoute,
    #[serde(skip)]
    visible_in_snapshot: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationSource {
    Scans,
    Imports,
    BackupPlanning,
    Backups,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationDiagnostic {
    source: OperationSource,
    code: String,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationsSnapshot {
    operations: Vec<OperationSummary>,
    diagnostics: Vec<OperationDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationChanged {
    operation: OperationSummary,
}

impl OperationSummary {
    fn is_visible_in_snapshot(&self) -> bool {
        self.visible_in_snapshot
    }
}

fn path_label(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

fn classify_scan(status: MediaScanJobStatus) -> (OperationStatus, bool, bool) {
    match status {
        MediaScanJobStatus::Running => (OperationStatus::Running, false, true),
        MediaScanJobStatus::Completed => (OperationStatus::Completed, false, false),
        MediaScanJobStatus::Failed => (OperationStatus::Attention, true, true),
        MediaScanJobStatus::Cancelled => (OperationStatus::Cancelled, false, false),
    }
}

fn classify_import(status: ImportSessionStatus) -> (OperationStatus, bool, bool) {
    match status {
        ImportSessionStatus::Planned => (OperationStatus::Queued, false, false),
        ImportSessionStatus::Queued => (OperationStatus::Queued, false, true),
        ImportSessionStatus::Running | ImportSessionStatus::RollingBack => {
            (OperationStatus::Running, false, true)
        }
        ImportSessionStatus::Paused => (OperationStatus::Paused, false, true),
        ImportSessionStatus::Failed
        | ImportSessionStatus::FailedRecoverable
        | ImportSessionStatus::RollbackFailed => (OperationStatus::Attention, true, true),
        ImportSessionStatus::Completed => (OperationStatus::Completed, false, false),
        ImportSessionStatus::Cancelled => (OperationStatus::Cancelled, false, false),
    }
}

fn classify_backup_planning(status: BackupPlanningJobStatus) -> (OperationStatus, bool, bool) {
    match status {
        BackupPlanningJobStatus::Running => (OperationStatus::Running, false, true),
        BackupPlanningJobStatus::Completed => (OperationStatus::Completed, false, false),
        BackupPlanningJobStatus::Failed => (OperationStatus::Attention, true, true),
        BackupPlanningJobStatus::Cancelled => (OperationStatus::Cancelled, false, false),
    }
}

fn classify_backup(status: BackupJobStatus) -> (OperationStatus, bool, bool) {
    match status {
        BackupJobStatus::Running => (OperationStatus::Running, false, true),
        BackupJobStatus::Paused => (OperationStatus::Paused, false, true),
        BackupJobStatus::Completed => (OperationStatus::Completed, false, false),
        BackupJobStatus::Failed => (OperationStatus::Attention, true, true),
        BackupJobStatus::Cancelled => (OperationStatus::Cancelled, false, false),
    }
}

impl From<&MediaScanJob> for OperationSummary {
    fn from(job: &MediaScanJob) -> Self {
        let (status, attention, visible_in_snapshot) = classify_scan(job.status);
        Self {
            kind: OperationKind::Scan,
            id: job.id.clone(),
            status,
            updated_at_unix_ms: job.updated_at_unix_ms,
            label: path_label(&job.path, "Media scan"),
            context: Some(job.path.display().to_string()),
            progress: OperationProgress {
                completed_items: job.processed_file_count,
                total_items: job.total_supported_file_count,
                completed_bytes: None,
                total_bytes: None,
            },
            error: job.error.clone(),
            attention,
            route: OperationRoute::Scan {
                scan_id: job.id.clone(),
            },
            visible_in_snapshot,
        }
    }
}

impl From<&ImportSession> for OperationSummary {
    fn from(session: &ImportSession) -> Self {
        let (status, attention, visible_in_snapshot) = classify_import(session.status);
        Self {
            kind: OperationKind::Import,
            id: session.id.clone(),
            status,
            updated_at_unix_ms: session.updated_at_unix_ms,
            label: path_label(&session.library_root, "Photo import"),
            context: Some(session.library_root.display().to_string()),
            progress: OperationProgress {
                completed_items: session.completed_item_count,
                total_items: Some(session.item_count),
                completed_bytes: Some(session.completed_size_bytes),
                total_bytes: Some(session.total_size_bytes),
            },
            error: session.last_error.clone(),
            attention,
            route: OperationRoute::Import {
                import_session_id: session.id.clone(),
            },
            visible_in_snapshot,
        }
    }
}

impl From<&BackupPlanningJob> for OperationSummary {
    fn from(job: &BackupPlanningJob) -> Self {
        let (status, attention, visible_in_snapshot) = classify_backup_planning(job.status);
        Self {
            kind: OperationKind::BackupPlanning,
            id: job.id.clone(),
            status,
            updated_at_unix_ms: job.updated_at_unix_ms,
            label: path_label(&job.target_path, "Backup planning"),
            context: Some(format!(
                "{} → {}",
                job.source_path.display(),
                job.target_path.display()
            )),
            progress: OperationProgress {
                completed_items: job.processed_file_count,
                total_items: job.total_file_count,
                completed_bytes: Some(job.processed_bytes),
                total_bytes: job.total_bytes,
            },
            error: job.error.clone(),
            attention,
            route: OperationRoute::BackupPlanning {
                job_id: job.id.clone(),
                target_id: job.target_id.to_string(),
            },
            visible_in_snapshot,
        }
    }
}

impl From<&BackupJob> for OperationSummary {
    fn from(job: &BackupJob) -> Self {
        let (status, attention, visible_in_snapshot) = classify_backup(job.status);
        Self {
            kind: OperationKind::Backup,
            id: job.id.clone(),
            status,
            updated_at_unix_ms: job.updated_at_unix_ms,
            label: path_label(&job.target_path, "Backup"),
            context: Some(format!(
                "{} → {}",
                job.source_path.display(),
                job.target_path.display()
            )),
            progress: OperationProgress {
                completed_items: job.processed_file_count,
                total_items: job.total_file_count,
                completed_bytes: Some(job.processed_bytes),
                total_bytes: job.total_bytes,
            },
            error: job.error.clone(),
            attention,
            route: OperationRoute::Backup {
                job_id: job.id.clone(),
                target_id: job.target_id.to_string(),
            },
            visible_in_snapshot,
        }
    }
}

fn add_source<T>(
    result: Result<Vec<T>, OperationDiagnostic>,
    operations: &mut Vec<OperationSummary>,
    diagnostics: &mut Vec<OperationDiagnostic>,
) where
    for<'a> OperationSummary: From<&'a T>,
{
    match result {
        Ok(items) => operations.extend(items.iter().map(OperationSummary::from)),
        Err(diagnostic) => diagnostics.push(diagnostic),
    }
}

fn status_precedence(status: OperationStatus) -> u8 {
    match status {
        OperationStatus::Attention => 4,
        OperationStatus::Completed | OperationStatus::Cancelled => 3,
        OperationStatus::Paused => 2,
        OperationStatus::Running => 1,
        OperationStatus::Queued => 0,
    }
}

fn deduplicate_operations(operations: Vec<OperationSummary>) -> Vec<OperationSummary> {
    let mut unique = HashMap::<(OperationKind, String), OperationSummary>::new();
    for operation in operations {
        let key = (operation.kind, operation.id.clone());
        match unique.entry(key) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(operation);
            }
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                let current = entry.get();
                let should_replace = operation.updated_at_unix_ms > current.updated_at_unix_ms
                    || operation.updated_at_unix_ms == current.updated_at_unix_ms
                        && status_precedence(operation.status) > status_precedence(current.status);
                if should_replace {
                    entry.insert(operation);
                }
            }
        }
    }
    unique.into_values().collect()
}

fn aggregate_operations(
    scans: Result<Vec<MediaScanJob>, OperationDiagnostic>,
    imports: Result<Vec<ImportSession>, OperationDiagnostic>,
    backup_planning: Result<Vec<BackupPlanningJob>, OperationDiagnostic>,
    backups: Result<Vec<BackupJob>, OperationDiagnostic>,
) -> OperationsSnapshot {
    let mut operations = Vec::new();
    let mut diagnostics = Vec::new();
    add_source(scans, &mut operations, &mut diagnostics);
    add_source(imports, &mut operations, &mut diagnostics);
    add_source(backup_planning, &mut operations, &mut diagnostics);
    add_source(backups, &mut operations, &mut diagnostics);
    operations = deduplicate_operations(operations)
        .into_iter()
        .filter(OperationSummary::is_visible_in_snapshot)
        .collect();
    operations.sort_by(|left, right| {
        right
            .updated_at_unix_ms
            .cmp(&left.updated_at_unix_ms)
            .then_with(|| left.id.cmp(&right.id))
    });
    OperationsSnapshot {
        operations,
        diagnostics,
    }
}

fn diagnostic(
    source: OperationSource,
    code: impl Into<String>,
    message: impl Into<String>,
) -> OperationDiagnostic {
    OperationDiagnostic {
        source,
        code: code.into(),
        message: message.into(),
    }
}

#[tauri::command]
pub(crate) fn list_operations(
    scans: tauri::State<'_, ScanService>,
    imports: tauri::State<'_, ImportService>,
    backups: tauri::State<'_, BackupService>,
) -> OperationsSnapshot {
    aggregate_operations(
        scans
            .list()
            .map_err(|error| diagnostic(OperationSource::Scans, error.code, error.message)),
        imports
            .list_sessions()
            .map_err(|error| diagnostic(OperationSource::Imports, error.code, error.message)),
        backups.list_planning_jobs().map_err(|error| {
            diagnostic(OperationSource::BackupPlanning, error.code, error.message)
        }),
        backups
            .list_jobs()
            .map_err(|error| diagnostic(OperationSource::Backups, error.code, error.message)),
    )
}

pub(crate) fn emit_operation_changed(app: &tauri::AppHandle, operation: OperationSummary) {
    let _ = app.emit(OPERATIONS_CHANGED_EVENT, OperationChanged { operation });
}

pub(crate) fn emit_scan_operation(app: &tauri::AppHandle, job: &MediaScanJob) {
    emit_operation_changed(app, OperationSummary::from(job));
}

pub(crate) fn emit_import_operation(app: &tauri::AppHandle, session: &ImportSession) {
    emit_operation_changed(app, OperationSummary::from(session));
}

pub(crate) fn emit_backup_planning_operation(app: &tauri::AppHandle, job: &BackupPlanningJob) {
    emit_operation_changed(app, OperationSummary::from(job));
}

pub(crate) fn emit_backup_operation(app: &tauri::AppHandle, job: &BackupJob) {
    emit_operation_changed(app, OperationSummary::from(job));
}

#[cfg(test)]
mod tests {
    use super::*;
    use importer_manifest::{ImportSessionOperation, SessionSourceIdentity};
    use std::path::PathBuf;

    fn import_session(status: ImportSessionStatus, updated_at_unix_ms: u64) -> ImportSession {
        ImportSession {
            id: format!("session-{updated_at_unix_ms}"),
            created_at_unix_ms: 1,
            updated_at_unix_ms,
            completed_at_unix_ms: None,
            operation: ImportSessionOperation::Copy,
            status,
            library_root: PathBuf::from("C:/Photos"),
            source_fingerprint: None,
            source_identity: None::<SessionSourceIdentity>,
            file_count: 4,
            completed_file_count: 2,
            item_count: 4,
            completed_item_count: 2,
            total_size_bytes: 100,
            completed_size_bytes: 50,
            last_error: None,
            pause_requested: false,
            cancel_requested: false,
            move_confirmed: false,
            operations: Vec::new(),
        }
    }

    fn empty_sources() -> (
        Result<Vec<MediaScanJob>, OperationDiagnostic>,
        Result<Vec<BackupPlanningJob>, OperationDiagnostic>,
        Result<Vec<BackupJob>, OperationDiagnostic>,
    ) {
        (Ok(Vec::new()), Ok(Vec::new()), Ok(Vec::new()))
    }

    #[test]
    fn classifies_import_lifecycle_and_attention_states() {
        let cases = [
            (ImportSessionStatus::Queued, OperationStatus::Queued, false),
            (
                ImportSessionStatus::Running,
                OperationStatus::Running,
                false,
            ),
            (
                ImportSessionStatus::RollingBack,
                OperationStatus::Running,
                false,
            ),
            (ImportSessionStatus::Paused, OperationStatus::Paused, false),
            (
                ImportSessionStatus::FailedRecoverable,
                OperationStatus::Attention,
                true,
            ),
            (
                ImportSessionStatus::RollbackFailed,
                OperationStatus::Attention,
                true,
            ),
            (
                ImportSessionStatus::Completed,
                OperationStatus::Completed,
                false,
            ),
            (
                ImportSessionStatus::Cancelled,
                OperationStatus::Cancelled,
                false,
            ),
        ];
        for (input, expected_status, expected_attention) in cases {
            let operation = OperationSummary::from(&import_session(input, 1));
            assert_eq!(operation.status, expected_status);
            assert_eq!(operation.attention, expected_attention);
        }
    }

    #[test]
    fn classifies_scan_and_backup_lifecycles_consistently() {
        assert_eq!(
            classify_scan(MediaScanJobStatus::Running),
            (OperationStatus::Running, false, true)
        );
        assert_eq!(
            classify_scan(MediaScanJobStatus::Failed),
            (OperationStatus::Attention, true, true)
        );
        assert_eq!(
            classify_backup_planning(BackupPlanningJobStatus::Failed),
            (OperationStatus::Attention, true, true)
        );
        assert_eq!(
            classify_backup(BackupJobStatus::Paused),
            (OperationStatus::Paused, false, true)
        );
        assert_eq!(
            classify_backup(BackupJobStatus::Completed),
            (OperationStatus::Completed, false, false)
        );
    }

    #[test]
    fn event_contract_keeps_terminal_tombstones_and_exact_route() {
        let operation = OperationSummary::from(&import_session(ImportSessionStatus::Completed, 4));
        assert!(!operation.is_visible_in_snapshot());

        let json = serde_json::to_value(OperationChanged { operation }).unwrap();
        assert_eq!(json["operation"]["kind"], "import");
        assert_eq!(json["operation"]["status"], "completed");
        assert_eq!(json["operation"]["route"]["kind"], "import");
        assert_eq!(json["operation"]["route"]["importSessionId"], "session-4");
        assert!(json["operation"].get("visibleInSnapshot").is_none());
    }

    #[test]
    fn hydration_filters_terminal_operations_and_keeps_attention() {
        let (scans, planning, backups) = empty_sources();
        let snapshot = aggregate_operations(
            scans,
            Ok(vec![
                import_session(ImportSessionStatus::Completed, 4),
                import_session(ImportSessionStatus::Cancelled, 3),
                import_session(ImportSessionStatus::Planned, 8),
                import_session(ImportSessionStatus::FailedRecoverable, 2),
                import_session(ImportSessionStatus::Running, 1),
            ]),
            planning,
            backups,
        );

        assert_eq!(snapshot.operations.len(), 2);
        assert!(snapshot.operations.iter().any(|item| item.attention));
        assert!(
            snapshot
                .operations
                .iter()
                .any(|item| item.status == OperationStatus::Running)
        );
    }

    #[test]
    fn partial_failure_preserves_other_sources_and_reports_diagnostic() {
        let (_, planning, backups) = empty_sources();
        let snapshot = aggregate_operations(
            Err(diagnostic(
                OperationSource::Scans,
                "scanStateUnavailable",
                "scan unavailable",
            )),
            Ok(vec![import_session(ImportSessionStatus::Running, 7)]),
            planning,
            backups,
        );

        assert_eq!(snapshot.operations.len(), 1);
        assert_eq!(snapshot.operations[0].kind, OperationKind::Import);
        assert_eq!(snapshot.diagnostics.len(), 1);
        assert_eq!(snapshot.diagnostics[0].source, OperationSource::Scans);
    }

    #[test]
    fn aggregation_orders_operations_by_newest_update() {
        let (scans, planning, backups) = empty_sources();
        let snapshot = aggregate_operations(
            scans,
            Ok(vec![
                import_session(ImportSessionStatus::Running, 3),
                import_session(ImportSessionStatus::Paused, 9),
            ]),
            planning,
            backups,
        );

        assert_eq!(snapshot.operations[0].updated_at_unix_ms, 9);
        assert_eq!(snapshot.operations[1].updated_at_unix_ms, 3);
    }

    #[test]
    fn aggregation_deduplicates_by_kind_and_id_before_filtering() {
        let (scans, planning, backups) = empty_sources();
        let mut older = import_session(ImportSessionStatus::Queued, 3);
        older.id = "same-active".to_owned();
        let mut newer = import_session(ImportSessionStatus::Running, 9);
        newer.id = "same-active".to_owned();

        let mut tied_running = import_session(ImportSessionStatus::Running, 5);
        tied_running.id = "same-terminal".to_owned();
        let mut tied_completed = import_session(ImportSessionStatus::Completed, 5);
        tied_completed.id = "same-terminal".to_owned();

        let mut tied_less_advanced = import_session(ImportSessionStatus::Running, 6);
        tied_less_advanced.id = "same-attention".to_owned();
        let mut tied_attention = import_session(ImportSessionStatus::FailedRecoverable, 6);
        tied_attention.id = "same-attention".to_owned();

        let snapshot = aggregate_operations(
            scans,
            Ok(vec![
                newer,
                older,
                tied_running,
                tied_completed,
                tied_attention,
                tied_less_advanced,
            ]),
            planning,
            backups,
        );

        assert_eq!(snapshot.operations.len(), 2);
        assert_eq!(snapshot.operations[0].id, "same-active");
        assert_eq!(snapshot.operations[0].status, OperationStatus::Running);
        assert_eq!(snapshot.operations[1].id, "same-attention");
        assert_eq!(snapshot.operations[1].status, OperationStatus::Attention);
        assert!(
            snapshot
                .operations
                .iter()
                .all(|operation| operation.id != "same-terminal")
        );
    }
}
