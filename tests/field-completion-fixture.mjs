import { readFileSync } from 'node:fs';
import { offlineFixture, BASE, JOB, OWNER } from './offline-work-fixture.mjs';
export { BASE, JOB, OWNER };
export const data=JSON.parse(readFileSync(new URL('./data/field-completion-v1.json',import.meta.url)));
export const scenarios=data.scenarios;
export const clone=value=>structuredClone(value);
export function receiptFor(value, job=JOB) {
  const receipt=clone(value);
  receipt.job.job_id=job;receipt.completion.job_id=job;receipt.readiness.job_id=job;
  return receipt;
}
const source=`
 const callbacks=[];const session=()=>localStorage.getItem('fixture-owner')?{user:{id:localStorage.getItem('fixture-owner')}}:null;
 window.__switchAccount=id=>{localStorage.setItem('fixture-owner',id||'');callbacks.forEach(cb=>cb(id?'SIGNED_IN':'SIGNED_OUT',session()));};
 async function query(name,args){const r=await fetch('/__completion_fixture/'+name,{method:'POST',body:JSON.stringify(args)});return r.json();}
 export const supabase={auth:{getSession:async()=>({data:{session:session()}}),signOut:async()=>__switchAccount(null),onAuthStateChange:cb=>{callbacks.push(cb);cb('INITIAL_SESSION',session());return {data:{subscription:{unsubscribe(){}}}};}},rpc:(name,args)=>query(name,args),from:name=>{const filters={};const q={select:()=>q,eq:(key,value)=>{filters[key]=value;return q;},order:()=>q,single:()=>query(name,filters),then:(ok,bad)=>query(name,filters).then(ok,bad)};return q;}};
 export async function getSession(){return {session:session(),isAdmin:!!session()};}
`;
export async function completionFixture(browser,options={}) {
  const f=options.baseFixture || await offlineFixture(browser,{open:false,...options});
  const state=options.completionState || {calls:[],effects:0,records:new Map(),lost:false,fail:null,hold:false,registerFail:null,registerLost:false,registrations:0,evidence:[],
    requirements:clone(scenarios.cleaning_before_and_after.requirements_before_any_evidence),
    readiness:{...receiptFor(scenarios.cleaning_before_and_after.accepted).readiness,completion_open:false,latest_completion_id:null,lock_version:1,evidence_state:'blocked',blocking_shortfalls:2},
    receipt:receiptFor(scenarios.cleaning_before_and_after.accepted),
    materials:[{id:'material-product',name:'Cleaning product',unit:'litre',tracking_mode:'quantity'},{id:'material-level',name:'Cheap supply',unit:'level',tracking_mode:'level'}],
    locations:[{id:'loc-base',code:'base',name:'Base',kind:'base'},{id:'loc-car-a',code:'car_a',name:'Car A',kind:'vehicle'}]};
  await f.context.route('**/shared/supabase.js',route=>route.fulfill({contentType:'application/javascript',body:source}));
  await f.context.route('**/__offline_fixture/getJob',async route=>{
    const [id]=JSON.parse(route.request().postData());f.state.calls.push({name:'getJob',args:[id]});
    if(f.state.offline)return route.abort('internetdisconnected');
    const row={id,status:state.readiness.completion_open ? 'completed':'in_progress',completed_at:state.readiness.completion_open ? '<timestamp>':null,lock_version:state.readiness.lock_version,customers:{name:id===JOB?'Saved Customer A':'Saved Customer B'},properties:{id:'property-'+id,address_line1:'123 Saved Street',city:'Test City',passport:{}}};
    return route.fulfill({contentType:'application/json',body:JSON.stringify(row)});
  });
  await f.context.route('**/__completion_fixture/*',async route=>{
    const name=new URL(route.request().url()).pathname.split('/').at(-1),args=JSON.parse(route.request().postData()||'{}');state.calls.push({name,args});
    if(f.state.offline)return route.abort('internetdisconnected');
    let result;
    if(state.readDenied && ['ns_job_evidence_requirements','ns_job_evidence_readiness','ns_job_evidence'].includes(name))
      return route.fulfill({contentType:'application/json',body:JSON.stringify({data:null,error:{code:'42501',message:'Completion evidence is outside your assignment.'}})});
    if(name==='ns_job_evidence_requirements')result=state.requirements;
    else if(name==='ns_job_evidence_readiness')result=state.readiness;
    else if(name==='ns_job_evidence')result=args.frozen ? state.evidence.filter(row=>row.frozen&&row.attachment_id===args.attachment_id) : state.evidence;
    else if(name==='ns_evidence_exceptions')result=state.exceptions || [];
    else if(name==='ns_evidence_policy_version')result=state.policyChangeDuringRead && state.calls.filter(row=>row.name===name).length%2===0 ? state.readiness.policy_version+1 : state.readiness.policy_version;
    else if(name==='ns_materials')result=state.materials;
    else if(name==='ns_stock_locations')result=state.locations;
    else if(name==='can_see_location')result=state.locations.some(row=>row.id===args.p_location_id);
    else if(name==='ns_completion_receipt')result=state.receipt;
    else if(name==='register_job_evidence') {
      if(state.registerFail)return route.fulfill({contentType:'application/json',body:JSON.stringify({data:null,error:{code:state.registerFail.sqlstate,message:state.registerFail.message}})});
      if(!state.registrationKey){state.registrationKey=args.p_client_operation_id;state.registrations++;}
      result={...clone(scenarios.missing_metadata_and_evidence.no_device_metadata),job_id:args.p_job_id,gps_state:args.p_gps_state||'unknown',replayed:state.registrations===1&&state.registerReplayed};
      result.replayed=!!result.replayed;
      if(state.registerLost)return route.abort('internetdisconnected');
    } else if(name==='complete_job_with_evidence') {
      if(state.hold)await new Promise(resolve=>{state.release=resolve;});
      if(state.fail)return route.fulfill({contentType:'application/json',body:JSON.stringify({data:null,error:{code:state.fail.sqlstate,message:state.fail.message}})});
      if(state.records.has(args.p_client_operation_id))result={...clone(state.records.get(args.p_client_operation_id)),replayed:true};
      else {result=clone(state.receipt);state.records.set(args.p_client_operation_id,result);state.effects++;state.readiness=clone(result.readiness);}
      if(state.lost)return route.abort('internetdisconnected');
    } else throw new Error('Unknown fixture operation '+name);
    return route.fulfill({contentType:'application/json',body:JSON.stringify({data:state.malformed && name==='complete_job_with_evidence' ? {} : result,error:null})}).catch(()=>{});
  });
  return {...f,completion:state,async open(){await f.page.goto(`${BASE}/admin/field.html#/visit/${JOB}`);await f.page.getByRole('heading',{name:'Saved Customer A',exact:true,level:1}).waitFor();await f.page.locator('.field-completion').getByText('Current readiness:',{exact:false}).waitFor();await f.page.locator('[data-completion-review]').waitFor();}};
}
