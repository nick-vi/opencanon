use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::json;

use super::EngineProjectHandle;
use crate::contracts::{AppendProtocolEventRequest, ListProtocolEventsRequest};
use crate::json::{decode, encode, napi_error, sqlite_error};

pub(super) fn append_protocol_event_json(
    project: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: AppendProtocolEventRequest = decode(&request)?;
    let mut conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let transaction = conn
        .transaction()
        .map_err(|error| sqlite_error("Could not start protocol event transaction", error))?;
    let event = append_protocol_event(
        &transaction,
        request.event,
        request.max_count,
        &request.retain_after,
    )?;
    transaction
        .commit()
        .map_err(|error| sqlite_error("Could not commit protocol event", error))?;

    encode(&event)
}

pub(super) fn append_protocol_event(
    transaction: &Transaction<'_>,
    mut event: serde_json::Value,
    max_count: u32,
    retain_after: &str,
) -> napi::Result<serde_json::Value> {
    if max_count == 0 {
        return Err(napi_error(
            "invalid-engine-payload",
            "Protocol event retention count must be positive.",
        ));
    }
    let timestamp = required_string(&event, "timestamp")?;
    let revision = event
        .get("revision")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            napi_error(
                "invalid-engine-payload",
                "Protocol event revision must be positive.",
            )
        })?;
    let revision = i64::try_from(revision).map_err(|_| {
        napi_error(
            "invalid-engine-payload",
            "Protocol event revision exceeds SQLite integer range.",
        )
    })?;
    let domain = required_string(&event, "domain")?;
    let event_type = required_string(&event, "type")?;
    let operation_id = event.get("operationId").and_then(serde_json::Value::as_str);
    let payload = serde_json::to_string(&event)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;

    transaction
        .execute(
            "insert into protocol_events(timestamp, revision, domain, type, operation_id, payload)
             values (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                timestamp,
                revision,
                domain,
                event_type,
                operation_id,
                payload
            ],
        )
        .map_err(|error| sqlite_error("Could not append protocol event", error))?;
    let sequence = transaction.last_insert_rowid();
    transaction
        .execute(
            "delete from protocol_events where timestamp < ?1",
            params![retain_after],
        )
        .map_err(|error| sqlite_error("Could not expire protocol events by age", error))?;
    let keep_from = transaction
        .query_row(
            "select sequence from protocol_events order by sequence desc limit 1 offset ?1",
            params![i64::from(max_count - 1)],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| sqlite_error("Could not calculate protocol event retention", error))?;
    if let Some(keep_from) = keep_from {
        transaction
            .execute(
                "delete from protocol_events where sequence < ?1",
                params![keep_from],
            )
            .map_err(|error| sqlite_error("Could not bound protocol event retention", error))?;
    }

    let record = event.as_object_mut().ok_or_else(|| {
        napi_error(
            "invalid-engine-payload",
            "Protocol event must be a JSON object.",
        )
    })?;
    record.insert("sequence".to_string(), json!(sequence));
    Ok(event)
}

pub(super) fn list_protocol_events_json(
    project: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: ListProtocolEventsRequest = decode(&request)?;
    if request.limit == 0 || request.limit > 1000 {
        return Err(napi_error(
            "invalid-engine-payload",
            "Protocol event limit must be from 1 to 1000.",
        ));
    }
    let after_sequence = i64::try_from(request.after_sequence).map_err(|_| {
        napi_error(
            "invalid-engine-payload",
            "Protocol event cursor exceeds SQLite integer range.",
        )
    })?;
    let conn = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let latest_sequence = conn
        .query_row(
            "select coalesce(max(sequence), 0) from protocol_events",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| sqlite_error("Could not read latest protocol event sequence", error))?;
    let oldest_available_sequence = conn
        .query_row("select min(sequence) from protocol_events", [], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .map_err(|error| sqlite_error("Could not read oldest protocol event sequence", error))?;
    let mut statement = conn
        .prepare(
            "select sequence, payload from protocol_events
             where sequence > ?1 and (?2 is null or operation_id = ?2)
             order by sequence asc limit ?3",
        )
        .map_err(|error| sqlite_error("Could not prepare protocol event replay", error))?;
    let rows = statement
        .query_map(
            params![
                after_sequence,
                request.operation_id,
                i64::from(request.limit)
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| sqlite_error("Could not list protocol events", error))?;
    let mut events = Vec::new();
    for row in rows {
        let (sequence, payload) =
            row.map_err(|error| sqlite_error("Could not decode protocol event", error))?;
        let mut event = serde_json::from_str::<serde_json::Value>(&payload)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
        let record = event.as_object_mut().ok_or_else(|| {
            napi_error(
                "invalid-engine-payload",
                "Stored protocol event must be a JSON object.",
            )
        })?;
        record.insert("sequence".to_string(), json!(sequence));
        events.push(event);
    }
    encode(&json!({
        "events": events,
        "latestSequence": latest_sequence,
        "oldestAvailableSequence": oldest_available_sequence,
    }))
}

fn required_string<'a>(value: &'a serde_json::Value, key: &str) -> napi::Result<&'a str> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| {
            napi_error(
                "invalid-engine-payload",
                &format!("Protocol event is missing {key}."),
            )
        })
}
