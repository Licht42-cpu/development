import { supabase } from '../../../shared/supabase.js';

function unwrap(result) { if (result.error) throw result.error; return result.data; }
export async function readCompletion(jobId) {
  const before = unwrap(await supabase.rpc('ns_evidence_policy_version'));
  const [requirements, readiness, evidence, exceptions] = await Promise.all([
    supabase.from('ns_job_evidence_requirements').select('*').eq('job_id', jobId).order('service_key').order('requirement'),
    supabase.from('ns_job_evidence_readiness').select('*').eq('job_id', jobId).single(),
    supabase.from('ns_job_evidence').select('*').eq('job_id', jobId).order('received_at'),
    supabase.from('ns_evidence_exceptions').select('*').eq('job_id', jobId).order('authorised_at')
  ]);
  const value = { requirements: unwrap(requirements), readiness: unwrap(readiness), evidence: unwrap(evidence), exceptions: unwrap(exceptions) };
  if (!value.readiness || !Number.isInteger(value.readiness.lock_version) || !Number.isInteger(value.readiness.policy_version) || !Array.isArray(value.requirements))
    throw new Error('Completion requirements are unavailable. No policy was inferred.');
  const after = unwrap(await supabase.rpc('ns_evidence_policy_version'));
  if (before !== after || value.readiness.policy_version !== after)
    throw Object.assign(new Error('Evidence policy changed while loading. Refresh requirements before reviewing completion.'), {code:'55000'});
  return value;
}
export async function completionReceipt(id) {
  return unwrap(await supabase.rpc('ns_completion_receipt', { p_completion_id: id, p_replayed: false }));
}
export async function completeFieldJob(payload) {
  if (!payload?.p_client_operation_id || !payload.p_job_id || !Number.isInteger(payload.p_job_lock_version) || !Number.isInteger(payload.p_policy_version))
    throw new Error('A saved completion must contain the rendered job and policy versions and original key.');
  const receipt = unwrap(await supabase.rpc('complete_job_with_evidence', payload));
  if (!receipt?.completion?.completion_id || receipt.completion.job_id !== payload.p_job_id || receipt.job?.job_id !== payload.p_job_id || typeof receipt.replayed !== 'boolean')
    throw new Error('No valid completion receipt received. The outcome is unknown; retry the original request.');
  return receipt;
}
export async function registerFieldEvidence(payload) {
  const receipt = unwrap(await supabase.rpc('register_job_evidence', payload));
  if (!receipt?.evidence_id || receipt.job_id !== payload.p_job_id || typeof receipt.replayed !== 'boolean')
    throw new Error('No valid evidence receipt received. Keep the original registration request for retry.');
  return receipt;
}
export async function completionCatalogue() {
  const [materials, places] = await Promise.all([
    supabase.from('ns_materials').select('id,name,unit,tracking_mode').eq('active', true).order('name'),
    supabase.from('ns_stock_locations').select('id,code,name,kind').eq('active', true).order('sort_order')
  ]);
  const locations = unwrap(places);
  const allowed = await Promise.all(locations.map(async row => unwrap(await supabase.rpc('can_see_location', { p_location_id: row.id })) === true));
  return { materials: unwrap(materials), locations: locations.filter((_, index) => allowed[index]) };
}
export async function photoIsFrozen(id) {
  const rows = unwrap(await supabase.from('ns_job_evidence').select('id').eq('attachment_id', id).eq('frozen', true));
  return rows.length > 0;
}
