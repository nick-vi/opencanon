use rusqlite::{params, OptionalExtension};
use serde_json::json;

use super::EngineProjectHandle;
use crate::contracts::{
    AppendJobEventRequest, ListJobEventsRequest, ListJobsRequest, ReadJobRequest, WriteJobRequest,
};
use crate::json::{decode, encode, napi_error, sqlite_error};

pub(super) fn write_job_json(project: &EngineProjectHandle, request: String) -> napi::Result<()> {
    let request: WriteJobRequest = decode(&request)?;
    let id = required_json_string(&request.job, "id", "Job")?;
    let job_type = required_json_string(&request.job, "kind", "Job")?;
    let status = required_json_string(&request.job, "status", "Job")?;
    let created_at = required_json_string(&request.job, "createdAt", "Job")?;
    let updated_at = required_json_string(&request.job, "updatedAt", "Job")?;
    let payload = serde_json::to_string(&request.job)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
    let conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    conn.execute(
        "insert into jobs(id, type, status, payload, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5, ?6)
         on conflict(id) do update set type = excluded.type, status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at",
        params![id, job_type, status, payload, created_at, updated_at],
    )
    .map_err(|error| sqlite_error("Could not write project job", error))?;
    Ok(())
}

pub(super) fn read_job_json(
    project: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: ReadJobRequest = decode(&request)?;
    let conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let payload = conn
        .query_row(
            "select payload from jobs where id = ?1",
            params![request.job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| sqlite_error("Could not read project job", error))?;
    let job = payload
        .map(|value| serde_json::from_str::<serde_json::Value>(&value))
        .transpose()
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
    encode(&json!({ "job": job }))
}

pub(super) fn list_jobs_json(
    project: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: ListJobsRequest = decode(&request)?;
    let limit = request.limit.unwrap_or(50).clamp(1, 500);
    let conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let mut jobs = Vec::new();
    if let Some(job_type) = request.r#type {
        let mut statement = conn
            .prepare("select payload from jobs where type = ?1 order by updated_at desc limit ?2")
            .map_err(|error| sqlite_error("Could not prepare project job list", error))?;
        let rows = statement
            .query_map(params![job_type, limit], |row| row.get::<_, String>(0))
            .map_err(|error| sqlite_error("Could not list project jobs", error))?;
        for row in rows {
            jobs.push(decode_stored_json(row, "Could not decode project job")?);
        }
    } else {
        let mut statement = conn
            .prepare("select payload from jobs order by updated_at desc limit ?1")
            .map_err(|error| sqlite_error("Could not prepare project job list", error))?;
        let rows = statement
            .query_map(params![limit], |row| row.get::<_, String>(0))
            .map_err(|error| sqlite_error("Could not list project jobs", error))?;
        for row in rows {
            jobs.push(decode_stored_json(row, "Could not decode project job")?);
        }
    }
    encode(&jobs)
}

pub(super) fn append_job_event_json(
    project: &EngineProjectHandle,
    request: String,
) -> napi::Result<()> {
    let request: AppendJobEventRequest = decode(&request)?;
    let job_id = required_json_string(&request.event, "runId", "Job event")?;
    let event_type = required_json_string(&request.event, "type", "Job event")?;
    let timestamp = required_json_string(&request.event, "timestamp", "Job event")?;
    let sequence = request
        .event
        .get("sequence")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            napi_error(
                "invalid-engine-payload",
                "Job event is missing a positive sequence.",
            )
        })? as i64;
    let payload = serde_json::to_string(&request.event)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
    let conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    conn.execute(
        "insert into job_events(job_id, sequence, type, timestamp, payload) values (?1, ?2, ?3, ?4, ?5)",
        params![job_id, sequence, event_type, timestamp, payload],
    )
    .map_err(|error| sqlite_error("Could not append project job event", error))?;
    Ok(())
}

pub(super) fn list_job_events_json(
    project: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: ListJobEventsRequest = decode(&request)?;
    let after_sequence = request.after_sequence.unwrap_or(0) as i64;
    let limit = request.limit.unwrap_or(500).clamp(1, 2_000);
    let conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let mut statement = conn
        .prepare("select payload from job_events where job_id = ?1 and sequence > ?2 order by sequence asc limit ?3")
        .map_err(|error| sqlite_error("Could not prepare project job event list", error))?;
    let rows = statement
        .query_map(params![request.job_id, after_sequence, limit], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| sqlite_error("Could not list project job events", error))?;
    let mut events = Vec::new();
    for row in rows {
        events.push(decode_stored_json(
            row,
            "Could not decode project job event",
        )?);
    }
    encode(&events)
}

fn required_json_string<'a>(
    value: &'a serde_json::Value,
    field: &str,
    subject: &str,
) -> napi::Result<&'a str> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|item| !item.trim().is_empty())
        .ok_or_else(|| {
            napi_error(
                "invalid-engine-payload",
                &format!("{subject} is missing {field}."),
            )
        })
}

fn decode_stored_json(
    row: rusqlite::Result<String>,
    context: &str,
) -> napi::Result<serde_json::Value> {
    let payload = row.map_err(|error| sqlite_error(context, error))?;
    serde_json::from_str::<serde_json::Value>(&payload)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))
}
