create table meta (
  key text primary key,
  value text not null
);

create table files (
  path text primary key,
  content_hash text not null,
  fact_hash text,
  language text,
  size integer not null default 0,
  indexed_at text not null,
  stale integer not null default 0
);

create table facts (
  path text primary key,
  content_hash text not null,
  parser_version text not null,
  payload text not null,
  diagnostics text not null,
  indexed_at text not null,
  foreign key(path) references files(path) on delete cascade
);

create table repo_graphs (
  graph_hash text primary key,
  payload text not null,
  indexed_at text not null
);

create table findings (
  id text primary key,
  validator_id text,
  file text,
  payload text not null,
  status text not null default 'open',
  indexed_at text not null,
  resolved_at text
);

create table canon_events (
  id text primary key,
  type text not null,
  timestamp text not null,
  payload text not null
);

create table watch_state (
  root_dir text primary key,
  inventory_hash text not null,
  stale integer not null,
  reason text,
  updated_at text not null
);

create table jobs (
  id text primary key,
  type text not null,
  status text not null,
  payload text not null,
  created_at text not null,
  updated_at text not null
);

create index idx_files_stale on files(stale);
create index idx_findings_validator_file on findings(validator_id, file);
create index idx_canon_events_timestamp on canon_events(timestamp);
create index idx_jobs_status on jobs(status);
