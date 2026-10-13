import { supabase } from '../../../shared/supabase.js';
import { packsToUnits } from './inventory-math.js';

/* Single data-access boundary. Views never talk to Supabase directly, so the
   day this moves behind a Next.js route handler, only this file changes. */

function unwrap({ data, error }) {
  if (error) throw new Error(error.message || 'Request failed');
  return data;
}

/* ------------------------------------------------------------ reference -- */

export async function listServices({ onlyQuotable = false } = {}) {
  let q = supabase.from('services').select('*').eq('active', true).order('sort_order');
  if (onlyQuotable) q = q.eq('quotable', true);
  return unwrap(await q);
}

export async function listPricingRules() {
  return unwrap(await supabase
    .from('pricing_rules')
    .select('*, services(key,name,unit,category)')
    .is('effective_to', null)
    .order('service_id'));
}

export async function listModifiers() {
  return unwrap(await supabase
    .from('pricing_modifiers').select('*').eq('active', true)
    .order('group_key').order('sort_order'));
}

export async function listSiteFactors() {
  return unwrap(await supabase
    .from('site_factors').select('*').eq('active', true)
    .order('group_key').order('sort_order'));
}

export async function listInspectionFlags() {
  return unwrap(await supabase
    .from('inspection_flags').select('*').eq('active', true).order('sort_order'));
}

export async function listServiceFlagMap() {
  return unwrap(await supabase.from('service_inspection_flags').select('service_id,flag_id'));
}

export async function getSettings() {
  const rows = unwrap(await supabase.from('app_settings').select('key,value,description'));
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export async function updateSetting(key, value) {
  return unwrap(await supabase.from('app_settings')
    .update({ value }).eq('key', key).select().single());
}

export async function updatePricingRule(serviceId, { rate, minimum }) {
  // Close the current rule and open a new one, so quotes already sent keep
  // the basis they were built on.
  //
  // Two things here are load-bearing:
  //
  // 1. approval_status is carried forward explicitly. The column defaults to
  //    'approved' in the database, so inserting without it silently promotes
  //    a *provisional* rate to approved -- which would let a customer accept
  //    pricing nobody had signed off, defeating the whole provisional-pricing
  //    guard. Changing a number is not the same act as approving it.
  // 2. The close is undone if the insert fails. Otherwise the service is left
  //    with no open rule at all, and every job reads it as 'unpriced'.
  const open = unwrap(await supabase.from('pricing_rules')
    .select('id, approval_status')
    .eq('service_id', serviceId).is('effective_to', null)
    .order('effective_from', { ascending: false }));

  const previous = open[0] || null;

  if (previous) {
    unwrap(await supabase.from('pricing_rules')
      .update({ effective_to: new Date().toISOString() })
      .eq('service_id', serviceId).is('effective_to', null));
  }

  try {
    return unwrap(await supabase.from('pricing_rules')
      .insert({
        service_id: serviceId, rate, minimum,
        // No prior rule means this service was unpriced; a rate typed into
        // settings is not an approval, so it starts provisional.
        approval_status: previous ? previous.approval_status : 'provisional',
        note: 'Updated from admin settings'
      })
      .select().single());
  } catch (err) {
    if (previous) {
      await supabase.from('pricing_rules')
        .update({ effective_to: null }).eq('id', previous.id);
    }
    throw err;
  }
}

export async function setServiceActive(serviceId, patch) {
  return unwrap(await supabase.from('services')
    .update(patch).eq('id', serviceId).select().single());
}

/* ------------------------------------------------------------- customers -- */

/* NOTE ON WHY MOST OF THIS IS PLAIN TABLE ACCESS, NOT RPCs.
 *
 * customers and properties both carry a single RLS policy -- `admin_all`,
 * ALL commands, role authenticated, is_admin() for USING and WITH CHECK --
 * verified against the live database. So a direct .from('customers') read
 * is ALREADY admin-only, and wrapping it in a SECURITY DEFINER RPC would
 * bypass that policy and make the SQL solely responsible for not leaking
 * rows. The two RPCs below exist only where PostgREST genuinely cannot
 * express the query; everything else stays a plain, RLS-enforced query. */

/** Customer search. An RPC because it ORs a text match across customers AND
 *  the addresses of their properties -- PostgREST can filter one embedded
 *  resource but cannot OR across a parent and its child, the same wall
 *  search_jobs hit in Batch 3. */
export async function searchCustomers({
  query = null, sort = 'name_asc', limit = 50, offset = 0
} = {}) {
  return unwrap(await supabase.rpc('search_customers', {
    p_query: query || null, p_sort: sort, p_limit: limit, p_offset: offset
  }));
}

/** One customer with the properties they own. Properties come embedded
 *  rather than as a second round trip, and nothing here is aggregated --
 *  counts belong to the list, which already computes them server-side. */
export async function getCustomer(id) {
  return unwrap(await supabase.from('customers')
    .select('*, properties(id,address_line1,address_line2,city,province,postal_code,' +
            'property_type,access_note,created_at)')
    .eq('id', id).single());
}

/** Jobs for a customer, with their quotes embedded -- one query rather than
 *  one per job, which is the N+1 the brief calls out. */
export async function listCustomerJobs(customerId) {
  return unwrap(await supabase.from('ns_jobs')
    .select('id,reference,title,status,created_at,scheduled_for,completed_at,' +
            'properties(id,address_line1,city), ns_quotes(id,version,status,total)')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false }));
}

/** The customer's own request history -- real rows, not a reconstruction. */
export async function listCustomerRequests(customerId) {
  return unwrap(await supabase.from('quote_requests')
    .select('id,status,submitted_at,customer_message,preferred_schedule,' +
            'properties(id,address_line1,city)')
    .eq('customer_id', customerId)
    .order('submitted_at', { ascending: false }));
}

/** Plain update; RLS enforces admin. Callers pass only the fields the
 *  schema actually has -- see views/customers.js for which those are. */
export async function updateCustomer(id, patch) {
  return unwrap(await supabase.from('customers')
    .update(patch).eq('id', id).select().single());
}

/* ------------------------------------------------------------ properties -- */

/** Everything the Property Passport shows, in one round trip.
 *
 *  An RPC because the alternative is five separate job-scoped queries from
 *  the browser. Nothing it returns is property-scoped data that the schema
 *  does not have: measurements, photos, inspections and quotes are all
 *  job-scoped here, so each row arrives carrying its job and its date and
 *  the UI presents them as history rather than as standing property facts.
 *
 *  Photos come back as storage paths only -- both buckets are private, so
 *  the browser mints a signed URL per photo with signedPhotoUrl(). */
export async function propertyHistory(propertyId) {
  return unwrap(await supabase.rpc('property_history', { p_property_id: propertyId }));
}

/* -------------------------------------------------------------- requests -- */

export async function listRequests(status = 'new') {
  let q = supabase.from('quote_requests')
    .select('*, customers(name,email,phone,preferred_contact), properties(address_line1,city,postal_code), quote_request_services(other_label, services(name,key))')
    .order('submitted_at', { ascending: false });
  if (status && status !== 'all') q = q.eq('status', status);
  return unwrap(await q);
}

export async function getRequest(id) {
  return unwrap(await supabase.from('quote_requests')
    .select('*, customers(*), properties(*), quote_request_services(other_label, services(name,key))')
    .eq('id', id).single());
}

export async function convertRequestToJob(requestId) {
  return unwrap(await supabase.rpc('create_job_from_request', { p_request_id: requestId }));
}

export async function markRequestStatus(id, status) {
  const patch = { status };
  if (status === 'reviewed') patch.reviewed_at = new Date().toISOString();
  return unwrap(await supabase.from('quote_requests')
    .update(patch).eq('id', id).select().single());
}

/* ------------------------------------------------------------------ jobs -- */

/** Jobs list, searched/filtered/sorted server-side by the search_jobs RPC.
 *
 *  Replaces the old listJobs(), which fetched 200 unfiltered rows and offered
 *  no search at all. Text search has to span ns_jobs, customers and
 *  properties; PostgREST can filter on one embedded resource but cannot OR
 *  across two, so this is a function rather than a query builder.
 *
 *  The RPC also owns the definitions of today / upcoming / overdue /
 *  unscheduled, so a dashboard count and the list it links to are computed in
 *  the same place and cannot disagree.
 *
 *  Returns { total, limit, offset, sort, rows } where each row already
 *  carries its customer, property, requested services, latest quote and
 *  review-flag rollup -- no per-row follow-up queries. */
export async function searchJobs({
  query = null, statuses = null, scheduleBucket = null,
  scheduledFrom = null, scheduledTo = null, needsReview = false,
  sort = 'updated_desc', limit = 50, offset = 0
} = {}) {
  return unwrap(await supabase.rpc('search_jobs', {
    p_query: query || null,
    p_statuses: statuses && statuses.length ? statuses : null,
    p_schedule_bucket: scheduleBucket || null,
    p_scheduled_from: scheduledFrom || null,
    p_scheduled_to: scheduledTo || null,
    p_needs_review: !!needsReview,
    p_sort: sort,
    p_limit: limit,
    p_offset: offset
  }));
}

/** Field console's schedule screen: jobs booked for today, with enough on
 *  each row (customer, address, time, latest quoted value) to decide what
 *  to do next without opening the job. Quotes come embedded per job --
 *  the caller picks the highest version for "quoted value" since a job can
 *  carry several. */
export async function listTodaysVisits() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return unwrap(await supabase.from('ns_jobs')
    .select('*, customers(name,phone,email), properties(address_line1,city,postal_code,latitude,longitude), ' +
            'ns_quotes(id,version,total,status)')
    .gte('scheduled_for', start.toISOString()).lt('scheduled_for', end.toISOString())
    .order('scheduled_for'));
}

/** The next few days after today, so a tech can see what is coming without
 *  leaving the field console. Same shape as listTodaysVisits so the schedule
 *  screen can render either list with one row renderer. */
export async function listUpcomingVisits(days = 7) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const from = new Date(start); from.setDate(from.getDate() + 1);
  const to = new Date(start); to.setDate(to.getDate() + 1 + days);
  return unwrap(await supabase.from('ns_jobs')
    .select('*, customers(name,phone,email), properties(address_line1,city,postal_code,latitude,longitude), ' +
            'ns_quotes(id,version,total,status)')
    .gte('scheduled_for', from.toISOString()).lt('scheduled_for', to.toISOString())
    .order('scheduled_for'));
}

export async function getJob(id) {
  // The original request's service choices come along via the normalized
  // quote_request_services relationship, not a copy: ns_jobs.request_id ->
  // quote_requests -> quote_request_services. Nothing is duplicated onto the
  // job, so the request's history can't be overwritten by later quoting --
  // "what they asked for" and "what we're quoting" stay separate records.
  return unwrap(await supabase.from('ns_jobs')
    .select('*, customers(*), properties(*), ' +
            'quote_requests(id,submitted_at,customer_message,preferred_schedule,' +
            'quote_request_services(other_label, services(id,name,key)))')
    .eq('id', id).single());
}

/** Sets or clears the scheduled date/time. Separate from the generic
 *  updateJob patch so the one field the field console's schedule screen
 *  depends on has a named, validated entry point.
 *  `scheduledFor` is an ISO string, or null to clear. */
export async function scheduleJob(id, scheduledFor) {
  if (scheduledFor !== null) {
    const when = new Date(scheduledFor);
    if (Number.isNaN(when.getTime())) throw new Error('That is not a valid date and time.');
    scheduledFor = when.toISOString();
  }
  return unwrap(await supabase.from('ns_jobs')
    .update({ scheduled_for: scheduledFor }).eq('id', id).select().single());
}

/** Marks a job complete.
 *
 *  REWRITTEN IN BATCH 11.1, SAME SIGNATURE ON PURPOSE. This used to be a
 *  direct UPDATE:
 *
 *    update ns_jobs set status='completed', completed_at=now()
 *     where id=$1 and completed_at is null
 *
 *  which any admin could issue with no evidence, no material count and no
 *  way to tell a retry from a second completion. The database now refuses
 *  it (42501) and `complete_job_with_evidence` is the only way in. See
 *  docs/completion-evidence-contract-v1.md.
 *
 *  The RETURN SHAPE is deliberately unchanged -- `{ id, status,
 *  completed_at }`, or null -- because the field console calls this and that
 *  file belongs to the other track. A caller that only wants "mark it done"
 *  keeps working; a caller that wants the receipt calls
 *  completeJobWithEvidence() below and reads it.
 *
 *  The replay key is minted here rather than by the caller, which means a
 *  double tap in one session is two keys and the SECOND one is refused as a
 *  duplicate (23505) rather than silently accepted. That is the right
 *  outcome for a desk button; a client that needs true retry safety across
 *  a lost response passes its own key through completeJobWithEvidence. */
export async function completeJob(id) {
  const receipt = await completeJobWithEvidence({ jobId: id });
  if (!receipt || !receipt.job) return null;
  return {
    id: receipt.job.job_id,
    status: receipt.job.status,
    completed_at: receipt.job.completed_at
  };
}

/** The full completion call: the receipt, the readiness, the corrections and
 *  any additional work, as the contract's §5 describes it.
 *
 *  `jobLockVersion` and `policyVersion` are read here when the caller does
 *  not supply them, which is a convenience and not a substitute for the
 *  conflict check: the server still compares them, so a job somebody else
 *  moved between this read and the write is refused with 55000 rather than
 *  overwritten. A caller that already holds the versions it showed the
 *  operator should pass those, so the check is against what the human saw. */
export async function completeJobWithEvidence({
  clientOperationId, jobId, jobLockVersion, policyVersion,
  workFinishedAt, consumption = [], additionalWork = [], note
} = {}) {
  let lock = jobLockVersion;
  let policy = policyVersion;
  if (lock === undefined || lock === null || policy === undefined || policy === null) {
    const [job, version] = await Promise.all([
      unwrap(await supabase.from('ns_jobs')
        .select('id,lock_version').eq('id', jobId).single()),
      unwrap(await supabase.rpc('ns_evidence_policy_version'))
    ]);
    if (lock === undefined || lock === null) lock = job.lock_version;
    if (policy === undefined || policy === null) policy = version;
  }
  return unwrap(await supabase.rpc('complete_job_with_evidence', {
    p_client_operation_id: clientOperationId || newOperationId('done'),
    p_job_id: jobId,
    p_job_lock_version: lock,
    p_policy_version: policy,
    p_work_finished_at: workFinishedAt || null,
    p_consumption: consumption,
    p_additional_work: additionalWork,
    p_note: note || null
  }));
}

/* --------------------------------------------- evidence and completion -- */

/** What this job has to prove, per service, with unknown as its own state.
 *  `required_count` is NULL for an unconfigured service -- never 0, which
 *  would read as "nothing needed". */
export async function jobEvidenceRequirements(jobId) {
  return unwrap(await supabase.from('ns_job_evidence_requirements')
    .select('*').eq('job_id', jobId)
    .order('service_key').order('requirement'));
}

export async function jobEvidenceReadiness(jobId) {
  return unwrap(await supabase.from('ns_job_evidence_readiness')
    .select('*').eq('job_id', jobId).single());
}

export async function listJobEvidence(jobId) {
  return unwrap(await supabase.from('ns_job_evidence')
    .select('*').eq('job_id', jobId).order('received_at'));
}

/** Registers an already-uploaded attachment against a purpose.
 *
 *  By ATTACHMENT ID, never by a storage path: a caller that could name a
 *  path could name one it had not uploaded. The capture metadata is passed
 *  through as the device's CLAIM; the server records its own receipt time
 *  and actor separately and those are the ones a dispute turns on. */
export async function registerJobEvidence({
  clientOperationId, jobId, attachmentId, requirement, serviceKey,
  capturedAt, captureTimeState, lat, lon, accuracyM, gpsState,
  clientWatermark, source = 'field_console'
}) {
  return unwrap(await supabase.rpc('register_job_evidence', {
    p_client_operation_id: clientOperationId || newOperationId('ev'),
    p_job_id: jobId,
    p_attachment_id: attachmentId,
    p_requirement: requirement,
    p_service_key: serviceKey || null,
    p_captured_at: capturedAt || null,
    p_capture_time_state: captureTimeState || null,
    p_captured_lat: lat ?? null,
    p_captured_lon: lon ?? null,
    p_captured_accuracy_m: accuracyM ?? null,
    p_gps_state: gpsState || null,
    p_client_watermark: clientWatermark || null,
    p_source: source
  }));
}

export async function listEvidencePolicies() {
  return unwrap(await supabase.from('ns_evidence_policies')
    .select('*, services(key,name)').eq('active', true)
    .order('service_id').order('requirement'));
}

export async function evidencePolicyVersion() {
  return unwrap(await supabase.rpc('ns_evidence_policy_version'));
}

/** Owner only. Writing a policy IS confirming it: only a confirmed rule may
 *  be `blocking`, so nothing the system merely proposed can stop a crew. */
export async function setEvidencePolicy({
  clientOperationId, serviceKey, requirement, minCount = 1,
  coverage = 'per_job', requiresGeotag = false, enforcement = 'advisory', note
}) {
  return unwrap(await supabase.rpc('set_evidence_policy', {
    p_client_operation_id: clientOperationId || newOperationId('pol'),
    p_service_key: serviceKey,
    p_requirement: requirement,
    p_min_count: minCount,
    p_coverage: coverage,
    p_requires_geotag: requiresGeotag,
    p_enforcement: enforcement,
    p_note: note || null
  }));
}

export async function retireEvidencePolicy({ clientOperationId, serviceKey, requirement }) {
  return unwrap(await supabase.rpc('retire_evidence_policy', {
    p_client_operation_id: clientOperationId || newOperationId('pol'),
    p_service_key: serviceKey,
    p_requirement: requirement
  }));
}

export async function listEvidenceExceptions(jobId) {
  return unwrap(await supabase.from('ns_evidence_exceptions')
    .select('*, services(key,name)').eq('job_id', jobId)
    .order('authorised_at', { ascending: false }));
}

/** Owner only, and the reason is not optional: an exception without one is
 *  the absence of a rule rather than an exception to it. */
export async function authoriseEvidenceException({
  clientOperationId, jobId, reason, requirement, serviceKey
}) {
  return unwrap(await supabase.rpc('authorise_evidence_exception', {
    p_client_operation_id: clientOperationId || newOperationId('exc'),
    p_job_id: jobId,
    p_reason: reason,
    p_requirement: requirement || null,
    p_service_key: serviceKey || null
  }));
}

export async function listJobCompletions(jobId) {
  return unwrap(await supabase.from('ns_job_completions')
    .select('*').eq('job_id', jobId).order('accepted_at', { ascending: false }));
}

export async function completionReceipt(completionId) {
  return unwrap(await supabase.rpc('ns_completion_receipt', {
    p_completion_id: completionId, p_replayed: false
  }));
}

/** Owner only. Appends a reopen with a reason; the receipt is untouched. */
export async function reopenJobCompletion({ clientOperationId, completionId, reason }) {
  return unwrap(await supabase.rpc('reopen_job_completion', {
    p_client_operation_id: clientOperationId || newOperationId('re'),
    p_completion_id: completionId,
    p_reason: reason
  }));
}

/** Owner only. `quantity` is the SIGNED CHANGE TO THE RECORD: negative for
 *  what was over-reported, positive for what was missed. The ledger moves
 *  the other way, which the backend does -- do not pre-negate it here. */
export async function correctJobConsumption({
  clientOperationId, completionId, materialId, reason, quantity, level,
  locationCode = 'base', countPrecision = 'exact', corrects
}) {
  return unwrap(await supabase.rpc('correct_job_consumption', {
    p_client_operation_id: clientOperationId || newOperationId('fix'),
    p_completion_id: completionId,
    p_material_id: materialId,
    p_reason: reason,
    p_quantity: quantity ?? null,
    p_level: level || null,
    p_location_code: locationCode,
    p_count_precision: countPrecision,
    p_corrects: corrects || null
  }));
}

export async function listJobConsumptions(jobId) {
  return unwrap(await supabase.from('ns_job_consumptions')
    .select('*, ns_materials(name,unit)').eq('job_id', jobId)
    .order('recorded_at'));
}

export async function updateJob(id, patch) {
  return unwrap(await supabase.from('ns_jobs')
    .update(patch).eq('id', id).select().single());
}

/** Property Passport lives on properties.passport (jsonb) -- this is a
 *  plain generic patch, same shape as updateJob/updateQuote. */
export async function updateProperty(id, patch) {
  return unwrap(await supabase.from('properties')
    .update(patch).eq('id', id).select().single());
}

/** The whole dashboard in one round trip.
 *
 *  Replaces dashboardCounts(), which fetched EVERY ns_jobs row just to tally
 *  statuses in JS and still could not answer most of what the home screen
 *  needs. Counting server-side also means a failed load is a single clear
 *  failure rather than a screen of plausible-looking zeros.
 *
 *  Every field maps to a real column; see the migration for what was
 *  deliberately left out (no "viewed", no undateable supersession). */
export async function dashboardSummary() {
  return unwrap(await supabase.rpc('admin_dashboard_summary'));
}

/** Chronological activity for one job, assembled server-side from the
 *  timestamps that actually exist across nine tables. One query instead of
 *  nine. Returns normalized events; components/job-activity.js turns them
 *  into display rows. */
export async function jobActivity(jobId) {
  return unwrap(await supabase.rpc('job_activity', { p_job_id: jobId }));
}

/* -------------------------------------------------------------- sections -- */

export async function listSections(jobId) {
  return unwrap(await supabase.from('job_sections')
    .select('*').eq('job_id', jobId).order('sort_order'));
}

export async function createSection(jobId, section) {
  return unwrap(await supabase.from('job_sections')
    .insert({ job_id: jobId, ...section }).select().single());
}

export async function updateSection(id, patch) {
  return unwrap(await supabase.from('job_sections')
    .update(patch).eq('id', id).select().single());
}

export async function deleteSection(id) {
  return unwrap(await supabase.from('job_sections').delete().eq('id', id));
}

/* ---------------------------------------------------------- measurements -- */

export async function listMeasurements(jobId) {
  return unwrap(await supabase.from('job_measurements')
    .select('*, measurement_modifiers(modifier_id), job_measurement_addons(*)')
    .eq('job_id', jobId).order('sort_order'));
}

export async function createMeasurement(jobId, measurement) {
  return unwrap(await supabase.from('job_measurements')
    .insert({ job_id: jobId, ...measurement }).select().single());
}

export async function updateMeasurement(id, patch) {
  return unwrap(await supabase.from('job_measurements')
    .update(patch).eq('id', id).select().single());
}

export async function deleteMeasurement(id) {
  return unwrap(await supabase.from('job_measurements').delete().eq('id', id));
}

/** Replaces the modifier selection for one group without touching the others. */
export async function setMeasurementModifier(measurementId, groupModifierIds, newModifierId) {
  if (groupModifierIds.length) {
    unwrap(await supabase.from('measurement_modifiers')
      .delete().eq('measurement_id', measurementId).in('modifier_id', groupModifierIds));
  }
  if (newModifierId) {
    unwrap(await supabase.from('measurement_modifiers')
      .insert({ measurement_id: measurementId, modifier_id: newModifierId }));
  }
}

export async function addMeasurementAddon(measurementId, addon) {
  return unwrap(await supabase.from('job_measurement_addons')
    .insert({ measurement_id: measurementId, ...addon }).select().single());
}

export async function deleteMeasurementAddon(id) {
  return unwrap(await supabase.from('job_measurement_addons').delete().eq('id', id));
}

/* ------------------------------------------------------------ inspection -- */

export async function listJobFlags(jobId) {
  return unwrap(await supabase.from('job_inspection_flags')
    .select('flag_id,note').eq('job_id', jobId));
}

/** Toggles an inspection flag, optionally recording what was observed.
 *  job_inspection_flags.note has existed all along and nothing wrote it, so
 *  a tech could tick "Difficult access" but never say why. The PK is
 *  (job_id, flag_id), which is what makes the upsert safe to repeat. */
export async function setJobFlag(jobId, flagId, on, note) {
  if (on) {
    const row = { job_id: jobId, flag_id: flagId };
    // Only send `note` when the caller actually supplied one, so toggling a
    // flag on doesn't blank a note that is already there.
    if (note !== undefined) row.note = note || null;
    return unwrap(await supabase.from('job_inspection_flags')
      .upsert(row, { onConflict: 'job_id,flag_id' }));
  }
  return unwrap(await supabase.from('job_inspection_flags')
    .delete().eq('job_id', jobId).eq('flag_id', flagId));
}

/** Records an observation against an already-ticked flag. */
export async function setJobFlagNote(jobId, flagId, note) {
  return unwrap(await supabase.from('job_inspection_flags')
    .update({ note: note || null }).eq('job_id', jobId).eq('flag_id', flagId));
}

/* ----------------------------------------------------------- attachments -- */

export async function listAttachments(jobId) {
  return unwrap(await supabase.from('job_attachments')
    .select('*').eq('job_id', jobId).order('created_at'));
}

/** Private bucket: a short-lived signed URL is minted per view. Defaults to
 *  the customer-upload bucket for existing callers; the field console's own
 *  site photos live in the separate 'job-photos' bucket. */
/** Which bucket an attachment row's file actually lives in.
 *
 *  Customer uploads arrive through attach_request_photo into 'request-photos'
 *  and keep their request_id even after create_job_from_request reparents them
 *  onto the job. Staff captures from the field console go to 'job-photos' and
 *  never set one. Signing against the wrong bucket fails, which is why every
 *  field-captured photo used to render "Preview unavailable" on the desk job
 *  screen -- the one place the office actually reviews them. */
export function attachmentBucket(attachment) {
  return attachment?.request_id ? 'request-photos' : 'job-photos';
}

export async function signedPhotoUrl(storagePath, seconds = 900, bucket = 'request-photos') {
  const { data, error } = await supabase.storage
    .from(bucket).createSignedUrl(storagePath, seconds);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

/** Uploads a staff-captured site photo to the private 'job-photos' bucket
 *  and records it as a job_attachments row. kind is one of site_photo |
 *  before | after | damage | measurement | document. */
export async function uploadJobPhoto(jobId, file, { kind = 'site_photo', caption, elevationTag, issueFlag = false } = {}) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${jobId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('job-photos').upload(path, file, { contentType: file.type || 'image/jpeg' });
  if (uploadError) throw new Error(uploadError.message);

  return unwrap(await supabase.from('job_attachments').insert({
    job_id: jobId, storage_path: path, kind,
    caption: caption || null, elevation_tag: elevationTag || null,
    issue_flag: !!issueFlag, mime_type: file.type || null, size_bytes: file.size ?? null
  }).select().single());
}

export async function updateAttachment(id, patch) {
  return unwrap(await supabase.from('job_attachments').update(patch).eq('id', id).select().single());
}

export async function deleteAttachment(id) {
  return unwrap(await supabase.from('job_attachments').delete().eq('id', id));
}

/* ----------------------------------------------------------------- notes -- */

export async function listNotes(jobId) {
  return unwrap(await supabase.from('job_notes')
    .select('*').eq('job_id', jobId).order('created_at', { ascending: false }));
}

/** job_notes.visibility is a CHECK of exactly 'internal' | 'customer'.
 *  'customer' is the existing representation of a customer-facing note --
 *  completion-report.js already filters on it -- so there is no separate
 *  customer-notes field to add.
 *
 *  author_id references auth.users. admin_users holds only user_id and the
 *  client cannot read auth.users, so the author is stored but can only be
 *  rendered as "you" vs "another admin"; there is no name to display. */
export async function addNote(jobId, body, visibility = 'internal') {
  const text = (body || '').trim();
  if (!text) throw new Error('A note needs some text.');
  if (visibility !== 'internal' && visibility !== 'customer') {
    throw new Error(`Unknown note visibility: ${visibility}`);
  }
  const { data: { session } } = await supabase.auth.getSession();
  return unwrap(await supabase.from('job_notes')
    .insert({ job_id: jobId, body: text, visibility, author_id: session?.user?.id || null })
    .select().single());
}

/** The signed-in admin's auth user id, for telling "your note" from
 *  "another admin's note". There is no name available: job_notes.author_id
 *  references auth.users, which the browser client cannot read, and
 *  admin_users holds only user_id. */
export async function currentUserId() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id || null;
}

export async function deleteNote(id) {
  return unwrap(await supabase.from('job_notes').delete().eq('id', id));
}

/* --------------------------------------------------------------- pricing -- */

export async function calculatePricing(jobId) {
  return unwrap(await supabase.rpc('calculate_job_pricing', { p_job_id: jobId }));
}

/* ---------------------------------------------------------------- quotes -- */

export async function listQuotes(jobId) {
  // line items, adjustments and change orders must come with the quote --
  // the builder renders them, and selecting '*' alone silently produced an
  // empty-looking quote
  return unwrap(await supabase.from('ns_quotes')
    .select('*, quote_line_items(*), quote_adjustments(*), ns_change_orders(*)')
    .eq('job_id', jobId)
    .order('version', { ascending: false }));
}

export async function getQuote(id) {
  return unwrap(await supabase.from('ns_quotes')
    .select('*, quote_line_items(*), quote_adjustments(*), ns_jobs(*, customers(*), properties(*))')
    .eq('id', id).single());
}

export async function createQuoteFromCalculation(jobId, kind = 'final') {
  return unwrap(await supabase.rpc('create_quote_from_calculation', {
    p_job_id: jobId, p_kind: kind
  }));
}

/** One sibling of an option group (Phase C) -- measurementIds is an
 *  explicit subset of this job's job_measurements, never auto-derived. */
export async function createOptionQuote(jobId, optionGroupId, optionLabel, optionSortOrder, measurementIds, kind = 'final') {
  return unwrap(await supabase.rpc('create_option_quote', {
    p_job_id: jobId, p_option_group_id: optionGroupId, p_option_label: optionLabel,
    p_option_sort_order: optionSortOrder, p_measurement_ids: measurementIds, p_kind: kind
  }));
}

/** Sends every sibling in the group at once, in a single customer email --
 *  see mark_quote_sent's own guard for why sendQuote() refuses an
 *  option-group member directly. */
export async function sendOptionGroup(optionGroupId) {
  return unwrap(await supabase.rpc('send_option_group', { p_option_group_id: optionGroupId }));
}

export async function addAdjustment(quoteId, adjustment) {
  const row = unwrap(await supabase.from('quote_adjustments')
    .insert({ quote_id: quoteId, ...adjustment }).select().single());
  await recalcQuote(quoteId);
  return row;
}

export async function deleteAdjustment(id, quoteId) {
  unwrap(await supabase.from('quote_adjustments').delete().eq('id', id));
  await recalcQuote(quoteId);
}

export async function addManualLine(quoteId, line) {
  const row = unwrap(await supabase.from('quote_line_items')
    .insert({ quote_id: quoteId, source: 'manual', ...line }).select().single());
  await recalcQuote(quoteId);
  return row;
}

export async function deleteLine(id, quoteId) {
  unwrap(await supabase.from('quote_line_items').delete().eq('id', id));
  await recalcQuote(quoteId);
}

export async function recalcQuote(quoteId) {
  return unwrap(await supabase.rpc('recalculate_quote_totals', { p_quote_id: quoteId }));
}

export async function updateQuote(id, patch) {
  return unwrap(await supabase.from('ns_quotes')
    .update(patch).eq('id', id).select().single());
}

export async function sendQuote(id) {
  return unwrap(await supabase.rpc('mark_quote_sent', { p_quote_id: id }));
}

/** Clones a quote's pricing (line items + adjustments, copied verbatim) into
 *  a new draft version. Returns the new quote's id. */
export async function duplicateQuote(id) {
  return unwrap(await supabase.rpc('duplicate_quote', { p_quote_id: id }));
}

/* ------------------------------------------------------------ signatures -- */

/** Uploads the signature PNG under job-photos/<job>/signatures/... -- a
 *  distinct prefix, not a job_attachments row, because a signature isn't a
 *  tagged site photo, it's a field on the quote. That prefix is the one
 *  thing in this private bucket an anonymous quote.html reader can fetch
 *  (see the "public reads quote signatures" storage policy). Returns the
 *  storage path, not a URL -- see ns_quotes.signature_url's comment. */
export async function uploadSignature(jobId, pngBlob) {
  const path = `${jobId}/signatures/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const { error } = await supabase.storage
    .from('job-photos').upload(path, pngBlob, { contentType: 'image/png' });
  if (error) throw new Error(error.message);
  return path;
}

/** Records the signature and moves the quote to 'accepted' -- works whether
 *  the quote was ever emailed or not (signed live, same visit, is a
 *  complete path of its own). See save_quote_signature() for the exact
 *  state transition. */
export async function saveQuoteSignature(quoteId, signaturePath, signedByName) {
  return unwrap(await supabase.rpc('save_quote_signature', {
    p_quote_id: quoteId, p_signature_path: signaturePath, p_signed_by_name: signedByName
  }));
}

/* --------------------------------------------------------- change orders -- */

export async function listChangeOrders(quoteId) {
  return unwrap(await supabase.from('ns_change_orders')
    .select('*').eq('quote_id', quoteId).order('created_at'));
}

/** REWIRED IN BATCH 11.1. These three were direct table writes, which meant
 *  a crew could raise a paid change and approve it in two clicks. The table
 *  grants are gone; both steps are now owner-gated RPCs.
 *
 *  `addChangeOrder` keeps its signature for the desk screen, and keeps its
 *  two steps distinct underneath: a proposal with no price, then the
 *  owner's decision that sets the figure. Pass no amount and it stays
 *  unpriced, which is what a crew's observation is. */
export async function addChangeOrder(quoteId, { description, amount, jobId } = {}) {
  const proposal = await proposeAdditionalWork({ jobId, description });
  if (amount === undefined || amount === null || amount === '') {
    return { id: proposal.change_order_id, description, amount: null,
             status: 'proposed', pricing_state: 'unpriced' };
  }
  const decided = await decideChangeOrder({
    changeOrderId: proposal.change_order_id, decision: 'approved', amount
  });
  return { id: decided.change_order_id, description, amount: decided.amount,
           status: decided.status, pricing_state: 'priced' };
}

/** A crew may say the gutters need doing. It may not say what that is
 *  worth, so there is no amount here at all. */
export async function proposeAdditionalWork({ clientOperationId, jobId, description, note }) {
  return unwrap(await supabase.rpc('propose_additional_work', {
    p_client_operation_id: clientOperationId || newOperationId('aw'),
    p_job_id: jobId,
    p_description: description,
    p_note: note || null
  }));
}

/** Owner only. Approving sets the figure in the SAME transaction, so there
 *  is no window in which an approved change order has no price. Approving
 *  does NOT touch ns_quotes.total -- the caller sums approved amounts
 *  wherever a combined "quote + approved changes" figure is needed. */
export async function decideChangeOrder({
  clientOperationId, changeOrderId, decision, amount, reason
}) {
  return unwrap(await supabase.rpc('decide_change_order', {
    p_client_operation_id: clientOperationId || newOperationId('dec'),
    p_change_order_id: changeOrderId,
    p_decision: decision,
    p_amount: amount ?? null,
    p_reason: reason || null
  }));
}

/** Kept for the existing call sites. `approved` needs an amount now, which
 *  is the point: approved money with no figure is not money. */
export async function setChangeOrderStatus(id, status, { amount, reason } = {}) {
  return decideChangeOrder({ changeOrderId: id, decision: status, amount, reason });
}

/** DELETING IS GONE, and declining replaces it. A change order the customer
 *  may already have been told about should not vanish from the history; a
 *  declined one says what happened. The table has no DELETE grant either,
 *  so this is the only path. */
export async function declineChangeOrder(id, reason) {
  return decideChangeOrder({ changeOrderId: id, decision: 'declined', reason });
}

/* -------------------------------------------------------------- seasonal -- */

/** A customer's past quote for a seasonal (lighting) service, one per
 *  customer+service, so the renewals screen can offer "last winter you did
 *  X for them, want to re-quote it for this season" without re-deriving
 *  that from raw quote history inline. category is the services.category
 *  this counts as seasonal -- currently just 'lighting' (Christmas +
 *  permanent outdoor), since winter_property_care is an ongoing-season
 *  service that renews on a schedule, not a once-a-year re-quote. */
export async function listSeasonalQuoteHistory() {
  return unwrap(await supabase.from('ns_quotes')
    .select('id,version,status,total,created_at,sent_at,' +
            'ns_jobs(id,customer_id,property_id,customers(name,phone,email),properties(address_line1,city)),' +
            'quote_line_items(service_id,description,services(key,name,category))')
    .in('status', ['sent', 'accepted', 'declined', 'expired', 'superseded'])
    .order('created_at', { ascending: false })
    .limit(500));
}

/* -------------------------------------------------------- snow / winter --- */

export async function listSnowEvents() {
  return unwrap(await supabase.from('ns_snow_events').select('*').order('event_date', { ascending: false }));
}

export async function addSnowEvent({ eventDate, accumulationCm, notes }) {
  return unwrap(await supabase.from('ns_snow_events')
    .insert({ event_date: eventDate, accumulation_cm: accumulationCm ?? null, notes: notes || null })
    .select().single());
}

export async function deleteSnowEvent(id) {
  return unwrap(await supabase.from('ns_snow_events').delete().eq('id', id));
}

export async function listPropertyClears(eventId) {
  let q = supabase.from('ns_property_clears')
    .select('*, properties(address_line1,city)').order('cleared_at', { ascending: false });
  if (eventId) q = q.eq('event_id', eventId);
  return unwrap(await q);
}

export async function logPropertyClear({ propertyId, eventId, saltAppliedKg, notes }) {
  return unwrap(await supabase.from('ns_property_clears').insert({
    property_id: propertyId, event_id: eventId || null,
    salt_applied_kg: saltAppliedKg ?? null, notes: notes || null
  }).select().single());
}

/** Properties, for the "log a clear" picker -- deliberately simple (every
 *  property, not just ones with a past winter job) so a brand-new winter
 *  client can still be logged on their first clear. */
export async function listWinterProperties() {
  return unwrap(await supabase.from('properties')
    .select('id,address_line1,city,customers(name)')
    .order('address_line1').limit(500));
}

/* ------------------------------------------------------------- inventory -- */

/* Batch 8.1. Stock is read from the ns_material_stock VIEW, never summed in
   the browser: on-hand is the signed sum of an append-only ledger, and
   computing it here would mean fetching every movement ever posted. Writes
   go to ns_material_stock_moves as new rows -- a mistake is corrected by
   posting its reverse, never by editing or deleting a movement, which is
   what keeps a disputed shelf count explainable. */

export async function listSuppliers({ includeInactive = false } = {}) {
  let q = supabase.from('ns_suppliers').select('*').order('name');
  if (!includeInactive) q = q.eq('active', true);
  return unwrap(await q);
}

export async function createSupplier(patch) {
  return unwrap(await supabase.from('ns_suppliers').insert(patch).select().single());
}

export async function updateSupplier(id, patch) {
  return unwrap(await supabase.from('ns_suppliers')
    .update(patch).eq('id', id).select().single());
}

/** The catalogue joined to its derived on-hand figure. Two round trips
 *  rather than one view that also carries the supplier name, because the
 *  view is grouped by material and adding a join to it would mean another
 *  migration every time the catalogue grows a column. */
export async function listMaterials({ includeInactive = false } = {}) {
  const [materials, stock] = await Promise.all([
    (async () => {
      let q = supabase.from('ns_materials')
        .select('*, ns_suppliers(id,name)').order('category').order('name');
      if (!includeInactive) q = q.eq('active', true);
      return unwrap(await q);
    })(),
    unwrap(await supabase.from('ns_material_stock').select('*'))
  ]);
  const byId = new Map(stock.map((s) => [s.material_id, s]));
  return materials.map((m) => ({
    ...m,
    on_hand: Number(byId.get(m.id)?.on_hand ?? 0),
    needs_reorder: byId.get(m.id)?.needs_reorder ?? true,
    last_move_at: byId.get(m.id)?.last_move_at ?? null
  }));
}

export async function createMaterial(patch) {
  return unwrap(await supabase.from('ns_materials').insert(patch).select().single());
}

export async function updateMaterial(id, patch) {
  return unwrap(await supabase.from('ns_materials')
    .update(patch).eq('id', id).select().single());
}

export async function listStockMoves(materialId, limit = 50) {
  return unwrap(await supabase.from('ns_material_stock_moves')
    .select('*').eq('material_id', materialId)
    .order('occurred_at', { ascending: false }).limit(limit));
}

/* Operations contract v1. Direct INSERT on the ledger is revoked, so these
   two functions are the only way stock moves -- see
   docs/operations-contract-v1.md and the migration's own comment on why
   that revoke is what makes the guarantees real rather than advisory. */

/** A client-generated replay key. It has to be generated BEFORE the request
 *  and reused on retry, which is the whole point: the server never saw the
 *  first attempt, so only the caller can say "this is that same act". */
export function newOperationId(prefix = 'op') {
  const rand = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${rand}`;
}

/** One material at one location. `quantity` is a MAGNITUDE: the sign comes
 *  from `reason`, decided server-side, so a positive 'consumed' cannot add
 *  stock. 'adjustment' is the exception and keeps the sign it is given,
 *  because a negative correction has to be enterable at all. */
export async function postStockMovement({
  clientOperationId, materialId, locationCode = 'base', quantity, reason,
  note, jobId, purchaseOrderId, vehicleCode,
  condition = 'usable', countPrecision = 'exact'
}) {
  return unwrap(await supabase.rpc('post_stock_movement', {
    p_client_operation_id: clientOperationId || newOperationId('mv'),
    p_material_id: materialId,
    p_location_code: locationCode,
    p_quantity: quantity,
    p_reason: reason,
    p_note: note || null,
    p_job_id: jobId || null,
    p_purchase_order_id: purchaseOrderId || null,
    p_vehicle_code: vehicleCode || null,
    p_condition: condition,
    p_count_precision: countPrecision
  }));
}

/** Two conserving legs between two locations. Refused until the physical
 *  movement is confirmed -- a half-moved balance is the thing a crew cannot
 *  reconcile against a car. */
export async function postStockTransfer({
  clientOperationId, materialId, quantity, fromLocationCode, toLocationCode,
  confirmedPhysical = false, note, jobId
}) {
  return unwrap(await supabase.rpc('post_stock_transfer', {
    p_client_operation_id: clientOperationId || newOperationId('xf'),
    p_material_id: materialId,
    p_quantity: quantity,
    p_from_location_code: fromLocationCode,
    p_to_location_code: toLocationCode,
    p_confirmed_physical: confirmedPhysical,
    p_note: note || null,
    p_job_id: jobId || null
  }));
}

/* Reservations. A claim against a balance, not a movement -- see
   docs/operations-contract-v1.md. These reduce `available` and leave
   `on_hand` alone, which is why the inventory screens read `available`
   when asking "can we promise this" and `on_hand` when asking "what is
   physically there". */

export async function listReservations({ materialId, locationCode, status = 'held' } = {}) {
  let q = supabase.from('ns_stock_reservations')
    .select('*, ns_materials(id,name,sku,unit), ns_stock_locations(id,code,name)')
    .order('held_at', { ascending: false }).limit(200);
  if (materialId) q = q.eq('material_id', materialId);
  if (status) q = q.eq('status', status);
  const rows = unwrap(await q);
  return locationCode
    ? rows.filter((r) => r.ns_stock_locations?.code === locationCode)
    : rows;
}

export async function reserveStock({
  clientOperationId, materialId, locationCode = 'base', quantity, jobId, note, expiresAt
}) {
  return unwrap(await supabase.rpc('reserve_stock', {
    p_client_operation_id: clientOperationId || newOperationId('res'),
    p_material_id: materialId,
    p_location_code: locationCode,
    p_quantity: quantity,
    p_job_id: jobId || null,
    p_note: note || null,
    p_expires_at: expiresAt || null
  }));
}

export async function releaseStockReservation({ clientOperationId, reservationId, note }) {
  return unwrap(await supabase.rpc('release_stock_reservation', {
    p_client_operation_id: clientOperationId || newOperationId('rel'),
    p_reservation_id: reservationId,
    p_note: note || null
  }));
}

/** Closes the claim and posts the movement in ONE transaction, so stock is
 *  never counted as both reserved and issued. A partial consumption releases
 *  the remainder rather than leaving it committed. */
export async function consumeStockReservation({
  clientOperationId, reservationId, quantity, countPrecision = 'exact', note
}) {
  return unwrap(await supabase.rpc('consume_stock_reservation', {
    p_client_operation_id: clientOperationId || newOperationId('use'),
    p_reservation_id: reservationId,
    p_quantity: quantity ?? null,
    p_count_precision: countPrecision,
    p_note: note || null
  }));
}

/* Empty / Low / Enough, for supplies not worth counting. An observation
   that REPLACES the previous one, which is why this upserts rather than
   appending -- it is deliberately not in the movement ledger. */
export async function setMaterialLevel({ materialId, locationId, state, note }) {
  return unwrap(await supabase.from('ns_material_levels').upsert({
    material_id: materialId,
    location_id: locationId,
    state,
    note: note || null,
    checked_at: new Date().toISOString(),
    checked_by: await currentUserId()
  }, { onConflict: 'material_id,location_id' }).select().single());
}

export async function listCrewMembers() {
  return unwrap(await supabase.from('ns_crew_members')
    .select('*, ns_stock_locations(id,code,name)').order('role'));
}

export async function listStockLocations({ includeInactive = false } = {}) {
  let q = supabase.from('ns_stock_locations').select('*').order('sort_order');
  if (!includeInactive) q = q.eq('active', true);
  return unwrap(await q);
}

export async function listStockByLocation(materialId) {
  let q = supabase.from('ns_material_stock_by_location')
    .select('*').order('location_code');
  if (materialId) q = q.eq('material_id', materialId);
  return unwrap(await q);
}

export async function listPurchaseOrders({ status } = {}) {
  let q = supabase.from('ns_purchase_orders')
    .select('*, ns_suppliers(id,name), ns_purchase_order_lines(*, ns_materials(id,name,sku,unit,pack_quantity))')
    .order('created_at', { ascending: false }).limit(100);
  if (status) q = q.eq('status', status);
  return unwrap(await q);
}

export async function createPurchaseOrder(patch) {
  return unwrap(await supabase.from('ns_purchase_orders').insert({
    ...patch, created_by: await currentUserId()
  }).select().single());
}

export async function updatePurchaseOrder(id, patch) {
  return unwrap(await supabase.from('ns_purchase_orders')
    .update(patch).eq('id', id).select().single());
}

export async function addPurchaseOrderLine(purchaseOrderId, line) {
  return unwrap(await supabase.from('ns_purchase_order_lines')
    .insert({ purchase_order_id: purchaseOrderId, ...line }).select().single());
}

export async function updatePurchaseOrderLine(id, patch) {
  return unwrap(await supabase.from('ns_purchase_order_lines')
    .update(patch).eq('id', id).select().single());
}

export async function deletePurchaseOrderLine(id) {
  unwrap(await supabase.from('ns_purchase_order_lines').delete().eq('id', id));
}

/** Receiving is TWO writes that must both land: the line's received count,
 *  and a stock movement in material units. They are issued in that order so
 *  a failure after the first leaves a PO that under-reports its receipt --
 *  visible and correctable -- rather than stock on the shelf that no
 *  paperwork accounts for. There is no RPC for this yet; if the pair starts
 *  drifting in practice it belongs in one. */
export async function receivePurchaseOrderLine(line, packs, { locationCode = 'base' } = {}) {
  const units = packsToUnits(line.ns_materials, packs);
  if (!(units > 0)) throw new Error('Receive a positive number of packs.');

  await updatePurchaseOrderLine(line.id, {
    packs_received: Number(line.packs_received || 0) + Number(packs)
  });
  await postStockMovement({
    materialId: line.material_id,
    locationCode,
    quantity: units,
    reason: 'received',
    purchaseOrderId: line.purchase_order_id,
    note: `Received ${packs} pack(s) on PO`
  });
}

export async function listServiceMaterialUsage() {
  return unwrap(await supabase.from('ns_service_material_usage')
    .select('*, services(id,key,name,unit), ns_materials(id,name,sku,unit)')
    .order('service_id'));
}

export async function setServiceMaterialUsage(patch) {
  return unwrap(await supabase.from('ns_service_material_usage')
    .insert(patch).select().single());
}

export async function updateServiceMaterialUsage(id, patch) {
  return unwrap(await supabase.from('ns_service_material_usage')
    .update(patch).eq('id', id).select().single());
}

export async function deleteServiceMaterialUsage(id) {
  unwrap(await supabase.from('ns_service_material_usage').delete().eq('id', id));
}

/** Quantities only. This is not pricing and is not read by the quote path --
 *  see the RPC's own comment. */
export async function estimateJobMaterials(jobId, locationCode = null) {
  return unwrap(await supabase.rpc('estimate_job_materials', {
    p_job_id: jobId,
    p_location_code: locationCode
  }));
}

/* --------------------------------------- daily vehicle load planning ---- */

/* A plan RECOMMENDS; confirming it MOVES. Those are two calls on purpose,
 * and the quantities on a plan line are readings taken when it was built --
 * never a balance anything derives from. See docs/daily-load-contract-v1.md. */

export async function buildLoadPlan({ clientOperationId, locationCode, workDate, note }) {
  return unwrap(await supabase.rpc('build_load_plan', {
    p_client_operation_id: clientOperationId || newOperationId('plan'),
    p_location_code: locationCode,
    p_work_date: workDate,
    p_note: note || null
  }));
}

/** The live plan for a car and day, or null. Read rather than built, so
 *  opening the screen never creates a revision. */
/** The crew's read path, as the contract freezes it.
 *
 *  REWRITTEN IN THE 10.1 CORRECTIVE. This used to query ns_load_plan_view
 *  and build its own DTO, and that DTO had drifted from the contract: it
 *  dropped location_id, the plan note and the two counts, and it filtered
 *  closed plans out, so last night's closing count was unreadable. Codex's
 *  review of 1ffafc2 found all four. The shape now comes from
 *  get_load_plan(), which is the one thing the contract freezes, so the
 *  screen and the document cannot disagree again.
 *
 *  Returns the whole envelope -- `state`, `can_build`, `plan`, the counts
 *  and the day's visits -- not just the plan, because `state: 'none'` is a
 *  thing a screen has to be able to say. */
export async function getLoadPlan({ locationCode, workDate }) {
  return unwrap(await supabase.rpc('get_load_plan', {
    p_location_code: locationCode,
    p_work_date: workDate
  }));
}

/** The day's authorised visits and the vehicles this caller may read.
 *  Also returned inside getLoadPlan(), so a cold open is one round trip. */
export async function loadDaySummary({ locationCode, workDate }) {
  return unwrap(await supabase.rpc('ns_load_day_summary', {
    p_location_code: locationCode,
    p_work_date: workDate
  }));
}

export async function setManualKeep({
  clientOperationId, locationCode, workDate, materialId, keep = true, reason
}) {
  return unwrap(await supabase.rpc('set_manual_keep', {
    p_client_operation_id: clientOperationId || newOperationId('keep'),
    p_location_code: locationCode,
    p_work_date: workDate,
    p_material_id: materialId,
    p_keep: keep,
    p_reason: reason || null
  }));
}

/** `quantity` is required for a `carry_extra` of a counted material: an
 *  authorisation with no amount is not something a confirmation can act on,
 *  and before the 10.1 corrective one was accepted and then ignored. A set
 *  has no quantity and a level-tracked supply has no number, so both are
 *  exempt. A `skip_required` must not carry one. */
export async function authoriseLoadException({
  clientOperationId, locationCode, workDate, kind, reason, materialId,
  rentalSetId, quantity
}) {
  return unwrap(await supabase.rpc('authorise_load_exception', {
    p_client_operation_id: clientOperationId || newOperationId('exc'),
    p_location_code: locationCode,
    p_work_date: workDate,
    p_kind: kind,
    p_reason: reason,
    p_material_id: materialId || null,
    p_rental_set_id: rentalSetId || null,
    p_quantity: quantity ?? null
  }));
}

/** Posts the transfers.
 *
 *  THREE THINGS THE CALLER HAS TO QUOTE BACK, all from the plan it was
 *  showing when the operator pressed the button:
 *
 *   * `expectedRevision` -- somebody rebuilt the plan.
 *   * `expectedFingerprint` (the plan's `basis_fingerprint`) -- the day's
 *     schedule moved and nobody rebuilt it.
 *   * `expectedLinesFingerprint` -- a Manual Keep was set or cleared, or
 *     the owner authorised a departure, so what the plan RECOMMENDS changed
 *     while the screen was open. The revision and the basis both still
 *     match in that case, which is why it needs its own value.
 *
 *  The revision and the lines fingerprint are required by the backend
 *  (22023 if absent): a confirmation that cannot say what it saw cannot be
 *  checked. See docs/daily-load-contract-v1.md v2.1 §6. */
export async function confirmLoadPlan({
  clientOperationId, planId, expectedRevision, expectedFingerprint,
  expectedLinesFingerprint, note
}) {
  return unwrap(await supabase.rpc('confirm_load_plan', {
    p_client_operation_id: clientOperationId || newOperationId('conf'),
    p_plan_id: planId,
    p_expected_revision: expectedRevision ?? null,
    p_expected_fingerprint: expectedFingerprint || null,
    p_note: note || null,
    p_expected_lines_fingerprint: expectedLinesFingerprint || null
  }));
}

export async function reconcileDayEnd({
  clientOperationId, locationCode, workDate, lines, note
}) {
  return unwrap(await supabase.rpc('reconcile_day_end', {
    p_client_operation_id: clientOperationId || newOperationId('rec'),
    p_location_code: locationCode,
    p_work_date: workDate,
    p_lines: lines,
    p_note: note || null
  }));
}

/** Suggestions only: nothing here reserves, orders or moves anything. */
export async function nextDaySuggestions({ locationCode, workDate }) {
  return unwrap(await supabase.rpc('ns_next_day_suggestions', {
    p_location_code: locationCode,
    p_work_date: workDate
  }));
}

/* ------------------------------- permanent lighting: kits and pieces ---- */

/* Three rules this half of the API exists to keep:
 *   - a kit and its contents are never both available, so opening one is a
 *     single RPC and never two browser writes;
 *   - an offcut is a PIECE, so the screen asks for a length and the backend
 *     checks it against what the ledger says is there;
 *   - an unchecked product specification cannot reach a job plan. */

export async function listKitSheets() {
  return unwrap(await supabase.from('ns_kit_sheets')
    .select('*, ns_materials(id,name,sku,category,unit,spec_state), '
            + 'ns_kit_sheet_lines(id,material_id,quantity_per_kit,inclusion,note,'
            + 'ns_materials(id,name,unit))')
    .order('created_at', { ascending: false }).limit(200));
}

export async function createKitSheet(patch) {
  return unwrap(await supabase.from('ns_kit_sheets').insert(patch).select().single());
}

export async function updateKitSheet(id, patch) {
  return unwrap(await supabase.from('ns_kit_sheets')
    .update(patch).eq('id', id).select().single());
}

export async function addKitSheetLine(patch) {
  return unwrap(await supabase.from('ns_kit_sheet_lines').insert(patch).select().single());
}

export async function deleteKitSheetLine(id) {
  unwrap(await supabase.from('ns_kit_sheet_lines').delete().eq('id', id));
}

/** One transaction: the kit leaves stock as its components arrive. */
export async function openSealedKit({
  clientOperationId, kitMaterialId, locationCode = 'base', kitCount = 1, note
}) {
  return unwrap(await supabase.rpc('open_sealed_kit', {
    p_client_operation_id: clientOperationId || newOperationId('kit'),
    p_kit_material_id: kitMaterialId,
    p_location_code: locationCode,
    p_kit_count: kitCount,
    p_note: note || null
  }));
}

export async function listOffcuts({ materialId, locationCode, status = 'available' } = {}) {
  let q = supabase.from('ns_material_offcuts')
    .select('*, ns_materials(id,name,unit), ns_stock_locations(id,code,name)')
    .order('length', { ascending: false }).limit(300);
  if (materialId) q = q.eq('material_id', materialId);
  if (status) q = q.eq('status', status);
  const rows = unwrap(await q);
  return locationCode
    ? rows.filter((r) => r.ns_stock_locations?.code === locationCode)
    : rows;
}

/** Pieces, not just a total. `longest_runnable` is the number that decides
 *  whether a run can be cut at all; a total cannot answer that. */
export async function listPieceAvailability({ locationCode, materialId } = {}) {
  let q = supabase.from('ns_material_piece_availability').order('name').limit(500);
  if (locationCode) q = q.eq('location_code', locationCode);
  if (materialId) q = q.eq('material_id', materialId);
  return unwrap(await q);
}

export async function recordOffcut({
  clientOperationId, materialId, locationCode = 'base', length, fromJobId, note
}) {
  return unwrap(await supabase.rpc('record_offcut', {
    p_client_operation_id: clientOperationId || newOperationId('cut'),
    p_material_id: materialId,
    p_location_code: locationCode,
    p_length: length,
    p_from_job_id: fromJobId || null,
    p_note: note || null
  }));
}

export async function consumeOffcut({ clientOperationId, offcutId, jobId, note }) {
  return unwrap(await supabase.rpc('consume_offcut', {
    p_client_operation_id: clientOperationId || newOperationId('use'),
    p_offcut_id: offcutId,
    p_job_id: jobId || null,
    p_note: note || null
  }));
}

export async function scrapOffcut({ clientOperationId, offcutId, note }) {
  return unwrap(await supabase.rpc('scrap_offcut', {
    p_client_operation_id: clientOperationId || newOperationId('scrap'),
    p_offcut_id: offcutId,
    p_note: note || null
  }));
}

/* ------------------------------------------- job material sheets ------- */

export async function getJobMaterialSheet(jobId) {
  const rows = unwrap(await supabase.from('ns_job_material_sheets')
    .select('*, ns_job_material_sheet_lines(id,material_id,quantity,selected,source,'
            + 'note,reservation_id,ns_materials(id,name,unit,category,spec_state))')
    .eq('job_id', jobId)
    .in('status', ['draft', 'reviewed', 'reserved'])
    .limit(1));
  return rows[0] || null;
}

export async function createJobMaterialSheet(jobId) {
  return unwrap(await supabase.from('ns_job_material_sheets')
    .insert({ job_id: jobId, created_by: await currentUserId() }).select().single());
}

export async function selectJobMaterial({
  clientOperationId, sheetId, materialId, quantity, selected = true,
  source = 'selected', serviceId, note
}) {
  return unwrap(await supabase.rpc('select_job_material', {
    p_client_operation_id: clientOperationId || newOperationId('sel'),
    p_sheet_id: sheetId,
    p_material_id: materialId,
    p_quantity: quantity,
    p_selected: selected,
    p_source: source,
    p_service_id: serviceId || null,
    p_note: note || null
  }));
}

export async function reviewJobMaterialSheet({ clientOperationId, sheetId, note }) {
  return unwrap(await supabase.rpc('review_job_material_sheet', {
    p_client_operation_id: clientOperationId || newOperationId('rev'),
    p_sheet_id: sheetId,
    p_note: note || null
  }));
}

/** Reserves the SELECTED lines and only those. */
export async function reserveJobMaterialSheet({
  clientOperationId, sheetId, locationCode = 'base', note
}) {
  return unwrap(await supabase.rpc('reserve_job_material_sheet', {
    p_client_operation_id: clientOperationId || newOperationId('res'),
    p_sheet_id: sheetId,
    p_location_code: locationCode,
    p_note: note || null
  }));
}

/** Candidates WITH the job's measurements and no ranking: the
 *  manufacturer's layout decides, not this list. */
export async function heatingKitCandidates(jobId) {
  return unwrap(await supabase.rpc('ns_heating_kit_candidates', { p_job_id: jobId }));
}

/* ------------------------------------- company-owned Christmas sets ----- */

/* A set belongs to Nova Shield. A customer gets seasonal USE of it, which is
 * an assignment -- temporary, and kept afterwards as history. So nothing
 * here writes ns_rental_sets or ns_seasonal_assignments directly: every
 * change goes through a seasonal RPC that moves the set and its assignment
 * together, under a replay key, with the conflict and inspection rules
 * enforced in the database. A direct write would walk past all of it, and
 * the grants are set up so that it cannot. */

/** Availability, with the reason it is unavailable. Reads the view rather
 *  than the table so the screen and the RPCs agree on what "available"
 *  means -- there is one definition and this is it. */
export async function listSeasonalSets({ status, availableOnly } = {}) {
  let q = supabase.from('ns_seasonal_set_availability').order('set_code').limit(500);
  if (status) q = q.eq('status', status);
  if (availableOnly) q = q.eq('available_for_reuse', true);
  return unwrap(await q);
}

/** The assignment rows for a set, newest season first. This is the history
 *  the business runs on: who had it, when it went up, what came back. */
export async function listSeasonalAssignments({ setId, openOnly } = {}) {
  let q = supabase.from('ns_seasonal_assignments')
    .select('*, customers(id,name), properties(id,address_line1,city)')
    .order('season_year', { ascending: false }).limit(500);
  if (setId) q = q.eq('set_id', setId);
  // OPEN, not active: an assignment still holds the set after the crew has
  // taken it down, because release is what finishes a season. A screen that
  // only fetched 'assigned' and 'installed' would show a recovered set with
  // no assignment and no way to release it.
  if (openOnly) q = q.in('status', ['assigned', 'installed', 'removed']);
  return unwrap(await q);
}

/** Columns, not `*`. Batch 11.1 took `client_operation_id` off the
 *  authenticated read surface at column level (seasonal contract v1.2 §8),
 *  so `select=*` now asks for a column the role cannot see and the whole
 *  query fails. Naming the columns also means a column added later does not
 *  silently start arriving in the browser. */
const RENTAL_SET_EVENT_COLUMNS =
  'id,rental_set_id,event,job_id,customer_id,assignment_id,' +
  'occurred_at,note,created_at,created_by';

export async function listRentalSetEvents(rentalSetId, limit = 50) {
  return unwrap(await supabase.from('ns_rental_set_events')
    .select(RENTAL_SET_EVENT_COLUMNS).eq('rental_set_id', rentalSetId)
    .order('occurred_at', { ascending: false }).limit(limit));
}

export async function registerSeasonalSet({
  clientOperationId, setCode, runType, colour, linearFt, locationCode,
  materialId, buildQuantity, note
}) {
  return unwrap(await supabase.rpc('register_seasonal_set', {
    p_client_operation_id: clientOperationId || newOperationId('set'),
    p_set_code: setCode,
    p_run_type: runType || null,
    p_colour: colour || null,
    p_linear_ft: linearFt ?? null,
    p_location_code: locationCode || null,
    p_material_id: materialId || null,
    p_build_quantity: buildQuantity ?? null,
    p_note: note || null
  }));
}

export async function assignSeasonalSet({
  clientOperationId, setId, customerId, seasonYear, propertyId, jobId, note
}) {
  return unwrap(await supabase.rpc('assign_seasonal_set', {
    p_client_operation_id: clientOperationId || newOperationId('asg'),
    p_set_id: setId,
    p_customer_id: customerId,
    p_season_year: seasonYear,
    p_property_id: propertyId || null,
    p_job_id: jobId || null,
    p_note: note || null
  }));
}

export async function cancelSeasonalAssignment({ clientOperationId, assignmentId, note }) {
  return unwrap(await supabase.rpc('cancel_seasonal_assignment', {
    p_client_operation_id: clientOperationId || newOperationId('cxl'),
    p_assignment_id: assignmentId,
    p_note: note || null
  }));
}

export async function installSeasonalSet({
  clientOperationId, assignmentId, installedAt, jobId, note
}) {
  return unwrap(await supabase.rpc('install_seasonal_set', {
    p_client_operation_id: clientOperationId || newOperationId('ins'),
    p_assignment_id: assignmentId,
    p_installed_at: installedAt || null,
    p_job_id: jobId || null,
    p_note: note || null
  }));
}

/** `recoveryCondition` is what the crew SAW, not a verdict: the set goes
 *  back to uninspected whatever they report, so last season's inspection
 *  can never make this season's return look offerable. */
export async function recoverSeasonalSet({
  clientOperationId, assignmentId, recoveryCondition, locationCode, removedAt, note
}) {
  return unwrap(await supabase.rpc('recover_seasonal_set', {
    p_client_operation_id: clientOperationId || newOperationId('rec'),
    p_assignment_id: assignmentId,
    p_recovery_condition: recoveryCondition,
    p_location_code: locationCode || null,
    p_removed_at: removedAt || null,
    p_note: note || null
  }));
}

export async function inspectSeasonalSet({ clientOperationId, setId, condition, note }) {
  return unwrap(await supabase.rpc('inspect_seasonal_set', {
    p_client_operation_id: clientOperationId || newOperationId('insp'),
    p_set_id: setId,
    p_condition: condition,
    p_note: note || null
  }));
}

export async function releaseSeasonalSet({ clientOperationId, assignmentId, note }) {
  return unwrap(await supabase.rpc('release_seasonal_set', {
    p_client_operation_id: clientOperationId || newOperationId('rel'),
    p_assignment_id: assignmentId,
    p_note: note || null
  }));
}

export async function recordSetRenewal({
  clientOperationId, assignmentId, renewalState, note
}) {
  return unwrap(await supabase.rpc('record_set_renewal', {
    p_client_operation_id: clientOperationId || newOperationId('ren'),
    p_assignment_id: assignmentId,
    p_renewal_state: renewalState,
    p_note: note || null
  }));
}

export async function retireSeasonalSet({
  clientOperationId, setId, stripMaterialId, stripQuantity, locationCode, note
}) {
  return unwrap(await supabase.rpc('retire_seasonal_set', {
    p_client_operation_id: clientOperationId || newOperationId('ret'),
    p_set_id: setId,
    p_strip_material_id: stripMaterialId || null,
    p_strip_quantity: stripQuantity ?? null,
    p_location_code: locationCode || null,
    p_note: note || null
  }));
}

/* =====================================================================
   Batch 12.1 -- dispatch, property instructions and the two crew-triggered
   customer messages.

   Every mutation here takes a client operation id and is replay-safe
   server-side (dispatch contract v1 §8). Every planning mutation also
   quotes the revision the screen was shown, the same way a load
   confirmation quotes its three values: a concurrent edit is refused with
   the current number rather than applied on top of somebody else's work.
   ===================================================================== */

/** The ordered day for one vehicle: stops in order, work that needs a car,
 *  the operating-day window, and what the dispatch edits did to the load
 *  plan. One read, frozen in docs/dispatch-contract-v1.md §3. */
export async function getDispatchDay({ locationCode, workDate }) {
  return unwrap(await supabase.rpc('get_dispatch_day', {
    p_location_code: locationCode,
    p_work_date: workDate
  }));
}

/** Set the order of a vehicle's day.
 *
 *  `jobIds` must be EXACTLY the day's jobs, in the wanted order -- the
 *  backend refuses a subset rather than quietly dropping the stop a stale
 *  screen had not seen. */
export async function reorderDispatchDay({
  clientOperationId, locationCode, workDate, jobIds, expectedRevision
}) {
  return unwrap(await supabase.rpc('reorder_dispatch_day', {
    p_client_operation_id: clientOperationId || newOperationId('ord'),
    p_location_code: locationCode,
    p_work_date: workDate,
    p_job_ids: jobIds,
    p_expected_revision: expectedRevision ?? null
  }));
}

/** Put a job on a vehicle, or take it off with `locationCode: null`.
 *
 *  Invalidates the load plan on both the car it left and the one it joined;
 *  the receipt lists what it touched and says `stock_moved: false`, because
 *  a reassignment on a screen does not carry tools across a car park. */
export async function assignJobToVehicle({
  clientOperationId, jobId, locationCode, expectedRevision, reason
}) {
  return unwrap(await supabase.rpc('assign_job_to_vehicle', {
    p_client_operation_id: clientOperationId || newOperationId('asg'),
    p_job_id: jobId,
    p_location_code: locationCode ?? null,
    p_expected_revision: expectedRevision ?? null,
    p_reason: reason || null
  }));
}

/** Move a job to another time, possibly another day. */
export async function rescheduleJob({
  clientOperationId, jobId, scheduledFor, expectedRevision, reason
}) {
  return unwrap(await supabase.rpc('reschedule_job', {
    p_client_operation_id: clientOperationId || newOperationId('resch'),
    p_job_id: jobId,
    p_scheduled_for: scheduledFor,
    p_expected_revision: expectedRevision ?? null,
    p_reason: reason || null
  }));
}

/** What the two cars are competing for on a day. A read: nothing is
 *  transferred, reserved, bought or consumed by looking. */
export async function dispatchEquipmentConflicts({ workDate }) {
  return unwrap(await supabase.rpc('dispatch_equipment_conflicts', {
    p_work_date: workDate
  }));
}

/* ------------------------------------------- property instructions -- */

/** How to get in, what to watch for, and the defined work zones.
 *
 *  THE ONLY PATH TO THE PRIVATE COLUMNS. `access_code` and `internal_note`
 *  have no column-level SELECT for `authenticated`, so this function --
 *  which checks that the caller owns the business or crews a vehicle with
 *  work at the property -- is how they are read. Do not add a table read
 *  for them; a UI filter is not authorisation. */
export async function getPropertyAccess(propertyId) {
  return unwrap(await supabase.rpc('get_property_access', {
    p_property_id: propertyId
  }));
}

/** Write the working details. Every field is sent every time, because a
 *  partial update whose nulls mean "leave alone" cannot express "clear
 *  this". `expectedVersion` 0 is a first save. */
export async function setPropertyAccess({
  clientOperationId, propertyId, entranceNote, hazardNote, parkingNote,
  internalNote, accessCode, customerNote, expectedVersion
}) {
  return unwrap(await supabase.rpc('set_property_access', {
    p_client_operation_id: clientOperationId || newOperationId('acc'),
    p_property_id: propertyId,
    p_entrance_note: entranceNote ?? null,
    p_hazard_note: hazardNote ?? null,
    p_parking_note: parkingNote ?? null,
    p_internal_note: internalNote ?? null,
    p_access_code: accessCode ?? null,
    p_customer_note: customerNote ?? null,
    p_expected_version: expectedVersion ?? null
  }));
}

/** Create or replace a work zone.
 *
 *  `space` is 'geographic' (points are {lat,lng}) or 'image' (points are
 *  {x,y} as 0..1 fractions of `imageSource`). A drawing is not a surveyed
 *  boundary and the backend will not let it claim to be one. */
export async function savePropertyWorkZone({
  clientOperationId, propertyId, label, kind, space, points, imageSource,
  note, zoneId, expectedVersion
}) {
  return unwrap(await supabase.rpc('save_property_work_zone', {
    p_client_operation_id: clientOperationId || newOperationId('zone'),
    p_property_id: propertyId,
    p_label: label,
    p_kind: kind,
    p_space: space,
    p_points: points,
    p_image_source: imageSource ?? null,
    p_note: note ?? null,
    p_zone_id: zoneId ?? null,
    p_expected_version: expectedVersion ?? null
  }));
}

/** Retire a zone. Not a delete: what was drawn, and when it stopped
 *  applying, is history. */
export async function retirePropertyWorkZone({
  clientOperationId, zoneId, reason
}) {
  return unwrap(await supabase.rpc('retire_property_work_zone', {
    p_client_operation_id: clientOperationId || newOperationId('zone'),
    p_zone_id: zoneId,
    p_reason: reason
  }));
}

/* ------------------------------------------- issues and the states -- */

/** Report that the crew could not get in, or that the kit broke.
 *
 *  A report never changes the job's commercial status and never completes
 *  or cancels anything; the receipt says so explicitly. */
export async function reportJobIssue({
  clientOperationId, jobId, kind, reason, materialId
}) {
  return unwrap(await supabase.rpc('report_job_issue', {
    p_client_operation_id: clientOperationId || newOperationId('iss'),
    p_job_id: jobId,
    p_kind: kind,
    p_reason: reason,
    p_material_id: materialId ?? null
  }));
}

/** Resolve a reported problem. Owner-only and reasoned. */
export async function resolveJobIssue({
  clientOperationId, issueId, resolutionState, note
}) {
  return unwrap(await supabase.rpc('resolve_job_issue', {
    p_client_operation_id: clientOperationId || newOperationId('res'),
    p_issue_id: issueId,
    p_resolution_state: resolutionState,
    p_note: note
  }));
}

/** Set a stop's dispatch state: planned, skipped, blocked or
 *  work_finished.
 *
 *  `work_finished` IS NOT A COMPLETION. An accepted completion is
 *  completeJobWithEvidence() and nothing else; this call cannot produce one
 *  and its receipt reports the completion state separately so a screen
 *  cannot render one as the other. */
export async function setDispatchStage({
  clientOperationId, jobId, state, reason, expectedVersion
}) {
  return unwrap(await supabase.rpc('set_dispatch_stage', {
    p_client_operation_id: clientOperationId || newOperationId('stg'),
    p_job_id: jobId,
    p_state: state,
    p_reason: reason ?? null,
    p_expected_version: expectedVersion ?? null
  }));
}

/** The commercial status, the dispatch state, the completion state and the
 *  open issues, side by side. Four facts, never inferred from each other. */
export async function jobDispatchStatus(jobId) {
  const rows = unwrap(await supabase.from('ns_job_dispatch_status')
    .select('*').eq('job_id', jobId));
  return rows[0] || null;
}

export async function listJobIssues(jobId) {
  return unwrap(await supabase.from('ns_job_issues')
    .select('*').eq('job_id', jobId).order('reported_at', { ascending: false }));
}

/* --------------------------------------- the two customer messages -- */

/** "On the way" or "we cannot get in", through the existing notification
 *  pipeline.
 *
 *  FIVE OUTCOMES, four of which are not a send: `accepted` (queued),
 *  `delivered`, `provider_failed`, `unknown` and `unavailable` (no provider
 *  configured, or no number on file). The receipt's `delivery_state` is the
 *  honest one -- `sent` is always false, because queueing is not sending. */
export async function requestJobNotification({
  clientOperationId, jobId, kind, channel
}) {
  return unwrap(await supabase.rpc('request_job_notification', {
    p_client_operation_id: clientOperationId || newOperationId('nt'),
    p_job_id: jobId,
    p_kind: kind,
    p_channel: channel || 'sms'
  }));
}

/** What a job's messages have come to, and whether a provider is
 *  configured at all. */
export async function jobNotificationRequests(jobId) {
  return unwrap(await supabase.rpc('job_notification_requests', {
    p_job_id: jobId
  }));
}

/** Record what the provider said. Owner-only: a crew cannot mark its own
 *  message delivered. `unknown` deliberately stays live and keeps blocking
 *  a second request, because a retry might be the customer's second
 *  identical text. */
export async function recordNotificationOutcome({
  requestId, deliveryState, providerMessageId, providerError
}) {
  return unwrap(await supabase.rpc('record_notification_outcome', {
    p_request_id: requestId,
    p_delivery_state: deliveryState,
    p_provider_message_id: providerMessageId ?? null,
    p_provider_error: providerError ?? null
  }));
}

/* ------------------------------------------------ winter dispatch -- */

/** Properties with winter work that could go out, ONE ROW PER PROPERTY --
 *  walkway and deck are one visit -- plus the automation state, which is
 *  `unconfigured` because no snowfall rule, forecast source or visit
 *  allowance exists. */
export async function winterDispatchCandidates({ workDate }) {
  return unwrap(await supabase.rpc('ns_winter_dispatch_candidates', {
    p_work_date: workDate
  }));
}

/** Send an existing winter job out, deliberately. Creates no job and no
 *  minimum, and refuses a second visit to the same property that day. */
export async function dispatchWinterVisit({
  clientOperationId, jobId, locationCode, scheduledFor, reason
}) {
  return unwrap(await supabase.rpc('dispatch_winter_visit', {
    p_client_operation_id: clientOperationId || newOperationId('win'),
    p_job_id: jobId,
    p_location_code: locationCode ?? null,
    p_scheduled_for: scheduledFor,
    p_reason: reason
  }));
}

/* ==========================================================================
   BATCH 13.1 -- customer completion reports, scoped access, delivery and the
   payment boundary. Contract: docs/customer-handover-contract-v1.md (v1).

   NOTHING HERE IS APPLIED TO THE LIVE DATABASE YET: twenty-eight migrations
   are pending. Every call below will raise `function does not exist` until
   they are, which is the honest state and not something to catch and hide.
   ========================================================================== */

/* ------------------------------------------- publishing evidence -- */

/** Decide whether ONE registered evidence record may be shown to the
 *  customer. Owner-only; a withheld decision needs a reason.
 *
 *  `customerCaption` is what the customer reads. It is NOT the attachment's
 *  own caption -- that one is an internal note the office wrote for itself
 *  and republishing it is the leak this separation exists to prevent.
 *
 *  Deciding does not alter a report already generated: the document is
 *  frozen, so the decision appears in the next generation, which is a new,
 *  superseding report. */
export async function setEvidencePublication({
  clientOperationId, evidenceId, decision, reason, customerCaption
}) {
  return unwrap(await supabase.rpc('set_evidence_publication', {
    p_client_operation_id: clientOperationId || newOperationId('pub'),
    p_evidence_id: evidenceId,
    p_decision: decision,
    p_reason: reason ?? null,
    p_customer_caption: customerCaption ?? null
  }));
}

/* --------------------------------------------------- the report -- */

/** Every report for a job, newest first, with its frozen document, its
 *  state and whatever evidence still has no publication decision. */
export async function jobCompletionReports({ jobId }) {
  return unwrap(await supabase.rpc('job_completion_reports', { p_job_id: jobId }));
}

/** Generate the customer's report from an ACCEPTED COMPLETION -- not a
 *  worker's tap and not `work_finished`.
 *
 *  Two generations of the same facts are ONE report: the backend
 *  deduplicates on the logical source version, so a second tab or a retry
 *  under a fresh key is answered with the first report and `replayed:
 *  true`. A correction produces a new, superseding version instead. */
export async function generateCompletionReport({ clientOperationId, completionId }) {
  return unwrap(await supabase.rpc('generate_completion_report', {
    p_client_operation_id: clientOperationId || newOperationId('rep'),
    p_completion_id: completionId
  }));
}

/** The owner's decision that a customer may read this report. Issues no
 *  link and sends nothing -- those are two further deliberate acts. */
export async function publishCompletionReport({ clientOperationId, reportId }) {
  return unwrap(await supabase.rpc('publish_completion_report', {
    p_client_operation_id: clientOperationId || newOperationId('pubrep'),
    p_report_id: reportId
  }));
}

/* ------------------------------------------- the customer's link -- */

/** Issue a capability. OWNER-ONLY, and the token is in the result ONCE:
 *  it is stored only as a sha256 hash, so it cannot be read back and a
 *  replay under the same key returns `token: null` with
 *  `token_state: 'not_recoverable'`. Show it or send it; do not file it.
 *
 *  `scope: 'report'` opens one report. `scope: 'customer_collection'` is
 *  the deliberate broad grant and needs `customerId`; it is never derived
 *  from an email or from a forwarded report link.
 *
 *  `expiresAt` is required unless the owner has set
 *  `customer_portal.link_expiry_days` in Settings. There is no invented
 *  default. */
export async function issueCustomerGrant({
  clientOperationId, scope, reportId, customerId, expiresAt, label
}) {
  return unwrap(await supabase.rpc('issue_customer_grant', {
    p_client_operation_id: clientOperationId || newOperationId('grant'),
    p_scope: scope ?? 'report',
    p_report_id: reportId ?? null,
    p_customer_id: customerId ?? null,
    p_expires_at: expiresAt ?? null,
    p_label: label ?? null
  }));
}

/** Stop a link. It stops further reads and any new signed download; it
 *  cannot reach inside a signed URL a reader already holds, and the
 *  receipt says exactly that rather than claiming an instant cut-off. */
export async function revokeCustomerGrant({ clientOperationId, grantId, reason }) {
  return unwrap(await supabase.rpc('revoke_customer_grant', {
    p_client_operation_id: clientOperationId || newOperationId('rev'),
    p_grant_id: grantId,
    p_reason: reason
  }));
}

/** Who can read what, with prefixes rather than tokens, plus read counts. */
export async function customerGrants({ reportId, customerId }) {
  return unwrap(await supabase.rpc('customer_grants', {
    p_report_id: reportId ?? null,
    p_customer_id: customerId ?? null
  }));
}

/* ------------------------------------------------------ delivery -- */

/** Send a PUBLISHED report. Mints the customer's capability and queues the
 *  message into the existing `notifications` table in one transaction, so
 *  the token never comes back through a browser.
 *
 *  `accepted` means QUEUED, not sent -- the receipt carries `sent: false`
 *  on purpose. `unavailable` is a receipt rather than an error (no SMS
 *  provider, or no contact on file) and mints no capability at all. */
export async function deliverCompletionReport({
  clientOperationId, reportId, channel, expiresAt
}) {
  return unwrap(await supabase.rpc('deliver_completion_report', {
    p_client_operation_id: clientOperationId || newOperationId('del'),
    p_report_id: reportId,
    p_channel: channel ?? 'sms',
    p_expires_at: expiresAt ?? null
  }));
}

/** Every delivery for a report, with its state and no recipient read back. */
export async function reportDeliveries({ reportId }) {
  return unwrap(await supabase.rpc('report_deliveries', { p_report_id: reportId }));
}

/** The five clocks: acceptance, readiness, generation, enqueue and the
 *  provider's answer -- with local processing and provider time measured
 *  separately. An unavailable provider or an unknown outcome is never
 *  scored as having met a delivery target. */
export async function reportDeliveryTiming({ reportId }) {
  return unwrap(await supabase.rpc('report_delivery_timing', {
    p_report_id: reportId
  }));
}

/** Record what the provider said. Owner or the sending adapter only, and
 *  `unknown` stays live and keeps blocking a second message. */
export async function recordReportDeliveryOutcome({
  deliveryId, deliveryState, providerMessageId, providerError
}) {
  return unwrap(await supabase.rpc('record_report_delivery_outcome', {
    p_delivery_id: deliveryId,
    p_delivery_state: deliveryState,
    p_provider_message_id: providerMessageId ?? null,
    p_provider_error: providerError ?? null
  }));
}

/** Whether a customer can reply to one of our messages. Today: no, and the
 *  answer says why, with the rule a later implementation inherits -- an
 *  automatic reply never discloses an access code. */
export async function inboundReplySupport() {
  return unwrap(await supabase.rpc('ns_inbound_reply_support', {}));
}

/* ----------------------------------------------- payment boundary -- */

/** The money state of a job: the approved total (accepted quote plus
 *  approved, priced change orders), what has been received -- which this
 *  system does not record -- and therefore a null remaining balance with
 *  `balance_state: 'no_settlement_model'`. Also the provider state and the
 *  provider work still outstanding. */
export async function jobPaymentState({ jobId }) {
  return unwrap(await supabase.rpc('job_payment_state', { p_job_id: jobId }));
}

/** Prepare a payment request. Returns `state: 'unavailable'` with a reason
 *  while no provider is selected or no settlement model exists -- which is
 *  today, for every job.
 *
 *  `expectedAmount` is the figure the owner was shown; a stale one is
 *  refused rather than quietly re-bound. Preparing or opening a request is
 *  never payment, and nothing in this system can mark work paid. */
export async function createPaymentRequest({
  clientOperationId, jobId, expectedAmount
}) {
  return unwrap(await supabase.rpc('create_payment_request', {
    p_client_operation_id: clientOperationId || newOperationId('pay'),
    p_job_id: jobId,
    p_expected_amount: expectedAmount ?? null
  }));
}
