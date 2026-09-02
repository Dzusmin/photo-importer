use std::path::PathBuf;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const CURRENT_SETTINGS_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    pub schema_version: u32,
    pub portable: PortableSettings,
    pub local: LocalSettings,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableSettings {
    pub import: ImportSettings,
    pub naming: NamingSettings,
    pub camera_profiles: Vec<CameraProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportSettings {
    pub default_operation: ImportOperation,
    pub default_source_behavior: SourceBehavior,
    pub event_gap_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamingSettings {
    pub folder_template: String,
    pub collision_policy: CollisionPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CameraProfile {
    #[schemars(with = "String")]
    pub id: Uuid,
    pub name: String,
    pub exif_matchers: Vec<ExifCameraMatcher>,
    pub default_time_offset_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExifCameraMatcher {
    pub make: Option<String>,
    pub model: Option<String>,
    pub serial_number: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalSettings {
    pub library_path: Option<PathBuf>,
    pub start_at_login: bool,
    pub minimize_to_tray: bool,
    pub source_bindings: Vec<SourceBinding>,
    pub max_concurrent_imports: u8,
    pub resume_after_restart: ResumeAfterRestart,
    pub show_window_when_plan_ready: bool,
    pub notifications_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceBinding {
    #[schemars(with = "String")]
    pub id: Uuid,
    pub source_identity: SourceIdentity,
    pub display_name: String,
    pub behavior: SourceBehavior,
    #[schemars(with = "Vec<String>")]
    pub camera_profile_ids: Vec<Uuid>,
    #[serde(default, skip_serializing_if = "MarkerState::is_unknown")]
    pub marker_state: MarkerState,
    pub last_seen_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MarkerState {
    #[default]
    Unknown,
    Written,
    ReadOnly,
    WriteFailed,
}

impl MarkerState {
    fn is_unknown(&self) -> bool {
        *self == Self::Unknown
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceIdentity {
    #[schemars(with = "Option<String>")]
    pub marker_uuid: Option<Uuid>,
    pub platform_volume_id: Option<String>,
    pub fallback_fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ImportOperation {
    Copy,
    MoveAfterVerification,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SourceBehavior {
    Ask,
    #[serde(alias = "autoScan")]
    AutoPreparePlan,
    Ignore,
}

/// Shared physical-media role used by source and backup registries. A single
/// identity must never be registered in both roles at the same time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MediaRole {
    CameraSource,
    BackupTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ResumeAfterRestart {
    Ask,
    Automatic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CollisionPolicy {
    Ask,
    AppendSequence,
}
