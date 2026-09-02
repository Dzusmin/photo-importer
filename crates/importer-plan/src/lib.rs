//! Deterministic, read-only planning of imports into a photo library.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Component, Path, PathBuf};

use chrono::{Datelike, Local, TimeZone};
use importer_domain::settings::CollisionPolicy;
use importer_media::{EventGroup, MediaFileKind, MediaItem};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateContext {
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub camera_alias: Option<String>,
    pub source_alias: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPlanInput {
    pub event: EventGroup,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildImportPlanRequest {
    pub library_root: PathBuf,
    pub folder_template: String,
    pub collision_policy: CollisionPolicy,
    pub events: Vec<EventPlanInput>,
    pub excluded_item_keys: BTreeSet<String>,
    pub excluded_source_paths: BTreeSet<PathBuf>,
    pub context: TemplateContext,
    pub item_contexts: BTreeMap<String, TemplateContext>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportPlanStatus {
    Ready,
    RequiresDecision,
    Empty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanConflictKind {
    DestinationExists,
    DuplicateDestination,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanConflict {
    pub kind: PlanConflictKind,
    pub item_key: String,
    pub destination_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedFileOperation {
    pub source_path: PathBuf,
    pub source_relative_path: PathBuf,
    pub destination_path: PathBuf,
    pub destination_relative_path: PathBuf,
    pub kind: MediaFileKind,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedMediaItem {
    pub item_key: String,
    pub captured_at_unix_ms: u64,
    pub total_size_bytes: u64,
    pub files: Vec<PlannedFileOperation>,
    pub has_raw_jpeg_pair: bool,
    pub has_sidecar: bool,
    pub camera_alias: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedEvent {
    pub event_index: usize,
    pub event_name: String,
    pub folder_relative_path: PathBuf,
    pub starts_at_unix_ms: u64,
    pub total_size_bytes: u64,
    pub items: Vec<PlannedMediaItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub status: ImportPlanStatus,
    pub library_root: PathBuf,
    pub events: Vec<PlannedEvent>,
    pub conflicts: Vec<PlanConflict>,
    pub item_count: usize,
    pub file_count: usize,
    pub total_size_bytes: u64,
    pub excluded_item_count: usize,
    pub excluded_file_count: usize,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PlanError {
    #[error("library path is not configured")]
    MissingLibraryPath,
    #[error("event {event_index} has no name")]
    EmptyEventName { event_index: usize },
    #[error("folder template contains an unsupported variable: {{{0}}}")]
    UnknownTemplateVariable(String),
    #[error("folder template has unbalanced braces")]
    UnbalancedTemplate,
    #[error("folder template resolves outside the library")]
    UnsafeTemplatePath,
}

pub fn build_import_plan(request: BuildImportPlanRequest) -> Result<ImportPlan, PlanError> {
    if request.library_root.as_os_str().is_empty() {
        return Err(PlanError::MissingLibraryPath);
    }

    let mut events = request.events;
    events.sort_by_key(|input| (input.event.starts_at_unix_ms, input.event.index));
    let mut planned_paths = HashSet::new();
    let mut planned_events = Vec::new();
    let mut conflicts = Vec::new();
    let mut excluded_item_count = 0;
    let mut excluded_file_count = 0;
    let excluded_source_paths: HashSet<_> = request
        .excluded_source_paths
        .iter()
        .map(|path| normalized_path_key(path))
        .collect();

    for input in events {
        let event_name = input.name.trim();
        if event_name.is_empty() {
            return Err(PlanError::EmptyEventName {
                event_index: input.event.index,
            });
        }
        let mut items = input.event.items;
        items.sort_by_key(|item| (item.captured_at_unix_ms, item.key.clone()));
        let mut planned_items = BTreeMap::<PathBuf, Vec<PlannedMediaItem>>::new();

        for item in items {
            if request.excluded_item_keys.contains(&item.key) {
                excluded_item_count += 1;
                continue;
            }
            let skipped_files = item
                .files
                .iter()
                .filter(|file| excluded_source_paths.contains(&normalized_path_key(&file.path)))
                .count();
            excluded_file_count += skipped_files;
            if skipped_files == item.files.len() {
                excluded_item_count += 1;
                continue;
            }
            let context = request
                .item_contexts
                .get(&item.key)
                .unwrap_or(&request.context);
            let folder = render_folder_template(
                &request.folder_template,
                input.event.starts_at_unix_ms,
                event_name,
                context,
            )?;
            let (operations, item_conflicts) = plan_item(
                &request.library_root,
                &folder,
                &item,
                request.collision_policy,
                &mut planned_paths,
                &excluded_source_paths,
            );
            conflicts.extend(item_conflicts);
            planned_items
                .entry(folder)
                .or_default()
                .push(PlannedMediaItem {
                    item_key: item.key,
                    captured_at_unix_ms: item.captured_at_unix_ms,
                    total_size_bytes: operations.iter().map(|file| file.size_bytes).sum(),
                    files: operations,
                    has_raw_jpeg_pair: item.has_raw_jpeg_pair,
                    has_sidecar: item.has_sidecar,
                    camera_alias: context.camera_alias.clone(),
                });
        }
        for (folder, planned_items) in planned_items {
            planned_events.push(PlannedEvent {
                event_index: input.event.index,
                event_name: event_name.to_owned(),
                folder_relative_path: folder,
                starts_at_unix_ms: input.event.starts_at_unix_ms,
                total_size_bytes: planned_items.iter().map(|item| item.total_size_bytes).sum(),
                items: planned_items,
            });
        }
    }

    let item_count = planned_events.iter().map(|event| event.items.len()).sum();
    let file_count = planned_events
        .iter()
        .flat_map(|event| &event.items)
        .map(|item| item.files.len())
        .sum();
    let total_size_bytes = planned_events
        .iter()
        .map(|event| event.total_size_bytes)
        .sum();
    let status = if item_count == 0 {
        ImportPlanStatus::Empty
    } else if conflicts.is_empty() {
        ImportPlanStatus::Ready
    } else {
        ImportPlanStatus::RequiresDecision
    };

    Ok(ImportPlan {
        status,
        library_root: request.library_root,
        events: planned_events,
        conflicts,
        item_count,
        file_count,
        total_size_bytes,
        excluded_item_count,
        excluded_file_count,
    })
}

fn plan_item(
    library_root: &Path,
    folder: &Path,
    item: &MediaItem,
    collision_policy: CollisionPolicy,
    planned_paths: &mut HashSet<String>,
    excluded_source_paths: &HashSet<String>,
) -> (Vec<PlannedFileOperation>, Vec<PlanConflict>) {
    let mut sequence = 1_u32;
    loop {
        let candidates: Vec<_> = item
            .files
            .iter()
            .filter(|file| !excluded_source_paths.contains(&normalized_path_key(&file.path)))
            .map(|file| {
                let file_name = sequenced_file_name(&file.relative_path, sequence);
                let relative = folder.join(file_name);
                let destination = library_root.join(&relative);
                (file, relative, destination)
            })
            .collect();
        let found: Vec<_> = candidates
            .iter()
            .filter_map(|(_, _, destination)| {
                let key = normalized_path_key(destination);
                if destination.exists() {
                    Some((PlanConflictKind::DestinationExists, destination.clone()))
                } else if planned_paths.contains(&key) {
                    Some((PlanConflictKind::DuplicateDestination, destination.clone()))
                } else {
                    None
                }
            })
            .collect();

        if found.is_empty() || collision_policy == CollisionPolicy::Ask {
            for (_, _, destination) in &candidates {
                planned_paths.insert(normalized_path_key(destination));
            }
            let operations = candidates
                .into_iter()
                .map(|(file, relative, destination)| PlannedFileOperation {
                    source_path: file.path.clone(),
                    source_relative_path: file.relative_path.clone(),
                    destination_path: destination,
                    destination_relative_path: relative,
                    kind: file.kind,
                    size_bytes: file.size_bytes,
                })
                .collect();
            let conflicts = found
                .into_iter()
                .map(|(kind, destination_path)| PlanConflict {
                    kind,
                    item_key: item.key.clone(),
                    destination_path,
                })
                .collect();
            return (operations, conflicts);
        }
        sequence = sequence.saturating_add(1);
    }
}

fn sequenced_file_name(path: &Path, sequence: u32) -> String {
    let original = path.file_name().unwrap_or_default().to_string_lossy();
    if sequence == 1 {
        return original.into_owned();
    }
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    path.extension().map_or_else(
        || format!("{stem}-{sequence}"),
        |extension| format!("{stem}-{sequence}.{}", extension.to_string_lossy()),
    )
}

fn render_folder_template(
    template: &str,
    timestamp_ms: u64,
    event_name: &str,
    context: &TemplateContext,
) -> Result<PathBuf, PlanError> {
    let timestamp = i64::try_from(timestamp_ms).unwrap_or(i64::MAX);
    let date = Local
        .timestamp_millis_opt(timestamp)
        .single()
        .or_else(|| Local.timestamp_millis_opt(0).single())
        .expect("Unix epoch is representable in the local timezone");
    let mut rendered = String::new();
    let mut characters = template.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '{' {
            let mut variable = String::new();
            let mut closed = false;
            for inner in characters.by_ref() {
                if inner == '}' {
                    closed = true;
                    break;
                }
                if inner == '{' {
                    return Err(PlanError::UnbalancedTemplate);
                }
                variable.push(inner);
            }
            if !closed {
                return Err(PlanError::UnbalancedTemplate);
            }
            let value = match variable.as_str() {
                "year" => format!("{:04}", date.year()),
                "month" => format!("{:02}", date.month()),
                "day" => format!("{:02}", date.day()),
                "date" => format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day()),
                "event_name" => event_name.to_owned(),
                "camera_make" => context.camera_make.clone().unwrap_or_default(),
                "camera_model" => context.camera_model.clone().unwrap_or_default(),
                "camera_alias" => context.camera_alias.clone().unwrap_or_default(),
                "source_alias" => context.source_alias.clone().unwrap_or_default(),
                _ => return Err(PlanError::UnknownTemplateVariable(variable)),
            };
            rendered.push_str(&sanitize_component_fragment(&value));
        } else if character == '}' {
            return Err(PlanError::UnbalancedTemplate);
        } else {
            rendered.push(character);
        }
    }
    safe_relative_folder(&rendered)
}

fn safe_relative_folder(rendered: &str) -> Result<PathBuf, PlanError> {
    if rendered.starts_with(['/', '\\']) || rendered.as_bytes().get(1) == Some(&b':') {
        return Err(PlanError::UnsafeTemplatePath);
    }
    let normalized = rendered.replace('\\', "/");
    let mut result = PathBuf::new();
    for raw in normalized.split('/') {
        let component = sanitize_path_component(raw);
        if raw == "." || raw == ".." || component == "." || component == ".." {
            return Err(PlanError::UnsafeTemplatePath);
        }
        result.push(component);
    }
    if result.as_os_str().is_empty()
        || result
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PlanError::UnsafeTemplatePath);
    }
    Ok(result)
}

fn sanitize_component_fragment(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect()
}

fn sanitize_path_component(value: &str) -> String {
    let cleaned = sanitize_component_fragment(value)
        .trim()
        .trim_end_matches(['.', ' '])
        .to_owned();
    let mut cleaned = if cleaned.is_empty() {
        "_".to_owned()
    } else {
        cleaned
    };
    let base = cleaned
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && base.as_bytes()[3].is_ascii_digit()
            && base.as_bytes()[3] != b'0');
    if reserved {
        cleaned.insert(0, '_');
    }
    cleaned
}

fn normalized_path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use importer_media::{CaptureTimeSource, MediaFile};
    use tempfile::tempdir;

    fn item(key: &str, names: &[&str]) -> MediaItem {
        MediaItem {
            key: key.to_owned(),
            original_captured_at_unix_ms: 1_725_062_400_000,
            captured_at_unix_ms: 1_725_062_400_000,
            time_source: CaptureTimeSource::Exif,
            time_correction_seconds: 0,
            total_size_bytes: names.len() as u64 * 10,
            files: names
                .iter()
                .map(|name| MediaFile {
                    path: PathBuf::from("source").join(name),
                    relative_path: PathBuf::from(name),
                    kind: if name.ends_with(".xmp") {
                        MediaFileKind::Xmp
                    } else {
                        MediaFileKind::Raw
                    },
                    size_bytes: 10,
                    modified_at_unix_ms: 0,
                    embedded_captured_at_unix_ms: None,
                    embedded_time_source: None,
                    camera_identity: None,
                })
                .collect(),
            has_raw_jpeg_pair: names.len() > 1,
            has_sidecar: names.iter().any(|name| name.ends_with(".xmp")),
            camera_identity: None,
            camera_metadata_conflict: false,
        }
    }

    fn request(
        root: &Path,
        items: Vec<MediaItem>,
        policy: CollisionPolicy,
    ) -> BuildImportPlanRequest {
        BuildImportPlanRequest {
            library_root: root.to_path_buf(),
            folder_template: "{year}/{date}-{event_name}".to_owned(),
            collision_policy: policy,
            events: vec![EventPlanInput {
                event: EventGroup {
                    index: 1,
                    starts_at_unix_ms: 1_725_062_400_000,
                    ends_at_unix_ms: 1_725_062_400_000,
                    total_size_bytes: 10,
                    items,
                },
                name: "Urodziny: Ania".to_owned(),
            }],
            excluded_item_keys: BTreeSet::new(),
            excluded_source_paths: BTreeSet::new(),
            context: TemplateContext::default(),
            item_contexts: BTreeMap::new(),
        }
    }

    #[test]
    fn creates_deterministic_safe_plan_without_writing() {
        let root = tempdir().unwrap();
        let plan = build_import_plan(request(
            root.path(),
            vec![item("a", &["IMG_1.CR3", "IMG_1.xmp"])],
            CollisionPolicy::Ask,
        ))
        .unwrap();

        assert_eq!(plan.status, ImportPlanStatus::Ready);
        assert_eq!(plan.file_count, 2);
        assert!(
            plan.events[0]
                .folder_relative_path
                .to_string_lossy()
                .contains("Urodziny_ Ania")
        );
        assert!(!plan.events[0].items[0].files[0].destination_path.exists());
    }

    #[test]
    fn reports_existing_destination_for_ask_policy() {
        let root = tempdir().unwrap();
        let first = request(
            root.path(),
            vec![item("a", &["IMG.CR3"])],
            CollisionPolicy::Ask,
        );
        let folder = render_folder_template(
            &first.folder_template,
            first.events[0].event.starts_at_unix_ms,
            "Urodziny: Ania",
            &first.context,
        )
        .unwrap();
        std::fs::create_dir_all(root.path().join(&folder)).unwrap();
        std::fs::write(root.path().join(folder).join("IMG.CR3"), b"old").unwrap();

        let plan = build_import_plan(first).unwrap();
        assert_eq!(plan.status, ImportPlanStatus::RequiresDecision);
        assert_eq!(plan.conflicts[0].kind, PlanConflictKind::DestinationExists);
    }

    #[test]
    fn appends_one_sequence_to_all_files_in_a_pair() {
        let root = tempdir().unwrap();
        let initial = build_import_plan(request(
            root.path(),
            vec![item("a", &["IMG.CR3"])],
            CollisionPolicy::Ask,
        ))
        .unwrap();
        let destination = &initial.events[0].items[0].files[0].destination_path;
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::fs::write(destination, b"old").unwrap();

        let plan = build_import_plan(request(
            root.path(),
            vec![item("a", &["IMG.CR3", "IMG.xmp"])],
            CollisionPolicy::AppendSequence,
        ))
        .unwrap();
        let names: Vec<_> = plan.events[0].items[0]
            .files
            .iter()
            .map(|file| {
                file.destination_path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, ["IMG-2.CR3", "IMG-2.xmp"]);
        assert_eq!(plan.status, ImportPlanStatus::Ready);
    }

    #[test]
    fn rejects_parent_and_absolute_paths() {
        assert_eq!(
            safe_relative_folder("../escape"),
            Err(PlanError::UnsafeTemplatePath)
        );
        assert_eq!(
            safe_relative_folder("C:/escape"),
            Err(PlanError::UnsafeTemplatePath)
        );
    }

    #[test]
    fn makes_windows_reserved_names_portable() {
        assert_eq!(
            safe_relative_folder("CON/album").unwrap(),
            PathBuf::from("_CON").join("album")
        );
    }

    #[test]
    fn omits_only_recognized_files_from_a_partial_item() {
        let root = tempdir().unwrap();
        let mut request = request(
            root.path(),
            vec![item("a", &["IMG.CR3", "IMG.jpg", "IMG.xmp"])],
            CollisionPolicy::Ask,
        );
        request
            .excluded_source_paths
            .insert(PathBuf::from("source").join("IMG.jpg"));

        let plan = build_import_plan(request).unwrap();

        let names: Vec<_> = plan.events[0].items[0]
            .files
            .iter()
            .map(|file| file.source_path.file_name().unwrap().to_string_lossy())
            .collect();
        assert_eq!(names, ["IMG.CR3", "IMG.xmp"]);
        assert_eq!(plan.excluded_file_count, 1);
        assert_eq!(plan.total_size_bytes, 20);
    }

    #[test]
    fn rejects_a_missing_library_and_an_empty_event_name() {
        let root = tempdir().unwrap();
        let mut missing = request(
            root.path(),
            vec![item("a", &["IMG.CR3"])],
            CollisionPolicy::Ask,
        );
        missing.library_root = PathBuf::new();
        assert_eq!(
            build_import_plan(missing),
            Err(PlanError::MissingLibraryPath)
        );

        let mut unnamed = request(
            root.path(),
            vec![item("a", &["IMG.CR3"])],
            CollisionPolicy::Ask,
        );
        unnamed.events[0].name = "  ".to_owned();
        assert_eq!(
            build_import_plan(unnamed),
            Err(PlanError::EmptyEventName { event_index: 1 })
        );
    }

    #[test]
    fn excluding_every_item_produces_an_empty_plan() {
        let root = tempdir().unwrap();
        let mut request = request(
            root.path(),
            vec![item("a", &["IMG.CR3"])],
            CollisionPolicy::Ask,
        );
        request.excluded_item_keys.insert("a".to_owned());

        let plan = build_import_plan(request).unwrap();

        assert_eq!(plan.status, ImportPlanStatus::Empty);
        assert_eq!(plan.excluded_item_count, 1);
        assert!(plan.events.is_empty());
    }

    #[test]
    fn append_sequence_skips_all_existing_sequences() {
        let root = tempdir().unwrap();
        let initial = build_import_plan(request(
            root.path(),
            vec![item("a", &["IMG.CR3"])],
            CollisionPolicy::Ask,
        ))
        .unwrap();
        let destination = &initial.events[0].items[0].files[0].destination_path;
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::fs::write(destination, b"1").unwrap();
        std::fs::write(destination.with_file_name("IMG-2.CR3"), b"2").unwrap();
        std::fs::write(destination.with_file_name("IMG-3.CR3"), b"3").unwrap();

        let plan = build_import_plan(request(
            root.path(),
            vec![item("a", &["IMG.CR3", "IMG.xmp"])],
            CollisionPolicy::AppendSequence,
        ))
        .unwrap();

        assert!(plan.events[0].items[0].files.iter().all(|file| {
            file.destination_path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains("-4")
        }));
    }

    #[test]
    fn duplicate_destinations_inside_one_plan_are_reported() {
        let root = tempdir().unwrap();
        let plan = build_import_plan(request(
            root.path(),
            vec![item("a", &["IMG.CR3"]), item("b", &["IMG.CR3"])],
            CollisionPolicy::Ask,
        ))
        .unwrap();

        assert_eq!(plan.status, ImportPlanStatus::RequiresDecision);
        assert!(
            plan.conflicts
                .iter()
                .any(|conflict| conflict.kind == PlanConflictKind::DuplicateDestination)
        );
    }

    #[test]
    fn sanitizes_empty_trailing_and_unicode_components() {
        assert_eq!(
            safe_relative_folder("folder.../ ").unwrap(),
            PathBuf::from("folder").join("_")
        );
        assert_eq!(
            safe_relative_folder("zdjęcia/Łódź").unwrap(),
            PathBuf::from("zdjęcia").join("Łódź")
        );
    }

    #[test]
    fn reports_unknown_and_unbalanced_template_variables() {
        let context = TemplateContext::default();
        assert_eq!(
            render_folder_template("{missing}", 0, "event", &context),
            Err(PlanError::UnknownTemplateVariable("missing".to_owned()))
        );
        assert_eq!(
            render_folder_template("{year", 0, "event", &context),
            Err(PlanError::UnbalancedTemplate)
        );
    }
}
