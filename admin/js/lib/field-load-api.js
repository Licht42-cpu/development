// Field-owned transport. Wire names come from b7f0a22's frozen v2.1 contract;
// do not assemble a plan from views or import the desktop load component.
import { supabase } from '../../../shared/supabase.js';

function unwrap(result) {
  if (result.error) throw result.error;
  if (result.data == null) throw new Error('No response was received. The operation may have completed.');
  return result.data;
}
export async function loadRead(code, date) {
  const value = unwrap(await supabase.rpc('get_load_plan', { p_location_code: code, p_work_date: date }));
  if (!['current','confirmed','closed','none'].includes(value.state) || typeof value.can_build !== 'boolean' ||
      (value.state === 'none') !== (value.plan === null) || !Array.isArray(value.day?.readable_vehicles) ||
      !Array.isArray(value.day?.jobs) || !value.day.window_starts_at || !value.day.window_ends_at ||
      value.location_code !== code.trim().toLowerCase() || value.work_date !== date)
    throw new Error('The server did not return a supported v2.1 load read. No plan was inferred.');
  return value;
}
export async function loadCall(name, request) {
  if (!['build_load_plan', 'confirm_load_plan', 'set_manual_keep', 'authorise_load_exception', 'reconcile_day_end'].includes(name))
    throw new Error('Unsupported load operation.');
  const receipt = unwrap(await supabase.rpc(name, request));
  const id = { build_load_plan: 'plan_id', confirm_load_plan: 'plan_id', set_manual_keep: 'material_id', authorise_load_exception: 'exception_id', reconcile_day_end: 'reconciliation_id' }[name];
  if (typeof receipt.replayed !== 'boolean' || !receipt[id] ||
      name === 'confirm_load_plan' && (!Number.isInteger(receipt.transfers_posted) || !receipt.confirmed_lines_fingerprint) ||
      name === 'reconcile_day_end' && receipt.variance_basis !== 'live_usable_on_hand')
    throw new Error('No valid acceptance receipt received. Outcome unknown; retry the original request.');
  return receipt;
}
export async function loadVehicles() {
  const locations = unwrap(await supabase.from('ns_stock_locations').select('id,code,name,kind')
    .eq('active', true).eq('kind', 'vehicle').order('sort_order'));
  // Location metadata is admin-readable, not itself crew authorisation.
  // Ask the existing stock-contract helper; never start Car B's crew in A.
  const allowed = await Promise.all(locations.map(async location =>
    unwrap(await supabase.rpc('can_see_location', { p_location_id: location.id })) === true));
  return locations.filter((_, index) => allowed[index]);
}
export async function closingMaterials() {
  // The closing basis stays server-side. These reads supply names/units only,
  // and NEVER prefill a count or calculate a variance from morning quantities.
  return unwrap(await supabase.from('ns_materials').select('id,name,unit,tracking_mode,category').eq('active', true).order('name'));
}
export async function loadSuggestions(code, date) {
  return unwrap(await supabase.rpc('ns_next_day_suggestions', { p_location_code: code, p_work_date: date }));
}
