create table if not exists conversations (
  wa_id text primary key,
  name text not null default '',
  -- 'bot' answers automatically; 'human' leaves the customer to an attendant.
  mode text not null default 'bot' check (mode in ('bot', 'human')),
  handoff_reason text,
  last_inbound_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id bigserial primary key,
  wa_id text not null references conversations (wa_id),
  author text not null check (author in ('customer', 'bot', 'agent')),
  body text not null,
  -- WhatsApp's message id. Unique for inbound messages, so a webhook Meta
  -- delivers twice is stored and answered once.
  wamid text unique,
  created_at timestamptz not null default now()
);

-- Set when WhatsApp refused an outbound message: the customer never got it,
-- and the dashboard says so.
alter table messages add column if not exists send_error text;

create index if not exists messages_by_conversation on messages (wa_id, id);
