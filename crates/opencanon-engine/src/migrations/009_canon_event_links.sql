create table canon_event_links (
  event_id text not null,
  kind text not null check (kind in ('change', 'task', 'check')),
  value text not null,
  primary key(event_id, kind, value),
  foreign key(event_id) references canon_events(id) on delete cascade
);

create index idx_canon_event_links_lookup on canon_event_links(kind, value, event_id);

insert or ignore into canon_event_links(event_id, kind, value)
select canon_events.id, 'change', json_each.value
from canon_events, json_each(canon_events.payload, '$.changeIds');

insert or ignore into canon_event_links(event_id, kind, value)
select canon_events.id, 'task', json_each.value
from canon_events, json_each(canon_events.payload, '$.taskIds');

insert or ignore into canon_event_links(event_id, kind, value)
select canon_events.id, 'check', json_each.value
from canon_events, json_each(canon_events.payload, '$.checkIds');
