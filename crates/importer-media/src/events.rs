use serde::{Deserialize, Serialize};

use crate::MediaItem;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventGroup {
    pub index: usize,
    pub starts_at_unix_ms: u64,
    pub ends_at_unix_ms: u64,
    pub total_size_bytes: u64,
    pub items: Vec<MediaItem>,
}

#[must_use]
pub fn group_into_events(mut items: Vec<MediaItem>, event_gap_minutes: u32) -> Vec<EventGroup> {
    items.sort_by_key(|item| (item.captured_at_unix_ms, item.key.clone()));
    let maximum_gap_ms = u64::from(event_gap_minutes) * 60 * 1_000;
    let mut events: Vec<EventGroup> = Vec::new();

    for item in items {
        let belongs_to_current = events.last().is_some_and(|event| {
            item.captured_at_unix_ms
                .saturating_sub(event.ends_at_unix_ms)
                <= maximum_gap_ms
        });
        if belongs_to_current {
            let event = events.last_mut().expect("event exists after check");
            event.ends_at_unix_ms = item.captured_at_unix_ms;
            event.total_size_bytes += item.total_size_bytes;
            event.items.push(item);
        } else {
            events.push(EventGroup {
                index: events.len() + 1,
                starts_at_unix_ms: item.captured_at_unix_ms,
                ends_at_unix_ms: item.captured_at_unix_ms,
                total_size_bytes: item.total_size_bytes,
                items: vec![item],
            });
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(key: &str, minute: u64) -> MediaItem {
        MediaItem {
            key: key.to_owned(),
            original_captured_at_unix_ms: minute * 60 * 1_000,
            captured_at_unix_ms: minute * 60 * 1_000,
            time_source: crate::CaptureTimeSource::Exif,
            time_correction_seconds: 0,
            total_size_bytes: 10,
            files: Vec::new(),
            has_raw_jpeg_pair: false,
            has_sidecar: false,
            camera_identity: None,
            camera_metadata_conflict: false,
        }
    }

    #[test]
    fn splits_only_when_gap_is_greater_than_threshold() {
        let events = group_into_events(vec![item("a", 0), item("b", 120), item("c", 241)], 120);

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].items.len(), 2);
        assert_eq!(events[1].items.len(), 1);
    }

    #[test]
    fn midnight_has_no_special_meaning() {
        let before_midnight = 23 * 60 + 55;
        let after_midnight = 24 * 60 + 10;

        let events = group_into_events(
            vec![
                item("before", before_midnight),
                item("after", after_midnight),
            ],
            30,
        );

        assert_eq!(events.len(), 1);
    }

    #[test]
    fn sorts_input_before_grouping() {
        let events = group_into_events(vec![item("later", 40), item("first", 10)], 15);

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].items[0].key, "first");
    }
}
