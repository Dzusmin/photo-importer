use std::fs;
use std::path::Path;

use importer_media::{
    CaptureTimeReader, CaptureTimeSource, CaptureTimestamp, MediaFileKind, group_into_events,
    scan_media, scan_media_with_reader,
};

struct FixedExifReader;

impl CaptureTimeReader for FixedExifReader {
    fn capture_time(&mut self, path: &Path) -> Option<CaptureTimestamp> {
        (path
            .extension()?
            .to_string_lossy()
            .eq_ignore_ascii_case("jpg"))
        .then_some(CaptureTimestamp {
            unix_ms: 1_700_000_000_000,
            source: CaptureTimeSource::Exif,
        })
    }
}

fn create_file(path: &Path, contents: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

#[test]
fn scans_dcim_and_groups_raw_jpeg_xmp_as_one_item() {
    let directory = tempfile::tempdir().unwrap();
    let dcim = directory.path().join("DCIM/100CAMERA");
    create_file(&dcim.join("IMG_0001.CR3"), b"raw");
    create_file(&dcim.join("IMG_0001.JPG"), b"jpeg");
    create_file(&dcim.join("IMG_0001.XMP"), b"sidecar");
    create_file(&dcim.join("README.txt"), b"ignored");

    let scan = scan_media(directory.path()).unwrap();

    assert_eq!(scan.items.len(), 1);
    assert_eq!(scan.supported_file_count, 3);
    assert_eq!(scan.skipped_file_count, 1);
    assert!(scan.items[0].has_raw_jpeg_pair);
    assert!(scan.items[0].has_sidecar);
    assert_eq!(scan.items[0].files.len(), 3);
}

#[test]
fn keeps_video_with_the_same_stem_as_a_separate_item() {
    let directory = tempfile::tempdir().unwrap();
    create_file(&directory.path().join("CLIP.JPG"), b"photo");
    create_file(&directory.path().join("CLIP.MOV"), b"video");

    let scan = scan_media(directory.path()).unwrap();

    assert_eq!(scan.items.len(), 2);
    assert!(scan.items.iter().any(|item| {
        item.files
            .iter()
            .any(|file| file.kind == MediaFileKind::Video)
    }));
}

#[test]
fn scan_result_can_be_grouped_without_splitting_at_midnight() {
    let directory = tempfile::tempdir().unwrap();
    create_file(&directory.path().join("A.NEF"), b"a");
    create_file(&directory.path().join("B.JPG"), b"b");

    let scan = scan_media(directory.path()).unwrap();
    let events = group_into_events(scan.items, 120);

    assert_eq!(events.len(), 1);
}

#[test]
fn embedded_time_wins_and_missing_metadata_falls_back_to_file_time() {
    let directory = tempfile::tempdir().unwrap();
    create_file(&directory.path().join("WITH_EXIF.JPG"), b"jpeg");
    create_file(&directory.path().join("WITHOUT_EXIF.NEF"), b"raw");

    let scan = scan_media_with_reader(directory.path(), &mut FixedExifReader).unwrap();
    let with_exif = scan
        .items
        .iter()
        .find(|item| item.key.contains("with_exif"))
        .unwrap();
    let fallback = scan
        .items
        .iter()
        .find(|item| item.key.contains("without_exif"))
        .unwrap();

    assert_eq!(with_exif.time_source, CaptureTimeSource::Exif);
    assert_eq!(with_exif.captured_at_unix_ms, 1_700_000_000_000);
    assert_eq!(fallback.time_source, CaptureTimeSource::FileModified);
    assert_eq!(
        fallback.captured_at_unix_ms,
        fallback.original_captured_at_unix_ms
    );
}
