//! Pure domain rules for Photo Importer.
//!
//! This crate deliberately has no dependency on Tauri or an operating system.

pub const PRODUCT_NAME: &str = "Photo Importer";

pub mod settings;

pub use settings::{AppSettings, CURRENT_SETTINGS_SCHEMA_VERSION};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_has_a_stable_name() {
        assert_eq!(PRODUCT_NAME, "Photo Importer");
    }
}
