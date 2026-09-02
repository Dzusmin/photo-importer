use std::collections::BTreeSet;
use std::fs;

use importer_domain::settings::CollisionPolicy;
use importer_import::ImportExecutor;
use importer_manifest::{
    FileCandidate, FileImportState, ImportManifest, ImportSessionOperation, ImportSessionStatus,
    NewImportOperation, NewImportSession,
};
use importer_media::{MediaFileKind, group_into_events, scan_media};
use importer_plan::{BuildImportPlanRequest, EventPlanInput, TemplateContext, build_import_plan};
use tempfile::tempdir;

#[test]
fn scan_plan_import_and_rescan_recognizes_the_whole_media_item() {
    let workspace = tempdir().expect("temporary workspace");
    let card = workspace.path().join("card");
    let dcim = card.join("DCIM").join("100CAMERA");
    let library = workspace.path().join("library");
    fs::create_dir_all(&dcim).expect("camera directory");
    fs::create_dir_all(&library).expect("library directory");
    fs::write(dcim.join("IMG_0001.JPG"), b"jpeg bytes").expect("jpeg fixture");
    fs::write(dcim.join("IMG_0001.XMP"), b"sidecar bytes").expect("xmp fixture");
    fs::write(card.join("README.txt"), b"ignored").expect("unsupported fixture");

    let scan = scan_media(&card).expect("card scan");
    assert_eq!(scan.supported_file_count, 2);
    assert_eq!(scan.skipped_file_count, 0, "only DCIM should be scanned");
    assert_eq!(scan.items.len(), 1);
    assert!(scan.items[0].has_sidecar);

    let events = group_into_events(scan.items.clone(), 120);
    let plan = build_import_plan(BuildImportPlanRequest {
        library_root: library.clone(),
        folder_template: "{year}/{date}-{event_name}".to_owned(),
        collision_policy: CollisionPolicy::Ask,
        events: events
            .into_iter()
            .map(|event| EventPlanInput {
                event,
                name: "Test aparatu".to_owned(),
            })
            .collect(),
        excluded_item_keys: BTreeSet::new(),
        excluded_source_paths: BTreeSet::new(),
        context: TemplateContext::default(),
        item_contexts: Default::default(),
    })
    .expect("import plan");
    assert_eq!(plan.item_count, 1);
    assert_eq!(plan.file_count, 2);
    assert!(plan.conflicts.is_empty());
    assert!(
        plan.events[0]
            .folder_relative_path
            .to_string_lossy()
            .contains("Test aparatu")
    );

    let operations: Vec<_> = plan
        .events
        .iter()
        .flat_map(|event| {
            event.items.iter().flat_map(move |item| {
                item.files.iter().map(move |file| NewImportOperation {
                    item_key: item.item_key.clone(),
                    event_name: event.event_name.clone(),
                    source_path: file.source_path.clone(),
                    source_relative_path: file.source_relative_path.clone(),
                    destination_path: file.destination_path.clone(),
                    destination_relative_path: file.destination_relative_path.clone(),
                    kind: kind_name(file.kind).to_owned(),
                    size_bytes: file.size_bytes,
                })
            })
        })
        .collect();
    let manifest =
        ImportManifest::open(workspace.path().join("manifest.sqlite")).expect("manifest database");
    let session = manifest
        .create_import_session(&NewImportSession {
            operation: ImportSessionOperation::Copy,
            library_root: library,
            source_fingerprint: Some("test-card".to_owned()),
            source_identity: None,
            move_confirmed: false,
            operations,
        })
        .expect("persisted session");

    let completed = ImportExecutor::new(manifest.clone())
        .execute_session(&session.id, |_| {})
        .expect("completed import");
    assert_eq!(completed.status, ImportSessionStatus::Completed);
    assert_eq!(completed.completed_file_count, 2);
    assert!(
        completed
            .operations
            .iter()
            .all(|operation| operation.destination_path.is_file())
    );

    let candidates: Vec<_> = scan
        .items
        .iter()
        .flat_map(|item| {
            item.files.iter().map(move |file| FileCandidate {
                item_key: item.key.clone(),
                path: file.path.clone(),
                size_bytes: file.size_bytes,
            })
        })
        .collect();
    let recognition = manifest
        .recognize_files(&candidates)
        .expect("manifest recognition");
    assert_eq!(recognition.len(), 2);
    assert!(
        recognition
            .iter()
            .all(|file| file.state == FileImportState::Imported)
    );
}

fn kind_name(kind: MediaFileKind) -> &'static str {
    match kind {
        MediaFileKind::Jpeg => "jpeg",
        MediaFileKind::Heic => "heic",
        MediaFileKind::Raw => "raw",
        MediaFileKind::Video => "video",
        MediaFileKind::Xmp => "xmp",
    }
}
