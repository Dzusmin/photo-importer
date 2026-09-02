use std::fs;

use importer_import::ImportExecutor;
use importer_manifest::{
    FileCandidate, FileImportState, ImportManifest, ImportSessionOperation, ImportSessionStatus,
    NewImportOperation, NewImportSession,
};

fn session(
    manifest: &ImportManifest,
    root: &std::path::Path,
    move_files: bool,
    names: &[&str],
) -> importer_manifest::ImportSession {
    let source_root = root.join("card");
    let library = root.join("library");
    fs::create_dir_all(&source_root).unwrap();
    let operations = names
        .iter()
        .map(|name| {
            let source = source_root.join(name);
            fs::write(&source, format!("content-{name}")).unwrap();
            NewImportOperation {
                item_key: "pair".into(),
                event_name: "party".into(),
                source_path: source.clone(),
                source_relative_path: name.into(),
                destination_path: library.join("party").join(name),
                destination_relative_path: std::path::PathBuf::from("party").join(name),
                kind: "jpeg".into(),
                size_bytes: fs::metadata(source).unwrap().len(),
            }
        })
        .collect();
    manifest
        .create_import_session(&NewImportSession {
            operation: if move_files {
                ImportSessionOperation::MoveAfterVerification
            } else {
                ImportSessionOperation::Copy
            },
            library_root: library,
            source_fingerprint: Some("card".into()),
            source_identity: None,
            move_confirmed: move_files,
            operations,
        })
        .unwrap()
}

#[test]
fn copies_verifies_and_records_a_file_atomically() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = session(&manifest, directory.path(), false, &["a.jpg"]);

    let completed = ImportExecutor::new(manifest.clone())
        .execute_session(&session.id, |_| {})
        .unwrap();

    assert_eq!(completed.status, ImportSessionStatus::Completed);
    assert_eq!(completed.completed_file_count, 1);
    assert_eq!(
        fs::read(directory.path().join("library/party/a.jpg")).unwrap(),
        b"content-a.jpg"
    );
    let recognized = manifest
        .recognize_files(&[FileCandidate {
            item_key: "again".into(),
            path: directory.path().join("card/a.jpg"),
            size_bytes: b"content-a.jpg".len() as u64,
        }])
        .unwrap();
    assert_eq!(recognized[0].state, FileImportState::Imported);
}

#[test]
fn refuses_to_overwrite_a_destination_created_after_planning() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = session(&manifest, directory.path(), false, &["a.jpg"]);
    fs::create_dir_all(directory.path().join("library/party")).unwrap();
    fs::write(directory.path().join("library/party/a.jpg"), b"different").unwrap();

    assert!(
        ImportExecutor::new(manifest.clone())
            .execute_session(&session.id, |_| {})
            .is_err()
    );
    let failed = manifest.get_import_session(&session.id).unwrap().unwrap();
    assert_eq!(failed.status, ImportSessionStatus::Failed);
    assert_eq!(
        fs::read(directory.path().join("library/party/a.jpg")).unwrap(),
        b"different"
    );
}

#[test]
fn adopts_an_identical_file_published_before_a_crash_was_recorded() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = session(&manifest, directory.path(), false, &["a.jpg"]);
    fs::create_dir_all(directory.path().join("library/party")).unwrap();
    fs::copy(
        directory.path().join("card/a.jpg"),
        directory.path().join("library/party/a.jpg"),
    )
    .unwrap();

    let completed = ImportExecutor::new(manifest)
        .execute_session(&session.id, |_| {})
        .unwrap();

    assert_eq!(completed.status, ImportSessionStatus::Completed);
}

#[test]
fn move_deletes_sources_only_after_the_whole_item_is_verified() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = session(
        &manifest,
        directory.path(),
        true,
        &["a.raw", "a.jpg", "a.xmp"],
    );

    let completed = ImportExecutor::new(manifest)
        .execute_session(&session.id, |_| {})
        .unwrap();

    assert_eq!(completed.status, ImportSessionStatus::Completed);
    assert!(
        completed
            .operations
            .iter()
            .all(|operation| operation.source_deleted)
    );
    assert!(!directory.path().join("card/a.raw").exists());
    assert!(directory.path().join("library/party/a.raw").exists());
}

#[test]
fn cancellation_requested_during_progress_stops_after_the_current_media_set() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = session(&manifest, directory.path(), false, &["a.jpg", "b.jpg"]);
    let control = manifest.clone();

    let cancelled = ImportExecutor::new(manifest)
        .execute_session(&session.id, |progress| {
            if progress.completed_file_count == 1 {
                control.request_session_cancel(&progress.id).unwrap();
            }
        })
        .unwrap();

    assert_eq!(cancelled.status, ImportSessionStatus::Cancelled);
    assert_eq!(cancelled.completed_file_count, 2);
    assert!(directory.path().join("library/party/a.jpg").exists());
    assert!(directory.path().join("library/party/b.jpg").exists());
}

#[test]
fn pause_stops_after_the_current_media_set_and_resume_finishes_session() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = session(&manifest, directory.path(), false, &["a.jpg", "b.jpg"]);
    let control = manifest.clone();

    let paused = ImportExecutor::new(manifest.clone())
        .execute_session(&session.id, |progress| {
            if progress.completed_file_count == 1 {
                control.request_session_pause(&progress.id).unwrap();
            }
        })
        .unwrap();

    assert_eq!(paused.status, ImportSessionStatus::Paused);
    assert_eq!(paused.completed_file_count, 2);
    let resumed = ImportExecutor::new(manifest)
        .execute_session(&session.id, |_| {})
        .unwrap();
    assert_eq!(resumed.status, ImportSessionStatus::Completed);
    assert_eq!(resumed.completed_file_count, 2);
    assert_eq!(resumed.operations[0].attempts, 1);
    assert_eq!(resumed.operations[1].attempts, 1);
}

#[test]
fn failed_second_file_can_be_restored_and_resumed_without_recopying_first() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = session(&manifest, directory.path(), false, &["a.jpg", "b.jpg"]);
    fs::remove_file(directory.path().join("card/b.jpg")).unwrap();

    assert!(
        ImportExecutor::new(manifest.clone())
            .execute_session(&session.id, |_| {})
            .is_err()
    );
    let failed = manifest.get_import_session(&session.id).unwrap().unwrap();
    assert_eq!(failed.completed_file_count, 1);
    assert_eq!(failed.status, ImportSessionStatus::FailedRecoverable);
    fs::write(directory.path().join("card/b.jpg"), b"content-b.jpg").unwrap();

    let resumed = ImportExecutor::new(manifest)
        .execute_session(&session.id, |_| {})
        .unwrap();

    assert_eq!(resumed.status, ImportSessionStatus::Completed);
    assert_eq!(resumed.operations[0].attempts, 1);
    assert_eq!(resumed.operations[1].attempts, 2);
}

#[test]
fn source_size_change_fails_and_cleans_a_stale_partial_file() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = session(&manifest, directory.path(), false, &["a.jpg"]);
    fs::write(directory.path().join("card/a.jpg"), b"changed-and-longer").unwrap();
    let destination = directory.path().join("library/party/a.jpg");
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    let partial =
        destination.with_file_name(format!("a.jpg.photo-importer-{}.partial", session.id));
    fs::write(&partial, b"stale").unwrap();

    assert!(
        ImportExecutor::new(manifest.clone())
            .execute_session(&session.id, |_| {})
            .is_err()
    );

    assert!(!partial.exists());
    assert!(!destination.exists());
    assert_eq!(
        manifest
            .get_import_session(&session.id)
            .unwrap()
            .unwrap()
            .status,
        ImportSessionStatus::Failed
    );
}

#[test]
fn missing_session_and_unconfirmed_move_are_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    assert!(
        ImportExecutor::new(manifest.clone())
            .execute_session("missing", |_| {})
            .is_err()
    );

    let source = directory.path().join("source.jpg");
    fs::write(&source, b"x").unwrap();
    let unconfirmed = manifest
        .create_import_session(&NewImportSession {
            operation: ImportSessionOperation::MoveAfterVerification,
            library_root: directory.path().join("library"),
            source_fingerprint: None,
            source_identity: None,
            move_confirmed: false,
            operations: vec![NewImportOperation {
                item_key: "item".into(),
                event_name: "event".into(),
                source_path: source,
                source_relative_path: "source.jpg".into(),
                destination_path: directory.path().join("library/source.jpg"),
                destination_relative_path: "source.jpg".into(),
                kind: "jpeg".into(),
                size_bytes: 1,
            }],
        })
        .unwrap();

    assert!(
        ImportExecutor::new(manifest)
            .execute_session(&unconfirmed.id, |_| {})
            .is_err()
    );
}

#[test]
fn move_failure_keeps_the_verified_destination_and_marks_session_failed() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = session(&manifest, directory.path(), true, &["a.jpg"]);
    let source = directory.path().join("card/a.jpg");

    let result = ImportExecutor::new(manifest.clone()).execute_session(&session.id, |progress| {
        if progress.completed_file_count == 1 && source.is_file() {
            fs::remove_file(&source).unwrap();
            fs::create_dir(&source).unwrap();
            fs::write(source.join("blocker"), b"x").unwrap();
        }
    });

    assert!(result.is_err());
    assert!(directory.path().join("library/party/a.jpg").is_file());
    assert!(source.is_dir());
    assert_eq!(
        manifest
            .get_import_session(&session.id)
            .unwrap()
            .unwrap()
            .status,
        ImportSessionStatus::Failed
    );
}

#[test]
fn rollback_removes_only_the_verified_results_of_the_session() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = session(&manifest, directory.path(), false, &["a.jpg"]);
    let executor = ImportExecutor::new(manifest.clone());
    executor.execute_session(&session.id, |_| {}).unwrap();

    let rolled_back = executor.rollback_session(&session.id, |_| {}).unwrap();

    assert_eq!(rolled_back.status, ImportSessionStatus::Cancelled);
    assert_eq!(rolled_back.completed_file_count, 0);
    assert!(!directory.path().join("library/party/a.jpg").exists());
}

#[test]
fn rollback_refuses_to_delete_a_file_changed_after_import() {
    let directory = tempfile::tempdir().unwrap();
    let manifest = ImportManifest::open(directory.path().join("manifest.sqlite3")).unwrap();
    let session = session(&manifest, directory.path(), false, &["a.jpg"]);
    let executor = ImportExecutor::new(manifest);
    executor.execute_session(&session.id, |_| {}).unwrap();
    let destination = directory.path().join("library/party/a.jpg");
    fs::write(&destination, b"edited after import").unwrap();

    assert!(executor.rollback_session(&session.id, |_| {}).is_err());
    assert!(destination.exists());
}
