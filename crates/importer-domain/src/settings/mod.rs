mod defaults;
mod model;
mod validation;

pub use defaults::{
    DEFAULT_EVENT_GAP_MINUTES, DEFAULT_FOLDER_TEMPLATE, MAX_EVENT_GAP_MINUTES,
    MIN_EVENT_GAP_MINUTES,
};
pub use model::{
    AppSettings, CURRENT_SETTINGS_SCHEMA_VERSION, CameraProfile, CollisionPolicy,
    ExifCameraMatcher, ImportOperation, ImportSettings, LocalSettings, MarkerState, MediaRole,
    NamingSettings, PortableSettings, ResumeAfterRestart, SourceBehavior, SourceBinding,
    SourceIdentity,
};
pub use validation::{
    SettingsValidationError, SettingsValidationErrorCode, SettingsValidationErrors,
};
