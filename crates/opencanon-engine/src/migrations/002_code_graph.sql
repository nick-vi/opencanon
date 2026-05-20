create table code_extractions (
  path text primary key,
  content_hash text not null,
  parser_version text not null,
  extractor_version text not null,
  extracted_at text not null,
  diagnostics text not null default '[]',
  foreign key(path) references files(path) on delete cascade
);

create table code_nodes (
  id text primary key,
  path text not null,
  language text not null,
  kind text not null,
  name text not null,
  qualified_name text not null,
  exported integer not null default 0,
  signature text,
  start_line integer not null,
  start_column integer not null,
  end_line integer not null,
  end_column integer not null,
  start_byte integer not null,
  end_byte integer not null,
  content_hash text not null,
  extractor_version text not null,
  indexed_at text not null,
  foreign key(path) references files(path) on delete cascade
);

create table code_edges (
  id text primary key,
  source_id text not null,
  target_id text not null,
  kind text not null,
  provenance text not null,
  confidence text not null,
  path text not null,
  start_line integer,
  start_column integer,
  start_byte integer,
  metadata text not null default '{}',
  foreign key(source_id) references code_nodes(id) on delete cascade,
  foreign key(target_id) references code_nodes(id) on delete cascade,
  foreign key(path) references files(path) on delete cascade
);

create table unresolved_references (
  id text primary key,
  from_node_id text,
  path text not null,
  language text not null,
  reference_name text not null,
  reference_kind text not null,
  source text,
  start_line integer not null,
  start_column integer not null,
  end_line integer not null,
  end_column integer not null,
  start_byte integer not null,
  end_byte integer not null,
  candidates text not null default '[]',
  provenance text not null,
  confidence text not null,
  content_hash text not null,
  extractor_version text not null,
  indexed_at text not null,
  foreign key(from_node_id) references code_nodes(id) on delete set null,
  foreign key(path) references files(path) on delete cascade
);

create index idx_code_nodes_path on code_nodes(path);
create index idx_code_nodes_kind on code_nodes(kind);
create index idx_code_nodes_name on code_nodes(name);
create index idx_code_nodes_qualified_name on code_nodes(qualified_name);
create index idx_code_nodes_path_line on code_nodes(path, start_line);
create index idx_code_edges_source_kind on code_edges(source_id, kind);
create index idx_code_edges_target_kind on code_edges(target_id, kind);
create index idx_unresolved_path on unresolved_references(path);
create index idx_unresolved_name on unresolved_references(reference_name);
create index idx_unresolved_from on unresolved_references(from_node_id);

create virtual table code_node_search_fts using fts5(
  name,
  qualified_name,
  kind,
  path,
  signature,
  content='code_nodes',
  content_rowid='rowid',
  tokenize = 'unicode61 tokenchars ''_'''
);

create trigger code_node_search_fts_ai after insert on code_nodes begin
  insert into code_node_search_fts(rowid, name, qualified_name, kind, path, signature)
  values (new.rowid, new.name, new.qualified_name, new.kind, new.path, coalesce(new.signature, ''));
end;

create trigger code_node_search_fts_ad after delete on code_nodes begin
  insert into code_node_search_fts(code_node_search_fts, rowid, name, qualified_name, kind, path, signature)
  values ('delete', old.rowid, old.name, old.qualified_name, old.kind, old.path, coalesce(old.signature, ''));
end;

create trigger code_node_search_fts_au after update on code_nodes begin
  insert into code_node_search_fts(code_node_search_fts, rowid, name, qualified_name, kind, path, signature)
  values ('delete', old.rowid, old.name, old.qualified_name, old.kind, old.path, coalesce(old.signature, ''));
  insert into code_node_search_fts(rowid, name, qualified_name, kind, path, signature)
  values (new.rowid, new.name, new.qualified_name, new.kind, new.path, coalesce(new.signature, ''));
end;
