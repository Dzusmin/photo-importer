//! Platform-neutral decisions for the background media-source monitor.

use std::collections::HashMap;

use importer_domain::AppSettings;
use importer_domain::settings::SourceBehavior;
use importer_media::SourceVolume;
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceConnection {
    pub volume: SourceVolume,
    pub binding_id: Uuid,
    pub profile_name: String,
    pub profile_names: Vec<String>,
    pub behavior: SourceBehavior,
    pub probable_match: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonitorChange {
    Connected(SourceConnection),
    BecameKnown(SourceConnection),
    UnknownConnected(SourceVolume),
    Disconnected(SourceVolume),
}

#[derive(Debug, Default)]
pub struct SourceSnapshot {
    known_volumes: HashMap<String, SourceVolume>,
    resolved_keys: std::collections::HashSet<String>,
}

impl SourceSnapshot {
    #[must_use]
    pub fn update(
        &mut self,
        volumes: Vec<SourceVolume>,
        settings: &AppSettings,
    ) -> Vec<MonitorChange> {
        let current: HashMap<_, _> = volumes
            .into_iter()
            .filter(|volume| volume.likely_camera_source)
            .map(|volume| (volume_key(&volume), volume))
            .collect();
        let mut changes = Vec::new();
        let resolved_keys: std::collections::HashSet<_> = current
            .iter()
            .filter(|(_, volume)| resolve_connection(volume, settings).is_some())
            .map(|(key, _)| key.clone())
            .collect();

        for (key, volume) in &current {
            if !self.known_volumes.contains_key(key) {
                changes.push(resolve_connection(volume, settings).map_or_else(
                    || MonitorChange::UnknownConnected(volume.clone()),
                    MonitorChange::Connected,
                ));
            } else if !self.resolved_keys.contains(key)
                && let Some(connection) = resolve_connection(volume, settings)
            {
                changes.push(MonitorChange::BecameKnown(connection));
            }
        }
        for (key, volume) in &self.known_volumes {
            if !current.contains_key(key) {
                changes.push(MonitorChange::Disconnected(volume.clone()));
            }
        }

        changes.sort_by_key(change_key);
        self.known_volumes = current;
        self.resolved_keys = resolved_keys;
        changes
    }
}

#[must_use]
pub fn resolve_connection(
    volume: &SourceVolume,
    settings: &AppSettings,
) -> Option<SourceConnection> {
    let (binding, (_, probable_match)) = settings
        .local
        .source_bindings
        .iter()
        .filter_map(|binding| identity_match(binding, volume).map(|matched| (binding, matched)))
        .max_by_key(|(_, (strength, _))| *strength)?;
    let profile_names: Vec<_> = settings
        .portable
        .camera_profiles
        .iter()
        .filter(|profile| binding.camera_profile_ids.contains(&profile.id))
        .map(|profile| profile.name.clone())
        .collect();

    Some(SourceConnection {
        volume: volume.clone(),
        binding_id: binding.id,
        profile_name: profile_names
            .first()
            .cloned()
            .unwrap_or_else(|| "Nieznany aparat".to_owned()),
        profile_names,
        behavior: if probable_match {
            SourceBehavior::Ask
        } else {
            binding.behavior
        },
        probable_match,
    })
}

fn identity_match(
    binding: &importer_domain::settings::SourceBinding,
    volume: &SourceVolume,
) -> Option<(u8, bool)> {
    let identity = &binding.source_identity;
    if identity.marker_uuid.is_some() && identity.marker_uuid == volume.marker_uuid {
        return Some((3, false));
    }
    if identity.platform_volume_id.is_some()
        && identity.platform_volume_id == volume.platform_volume_id
    {
        return Some((2, false));
    }
    if identity.fallback_fingerprint == volume.fingerprint {
        // A fallback-only legacy binding is the best identity it can have. If
        // stronger signals were recorded and no longer match, confirmation is
        // required before automation is allowed.
        let probable = identity.marker_uuid.is_some() || identity.platform_volume_id.is_some();
        return Some((u8::from(!probable), probable));
    }
    None
}

fn volume_key(volume: &SourceVolume) -> String {
    format!("{}\0{}", volume.fingerprint, volume.mount_path.display())
}

fn change_key(change: &MonitorChange) -> String {
    match change {
        MonitorChange::Connected(connection) => volume_key(&connection.volume),
        MonitorChange::BecameKnown(connection) => volume_key(&connection.volume),
        MonitorChange::UnknownConnected(volume) => volume_key(volume),
        MonitorChange::Disconnected(volume) => volume_key(volume),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use importer_domain::settings::{CameraProfile, SourceBinding, SourceIdentity};
    use uuid::Uuid;

    use super::*;

    fn volume(fingerprint: &str, mount: &str) -> SourceVolume {
        SourceVolume {
            fingerprint: fingerprint.to_owned(),
            marker_uuid: None,
            platform_volume_id: None,
            name: "CAMERA".to_owned(),
            mount_path: PathBuf::from(mount),
            file_system: "exFAT".to_owned(),
            total_bytes: 64_000,
            available_bytes: 32_000,
            removable: true,
            read_only: false,
            contains_dcim: true,
            likely_camera_source: true,
        }
    }

    fn settings(fingerprint: &str, behavior: SourceBehavior) -> AppSettings {
        let profile_id = Uuid::new_v4();
        let mut settings = AppSettings::default();
        settings.portable.camera_profiles.push(CameraProfile {
            id: profile_id,
            name: "Aparat rodzinny".to_owned(),
            exif_matchers: Vec::new(),
            default_time_offset_seconds: 0,
        });
        settings.local.source_bindings.push(SourceBinding {
            id: Uuid::new_v4(),
            source_identity: SourceIdentity {
                marker_uuid: None,
                platform_volume_id: None,
                fallback_fingerprint: fingerprint.to_owned(),
            },
            display_name: "CAMERA".to_owned(),
            behavior,
            camera_profile_ids: vec![profile_id],
            marker_state: Default::default(),
            last_seen_at_unix_ms: None,
        });
        settings
    }

    #[test]
    fn reports_a_known_source_only_once_until_it_is_disconnected() {
        let settings = settings("card", SourceBehavior::AutoPreparePlan);
        let mut snapshot = SourceSnapshot::default();

        let first = snapshot.update(vec![volume("card", "E:/")], &settings);
        let unchanged = snapshot.update(vec![volume("card", "E:/")], &settings);
        let removed = snapshot.update(Vec::new(), &settings);
        let reconnected = snapshot.update(vec![volume("card", "E:/")], &settings);

        assert!(matches!(first[0], MonitorChange::Connected(_)));
        assert!(unchanged.is_empty());
        assert!(matches!(removed[0], MonitorChange::Disconnected(_)));
        assert!(matches!(reconnected[0], MonitorChange::Connected(_)));
    }

    #[test]
    fn reports_unknown_camera_volumes_and_ignores_non_camera_volumes() {
        let settings = settings("known", SourceBehavior::Ask);
        let mut non_camera = volume("known", "C:/");
        non_camera.removable = false;
        non_camera.contains_dcim = false;
        non_camera.likely_camera_source = false;
        let mut snapshot = SourceSnapshot::default();

        let changes = snapshot.update(vec![volume("unknown", "D:/"), non_camera], &settings);

        assert_eq!(changes.len(), 1);
        assert!(matches!(changes[0], MonitorChange::UnknownConnected(_)));
    }

    #[test]
    fn profile_behavior_is_used_for_a_bound_source() {
        let settings = settings("card", SourceBehavior::Ignore);

        let connection = resolve_connection(&volume("card", "E:/"), &settings).unwrap();

        assert_eq!(connection.profile_name, "Aparat rodzinny");
        assert_eq!(connection.behavior, SourceBehavior::Ignore);
    }

    #[test]
    fn treats_the_same_card_mounted_at_two_paths_as_two_connections() {
        let settings = settings("card", SourceBehavior::Ask);
        let mut snapshot = SourceSnapshot::default();

        let changes = snapshot.update(
            vec![volume("card", "E:/"), volume("card", "F:/")],
            &settings,
        );

        assert_eq!(changes.len(), 2);
        assert!(
            matches!(&changes[0], MonitorChange::Connected(connection) if connection.volume.mount_path.as_path() == std::path::Path::new("E:/"))
        );
        assert!(
            matches!(&changes[1], MonitorChange::Connected(connection) if connection.volume.mount_path.as_path() == std::path::Path::new("F:/"))
        );
    }

    #[test]
    fn detects_a_card_that_becomes_known_while_still_connected() {
        let mut snapshot = SourceSnapshot::default();
        assert!(matches!(
            snapshot.update(vec![volume("card", "E:/")], &AppSettings::default())[0],
            MonitorChange::UnknownConnected(_)
        ));

        let changes = snapshot.update(
            vec![volume("card", "E:/")],
            &settings("card", SourceBehavior::AutoPreparePlan),
        );

        assert!(matches!(changes[0], MonitorChange::BecameKnown(_)));
    }

    #[test]
    fn reports_disconnects_for_unknown_camera_sources() {
        let mut snapshot = SourceSnapshot::default();
        let _ = snapshot.update(vec![volume("unknown", "E:/")], &AppSettings::default());

        assert!(matches!(
            snapshot.update(Vec::new(), &AppSettings::default())[0],
            MonitorChange::Disconnected(_)
        ));
    }

    #[test]
    fn binding_without_a_matching_profile_is_reported_as_unknown_camera() {
        let mut settings = AppSettings::default();
        settings.local.source_bindings.push(SourceBinding {
            id: Uuid::new_v4(),
            source_identity: SourceIdentity {
                marker_uuid: None,
                platform_volume_id: None,
                fallback_fingerprint: "card".to_owned(),
            },
            display_name: "CAMERA".to_owned(),
            behavior: SourceBehavior::Ask,
            camera_profile_ids: vec![Uuid::new_v4()],
            marker_state: Default::default(),
            last_seen_at_unix_ms: None,
        });

        let connection = resolve_connection(&volume("card", "E:/"), &settings).unwrap();
        assert_eq!(connection.profile_name, "Nieznany aparat");
    }

    #[test]
    fn marker_identity_wins_over_the_same_fallback_fingerprint() {
        let marker_a = Uuid::new_v4();
        let marker_b = Uuid::new_v4();
        let profile_a = Uuid::new_v4();
        let profile_b = Uuid::new_v4();
        let mut settings = AppSettings::default();
        for (id, name) in [(profile_a, "Canon"), (profile_b, "Nikon")] {
            settings.portable.camera_profiles.push(CameraProfile {
                id,
                name: name.into(),
                exif_matchers: Vec::new(),
                default_time_offset_seconds: 0,
            });
        }
        for (marker, profile) in [(marker_a, profile_a), (marker_b, profile_b)] {
            settings.local.source_bindings.push(SourceBinding {
                id: Uuid::new_v4(),
                source_identity: SourceIdentity {
                    marker_uuid: Some(marker),
                    platform_volume_id: None,
                    fallback_fingerprint: "same-card-layout".into(),
                },
                display_name: "Karta".into(),
                behavior: SourceBehavior::AutoPreparePlan,
                camera_profile_ids: vec![profile],
                marker_state: Default::default(),
                last_seen_at_unix_ms: None,
            });
        }
        let mut card = volume("same-card-layout", "E:/");
        card.marker_uuid = Some(marker_b);

        let connection = resolve_connection(&card, &settings).unwrap();

        assert_eq!(connection.profile_name, "Nikon");
        assert!(!connection.probable_match);
        assert_eq!(connection.behavior, SourceBehavior::AutoPreparePlan);
    }

    #[test]
    fn fallback_mismatch_never_starts_automatic_import() {
        let marker = Uuid::new_v4();
        let mut settings = settings("card", SourceBehavior::AutoPreparePlan);
        settings.local.source_bindings[0]
            .source_identity
            .marker_uuid = Some(marker);

        let connection = resolve_connection(&volume("card", "E:/"), &settings).unwrap();

        assert!(connection.probable_match);
        assert_eq!(connection.behavior, SourceBehavior::Ask);
    }
}
