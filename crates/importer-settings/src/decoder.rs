use std::path::{Path, PathBuf};

use importer_domain::settings::SettingsValidationErrors;
use importer_domain::{AppSettings, CURRENT_SETTINGS_SCHEMA_VERSION};
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum SettingsDecodeError {
    #[error("settings file {path} does not contain valid JSON: {source}")]
    InvalidJson {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("settings file {path} has no schemaVersion")]
    MissingSchemaVersion { path: PathBuf },
    #[error("settings file {path} has a non-integer schemaVersion")]
    InvalidSchemaVersion { path: PathBuf },
    #[error(
        "settings file {path} uses unsupported schema version {found}; current version is {current}"
    )]
    UnsupportedSchemaVersion {
        path: PathBuf,
        found: u64,
        current: u32,
    },
    #[error("settings file {path} does not match schema version {version}: {source}")]
    SchemaMismatch {
        path: PathBuf,
        version: u32,
        #[source]
        source: serde_json::Error,
    },
    #[error("settings file {path} failed domain validation: {source}")]
    Validation {
        path: PathBuf,
        #[source]
        source: SettingsValidationErrors,
    },
}

pub(crate) fn decode_settings(
    bytes: &[u8],
    path: &Path,
) -> Result<AppSettings, SettingsDecodeError> {
    let mut value: Value =
        serde_json::from_slice(bytes).map_err(|source| SettingsDecodeError::InvalidJson {
            path: path.to_path_buf(),
            source,
        })?;

    let version_value =
        value
            .get("schemaVersion")
            .ok_or_else(|| SettingsDecodeError::MissingSchemaVersion {
                path: path.to_path_buf(),
            })?;
    let version =
        version_value
            .as_u64()
            .ok_or_else(|| SettingsDecodeError::InvalidSchemaVersion {
                path: path.to_path_buf(),
            })?;

    if version == 1 && CURRENT_SETTINGS_SCHEMA_VERSION == 2 {
        migrate_v1_to_v2(&mut value);
    } else if version != u64::from(CURRENT_SETTINGS_SCHEMA_VERSION) {
        return Err(SettingsDecodeError::UnsupportedSchemaVersion {
            path: path.to_path_buf(),
            found: version,
            current: CURRENT_SETTINGS_SCHEMA_VERSION,
        });
    }

    let settings: AppSettings =
        serde_json::from_value(value).map_err(|source| SettingsDecodeError::SchemaMismatch {
            path: path.to_path_buf(),
            version: CURRENT_SETTINGS_SCHEMA_VERSION,
            source,
        })?;

    settings
        .validate()
        .map_err(|source| SettingsDecodeError::Validation {
            path: path.to_path_buf(),
            source,
        })?;

    Ok(settings)
}

fn migrate_v1_to_v2(value: &mut Value) {
    let mut behavior_by_profile = std::collections::HashMap::<String, Value>::new();
    if let Some(portable) = value.get_mut("portable").and_then(Value::as_object_mut) {
        if let Some(import) = portable.get_mut("import").and_then(Value::as_object_mut)
            && let Some(behavior) = import.remove("knownSourceBehavior")
        {
            import.insert(
                "defaultSourceBehavior".to_owned(),
                migrate_behavior(behavior),
            );
        }
        if let Some(profiles) = portable
            .get_mut("cameraProfiles")
            .and_then(Value::as_array_mut)
        {
            for profile in profiles {
                if let Some(profile) = profile.as_object_mut()
                    && let Some(id) = profile.get("id").and_then(Value::as_str).map(str::to_owned)
                {
                    let behavior = profile
                        .remove("onConnect")
                        .map(migrate_behavior)
                        .unwrap_or_else(|| json!("ask"));
                    behavior_by_profile.insert(id, behavior);
                }
            }
        }
    }
    if let Some(local) = value.get_mut("local").and_then(Value::as_object_mut) {
        if let Some(bindings) = local
            .get_mut("sourceBindings")
            .and_then(Value::as_array_mut)
        {
            for binding in bindings {
                let Some(binding) = binding.as_object_mut() else {
                    continue;
                };
                let fingerprint = binding
                    .remove("sourceFingerprint")
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_default();
                let profile_id = binding
                    .remove("cameraProfileId")
                    .and_then(|value| value.as_str().map(str::to_owned));
                let id = stable_binding_id(&fingerprint);
                let behavior = profile_id
                    .as_ref()
                    .and_then(|id| behavior_by_profile.get(id))
                    .cloned()
                    .unwrap_or_else(|| json!("ask"));
                binding.insert("id".to_owned(), json!(id));
                binding.insert(
                    "sourceIdentity".to_owned(),
                    json!({
                        "markerUuid": null,
                        "platformVolumeId": null,
                        "fallbackFingerprint": fingerprint,
                    }),
                );
                binding.insert("displayName".to_owned(), json!(""));
                binding.insert("behavior".to_owned(), behavior);
                binding.insert(
                    "cameraProfileIds".to_owned(),
                    profile_id.map_or_else(|| json!([]), |id| json!([id])),
                );
                binding.insert("lastSeenAtUnixMs".to_owned(), Value::Null);
            }
        }
        local.insert("maxConcurrentImports".to_owned(), json!(2));
        local.insert("resumeAfterRestart".to_owned(), json!("ask"));
        local.insert("showWindowWhenPlanReady".to_owned(), json!(false));
        local.insert("notificationsEnabled".to_owned(), json!(true));
    }
    if let Some(root) = value.as_object_mut() {
        root.insert(
            "schemaVersion".to_owned(),
            json!(CURRENT_SETTINGS_SCHEMA_VERSION),
        );
    }
}

fn migrate_behavior(value: Value) -> Value {
    if value.as_str() == Some("autoScan") {
        json!("autoPreparePlan")
    } else {
        value
    }
}

fn stable_binding_id(fingerprint: &str) -> Uuid {
    fn fnv64(bytes: &[u8], seed: u64) -> u64 {
        bytes.iter().fold(seed, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
    }
    let mut bytes = [0_u8; 16];
    bytes[..8].copy_from_slice(&fnv64(fingerprint.as_bytes(), 0xcbf29ce484222325).to_be_bytes());
    bytes[8..].copy_from_slice(&fnv64(fingerprint.as_bytes(), 0x84222325cbf29ce4).to_be_bytes());
    Uuid::from_bytes(bytes)
}
