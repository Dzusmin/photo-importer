use std::path::{Path, PathBuf};
#[cfg(not(target_os = "windows"))]
use std::process::Command;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sysinfo::Disks;
use uuid::Uuid;

const SOURCE_MARKER: &str = ".photo-importer-source-id";
const SOURCE_MARKER_DIRECTORY: &str = ".photo-importer";
const SOURCE_MARKER_FILE: &str = "source.json";
const DISCOVERY_CACHE_TTL: Duration = Duration::from_secs(2);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceMarker {
    format_version: u32,
    source_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceVolume {
    pub fingerprint: String,
    pub marker_uuid: Option<Uuid>,
    pub platform_volume_id: Option<String>,
    pub name: String,
    pub mount_path: PathBuf,
    pub file_system: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub removable: bool,
    pub read_only: bool,
    pub contains_dcim: bool,
    pub likely_camera_source: bool,
}

pub trait SourceDiscovery {
    fn discover(&self) -> Vec<SourceVolume>;
}

/// Platform adapter used to obtain an identifier which survives mount-point
/// changes.  Failures are deliberately non-fatal: read-only cards and systems
/// without the native utility still use the marker UUID or guarded fallback.
pub trait VolumeIdProvider {
    fn volume_id(&self, mount_path: &Path) -> Option<String>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemVolumeIdProvider;

impl VolumeIdProvider for SystemVolumeIdProvider {
    fn volume_id(&self, mount_path: &Path) -> Option<String> {
        platform_volume_id(mount_path)
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemSourceDiscovery;

#[derive(Debug, Default)]
struct DiscoveryCacheState {
    volumes: Vec<SourceVolume>,
    refreshed_at: Option<Instant>,
    refreshing: bool,
}

#[derive(Debug, Default)]
struct DiscoveryCache {
    state: Mutex<DiscoveryCacheState>,
    refreshed: Condvar,
}

impl DiscoveryCache {
    fn get_or_refresh(
        &self,
        max_age: Duration,
        discover: impl FnOnce() -> Vec<SourceVolume>,
    ) -> Vec<SourceVolume> {
        let requested_at = Instant::now();
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        loop {
            if state
                .refreshed_at
                .is_some_and(|refreshed_at| refreshed_at.elapsed() <= max_age)
            {
                return state.volumes.clone();
            }
            if state.refreshing {
                state = self
                    .refreshed
                    .wait(state)
                    .unwrap_or_else(|error| error.into_inner());
                if state
                    .refreshed_at
                    .is_some_and(|refreshed_at| refreshed_at >= requested_at)
                {
                    return state.volumes.clone();
                }
                continue;
            }
            state.refreshing = true;
            break;
        }
        drop(state);

        let volumes = discover();
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.volumes = volumes.clone();
        state.refreshed_at = Some(Instant::now());
        state.refreshing = false;
        self.refreshed.notify_all();
        volumes
    }

    fn invalidate(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.refreshed_at = None;
    }
}

fn system_discovery_cache() -> &'static DiscoveryCache {
    static CACHE: OnceLock<DiscoveryCache> = OnceLock::new();
    CACHE.get_or_init(DiscoveryCache::default)
}

impl SourceDiscovery for SystemSourceDiscovery {
    fn discover(&self) -> Vec<SourceVolume> {
        system_discovery_cache().get_or_refresh(DISCOVERY_CACHE_TTL, discover_system_volumes)
    }
}

fn discover_system_volumes() -> Vec<SourceVolume> {
    let disks = Disks::new_with_refreshed_list();
    let mut volumes: Vec<_> = disks
        .list()
        .iter()
        .map(|disk| {
            let name = disk.name().to_string_lossy().into_owned();
            let file_system = disk.file_system().to_string_lossy().into_owned();
            let contains_dcim = contains_dcim(disk.mount_point());
            let removable = disk.is_removable();
            SourceVolume {
                fingerprint: source_fingerprint(&name, &file_system, disk.total_space()),
                marker_uuid: read_marker_uuid(disk.mount_point()),
                platform_volume_id: SystemVolumeIdProvider.volume_id(disk.mount_point()),
                name,
                mount_path: disk.mount_point().to_path_buf(),
                file_system,
                total_bytes: disk.total_space(),
                available_bytes: disk.available_space(),
                removable,
                read_only: disk.is_read_only(),
                contains_dcim,
                likely_camera_source: removable || contains_dcim,
            }
        })
        .collect();
    volumes.sort_by(|left, right| left.mount_path.cmp(&right.mount_path));
    volumes
}

#[cfg(target_os = "windows")]
fn platform_volume_id(_mount_path: &Path) -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn platform_volume_id(mount_path: &Path) -> Option<String> {
    command_value(
        "findmnt",
        &[
            "--noheadings",
            "--output",
            "UUID",
            "--target",
            &mount_path.to_string_lossy(),
        ],
    )
}

#[cfg(target_os = "macos")]
fn platform_volume_id(mount_path: &Path) -> Option<String> {
    let output = Command::new("diskutil")
        .args(["info", &mount_path.to_string_lossy()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            let (label, value) = line.split_once(':')?;
            matches!(label.trim(), "Volume UUID" | "Disk / Partition UUID")
                .then(|| normalized_id(value))
                .flatten()
        })
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn platform_volume_id(_mount_path: &Path) -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn command_value(program: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new(program).args(arguments).output().ok()?;
    output
        .status
        .success()
        .then(|| normalized_id(&String::from_utf8_lossy(&output.stdout)))?
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn normalized_id(value: &str) -> Option<String> {
    let value = value.trim().trim_matches(['{', '}']).trim();
    (!value.is_empty() && value != "-").then(|| value.to_ascii_lowercase())
}

fn read_marker_uuid(mount_path: &Path) -> Option<Uuid> {
    let versioned = mount_path
        .join(SOURCE_MARKER_DIRECTORY)
        .join(SOURCE_MARKER_FILE);
    if let Ok(contents) = std::fs::read(&versioned)
        && let Ok(marker) = serde_json::from_slice::<SourceMarker>(&contents)
        && marker.format_version == 1
    {
        return Some(marker.source_id);
    }
    std::fs::read_to_string(mount_path.join(SOURCE_MARKER))
        .ok()
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
}

pub fn ensure_source_marker(mount_path: &Path) -> std::io::Result<Uuid> {
    if let Some(id) = read_marker_uuid(mount_path) {
        system_discovery_cache().invalidate();
        return Ok(id);
    }
    let id = Uuid::new_v4();
    let directory = mount_path.join(SOURCE_MARKER_DIRECTORY);
    std::fs::create_dir_all(&directory)?;
    let destination = directory.join(SOURCE_MARKER_FILE);
    let temporary = directory.join(format!("source-{}.tmp", Uuid::new_v4()));
    let contents = serde_json::to_vec_pretty(&SourceMarker {
        format_version: 1,
        source_id: id,
    })
    .map_err(std::io::Error::other)?;
    std::fs::write(&temporary, contents)?;
    if let Err(error) = std::fs::rename(&temporary, &destination) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    system_discovery_cache().invalidate();
    Ok(id)
}

fn contains_dcim(mount_path: &Path) -> bool {
    ["DCIM", "dcim", "Dcim"]
        .into_iter()
        .any(|name| mount_path.join(name).is_dir())
}

fn source_fingerprint(name: &str, file_system: &str, total_bytes: u64) -> String {
    let mut hash = Sha256::new();
    hash.update(b"photo-importer-source-v1\0");
    hash.update(name.as_bytes());
    hash.update(b"\0");
    hash.update(file_system.as_bytes());
    hash.update(b"\0");
    hash.update(total_bytes.to_le_bytes());
    format!("sha256:{:x}", hash.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    #[test]
    fn fingerprint_is_stable_for_the_same_characteristics() {
        let first = source_fingerprint("CAMERA", "exFAT", 64_000);
        let second = source_fingerprint("CAMERA", "exFAT", 64_000);

        assert_eq!(first, second);
        assert!(first.starts_with("sha256:"));
        assert_eq!(first.len(), 71);
    }

    #[test]
    fn fingerprint_changes_with_source_characteristics() {
        assert_ne!(
            source_fingerprint("CAMERA", "exFAT", 64_000),
            source_fingerprint("CAMERA", "exFAT", 128_000)
        );
    }

    #[test]
    fn writes_and_reuses_a_versioned_source_marker() {
        let directory = tempfile::tempdir().unwrap();

        let first = ensure_source_marker(directory.path()).unwrap();
        let second = ensure_source_marker(directory.path()).unwrap();

        assert_eq!(first, second);
        let marker = directory
            .path()
            .join(SOURCE_MARKER_DIRECTORY)
            .join(SOURCE_MARKER_FILE);
        assert!(marker.is_file());
        assert_eq!(read_marker_uuid(directory.path()), Some(first));
    }

    #[test]
    fn concurrent_discovery_requests_share_one_refresh() {
        let cache = Arc::new(DiscoveryCache::default());
        let discoveries = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));
        let threads = (0..8)
            .map(|_| {
                let cache = Arc::clone(&cache);
                let discoveries = Arc::clone(&discoveries);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    cache.get_or_refresh(Duration::from_secs(60), || {
                        discoveries.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(50));
                        vec![source_volume_fixture()]
                    })
                })
            })
            .collect::<Vec<_>>();

        for thread in threads {
            assert_eq!(thread.join().unwrap(), vec![source_volume_fixture()]);
        }
        assert_eq!(discoveries.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn invalidating_discovery_cache_forces_the_next_refresh() {
        let cache = DiscoveryCache::default();
        let discoveries = AtomicUsize::new(0);
        let discover = || {
            discoveries.fetch_add(1, Ordering::SeqCst);
            vec![source_volume_fixture()]
        };

        cache.get_or_refresh(Duration::from_secs(60), discover);
        cache.get_or_refresh(Duration::from_secs(60), discover);
        assert_eq!(discoveries.load(Ordering::SeqCst), 1);

        cache.invalidate();
        cache.get_or_refresh(Duration::from_secs(60), discover);
        assert_eq!(discoveries.load(Ordering::SeqCst), 2);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_volume_identity_does_not_spawn_an_external_helper() {
        assert_eq!(platform_volume_id(Path::new("E:\\")), None);
    }

    fn source_volume_fixture() -> SourceVolume {
        SourceVolume {
            fingerprint: "card-fixture".into(),
            marker_uuid: None,
            platform_volume_id: None,
            name: "CARD".into(),
            mount_path: PathBuf::from("E:\\"),
            file_system: "exFAT".into(),
            total_bytes: 64_000,
            available_bytes: 32_000,
            removable: true,
            read_only: false,
            contains_dcim: true,
            likely_camera_source: true,
        }
    }
}
