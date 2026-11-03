create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  price_cents integer not null check (price_cents > 0)
);

create type order_status as enum ('pending', 'paid', 'failed', 'expired', 'refunded');
create type payment_method as enum ('pix', 'card');

create table orders (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  amount_cents integer not null check (amount_cents > 0),
  customer_email text not null,
  method payment_method not null,
  status order_status not null default 'pending',
  -- Mercado Pago payment id or Stripe Checkout Session id.
  provider_ref text,
  pix_copy_paste text,
  pix_qr_base64 text,
  checkout_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per provider event: a retried webhook hits the primary key and is
-- skipped, so an order is never moved twice by the same event.
create table payment_events (
  provider text not null,
  event_id text not null,
  order_id uuid references orders (id),
  status order_status,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);

-- Only the server, with the service-role key, touches these tables. RLS on
-- with no policies keeps the anon key out entirely.
alter table products enable row level security;
alter table orders enable row level security;
alter table payment_events enable row level security;
