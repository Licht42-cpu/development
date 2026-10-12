// Field-owned transport against b21d082's dispatch v1. No desktop API edits.
import { supabase } from '../../../shared/supabase.js';

function unwrap(result) {
  if (result.error) throw result.error;
  if (result.data == null) throw new Error('No supported dispatch response was received.');
  return result.data;
}
export async function dispatchRead(code, date) {
  const value = unwrap(await supabase.rpc('get_dispatch_day', {p_location_code:code,p_work_date:date}));
  if (value.location_code !== code || value.work_date !== date || !Number.isInteger(value.revision) ||
      !Array.isArray(value.stops) || !Array.isArray(value.unassigned_jobs) || !Array.isArray(value.readable_vehicles) ||
      typeof value.can_plan !== 'boolean' || !['current','confirmed','superseded','closed','none'].includes(value.load_plan?.state) ||
      typeof value.load_plan.needs_rebuild !== 'boolean' ||
      !['configured','unconfigured'].includes(value.work_day_timezone_state) ||
      !value.window_starts_at || !value.window_ends_at ||
      value.stops.some(stop => !stop.job_id || !['derived','explicit','stale'].includes(stop.order_state)))
    throw new Error('Unsupported dispatch day. No stop order was inferred.');
  return value;
}
export async function propertyRead(propertyId) {
  const value = unwrap(await supabase.rpc('get_property_access', {p_property_id:propertyId}));
  if (value.property_id !== propertyId || !Array.isArray(value.zones) ||
      !['known','missing'].includes(value.coordinates?.state))
    throw new Error('Unsupported property instructions. No location was inferred.');
  return value;
}
export async function dispatchJobRead(jobId) {
  if (unwrap(await supabase.rpc('ns_can_work_job',{p_job_id:jobId})) !== true)
    throw Object.assign(new Error('This job is not yours to open.'),{code:'42501'});
  const [status, issues, messages] = await Promise.all([
    supabase.from('ns_job_dispatch_status').select('*').eq('job_id',jobId).single(),
    supabase.from('ns_job_issues').select('*').eq('job_id',jobId).order('reported_at'),
    supabase.rpc('job_notification_requests',{p_job_id:jobId})
  ]);
  const value={status:unwrap(status),issues:unwrap(issues),messages:unwrap(messages)};
  if(value.status.job_id !== jobId || !Array.isArray(value.issues) || value.messages.job_id !== jobId || !Array.isArray(value.messages.requests))
    throw new Error('Unsupported job dispatch facts. No status was inferred.');
  return value;
}
export async function dispatchCall(name, payload) {
  if (!['report_job_issue','request_job_notification'].includes(name)) throw new Error('Unsupported field dispatch action.');
  const value = unwrap(await supabase.rpc(name,payload));
  if (value.job_id !== payload.p_job_id || typeof value.replayed !== 'boolean' ||
      name === 'report_job_issue' && (!value.issue_id || value.completion_recorded !== false || value.job_status_changed !== false) ||
      name === 'request_job_notification' && (!value.request_id || value.sent !== false ||
        !['accepted','delivered','provider_failed','unknown','unavailable'].includes(value.delivery_state)))
    throw new Error('No valid dispatch receipt received. Outcome unknown; recover the original request.');
  return value;
}
