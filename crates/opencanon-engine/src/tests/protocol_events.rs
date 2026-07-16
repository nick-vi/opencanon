use serde_json::{json, Value};

use super::support::*;

fn event(
    timestamp: &str,
    revision: u64,
    domain: &str,
    event_type: &str,
    operation_id: Option<&str>,
) -> Value {
    let mut event = json!({
        "protocolVersion": 1,
        "timestamp": timestamp,
        "revision": revision,
        "domain": domain,
        "type": event_type,
        "summary": format!("Recorded {event_type}."),
        "ids": [event_type]
    });
    if let Some(operation_id) = operation_id {
        event["operationId"] = json!(operation_id);
    }
    event
}

fn append(
    project: &crate::EngineProjectHandle,
    value: Value,
    max_count: u64,
    retain_after: &str,
) -> Value {
    let output = project
        .append_protocol_event_json(
            json!({
                "event": value,
                "maxCount": max_count,
                "retainAfter": retain_after
            })
            .to_string(),
        )
        .unwrap();
    serde_json::from_str(&output).unwrap()
}

fn list(
    project: &crate::EngineProjectHandle,
    after_sequence: u64,
    limit: u64,
    operation_id: Option<&str>,
) -> Value {
    let output = project
        .list_protocol_events_json(
            json!({
                "afterSequence": after_sequence,
                "limit": limit,
                "operationId": operation_id
            })
            .to_string(),
        )
        .unwrap();
    serde_json::from_str(&output).unwrap()
}

#[test]
fn allocates_global_sequences_and_replays_operation_events() {
    let root = test_root("protocol-event-replay");
    let first_writer = open_test_project(&root);
    let second_writer = open_test_project(&root);

    let first = append(
        &first_writer,
        event("2026-07-16T10:00:00.000Z", 7, "project", "published", None),
        100,
        "2026-07-01T00:00:00.000Z",
    );
    let second = append(
        &second_writer,
        event(
            "2026-07-16T10:00:01.000Z",
            7,
            "proof",
            "check-running",
            Some("run-1"),
        ),
        100,
        "2026-07-01T00:00:00.000Z",
    );
    let third = append(
        &first_writer,
        event(
            "2026-07-16T10:00:02.000Z",
            8,
            "proof",
            "check-passed",
            Some("run-1"),
        ),
        100,
        "2026-07-01T00:00:00.000Z",
    );

    assert_eq!(first["sequence"], 1);
    assert_eq!(second["sequence"], 2);
    assert_eq!(third["sequence"], 3);

    let replay = list(&second_writer, 1, 10, Some("run-1"));
    assert_eq!(replay["latestSequence"], 3);
    assert_eq!(replay["oldestAvailableSequence"], 1);
    assert_eq!(replay["events"].as_array().unwrap().len(), 2);
    assert_eq!(replay["events"][0]["sequence"], 2);
    assert_eq!(replay["events"][1]["sequence"], 3);
}

#[test]
fn bounds_protocol_event_history_by_age_and_count() {
    let root = test_root("protocol-event-retention");
    let project = open_test_project(&root);

    append(
        &project,
        event("2026-06-01T00:00:00.000Z", 1, "activity", "expired", None),
        3,
        "2026-07-01T00:00:00.000Z",
    );
    for index in 0..4 {
        append(
            &project,
            event(
                &format!("2026-07-16T10:00:0{index}.000Z"),
                2,
                "knowledge",
                &format!("indexed-{index}"),
                None,
            ),
            3,
            "2026-07-01T00:00:00.000Z",
        );
    }

    let replay = list(&project, 0, 10, None);
    let events = replay["events"].as_array().unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(replay["oldestAvailableSequence"], 3);
    assert_eq!(replay["latestSequence"], 5);
    assert_eq!(events[0]["type"], "indexed-1");
    assert_eq!(events[2]["type"], "indexed-3");
}

#[test]
fn rejects_invalid_protocol_event_bounds() {
    let root = test_root("protocol-event-invalid-bounds");
    let project = open_test_project(&root);

    let append_error = project
        .append_protocol_event_json(
            json!({
                "event": event("2026-07-16T10:00:00.000Z", 1, "project", "published", None),
                "maxCount": 0,
                "retainAfter": "2026-07-01T00:00:00.000Z"
            })
            .to_string(),
        )
        .unwrap_err();
    assert!(append_error.to_string().contains("retention count"));

    let list_error = project
        .list_protocol_events_json(json!({ "afterSequence": 0, "limit": 1001 }).to_string())
        .unwrap_err();
    assert!(list_error.to_string().contains("limit"));
}
