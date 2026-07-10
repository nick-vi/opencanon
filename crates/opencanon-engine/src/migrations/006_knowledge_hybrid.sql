alter table knowledge_snapshots add column chunk_tree_hash text not null default '';
alter table knowledge_chunks add column text text not null default '';

create virtual table if not exists knowledge_chunks_fts using fts5(
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

create index if not exists idx_knowledge_chunks_embedding_hash on knowledge_chunks(root_dir, index_id, embedding_hash);
