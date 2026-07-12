create index idx_jobs_type_status_updated
  on jobs(type, status, updated_at desc, id desc);
