-- ===========================================================================
-- Batch 12.1, part 2: how to get in, what to watch for, and where the work
-- actually is.
--
-- WHAT IS REUSED. `properties.access_note` already exists and the field
-- console already reads it through the authorised `getJob` path (Codex's
-- 10.2 handoff relies on exactly that). It is NOT duplicated here. This
-- file adds the things that column cannot hold:
--
--   * a hazard, which is a different sentence from an entrance instruction
--     and must not be buried in the same free-text blob;
--   * an internal note and an access CODE, which are ours and never the
--     customer's;
--   * a customer-facing sentence, which is the only one that may ever
--     appear on a customer surface;
--   * defined work zones, which are drawings with a declared coordinate
--     space -- not surveyed boundaries and not a geofence.
--
-- THE AUTHORISATION DECISION, stated because it is the whole point of §3.
-- A UI filter is not authorisation. So the private columns are not granted
-- to `authenticated` AT ALL: there is no column-level SELECT for them, and
-- the only way to read them is get_property_access(), which checks that the
-- caller is the owner or crews a vehicle with work at that property. A
-- crew that is not working the place cannot read its code through the new
-- function, through the table, or through any view in this file.
--
-- Column grants are issued the only way that works in PostgreSQL: REVOKE
-- the table-level SELECT first, then GRANT the columns. A column REVOKE
-- against a table-level grant does nothing at all (it warns and carries on),
-- which is the trap the 9.1 corrective hit on ns_rental_set_events.
--
-- NOT APPLIED ANYWHERE.
-- ===========================================================================

/* ===================================================================== */
/* 1. who may see a property's working details                            */
/* ===================================================================== */

/** Whether the caller may see the working details of a property: the
 *  entrance, the hazards, the codes, the zones.
 *
 *  An owner may. A crew may when the property has work on the vehicle it
 *  crews -- on ANY date, because a crew preparing tomorrow needs tonight's
 *  gate code, not only today's. With one active vehicle an unassigned job
 *  counts, by the same one-vehicle rule the load plan uses; with two it
 *  does not, because then nobody has said which car is going.
 *
 *  Deliberately NOT "any admin": the customers/properties tables carry a
 *  single admin_all policy, which is right for a name and an address and
 *  wrong for a key-safe code. */
create or replace function public.ns_can_see_property(p_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not public.is_admin() then false
    when public.is_owner() then true
    when p_property_id is null then false
    else exists (
      select 1
        from public.ns_jobs j
        left join public.ns_job_vehicle_assignments a on a.job_id = j.id
       where j.property_id = p_property_id
         and (
           a.location_id = public.current_crew_vehicle()
           or (a.job_id is null
               and public.current_crew_vehicle() is not null
               and (select count(*) from public.ns_stock_locations
                     where kind = 'vehicle' and active) = 1)))
  end
$$;

/* ===================================================================== */
/* 2. the access record                                                   */
/* ===================================================================== */

create table if not exists public.ns_property_access (
  property_id   uuid primary key references public.properties(id) on delete cascade,

  -- CREW-VISIBLE WORKING DETAIL. Separate columns because they are separate
  -- sentences: "round the side, gate is unlatched" and "the dog is loose
  -- after 4pm" must not be one paragraph somebody skims.
  entrance_note text,
  hazard_note   text,
  parking_note  text,

  -- OURS, NEVER THEIRS. internal_note is for the office and the crew;
  -- access_code is a key. Neither is granted to `authenticated` at the
  -- column level -- see §5 -- so the only read path is the scoped function.
  internal_note text,
  access_code   text,

  -- THE ONLY CUSTOMER-FACING FIELD in this table. If a sentence should
  -- reach a customer it lives here and nowhere else, so "is this safe to
  -- send" is answered by which column it is in rather than by judgement at
  -- send time.
  customer_note text,

  -- Bumped by every accepted write, so a second editor is refused rather
  -- than silently overwriting the first.
  lock_version  integer not null default 1,

  updated_by    uuid references auth.users(id),
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),

  constraint ns_property_access_lock_positive check (lock_version >= 1)
);

comment on table public.ns_property_access is
  'Working details for a property that properties.access_note cannot hold: '
  'hazards and parking separately from the entrance, an internal note and '
  'an access code that are never customer-facing, and the one sentence that '
  'is. properties.access_note is unchanged and still the entrance note the '
  'field console already reads.';

comment on column public.ns_property_access.access_code is
  'PRIVATE. No column-level SELECT is granted to authenticated; read it '
  'through get_property_access(), which checks that the caller owns the '
  'business or crews a vehicle with work at this property.';

/* ===================================================================== */
/* 3. work zones                                                          */
/* ===================================================================== */

/** Are these points a usable drawing in the space they claim?
 *
 *  IMMUTABLE because a CHECK constraint may only call an immutable
 *  function, and this one looks at nothing but its arguments.
 *
 *  geographic -- real latitude/longitude, so it can be put on a map.
 *  image      -- fractions of a NAMED image, 0..1 on each axis, so it
 *                scales to whatever size the renderer draws and cannot be
 *                mistaken for a position on the earth.
 *
 *  Three points minimum: two points are a line, and a line is not a zone. */
create or replace function public.ns_zone_points_valid(
  p_space text, p_points jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_points is null or jsonb_typeof(p_points) <> 'array' then false
    when jsonb_array_length(p_points) < 3 then false
    when p_space = 'geographic' then not exists (
      select 1 from jsonb_array_elements(p_points) e
       where jsonb_typeof(e -> 'lat') <> 'number'
          or jsonb_typeof(e -> 'lng') <> 'number'
          or (e ->> 'lat')::numeric not between -90 and 90
          or (e ->> 'lng')::numeric not between -180 and 180)
    when p_space = 'image' then not exists (
      select 1 from jsonb_array_elements(p_points) e
       where jsonb_typeof(e -> 'x') <> 'number'
          or jsonb_typeof(e -> 'y') <> 'number'
          or (e ->> 'x')::numeric not between 0 and 1
          or (e ->> 'y')::numeric not between 0 and 1)
    else false
  end
$$;

create table if not exists public.ns_property_work_zones (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,

  label         text not null,
  kind          text not null,

  -- WHICH SPACE THE NUMBERS ARE IN. An unanchored drawing must not be able
  -- to pass itself off as geography, so the space is declared and the
  -- points are validated against it.
  space         text not null,
  points        jsonb not null,

  -- Required for, and only allowed for, the image space: a drawing on a
  -- photo is meaningless without saying which photo.
  image_source  text,

  note          text,

  -- A DRAWING IS NOT A SURVEY. One value, so the data can never claim
  -- otherwise; a future surveyed source would be a new value and a new
  -- conversation.
  source        text not null default 'owner_drawn',

  retired_at    timestamptz,
  retired_by    uuid references auth.users(id),
  retired_reason text,

  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id),
  updated_at    timestamptz not null default now(),
  lock_version  integer not null default 1,

  constraint ns_zone_kind_known check (kind in (
    'work_area', 'hazard', 'parking', 'access_path')),
  constraint ns_zone_space_known check (space in ('geographic', 'image')),
  constraint ns_zone_source_known check (source = 'owner_drawn'),
  constraint ns_zone_points_ok check (public.ns_zone_points_valid(space, points)),
  constraint ns_zone_image_needs_a_source check (
    (space = 'image') = (image_source is not null)),
  constraint ns_zone_label_present check (btrim(label) <> ''),
  constraint ns_zone_retired_has_a_reason check (
    (retired_at is null) = (retired_reason is null))
);

create index if not exists ns_property_work_zones_property_idx
  on public.ns_property_work_zones (property_id)
  where retired_at is null;

comment on table public.ns_property_work_zones is
  'Owner-drawn zones for a property: where the work is, what to avoid, '
  'where to park. NOT a surveyed boundary and NOT a geofence -- nothing in '
  'this system triggers on entering one. Geographic zones are real '
  'lat/lng; image zones are 0..1 fractions of a named image and say so.';

/* ===================================================================== */
/* 4. the reads                                                           */
/* ===================================================================== */

/** Everything a dispatcher or an assigned crew needs about getting in and
 *  finding the work.
 *
 *  `coordinates_state` is explicit: a property with no latitude/longitude
 *  is MISSING, not 0,0 and not the middle of the city. */
create or replace function public.get_property_access(p_property_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_prop record;
  v_acc  public.ns_property_access;
begin
  if not public.is_admin() then
    raise exception 'get_property_access is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.ns_can_see_property(p_property_id) then
    raise exception
      'That property has no work on your vehicle, so its access details are '
      'not yours to read.'
      using errcode = 'insufficient_privilege';
  end if;

  select p.id, p.address_line1, p.city, p.access_note, p.latitude, p.longitude
    into v_prop
    from public.properties p where p.id = p_property_id;
  if not found then
    raise exception 'No such property %', p_property_id
      using errcode = 'no_data_found';
  end if;

  select * into v_acc from public.ns_property_access
   where property_id = p_property_id;

  return jsonb_build_object(
    'property_id',   p_property_id,
    'address_line1', v_prop.address_line1,
    'city',          v_prop.city,

    -- The existing column, read from where it already lives.
    'access_note',   v_prop.access_note,

    'coordinates', case
      when v_prop.latitude is null or v_prop.longitude is null then
        jsonb_build_object('state', 'missing', 'lat', null, 'lng', null)
      else
        jsonb_build_object('state', 'known',
          'lat', v_prop.latitude, 'lng', v_prop.longitude) end,

    -- Null when nobody has filled it in, which is different from an empty
    -- string somebody saved on purpose.
    'access', case when v_acc.property_id is null then null else jsonb_build_object(
      'entrance_note', v_acc.entrance_note,
      'hazard_note',   v_acc.hazard_note,
      'parking_note',  v_acc.parking_note,
      'internal_note', v_acc.internal_note,
      'access_code',   v_acc.access_code,
      'customer_note', v_acc.customer_note,
      'lock_version',  v_acc.lock_version,
      'updated_at',    v_acc.updated_at) end,

    'zones', coalesce((
      select jsonb_agg(jsonb_build_object(
               'zone_id',      z.id,
               'label',        z.label,
               'kind',         z.kind,
               'space',        z.space,
               'points',       z.points,
               'image_source', z.image_source,
               'note',         z.note,
               'source',       z.source,
               'lock_version', z.lock_version)
             order by z.kind, z.label)
        from public.ns_property_work_zones z
       where z.property_id = p_property_id and z.retired_at is null), '[]'::jsonb));
end
$$;

/** The customer-safe subset, as a view so there is one definition of
 *  "safe to show a customer" rather than a judgement at each call site.
 *  No anon grant: the customer portal is 13.1's, and inventing its
 *  authorisation here would be inventing the portal. */
create or replace view public.ns_property_customer_notes as
  select a.property_id, a.customer_note, a.updated_at
    from public.ns_property_access a
   where a.customer_note is not null and btrim(a.customer_note) <> '';

comment on view public.ns_property_customer_notes is
  'The ONLY property instruction surface intended for a customer: the '
  'customer_note column and nothing else. No anon grant exists; the '
  'customer-facing read is Batch 13.1''s to define.';

/* ===================================================================== */
/* 5. the mutations                                                       */
/* ===================================================================== */

/** Write a property's working details.
 *
 *  Every field is passed every time, because a partial update with nulls
 *  meaning "leave alone" cannot express "clear this". `p_expected_version`
 *  is how a second editor is refused. */
create or replace function public.set_property_access(
  p_client_operation_id text,
  p_property_id         uuid,
  p_entrance_note       text default null,
  p_hazard_note         text default null,
  p_parking_note        text default null,
  p_internal_note       text default null,
  p_access_code         text default null,
  p_customer_note       text default null,
  p_expected_version    integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print   text;
  v_replay  jsonb;
  v_acc     public.ns_property_access;
  v_receipt jsonb;
begin
  if not public.is_owner() then
    raise exception
      'Access codes and customer-facing notes are the owner''s to write. A '
      'crew reports what it found; it does not rewrite the record.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'property_id',   p_property_id,
    'entrance_note', p_entrance_note,
    'hazard_note',   p_hazard_note,
    'parking_note',  p_parking_note,
    'internal_note', p_internal_note,
    'access_code',   p_access_code,
    'customer_note', p_customer_note,
    'expected_version', p_expected_version));

  v_replay := public.ns_dispatch_replay_guard(
    p_client_operation_id, 'property_access', v_print);
  if v_replay is not null then return v_replay; end if;

  if not exists (select 1 from public.properties where id = p_property_id) then
    raise exception 'No such property %', p_property_id
      using errcode = 'no_data_found';
  end if;

  select * into v_acc from public.ns_property_access
   where property_id = p_property_id for update;

  if found then
    if p_expected_version is not null and p_expected_version <> v_acc.lock_version then
      raise exception
        'These details were edited by somebody else (you had version %, it '
        'is now %). Reload before saving.', p_expected_version, v_acc.lock_version
        using errcode = 'check_violation';
    end if;
    update public.ns_property_access
       set entrance_note = p_entrance_note,
           hazard_note   = p_hazard_note,
           parking_note  = p_parking_note,
           internal_note = p_internal_note,
           access_code   = p_access_code,
           customer_note = p_customer_note,
           lock_version  = lock_version + 1,
           updated_by    = auth.uid(),
           updated_at    = now()
     where property_id = p_property_id
    returning * into v_acc;
  else
    if p_expected_version is not null and p_expected_version <> 0 then
      raise exception
        'These details do not exist yet, so there is no version % to '
        'replace. Send 0 or nothing for a first save.', p_expected_version
        using errcode = 'check_violation';
    end if;
    insert into public.ns_property_access
      (property_id, entrance_note, hazard_note, parking_note, internal_note,
       access_code, customer_note, updated_by)
    values
      (p_property_id, p_entrance_note, p_hazard_note, p_parking_note,
       p_internal_note, p_access_code, p_customer_note, auth.uid())
    returning * into v_acc;
  end if;

  -- THE RECEIPT DOES NOT ECHO THE CODE. A receipt is logged, replayed and
  -- rendered; a key does not belong in all three. Whether one is on record
  -- is a different fact from what it is.
  v_receipt := jsonb_build_object(
    'property_id',  p_property_id,
    'lock_version', v_acc.lock_version,
    'updated_at',   v_acc.updated_at,
    'replayed',     false,
    'has_access_code', v_acc.access_code is not null,
    'has_internal_note', v_acc.internal_note is not null,
    'has_customer_note', v_acc.customer_note is not null);

  insert into public.ns_dispatch_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'property_access', null, null, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/** Create or replace a work zone.
 *
 *  p_zone_id null creates; non-null replaces, with the version check. The
 *  points are validated by the CHECK, so a bad drawing is refused by the
 *  database rather than by the screen that drew it. */
create or replace function public.save_property_work_zone(
  p_client_operation_id text,
  p_property_id         uuid,
  p_label               text,
  p_kind                text,
  p_space               text,
  p_points              jsonb,
  p_image_source        text default null,
  p_note                text default null,
  p_zone_id             uuid default null,
  p_expected_version    integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print   text;
  v_replay  jsonb;
  v_zone    public.ns_property_work_zones;
  v_receipt jsonb;
begin
  if not public.is_owner() then
    raise exception 'Work zones are the owner''s to draw.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if not public.ns_zone_points_valid(p_space, p_points) then
    raise exception
      'Those points are not a zone in the % space. A zone needs at least '
      'three points; geographic points are lat/lng within range, image '
      'points are 0..1 fractions of the named image.', coalesce(p_space, 'given')
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'property_id',  p_property_id,
    'zone_id',      p_zone_id,
    'label',        p_label,
    'kind',         p_kind,
    'space',        p_space,
    'points',       p_points,
    'image_source', p_image_source,
    'note',         p_note,
    'expected_version', p_expected_version));

  v_replay := public.ns_dispatch_replay_guard(
    p_client_operation_id, 'work_zone', v_print);
  if v_replay is not null then return v_replay; end if;

  if p_zone_id is null then
    insert into public.ns_property_work_zones
      (property_id, label, kind, space, points, image_source, note,
       created_by, updated_by)
    values
      (p_property_id, btrim(p_label), p_kind, p_space, p_points,
       p_image_source, p_note, auth.uid(), auth.uid())
    returning * into v_zone;
  else
    select * into v_zone from public.ns_property_work_zones
     where id = p_zone_id for update;
    if not found then
      raise exception 'No such work zone %', p_zone_id
        using errcode = 'no_data_found';
    end if;
    if v_zone.retired_at is not null then
      raise exception
        'Zone "%" was retired. Draw a new one rather than reviving it: the '
        'retired one is the record of what was there.', v_zone.label
        using errcode = 'check_violation';
    end if;
    if p_expected_version is not null and p_expected_version <> v_zone.lock_version then
      raise exception
        'That zone was edited by somebody else (you had version %, it is '
        'now %). Reload before saving.', p_expected_version, v_zone.lock_version
        using errcode = 'check_violation';
    end if;
    update public.ns_property_work_zones
       set label = btrim(p_label), kind = p_kind, space = p_space,
           points = p_points, image_source = p_image_source, note = p_note,
           lock_version = lock_version + 1,
           updated_by = auth.uid(), updated_at = now()
     where id = p_zone_id
    returning * into v_zone;
  end if;

  v_receipt := jsonb_build_object(
    'zone_id',      v_zone.id,
    'property_id',  v_zone.property_id,
    'label',        v_zone.label,
    'kind',         v_zone.kind,
    'space',        v_zone.space,
    'points',       v_zone.points,
    'image_source', v_zone.image_source,
    'source',       v_zone.source,
    'lock_version', v_zone.lock_version,
    'replayed',     false,
    -- Said in the receipt as well as the comment, because this is the
    -- thing somebody will be tempted to forget.
    'is_surveyed_boundary', false);

  insert into public.ns_dispatch_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'work_zone', null, null, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/** Retire a zone. Not a delete: what the owner drew, and when it stopped
 *  applying, is history worth keeping. */
create or replace function public.retire_property_work_zone(
  p_client_operation_id text,
  p_zone_id             uuid,
  p_reason              text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print   text;
  v_replay  jsonb;
  v_zone    public.ns_property_work_zones;
  v_receipt jsonb;
begin
  if not public.is_owner() then
    raise exception 'Work zones are the owner''s to retire.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why the zone no longer applies'
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'zone_id', p_zone_id, 'reason', btrim(p_reason), 'retire', true));
  v_replay := public.ns_dispatch_replay_guard(
    p_client_operation_id, 'work_zone', v_print);
  if v_replay is not null then return v_replay; end if;

  update public.ns_property_work_zones
     set retired_at = now(), retired_by = auth.uid(),
         retired_reason = btrim(p_reason),
         lock_version = lock_version + 1
   where id = p_zone_id and retired_at is null
  returning * into v_zone;
  if not found then
    raise exception 'No such live work zone %', p_zone_id
      using errcode = 'no_data_found';
  end if;

  v_receipt := jsonb_build_object(
    'zone_id', v_zone.id, 'property_id', v_zone.property_id,
    'retired_at', v_zone.retired_at, 'reason', v_zone.retired_reason,
    'replayed', false);

  insert into public.ns_dispatch_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'work_zone', null, null, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/* ===================================================================== */
/* 6. RLS, column grants and assertions                                   */
/* ===================================================================== */

alter table public.ns_property_access enable row level security;
alter table public.ns_property_work_zones enable row level security;

do $$
begin
  execute 'drop policy if exists ns_property_access_read on public.ns_property_access';
  execute 'create policy ns_property_access_read on public.ns_property_access
             for select to authenticated
             using (public.ns_can_see_property(property_id))';
  execute 'drop policy if exists ns_property_zones_read on public.ns_property_work_zones';
  execute 'create policy ns_property_zones_read on public.ns_property_work_zones
             for select to authenticated
             using (public.ns_can_see_property(property_id))';
end
$$;

/* THE COLUMN GRANT, done the only way that works.
   `revoke select (access_code) ...` against a TABLE-level grant does
   nothing in PostgreSQL -- it warns "no privileges could be revoked" and
   leaves the table grant in place. So: revoke the table SELECT, then grant
   the columns that may be read directly. internal_note and access_code are
   absent from that list on purpose; get_property_access() is their only
   read path and it checks scope. */
do $$
begin
  execute 'revoke all on public.ns_property_access from public';
  execute 'revoke all on public.ns_property_access from anon';
  execute 'revoke all on public.ns_property_access from authenticated';
  execute 'grant select (property_id, entrance_note, hazard_note, parking_note,
                         customer_note, lock_version, updated_at, created_at)
             on public.ns_property_access to authenticated';
  execute 'grant all on public.ns_property_access to service_role';

  execute 'revoke all on public.ns_property_work_zones from public';
  execute 'revoke all on public.ns_property_work_zones from anon';
  execute 'grant select on public.ns_property_work_zones to authenticated';
  execute 'grant all on public.ns_property_work_zones to service_role';

  execute 'revoke all on public.ns_property_customer_notes from public';
  execute 'revoke all on public.ns_property_customer_notes from anon';
  execute 'grant select on public.ns_property_customer_notes to authenticated';
  execute 'grant all on public.ns_property_customer_notes to service_role';
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ns_can_see_property(uuid)',
    'public.ns_zone_points_valid(text,jsonb)',
    'public.get_property_access(uuid)',
    'public.set_property_access(text,uuid,text,text,text,text,text,text,integer)',
    'public.save_property_work_zone(text,uuid,text,text,text,jsonb,text,text,uuid,integer)',
    'public.retire_property_work_zone(text,uuid,text)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.get_property_access(uuid)',
    'public.set_property_access(text,uuid,text,text,text,text,text,text,integer)',
    'public.save_property_work_zone(text,uuid,text,text,text,jsonb,text,text,uuid,integer)'
  ]
  loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception 'anon can execute %, which it must not', f;
    end if;
  end loop;

  -- THE PRIVATE COLUMNS ARE PRIVATE, asserted with has_column_privilege
  -- rather than by trying a select: the table owner bypasses grants, so a
  -- successful read here would prove nothing.
  foreach f in array array['access_code', 'internal_note']
  loop
    if has_column_privilege('authenticated', 'public.ns_property_access', f, 'select') then
      raise exception
        'authenticated can read ns_property_access.% directly, so the '
        'scoped function is not the only path to it', f;
    end if;
    if has_column_privilege('anon', 'public.ns_property_access', f, 'select') then
      raise exception 'anon can read ns_property_access.%', f;
    end if;
  end loop;

  -- And the crew-visible ones still are, or the field console breaks.
  if not has_column_privilege('authenticated', 'public.ns_property_access',
                              'entrance_note', 'select') then
    raise exception 'authenticated lost its read of the entrance note';
  end if;

  foreach f in array array[
    'public.ns_property_access', 'public.ns_property_work_zones']
  loop
    if has_table_privilege('authenticated', f, 'insert')
       or has_table_privilege('authenticated', f, 'update')
       or has_table_privilege('authenticated', f, 'delete') then
      raise exception
        'authenticated can write % directly, so the version check and the '
        'owner-only rule could be bypassed', f;
    end if;
  end loop;
end
$$;
