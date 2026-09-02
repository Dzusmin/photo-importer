use super::{
    AppSettings, CURRENT_SETTINGS_SCHEMA_VERSION, CollisionPolicy, ImportOperation, ImportSettings,
    LocalSettings, NamingSettings, PortableSettings, ResumeAfterRestart, SourceBehavior,
};

pub const MIN_EVENT_GAP_MINUTES: u32 = 1;
pub const MAX_EVENT_GAP_MINUTES: u32 = 7 * 24 * 60;
pub const DEFAULT_EVENT_GAP_MINUTES: u32 = 120;
pub const DEFAULT_FOLDER_TEMPLATE: &str = "{year}/{date}-{event_name}";

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SETTINGS_SCHEMA_VERSION,
            portable: PortableSettings::default(),
            local: LocalSettings::default(),
        }
    }
}

impl Default for ImportSettings {
    fn default() -> Self {
        Self {
            default_operation: ImportOperation::Copy,
            default_source_behavior: SourceBehavior::Ask,
            event_gap_minutes: DEFAULT_EVENT_GAP_MINUTES,
        }
    }
}

impl Default for NamingSettings {
    fn default() -> Self {
        Self {
            folder_template: DEFAULT_FOLDER_TEMPLATE.to_owned(),
            collision_policy: CollisionPolicy::Ask,
        }
    }
}

impl Default for LocalSettings {
    fn default() -> Self {
        Self {
            library_path: None,
            start_at_login: false,
            minimize_to_tray: true,
            source_bindings: Vec::new(),
            max_concurrent_imports: 2,
            resume_after_restart: ResumeAfterRestart::Ask,
            show_window_when_plan_ready: false,
            notifications_enabled: true,
        }
    }
}
