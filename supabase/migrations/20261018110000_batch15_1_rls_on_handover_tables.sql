-- ===========================================================================
-- Batch 15.1 CORRECTIVE: row-level security on the seven tables Batch 13.1
-- created without it.
--
-- WHAT THE RELEASE AUDIT FOUND, and it is a defect I shipped. Every table
-- from Batch 8.1 through 12.1 has RLS enabled with at least one policy. All
-- SEVEN tables Batch 13.1 added have RLS OFF and no policy at all, and five
-- of them grant SELECT to `authenticated`:
--
--   ns_completion_reports        the frozen customer documents
--   ns_evidence_publications     which photographs a customer may see
--   ns_handover_operations       every handover receipt
--   ns_customer_grant_reads      who opened what, and when
--   ns_document_access_tickets   outstanding file authorisations
--   ns_report_deliveries         what was queued, to whom, with what outcome
--   ns_payment_requests          the amounts asked for
--
-- WHY THAT MATTERS even though the RPCs are all scoped. In Supabase
-- `authenticated` is ANY signed-in user, not an admin. A grant with no
-- policy means a signed-in non-admin could read every customer's completion
-- report straight off the table, captions, totals and all -- around the
-- outside of the capability, the scope and the publication decision that
-- 13.1 spends four migrations enforcing. The table-level grant was the hole
-- in a story about not having holes.
--
-- WHY IT WAS NOT CAUGHT. 13.1's own suite asserted the grants it meant to
-- set (`has_table_privilege('anon', …) = false`) and never asked whether a
-- logged-in non-admin was contained. The grant was right; the containment
-- behind it was missing, and a test that only checks what it built cannot
-- see what every other batch had that this one did not. The audit found it
-- by comparing this chain's tables against each other rather than against
-- their own expectations -- `docs/release/pending-migration-audit.md`,
-- "Tables with row-level security OFF".
--
-- THE SHAPE IS THE HOUSE ONE, not a new idea: RLS enabled, one
-- `for select to authenticated using (…)` policy per table, scoped by the
-- same predicate the matching RPC already uses, and writes left to the
-- security-definer functions. A crew sees what it could already ask for; an
-- owner sees everything; a signed-in stranger sees nothing.
--
-- `ns_customer_grants` has no SELECT grant at all (13.1 §11, token hashes),
-- so it was never exposed -- but RLS goes on it too, because "safe because
-- nobody granted it" is one careless `grant select` away from false.
--
-- NOT APPLIED ANYWHERE. Thirty-first pending migration.
-- ===========================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'public.ns_completion_reports',
    'public.ns_evidence_publications',
    'public.ns_handover_operations',
    'public.ns_customer_grants',
    'public.ns_customer_grant_reads',
    'public.ns_document_access_tickets',
    'public.ns_report_deliveries',
    'public.ns_payment_requests']
  loop
    execute format('alter table %s enable row level security', t);
  end loop;
end
$$;

do $$
begin
  /* A REPORT is readable by whoever may work its job -- the same rule
     job_completion_reports() already applies, so the table and the RPC
     cannot disagree. */
  drop policy if exists ns_completion_reports_read on public.ns_completion_reports;
  create policy ns_completion_reports_read on public.ns_completion_reports
    for select to authenticated using (public.ns_can_work_job(job_id));

  drop policy if exists ns_evidence_publications_read on public.ns_evidence_publications;
  create policy ns_evidence_publications_read on public.ns_evidence_publications
    for select to authenticated using (public.ns_can_work_job(job_id));

  /* THE OWNER'S OWN RECORDS. A receipt ledger, a grant list, an issued
     ticket, a delivery and a payment request are all the owner's view of
     the business: 13.1 makes every one of their writers owner-only, and a
     crew has no screen that reads them. `is_owner()` rather than
     `is_admin()`, deliberately -- this is the one place where being less
     generous than the rest of the schema is right. */
  drop policy if exists ns_handover_operations_read on public.ns_handover_operations;
  create policy ns_handover_operations_read on public.ns_handover_operations
    for select to authenticated using (public.is_owner());

  drop policy if exists ns_customer_grants_read on public.ns_customer_grants;
  create policy ns_customer_grants_read on public.ns_customer_grants
    for select to authenticated using (public.is_owner());

  drop policy if exists ns_customer_grant_reads_read on public.ns_customer_grant_reads;
  create policy ns_customer_grant_reads_read on public.ns_customer_grant_reads
    for select to authenticated using (public.is_owner());

  drop policy if exists ns_document_access_tickets_read on public.ns_document_access_tickets;
  create policy ns_document_access_tickets_read on public.ns_document_access_tickets
    for select to authenticated using (public.is_owner());

  drop policy if exists ns_report_deliveries_read on public.ns_report_deliveries;
  create policy ns_report_deliveries_read on public.ns_report_deliveries
    for select to authenticated using (public.is_owner());

  drop policy if exists ns_payment_requests_read on public.ns_payment_requests;
  create policy ns_payment_requests_read on public.ns_payment_requests
    for select to authenticated using (public.is_owner());
end
$$;

/* WHY THE CUSTOMER'S OWN READ IS UNAFFECTED. get_customer_report(),
   list_customer_documents() and request_customer_document() are SECURITY
   DEFINER and run as the owner of the function, so RLS on these tables does
   not stand between a capability-holding customer and their own document.
   The anon role still has no table grant and no policy, which is the point:
   the ONLY anon path is the three functions. */

/* ===================================================================== */
/* assertions                                                            */
/* ===================================================================== */

do $$
declare
  t text;
  v_missing text[] := '{}';
begin
  foreach t in array array[
    'public.ns_completion_reports',
    'public.ns_evidence_publications',
    'public.ns_handover_operations',
    'public.ns_customer_grants',
    'public.ns_customer_grant_reads',
    'public.ns_document_access_tickets',
    'public.ns_report_deliveries',
    'public.ns_payment_requests']
  loop
    if not (select relrowsecurity from pg_class where oid = t::regclass) then
      v_missing := v_missing || (t || ' has RLS off');
    end if;
    if not exists (select 1 from pg_policy where polrelid = t::regclass) then
      v_missing := v_missing || (t || ' has no policy');
    end if;
    -- And a re-run must not stack policies.
    if (select count(*) from pg_policy where polrelid = t::regclass) > 1 then
      v_missing := v_missing || (t || ' has more than one policy');
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'batch15.1 RLS corrective incomplete: %',
      array_to_string(v_missing, '; ');
  end if;

  -- Still no anon table grant anywhere in the handover set: the customer's
  -- route is the three definer functions and nothing else.
  foreach t in array array[
    'public.ns_completion_reports', 'public.ns_customer_grants',
    'public.ns_document_access_tickets', 'public.ns_report_deliveries',
    'public.ns_payment_requests']
  loop
    if has_table_privilege('anon', t::regclass, 'select') then
      raise exception 'anon can select %', t;
    end if;
  end loop;

  -- The three customer reads must still be anon-executable, or the customer
  -- page is dead and this corrective broke the thing it was protecting.
  if not has_function_privilege('anon',
       'public.get_customer_report(text,uuid)', 'execute') then
    raise exception 'anon lost execute on get_customer_report';
  end if;
end
$$;
