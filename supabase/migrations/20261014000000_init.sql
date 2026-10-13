-- Video Enhancer: initial schema (SPEC v2.1 "Data model").
-- Single-owner tool; every row is still scoped by owner_id and protected by RLS.

-- ---------------------------------------------------------------- tables

create table public.assets (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  object_key  text not null,
  filename    text not null,
  size_bytes  bigint not null check (size_bytes >= 0),
  state       text not null default 'UPLOADING'
              check (state in ('UPLOADING', 'READY', 'DELETED')),
  client_meta jsonb not null default '{}'::jsonb,  -- from <video> in the browser (UX only)
  probe       jsonb,                               -- ffprobe result from Colab (authoritative)
  created_at  timestamptz not null default now()
);

create table public.jobs (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  asset_id         uuid not null references public.assets (id) on delete cascade,
  preset_id        text not null,
  params           jsonb not null default '{}'::jsonb,
  state            text not null default 'QUEUED'
                   check (state in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  attempt_id       uuid,
  attempt_count    int not null default 0,
  cancel_requested boolean not null default false,
  stage            text,
  processed_frames int,
  total_frames     int,
  heartbeat_at     timestamptz,
  output_key       text,
  output_meta      jsonb,
  error_code       text,
  error_message    text,
  worker_info      jsonb,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

create table public.worker_tokens (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  token_sha256 text not null,                      -- hex digest; the raw token is never stored
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

-- --------------------------------------------------------------- indexes

create index jobs_state_created_at_idx     on public.jobs (state, created_at);
create index jobs_owner_created_at_idx     on public.jobs (owner_id, created_at desc);
create index jobs_asset_id_idx             on public.jobs (asset_id);
create index assets_owner_created_at_idx   on public.assets (owner_id, created_at desc);
create unique index worker_tokens_token_sha256_key on public.worker_tokens (token_sha256);

-- ------------------------------------------------------------------- RLS

alter table public.assets        enable row level security;
alter table public.jobs          enable row level security;
alter table public.worker_tokens enable row level security;

-- anon gets nothing at all (no grants, no policies).
revoke all on public.assets, public.jobs, public.worker_tokens from anon;

create policy assets_select_own on public.assets
  for select to authenticated using ((select auth.uid()) = owner_id);
create policy assets_insert_own on public.assets
  for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy assets_update_own on public.assets
  for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy assets_delete_own on public.assets
  for delete to authenticated using ((select auth.uid()) = owner_id);

create policy jobs_select_own on public.jobs
  for select to authenticated using ((select auth.uid()) = owner_id);
create policy jobs_insert_own on public.jobs
  for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy jobs_update_own on public.jobs
  for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy jobs_delete_own on public.jobs
  for delete to authenticated using ((select auth.uid()) = owner_id);

-- worker_tokens: no delete policy (tokens are revoked, not deleted).
create policy worker_tokens_select_own on public.worker_tokens
  for select to authenticated using ((select auth.uid()) = owner_id);
create policy worker_tokens_insert_own on public.worker_tokens
  for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy worker_tokens_update_own on public.worker_tokens
  for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

-- ------------------------------------------------------------- claim_job

-- Atomically claims the oldest QUEUED job (across all owners: the operator's
-- worker serves every user) whose preset is in p_presets, FIFO by
-- (created_at, id). Returns the claimed row as a set: exactly one row when a job was
-- claimed, zero rows when nothing is claimable (PostgREST returns `[]`).
create function public.claim_job(p_presets text[])
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs;
begin
  select j.* into v_job
  from public.jobs as j
  where j.state = 'QUEUED'
    and j.preset_id = any (p_presets)
  order by j.created_at, j.id
  limit 1
  for update skip locked;

  if not found then
    return;
  end if;

  update public.jobs as j
  set state            = 'RUNNING',
      attempt_id       = pg_catalog.gen_random_uuid(),
      attempt_count    = j.attempt_count + 1,
      started_at       = coalesce(j.started_at, pg_catalog.now()),
      heartbeat_at     = pg_catalog.now(),
      stage            = null,
      processed_frames = null,
      total_frames     = null,
      error_code       = null,
      error_message    = null
  where j.id = v_job.id
  returning j.* into v_job;

  return next v_job;
  return;
end;
$$;

revoke execute on function public.claim_job(text[]) from public, anon, authenticated;
grant  execute on function public.claim_job(text[]) to service_role;
