use std::fs;
use std::path::PathBuf;

use importer_domain::{AppSettings, CURRENT_SETTINGS_SCHEMA_VERSION};
use importer_settings::{
    JsonSettingsRepository, SettingsDecodeError, SettingsLoadSource, SettingsRepository,
    SettingsRepositoryError,
};
use tempfile::TempDir;

const CORRUPT_SETTINGS: &[u8] = include_bytes!("fixtures/corrupt-settings.txt");
const UNSUPPORTED_SETTINGS: &[u8] = include_bytes!("fixtures/unsupported-settings.json");
const INVALID_SETTINGS: &[u8] = include_bytes!("fixtures/invalid-settings.json");

fn repository() -> (TempDir, JsonSettingsRepository) {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let repository = JsonSettingsRepository::new(directory.path());
    (directory, repository)
}

fn changed_settings() -> AppSettings {
    let mut settings = AppSettings::default();
    settings.portable.import.event_gap_minutes = 45;
    settings.portable.naming.folder_template = "{date}-{event_name}".to_owned();
    settings
}

fn write(path: &std::path::Path, contents: &[u8]) {
    fs::create_dir_all(path.parent().expect("fixture path should have a parent"))
        .expect("fixture directory should be created");
    fs::write(path, contents).expect("fixture should be written");
}

#[test]
fn missing_file_returns_defaults_without_creating_a_file() {
    let (_directory, repository) = repository();

    let loaded = repository.load().expect("defaults should load");

    assert_eq!(loaded.settings, AppSettings::default());
    assert_eq!(loaded.source, SettingsLoadSource::Defaults);
    assert!(!repository.primary_path().exists());
    assert!(!repository.backup_path().exists());
}

#[test]
fn version_one_settings_are_migrated_to_per_card_behavior() {
    let (_directory, repository) = repository();
    let profile_id = "4f79c756-18d8-4f72-8a2f-cdc382787e48";
    let legacy = format!(
        r#"{{
          "schemaVersion": 1,
          "portable": {{
            "import": {{"defaultOperation":"copy","knownSourceBehavior":"ask","eventGapMinutes":120}},
            "naming": {{"folderTemplate":"{{year}}/{{date}}-{{event_name}}","collisionPolicy":"ask"}},
            "cameraProfiles": [{{"id":"{profile_id}","name":"X-T5","exifMatchers":[],"onConnect":"autoScan","defaultTimeOffsetSeconds":0}}]
          }},
          "local": {{"libraryPath":null,"startAtLogin":false,"minimizeToTray":true,
            "sourceBindings":[{{"sourceFingerprint":"sha256:card","cameraProfileId":"{profile_id}"}}]}}
        }}"#
    );
    write(&repository.primary_path(), legacy.as_bytes());

    let migrated = repository.load().unwrap().settings;

    assert_eq!(migrated.schema_version, 2);
    assert_eq!(migrated.local.max_concurrent_imports, 2);
    assert_eq!(migrated.local.source_bindings.len(), 1);
    assert_eq!(
        migrated.local.source_bindings[0].behavior,
        importer_domain::settings::SourceBehavior::AutoPreparePlan
    );
    assert_eq!(
        migrated.local.source_bindings[0].camera_profile_ids.len(),
        1
    );
}

#[test]
fn first_save_creates_pretty_json_that_round_trips() {
    let (_directory, repository) = repository();
    let expected = changed_settings();

    repository.save(&expected).expect("settings should save");
    let contents = fs::read_to_string(repository.primary_path()).expect("settings should be read");
    let loaded = repository.load().expect("settings should load");

    assert!(contents.ends_with('\n'));
    assert!(contents.contains("\n  \"schemaVersion\""));
    assert_eq!(loaded.settings, expected);
    assert_eq!(loaded.source, SettingsLoadSource::PrimaryFile);
    assert!(!repository.backup_path().exists());
}

#[test]
fn unicode_paths_round_trip() {
    let directory = tempfile::tempdir().expect("temporary directory should be created");
    let repository = JsonSettingsRepository::new(directory.path().join("zdjęcia-設定"));
    let mut expected = changed_settings();
    expected.local.library_path = Some(PathBuf::from("C:\\Zdjęcia\\Łódź 📷"));

    repository.save(&expected).expect("settings should save");

    assert_eq!(
        repository.load().expect("settings should load").settings,
        expected
    );
}

#[test]
fn second_save_preserves_previous_valid_version_as_backup() {
    let (_directory, repository) = repository();
    let first = AppSettings::default();
    let second = changed_settings();

    repository.save(&first).expect("first save should succeed");
    repository
        .save(&second)
        .expect("second save should succeed");

    assert_eq!(
        repository.load().expect("primary should load").settings,
        second
    );
    assert_eq!(repository.load_backup().expect("backup should load"), first);
}

#[test]
fn repeated_saves_replace_files_without_leaving_temporary_files() {
    let (directory, repository) = repository();

    for gap in [15, 30, 60, 90] {
        let mut settings = AppSettings::default();
        settings.portable.import.event_gap_minutes = gap;
        repository.save(&settings).expect("save should succeed");
    }

    let file_names: Vec<_> = fs::read_dir(directory.path())
        .expect("directory should be readable")
        .map(|entry| entry.expect("entry should be readable").file_name())
        .collect();
    assert_eq!(file_names.len(), 2);
    assert!(repository.primary_path().exists());
    assert!(repository.backup_path().exists());
}

#[test]
fn missing_backup_is_reported_explicitly() {
    let (_directory, repository) = repository();

    let error = repository
        .load_backup()
        .expect_err("missing backup should fail");

    assert!(matches!(
        error,
        SettingsRepositoryError::BackupNotFound { .. }
    ));
}

#[test]
fn corrupt_primary_reports_that_no_valid_backup_exists() {
    let (_directory, repository) = repository();
    write(&repository.primary_path(), CORRUPT_SETTINGS);

    let error = repository.load().expect_err("corrupt primary should fail");

    assert!(matches!(
        error,
        SettingsRepositoryError::CorruptedPrimary {
            backup_available: false,
            ..
        }
    ));
}

#[test]
fn corrupt_primary_reports_a_valid_backup() {
    let (_directory, repository) = repository();
    repository
        .save(&AppSettings::default())
        .expect("first save should succeed");
    repository
        .save(&changed_settings())
        .expect("second save should create backup");
    write(&repository.primary_path(), CORRUPT_SETTINGS);

    let error = repository.load().expect_err("corrupt primary should fail");

    assert!(matches!(
        error,
        SettingsRepositoryError::CorruptedPrimary {
            backup_available: true,
            ..
        }
    ));
}

#[test]
fn invalid_new_settings_never_touch_disk() {
    let (_directory, repository) = repository();
    let original = AppSettings::default();
    repository
        .save(&original)
        .expect("first save should succeed");
    let original_bytes = fs::read(repository.primary_path()).expect("primary should be readable");
    let mut invalid = changed_settings();
    invalid.portable.import.event_gap_minutes = 0;

    let error = repository
        .save(&invalid)
        .expect_err("invalid settings should not save");

    assert!(matches!(error, SettingsRepositoryError::Validation { .. }));
    assert_eq!(
        fs::read(repository.primary_path()).expect("primary should remain readable"),
        original_bytes
    );
    assert!(!repository.backup_path().exists());
}

#[test]
fn save_refuses_to_overwrite_a_corrupt_primary_or_existing_backup() {
    let (_directory, repository) = repository();
    let backup_bytes = serde_json::to_vec(&AppSettings::default()).expect("settings serialize");
    write(&repository.primary_path(), CORRUPT_SETTINGS);
    write(&repository.backup_path(), &backup_bytes);

    let error = repository
        .save(&changed_settings())
        .expect_err("save over corrupt primary should fail");

    assert!(matches!(
        error,
        SettingsRepositoryError::CorruptedPrimary {
            backup_available: true,
            ..
        }
    ));
    assert_eq!(
        fs::read(repository.primary_path()).unwrap(),
        CORRUPT_SETTINGS
    );
    assert_eq!(fs::read(repository.backup_path()).unwrap(), backup_bytes);
}

#[test]
fn restore_backup_replaces_corrupt_primary_and_keeps_backup() {
    let (_directory, repository) = repository();
    let expected = changed_settings();
    let backup_bytes = serde_json::to_vec_pretty(&expected).expect("settings serialize");
    write(&repository.primary_path(), CORRUPT_SETTINGS);
    write(&repository.backup_path(), &backup_bytes);

    let restored = repository
        .restore_backup()
        .expect("valid backup should restore");

    assert_eq!(restored, expected);
    assert_eq!(
        repository
            .load()
            .expect("restored primary should load")
            .settings,
        expected
    );
    assert_eq!(fs::read(repository.backup_path()).unwrap(), backup_bytes);
}

#[test]
fn invalid_backup_does_not_replace_primary() {
    let (_directory, repository) = repository();
    let expected = AppSettings::default();
    repository.save(&expected).expect("primary should save");
    let primary_bytes = fs::read(repository.primary_path()).expect("primary should be readable");
    write(&repository.backup_path(), INVALID_SETTINGS);

    let error = repository
        .restore_backup()
        .expect_err("invalid backup should fail");

    assert!(matches!(error, SettingsRepositoryError::InvalidBackup(_)));
    assert_eq!(fs::read(repository.primary_path()).unwrap(), primary_bytes);
}

#[test]
fn unsupported_schema_version_is_detected_before_deserialization() {
    let (_directory, repository) = repository();
    write(&repository.primary_path(), UNSUPPORTED_SETTINGS);

    let error = repository.load().expect_err("future version should fail");
    let SettingsRepositoryError::CorruptedPrimary { reason, .. } = error else {
        panic!("expected corrupted primary error");
    };

    assert!(reason.contains("unsupported schema version 999"));
    assert!(reason.contains(&CURRENT_SETTINGS_SCHEMA_VERSION.to_string()));
}

#[test]
fn missing_schema_version_is_detected_explicitly() {
    let (_directory, repository) = repository();
    write(
        &repository.backup_path(),
        br#"{"portable": {}, "local": {}}"#,
    );

    let error = repository
        .load_backup()
        .expect_err("missing schema version should fail");

    assert!(matches!(
        error,
        SettingsRepositoryError::InvalidBackup(SettingsDecodeError::MissingSchemaVersion { .. })
    ));
}

#[test]
fn unknown_fields_are_rejected_by_the_versioned_schema() {
    let (_directory, repository) = repository();
    let mut value = serde_json::to_value(AppSettings::default()).expect("settings serialize");
    value
        .as_object_mut()
        .expect("settings should be an object")
        .insert("surprise".to_owned(), serde_json::Value::Bool(true));
    write(
        &repository.backup_path(),
        &serde_json::to_vec(&value).expect("value should serialize"),
    );

    let error = repository
        .load_backup()
        .expect_err("unknown field should fail");

    assert!(matches!(
        error,
        SettingsRepositoryError::InvalidBackup(SettingsDecodeError::SchemaMismatch { .. })
    ));
}

#[test]
fn orphan_temporary_file_is_ignored() {
    let (directory, repository) = repository();
    repository
        .save(&changed_settings())
        .expect("settings should save");
    write(
        &directory.path().join(".photo-importer-settings-orphan.tmp"),
        CORRUPT_SETTINGS,
    );

    assert_eq!(
        repository.load().expect("primary should load").settings,
        changed_settings()
    );
}
