//! Cross-platform media source discovery, scanning and event grouping.
//!
//! This crate deliberately does not depend on Tauri. Paths can come from a
//! detected volume, a manually selected directory or, later, a network share.

mod discovery;
mod events;
mod metadata;
mod scan;

pub use discovery::{SourceDiscovery, SourceVolume, SystemSourceDiscovery, ensure_source_marker};
pub use events::{EventGroup, group_into_events};
pub use metadata::{
    CameraIdentity, CaptureTimeReader, CaptureTimestamp, MediaMetadata, NomExifCaptureTimeReader,
};
pub use scan::{
    CaptureTimeSource, MediaFile, MediaFileKind, MediaItem, MediaScan, MediaScanTimings, ScanError,
    ScanProgress, ScanProgressPhase, ScanWarning, apply_time_correction, scan_media,
    scan_media_parallel_with_progress, scan_media_with_progress, scan_media_with_reader,
};
