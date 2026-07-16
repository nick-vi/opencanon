create table protocol_events (
  sequence integer primary key autoincrement,
  timestamp text not null,
  revision integer not null check (revision > 0),
  domain text not null check (domain in ('project', 'canon', 'proof', 'knowledge', 'activity', 'health')),
  type text not null,
  operation_id text,
  payload text not null
);

create index idx_protocol_events_timestamp on protocol_events(timestamp);
create index idx_protocol_events_operation_sequence on protocol_events(operation_id, sequence);
