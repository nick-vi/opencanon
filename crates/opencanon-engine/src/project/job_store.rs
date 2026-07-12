use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::json;

use super::EngineProjectHandle;
use crate::contracts::{
    AdmitJobsRequest, AppendJobEventRequest, ListJobEventsRequest, ListJobsRequest,
    PruneJobsRequest, ReadJobRequest, WriteJobRequest,
};
use crate::json::{decode, encode, napi_error, sqlite_error};

pub(super) fn write_job_json(project: &EngineProjectHandle, request: String) -> napi::Result<()> {
    let request: WriteJobRequest = decode(&request)?;
    let conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    write_job(&conn, &request.job, true)?;
    Ok(())
}

pub(super) fn admit_jobs_json(
    project: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: AdmitJobsRequest = decode(&request)?;
    if request.capacity == 0 {
        return Err(napi_error(
            "invalid-engine-payload",
            "Job admission capacity must be positive.",
        ));
    }
    if request.jobs.is_empty() || request.jobs.len() != request.events.len() {
        return Err(napi_error(
            "invalid-engine-payload",
            "Job admission requires one queued event for every non-empty job batch.",
        ));
    }
    let mut ids = HashSet::new();
    for (job, event) in request.jobs.iter().zip(&request.events) {
        let id = required_json_string(job, "id", "Job")?;
        if !ids.insert(id.to_string()) {
            return Err(napi_error(
                "invalid-engine-payload",
                "Job admission batch contains duplicate run ids.",
            ));
        }
        if required_json_string(job, "kind", "Job")? != "change-check"
            || required_json_string(job, "status", "Job")? != "queued"
        {
            return Err(napi_error(
                "invalid-engine-payload",
                "Job admission accepts queued Change check runs only.",
            ));
        }
        if required_json_string(event, "runId", "Job event")? != id
            || required_json_string(event, "type", "Job event")? != "queued"
            || event.get("sequence").and_then(serde_json::Value::as_u64) != Some(1)
            || required_json_string(event, "batchId", "Job event")?
                != required_json_string(job, "batchId", "Job")?
        {
            return Err(napi_error(
                "invalid-engine-payload",
                "Each admitted run requires its matching sequence-one queued event.",
            ));
        }
    }

    let requested_count = request.jobs.len() as u32;
    let mut conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let transaction = conn
        .transaction()
        .map_err(|error| sqlite_error("Could not start job admission transaction", error))?;
    let active_count: u32 = transaction
        .query_row(
            "select count(*) from jobs where type = 'change-check' and status in ('queued', 'running')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("Could not count active Change check runs", error))?;
    if active_count.saturating_add(requested_count) > request.capacity {
        transaction
            .rollback()
            .map_err(|error| sqlite_error("Could not finish rejected job admission", error))?;
        return encode(&json!({
            "accepted": false,
            "activeCount": active_count,
            "requestedCount": requested_count,
            "capacity": request.capacity,
        }));
    }
    for (job, event) in request.jobs.iter().zip(&request.events) {
        write_job_in_transaction(&transaction, job)?;
        append_job_event_in_transaction(&transaction, event)?;
    }
    transaction
        .commit()
        .map_err(|error| sqlite_error("Could not commit job admission", error))?;
    encode(&json!({
        "accepted": true,
        "activeCount": active_count + requested_count,
        "requestedCount": requested_count,
        "capacity": request.capacity,
    }))
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
    let conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let mut jobs = Vec::new();
    match request.mode.as_str() {
        "recent" => {
            let limit = request
                .limit
                .ok_or_else(|| {
                    napi_error(
                        "invalid-engine-payload",
                        "Recent Change check run queries require limit.",
                    )
                })?
                .clamp(1, 500);
            if let Some(status) = request.status {
                validate_job_status(&status)?;
                let mut statement = conn
                    .prepare("select payload from jobs where type = 'change-check' and status = ?1 order by updated_at desc, id desc limit ?2")
                    .map_err(|error| sqlite_error("Could not prepare filtered Change check run list", error))?;
                let rows = statement
                    .query_map(params![status, limit], |row| row.get::<_, String>(0))
                    .map_err(|error| {
                        sqlite_error("Could not list filtered Change check runs", error)
                    })?;
                for row in rows {
                    jobs.push(decode_stored_json(
                        row,
                        "Could not decode Change check run",
                    )?);
                }
            } else {
                let mut statement = conn
                    .prepare("select payload from jobs where type = 'change-check' order by updated_at desc, id desc limit ?1")
                    .map_err(|error| sqlite_error("Could not prepare Change check run list", error))?;
                let rows = statement
                    .query_map(params![limit], |row| row.get::<_, String>(0))
                    .map_err(|error| sqlite_error("Could not list Change check runs", error))?;
                for row in rows {
                    jobs.push(decode_stored_json(
                        row,
                        "Could not decode Change check run",
                    )?);
                }
            }
        }
        "active" => {
            if request.limit.is_some() || request.status.is_some() {
                return Err(napi_error(
                    "invalid-engine-payload",
                    "Active Change check run queries do not accept limit or status.",
                ));
            }
            let mut statement = conn
                .prepare("select payload from jobs where type = 'change-check' and status in ('queued', 'running') order by updated_at desc, id desc")
                .map_err(|error| sqlite_error("Could not prepare active Change check run list", error))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| sqlite_error("Could not list active Change check runs", error))?;
            for row in rows {
                jobs.push(decode_stored_json(
                    row,
                    "Could not decode active Change check run",
                )?);
            }
        }
        _ => {
            return Err(napi_error(
                "invalid-engine-payload",
                "Change check run query mode must be recent or active.",
            ));
        }
    }
    encode(&jobs)
}

pub(super) fn prune_jobs_json(
    project: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: PruneJobsRequest = decode(&request)?;
    if request.terminal_before.trim().is_empty() || request.max_terminal_count == 0 {
        return Err(napi_error(
            "invalid-engine-payload",
            "Job retention requires terminalBefore and a positive maxTerminalCount.",
        ));
    }
    let mut conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let transaction = conn
        .transaction()
        .map_err(|error| sqlite_error("Could not start job retention transaction", error))?;
    transaction
        .execute_batch(
            "create temp table if not exists opencanon_prunable_jobs(id text primary key) strict;
             delete from opencanon_prunable_jobs;",
        )
        .map_err(|error| sqlite_error("Could not initialize job retention candidates", error))?;
    transaction
        .execute(
            "insert into opencanon_prunable_jobs(id)
             select id from (
               select id, updated_at, row_number() over (order by updated_at desc, id desc) as retained_rank
               from jobs
               where type = 'change-check' and status in ('passed', 'failed', 'cancelled')
             )
             where updated_at < ?1 or retained_rank > ?2",
            params![request.terminal_before, request.max_terminal_count],
        )
        .map_err(|error| sqlite_error("Could not select expired Change check runs", error))?;
    let deleted_runs: u32 = transaction
        .query_row("select count(*) from opencanon_prunable_jobs", [], |row| {
            row.get(0)
        })
        .map_err(|error| sqlite_error("Could not count expired Change check runs", error))?;
    let deleted_events: u32 = transaction
        .query_row(
            "select count(*) from job_events where job_id in (select id from opencanon_prunable_jobs)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("Could not count expired Change check run events", error))?;
    transaction
        .execute(
            "delete from jobs where id in (select id from opencanon_prunable_jobs)",
            [],
        )
        .map_err(|error| sqlite_error("Could not prune expired Change check runs", error))?;
    let retained_terminal_runs: u32 = transaction
        .query_row(
            "select count(*) from jobs where type = 'change-check' and status in ('passed', 'failed', 'cancelled')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("Could not count retained Change check runs", error))?;
    transaction
        .execute("delete from opencanon_prunable_jobs", [])
        .map_err(|error| sqlite_error("Could not clear job retention candidates", error))?;
    transaction
        .commit()
        .map_err(|error| sqlite_error("Could not commit job retention", error))?;
    encode(&json!({
        "deletedRuns": deleted_runs,
        "deletedEvents": deleted_events,
        "retainedTerminalRuns": retained_terminal_runs,
    }))
}

fn validate_job_status(status: &str) -> napi::Result<()> {
    if matches!(
        status,
        "queued" | "running" | "passed" | "failed" | "cancelled"
    ) {
        return Ok(());
    }
    Err(napi_error(
        "invalid-engine-payload",
        "Unknown Change check run status.",
    ))
}

fn write_job(conn: &Connection, job: &serde_json::Value, upsert: bool) -> napi::Result<()> {
    let id = required_json_string(job, "id", "Job")?;
    let job_type = required_json_string(job, "kind", "Job")?;
    let status = required_json_string(job, "status", "Job")?;
    let created_at = required_json_string(job, "createdAt", "Job")?;
    let updated_at = required_json_string(job, "updatedAt", "Job")?;
    let payload = serde_json::to_string(job)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
    let sql = if upsert {
        "insert into jobs(id, type, status, payload, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5, ?6)
         on conflict(id) do update set type = excluded.type, status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at"
    } else {
        "insert into jobs(id, type, status, payload, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5, ?6)"
    };
    conn.execute(
        sql,
        params![id, job_type, status, payload, created_at, updated_at],
    )
    .map_err(|error| sqlite_error("Could not write project job", error))?;
    Ok(())
}

fn write_job_in_transaction(
    transaction: &Transaction<'_>,
    job: &serde_json::Value,
) -> napi::Result<()> {
    write_job(transaction, job, false)
}

fn append_job_event_in_transaction(
    transaction: &Transaction<'_>,
    event: &serde_json::Value,
) -> napi::Result<()> {
    let job_id = required_json_string(event, "runId", "Job event")?;
    let event_type = required_json_string(event, "type", "Job event")?;
    let timestamp = required_json_string(event, "timestamp", "Job event")?;
    let sequence = event
        .get("sequence")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            napi_error(
                "invalid-engine-payload",
                "Job event is missing a positive sequence.",
            )
        })? as i64;
    let payload = serde_json::to_string(event)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
    transaction
        .execute(
            "insert into job_events(job_id, sequence, type, timestamp, payload) values (?1, ?2, ?3, ?4, ?5)",
            params![job_id, sequence, event_type, timestamp, payload],
        )
        .map_err(|error| sqlite_error("Could not append project job event", error))?;
    Ok(())
}

pub(super) fn append_job_event_json(
    project: &EngineProjectHandle,
    request: String,
) -> napi::Result<()> {
    let request: AppendJobEventRequest = decode(&request)?;
    let mut conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let transaction = conn
        .transaction()
        .map_err(|error| sqlite_error("Could not start job event transaction", error))?;
    append_job_event_in_transaction(&transaction, &request.event)?;
    transaction
        .commit()
        .map_err(|error| sqlite_error("Could not commit project job event", error))?;
    Ok(())
}

pub(super) fn list_job_events_json(
    project: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: ListJobEventsRequest = decode(&request)?;
    let after_sequence = request.after_sequence as i64;
    let limit = request.limit.clamp(1, 2_000);
    let conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let sql = match request.order.as_str() {
        "asc" => "select payload from job_events where job_id = ?1 and sequence > ?2 order by sequence asc limit ?3",
        "desc" => "select payload from job_events where job_id = ?1 and sequence > ?2 order by sequence desc limit ?3",
        _ => {
            return Err(napi_error(
                "invalid-engine-payload",
                "Change check event order must be asc or desc.",
            ));
        }
    };
    let mut statement = conn
        .prepare(sql)
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
