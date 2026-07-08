use rusqlite::{params, Connection};
use serde_json::Value;

use crate::json::{napi_error, sqlite_error};
use crate::observability::ObservationSink;

use super::json_fields::{
    json_bool_field, json_optional_bool_field, json_optional_f64_field,
    json_optional_payload_field, json_optional_string_field, json_payload, json_payload_field,
    json_string_field,
};

pub(super) struct SqliteObservationSink<'a> {
    pub(super) tx: &'a rusqlite::Transaction<'a>,
    pub(super) root_dir: &'a str,
}

impl ObservationSink for SqliteObservationSink<'_> {
    fn write_trace(&mut self, trace: &Value) -> napi::Result<()> {
        write_observability_trace(self.tx, self.root_dir, trace)
    }

    fn write_span(&mut self, span: &Value) -> napi::Result<()> {
        write_observability_span(self.tx, self.root_dir, span)
    }

    fn write_event(&mut self, event: &Value) -> napi::Result<()> {
        write_observability_event(self.tx, self.root_dir, event)
    }
}

fn write_observability_trace(
    tx: &rusqlite::Transaction<'_>,
    root_dir: &str,
    trace: &Value,
) -> napi::Result<()> {
    let attributes = json_payload_field(trace, "attributes")?;
    let resource = json_optional_payload_field(trace, "resource")?;
    let error = json_optional_payload_field(trace, "error")?;
    let payload = json_payload(trace)?;
    tx.execute(
        "insert into observability_traces(
           root_dir, id, name, status, recording, sampled, started_at, ended_at, duration_ms,
           parent_trace_id, trace_state, trace_flags, attributes, resource, error, payload
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         on conflict(root_dir, id) do update set
           name = excluded.name,
           status = excluded.status,
           recording = excluded.recording,
           sampled = excluded.sampled,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           duration_ms = excluded.duration_ms,
           parent_trace_id = excluded.parent_trace_id,
           trace_state = excluded.trace_state,
           trace_flags = excluded.trace_flags,
           attributes = excluded.attributes,
           resource = excluded.resource,
           error = excluded.error,
           payload = excluded.payload",
        params![
            root_dir,
            json_string_field(trace, "id")?,
            json_string_field(trace, "name")?,
            json_string_field(trace, "status")?,
            json_bool_field(trace, "recording")? as i64,
            json_bool_field(trace, "sampled")? as i64,
            json_string_field(trace, "startedAt")?,
            json_optional_string_field(trace, "endedAt"),
            json_optional_f64_field(trace, "durationMs"),
            json_optional_string_field(trace, "parentTraceId"),
            json_optional_string_field(trace, "traceState"),
            json_optional_string_field(trace, "traceFlags"),
            attributes,
            resource,
            error,
            payload,
        ],
    )
    .map_err(|error| sqlite_error("Could not write observability trace", error))?;
    Ok(())
}

fn write_observability_span(
    tx: &rusqlite::Transaction<'_>,
    root_dir: &str,
    span: &Value,
) -> napi::Result<()> {
    let attributes = json_payload_field(span, "attributes")?;
    let resource = json_optional_payload_field(span, "resource")?;
    let output = json_optional_payload_field(span, "output")?;
    let error = json_optional_payload_field(span, "error")?;
    let payload = json_payload(span)?;
    tx.execute(
        "insert into observability_spans(
           root_dir, id, trace_id, parent_span_id, name, kind, otel_kind, status,
           recording, sampled, started_at, ended_at, duration_ms, trace_parent,
           trace_state, trace_flags, attributes, resource, output, error, payload
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
         on conflict(root_dir, id) do update set
           trace_id = excluded.trace_id,
           parent_span_id = excluded.parent_span_id,
           name = excluded.name,
           kind = excluded.kind,
           otel_kind = excluded.otel_kind,
           status = excluded.status,
           recording = excluded.recording,
           sampled = excluded.sampled,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           duration_ms = excluded.duration_ms,
           trace_parent = excluded.trace_parent,
           trace_state = excluded.trace_state,
           trace_flags = excluded.trace_flags,
           attributes = excluded.attributes,
           resource = excluded.resource,
           output = excluded.output,
           error = excluded.error,
           payload = excluded.payload",
        params![
            root_dir,
            json_string_field(span, "id")?,
            json_string_field(span, "traceId")?,
            json_optional_string_field(span, "parentSpanId"),
            json_string_field(span, "name")?,
            json_string_field(span, "kind")?,
            json_string_field(span, "otelKind")?,
            json_string_field(span, "status")?,
            json_bool_field(span, "recording")? as i64,
            json_bool_field(span, "sampled")? as i64,
            json_string_field(span, "startedAt")?,
            json_optional_string_field(span, "endedAt"),
            json_optional_f64_field(span, "durationMs"),
            json_string_field(span, "traceParent")?,
            json_optional_string_field(span, "traceState"),
            json_string_field(span, "traceFlags")?,
            attributes,
            resource,
            output,
            error,
            payload,
        ],
    )
    .map_err(|error| sqlite_error("Could not write observability span", error))?;
    Ok(())
}

fn write_observability_event(
    tx: &rusqlite::Transaction<'_>,
    root_dir: &str,
    event: &Value,
) -> napi::Result<()> {
    let attributes = json_optional_payload_field(event, "attributes")?;
    let resource = json_optional_payload_field(event, "resource")?;
    let payload = json_payload(event)?;
    tx.execute(
        "insert into observability_events(
           root_dir, id, trace_id, span_id, name, occurred_at, trace_flags, sampled,
           attributes, resource, payload
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         on conflict(root_dir, id) do update set
           trace_id = excluded.trace_id,
           span_id = excluded.span_id,
           name = excluded.name,
           occurred_at = excluded.occurred_at,
           trace_flags = excluded.trace_flags,
           sampled = excluded.sampled,
           attributes = excluded.attributes,
           resource = excluded.resource,
           payload = excluded.payload",
        params![
            root_dir,
            json_string_field(event, "id")?,
            json_string_field(event, "traceId")?,
            json_optional_string_field(event, "spanId"),
            json_string_field(event, "name")?,
            json_string_field(event, "occurredAt")?,
            json_optional_string_field(event, "traceFlags"),
            json_optional_bool_field(event, "sampled").map(|value| value as i64),
            attributes,
            resource,
            payload,
        ],
    )
    .map_err(|error| sqlite_error("Could not write observability event", error))?;
    Ok(())
}

pub(super) fn list_observability_payloads(
    conn: &Connection,
    root_dir: &str,
    table: &str,
    order_expr: &str,
    trace_column: &str,
    trace_id: Option<&str>,
    limit: u32,
) -> napi::Result<Vec<Value>> {
    let limit = i64::from(limit);
    match trace_id {
        Some(trace_id) => {
            let sql = format!(
                "select payload from {table} where root_dir = ?1 and {trace_column} = ?2 order by {order_expr} desc limit ?3"
            );
            let mut statement = conn
                .prepare(&sql)
                .map_err(|error| sqlite_error("Could not prepare observability list", error))?;
            let mut rows = statement
                .query(params![root_dir, trace_id, limit])
                .map_err(|error| sqlite_error("Could not list observability records", error))?;
            collect_observability_payloads(&mut rows)
        }
        None => {
            let sql = format!(
                "select payload from {table} where root_dir = ?1 order by {order_expr} desc limit ?2"
            );
            let mut statement = conn
                .prepare(&sql)
                .map_err(|error| sqlite_error("Could not prepare observability list", error))?;
            let mut rows = statement
                .query(params![root_dir, limit])
                .map_err(|error| sqlite_error("Could not list observability records", error))?;
            collect_observability_payloads(&mut rows)
        }
    }
}

fn collect_observability_payloads(rows: &mut rusqlite::Rows<'_>) -> napi::Result<Vec<Value>> {
    let mut payloads = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| sqlite_error("Could not decode observability row", error))?
    {
        let payload = row
            .get::<_, String>(0)
            .map_err(|error| sqlite_error("Could not decode observability payload", error))?;
        payloads.push(
            serde_json::from_str::<Value>(&payload)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?,
        );
    }
    Ok(payloads)
}
