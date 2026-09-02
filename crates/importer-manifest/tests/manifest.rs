use std::fs;

use importer_manifest::{
    FileCandidate, FileImportState, ImportManifest, ImportedFileRecord, SourceWorkflowRecord,
    hash_file,
};

#[test]
fn recognizes_content_after_recording_an_import() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let original = directory.path().join("card/IMG_1.CR3");
    let duplicate = directory.path().join("other-card/COPY.CR3");
    fs::create_dir_all(original.parent().unwrap()).unwrap();
    fs::create_dir_all(duplicate.parent().unwrap()).unwrap();
    fs::write(&original, b"same photo content").unwrap();
    fs::write(&duplicate, b"same photo content").unwrap();
    let hash = hash_file(&original).unwrap();
    manifest
        .record_imports(&[ImportedFileRecord {
            content_sha256: hash.clone(),
            size_bytes: fs::metadata(&original).unwrap().len(),
            original_name: "IMG_1.CR3".to_owned(),
            source_relative_path: "DCIM/IMG_1.CR3".into(),
            imported_path: "library/event/IMG_1.CR3".into(),
            imported_at_unix_ms: 123,
            source_fingerprint: Some("card-a".to_owned()),
            event_name: Some("event".to_owned()),
        }])
        .unwrap();

    let matches = manifest
        .recognize_files(&[FileCandidate {
            item_key: "copy".to_owned(),
            path: duplicate,
            size_bytes: fs::metadata(&original).unwrap().len(),
        }])
        .unwrap();

    assert_eq!(matches[0].state, FileImportState::Imported);
    assert_eq!(matches[0].content_sha256.as_deref(), Some(hash.as_str()));
    assert_eq!(
        matches[0].imported_path.as_deref(),
        Some(std::path::Path::new("library/event/IMG_1.CR3"))
    );
}

#[test]
fn avoids_hashing_files_with_an_unknown_size() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();

    let matches = manifest
        .recognize_files(&[FileCandidate {
            item_key: "missing".to_owned(),
            path: directory.path().join("does-not-exist.jpg"),
            size_bytes: 999,
        }])
        .unwrap();

    assert_eq!(matches[0].state, FileImportState::New);
    assert_eq!(matches[0].content_sha256, None);
}

#[test]
fn same_size_with_different_content_is_new() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let first = directory.path().join("first.jpg");
    let second = directory.path().join("second.jpg");
    fs::write(&first, b"AAAA").unwrap();
    fs::write(&second, b"BBBB").unwrap();
    manifest
        .record_imports(&[ImportedFileRecord {
            content_sha256: hash_file(&first).unwrap(),
            size_bytes: 4,
            original_name: "first.jpg".to_owned(),
            source_relative_path: "first.jpg".into(),
            imported_path: "library/first.jpg".into(),
            imported_at_unix_ms: 1,
            source_fingerprint: None,
            event_name: None,
        }])
        .unwrap();

    let matches = manifest
        .recognize_files(&[FileCandidate {
            item_key: "second".to_owned(),
            path: second,
            size_bytes: 4,
        }])
        .unwrap();

    assert_eq!(matches[0].state, FileImportState::New);
    assert!(matches[0].content_sha256.is_some());
}

#[test]
fn database_uses_schema_version_nine() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("manifest.sqlite3");
    ImportManifest::open(&path).unwrap();
    let connection = rusqlite::Connection::open(path).unwrap();
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();

    assert_eq!(version, 9);
}

#[test]
fn reuses_a_verified_source_hash_without_reading_the_whole_file_again() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let source_root = directory.path().join("card");
    let source = source_root.join("DCIM/photo.jpg");
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    let content = vec![42_u8; 1024 * 1024];
    fs::write(&source, &content).unwrap();
    let hash = hash_file(&source).unwrap();
    manifest
        .record_imports(&[ImportedFileRecord {
            content_sha256: hash,
            size_bytes: content.len() as u64,
            original_name: "photo.jpg".to_owned(),
            source_relative_path: "DCIM/photo.jpg".into(),
            imported_path: "library/photo.jpg".into(),
            imported_at_unix_ms: 1,
            source_fingerprint: Some("card-a".to_owned()),
            event_name: None,
        }])
        .unwrap();
    let candidates = [FileCandidate {
        item_key: "photo".to_owned(),
        path: source,
        size_bytes: content.len() as u64,
    }];

    let mut first = None;
    manifest
        .recognize_files_with_progress(
            &candidates,
            Some("card-a"),
            Some(&source_root),
            |progress| first = Some(progress),
            || false,
        )
        .unwrap();
    let mut second = None;
    let recognized = manifest
        .recognize_files_with_progress(
            &candidates,
            Some("card-a"),
            Some(&source_root),
            |progress| second = Some(progress),
            || false,
        )
        .unwrap();

    assert_eq!(recognized[0].state, FileImportState::Imported);
    assert_eq!(first.unwrap().fully_hashed_file_count, 1);
    let second = second.unwrap();
    assert_eq!(second.cache_hit_count, 1);
    assert_eq!(second.fully_hashed_file_count, 0);
    assert!(second.bytes_read < content.len() as u64);
}

#[test]
fn migrates_version_one_without_losing_import_history() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("manifest.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE imported_files (
            content_sha256 TEXT PRIMARY KEY NOT NULL,
            size_bytes INTEGER NOT NULL,
            original_name TEXT NOT NULL,
            source_relative_path TEXT NOT NULL,
            imported_path TEXT NOT NULL,
            imported_at_unix_ms INTEGER NOT NULL,
            source_fingerprint TEXT,
            event_name TEXT
         );
         INSERT INTO imported_files VALUES (
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            4, 'old.jpg', 'old.jpg', 'library/old.jpg', 1, NULL, NULL
         );
         PRAGMA user_version = 1;",
        )
        .unwrap();
    drop(connection);

    let manifest = ImportManifest::open(&path).unwrap();
    let sessions = manifest.list_import_sessions().unwrap();
    let connection = rusqlite::Connection::open(path).unwrap();
    let imported: i64 = connection
        .query_row("SELECT COUNT(*) FROM imported_files", [], |row| row.get(0))
        .unwrap();

    assert!(sessions.is_empty());
    assert_eq!(imported, 1);
}

#[test]
fn persists_session_operations_and_control_requests() {
    use importer_manifest::{
        ImportSessionOperation, NewImportOperation, NewImportSession, SessionSourceIdentity,
    };
    use uuid::Uuid;
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let marker_uuid = Uuid::new_v4();
    let session = manifest
        .create_import_session(&NewImportSession {
            operation: ImportSessionOperation::Copy,
            library_root: directory.path().join("library"),
            source_fingerprint: Some("card-a".into()),
            source_identity: Some(SessionSourceIdentity {
                marker_uuid: Some(marker_uuid),
                platform_volume_id: Some("volume-123".into()),
                fallback_fingerprint: "card-a".into(),
            }),
            move_confirmed: false,
            operations: vec![NewImportOperation {
                item_key: "item".into(),
                event_name: "event".into(),
                source_path: directory.path().join("card/a.jpg"),
                source_relative_path: "a.jpg".into(),
                destination_path: directory.path().join("library/event/a.jpg"),
                destination_relative_path: "event/a.jpg".into(),
                kind: "jpeg".into(),
                size_bytes: 10,
            }],
        })
        .unwrap();

    manifest.set_session_running(&session.id).unwrap();
    manifest.request_session_pause(&session.id).unwrap();
    let restored = manifest.get_import_session(&session.id).unwrap().unwrap();

    assert_eq!(restored.operations.len(), 1);
    assert!(restored.pause_requested);
    assert_eq!(restored.source_fingerprint.as_deref(), Some("card-a"));
    assert_eq!(
        restored.source_identity,
        Some(SessionSourceIdentity {
            marker_uuid: Some(marker_uuid),
            platform_volume_id: Some("volume-123".into()),
            fallback_fingerprint: "card-a".into(),
        })
    );
}

#[test]
fn reopening_database_pauses_an_interrupted_session_and_resets_its_operation() {
    use importer_manifest::{
        ImportSessionOperation, ImportSessionStatus, NewImportOperation, NewImportSession,
        OperationStatus,
    };
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("manifest.sqlite3");
    let manifest = ImportManifest::open(&path).unwrap();
    let session = manifest
        .create_import_session(&NewImportSession {
            operation: ImportSessionOperation::Copy,
            library_root: directory.path().join("library"),
            source_fingerprint: None,
            source_identity: None,
            move_confirmed: false,
            operations: vec![NewImportOperation {
                item_key: "item".into(),
                event_name: "event".into(),
                source_path: directory.path().join("source.jpg"),
                source_relative_path: "source.jpg".into(),
                destination_path: directory.path().join("library/source.jpg"),
                destination_relative_path: "source.jpg".into(),
                kind: "jpeg".into(),
                size_bytes: 1,
            }],
        })
        .unwrap();
    manifest.set_session_running(&session.id).unwrap();
    manifest
        .mark_operation_status(session.operations[0].id, OperationStatus::Copying, None)
        .unwrap();
    drop(manifest);

    let reopened = ImportManifest::open(path).unwrap();
    let recovered = reopened.get_import_session(&session.id).unwrap().unwrap();

    assert_eq!(recovered.status, ImportSessionStatus::Paused);
    assert_eq!(recovered.operations[0].status, OperationStatus::Pending);
}

#[test]
fn retrying_an_operation_counts_attempts_and_clears_the_last_error_on_completion() {
    use importer_manifest::{
        ImportSessionOperation, NewImportOperation, NewImportSession, OperationStatus,
    };
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = manifest
        .create_import_session(&NewImportSession {
            operation: ImportSessionOperation::Copy,
            library_root: directory.path().join("library"),
            source_fingerprint: None,
            source_identity: None,
            move_confirmed: false,
            operations: vec![NewImportOperation {
                item_key: "item".into(),
                event_name: "event".into(),
                source_path: "source.jpg".into(),
                source_relative_path: "source.jpg".into(),
                destination_path: "library/source.jpg".into(),
                destination_relative_path: "source.jpg".into(),
                kind: "jpeg".into(),
                size_bytes: 1,
            }],
        })
        .unwrap();
    let operation_id = session.operations[0].id;

    manifest
        .mark_operation_status(operation_id, OperationStatus::Copying, None)
        .unwrap();
    manifest
        .mark_operation_status(operation_id, OperationStatus::Failed, Some("disk full"))
        .unwrap();
    manifest
        .mark_operation_status(operation_id, OperationStatus::Copying, None)
        .unwrap();

    let retried = manifest.get_import_session(&session.id).unwrap().unwrap();
    assert_eq!(retried.operations[0].attempts, 2);
    assert_eq!(retried.operations[0].status, OperationStatus::Copying);
    assert_eq!(retried.operations[0].last_error, None);
}

#[test]
fn setting_session_running_clears_stale_controls_and_error() {
    use importer_manifest::{ImportSessionOperation, NewImportSession};
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = manifest
        .create_import_session(&NewImportSession {
            operation: ImportSessionOperation::Copy,
            library_root: directory.path().join("library"),
            source_fingerprint: None,
            source_identity: None,
            move_confirmed: false,
            operations: Vec::new(),
        })
        .unwrap();
    manifest
        .mark_session_status(
            &session.id,
            importer_manifest::ImportSessionStatus::Failed,
            Some("old error"),
        )
        .unwrap();
    manifest.request_session_cancel(&session.id).unwrap();

    manifest.set_session_running(&session.id).unwrap();

    let running = manifest.get_import_session(&session.id).unwrap().unwrap();
    assert_eq!(
        running.status,
        importer_manifest::ImportSessionStatus::Running
    );
    assert!(!running.pause_requested);
    assert!(!running.cancel_requested);
    assert_eq!(running.last_error, None);
}

#[test]
fn recording_the_same_hash_updates_its_browsable_destination() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let source = directory.path().join("source.jpg");
    fs::write(&source, b"same").unwrap();
    let hash = hash_file(&source).unwrap();
    let record = |path: &str, time| ImportedFileRecord {
        content_sha256: hash.clone(),
        size_bytes: 4,
        original_name: "source.jpg".to_owned(),
        source_relative_path: "source.jpg".into(),
        imported_path: path.into(),
        imported_at_unix_ms: time,
        source_fingerprint: None,
        event_name: None,
    };
    manifest
        .record_imports(&[record("library/old.jpg", 1)])
        .unwrap();
    manifest
        .record_imports(&[record("library/new.jpg", 2)])
        .unwrap();

    let recognized = manifest
        .recognize_files(&[FileCandidate {
            item_key: "item".to_owned(),
            path: source,
            size_bytes: 4,
        }])
        .unwrap();

    assert_eq!(
        recognized[0].imported_path.as_deref(),
        Some(std::path::Path::new("library/new.jpg"))
    );
}

#[test]
fn cancelled_and_completed_sessions_receive_a_completion_timestamp() {
    use importer_manifest::{ImportSessionOperation, ImportSessionStatus, NewImportSession};
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    for status in [
        ImportSessionStatus::Cancelled,
        ImportSessionStatus::Completed,
    ] {
        let session = manifest
            .create_import_session(&NewImportSession {
                operation: ImportSessionOperation::Copy,
                library_root: directory.path().join("library"),
                source_fingerprint: None,
                source_identity: None,
                move_confirmed: false,
                operations: Vec::new(),
            })
            .unwrap();
        manifest
            .mark_session_status(&session.id, status, None)
            .unwrap();
        assert!(
            manifest
                .get_import_session(&session.id)
                .unwrap()
                .unwrap()
                .completed_at_unix_ms
                .is_some()
        );
    }
}

#[test]
fn active_sessions_reserve_destination_paths() {
    use importer_manifest::{ImportSessionOperation, NewImportOperation, NewImportSession};
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let destination = directory.path().join("library/same.jpg");
    let new_session = |fingerprint: &str| NewImportSession {
        operation: ImportSessionOperation::Copy,
        library_root: directory.path().join("library"),
        source_fingerprint: Some(fingerprint.to_owned()),
        source_identity: None,
        move_confirmed: false,
        operations: vec![NewImportOperation {
            item_key: "item".into(),
            event_name: "event".into(),
            source_path: directory.path().join(format!("{fingerprint}.jpg")),
            source_relative_path: "same.jpg".into(),
            destination_path: destination.clone(),
            destination_relative_path: "same.jpg".into(),
            kind: "jpeg".into(),
            size_bytes: 1,
        }],
    };
    let first = manifest
        .create_import_session(&new_session("card-a"))
        .unwrap();

    assert!(
        manifest
            .create_import_session(&new_session("card-b"))
            .is_err()
    );

    manifest
        .mark_session_status(
            &first.id,
            importer_manifest::ImportSessionStatus::Cancelled,
            None,
        )
        .unwrap();
    assert!(
        manifest
            .create_import_session(&new_session("card-b"))
            .is_ok()
    );
}

#[test]
fn pending_source_workflow_survives_reopening_and_can_be_removed() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("manifest.sqlite3");
    let source = directory.path().join("card");
    let manifest = ImportManifest::open(&database).unwrap();
    manifest
        .save_pending_workflow(&source, "{\"scan\":1}", "{\"plan\":1}", 10)
        .unwrap();
    drop(manifest);

    let reopened = ImportManifest::open(database).unwrap();
    let workflows = reopened.list_pending_workflows().unwrap();
    assert_eq!(workflows.len(), 1);
    assert_eq!(workflows[0].0, source);
    reopened.delete_pending_workflow(&source).unwrap();
    assert!(reopened.list_pending_workflows().unwrap().is_empty());
}

#[test]
fn complete_source_workflow_survives_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("manifest.sqlite3");
    let source = directory.path().join("card");
    let expected = SourceWorkflowRecord {
        source_root: source.clone(),
        state: "planReady".into(),
        source_identity_json: Some(
            r#"{"markerUuid":"3d42ad77-6669-438e-8727-6b017a68dbf3","platformVolumeId":"volume-123","fallbackFingerprint":"fp"}"#.into(),
        ),
        display_name: "Canon EOS R6".into(),
        scan_json: r#"{"items":["raw+jpeg"]}"#.into(),
        plan_json: r#"{"status":"ready"}"#.into(),
        settings_schema_version: 2,
        settings_revision: "revision-a".into(),
        editor_json: r#"{"eventNames":{"event-1":"Wakacje"}}"#.into(),
        error: None,
        updated_at_unix_ms: 123_456,
    };
    ImportManifest::open(&database)
        .unwrap()
        .save_source_workflow(&expected)
        .unwrap();

    let restored = ImportManifest::open(database)
        .unwrap()
        .list_source_workflows()
        .unwrap();

    assert_eq!(restored, vec![expected]);
}
