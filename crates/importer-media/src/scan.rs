use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use walkdir::WalkDir;

use crate::CaptureTimeReader;
use crate::metadata::{CameraIdentity, CaptureTimestamp, NomExifCaptureTimeReader};

const JPEG_EXTENSIONS: &[&str] = &["jpg", "jpeg"];
const HEIC_EXTENSIONS: &[&str] = &["heic", "heif"];
const RAW_EXTENSIONS: &[&str] = &[
    "3fr", "arw", "cr2", "cr3", "dng", "erf", "iiq", "kdc", "mef", "mos", "mrw", "nef", "nrw",
    "orf", "pef", "raf", "raw", "rw2", "rwl", "sr2", "srf", "x3f",
];
const VIDEO_EXTENSIONS: &[&str] = &["avi", "m2ts", "m4v", "mov", "mp4", "mts"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaFileKind {
    Jpeg,
    Heic,
    Raw,
    Video,
    Xmp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureTimeSource {
    Exif,
    VideoMetadata,
    FileModified,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub path: PathBuf,
    pub relative_path: PathBuf,
    pub kind: MediaFileKind,
    pub size_bytes: u64,
    pub modified_at_unix_ms: u64,
    pub embedded_captured_at_unix_ms: Option<u64>,
    pub embedded_time_source: Option<CaptureTimeSource>,
    pub camera_identity: Option<CameraIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub key: String,
    pub original_captured_at_unix_ms: u64,
    pub captured_at_unix_ms: u64,
    pub time_source: CaptureTimeSource,
    pub time_correction_seconds: i64,
    pub total_size_bytes: u64,
    pub files: Vec<MediaFile>,
    pub has_raw_jpeg_pair: bool,
    pub has_sidecar: bool,
    pub camera_identity: Option<CameraIdentity>,
    pub camera_metadata_conflict: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanWarning {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaScan {
    pub root: PathBuf,
    pub items: Vec<MediaItem>,
    pub supported_file_count: usize,
    pub skipped_file_count: usize,
    pub total_size_bytes: u64,
    pub warnings: Vec<ScanWarning>,
    #[serde(default)]
    pub timings: MediaScanTimings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaScanTimings {
    pub discovery_ms: u64,
    pub metadata_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanProgressPhase {
    Discovering,
    ReadingMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: ScanProgressPhase,
    pub discovered_file_count: usize,
    pub processed_file_count: usize,
    pub total_supported_file_count: Option<usize>,
    pub current_path: Option<PathBuf>,
}

#[derive(Debug, Error)]
pub enum ScanError {
    #[error("scan root does not exist or is not a directory: {0}")]
    InvalidRoot(PathBuf),
    #[error("scan was cancelled")]
    Cancelled,
}

#[derive(Default)]
struct ItemBuilder {
    files: Vec<MediaFile>,
}

struct ProcessedFile {
    index: usize,
    path: PathBuf,
    result: Result<(String, MediaFile), ScanWarning>,
}

pub fn scan_media(root: &Path) -> Result<MediaScan, ScanError> {
    scan_media_parallel_with_progress(root, |_| {}, || false)
}

pub fn scan_media_parallel_with_progress(
    root: &Path,
    mut on_progress: impl FnMut(ScanProgress),
    is_cancelled: impl Fn() -> bool,
) -> Result<MediaScan, ScanError> {
    scan_media_internal(
        root,
        &mut on_progress,
        &is_cancelled,
        |supported_files, scan_root, on_progress, is_cancelled| {
            process_files_parallel(root, scan_root, supported_files, on_progress, is_cancelled)
        },
    )
}

pub fn scan_media_with_reader(
    root: &Path,
    time_reader: &mut dyn CaptureTimeReader,
) -> Result<MediaScan, ScanError> {
    scan_media_with_progress(root, time_reader, |_| {}, || false)
}

pub fn scan_media_with_progress(
    root: &Path,
    time_reader: &mut dyn CaptureTimeReader,
    mut on_progress: impl FnMut(ScanProgress),
    is_cancelled: impl Fn() -> bool,
) -> Result<MediaScan, ScanError> {
    scan_media_internal(
        root,
        &mut on_progress,
        &is_cancelled,
        |supported_files, scan_root, on_progress, is_cancelled| {
            process_files_sequential(
                root,
                scan_root,
                supported_files,
                time_reader,
                on_progress,
                is_cancelled,
            )
        },
    )
}

fn scan_media_internal(
    root: &Path,
    on_progress: &mut impl FnMut(ScanProgress),
    is_cancelled: &impl Fn() -> bool,
    process_files: impl FnOnce(
        &[(PathBuf, MediaFileKind)],
        &Path,
        &mut dyn FnMut(ScanProgress),
        &dyn Fn() -> bool,
    )
        -> Result<(BTreeMap<String, ItemBuilder>, Vec<ScanWarning>), ScanError>,
) -> Result<MediaScan, ScanError> {
    let discovery_started = Instant::now();
    if !root.is_dir() {
        return Err(ScanError::InvalidRoot(root.to_path_buf()));
    }

    let scan_root = preferred_scan_root(root);
    let mut warnings = Vec::new();
    let mut skipped_file_count = 0;
    let mut discovered_file_count = 0;
    let mut supported_files = Vec::new();

    for entry in WalkDir::new(&scan_root).follow_links(false) {
        if is_cancelled() {
            return Err(ScanError::Cancelled);
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                warnings.push(ScanWarning {
                    path: error
                        .path()
                        .map_or_else(|| scan_root.clone(), Path::to_path_buf),
                    message: error.to_string(),
                });
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        discovered_file_count += 1;
        let path = entry.path();
        if discovered_file_count % 25 == 0 {
            on_progress(ScanProgress {
                phase: ScanProgressPhase::Discovering,
                discovered_file_count,
                processed_file_count: 0,
                total_supported_file_count: None,
                current_path: Some(path.to_path_buf()),
            });
        }
        let Some(kind) = media_kind(path) else {
            skipped_file_count += 1;
            continue;
        };
        supported_files.push((path.to_path_buf(), kind));
    }

    let supported_file_count = supported_files.len();
    let discovery_ms = elapsed_ms(discovery_started);
    on_progress(ScanProgress {
        phase: ScanProgressPhase::ReadingMetadata,
        discovered_file_count,
        processed_file_count: 0,
        total_supported_file_count: Some(supported_file_count),
        current_path: None,
    });
    let metadata_started = Instant::now();
    let (groups, metadata_warnings) =
        process_files(&supported_files, &scan_root, on_progress, is_cancelled)?;
    let metadata_ms = elapsed_ms(metadata_started);
    warnings.extend(metadata_warnings);

    build_scan(
        root,
        supported_file_count,
        skipped_file_count,
        warnings,
        groups,
        MediaScanTimings {
            discovery_ms,
            metadata_ms,
        },
    )
}

fn process_files_sequential(
    root: &Path,
    _scan_root: &Path,
    supported_files: &[(PathBuf, MediaFileKind)],
    time_reader: &mut dyn CaptureTimeReader,
    on_progress: &mut dyn FnMut(ScanProgress),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(BTreeMap<String, ItemBuilder>, Vec<ScanWarning>), ScanError> {
    let mut groups: BTreeMap<String, ItemBuilder> = BTreeMap::new();
    let mut warnings = Vec::new();
    let supported_file_count = supported_files.len();
    for (index, (path, kind)) in supported_files.iter().enumerate() {
        if is_cancelled() {
            return Err(ScanError::Cancelled);
        }
        match process_file(root, path, *kind, time_reader) {
            Ok((key, file)) => groups.entry(key).or_default().files.push(file),
            Err(warning) => warnings.push(warning),
        }
        let processed_file_count = index + 1;
        if processed_file_count % 10 == 0 || processed_file_count == supported_file_count {
            on_progress(ScanProgress {
                phase: ScanProgressPhase::ReadingMetadata,
                discovered_file_count: supported_file_count,
                processed_file_count,
                total_supported_file_count: Some(supported_file_count),
                current_path: Some(path.clone()),
            });
        }
    }
    Ok((groups, warnings))
}

fn process_files_parallel(
    root: &Path,
    _scan_root: &Path,
    supported_files: &[(PathBuf, MediaFileKind)],
    on_progress: &mut dyn FnMut(ScanProgress),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(BTreeMap<String, ItemBuilder>, Vec<ScanWarning>), ScanError> {
    let count = supported_files.len();
    if count <= 1 {
        return process_files_sequential(
            root,
            root,
            supported_files,
            &mut NomExifCaptureTimeReader::default(),
            on_progress,
            is_cancelled,
        );
    }
    let worker_count = std::thread::available_parallelism()
        .map_or(2, usize::from)
        .clamp(2, 4)
        .min(count);
    let next = AtomicUsize::new(0);
    let stopped = AtomicBool::new(false);
    let (sender, receiver) = mpsc::channel::<ProcessedFile>();
    let mut received = Vec::with_capacity(count);

    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            let sender = sender.clone();
            let next = &next;
            let stopped = &stopped;
            scope.spawn(move || {
                let mut reader = NomExifCaptureTimeReader::default();
                loop {
                    if stopped.load(Ordering::Relaxed) {
                        break;
                    }
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some((path, kind)) = supported_files.get(index) else {
                        break;
                    };
                    let result = process_file(root, path, *kind, &mut reader);
                    if sender
                        .send(ProcessedFile {
                            index,
                            path: path.clone(),
                            result,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
        drop(sender);
        for processed_file_count in 1..=count {
            if is_cancelled() {
                stopped.store(true, Ordering::Relaxed);
                return Err(ScanError::Cancelled);
            }
            let Ok(file) = receiver.recv() else {
                stopped.store(true, Ordering::Relaxed);
                return Err(ScanError::Cancelled);
            };
            let current_path = file.path.clone();
            received.push(file);
            if processed_file_count % 10 == 0 || processed_file_count == count {
                on_progress(ScanProgress {
                    phase: ScanProgressPhase::ReadingMetadata,
                    discovered_file_count: count,
                    processed_file_count,
                    total_supported_file_count: Some(count),
                    current_path: Some(current_path),
                });
            }
        }
        Ok(())
    })?;

    received.sort_by_key(|file| file.index);
    let mut groups: BTreeMap<String, ItemBuilder> = BTreeMap::new();
    let mut warnings = Vec::new();
    for file in received {
        match file.result {
            Ok((key, media_file)) => groups.entry(key).or_default().files.push(media_file),
            Err(warning) => warnings.push(warning),
        }
    }
    Ok((groups, warnings))
}

fn process_file(
    root: &Path,
    path: &Path,
    kind: MediaFileKind,
    time_reader: &mut dyn CaptureTimeReader,
) -> Result<(String, MediaFile), ScanWarning> {
    let metadata = fs::metadata(path).map_err(|error| ScanWarning {
        path: path.to_path_buf(),
        message: error.to_string(),
    })?;
    let modified_at_unix_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        });
    let relative_path = path.strip_prefix(root).unwrap_or(path).to_path_buf();
    let key = item_key(&relative_path, kind);
    let embedded = (kind != MediaFileKind::Xmp).then(|| time_reader.read_metadata(path));
    Ok((
        key,
        MediaFile {
            path: path.to_path_buf(),
            relative_path,
            kind,
            size_bytes: metadata.len(),
            modified_at_unix_ms,
            embedded_captured_at_unix_ms: embedded
                .as_ref()
                .and_then(|metadata| metadata.captured_at.map(|time| time.unix_ms)),
            embedded_time_source: embedded
                .as_ref()
                .and_then(|metadata| metadata.captured_at.map(|time| time.source)),
            camera_identity: embedded.and_then(|metadata| metadata.camera_identity),
        },
    ))
}

fn build_scan(
    root: &Path,
    supported_file_count: usize,
    skipped_file_count: usize,
    warnings: Vec<ScanWarning>,
    groups: BTreeMap<String, ItemBuilder>,
    timings: MediaScanTimings,
) -> Result<MediaScan, ScanError> {
    let mut items: Vec<_> = groups
        .into_iter()
        .map(|(key, mut builder)| {
            builder
                .files
                .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
            let has_raw = builder
                .files
                .iter()
                .any(|file| file.kind == MediaFileKind::Raw);
            let has_jpeg = builder
                .files
                .iter()
                .any(|file| file.kind == MediaFileKind::Jpeg);
            let has_sidecar = builder
                .files
                .iter()
                .any(|file| file.kind == MediaFileKind::Xmp);
            let embedded_time = builder
                .files
                .iter()
                .filter_map(|file| {
                    Some(CaptureTimestamp {
                        unix_ms: file.embedded_captured_at_unix_ms?,
                        source: file.embedded_time_source?,
                    })
                })
                .min_by_key(|time| time.unix_ms);
            let modified_time = builder
                .files
                .iter()
                .filter(|file| file.kind != MediaFileKind::Xmp)
                .map(|file| file.modified_at_unix_ms)
                .min()
                .unwrap_or(0);
            let (captured_at_unix_ms, time_source) = embedded_time.map_or_else(
                || {
                    (
                        modified_time,
                        if modified_time == 0 {
                            CaptureTimeSource::Unknown
                        } else {
                            CaptureTimeSource::FileModified
                        },
                    )
                },
                |time| (time.unix_ms, time.source),
            );
            let total_size_bytes = builder.files.iter().map(|file| file.size_bytes).sum();
            let identities: Vec<_> = builder
                .files
                .iter()
                .filter_map(|file| file.camera_identity.clone())
                .collect();
            let camera_identity = identities.first().cloned();
            let camera_metadata_conflict = camera_identity.as_ref().is_some_and(|first| {
                identities
                    .iter()
                    .skip(1)
                    .any(|identity| !same_camera(first, identity))
            });
            MediaItem {
                key,
                original_captured_at_unix_ms: captured_at_unix_ms,
                captured_at_unix_ms,
                time_source,
                time_correction_seconds: 0,
                total_size_bytes,
                files: builder.files,
                has_raw_jpeg_pair: has_raw && has_jpeg,
                has_sidecar,
                camera_identity: if camera_metadata_conflict {
                    None
                } else {
                    camera_identity
                },
                camera_metadata_conflict,
            }
        })
        .collect();
    items.sort_by_key(|item| (item.captured_at_unix_ms, item.key.clone()));
    let total_size_bytes = items.iter().map(|item| item.total_size_bytes).sum();

    Ok(MediaScan {
        root: root.to_path_buf(),
        items,
        supported_file_count,
        skipped_file_count,
        total_size_bytes,
        warnings,
        timings,
    })
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn same_camera(left: &CameraIdentity, right: &CameraIdentity) -> bool {
    fn equal(left: Option<&str>, right: Option<&str>) -> bool {
        match (left, right) {
            (Some(left), Some(right)) => left.eq_ignore_ascii_case(right),
            _ => true,
        }
    }
    equal(left.make.as_deref(), right.make.as_deref())
        && equal(left.model.as_deref(), right.model.as_deref())
        && equal(
            left.serial_number.as_deref(),
            right.serial_number.as_deref(),
        )
}

pub fn apply_time_correction(
    items: &mut [MediaItem],
    item_keys: &[String],
    offset_seconds: i64,
) -> usize {
    let mut changed = 0;
    for item in items {
        if item_keys.contains(&item.key) {
            item.time_correction_seconds = offset_seconds;
            let offset_ms = offset_seconds.saturating_mul(1_000);
            item.captured_at_unix_ms = if offset_ms >= 0 {
                item.original_captured_at_unix_ms
                    .saturating_add(offset_ms.unsigned_abs())
            } else {
                item.original_captured_at_unix_ms
                    .saturating_sub(offset_ms.unsigned_abs())
            };
            changed += 1;
        }
    }
    changed
}

fn preferred_scan_root(root: &Path) -> PathBuf {
    ["DCIM", "dcim", "Dcim"]
        .into_iter()
        .map(|name| root.join(name))
        .find(|path| path.is_dir())
        .unwrap_or_else(|| root.to_path_buf())
}

fn media_kind(path: &Path) -> Option<MediaFileKind> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    if JPEG_EXTENSIONS.contains(&extension.as_str()) {
        Some(MediaFileKind::Jpeg)
    } else if HEIC_EXTENSIONS.contains(&extension.as_str()) {
        Some(MediaFileKind::Heic)
    } else if RAW_EXTENSIONS.contains(&extension.as_str()) {
        Some(MediaFileKind::Raw)
    } else if VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        Some(MediaFileKind::Video)
    } else if extension == "xmp" {
        Some(MediaFileKind::Xmp)
    } else {
        None
    }
}

fn item_key(relative_path: &Path, kind: MediaFileKind) -> String {
    let parent = relative_path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_string_lossy()
        .to_ascii_lowercase();
    let stem = relative_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let suffix = if kind == MediaFileKind::Video {
        "#video"
    } else {
        ""
    };
    format!("{parent}/{stem}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_supported_extensions_case_insensitively() {
        assert_eq!(media_kind(Path::new("A.CR3")), Some(MediaFileKind::Raw));
        assert_eq!(media_kind(Path::new("A.JpEg")), Some(MediaFileKind::Jpeg));
        assert_eq!(media_kind(Path::new("A.HEIC")), Some(MediaFileKind::Heic));
        assert_eq!(media_kind(Path::new("A.MOV")), Some(MediaFileKind::Video));
        assert_eq!(media_kind(Path::new("A.XMP")), Some(MediaFileKind::Xmp));
        assert_eq!(media_kind(Path::new("A.txt")), None);
    }

    #[test]
    fn correction_is_always_calculated_from_original_time() {
        let mut item = MediaItem {
            key: "photo".to_owned(),
            original_captured_at_unix_ms: 10_000,
            captured_at_unix_ms: 10_000,
            time_source: CaptureTimeSource::Exif,
            time_correction_seconds: 0,
            total_size_bytes: 0,
            files: Vec::new(),
            has_raw_jpeg_pair: false,
            has_sidecar: false,
            camera_identity: None,
            camera_metadata_conflict: false,
        };

        apply_time_correction(std::slice::from_mut(&mut item), &["photo".to_owned()], 5);
        apply_time_correction(std::slice::from_mut(&mut item), &["photo".to_owned()], -2);

        assert_eq!(item.captured_at_unix_ms, 8_000);
        assert_eq!(item.time_correction_seconds, -2);
    }

    #[test]
    fn reports_indeterminate_discovery_then_determinate_metadata_progress() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("a.jpg"), b"a").unwrap();
        std::fs::write(directory.path().join("b.jpg"), b"b").unwrap();
        let mut phases = Vec::new();

        let scan = scan_media_with_progress(
            directory.path(),
            &mut EmptyCaptureTimeReader,
            |progress| phases.push(progress),
            || false,
        )
        .unwrap();

        assert_eq!(scan.supported_file_count, 2);
        assert!(phases.iter().any(|progress| {
            progress.phase == ScanProgressPhase::ReadingMetadata
                && progress.total_supported_file_count == Some(2)
                && progress.processed_file_count == 2
        }));
    }

    #[test]
    fn cancellation_stops_before_reading_files() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("a.jpg"), b"a").unwrap();

        let result = scan_media_with_progress(
            directory.path(),
            &mut EmptyCaptureTimeReader,
            |_| {},
            || true,
        );

        assert!(matches!(result, Err(ScanError::Cancelled)));
    }

    #[test]
    fn rejects_a_missing_or_regular_file_root() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("file.jpg");
        std::fs::write(&file, b"x").unwrap();

        assert!(matches!(scan_media(&file), Err(ScanError::InvalidRoot(path)) if path == file));
        assert!(matches!(
            scan_media(&directory.path().join("missing")),
            Err(ScanError::InvalidRoot(_))
        ));
    }

    #[test]
    fn prefers_dcim_and_does_not_import_media_from_the_card_root() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("DCIM")).unwrap();
        std::fs::write(directory.path().join("outside.jpg"), b"outside").unwrap();
        std::fs::write(directory.path().join("DCIM/inside.jpg"), b"inside").unwrap();

        let scan = scan_media(directory.path()).unwrap();

        assert_eq!(scan.supported_file_count, 1);
        assert_eq!(
            scan.items[0].files[0].relative_path,
            PathBuf::from("DCIM/inside.jpg")
        );
    }

    #[test]
    fn cancellation_during_metadata_stops_the_scan() {
        use std::cell::Cell;

        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("a.jpg"), b"a").unwrap();
        std::fs::write(directory.path().join("b.jpg"), b"b").unwrap();
        let checks = Cell::new(0_u32);

        let result = scan_media_with_progress(
            directory.path(),
            &mut NomExifCaptureTimeReader::default(),
            |_| {},
            || {
                let next = checks.get() + 1;
                checks.set(next);
                next > 3
            },
        );

        assert!(matches!(result, Err(ScanError::Cancelled)));
    }

    #[test]
    fn correction_changes_only_selected_items_and_saturates_at_zero() {
        let mut selected = test_item("selected", 500);
        let untouched = test_item("untouched", 1_000);
        selected.original_captured_at_unix_ms = 500;
        let mut items = vec![selected, untouched.clone()];

        let changed = apply_time_correction(&mut items, &["selected".to_owned()], -1);

        assert_eq!(changed, 1);
        assert_eq!(items[0].captured_at_unix_ms, 0);
        assert_eq!(items[0].time_correction_seconds, -1);
        assert_eq!(items[1], untouched);
    }

    fn test_item(key: &str, captured_at_unix_ms: u64) -> MediaItem {
        MediaItem {
            key: key.to_owned(),
            original_captured_at_unix_ms: captured_at_unix_ms,
            captured_at_unix_ms,
            time_source: CaptureTimeSource::Exif,
            time_correction_seconds: 0,
            total_size_bytes: 0,
            files: Vec::new(),
            has_raw_jpeg_pair: false,
            has_sidecar: false,
            camera_identity: None,
            camera_metadata_conflict: false,
        }
    }

    struct EmptyCaptureTimeReader;

    impl CaptureTimeReader for EmptyCaptureTimeReader {
        fn capture_time(&mut self, _path: &Path) -> Option<CaptureTimestamp> {
            None
        }
    }
}
