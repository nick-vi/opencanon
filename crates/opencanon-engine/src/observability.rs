use serde_json::Value;

use crate::json::napi_error;

pub(crate) struct ObservationBatch<'a> {
    pub(crate) traces: &'a [Value],
    pub(crate) spans: &'a [Value],
    pub(crate) events: &'a [Value],
}

pub(crate) trait ObservationSink {
    fn write_trace(&mut self, trace: &Value) -> napi::Result<()>;
    fn write_span(&mut self, span: &Value) -> napi::Result<()>;
    fn write_event(&mut self, event: &Value) -> napi::Result<()>;

    fn write_batch(&mut self, batch: ObservationBatch<'_>) -> napi::Result<()> {
        for trace in batch.traces {
            validate_trace_record(trace)?;
            self.write_trace(trace)?;
        }
        for span in batch.spans {
            validate_span_record(span)?;
            self.write_span(span)?;
        }
        for event in batch.events {
            validate_event_record(event)?;
            self.write_event(event)?;
        }
        Ok(())
    }
}

pub(crate) fn validate_trace_record(trace: &Value) -> napi::Result<()> {
    validate_trace_id("trace.id", required_string(trace, "id")?)?;
    if let Some(trace_flags) = optional_string(trace, "traceFlags") {
        validate_trace_flags("trace.traceFlags", trace_flags)?;
    }
    Ok(())
}

pub(crate) fn validate_span_record(span: &Value) -> napi::Result<()> {
    let span_id = required_string(span, "id")?;
    let trace_id = required_string(span, "traceId")?;
    validate_span_id("span.id", span_id)?;
    validate_trace_id("span.traceId", trace_id)?;
    if let Some(parent_span_id) = optional_string(span, "parentSpanId") {
        validate_span_id("span.parentSpanId", parent_span_id)?;
    }
    let trace_flags = required_string(span, "traceFlags")?;
    validate_trace_flags("span.traceFlags", trace_flags)?;
    validate_traceparent(
        required_string(span, "traceParent")?,
        trace_id,
        span_id,
        trace_flags,
    )?;
    Ok(())
}

pub(crate) fn validate_event_record(event: &Value) -> napi::Result<()> {
    validate_trace_id("event.traceId", required_string(event, "traceId")?)?;
    if let Some(span_id) = optional_string(event, "spanId") {
        validate_span_id("event.spanId", span_id)?;
    }
    if let Some(trace_flags) = optional_string(event, "traceFlags") {
        validate_trace_flags("event.traceFlags", trace_flags)?;
    }
    Ok(())
}

fn validate_traceparent(
    traceparent: &str,
    trace_id: &str,
    span_id: &str,
    trace_flags: &str,
) -> napi::Result<()> {
    let mut parts = traceparent.split('-');
    let Some(version) = parts.next() else {
        return invalid("span.traceParent must contain a version.");
    };
    let Some(parent_trace_id) = parts.next() else {
        return invalid("span.traceParent must contain a trace id.");
    };
    let Some(parent_id) = parts.next() else {
        return invalid("span.traceParent must contain a parent id.");
    };
    let Some(parent_flags) = parts.next() else {
        return invalid("span.traceParent must contain trace flags.");
    };
    if parts.next().is_some() {
        return invalid("span.traceParent has too many fields.");
    }
    if version != "00" {
        return invalid("span.traceParent must use W3C trace context version 00.");
    }
    validate_trace_id("span.traceParent.traceId", parent_trace_id)?;
    validate_span_id("span.traceParent.parentId", parent_id)?;
    validate_trace_flags("span.traceParent.traceFlags", parent_flags)?;
    if parent_trace_id != trace_id {
        return invalid("span.traceParent trace id must match span.traceId.");
    }
    if parent_id != span_id {
        return invalid("span.traceParent parent id must match span.id.");
    }
    if parent_flags != trace_flags {
        return invalid("span.traceParent trace flags must match span.traceFlags.");
    }
    Ok(())
}

fn validate_trace_id(field: &str, value: &str) -> napi::Result<()> {
    if is_lower_hex(value, 32) && !is_all_zero(value) {
        return Ok(());
    }
    invalid(&format!(
        "{field} must be a non-zero 32 character lowercase hex trace id."
    ))
}

fn validate_span_id(field: &str, value: &str) -> napi::Result<()> {
    if is_lower_hex(value, 16) && !is_all_zero(value) {
        return Ok(());
    }
    invalid(&format!(
        "{field} must be a non-zero 16 character lowercase hex span id."
    ))
}

fn validate_trace_flags(field: &str, value: &str) -> napi::Result<()> {
    if is_lower_hex(value, 2) {
        return Ok(());
    }
    invalid(&format!(
        "{field} must be a 2 character lowercase hex trace flags value."
    ))
}

fn required_string<'a>(value: &'a Value, field: &str) -> napi::Result<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        napi_error(
            "invalid-observability-record",
            &format!("Observability record is missing string field {field}."),
        )
    })
}

fn optional_string<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn is_lower_hex(value: &str, expected_len: usize) -> bool {
    value.len() == expected_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_all_zero(value: &str) -> bool {
    value.bytes().all(|byte| byte == b'0')
}

fn invalid<T>(message: &str) -> napi::Result<T> {
    Err(napi_error("invalid-observability-record", message))
}
