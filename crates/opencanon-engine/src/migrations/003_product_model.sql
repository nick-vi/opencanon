create table product_model_snapshots (
  root_dir text primary key,
  graph_hash text not null,
  definitions_hash text not null,
  area_count integer not null default 0,
  spec_count integer not null default 0,
  change_count integer not null default 0,
  convention_count integer not null default 0,
  impact_surface_count integer not null default 0,
  validator_count integer not null default 0,
  node_count integer not null default 0,
  edge_count integer not null default 0,
  diagnostic_count integer not null default 0,
  payload text not null,
  indexed_at text not null
);

create table product_model_nodes (
  root_dir text not null,
  id text not null,
  kind text not null,
  label text not null,
  payload text not null,
  indexed_at text not null,
  primary key(root_dir, id),
  foreign key(root_dir) references product_model_snapshots(root_dir) on delete cascade
);

create table product_model_edges (
  root_dir text not null,
  id text not null,
  from_node_id text not null,
  to_node_id text not null,
  kind text not null,
  label text,
  payload text not null,
  indexed_at text not null,
  primary key(root_dir, id),
  foreign key(root_dir) references product_model_snapshots(root_dir) on delete cascade
);

create table product_model_diagnostics (
  root_dir text not null,
  id text not null,
  severity text not null,
  code text not null,
  from_node_id text,
  to_node_id text,
  message text not null,
  payload text not null,
  indexed_at text not null,
  primary key(root_dir, id),
  foreign key(root_dir) references product_model_snapshots(root_dir) on delete cascade
);

create index idx_product_model_nodes_kind on product_model_nodes(root_dir, kind);
create index idx_product_model_edges_from on product_model_edges(root_dir, from_node_id, kind);
create index idx_product_model_edges_to on product_model_edges(root_dir, to_node_id, kind);
create index idx_product_model_diagnostics_severity on product_model_diagnostics(root_dir, severity);
