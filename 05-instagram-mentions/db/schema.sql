create table if not exists mentions (
  id bigserial primary key,
  -- 'comment:<comment id>' or 'media:<media id>'. Unique, so a webhook Meta
  -- delivers twice is stored once.
  mention_key text unique not null,
  kind text not null check (kind in ('comment', 'media')),
  ig_user_id text not null,
  media_id text not null,
  comment_id text,
  -- Null for a comment: Graph does not return the comment's author.
  username text,
  text text not null default '',
  permalink text,
  media_url text,
  posted_at timestamptz,
  received_at timestamptz not null default now(),
  -- Set when the mention could not be read back from Graph.
  fetch_error text
);

create table if not exists replies (
  id bigserial primary key,
  mention_id bigint not null references mentions (id),
  body text not null,
  -- The id of the comment Instagram created for the reply.
  graph_id text,
  -- Set when Instagram refused the reply: it was never posted.
  send_error text,
  created_at timestamptz not null default now()
);

create index if not exists replies_by_mention on replies (mention_id, id);
