use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::{Arc, Barrier};

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
        "executor": { "runtimeNamespace": "test", "leaseId": "jobs-test" },
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
        json!({ "runId": "run-1", "batchId": "batch-1", "timestamp": "2026-07-12T00:00:01.000Z", "type": "started" }),
        json!({ "runId": "run-1", "batchId": "batch-1", "timestamp": "2026-07-12T00:00:02.000Z", "type": "stdout", "text": "live output\n" }),
        json!({ "runId": "run-1", "batchId": "batch-1", "timestamp": "2026-07-12T00:00:03.000Z", "type": "started" }),
    ];
    for event in events {
        project
            .append_job_event_json(json!({ "event": event }).to_string())
            .unwrap();
    }

    let replay: Value = serde_json::from_str(
        &project
            .list_job_events_json(
                json!({ "jobId": "run-1", "afterSequence": 1, "limit": 10, "order": "asc" })
                    .to_string(),
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
            .list_jobs_json(json!({ "mode": "recent", "limit": 10 }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
}

#[test]
fn migration_011_discards_pre_executor_jobs_without_touching_canon_events() {
    let root = test_root("job-executor-migration");
    let state_path = root.join(".opencanon/state/test/state.sqlite");
    {
        let project = open_test_project(&root);
        project
            .write_job_json(
                json!({ "job": queued_job("pre-contract", "2026-07-12T00:00:00.000Z") })
                    .to_string(),
            )
            .unwrap();
        project
            .append_job_event_json(
                json!({ "event": event_draft("pre-contract", "queued") }).to_string(),
            )
            .unwrap();
    }
    let conn = Connection::open(&state_path).unwrap();
    conn.execute(
        "insert into canon_events(id, type, timestamp, payload) values (?1, ?2, ?3, ?4)",
        (
            "canon-event",
            "indexed",
            "2026-07-12T00:00:00.000Z",
            "{\"id\":\"canon-event\"}",
        ),
    )
    .unwrap();
    conn.execute("delete from migrations where version >= 11", [])
        .unwrap();
    conn.execute("drop table protocol_events", []).unwrap();
    conn.execute("drop table project_publication", []).unwrap();
    drop(conn);

    drop(open_test_project(&root));
    let conn = Connection::open(&state_path).unwrap();
    assert_eq!(
        conn.query_row("select count(*) from jobs", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("select count(*) from job_events", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("select count(*) from canon_events", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row(
            "select count(*) from migrations where version = 11",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn allocates_job_event_sequences_across_project_connections() {
    let root = test_root("job-event-sequences");
    let project = open_test_project(&root);
    project
        .write_job_json(
            json!({ "job": queued_job("shared-run", "2026-07-12T00:00:00.000Z") }).to_string(),
        )
        .unwrap();

    let barrier = Arc::new(Barrier::new(3));
    let writers = (0..2)
        .map(|_| {
            let root = root.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let writer = open_test_project(&root);
                barrier.wait();
                for _ in 0..50 {
                    writer
                        .append_job_event_json(
                            json!({ "event": event_draft("shared-run", "started") }).to_string(),
                        )
                        .unwrap();
                }
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    for writer in writers {
        writer.join().unwrap();
    }

    let events: Value = serde_json::from_str(
        &project
            .list_job_events_json(
                json!({ "jobId": "shared-run", "afterSequence": 0, "limit": 200, "order": "asc" })
                    .to_string(),
            )
            .unwrap(),
    )
    .unwrap();
    let sequences = events
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["sequence"].as_u64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(sequences, (1..=100).collect::<Vec<_>>());
}

#[test]
fn admits_change_check_batches_atomically_at_capacity() {
    let root = test_root("job-admission");
    let project = open_test_project(&root);
    let jobs = [
        queued_job("run-1", "2026-07-12T00:00:00.000Z"),
        queued_job("run-2", "2026-07-12T00:00:01.000Z"),
    ];
    let events = [queued_event("run-1", 1), queued_event("run-2", 1)];
    let accepted: Value = serde_json::from_str(
        &project
            .admit_jobs_json(json!({ "jobs": jobs, "events": events, "capacity": 2 }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(accepted["accepted"], true);
    assert_eq!(accepted["activeCount"], 2);

    let rejected: Value = serde_json::from_str(
        &project
            .admit_jobs_json(
                json!({
                    "jobs": [queued_job("run-3", "2026-07-12T00:00:02.000Z")],
                    "events": [queued_event("run-3", 1)],
                    "capacity": 2
                })
                .to_string(),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(rejected["accepted"], false);
    assert_eq!(rejected["requestedCount"], 1);

    let listed: Value = serde_json::from_str(
        &project
            .list_jobs_json(json!({ "mode": "active" }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 2);
    let absent: Value = serde_json::from_str(
        &project
            .read_job_json(json!({ "jobId": "run-3" }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert!(absent["job"].is_null());
}

#[test]
fn prunes_terminal_jobs_by_age_and_count_without_removing_active_jobs() {
    let root = test_root("job-retention");
    let project = open_test_project(&root);
    let jobs = [
        queued_job("active", "2026-07-12T00:00:00.000Z"),
        terminal_job("old", "2026-01-01T00:00:00.000Z"),
        terminal_job("recent-1", "2026-07-09T00:00:00.000Z"),
        terminal_job("recent-2", "2026-07-10T00:00:00.000Z"),
        terminal_job("recent-3", "2026-07-11T00:00:00.000Z"),
    ];
    for job in jobs {
        let id = job["id"].as_str().unwrap();
        project
            .write_job_json(json!({ "job": job }).to_string())
            .unwrap();
        project
            .append_job_event_json(json!({ "event": event_draft(id, "queued") }).to_string())
            .unwrap();
    }

    let pruned: Value = serde_json::from_str(
        &project
            .prune_jobs_json(
                json!({ "terminalBefore": "2026-06-01T00:00:00.000Z", "maxTerminalCount": 2 })
                    .to_string(),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(pruned["deletedRuns"], 2);
    assert_eq!(pruned["deletedEvents"], 2);
    assert_eq!(pruned["retainedTerminalRuns"], 2);

    let active: Value = serde_json::from_str(
        &project
            .list_jobs_json(json!({ "mode": "active" }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(active.as_array().unwrap().len(), 1);
    assert_eq!(active[0]["id"], "active");
    for deleted_id in ["old", "recent-1"] {
        let stored: Value = serde_json::from_str(
            &project
                .read_job_json(json!({ "jobId": deleted_id }).to_string())
                .unwrap(),
        )
        .unwrap();
        assert!(stored["job"].is_null());
    }
}

#[test]
fn reads_latest_job_event_sequence_beyond_replay_page_size() {
    let root = test_root("job-latest-sequence");
    let project = open_test_project(&root);
    project
        .write_job_json(
            json!({ "job": queued_job("long-run", "2026-07-12T00:00:00.000Z") }).to_string(),
        )
        .unwrap();
    for _ in 1..=2_100 {
        project
            .append_job_event_json(
                json!({
                    "event": {
                        "runId": "long-run",
                        "batchId": "batch",
                        "timestamp": "2026-07-12T00:00:00.000Z",
                        "type": "started"
                    }
                })
                .to_string(),
            )
            .unwrap();
    }

    let latest: Value = serde_json::from_str(
        &project
            .list_job_events_json(
                json!({ "jobId": "long-run", "afterSequence": 0, "limit": 1, "order": "desc" })
                    .to_string(),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(latest[0]["sequence"], 2_100);
}

fn queued_job(id: &str, timestamp: &str) -> Value {
    json!({
        "id": id,
        "batchId": "batch",
        "kind": "change-check",
        "status": "queued",
        "changeId": "runtime-operations",
        "checkId": "engine-tests",
        "checkKind": "command",
        "executor": { "runtimeNamespace": "test", "leaseId": "jobs-test" },
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "outputTail": "",
        "outputBytes": 0,
        "outputTruncated": false
    })
}

fn terminal_job(id: &str, timestamp: &str) -> Value {
    json!({
        "id": id,
        "batchId": "batch",
        "kind": "change-check",
        "status": "passed",
        "changeId": "runtime-operations",
        "checkId": "engine-tests",
        "checkKind": "command",
        "executor": { "runtimeNamespace": "test", "leaseId": "jobs-test" },
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "startedAt": timestamp,
        "finishedAt": timestamp,
        "summary": "Passed.",
        "outputTail": "",
        "outputBytes": 0,
        "outputTruncated": false
    })
}

fn queued_event(run_id: &str, sequence: u64) -> Value {
    json!({
        "runId": run_id,
        "batchId": "batch",
        "sequence": sequence,
        "timestamp": "2026-07-12T00:00:00.000Z",
        "type": "queued"
    })
}

fn event_draft(run_id: &str, event_type: &str) -> Value {
    json!({
        "runId": run_id,
        "batchId": "batch",
        "timestamp": "2026-07-12T00:00:00.000Z",
        "type": event_type
    })
}
