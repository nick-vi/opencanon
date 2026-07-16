create table project_publication (
  singleton integer primary key check (singleton = 1),
  revision integer not null check (revision > 0),
  active_code_graph_generation text not null,
  published_at text not null
);
