use serde_json::{json, Value};

use super::support::*;

#[test]
fn persists_jobs_and_ordered_replay_events() {
    let root = test_root("jobs");
    let project = open_test_project(&root);
    let queued = json!({
        "id": "run-1",
        "batchId": "batch-1",
        "kind": "change-check",
        "status": "queued",
        "changeId": "runtime-operations",
        "checkId": "engine-tests",
        "checkKind": "command",
        "createdAt": "2026-07-12T00:00:00.000Z",
        "updatedAt": "2026-07-12T00:00:00.000Z",
        "outputTail": "",
        "outputBytes": 0,
        "outputTruncated": false
    });
    project
        .write_job_json(json!({ "job": queued }).to_string())
        .unwrap();

    let events = [
        json!({ "runId": "run-1", "batchId": "batch-1", "sequence": 1, "timestamp": "2026-07-12T00:00:01.000Z", "type": "started" }),
        json!({ "runId": "run-1", "batchId": "batch-1", "sequence": 2, "timestamp": "2026-07-12T00:00:02.000Z", "type": "stdout", "text": "live output\n" }),
        json!({ "runId": "run-1", "batchId": "batch-1", "sequence": 3, "timestamp": "2026-07-12T00:00:03.000Z", "type": "started" }),
    ];
    for event in events {
        project
            .append_job_event_json(json!({ "event": event }).to_string())
            .unwrap();
    }

    let replay: Value = serde_json::from_str(
        &project
            .list_job_events_json(
                json!({ "jobId": "run-1", "afterSequence": 1, "limit": 10 }).to_string(),
            )
            .unwrap(),
    )
    .unwrap();
    let replay = replay.as_array().unwrap();
    assert_eq!(replay.len(), 2);
    assert_eq!(replay[0]["sequence"], 2);
    assert_eq!(replay[1]["sequence"], 3);

    let stored: Value = serde_json::from_str(
        &project
            .read_job_json(json!({ "jobId": "run-1" }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(stored["job"]["status"], "queued");

    let listed: Value = serde_json::from_str(
        &project
            .list_jobs_json(json!({ "type": "change-check", "limit": 10 }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
}
