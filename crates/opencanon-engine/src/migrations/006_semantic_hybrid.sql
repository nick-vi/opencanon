alter table semantic_index_snapshots add column chunk_tree_hash text not null default '';
alter table semantic_chunks add column text text not null default '';

create virtual table if not exists semantic_chunks_fts using fts5(
  root_dir unindexed,
  index_id unindexed,
  id unindexed,
  path,
  heading,
  symbol,
  language,
  kind,
  preview,
  text,
  tokenize = 'unicode61'
);

create index if not exists idx_semantic_chunks_embedding_hash on semantic_chunks(root_dir, index_id, embedding_hash);
