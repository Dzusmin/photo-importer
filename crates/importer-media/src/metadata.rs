use std::path::Path;

use chrono::Local;
use nom_exif::{ExifTag, MediaKind, MediaParser, MediaSource, TrackInfoTag};

use crate::CaptureTimeSource;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraIdentity {
    pub make: Option<String>,
    pub model: Option<String>,
    pub serial_number: Option<String>,
}

impl CameraIdentity {
    #[must_use]
    pub fn normalized(mut self) -> Option<Self> {
        self.make = normalize(self.make);
        self.model = normalize(self.model);
        self.serial_number = normalize(self.serial_number);
        (self.make.is_some() || self.model.is_some() || self.serial_number.is_some())
            .then_some(self)
    }

    #[must_use]
    pub fn suggested_name(&self) -> String {
        [self.make.as_deref(), self.model.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureTimestamp {
    pub unix_ms: u64,
    pub source: CaptureTimeSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MediaMetadata {
    pub captured_at: Option<CaptureTimestamp>,
    pub camera_identity: Option<CameraIdentity>,
}

pub trait CaptureTimeReader {
    fn capture_time(&mut self, path: &Path) -> Option<CaptureTimestamp>;

    fn camera_identity(&mut self, _path: &Path) -> Option<CameraIdentity> {
        None
    }

    fn read_metadata(&mut self, path: &Path) -> MediaMetadata {
        MediaMetadata {
            captured_at: self.capture_time(path),
            camera_identity: self.camera_identity(path),
        }
    }
}

#[derive(Debug, Default)]
pub struct NomExifCaptureTimeReader {
    parser: MediaParser,
}

impl CaptureTimeReader for NomExifCaptureTimeReader {
    fn capture_time(&mut self, path: &Path) -> Option<CaptureTimestamp> {
        let source = MediaSource::open(path).ok()?;
        match source.kind() {
            MediaKind::Image => {
                let exif: nom_exif::Exif = self.parser.parse_exif(source).ok()?.into();
                let timestamp = [ExifTag::DateTimeOriginal, ExifTag::CreateDate]
                    .into_iter()
                    .find_map(|tag| exif.get(tag).and_then(|value| value.as_datetime()))?;
                timestamp_to_millis(exif_millis(timestamp), CaptureTimeSource::Exif)
            }
            MediaKind::Track => {
                let track = self.parser.parse_track(source).ok()?;
                let timestamp = track
                    .get(TrackInfoTag::CreateDate)
                    .and_then(|value| value.as_datetime())?;
                timestamp_to_millis(exif_millis(timestamp), CaptureTimeSource::VideoMetadata)
            }
        }
    }

    fn camera_identity(&mut self, path: &Path) -> Option<CameraIdentity> {
        let source = MediaSource::open(path).ok()?;
        if source.kind() != MediaKind::Image {
            return None;
        }
        let exif: nom_exif::Exif = self.parser.parse_exif(source).ok()?.into();
        CameraIdentity {
            make: exif
                .get(ExifTag::Make)
                .and_then(|value| value.as_str())
                .map(str::to_owned),
            model: exif
                .get(ExifTag::Model)
                .and_then(|value| value.as_str())
                .map(str::to_owned),
            serial_number: exif
                .get(ExifTag::CameraSerialNumber)
                .and_then(|value| value.as_str())
                .map(str::to_owned),
        }
        .normalized()
    }

    fn read_metadata(&mut self, path: &Path) -> MediaMetadata {
        let Ok(source) = MediaSource::open(path) else {
            return MediaMetadata::default();
        };
        match source.kind() {
            MediaKind::Image => {
                let Ok(exif) = self.parser.parse_exif(source) else {
                    return MediaMetadata::default();
                };
                let exif: nom_exif::Exif = exif.into();
                let captured_at = [ExifTag::DateTimeOriginal, ExifTag::CreateDate]
                    .into_iter()
                    .find_map(|tag| exif.get(tag).and_then(|value| value.as_datetime()))
                    .and_then(|timestamp| {
                        timestamp_to_millis(exif_millis(timestamp), CaptureTimeSource::Exif)
                    });
                let camera_identity = CameraIdentity {
                    make: exif
                        .get(ExifTag::Make)
                        .and_then(|value| value.as_str())
                        .map(str::to_owned),
                    model: exif
                        .get(ExifTag::Model)
                        .and_then(|value| value.as_str())
                        .map(str::to_owned),
                    serial_number: exif
                        .get(ExifTag::CameraSerialNumber)
                        .and_then(|value| value.as_str())
                        .map(str::to_owned),
                }
                .normalized();
                MediaMetadata {
                    captured_at,
                    camera_identity,
                }
            }
            MediaKind::Track => {
                let captured_at = self
                    .parser
                    .parse_track(source)
                    .ok()
                    .and_then(|track| {
                        track
                            .get(TrackInfoTag::CreateDate)
                            .and_then(|value| value.as_datetime())
                    })
                    .and_then(|timestamp| {
                        timestamp_to_millis(
                            exif_millis(timestamp),
                            CaptureTimeSource::VideoMetadata,
                        )
                    });
                MediaMetadata {
                    captured_at,
                    camera_identity: None,
                }
            }
        }
    }
}

fn normalize(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
        (!normalized.is_empty()).then_some(normalized)
    })
}

fn exif_millis(value: nom_exif::ExifDateTime) -> i64 {
    value.aware().map_or_else(
        || {
            let naive = value.into_naive();
            naive.and_local_timezone(Local).earliest().map_or_else(
                || naive.and_utc().timestamp_millis(),
                |time| time.timestamp_millis(),
            )
        },
        |aware| aware.timestamp_millis(),
    )
}

fn timestamp_to_millis(value: i64, source: CaptureTimeSource) -> Option<CaptureTimestamp> {
    Some(CaptureTimestamp {
        unix_ms: u64::try_from(value).ok()?,
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camera_identity_normalizes_spacing_and_builds_a_name() {
        let identity = CameraIdentity {
            make: Some("  Fujifilm ".to_owned()),
            model: Some("X-T5   II".to_owned()),
            serial_number: Some(" ABC123 ".to_owned()),
        }
        .normalized()
        .unwrap();

        assert_eq!(identity.make.as_deref(), Some("Fujifilm"));
        assert_eq!(identity.model.as_deref(), Some("X-T5 II"));
        assert_eq!(identity.serial_number.as_deref(), Some("ABC123"));
        assert_eq!(identity.suggested_name(), "Fujifilm X-T5 II");
    }

    #[test]
    fn empty_camera_identity_is_discarded() {
        assert!(
            CameraIdentity {
                make: Some(" ".to_owned()),
                model: None,
                serial_number: None,
            }
            .normalized()
            .is_none()
        );
    }
}
