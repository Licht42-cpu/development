// Compose existing browser doubles in ONE context. This is not an integrated
// backend: independent generated snapshots are normalized for a UI journey.
import {offlineFixture,BASE,JOB,SECOND,OWNER} from './offline-work-fixture.mjs';
import {loadFixture,scenarios as loads,envelopeFor} from './field-load-fixture.mjs';
import {completionFixture,scenarios as completions,receiptFor} from './field-completion-fixture.mjs';
import {dispatchFixture} from './field-dispatch-fixture.mjs';
export {BASE,JOB,SECOND,OWNER};
const clone=value=>structuredClone(value);
export async function coreJourneyFixture(browser,{code='car_a',width=390}={}) {
  const base=await offlineFixture(browser,{open:false,width});
  const load=await loadFixture(browser,{baseFixture:base});
  const completion=await completionFixture(browser,{baseFixture:base});
  const dispatch=await dispatchFixture(browser,{baseFixture:base});
  const date='2027-08-02';
  load.load.read=envelopeFor(loads[code==='car_b'?'car_b_assigned':'siding'].response);
  Object.assign(load.load.read,{location_code:code,location_name:code==='car_a'?'Car A':'Car B',work_date:date});
  Object.assign(load.load.read.plan,{location_code:code,work_date:date});
  Object.assign(load.load.read.day,{work_date:date,window_starts_at:date+'T00:00:00Z',window_ends_at:'2027-08-03T00:00:00Z'});
  const vehicles=[{location_id:'car-a-id',code:'car_a',name:'Car A',kind:'vehicle'},
    ...(code==='car_b'?[{location_id:'car-b-id',code:'car_b',name:'Car B',kind:'vehicle'}]:[])];
  load.load.read.day.readable_vehicles=vehicles;
  load.load.read.day.jobs=[{job_id:JOB,property_id:'property-'+JOB,customer_name:'Saved Customer A',assigned:code==='car_b',scheduled_for:date+'T12:00:00Z'}];
  const closingReceipt=clone(loads.closing_without_confirmation.receipt);
  Object.assign(closingReceipt,{location_code:code,work_date:date,plan_id:load.load.read.plan.plan_id});
  const observation=closingReceipt.lines[0];
  load.load.catalogue=[{id:observation.material_id,name:observation.material_name,unit:'litre',tracking_mode:'quantity'}];
  dispatch.dispatch.day.stops=[{...dispatch.dispatch.day.stops[0],job_id:JOB,property_id:'property-'+JOB,customer_name:'Saved Customer A',assigned:code==='car_b'}];
  Object.assign(dispatch.dispatch.day,{location_code:code,location_name:code==='car_a'?'Car A':'Car B',location_id:code==='car_a'?'car-a-id':'car-b-id',work_date:date,
    readable_vehicles:vehicles.map(v=>({code:v.code,name:v.name,location_id:v.location_id}))});
  // One consistent generated completion scenario; unconfigured remains
  // unconfigured, never a fabricated satisfied proof requirement.
  completion.completion.requirements=clone(completions.unconfigured_is_not_satisfied.requirements);
  // Generated readiness is post-acceptance: normalize its pre-submit lock
  // and open state, as the existing completion fixture does for its case.
  completion.completion.readiness={...clone(completions.unconfigured_is_not_satisfied.readiness),job_id:JOB,
    lock_version:1,completion_open:false,latest_completion_id:null};
  completion.completion.receipt=receiptFor(completions.unconfigured_is_not_satisfied.accepted);
  await base.context.route('**/shared/supabase.js',route=>route.fulfill({contentType:'application/javascript',body:`
    const callbacks=[];const session=()=>localStorage.getItem('fixture-owner')?{user:{id:localStorage.getItem('fixture-owner')}}:null;
    window.__switchAccount=id=>{localStorage.setItem('fixture-owner',id||'');callbacks.forEach(cb=>cb(id?'SIGNED_IN':'SIGNED_OUT',session()));};
    const completionNames=new Set(['ns_evidence_policy_version','ns_job_evidence_requirements','ns_job_evidence_readiness','ns_job_evidence','ns_evidence_exceptions','ns_completion_receipt','register_job_evidence','complete_job_with_evidence']);
    const dispatchNames=new Set(['get_dispatch_day','get_property_access','ns_can_work_job','ns_job_dispatch_status','ns_job_issues','job_notification_requests','report_job_issue','request_job_notification']);
    async function query(name,args){const prefix=completionNames.has(name)?'__completion_fixture':dispatchNames.has(name)?'__dispatch_fixture':'__field_load';return (await fetch('/'+prefix+'/'+name,{method:'POST',body:JSON.stringify(args)})).json();}
    export const supabase={auth:{getSession:async()=>({data:{session:session()}}),signOut:async()=>__switchAccount(null),onAuthStateChange:cb=>{callbacks.push(cb);cb('INITIAL_SESSION',session());return {data:{subscription:{unsubscribe(){}}}};}},rpc:(name,args)=>query(name,args),from:name=>{const filters={};const q={select:()=>q,eq:(k,v)=>{filters[k]=v;return q;},order:()=>q,single:()=>query(name,filters),then:(a,b)=>query(name,filters).then(a,b)};return q;}};
    export async function getSession(){return {session:session(),isAdmin:!!session()};}
  `}));
  return {...base,load:load.load,completion:completion.completion,dispatch:dispatch.dispatch,code,date,closingReceipt,
    async openDispatch(){await base.page.goto(BASE+'/admin/field.html#/dispatch?vehicle='+code+'&date='+date);
      await base.page.getByText('Ordered day received from the server.',{exact:false}).waitFor();},
    async confirmLoad(){await base.page.getByLabel('I checked the physical loading',{exact:false}).check();
      await base.page.getByRole('button',{name:'Confirm checked loading and returns',exact:true}).click();
      await base.page.getByText('Accepted by the server.',{exact:true}).waitFor();}};
}
