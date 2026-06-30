create table observability_traces (
  root_dir text not null,
  id text not null,
  name text not null,
  status text not null,
  recording integer not null,
  sampled integer not null,
  started_at text not null,
  ended_at text,
  duration_ms real,
  parent_trace_id text,
  trace_state text,
  trace_flags text,
  attributes text not null,
  resource text,
  error text,
  payload text not null,
  primary key(root_dir, id)
);

create table observability_spans (
  root_dir text not null,
  id text not null,
  trace_id text not null,
  parent_span_id text,
  name text not null,
  kind text not null,
  otel_kind text not null,
  status text not null,
  recording integer not null,
  sampled integer not null,
  started_at text not null,
  ended_at text,
  duration_ms real,
  trace_parent text not null,
  trace_state text,
  trace_flags text not null,
  attributes text not null,
  resource text,
  output text,
  error text,
  payload text not null,
  primary key(root_dir, id)
);

create table observability_events (
  root_dir text not null,
  id text not null,
  trace_id text not null,
  span_id text,
  name text not null,
  occurred_at text not null,
  trace_flags text,
  sampled integer,
  attributes text,
  resource text,
  payload text not null,
  primary key(root_dir, id)
);

create index idx_observability_traces_started on observability_traces(root_dir, started_at);
create index idx_observability_traces_status on observability_traces(root_dir, status);
create index idx_observability_spans_trace on observability_spans(root_dir, trace_id, started_at);
create index idx_observability_spans_status on observability_spans(root_dir, status);
create index idx_observability_events_trace on observability_events(root_dir, trace_id, occurred_at);
create index idx_observability_events_span on observability_events(root_dir, span_id, occurred_at);
