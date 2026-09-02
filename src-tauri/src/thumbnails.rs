use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, RwLock};

use importer_thumbnails::{CachedThumbnail, ThumbnailCache, ThumbnailError};
use serde::Serialize;

#[derive(Debug, Clone)]
pub(crate) struct ThumbnailService {
    cache: ThumbnailCache,
    limiter: Arc<GenerationLimiter>,
    in_flight: Arc<Mutex<HashMap<String, Arc<InFlight>>>>,
    lifecycle: Arc<RwLock<()>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThumbnailPayload {
    key: String,
    path: PathBuf,
    mime_type: &'static str,
    width: u32,
    height: u32,
    cache_hit: bool,
    timings: ThumbnailTimingPayload,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailTimingPayload {
    lookup_ms: u64,
    decode_ms: u64,
    resize_ms: u64,
    encode_and_persist_ms: u64,
    database_ms: u64,
    total_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThumbnailCommandError {
    code: &'static str,
    message: String,
}

#[derive(Debug)]
struct GenerationLimiter {
    maximum: usize,
    active: Mutex<usize>,
    changed: Condvar,
}

#[derive(Debug, Default)]
struct InFlight {
    finished: Mutex<bool>,
    changed: Condvar,
}

struct GenerationPermit<'a>(&'a GenerationLimiter);

struct InFlightLeader {
    key: String,
    flights: Arc<Mutex<HashMap<String, Arc<InFlight>>>>,
    flight: Arc<InFlight>,
}

impl ThumbnailService {
    pub(crate) fn new(cache_directory: PathBuf) -> Result<Self, ThumbnailError> {
        let available = std::thread::available_parallelism().map_or(2, usize::from);
        Ok(Self {
            cache: ThumbnailCache::open(cache_directory)?,
            limiter: Arc::new(GenerationLimiter::new(available.clamp(2, 4))),
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            lifecycle: Arc::new(RwLock::new(())),
        })
    }

    fn get_or_create(
        &self,
        path: &std::path::Path,
        max_dimension: u32,
    ) -> Result<CachedThumbnail, ThumbnailCommandError> {
        loop {
            if let Some(cached) = self
                .cache
                .get_cached(path, max_dimension)
                .map_err(map_error)?
            {
                return Ok(cached);
            }
            let key = self.cache.key_for(path, max_dimension).map_err(map_error)?;
            let (flight, leader) = {
                let mut flights = self.in_flight.lock().map_err(|_| queue_error())?;
                if let Some(flight) = flights.get(&key) {
                    (Arc::clone(flight), false)
                } else {
                    let flight = Arc::new(InFlight::default());
                    flights.insert(key.clone(), Arc::clone(&flight));
                    (flight, true)
                }
            };
            if !leader {
                flight.wait()?;
                continue;
            }
            let _leader = InFlightLeader {
                key,
                flights: Arc::clone(&self.in_flight),
                flight,
            };
            let _permit = self.limiter.acquire()?;
            let _lifecycle = self.lifecycle.read().map_err(|_| queue_error())?;
            if let Some(cached) = self
                .cache
                .get_cached(path, max_dimension)
                .map_err(map_error)?
            {
                return Ok(cached);
            }
            return self
                .cache
                .get_or_create(path, max_dimension)
                .map_err(map_error);
        }
    }

    fn clear(&self) -> Result<(), ThumbnailCommandError> {
        let _lifecycle = self.lifecycle.write().map_err(|_| queue_error())?;
        self.cache.clear().map_err(map_error)
    }
}

impl GenerationLimiter {
    fn new(maximum: usize) -> Self {
        Self {
            maximum,
            active: Mutex::new(0),
            changed: Condvar::new(),
        }
    }

    fn acquire(&self) -> Result<GenerationPermit<'_>, ThumbnailCommandError> {
        let mut active = self.active.lock().map_err(|_| queue_error())?;
        while *active >= self.maximum {
            active = self.changed.wait(active).map_err(|_| queue_error())?;
        }
        *active += 1;
        Ok(GenerationPermit(self))
    }
}

impl Drop for GenerationPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = active.saturating_sub(1);
            self.0.changed.notify_one();
        }
    }
}

impl InFlight {
    fn wait(&self) -> Result<(), ThumbnailCommandError> {
        let mut finished = self.finished.lock().map_err(|_| queue_error())?;
        while !*finished {
            finished = self.changed.wait(finished).map_err(|_| queue_error())?;
        }
        Ok(())
    }
}

impl Drop for InFlightLeader {
    fn drop(&mut self) {
        if let Ok(mut finished) = self.flight.finished.lock() {
            *finished = true;
            self.flight.changed.notify_all();
        }
        if let Ok(mut flights) = self.flights.lock() {
            flights.remove(&self.key);
        }
    }
}

#[tauri::command]
pub(crate) async fn get_media_thumbnail(
    path: PathBuf,
    max_dimension: u32,
    service: tauri::State<'_, ThumbnailService>,
) -> Result<ThumbnailPayload, ThumbnailCommandError> {
    let max_dimension = max_dimension.clamp(64, 2_048);
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let thumbnail = service.get_or_create(&path, max_dimension)?;
        Ok(ThumbnailPayload {
            key: thumbnail.key,
            path: thumbnail.path,
            mime_type: "image/jpeg",
            width: thumbnail.width,
            height: thumbnail.height,
            cache_hit: thumbnail.cache_hit,
            timings: ThumbnailTimingPayload {
                lookup_ms: thumbnail.timings.lookup_ms,
                decode_ms: thumbnail.timings.decode_ms,
                resize_ms: thumbnail.timings.resize_ms,
                encode_and_persist_ms: thumbnail.timings.encode_and_persist_ms,
                database_ms: thumbnail.timings.database_ms,
                total_ms: thumbnail.timings.total_ms,
            },
        })
    })
    .await
    .map_err(|error| {
        ThumbnailCommandError::new(
            "thumbnailTaskFailed",
            format!("Generowanie miniatury zostało przerwane: {error}"),
        )
    })?
}

#[tauri::command]
pub(crate) async fn clear_thumbnail_cache(
    service: tauri::State<'_, ThumbnailService>,
) -> Result<(), ThumbnailCommandError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.clear())
        .await
        .map_err(|error| {
            ThumbnailCommandError::new(
                "thumbnailTaskFailed",
                format!("Czyszczenie cache zostało przerwane: {error}"),
            )
        })?
}

impl ThumbnailCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn queue_error() -> ThumbnailCommandError {
    ThumbnailCommandError::new(
        "thumbnailQueueFailed",
        "Kolejka miniaturek jest niedostępna.",
    )
}

fn map_error(error: ThumbnailError) -> ThumbnailCommandError {
    let code = if matches!(
        error,
        ThumbnailError::Unsupported(_) | ThumbnailError::Decode { .. }
    ) {
        "thumbnailUnsupported"
    } else {
        "thumbnailFailed"
    };
    ThumbnailCommandError::new(code, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    #[test]
    fn limiter_releases_its_permits() {
        let limiter = GenerationLimiter::new(2);
        let first = limiter.acquire().unwrap();
        let second = limiter.acquire().unwrap();
        assert_eq!(*limiter.active.lock().unwrap(), 2);
        drop(first);
        assert_eq!(*limiter.active.lock().unwrap(), 1);
        drop(second);
        assert_eq!(*limiter.active.lock().unwrap(), 0);
    }

    #[test]
    fn dropping_a_leader_releases_followers_and_removes_the_key() {
        let flights = Arc::new(Mutex::new(HashMap::new()));
        let flight = Arc::new(InFlight::default());
        flights
            .lock()
            .unwrap()
            .insert("same-key".to_owned(), Arc::clone(&flight));
        let leader = InFlightLeader {
            key: "same-key".to_owned(),
            flights: Arc::clone(&flights),
            flight: Arc::clone(&flight),
        };

        drop(leader);

        assert!(*flight.finished.lock().unwrap());
        assert!(flights.lock().unwrap().is_empty());
    }

    #[test]
    fn identical_concurrent_requests_generate_only_once() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("camera.jpg");
        ImageBuffer::from_pixel(1_200, 800, Rgb([20_u8, 40, 60]))
            .save(&source)
            .unwrap();
        let service = Arc::new(ThumbnailService::new(directory.path().join("cache")).unwrap());
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let service = Arc::clone(&service);
                let barrier = Arc::clone(&barrier);
                let source = source.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    service.get_or_create(&source, 320).unwrap()
                })
            })
            .collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();

        assert_eq!(results.iter().filter(|result| !result.cache_hit).count(), 1);
        assert!(results.windows(2).all(|pair| pair[0].path == pair[1].path));
    }
}
