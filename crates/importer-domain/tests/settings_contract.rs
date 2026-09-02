use importer_domain::settings::{
    AppSettings, CURRENT_SETTINGS_SCHEMA_VERSION, CollisionPolicy, DEFAULT_EVENT_GAP_MINUTES,
    DEFAULT_FOLDER_TEMPLATE, ImportOperation, SettingsValidationErrorCode, SourceBehavior,
};
use serde_json::Value;

const SETTINGS_V2_FIXTURE: &str = include_str!("fixtures/settings-v2.json");

#[test]
fn v2_fixture_matches_the_default_contract() {
    let fixture: AppSettings =
        serde_json::from_str(SETTINGS_V2_FIXTURE).expect("fixture should deserialize");

    assert_eq!(fixture, AppSettings::default());
    assert_eq!(fixture.schema_version, CURRENT_SETTINGS_SCHEMA_VERSION);
    assert_eq!(
        fixture.portable.import.default_operation,
        ImportOperation::Copy
    );
    assert_eq!(
        fixture.portable.import.default_source_behavior,
        SourceBehavior::Ask
    );
    assert_eq!(
        fixture.portable.import.event_gap_minutes,
        DEFAULT_EVENT_GAP_MINUTES
    );
    assert_eq!(
        fixture.portable.naming.folder_template,
        DEFAULT_FOLDER_TEMPLATE
    );
    assert_eq!(
        fixture.portable.naming.collision_policy,
        CollisionPolicy::Ask
    );
    fixture.validate().expect("fixture should be valid");
}

#[test]
fn v2_fixture_round_trips_without_changing_its_json_shape() {
    let fixture: AppSettings =
        serde_json::from_str(SETTINGS_V2_FIXTURE).expect("fixture should deserialize");
    let expected_json: Value =
        serde_json::from_str(SETTINGS_V2_FIXTURE).expect("fixture should be JSON");
    let serialized_json = serde_json::to_value(fixture).expect("settings should serialize");

    assert_eq!(serialized_json, expected_json);
}

#[test]
fn v2_contract_rejects_unknown_fields() {
    let mut fixture: Value =
        serde_json::from_str(SETTINGS_V2_FIXTURE).expect("fixture should be JSON");
    fixture["portable"]["unexpected"] = Value::Bool(true);

    let error = serde_json::from_value::<AppSettings>(fixture)
        .expect_err("unknown fields should be rejected");

    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn v2_contract_reports_an_unsupported_version() {
    let mut fixture: AppSettings =
        serde_json::from_str(SETTINGS_V2_FIXTURE).expect("fixture should deserialize");
    fixture.schema_version = CURRENT_SETTINGS_SCHEMA_VERSION + 1;

    let errors = fixture
        .validate()
        .expect_err("newer schema should be rejected");

    assert!(errors.contains_code(SettingsValidationErrorCode::UnsupportedSchemaVersion));
}
