use rusqlite::{params, Transaction};

use crate::json::{napi_error, sqlite_error};

pub(super) fn write_canon_event(
    transaction: &Transaction<'_>,
    event: &serde_json::Value,
) -> napi::Result<()> {
    let id = required_event_string(event, "id")?;
    let event_type = required_event_string(event, "type")?;
    let timestamp = required_event_string(event, "timestamp")?;
    let payload = serde_json::to_string(event)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
    let links = canon_event_links(event)?;

    transaction.execute(
        "insert into canon_events(id, type, timestamp, payload) values (?1, ?2, ?3, ?4)
         on conflict(id) do update set type = excluded.type, timestamp = excluded.timestamp, payload = excluded.payload",
        params![id, event_type, timestamp, payload],
    )
    .map_err(|error| sqlite_error("Could not write canon event", error))?;
    transaction
        .execute(
            "delete from canon_event_links where event_id = ?1",
            params![id],
        )
        .map_err(|error| sqlite_error("Could not replace Canon event links", error))?;
    for (kind, value) in links {
        transaction
            .execute(
                "insert into canon_event_links(event_id, kind, value) values (?1, ?2, ?3)",
                params![id, kind, value],
            )
            .map_err(|error| sqlite_error("Could not write Canon event link", error))?;
    }
    Ok(())
}

fn canon_event_links(event: &serde_json::Value) -> napi::Result<Vec<(&'static str, String)>> {
    let mut links = Vec::new();
    for (field, kind) in [
        ("changeIds", "change"),
        ("taskIds", "task"),
        ("checkIds", "check"),
    ] {
        let Some(values) = event.get(field).and_then(serde_json::Value::as_array) else {
            continue;
        };
        for value in values {
            let value = value
                .as_str()
                .filter(|item| !item.trim().is_empty())
                .ok_or_else(|| {
                    napi_error(
                        "invalid-engine-payload",
                        &format!("Canon event {field} must contain non-empty strings."),
                    )
                })?;
            links.push((kind, value.to_string()));
        }
    }
    Ok(links)
}

fn required_event_string<'a>(event: &'a serde_json::Value, field: &str) -> napi::Result<&'a str> {
    event
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            napi_error(
                "invalid-engine-payload",
                &format!("Canon event is missing {field}."),
            )
        })
}
