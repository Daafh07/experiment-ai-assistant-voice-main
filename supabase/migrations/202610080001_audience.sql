-- Run in the Supabase SQL editor as postgres. Only this app's server may
-- call the RPC functions; no audience tables are exposed through the API.
begin;

create schema if not exists ayla_private;
revoke all on schema ayla_private from public, anon, authenticated, service_role;

create table if not exists ayla_private.audience_sessions (
  session text primary key,
  expires_at timestamptz not null
);
create table if not exists ayla_private.audience_questions (
  id bigint generated always as identity primary key,
  session text not null references ayla_private.audience_sessions(session) on delete cascade,
  text text not null check (char_length(text) between 1 and 200),
  name text not null default '' check (char_length(name) <= 40)
);
create index if not exists audience_questions_session_id on ayla_private.audience_questions(session, id);
create table if not exists ayla_private.audience_clients (
  session text not null references ayla_private.audience_sessions(session) on delete cascade,
  client text not null,
  last_sent_at timestamptz not null,
  primary key (session, client)
);
create table if not exists ayla_private.audience_ips (
  session text not null references ayla_private.audience_sessions(session) on delete cascade,
  ip_hash text not null,
  started_at timestamptz not null,
  count integer not null,
  primary key (session, ip_hash)
);

alter table ayla_private.audience_sessions enable row level security;
alter table ayla_private.audience_questions enable row level security;
alter table ayla_private.audience_clients enable row level security;
alter table ayla_private.audience_ips enable row level security;
revoke all on all tables in schema ayla_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema ayla_private from public, anon, authenticated, service_role;

create or replace function public.ayla_audience_submit(
  p_session text, p_client text, p_ip text, p_text text, p_name text
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz;
begin
  if p_session is null or p_session !~ '^[a-f0-9]{64}$'
    or p_client is null or p_client !~ '^[a-f0-9]{32}$'
    or p_ip is null or p_ip !~ '^[a-f0-9]{64}$'
    or p_text is null or char_length(btrim(p_text)) not between 1 and 200
    or p_name is null or char_length(p_name) > 40 then
    raise exception 'Invalid audience question' using errcode = '22023';
  end if;
  -- All operations in a session take this same transaction lock.
  perform pg_advisory_xact_lock(hashtextextended(p_session, 0));
  v_now := clock_timestamp();
  delete from ayla_private.audience_sessions where session = p_session and expires_at <= v_now;
  if exists (select 1 from ayla_private.audience_clients
    where session = p_session and client = p_client and last_sent_at > v_now - interval '10 seconds') then
    return 'rate';
  end if;
  if exists (select 1 from ayla_private.audience_ips
    where session = p_session and ip_hash = p_ip and started_at > v_now - interval '1 minute' and count >= 60) then
    return 'rate';
  end if;
  if (select count(*) from ayla_private.audience_questions where session = p_session) >= 50 then
    return 'full';
  end if;
  insert into ayla_private.audience_sessions values (p_session, v_now + interval '4 hours')
    on conflict (session) do update set expires_at = excluded.expires_at;
  insert into ayla_private.audience_questions(session, text, name) values (p_session, btrim(p_text), p_name);
  insert into ayla_private.audience_clients values (p_session, p_client, v_now)
    on conflict (session, client) do update set last_sent_at = excluded.last_sent_at;
  insert into ayla_private.audience_ips values (p_session, p_ip, v_now, 1)
    on conflict (session, ip_hash) do update set
      count = case when ayla_private.audience_ips.started_at <= v_now - interval '1 minute' then 1 else ayla_private.audience_ips.count + 1 end,
      started_at = case when ayla_private.audience_ips.started_at <= v_now - interval '1 minute' then v_now else ayla_private.audience_ips.started_at end;
  return 'ok';
end;
$$;

create or replace function public.ayla_audience_state(p_session text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
  v_next jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_session, 0));
  delete from ayla_private.audience_sessions where session = p_session and expires_at <= clock_timestamp();
  select count(*) into v_count from ayla_private.audience_questions where session = p_session;
  select jsonb_build_object('id', id, 'text', text, 'name', name) into v_next
    from ayla_private.audience_questions where session = p_session order by id limit 1;
  return jsonb_build_object('count', v_count, 'next', v_next);
end;
$$;

create or replace function public.ayla_audience_take(p_session text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_question ayla_private.audience_questions%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_session, 0));
  delete from ayla_private.audience_sessions where session = p_session and expires_at <= clock_timestamp();
  select * into v_question from ayla_private.audience_questions where session = p_session order by id limit 1;
  if not found or v_question.id is distinct from p_id then return null; end if;
  delete from ayla_private.audience_questions where id = v_question.id;
  return jsonb_build_object('id', v_question.id, 'text', v_question.text, 'name', v_question.name);
end;
$$;

-- Scheduled cleanup removes expired data even when nobody opens the demo.
create or replace function ayla_private.cleanup_audience()
returns void language plpgsql security definer set search_path = '' as $$
declare v_session text;
begin
  for v_session in select session from ayla_private.audience_sessions where expires_at <= clock_timestamp() loop
    if pg_try_advisory_xact_lock(hashtextextended(v_session, 0)) then
      delete from ayla_private.audience_sessions where session = v_session and expires_at <= clock_timestamp();
    end if;
  end loop;
  delete from ayla_private.audience_clients where last_sent_at <= clock_timestamp() - interval '10 seconds';
  delete from ayla_private.audience_ips where started_at <= clock_timestamp() - interval '1 minute';
end;
$$;

revoke all on function public.ayla_audience_submit(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.ayla_audience_state(text) from public, anon, authenticated;
revoke all on function public.ayla_audience_take(text, bigint) from public, anon, authenticated;
revoke all on function ayla_private.cleanup_audience() from public, anon, authenticated, service_role;
grant execute on function public.ayla_audience_submit(text, text, text, text, text) to service_role;
grant execute on function public.ayla_audience_state(text) to service_role;
grant execute on function public.ayla_audience_take(text, bigint) to service_role;

commit;

-- Make newly created RPC functions visible to the Supabase Data API.
notify pgrst, 'reload schema';
