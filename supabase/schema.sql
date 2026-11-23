-- SONIQ Supabase schema
-- Run this in Supabase Dashboard → SQL Editor.

create table if not exists public.app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

drop policy if exists "Users can read own app state" on public.app_state;
create policy "Users can read own app state"
  on public.app_state for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own app state" on public.app_state;
create policy "Users can insert own app state"
  on public.app_state for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own app state" on public.app_state;
create policy "Users can update own app state"
  on public.app_state for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own app state" on public.app_state;
create policy "Users can delete own app state"
  on public.app_state for delete to authenticated
  using (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('music', 'music', true)
on conflict (id) do update set public = true;

drop policy if exists "Users can upload own audio" on storage.objects;
create policy "Users can upload own audio"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'music'
    and (storage.foldername(name))[1] = 'users'
    and (storage.foldername(name))[2] = auth.uid()::text
    and (storage.foldername(name))[3] = 'music'
  );

drop policy if exists "Users can update own audio" on storage.objects;
create policy "Users can update own audio"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'music'
    and (storage.foldername(name))[1] = 'users'
    and (storage.foldername(name))[2] = auth.uid()::text
    and (storage.foldername(name))[3] = 'music'
  )
  with check (
    bucket_id = 'music'
    and (storage.foldername(name))[1] = 'users'
    and (storage.foldername(name))[2] = auth.uid()::text
    and (storage.foldername(name))[3] = 'music'
  );

drop policy if exists "Users can delete own audio" on storage.objects;
create policy "Users can delete own audio"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'music'
    and (storage.foldername(name))[1] = 'users'
    and (storage.foldername(name))[2] = auth.uid()::text
    and (storage.foldername(name))[3] = 'music'
  );
