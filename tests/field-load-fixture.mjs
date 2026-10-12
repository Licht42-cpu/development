import { readFileSync } from 'node:fs';
import { offlineFixture, BASE, OWNER } from './offline-work-fixture.mjs';
export const data = JSON.parse(readFileSync(new URL('./data/field-daily-load-v2.json', import.meta.url)));
export const scenarios = data.scenarios;
export const clone = value => structuredClone(value);
// Test composition only: generated plan responses are placed inside the
// generated read envelope. No product DTO is assembled from ledger views.
export function envelopeFor(plan) {
  const value = clone(scenarios.frozen_read_envelope.current);
  value.plan = clone(plan); value.work_date = plan.work_date; value.location_code = plan.location_code;
  value.location_id = plan.location_id;
  value.location_name = value.day.readable_vehicles.find(v => v.code === plan.location_code)?.name || plan.location_code;
  value.state = plan.status; value.needs_review_count = plan.needs_review_count;
  value.unassigned_job_count = plan.unassigned_jobs; value.can_build = false;
  value.day.work_date = plan.work_date;
  // These composition cases retain the frozen unconfigured/UTC setting.
  // Synthetic bounds keep screenshot dates consistent; they are NOT new
  // generated database evidence or client-side product bucketing.
  value.day.window_starts_at = `${plan.work_date}T00:00:00+00:00`;
  const end = new Date(`${plan.work_date}T00:00:00Z`); end.setUTCDate(end.getUTCDate()+1);
  value.day.window_ends_at = `${end.toISOString().slice(0,10)}T00:00:00+00:00`;
  return value;
}
const source = `
 const callbacks=[];
 const session=()=>localStorage.getItem('fixture-owner')?{user:{id:localStorage.getItem('fixture-owner')}}:null;
 window.__switchAccount=id=>{localStorage.setItem('fixture-owner',id||'');callbacks.forEach(cb=>cb(id?'SIGNED_IN':'SIGNED_OUT',session()));};
 async function query(name,args){const r=await fetch('/__field_load/'+name,{method:'POST',body:JSON.stringify(args)});return r.json();}
 export const supabase={auth:{getSession:async()=>({data:{session:session()}}),signOut:async()=>__switchAccount(null),onAuthStateChange:cb=>{callbacks.push(cb);cb('INITIAL_SESSION',session());return {data:{subscription:{unsubscribe(){}}}};}},
 rpc:(name,args)=>query(name,args),from:name=>{const filters={};const q={select:()=>q,eq:(key,value)=>{filters[key]=value;return q;},order:()=>q,then:(ok,bad)=>query(name,filters).then(ok,bad)};return q;}};
 export async function getSession(){return {session:session(),isAdmin:!!session()};}
`;
export async function loadFixture(browser, options = {}) {
  const f = await offlineFixture(browser, { open: false, ...options });
  const state = options.loadState || { read: clone(scenarios.frozen_read_envelope.current), catalogue: [], calls: [], receipts: new Map(), effects: 0, lost: null, fail: null, result: null, held: null };
  if (!options.loadState) state.read.can_build = false;
  await f.context.route('**/shared/supabase.js', route => route.fulfill({ contentType: 'application/javascript', body: source }));
  await f.context.route('**/__field_load/*', async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    const args = JSON.parse(route.request().postData() || '{}'); state.calls.push({ name, args });
    if (f.state.offline) return route.abort('internetdisconnected');
    if (state.held === name) await new Promise(resolve => { state.release = resolve; });
    let result;
    if (name === 'ns_stock_locations') result = state.locations || state.read.day.readable_vehicles.filter(v => v.kind === 'vehicle').map(v => ({ ...v, id: v.location_id }));
    else if (name === 'can_see_location') result = state.read.day.readable_vehicles.some(v => v.location_id === args.p_location_id);
    else if (name === 'ns_materials') result = state.catalogue;
    else if (name === 'get_load_plan') result = typeof state.read === 'function' ? state.read(args) : state.read;
    else if (name === 'ns_next_day_suggestions') result = scenarios.winter_replenishment.suggestions;
    else {
      if (state.fail) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: { code: state.fail.sqlstate || state.fail.code, message: state.fail.message }, data: null }) });
      const key = args.p_client_operation_id;
      if (state.receipts.has(key)) result = { ...state.receipts.get(key), replayed: true };
      else { result = clone(state.result || scenarios.per_operation_retries.confirmation.first); state.receipts.set(key, result); state.effects++; }
      if (state.lost === name) return route.abort('internetdisconnected');
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: result, error: null }) }).catch(() => {});
  });
  return { ...f, load: state, async open({ closing = false, code = state.read.location_code, date = state.read.work_date } = {}) {
    await f.page.goto(`${BASE}/admin/field.html#/load${closing ? '/closing' : ''}?vehicle=${code}&day=${date}`);
    await f.page.getByRole('heading', { name: closing ? 'End-of-day count' : 'Vehicle load', exact: true }).waitFor();
    await f.page.getByText('Window:', { exact: false }).waitFor();
  }, OWNER };
}
