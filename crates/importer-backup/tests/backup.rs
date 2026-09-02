use std::fs;

use importer_backup::{
    BACKUP_DIRECTORY, BackupOperationKind, PHOTOS_DIRECTORY, TECHNICAL_DIRECTORY, TargetRegistry,
};

fn setup() -> (
    tempfile::TempDir,
    TargetRegistry,
    importer_backup::BackupTarget,
) {
    let directory = tempfile::tempdir().unwrap();
    let disk = directory.path().join("disk");
    fs::create_dir(&disk).unwrap();
    let registry = TargetRegistry::open(directory.path().join("registry.sqlite3")).unwrap();
    let target = registry.register(&disk, "Archiwum 1").unwrap();
    (directory, registry, target)
}

#[test]
fn registers_and_recognizes_a_target_by_persistent_identity() {
    let (directory, registry, target) = setup();
    assert_eq!(registry.known_targets().unwrap(), vec![target.clone()]);
    assert!(
        directory
            .path()
            .join("disk")
            .join(BACKUP_DIRECTORY)
            .join(TECHNICAL_DIRECTORY)
            .join("target.json")
            .is_file()
    );
    assert!(
        registry
            .connect(target.id, directory.path().join("disk"))
            .is_ok()
    );

    let other = directory.path().join("other");
    fs::create_dir(&other).unwrap();
    assert!(registry.connect(target.id, other).is_err());
}

#[test]
fn copies_only_new_and_changed_files_and_keeps_readable_layout() {
    let (directory, registry, target) = setup();
    let source = directory.path().join("library");
    fs::create_dir_all(source.join("2026/Wakacje")).unwrap();
    fs::write(source.join("2026/Wakacje/a.jpg"), b"first").unwrap();
    let engine = registry
        .connect(target.id, directory.path().join("disk"))
        .unwrap();

    let first = engine.plan(&source).unwrap();
    assert_eq!(first.operations[0].kind, BackupOperationKind::New);
    let report = engine.execute(&first).unwrap();
    assert_eq!(report.copied_file_count, 1);
    assert_eq!(
        fs::read(
            directory
                .path()
                .join("disk")
                .join(BACKUP_DIRECTORY)
                .join(PHOTOS_DIRECTORY)
                .join("2026/Wakacje/a.jpg")
        )
        .unwrap(),
        b"first"
    );

    let second = engine.plan(&source).unwrap();
    assert!(second.operations.is_empty());
    assert_eq!(second.unchanged_file_count, 1);

    fs::write(source.join("2026/Wakacje/a.jpg"), b"second edition").unwrap();
    let changed = engine.plan(&source).unwrap();
    assert_eq!(changed.operations[0].kind, BackupOperationKind::Changed);
    let report = engine.execute(&changed).unwrap();
    assert_eq!(report.versioned_file_count, 1);
}

#[test]
fn changed_content_preserves_the_verified_previous_version() {
    let (directory, registry, target) = setup();
    let source = directory.path().join("library");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("photo.raw"), b"old bytes").unwrap();
    let engine = registry
        .connect(target.id, directory.path().join("disk"))
        .unwrap();
    engine.execute(&engine.plan(&source).unwrap()).unwrap();
    fs::write(source.join("photo.raw"), b"new bytes").unwrap();
    engine.execute(&engine.plan(&source).unwrap()).unwrap();

    let versions = directory
        .path()
        .join("disk")
        .join(BACKUP_DIRECTORY)
        .join(TECHNICAL_DIRECTORY)
        .join("versions/photo.raw");
    let version = fs::read_dir(versions)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("photo.raw");
    assert_eq!(fs::read(version).unwrap(), b"old bytes");
    assert_eq!(
        fs::read(engine.photos_root().join("photo.raw")).unwrap(),
        b"new bytes"
    );
}

#[test]
fn detects_and_repairs_a_tampered_destination() {
    let (directory, registry, target) = setup();
    let source = directory.path().join("library");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("photo.jpg"), b"trusted").unwrap();
    let engine = registry
        .connect(target.id, directory.path().join("disk"))
        .unwrap();
    engine.execute(&engine.plan(&source).unwrap()).unwrap();
    fs::write(engine.photos_root().join("photo.jpg"), b"corrupt").unwrap();

    let repair = engine.plan(&source).unwrap();
    assert_eq!(repair.operations[0].kind, BackupOperationKind::Repair);
    engine.execute(&repair).unwrap();
    assert_eq!(
        fs::read(engine.photos_root().join("photo.jpg")).unwrap(),
        b"trusted"
    );
}

#[test]
fn refuses_recursive_backup_into_the_source_tree() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("library");
    let disk = source.join("mounted-disk");
    fs::create_dir_all(&disk).unwrap();
    let registry = TargetRegistry::open(directory.path().join("registry.sqlite3")).unwrap();
    let target = registry.register(&disk, "bad placement").unwrap();
    let engine = registry.connect(target.id, disk).unwrap();
    assert!(engine.plan(source).is_err());
}
