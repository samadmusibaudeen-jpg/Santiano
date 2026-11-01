-- Run this ONCE in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- It creates the products table, the photo bucket and the stock function the shop uses.

create table if not exists public.products (
  id          bigint generated always as identity primary key,
  name        text        not null,
  description text,
  category    text,                                   -- e.g. 'Footwear'. Shoppers browse by this.
  price       numeric(12,2) not null check (price >= 0),   -- naira
  compare_at  numeric(12,2),                          -- old price; shows a "-20%" badge when higher than price
  stock_qty   integer check (stock_qty >= 0),         -- leave empty if you do not track stock (always available)
  sizes       text[]      not null default '{}',      -- e.g. {38,39,40}
  colours     text[]      not null default '{}',      -- e.g. {Black,White}
  images      text[]      not null default '{}',      -- public image URLs, first one is the main photo
  specs       text,
  tags        text,                                   -- extra search words, comma separated
  active      boolean     not null default true,      -- false hides it from the shop
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists products_category_idx on public.products (category);

-- The shop server talks to Supabase with the service-role key, which bypasses row level security.
-- Turning RLS on with no policies means nobody can read or change products with the public (anon) key.
alter table public.products enable row level security;

-- Public bucket for product photos (the admin page uploads here).
insert into storage.buckets (id, name, public) values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

-- Atomic stock change used when an order is paid (delta -2) or refunded (delta +2). Returns the new quantity.
create or replace function public.adjust_stock(p_id bigint, delta integer)
returns integer language sql as $$
  update public.products
     set stock_qty = greatest(0, stock_qty + delta), updated_at = now()
   where id = p_id and stock_qty is not null
  returning stock_qty;
$$;
revoke execute on function public.adjust_stock(bigint, integer) from public, anon, authenticated;
grant  execute on function public.adjust_stock(bigint, integer) to service_role;
