create table knowledge_nodes (
  root_dir text not null,
  index_id text not null,
  key text not null,
  kind text not null,
  hash text not null,
  parent_key text,
  children text not null default '[]',
  updated_at text not null,
  primary key(root_dir, index_id, key),
  foreign key(root_dir, index_id) references semantic_index_snapshots(root_dir, id) on delete cascade
);

create index idx_knowledge_nodes_parent on knowledge_nodes(root_dir, index_id, parent_key);
create index idx_knowledge_nodes_kind on knowledge_nodes(root_dir, index_id, kind);
