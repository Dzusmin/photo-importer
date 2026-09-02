//! Versioned, disposable thumbnail cache outside the photo library.

use std::fs;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};

use image::codecs::jpeg::JpegEncoder;
use image::metadata::Orientation;
use image::{DynamicImage, GenericImageView, ImageBuffer, ImageReader, Luma, Rgb};
use jpeg_decoder::{Decoder as ScaledJpegDecoder, PixelFormat};
use rawler::analyze::{extract_preview_pixels, extract_thumbnail_pixels};
use rawler::decoders::RawDecodeParams;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use thiserror::Error;

const CACHE_VERSION: u32 = 2;
const DEFAULT_MAX_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const JPEG_QUALITY: u8 = 84;
const LRU_WRITE_INTERVAL_MS: u64 = 60_000;

#[derive(Debug, Clone)]
pub struct ThumbnailCache {
    root: PathBuf,
    max_bytes: u64,
    connection: Arc<Mutex<Connection>>,
    total_bytes: Arc<AtomicU64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedThumbnail {
    pub key: String,
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub cache_hit: bool,
    pub timings: ThumbnailTimings,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThumbnailTimings {
    pub lookup_ms: u64,
    pub decode_ms: u64,
    pub resize_ms: u64,
    pub encode_and_persist_ms: u64,
    pub database_ms: u64,
    pub total_ms: u64,
}

#[derive(Debug, Error)]
pub enum ThumbnailError {
    #[error("cannot prepare thumbnail cache {path}: {source}")]
    PrepareCache {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot inspect source image {path}: {source}")]
    InspectSource {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("image format is not supported for preview: {0}")]
    Unsupported(PathBuf),
    #[error("cannot decode image {path}: {source}")]
    Decode {
        path: PathBuf,
        #[source]
        source: image::ImageError,
    },
    #[error("cannot encode thumbnail {path}: {source}")]
    Encode {
        path: PathBuf,
        #[source]
        source: image::ImageError,
    },
    #[error("thumbnail cache database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("thumbnail cache database lock is unavailable")]
    DatabaseUnavailable,
    #[error("cannot persist thumbnail {path}: {source}")]
    Persist {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl ThumbnailCache {
    pub fn open(cache_directory: impl Into<PathBuf>) -> Result<Self, ThumbnailError> {
        Self::open_with_limit(cache_directory, DEFAULT_MAX_BYTES)
    }

    pub fn open_with_limit(
        cache_directory: impl Into<PathBuf>,
        max_bytes: u64,
    ) -> Result<Self, ThumbnailError> {
        let root = cache_directory.into().join("thumbnails");
        fs::create_dir_all(root.join(format!("v{CACHE_VERSION}"))).map_err(|source| {
            ThumbnailError::PrepareCache {
                path: root.clone(),
                source,
            }
        })?;
        remove_stale_cache_versions(&root)?;
        let database_path = root.join("index.sqlite3");
        let connection = Connection::open(&database_path)?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS thumbnails (
                cache_key TEXT PRIMARY KEY NOT NULL,
                source_path TEXT NOT NULL,
                cache_path TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL,
                last_accessed_unix_ms INTEGER NOT NULL,
                cache_version INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS thumbnails_lru_idx ON thumbnails(last_accessed_unix_ms);",
        )?;
        connection.execute(
            "DELETE FROM thumbnails WHERE cache_version != ?1",
            [i64::from(CACHE_VERSION)],
        )?;
        let total_bytes = connection
            .query_row(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM thumbnails WHERE cache_version = ?1",
                [i64::from(CACHE_VERSION)],
                |row| row.get::<_, i64>(0),
            )?
            .try_into()
            .unwrap_or(u64::MAX);
        let cache = Self {
            root,
            max_bytes,
            connection: Arc::new(Mutex::new(connection)),
            total_bytes: Arc::new(AtomicU64::new(total_bytes)),
        };
        Ok(cache)
    }

    pub fn key_for(&self, source: &Path, max_dimension: u32) -> Result<String, ThumbnailError> {
        let (size, modified_ms) = source_identity(source)?;
        Ok(cache_key(source, size, modified_ms, max_dimension))
    }

    pub fn get_cached(
        &self,
        source: &Path,
        max_dimension: u32,
    ) -> Result<Option<CachedThumbnail>, ThumbnailError> {
        let started = Instant::now();
        let key = self.key_for(source, max_dimension)?;
        let mut thumbnail = self.lookup(&key)?;
        if let Some(value) = thumbnail.as_mut() {
            value.timings.lookup_ms = elapsed_ms(started);
            value.timings.total_ms = value.timings.lookup_ms;
        }
        Ok(thumbnail)
    }

    pub fn get_or_create(
        &self,
        source: &Path,
        max_dimension: u32,
    ) -> Result<CachedThumbnail, ThumbnailError> {
        let total_started = Instant::now();
        let lookup_started = Instant::now();
        let key = self.key_for(source, max_dimension)?;
        if let Some(cached) = self.lookup(&key)? {
            return Ok(cached);
        }
        let lookup_ms = elapsed_ms(lookup_started);
        let decode_started = Instant::now();
        let image = decode_preview(source, max_dimension)?;
        let decode_ms = elapsed_ms(decode_started);
        let resize_started = Instant::now();
        let thumbnail = image.thumbnail(max_dimension, max_dimension);
        let (width, height) = thumbnail.dimensions();
        let rgb = thumbnail.into_rgb8();
        let resize_ms = elapsed_ms(resize_started);
        let shard = self.root.join(format!("v{CACHE_VERSION}")).join(&key[..2]);
        fs::create_dir_all(&shard).map_err(|source_error| ThumbnailError::PrepareCache {
            path: shard.clone(),
            source: source_error,
        })?;
        let destination = shard.join(format!("{key}.jpg"));
        let persist_started = Instant::now();
        let temporary =
            NamedTempFile::new_in(&shard).map_err(|source_error| ThumbnailError::Persist {
                path: destination.clone(),
                source: source_error,
            })?;
        {
            let mut writer = BufWriter::new(temporary.as_file());
            JpegEncoder::new_with_quality(&mut writer, JPEG_QUALITY)
                .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
                .map_err(|source_error| ThumbnailError::Encode {
                    path: source.to_path_buf(),
                    source: source_error,
                })?;
            writer
                .flush()
                .map_err(|source_error| ThumbnailError::Persist {
                    path: destination.clone(),
                    source: source_error,
                })?;
        }
        match temporary.persist_noclobber(&destination) {
            Ok(_) => {}
            Err(error) if destination.is_file() => drop(error),
            Err(error) => {
                return Err(ThumbnailError::Persist {
                    path: destination,
                    source: error.error,
                });
            }
        }
        let size_bytes = fs::metadata(&destination)
            .map_err(|source_error| ThumbnailError::Persist {
                path: destination.clone(),
                source: source_error,
            })?
            .len();
        let encode_and_persist_ms = elapsed_ms(persist_started);
        let database_started = Instant::now();
        let inserted = self.database()?.execute(
            "INSERT OR IGNORE INTO thumbnails (cache_key, source_path, cache_path, width, height, size_bytes, last_accessed_unix_ms, cache_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ",
            params![key, source.to_string_lossy(), destination.to_string_lossy(), i64::from(width), i64::from(height), to_i64(size_bytes), to_i64(now_unix_ms()), i64::from(CACHE_VERSION)],
        )?;
        if inserted > 0 {
            self.total_bytes.fetch_add(size_bytes, Ordering::Relaxed);
        }
        self.prune()?;
        let database_ms = elapsed_ms(database_started);
        Ok(CachedThumbnail {
            key,
            path: destination,
            width,
            height,
            cache_hit: false,
            timings: ThumbnailTimings {
                lookup_ms,
                decode_ms,
                resize_ms,
                encode_and_persist_ms,
                database_ms,
                total_ms: elapsed_ms(total_started),
            },
        })
    }

    pub fn clear(&self) -> Result<(), ThumbnailError> {
        remove_cache_version_directories(&self.root, None)?;
        let version_root = self.root.join(format!("v{CACHE_VERSION}"));
        fs::create_dir_all(&version_root).map_err(|source| ThumbnailError::PrepareCache {
            path: version_root,
            source,
        })?;
        self.database()?.execute("DELETE FROM thumbnails", [])?;
        self.total_bytes.store(0, Ordering::Relaxed);
        Ok(())
    }

    fn lookup(&self, key: &str) -> Result<Option<CachedThumbnail>, ThumbnailError> {
        let connection = self.database()?;
        let row = connection.query_row(
            "SELECT cache_path, width, height, last_accessed_unix_ms FROM thumbnails WHERE cache_key = ?1 AND cache_version = ?2",
            params![key, i64::from(CACHE_VERSION)],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?)),
        ).optional()?;
        let Some((path, width, height, last_accessed)) = row else {
            return Ok(None);
        };
        let path = PathBuf::from(path);
        if !path.is_file() {
            connection.execute("DELETE FROM thumbnails WHERE cache_key = ?1", [key])?;
            return Ok(None);
        }
        let now = now_unix_ms();
        if now.saturating_sub(u64::try_from(last_accessed).unwrap_or(0)) >= LRU_WRITE_INTERVAL_MS {
            connection.execute(
                "UPDATE thumbnails SET last_accessed_unix_ms = ?2 WHERE cache_key = ?1",
                params![key, to_i64(now)],
            )?;
        }
        Ok(Some(CachedThumbnail {
            key: key.to_owned(),
            path,
            width: u32::try_from(width).unwrap_or(0),
            height: u32::try_from(height).unwrap_or(0),
            cache_hit: true,
            timings: ThumbnailTimings::default(),
        }))
    }

    fn prune(&self) -> Result<(), ThumbnailError> {
        let mut total = self.total_bytes.load(Ordering::Relaxed);
        if total <= self.max_bytes {
            return Ok(());
        }
        let connection = self.database()?;
        total = self.total_bytes.load(Ordering::Relaxed);
        while total > self.max_bytes {
            let oldest = connection.query_row("SELECT cache_key, cache_path, size_bytes FROM thumbnails WHERE cache_version = ?1 ORDER BY last_accessed_unix_ms LIMIT 1", [i64::from(CACHE_VERSION)], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))).optional()?;
            let Some((key, path, size)) = oldest else {
                break;
            };
            let _ = fs::remove_file(path);
            connection.execute("DELETE FROM thumbnails WHERE cache_key = ?1", [key])?;
            total = total.saturating_sub(u64::try_from(size).unwrap_or(0));
        }
        self.total_bytes.store(total, Ordering::Relaxed);
        Ok(())
    }

    fn database(&self) -> Result<MutexGuard<'_, Connection>, ThumbnailError> {
        self.connection
            .lock()
            .map_err(|_| ThumbnailError::DatabaseUnavailable)
    }
}

fn remove_stale_cache_versions(root: &Path) -> Result<(), ThumbnailError> {
    remove_cache_version_directories(root, Some(CACHE_VERSION))
}

fn remove_cache_version_directories(
    root: &Path,
    version_to_keep: Option<u32>,
) -> Result<(), ThumbnailError> {
    let entries = fs::read_dir(root).map_err(|source| ThumbnailError::PrepareCache {
        path: root.to_path_buf(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| ThumbnailError::PrepareCache {
            path: root.to_path_buf(),
            source,
        })?;
        let name = entry.file_name();
        let Some(version) = name
            .to_str()
            .and_then(|value| value.strip_prefix('v'))
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        if entry.path().is_dir() && version_to_keep != Some(version) {
            fs::remove_dir_all(entry.path()).map_err(|source| ThumbnailError::PrepareCache {
                path: root.to_path_buf(),
                source,
            })?;
        }
    }
    Ok(())
}

fn cache_key(path: &Path, size: u64, modified_ms: u64, dimension: u32) -> String {
    let mut hash = Sha256::new();
    hash.update(
        format!(
            "v{CACHE_VERSION}\0{}\0{size}\0{modified_ms}\0{dimension}",
            path.to_string_lossy()
        )
        .as_bytes(),
    );
    format!("{:x}", hash.finalize())
}

fn source_identity(source: &Path) -> Result<(u64, u64), ThumbnailError> {
    let metadata = fs::metadata(source).map_err(|source_error| ThumbnailError::InspectSource {
        path: source.to_path_buf(),
        source: source_error,
    })?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| {
            u64::try_from(value.as_millis()).unwrap_or(u64::MAX)
        });
    Ok((metadata.len(), modified_ms))
}

fn decode_preview(source: &Path, max_dimension: u32) -> Result<DynamicImage, ThumbnailError> {
    if is_raw(source) {
        let parameters = RawDecodeParams::default();
        if let Ok(thumbnail) = extract_thumbnail_pixels(source, &parameters) {
            return Ok(thumbnail);
        }
        if let Ok(preview) = extract_preview_pixels(source, &parameters) {
            return Ok(preview);
        }
        return embedded_jpeg(source).ok_or_else(|| ThumbnailError::Decode {
            path: source.to_path_buf(),
            source: image::ImageError::Decoding(image::error::DecodingError::new(
                image::ImageFormat::Jpeg.into(),
                io::Error::other("RAW file has no supported embedded preview"),
            )),
        });
    }
    if is_jpeg(source) {
        return decode_scaled_jpeg(source, max_dimension);
    }
    let reader =
        ImageReader::open(source).map_err(|source_error| ThumbnailError::InspectSource {
            path: source.to_path_buf(),
            source: source_error,
        })?;
    let reader =
        reader
            .with_guessed_format()
            .map_err(|source_error| ThumbnailError::InspectSource {
                path: source.to_path_buf(),
                source: source_error,
            })?;
    reader
        .decode()
        .map_err(|source_error| ThumbnailError::Decode {
            path: source.to_path_buf(),
            source: source_error,
        })
}

fn decode_scaled_jpeg(source: &Path, max_dimension: u32) -> Result<DynamicImage, ThumbnailError> {
    let file = fs::File::open(source).map_err(|source_error| ThumbnailError::InspectSource {
        path: source.to_path_buf(),
        source: source_error,
    })?;
    let mut decoder = ScaledJpegDecoder::new(BufReader::new(file));
    let target = u16::try_from(max_dimension.clamp(1, u32::from(u16::MAX))).unwrap_or(u16::MAX);
    let (width, height) = decoder
        .scale(target, target)
        .map_err(|source_error| jpeg_decode_error(source, source_error))?;
    let pixels = decoder
        .decode()
        .map_err(|source_error| jpeg_decode_error(source, source_error))?;
    let pixel_format = decoder
        .info()
        .map(|info| info.pixel_format)
        .unwrap_or(PixelFormat::RGB24);
    let orientation = decoder
        .exif_data()
        .and_then(exif_orientation)
        .and_then(Orientation::from_exif);
    let mut image = match pixel_format {
        PixelFormat::RGB24 => {
            ImageBuffer::<Rgb<u8>, _>::from_raw(u32::from(width), u32::from(height), pixels)
                .map(DynamicImage::ImageRgb8)
                .ok_or_else(|| invalid_jpeg_buffer(source))
        }
        PixelFormat::L8 => {
            ImageBuffer::<Luma<u8>, _>::from_raw(u32::from(width), u32::from(height), pixels)
                .map(DynamicImage::ImageLuma8)
                .ok_or_else(|| invalid_jpeg_buffer(source))
        }
        PixelFormat::CMYK32 => {
            let mut rgb = Vec::with_capacity(usize::from(width) * usize::from(height) * 3);
            let (cmyk_pixels, _) = pixels.as_chunks::<4>();
            for pixel in cmyk_pixels {
                let c = u16::from(pixel[0]);
                let m = u16::from(pixel[1]);
                let y = u16::from(pixel[2]);
                let k = u16::from(pixel[3]);
                rgb.extend_from_slice(&[
                    255_u16.saturating_sub((c * (255 - k) / 255) + k) as u8,
                    255_u16.saturating_sub((m * (255 - k) / 255) + k) as u8,
                    255_u16.saturating_sub((y * (255 - k) / 255) + k) as u8,
                ]);
            }
            ImageBuffer::<Rgb<u8>, _>::from_raw(u32::from(width), u32::from(height), rgb)
                .map(DynamicImage::ImageRgb8)
                .ok_or_else(|| invalid_jpeg_buffer(source))
        }
        PixelFormat::L16 => Err(ThumbnailError::Unsupported(source.to_path_buf())),
    }?;
    if let Some(orientation) = orientation {
        image.apply_orientation(orientation);
    }
    Ok(image)
}

fn exif_orientation(exif: &[u8]) -> Option<u8> {
    if exif.len() < 8 {
        return None;
    }
    let little_endian = match &exif[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let read_u16 = |offset: usize| -> Option<u16> {
        let bytes: [u8; 2] = exif.get(offset..offset + 2)?.try_into().ok()?;
        Some(if little_endian {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        })
    };
    let read_u32 = |offset: usize| -> Option<u32> {
        let bytes: [u8; 4] = exif.get(offset..offset + 4)?.try_into().ok()?;
        Some(if little_endian {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        })
    };
    if read_u16(2)? != 42 {
        return None;
    }
    let directory = usize::try_from(read_u32(4)?).ok()?;
    let count = usize::from(read_u16(directory)?);
    for index in 0..count {
        let entry = directory.checked_add(2 + index * 12)?;
        if read_u16(entry)? == 0x0112 && read_u16(entry + 2)? == 3 {
            return u8::try_from(read_u16(entry + 8)?).ok();
        }
    }
    None
}

fn jpeg_decode_error(source: &Path, error: jpeg_decoder::Error) -> ThumbnailError {
    ThumbnailError::Decode {
        path: source.to_path_buf(),
        source: image::ImageError::Decoding(image::error::DecodingError::new(
            image::ImageFormat::Jpeg.into(),
            error,
        )),
    }
}

fn invalid_jpeg_buffer(source: &Path) -> ThumbnailError {
    ThumbnailError::Decode {
        path: source.to_path_buf(),
        source: image::ImageError::Decoding(image::error::DecodingError::new(
            image::ImageFormat::Jpeg.into(),
            io::Error::other("decoded JPEG buffer has an invalid size"),
        )),
    }
}

fn embedded_jpeg(source: &Path) -> Option<DynamicImage> {
    const MAX_PREVIEW_SEARCH_BYTES: u64 = 64 * 1024 * 1024;
    let mut bytes = Vec::new();
    std::fs::File::open(source)
        .ok()?
        .take(MAX_PREVIEW_SEARCH_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    let mut cursor = 0;
    let mut best: Option<DynamicImage> = None;
    while let Some(start_offset) = find_bytes(&bytes[cursor..], &[0xff, 0xd8, 0xff]) {
        let start = cursor + start_offset;
        let Some(end_offset) = find_bytes(&bytes[start + 3..], &[0xff, 0xd9]) else {
            break;
        };
        let end = start + 3 + end_offset + 2;
        if let Ok(candidate) =
            image::load_from_memory_with_format(&bytes[start..end], image::ImageFormat::Jpeg)
        {
            let candidate_area = u64::from(candidate.width()) * u64::from(candidate.height());
            let best_area = best.as_ref().map_or(0, |image| {
                u64::from(image.width()) * u64::from(image.height())
            });
            if candidate_area > best_area {
                best = Some(candidate);
            }
        }
        cursor = end;
    }
    best
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn is_raw(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some(
            "3fr"
                | "arw"
                | "cr2"
                | "cr3"
                | "dng"
                | "erf"
                | "iiq"
                | "kdc"
                | "mef"
                | "mos"
                | "mrw"
                | "nef"
                | "nrw"
                | "orf"
                | "pef"
                | "raf"
                | "raw"
                | "rw2"
                | "rwl"
                | "sr2"
                | "srf"
                | "x3f"
        )
    )
}

fn is_jpeg(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("jpg" | "jpeg")
    )
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| {
            u64::try_from(value.as_millis()).unwrap_or(u64::MAX)
        })
}
fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    #[test]
    fn caches_and_reuses_a_versioned_thumbnail() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.jpg");
        ImageBuffer::from_pixel(80, 40, Rgb([20_u8, 40, 60]))
            .save(&source)
            .unwrap();
        let cache = ThumbnailCache::open(directory.path().join("cache")).unwrap();

        let first = cache.get_or_create(&source, 32).unwrap();
        let second = cache.get_or_create(&source, 32).unwrap();

        assert!(!first.cache_hit);
        assert!(second.cache_hit);
        assert_eq!((first.width, first.height), (32, 16));
        assert!(first.path.is_file());
    }

    #[test]
    fn clear_removes_generated_files_without_touching_source() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.jpg");
        ImageBuffer::from_pixel(10, 10, Rgb([0_u8, 0, 0]))
            .save(&source)
            .unwrap();
        let cache = ThumbnailCache::open(directory.path().join("cache")).unwrap();
        let thumbnail = cache.get_or_create(&source, 8).unwrap();

        cache.clear().unwrap();

        assert!(source.is_file());
        assert!(!thumbnail.path.exists());
    }

    #[test]
    fn extracts_an_embedded_jpeg_from_a_raw_container() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.raw");
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(40, 20, Rgb([2, 4, 8])));
        let mut jpeg = std::io::Cursor::new(Vec::new());
        image.write_to(&mut jpeg, image::ImageFormat::Jpeg).unwrap();
        let mut raw = b"fake-raw-header".to_vec();
        raw.extend(jpeg.into_inner());
        std::fs::write(&source, raw).unwrap();
        let cache = ThumbnailCache::open(directory.path().join("cache")).unwrap();

        let thumbnail = cache.get_or_create(&source, 20).unwrap();

        assert_eq!((thumbnail.width, thumbnail.height), (20, 10));
    }

    #[test]
    fn source_change_and_dimension_are_part_of_the_cache_key() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.png");
        ImageBuffer::from_pixel(80, 40, Rgb([1_u8, 2, 3]))
            .save(&source)
            .unwrap();
        let cache = ThumbnailCache::open(directory.path().join("cache")).unwrap();
        let small = cache.get_or_create(&source, 20).unwrap();
        let large = cache.get_or_create(&source, 40).unwrap();
        ImageBuffer::from_pixel(81, 40, Rgb([4_u8, 5, 6]))
            .save(&source)
            .unwrap();
        let changed = cache.get_or_create(&source, 20).unwrap();

        assert_ne!(small.key, large.key);
        assert_ne!(small.key, changed.key);
        assert_eq!((small.width, small.height), (20, 10));
        assert_eq!((large.width, large.height), (40, 20));
        assert!(!changed.cache_hit);
    }

    #[test]
    fn regenerates_a_database_entry_whose_file_was_removed() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.jpg");
        ImageBuffer::from_pixel(20, 20, Rgb([1_u8, 2, 3]))
            .save(&source)
            .unwrap();
        let cache = ThumbnailCache::open(directory.path().join("cache")).unwrap();
        let first = cache.get_or_create(&source, 10).unwrap();
        std::fs::remove_file(&first.path).unwrap();

        let regenerated = cache.get_or_create(&source, 10).unwrap();

        assert!(!regenerated.cache_hit);
        assert!(regenerated.path.is_file());
    }

    #[test]
    fn reports_missing_and_corrupt_sources_without_creating_cache_files() {
        let directory = tempfile::tempdir().unwrap();
        let cache_root = directory.path().join("cache");
        let cache = ThumbnailCache::open(&cache_root).unwrap();
        let missing = directory.path().join("missing.jpg");
        assert!(matches!(
            cache.get_or_create(&missing, 10),
            Err(ThumbnailError::InspectSource { .. })
        ));
        let corrupt = directory.path().join("corrupt.jpg");
        std::fs::write(&corrupt, b"not-an-image").unwrap();
        assert!(matches!(
            cache.get_or_create(&corrupt, 10),
            Err(ThumbnailError::Decode { .. })
        ));
    }

    #[test]
    fn raw_without_an_embedded_jpeg_fails_cleanly() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.cr3");
        std::fs::write(&source, b"fake raw without preview").unwrap();
        let cache = ThumbnailCache::open(directory.path().join("cache")).unwrap();

        assert!(matches!(
            cache.get_or_create(&source, 10),
            Err(ThumbnailError::Decode { .. })
        ));
    }

    #[test]
    fn zero_limit_prunes_generated_entries() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.jpg");
        ImageBuffer::from_pixel(20, 20, Rgb([1_u8, 2, 3]))
            .save(&source)
            .unwrap();
        let cache = ThumbnailCache::open_with_limit(directory.path().join("cache"), 0).unwrap();

        let first = cache.get_or_create(&source, 10).unwrap();
        let second = cache.get_or_create(&source, 10).unwrap();

        assert!(!first.path.exists());
        assert!(!second.cache_hit);
    }

    #[test]
    fn reads_little_and_big_endian_exif_orientation() {
        let little = [
            b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0,
        ];
        let big = [
            b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 8, 0, 0,
        ];

        assert_eq!(exif_orientation(&little), Some(6));
        assert_eq!(exif_orientation(&big), Some(8));
    }

    #[test]
    fn opening_v2_removes_only_stale_version_directories() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("cache").join("thumbnails");
        fs::create_dir_all(root.join("v1")).unwrap();
        fs::create_dir_all(root.join("custom-data")).unwrap();
        fs::write(root.join("v1").join("old.webp"), b"old").unwrap();

        let _cache = ThumbnailCache::open(directory.path().join("cache")).unwrap();

        assert!(!root.join("v1").exists());
        assert!(root.join("v2").is_dir());
        assert!(root.join("custom-data").is_dir());
    }
}
