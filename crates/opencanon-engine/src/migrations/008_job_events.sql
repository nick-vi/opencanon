create table job_events (
  job_id text not null,
  sequence integer not null,
  type text not null,
  timestamp text not null,
  payload text not null,
  primary key(job_id, sequence),
  foreign key(job_id) references jobs(id) on delete cascade
);

create index idx_job_events_job_sequence on job_events(job_id, sequence);
