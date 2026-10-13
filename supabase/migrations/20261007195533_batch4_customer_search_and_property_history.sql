-- Batch 4: two read-only admin RPCs for the Customer / Property Passport
-- surfaces.
--
-- WHY SECURITY INVOKER, UNLIKE THE BATCH 3 RPCS
--
-- Every table these functions read (customers, properties, ns_jobs,
-- ns_quotes, job_measurements, job_attachments, job_inspection_flags) has
-- RLS enabled with a single `admin_all` policy: ALL commands, role
-- `authenticated`, USING and WITH CHECK both is_admin(). Verified live
-- before writing this.
--
-- So SECURITY DEFINER is NOT required here, and using it would be actively
-- worse: it would bypass those policies and make this SQL solely
-- responsible for not leaking rows. Left as INVOKER (the default), RLS is
-- still applied inside the function, which means there is no query I can
-- write here that exposes a row the caller could not already read.
--
-- The explicit is_admin() guard is kept anyway, for two reasons: it turns a
-- non-admin's confusing empty result into a clear error, and it is the
-- backstop if any of those policies is ever loosened.
--
-- WHY THESE TWO FUNCTIONS EXIST AT ALL
--
-- Neither is a convenience wrapper. Each does something PostgREST cannot:
--   search_customers  - ORs a text match across customers AND their
--                       properties. PostgREST can filter one embedded
--                       resource but cannot OR across a parent and its
--                       child, the same limitation that made search_jobs
--                       necessary in Batch 3.
--   property_history  - gathers five job-scoped histories in one round
--                       trip. The alternative is N+1 from the browser.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No property-level measurement, photo, inspection or quote table. All of
-- those are job-scoped in this schema (none of them carries a property_id;
-- verified), so they are reported as HISTORY, reached through
-- ns_jobs.property_id, and each row keeps its job and date so it can never
-- read as a current property fact. Measurement versioning is explicitly out
-- of scope for this batch and no audit history is invented here.

/* ------------------------------------------------------- search_customers -- */

create or replace function public.search_customers(
  p_query  text    default null,
  p_sort   text    default 'name_asc',
  p_limit  integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_q      text    := nullif(btrim(coalesce(p_query, '')), '');
  v_like   text;
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total  integer;
  v_rows   jsonb;
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = 'insufficient_privilege';
  end if;

  v_like := case when v_q is null then null else '%' || v_q || '%' end;

  with matched as (
    select c.*
      from public.customers c
     where v_like is null
        or c.name  ilike v_like
        or c.email ilike v_like
        or c.phone ilike v_like
        -- The part PostgREST cannot express: find a customer by the
        -- address of any property they own.
        or exists (
             select 1 from public.properties p
              where p.customer_id = c.id
                and (p.address_line1 ilike v_like
                  or p.city         ilike v_like
                  or p.postal_code  ilike v_like)
           )
  ),
  enriched as (
    select
      m.id, m.name, m.email, m.phone, m.preferred_contact, m.created_at,
      (select count(*) from public.properties p where p.customer_id = m.id)   as property_count,
      (select count(*) from public.ns_jobs    j where j.customer_id = m.id)   as job_count,
      (select max(j.created_at) from public.ns_jobs j where j.customer_id = m.id) as last_job_at,
      -- A couple of addresses so a row is identifiable without opening it.
      coalesce((
        select jsonb_agg(x)
          from (
            select jsonb_build_object(
                     'id', p.id,
                     'address_line1', p.address_line1,
                     'city', p.city,
                     'postal_code', p.postal_code
                   ) as x
              from public.properties p
             where p.customer_id = m.id
             order by p.created_at
             limit 3
          ) s
      ), '[]'::jsonb) as properties
    from matched m
  ),
  /* The page is chosen by an explicit row_number, not by OFFSET over an
     unordered set. Without this the sort was applied only AFTER the slice,
     so which rows landed on page 2 was whatever order the planner happened
     to produce -- rows could repeat or vanish between pages. The window
     also yields the total in the same scan, so no second pass is needed. */
  ranked as (
    select e.*,
           row_number() over (
             order by
               case when p_sort = 'recent_job'   then e.last_job_at end desc nulls last,
               case when p_sort = 'created_desc' then e.created_at  end desc,
               lower(e.name) asc          -- also the 'name_asc' default
           ) as ord,
           count(*) over () as total_rows
      from enriched e
  )
  select coalesce(max(r.total_rows), 0),
         coalesce(jsonb_agg(to_jsonb(r) - 'ord' - 'total_rows' order by r.ord), '[]'::jsonb)
    into v_total, v_rows
    from ranked r
   where r.ord > v_offset and r.ord <= v_offset + v_limit;

  -- max() over an empty page is null, and a page past the end legitimately
  -- has no rows while the overall total is non-zero; recompute in that case
  -- rather than reporting a total of 0 and making the UI say "no matches".
  if v_total = 0 and v_offset > 0 then
    select count(*) into v_total
      from public.customers c
     where v_like is null
        or c.name  ilike v_like
        or c.email ilike v_like
        or c.phone ilike v_like
        or exists (
             select 1 from public.properties p
              where p.customer_id = c.id
                and (p.address_line1 ilike v_like
                  or p.city         ilike v_like
                  or p.postal_code  ilike v_like)
           );
  end if;

  return jsonb_build_object(
    'total',  coalesce(v_total, 0),
    'limit',  v_limit,
    'offset', v_offset,
    'sort',   coalesce(p_sort, 'name_asc'),
    'rows',   v_rows
  );
end;
$$;

/* ------------------------------------------------------- property_history -- */

create or replace function public.property_history(p_property_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_property jsonb;
  v_result   jsonb;
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = 'insufficient_privilege';
  end if;

  if p_property_id is null then
    raise exception 'A property id is required.' using errcode = 'check_violation';
  end if;

  select to_jsonb(p) || jsonb_build_object(
           'customer',
           case when c.id is null then null else jsonb_build_object(
             'id', c.id, 'name', c.name, 'email', c.email,
             'phone', c.phone, 'preferred_contact', c.preferred_contact
           ) end
         )
    into v_property
    from public.properties p
    left join public.customers c on c.id = p.customer_id
   where p.id = p_property_id;

  -- RLS already limits what is visible; a null here means genuinely absent.
  if v_property is null then
    raise exception 'Property not found.' using errcode = 'no_data_found';
  end if;

  select jsonb_build_object(
    'property', v_property,

    /* Every history below hangs off ns_jobs.property_id, which is the only
       path from a property to any of this. Each row keeps its job and its
       date precisely so the UI cannot present it as a standing fact about
       the property. */

    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', j.id, 'reference', j.reference, 'title', j.title,
               'status', j.status, 'created_at', j.created_at,
               'scheduled_for', j.scheduled_for, 'completed_at', j.completed_at,
               'services', coalesce((
                 select jsonb_agg(distinct s.name)
                   from public.job_measurements jm
                   join public.services s on s.id = jm.service_id
                  where jm.job_id = j.id
               ), '[]'::jsonb)
             ) order by j.created_at desc)
        from public.ns_jobs j
       where j.property_id = p_property_id
    ), '[]'::jsonb),

    'quotes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', q.id, 'job_id', q.job_id, 'job_reference', j.reference,
               'version', q.version, 'status', q.status, 'total', q.total,
               'option_label', q.option_label,
               'created_at', q.created_at, 'sent_at', q.sent_at,
               'responded_at', q.responded_at
             ) order by q.created_at desc)
        from public.ns_quotes q
        join public.ns_jobs j on j.id = q.job_id
       where j.property_id = p_property_id
    ), '[]'::jsonb),

    'measurements', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'job_id', m.job_id, 'job_reference', j.reference,
               'service', s.name, 'service_key', s.key,
               'label', m.label, 'quantity', m.quantity, 'unit', m.unit,
               'section', sec.name,
               'review_required', m.review_required,
               'review_reason', m.review_reason,
               'created_at', m.created_at, 'updated_at', m.updated_at
             ) order by m.created_at desc)
        from public.job_measurements m
        join public.ns_jobs j on j.id = m.job_id
        left join public.services s on s.id = m.service_id
        left join public.job_sections sec on sec.id = m.section_id
       where j.property_id = p_property_id
    ), '[]'::jsonb),

    'inspections', coalesce((
      select jsonb_agg(jsonb_build_object(
               'job_id', f.job_id, 'job_reference', j.reference,
               'flag', fl.name, 'warning', fl.warning,
               -- job_inspection_flags stamps noted_at, NOT created_at.
               'note', f.note, 'noted_at', f.noted_at
             ) order by f.noted_at desc nulls last)
        from public.job_inspection_flags f
        join public.ns_jobs j on j.id = f.job_id
        left join public.inspection_flags fl on fl.id = f.flag_id
       where j.property_id = p_property_id
    ), '[]'::jsonb),

    /* Storage paths only -- both buckets are private (verified), so the
       browser must mint a signed URL per photo via the existing
       signedPhotoUrl(). No public URL is constructed anywhere. */
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'job_id', a.job_id, 'job_reference', j.reference,
               'request_id', a.request_id,
               'storage_path', a.storage_path, 'kind', a.kind,
               'caption', a.caption, 'elevation_tag', a.elevation_tag,
               'customer_visible', a.customer_visible,
               'created_at', a.created_at
             ) order by a.created_at desc)
        from public.job_attachments a
        join public.ns_jobs j on j.id = a.job_id
       where j.property_id = p_property_id
    ), '[]'::jsonb),

    'generated_at', now()
  ) into v_result;

  return v_result;
end;
$$;

/* ------------------------------------------------------------- grants -- */

-- REVOKE ... FROM anon is a no-op: execute access comes from Postgres's
-- default grant to PUBLIC, not from a grant to anon. This is the exact trap
-- Batch 3 fell into and had to fix in a follow-up migration; doing it right
-- the first time here.
revoke execute on function public.search_customers(text, text, integer, integer) from public;
revoke execute on function public.property_history(uuid) from public;

grant execute on function public.search_customers(text, text, integer, integer) to authenticated;
grant execute on function public.property_history(uuid) to authenticated;
