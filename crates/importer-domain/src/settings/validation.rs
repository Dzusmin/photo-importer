use std::collections::HashSet;
use std::fmt;

use thiserror::Error;
use uuid::Uuid;

use super::{
    AppSettings, CURRENT_SETTINGS_SCHEMA_VERSION, ExifCameraMatcher, MAX_EVENT_GAP_MINUTES,
    MIN_EVENT_GAP_MINUTES,
};

const ALLOWED_TEMPLATE_VARIABLES: &[&str] = &[
    "year",
    "month",
    "day",
    "date",
    "event_name",
    "camera_make",
    "camera_model",
    "camera_alias",
    "source_alias",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsValidationErrorCode {
    UnsupportedSchemaVersion,
    OutOfRange,
    EmptyValue,
    InvalidTemplate,
    DuplicateValue,
    MissingReference,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsValidationError {
    pub path: String,
    pub code: SettingsValidationErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("settings validation failed with {count} error(s)", count = .errors.len())]
pub struct SettingsValidationErrors {
    errors: Vec<SettingsValidationError>,
}

impl SettingsValidationErrors {
    #[must_use]
    pub fn errors(&self) -> &[SettingsValidationError] {
        &self.errors
    }

    #[must_use]
    pub fn contains_code(&self, code: SettingsValidationErrorCode) -> bool {
        self.errors.iter().any(|error| error.code == code)
    }
}

impl AppSettings {
    pub fn validate(&self) -> Result<(), SettingsValidationErrors> {
        let mut errors = Vec::new();

        if self.schema_version != CURRENT_SETTINGS_SCHEMA_VERSION {
            errors.push(error(
                "schemaVersion",
                SettingsValidationErrorCode::UnsupportedSchemaVersion,
                format!(
                    "expected schema version {CURRENT_SETTINGS_SCHEMA_VERSION}, found {}",
                    self.schema_version
                ),
            ));
        }

        let event_gap = self.portable.import.event_gap_minutes;
        if !(MIN_EVENT_GAP_MINUTES..=MAX_EVENT_GAP_MINUTES).contains(&event_gap) {
            errors.push(error(
                "portable.import.eventGapMinutes",
                SettingsValidationErrorCode::OutOfRange,
                format!(
                    "event gap must be between {MIN_EVENT_GAP_MINUTES} and \
                     {MAX_EVENT_GAP_MINUTES} minutes"
                ),
            ));
        }

        if let Err(message) = validate_folder_template(&self.portable.naming.folder_template) {
            errors.push(error(
                "portable.naming.folderTemplate",
                SettingsValidationErrorCode::InvalidTemplate,
                message,
            ));
        }

        validate_profiles(self, &mut errors);
        validate_source_bindings(self, &mut errors);

        if !(1..=8).contains(&self.local.max_concurrent_imports) {
            errors.push(error(
                "local.maxConcurrentImports",
                SettingsValidationErrorCode::OutOfRange,
                "maximum concurrent imports must be between 1 and 8",
            ));
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(SettingsValidationErrors { errors })
        }
    }
}

fn validate_profiles(settings: &AppSettings, errors: &mut Vec<SettingsValidationError>) {
    let mut profile_ids = HashSet::new();

    for (profile_index, profile) in settings.portable.camera_profiles.iter().enumerate() {
        let profile_path = format!("portable.cameraProfiles[{profile_index}]");

        if !profile_ids.insert(profile.id) {
            errors.push(error(
                format!("{profile_path}.id"),
                SettingsValidationErrorCode::DuplicateValue,
                "camera profile id must be unique",
            ));
        }

        if profile.name.trim().is_empty() {
            errors.push(error(
                format!("{profile_path}.name"),
                SettingsValidationErrorCode::EmptyValue,
                "camera profile name cannot be empty",
            ));
        }

        for (matcher_index, matcher) in profile.exif_matchers.iter().enumerate() {
            if matcher_is_empty(matcher) {
                errors.push(error(
                    format!("{profile_path}.exifMatchers[{matcher_index}]"),
                    SettingsValidationErrorCode::EmptyValue,
                    "an EXIF matcher must define make, model, or serial number",
                ));
            }
        }
    }
}

fn validate_source_bindings(settings: &AppSettings, errors: &mut Vec<SettingsValidationError>) {
    let profile_ids: HashSet<Uuid> = settings
        .portable
        .camera_profiles
        .iter()
        .map(|profile| profile.id)
        .collect();
    let mut binding_ids = HashSet::new();
    let mut fallback_only_fingerprints = HashSet::new();
    let mut marker_ids = HashSet::new();
    let mut platform_ids = HashSet::new();

    for (binding_index, binding) in settings.local.source_bindings.iter().enumerate() {
        let binding_path = format!("local.sourceBindings[{binding_index}]");
        if !binding_ids.insert(binding.id) {
            errors.push(error(
                format!("{binding_path}.id"),
                SettingsValidationErrorCode::DuplicateValue,
                "source binding id must be unique",
            ));
        }
        let fingerprint = binding.source_identity.fallback_fingerprint.trim();

        if fingerprint.is_empty() {
            errors.push(error(
                format!("{binding_path}.sourceIdentity.fallbackFingerprint"),
                SettingsValidationErrorCode::EmptyValue,
                "source fingerprint cannot be empty",
            ));
        } else if binding.source_identity.marker_uuid.is_none()
            && binding.source_identity.platform_volume_id.is_none()
            && !fallback_only_fingerprints.insert(fingerprint)
        {
            errors.push(error(
                format!("{binding_path}.sourceIdentity.fallbackFingerprint"),
                SettingsValidationErrorCode::DuplicateValue,
                "source fingerprint must be unique",
            ));
        }

        if let Some(marker) = binding.source_identity.marker_uuid
            && !marker_ids.insert(marker)
        {
            errors.push(error(
                format!("{binding_path}.sourceIdentity.markerUuid"),
                SettingsValidationErrorCode::DuplicateValue,
                "source marker UUID must be unique",
            ));
        }
        if let Some(platform_id) = binding.source_identity.platform_volume_id.as_deref()
            && !platform_ids.insert(platform_id.trim().to_ascii_lowercase())
        {
            errors.push(error(
                format!("{binding_path}.sourceIdentity.platformVolumeId"),
                SettingsValidationErrorCode::DuplicateValue,
                "platform volume identifier must be unique",
            ));
        }

        for (profile_index, profile_id) in binding.camera_profile_ids.iter().enumerate() {
            if !profile_ids.contains(profile_id) {
                errors.push(error(
                    format!("{binding_path}.cameraProfileIds[{profile_index}]"),
                    SettingsValidationErrorCode::MissingReference,
                    "source binding references an unknown camera profile",
                ));
            }
        }
    }
}

fn matcher_is_empty(matcher: &ExifCameraMatcher) -> bool {
    [&matcher.make, &matcher.model, &matcher.serial_number]
        .into_iter()
        .all(|value| {
            value.as_deref().is_none_or(str::is_empty)
                || value.as_ref().is_some_and(|v| v.trim().is_empty())
        })
}

fn validate_folder_template(template: &str) -> Result<(), String> {
    if template.trim().is_empty() {
        return Err("folder template cannot be empty".to_owned());
    }

    let normalized = template.replace('\\', "/");
    if normalized.starts_with('/') || normalized.as_bytes().get(1) == Some(&b':') {
        return Err("folder template must be a relative path".to_owned());
    }
    if normalized
        .split('/')
        .any(|component| component == "." || component == "..")
    {
        return Err("folder template cannot contain . or .. path components".to_owned());
    }

    let mut characters = template.chars().peekable();

    while let Some(character) = characters.next() {
        match character {
            '{' => {
                let mut variable = String::new();
                let mut closed = false;

                for inner in characters.by_ref() {
                    match inner {
                        '}' => {
                            closed = true;
                            break;
                        }
                        '{' => return Err("nested opening brace in folder template".to_owned()),
                        _ => variable.push(inner),
                    }
                }

                if !closed {
                    return Err("unclosed variable in folder template".to_owned());
                }
                if !ALLOWED_TEMPLATE_VARIABLES.contains(&variable.as_str()) {
                    return Err(format!("unknown template variable: {{{variable}}}"));
                }
            }
            '}' => return Err("closing brace without an opening brace".to_owned()),
            _ => {}
        }
    }

    Ok(())
}

fn error(
    path: impl Into<String>,
    code: SettingsValidationErrorCode,
    message: impl fmt::Display,
) -> SettingsValidationError {
    SettingsValidationError {
        path: path.into(),
        code,
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{
        CameraProfile, ExifCameraMatcher, SourceBehavior, SourceBinding, SourceIdentity,
    };

    #[test]
    fn defaults_are_valid() {
        assert_eq!(AppSettings::default().validate(), Ok(()));
    }

    #[test]
    fn reports_all_independent_errors() {
        let mut settings = AppSettings {
            schema_version: 999,
            ..AppSettings::default()
        };
        settings.portable.import.event_gap_minutes = 0;
        settings.portable.naming.folder_template = "{unknown}".to_owned();

        let errors = settings.validate().expect_err("settings should be invalid");

        assert_eq!(errors.errors().len(), 3);
        assert!(errors.contains_code(SettingsValidationErrorCode::UnsupportedSchemaVersion));
        assert!(errors.contains_code(SettingsValidationErrorCode::OutOfRange));
        assert!(errors.contains_code(SettingsValidationErrorCode::InvalidTemplate));
    }

    #[test]
    fn rejects_empty_exif_matcher_and_unknown_profile_binding() {
        let mut settings = AppSettings::default();
        settings.portable.camera_profiles.push(CameraProfile {
            id: Uuid::new_v4(),
            name: "Camera".to_owned(),
            exif_matchers: vec![ExifCameraMatcher {
                make: None,
                model: Some("  ".to_owned()),
                serial_number: None,
            }],
            default_time_offset_seconds: 0,
        });
        settings.local.source_bindings.push(SourceBinding {
            id: Uuid::new_v4(),
            source_identity: SourceIdentity {
                marker_uuid: None,
                platform_volume_id: None,
                fallback_fingerprint: "volume:example".to_owned(),
            },
            display_name: "Example".to_owned(),
            behavior: SourceBehavior::Ask,
            camera_profile_ids: vec![Uuid::new_v4()],
            marker_state: Default::default(),
            last_seen_at_unix_ms: None,
        });

        let errors = settings.validate().expect_err("settings should be invalid");

        assert!(errors.contains_code(SettingsValidationErrorCode::EmptyValue));
        assert!(errors.contains_code(SettingsValidationErrorCode::MissingReference));
    }

    #[test]
    fn rejects_unbalanced_template_braces() {
        let mut settings = AppSettings::default();
        settings.portable.naming.folder_template = "{year/{event_name}".to_owned();

        let errors = settings.validate().expect_err("settings should be invalid");

        assert!(errors.contains_code(SettingsValidationErrorCode::InvalidTemplate));
    }

    #[test]
    fn rejects_absolute_and_parent_folder_templates() {
        for template in ["../outside", "/absolute", "C:\\absolute"] {
            let mut settings = AppSettings::default();
            settings.portable.naming.folder_template = template.to_owned();

            let errors = settings.validate().expect_err("template should be unsafe");

            assert!(errors.contains_code(SettingsValidationErrorCode::InvalidTemplate));
        }
    }
}
