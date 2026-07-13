use serde_json::{json, Value};

use super::support::*;

fn event(id: &str, change_id: &str) -> Value {
    json!({
        "id": id,
        "type": "updated",
        "timestamp": "2026-07-12T00:00:00.000Z",
        "files": [],
        "changeIds": [change_id],
        "taskIds": [],
        "checkIds": [],
        "conventionIds": [],
        "validatorIds": [],
        "findingIds": [],
        "summary": format!("Updated {change_id}.")
    })
}

#[test]
fn filters_before_bounding_recent_canon_events() {
    let root = test_root("activity-filter-before-limit");
    let project = open_test_project(&root);
    project
        .write_event_json(json!({ "event": event("target", "target-change") }).to_string())
        .unwrap();
    for index in 0..600 {
        project
            .write_event_json(
                json!({ "event": event(&format!("unrelated-{index:04}"), "unrelated-change") })
                    .to_string(),
            )
            .unwrap();
    }

    let output = project
        .list_events_json(
            json!({ "mode": "recent", "limit": 1, "changeId": "target-change" }).to_string(),
        )
        .unwrap();
    let events: Vec<Value> = serde_json::from_str(&output).unwrap();

    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["id"], "target");
}

#[test]
fn complete_change_history_is_not_truncated() {
    let root = test_root("activity-complete-history");
    let project = open_test_project(&root);
    for index in 0..550 {
        project
            .write_event_json(
                json!({ "event": event(&format!("target-{index:04}"), "target-change") })
                    .to_string(),
            )
            .unwrap();
    }
    project
        .write_event_json(json!({ "event": event("secondary", "secondary-change") }).to_string())
        .unwrap();

    let output = project
        .list_events_json(
            json!({ "mode": "change-history", "changeIds": ["target-change", "secondary-change"] })
                .to_string(),
        )
        .unwrap();
    let events: Vec<Value> = serde_json::from_str(&output).unwrap();

    assert_eq!(events.len(), 551);
    assert!(events.iter().any(|event| event["id"] == "secondary"));
}

#[test]
fn complete_change_history_requires_change_ids() {
    let root = test_root("activity-complete-history-empty");
    let project = open_test_project(&root);

    let error = project
        .list_events_json(json!({ "mode": "change-history", "changeIds": [] }).to_string())
        .unwrap_err();

    assert!(error.to_string().contains("require changeIds"));
}
