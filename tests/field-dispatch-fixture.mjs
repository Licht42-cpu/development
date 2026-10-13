import {readFileSync} from 'node:fs';
import {offlineFixture,BASE,JOB,SECOND,OWNER} from './offline-work-fixture.mjs';
export {BASE,JOB,SECOND,OWNER};
export const data=JSON.parse(readFileSync(new URL('./data/field-dispatch-v1.json',import.meta.url)));
export const scenarios=data.scenarios;
export const clone=value=>structuredClone(value);
const source=`
 const callbacks=[];const session=()=>localStorage.getItem('fixture-owner')?{user:{id:localStorage.getItem('fixture-owner')}}:null;
 window.__switchAccount=id=>{localStorage.setItem('fixture-owner',id||'');callbacks.forEach(cb=>cb(id?'SIGNED_IN':'SIGNED_OUT',session()));};
 async function query(name,args){return (await fetch('/__dispatch_fixture/'+name,{method:'POST',body:JSON.stringify(args)})).json();}
 export const supabase={auth:{getSession:async()=>({data:{session:session()}}),signOut:async()=>__switchAccount(null),onAuthStateChange:cb=>{callbacks.push(cb);cb('INITIAL_SESSION',session());return {data:{subscription:{unsubscribe(){}}}};}},rpc:(name,args)=>query(name,args),from:name=>{const filters={};const q={select:()=>q,eq:(k,v)=>{filters[k]=v;return q;},order:()=>q,single:()=>query(name,filters),then:(a,b)=>query(name,filters).then(a,b)};return q;}};
 export async function getSession(){return {session:session(),isAdmin:!!session()};}
`;
export async function dispatchFixture(browser,options={}) {
  const f=options.baseFixture || await offlineFixture(browser,{...options,open:false});
  const day=clone(scenarios.one_car_default_and_manual_order.read_after);
  day.stops=day.stops.map((stop,i)=>({...stop,job_id:i===0?SECOND:JOB,property_id:'property-'+(i===0?SECOND:JOB),customer_name:i===0?'Saved Customer B':'Saved Customer A'}));
  const state={day,property:clone(scenarios.property_instructions_and_private_codes.owner_read),calls:[],issues:[],requests:[],
    effects:0,records:new Map(),fail:null,lost:false,hold:false,propertyDenied:false,jobDenied:false,dayFail:null,
    commercial:'scheduled',dispatch:'planned',completion:'none',provider:false,outcome:'unavailable'};
  await f.context.route('**/shared/supabase.js',route=>route.fulfill({contentType:'application/javascript',body:source}));
  if(process.env.DISPATCH_BREAK==='secrets') {
    const body=readFileSync(new URL('../admin/js/lib/field-dispatch-work.js',import.meta.url),'utf8');
    await f.context.route('**/admin/js/lib/field-dispatch-work.js',route=>route.fulfill({contentType:'application/javascript',body:body.replace("['entrance_note','hazard_note','parking_note','customer_note']","['entrance_note','hazard_note','parking_note','customer_note','access_code','internal_note']")}));
  }
  await f.context.route('**/__dispatch_fixture/*',async route=>{
    const name=new URL(route.request().url()).pathname.split('/').at(-1),args=JSON.parse(route.request().postData()||'{}');state.calls.push({name,args});
    if(f.state.offline)return route.abort('internetdisconnected');
    const reply=(value,error=null)=>route.fulfill({contentType:'application/json',body:JSON.stringify({data:value,error})}).catch(()=>{});
    if((name==='get_property_access'&&state.propertyDenied)||(name==='ns_can_work_job'&&state.jobDenied))return reply(null,{code:'42501',message:'Secret 4821 must not appear in errors.'});
    if(name==='get_dispatch_day')return state.dayFail?reply(null,state.dayFail):reply(state.day);
    if(name==='get_property_access') {
      if(state.propertyHold)await new Promise(resolve=>{state.releaseProperty=resolve;});
      return reply({...clone(state.property),property_id:args.p_property_id});
    }
    if(name==='ns_stock_locations')return reply(state.day.readable_vehicles.map(v=>({id:v.location_id,code:v.code,name:v.name,kind:'vehicle'})));
    if(name==='can_see_location')return reply(state.vehicleDenied!==true);
    if(name==='ns_can_work_job')return reply(true);
    if(name==='ns_job_dispatch_status')return reply({job_id:args.job_id,job_status:state.commercial,dispatch_state:state.dispatch,
      completion_state:state.completion,open_issue_count:state.issues.filter(i=>i.resolution_state==='open').length});
    if(name==='ns_job_issues')return reply(state.issues);
    if(name==='job_notification_requests')return reply({job_id:args.p_job_id,provider_configured:state.provider,requests:state.requests});
    if(['report_job_issue','request_job_notification'].includes(name)) {
      if(state.hold)await new Promise(resolve=>{state.release=resolve;});
      if(state.fail)return reply(null,state.fail);
      let receipt=state.records.get(args.p_client_operation_id);
      if(receipt)receipt={...receipt,replayed:true};
      else {
        state.effects++;
        if(name==='report_job_issue') {
          receipt={...clone(scenarios.blocked_broken_and_finished_are_not_completed[args.p_kind==='blocked_access'?'blocked_report':'breakdown_report']),
            job_id:args.p_job_id,reason:args.p_reason,material_id:args.p_material_id};
          state.issues.push({...receipt,id:receipt.issue_id,reported_by:OWNER,resolution_note:null});
          if(args.p_kind==='blocked_access')state.dispatch='blocked';
        } else {
          receipt={...clone(scenarios.notification_outcomes[state.provider?'accepted':'no_provider_configured']),
            job_id:args.p_job_id,kind:args.p_kind,delivery_state:state.outcome};
          if(state.outcome==='provider_failed')receipt.reason='unroutable number';
          if(state.outcome==='delivered')receipt.sent=false;
          state.requests.push({...receipt,still_live:['accepted','unknown'].includes(receipt.delivery_state)});
        }
        state.records.set(args.p_client_operation_id,clone(receipt));
      }
      if(state.lost)return route.abort('internetdisconnected');
      return reply(receipt);
    }
    return reply(null,{code:'PGRST202',message:'Backend not implemented in this fixture.'});
  });
  return {...f,dispatch:state,async open(){await f.page.goto(`${BASE}/admin/field.html#/dispatch?vehicle=car_a&date=${state.day.work_date}`);
    await f.page.getByRole('heading',{name:'Ordered dispatch day',exact:true}).waitFor();
    await f.page.getByText('Ordered day received from the server.',{exact:false}).waitFor();
    if(state.day.stops.some(stop=>stop.property_id)){
      await f.page.getByText('Property instructions and crew actions',{exact:true}).first().click();
      await f.page.locator('[data-property-job]').first().getByText('Property access checked by the server.',{exact:true}).waitFor();}}};
}
