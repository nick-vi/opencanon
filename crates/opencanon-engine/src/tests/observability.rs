use rusqlite::Connection;
use serde_json::{json, Value};

use crate::state::schema_version;

use super::support::*;

#[test]
fn migration_004_applies_and_creates_observability_tables() {
    let root = test_root("graph-migration");
    let project = open_test_project(&root);
    let status = project.status_json().unwrap();
    let parsed: Value = serde_json::from_str(&status).unwrap();
    let migrations = parsed["migrationsApplied"].as_array().unwrap();
    assert!(migrations.iter().any(|version| version.as_u64() == Some(3)));
    assert!(migrations.iter().any(|version| version.as_u64() == Some(4)));
    assert!(migrations.iter().any(|version| version.as_u64() == Some(5)));
    assert!(migrations.iter().any(|version| version.as_u64() == Some(6)));
    assert!(migrations.iter().any(|version| version.as_u64() == Some(7)));
    assert_eq!(
        parsed["schemaVersion"].as_u64(),
        Some(u64::from(schema_version()))
    );
}

#[test]
fn observability_records_round_trip_and_filter_by_trace() {
    let root = test_root("observability-records");
    let project = open_test_project(&root);

    project
        .write_observability_records_json(
            json!({
                "traces": [{
                    "id": "1234567890abcdef1234567890abcdef",
                    "name": "doctor.run",
                    "status": "ok",
                    "recording": true,
                    "sampled": true,
                    "startedAt": "2026-06-06T00:00:00.000Z",
                    "endedAt": "2026-06-06T00:00:00.010Z",
                    "durationMs": 10,
                    "attributes": { "command": "doctor" },
                    "traceFlags": "01"
                }],
                "spans": [{
                    "id": "1234567890abcdef",
                    "traceId": "1234567890abcdef1234567890abcdef",
                    "name": "doctor.check",
                    "kind": "task",
                    "otelKind": "INTERNAL",
                    "status": "ok",
                    "recording": true,
                    "sampled": true,
                    "startedAt": "2026-06-06T00:00:00.001Z",
                    "endedAt": "2026-06-06T00:00:00.009Z",
                    "durationMs": 8,
                    "traceParent": "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
                    "traceFlags": "01",
                    "attributes": { "check": "state" },
                    "output": { "findings": 0 }
                }],
                "events": [{
                    "id": "event_1",
                    "traceId": "1234567890abcdef1234567890abcdef",
                    "spanId": "1234567890abcdef",
                    "name": "doctor.check.completed",
                    "occurredAt": "2026-06-06T00:00:00.008Z",
                    "traceFlags": "01",
                    "sampled": true,
                    "attributes": { "status": "pass" }
                }]
            })
            .to_string(),
        )
        .unwrap();

    let output = project
        .list_observability_records_json(
            json!({
                "traceId": "1234567890abcdef1234567890abcdef",
                "limit": 10
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(parsed["traces"][0]["name"], "doctor.run");
    assert_eq!(parsed["spans"][0]["output"]["findings"], 0);
    assert_eq!(parsed["events"][0]["name"], "doctor.check.completed");

    let conn = Connection::open(root.join(".opencanon/state.sqlite")).unwrap();
    let span_count: i64 = conn
        .query_row(
            "select count(*) from observability_spans where root_dir = ?1",
            [root.to_string_lossy().to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(span_count, 1);

    let invalid = project.write_observability_records_json(
        json!({
            "spans": [{
                "id": "1234567890abcdef",
                "traceId": "1234567890abcdef1234567890abcdef",
                "name": "invalid",
                "kind": "task",
                "otelKind": "INTERNAL",
                "status": "ok",
                "recording": true,
                "sampled": true,
                "startedAt": "2026-06-06T00:00:00.001Z",
                "traceParent": "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1234567890abcdef-01",
                "traceFlags": "01",
                "attributes": {}
            }]
        })
        .to_string(),
    );
    assert!(invalid
        .unwrap_err()
        .to_string()
        .contains("invalid-observability-record"));
}
