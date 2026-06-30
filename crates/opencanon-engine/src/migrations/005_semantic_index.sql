create table semantic_index_snapshots (
  root_dir text not null,
  id text not null,
  version text not null,
  status text not null,
  provider_id text not null,
  provider_display_name text,
  model_id text not null,
  model_digest text,
  dimensions integer not null,
  distance text not null,
  config_hash text not null,
  chunker_version text not null,
  producer_version text not null,
  source_inventory_hash text not null,
  identity_hash text not null,
  chunk_count integer not null default 0,
  vector_count integer not null default 0,
  stale_chunk_count integer not null default 0,
  diagnostics text not null default '[]',
  payload text not null,
  indexed_at text not null,
  updated_at text not null,
  primary key(root_dir, id)
);

create table semantic_chunks (
  root_dir text not null,
  index_id text not null,
  id text not null,
  path text not null,
  content_hash text not null,
  chunk_hash text not null,
  embedding_hash text not null,
  kind text not null,
  language text not null,
  ordinal integer not null,
  start_line integer not null,
  start_column integer not null,
  start_byte integer not null,
  end_line integer not null,
  end_column integer not null,
  end_byte integer not null,
  heading text,
  symbol text,
  token_estimate integer not null,
  preview text not null,
  payload text not null,
  indexed_at text not null,
  primary key(root_dir, index_id, id),
  foreign key(root_dir, index_id) references semantic_index_snapshots(root_dir, id) on delete cascade
);

create index idx_semantic_chunks_path on semantic_chunks(root_dir, index_id, path);
create index idx_semantic_chunks_hash on semantic_chunks(root_dir, index_id, chunk_hash);
create index idx_semantic_index_status on semantic_index_snapshots(root_dir, status);
