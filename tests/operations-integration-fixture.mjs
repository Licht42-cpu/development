import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BASE } from './test-harness.mjs';
export const JOB = '11111111-1111-4111-8111-111111111111';
export const PROPERTY = '22222222-2222-4222-8222-222222222222';
export const CUSTOMER = '33333333-3333-4333-8333-333333333333';

// Browser-only role and transport doubles. The application gets no fixture
// switch; this fixture never connects to a project or proves server grants.
const auth = `
  async function answer(kind, name, args) {
    __checks.push({kind,name,args});
    if (__probeDelay) await new Promise(resolve => setTimeout(resolve, __probeDelay));
    if (__probeError) return { data:null, error:__probeError };
    if (__missingRelation === name) return { data:null, error:{code:'PGRST205',message:'missing'} };
    if (kind==='rpc' && name==='is_owner') return { data:__owner, error:null };
    if (kind==='rpc' && name in __rpcValues) return {data:__rpcValues[name],error:null};
    if (kind==='table' && name==='ns_job_evidence_readiness') return { data:__readiness, error:null };
    return { data:{}, error:null };
  }
  const query = (kind,name,args) => {
    const result = {};
    for(const method of ['select','eq','order','limit','single','abortSignal']) result[method]=()=>result;
    result.then=(ok,bad)=>answer(kind,name,args).then(ok,bad);
    return result;
  };
  export const supabase = {
    rpc:(name,args)=>query('rpc',name,args), from:name=>query('table',name,{}),
    auth:{ signOut:async()=>{}, onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}) }
  };
  export async function getSession(){return {session:{user:{id:'fixture-owner'}},isAdmin:true};}
`;
const exported = [...readFileSync(new URL('../admin/js/lib/api.js', import.meta.url),'utf8')
  .matchAll(/export (?:async )?function (\w+)\(/g)].map(m=>m[1]);
const api = `
  const property = {id:'${PROPERTY}',address_line1:'FIXTURE 100 Example Road',city:'Example City',passport:{},customer:{id:'${CUSTOMER}',name:'FIXTURE Customer'}};
  function job(id){return {id,customer_id:'${CUSTOMER}',property_id:'${PROPERTY}',status:'in_progress',lock_version:1,customers:{id:'${CUSTOMER}',name:'FIXTURE Customer',email:'customer@example.test',phone:'5550100'},properties:property};}
  function value(name,args){
    if(name==='getJob')return job(args[0]);
    if(name==='propertyHistory')return {property,jobs:[],quotes:[],measurements:[],inspections:[],photos:[]};
    if(name==='getSettings')return {company:{website:'https://example.test'}};
    if(name==='currentUserId')return 'fixture-owner';
    if(name==='newOperationId')return 'fixture-operation';
    if(name==='getDispatchDay')return {location_code:args[0].locationCode,work_date:args[0].workDate,revision:1,can_plan:true,work_day_timezone_state:'unconfigured',window_starts_at:args[0].workDate+'T00:00:00Z',window_ends_at:args[0].workDate+'T23:59:59Z',readable_vehicles:[{code:'car_a',name:'Car A'},{code:'car_b',name:'Car B'}],stops:[],unassigned_jobs:[],load_plan:{state:'none'}};
    if(name==='dispatchEquipmentConflicts')return {items:[]};
    if(name==='getPropertyAccess')return {property_id:'${PROPERTY}',coordinates:{state:'unknown'},access:{lock_version:0,access_code:'FIXTURE-MEMORY-ONLY',entrance_note:'Use the front gate'},zones:[]};
    if(name==='jobCompletionReports')return {job_id:args[0].jobId,reports:[],undecided_evidence:[]};
    if(name==='jobPaymentState')return {approved_total:null,balance_state:'no_settlement_model',feature_state:'unavailable',provider_configured:false};
    if(name==='jobEvidenceReadiness')return __readiness;
    if(name==='getJobMaterialSheet')return null;
    if(name==='listStockLocations')return [{id:'base-id',code:'base',kind:'base',name:'Base'},{id:'car-a-id',code:'car_a',kind:'vehicle',name:'Car A'}];
    if(name==='listMaterials')return [{id:'part-1',name:'FIXTURE Cable',unit:'linear_ft',category:'wire',active:true,pack_quantity:1,tracking_mode:'quantity',on_hand:100,needs_reorder:false}];
    if(name==='listStockByLocation')return [{material_id:'part-1',location_id:'base-id',location_code:'base',location_name:'Base',on_hand:100,available:100,reserved:0,damaged:0,is_estimated:false}];
    if(name==='getLoadPlan')return {state:'none',can_build:true,plan:null,work_date:args[0].workDate,work_day_timezone_state:'unconfigured'};
    if(name==='loadDaySummary')return {state:'none'};
    return [];
  }
  function call(name,args){__calls.push({name,args});return name in __values?structuredClone(__values[name]):value(name,args);}
  ${exported.map(name=>`export ${['newOperationId','attachmentBucket'].includes(name)?'':'async '}function ${name}(...args){return call('${name}',args);}`).join('\n')}
`;

export async function integrationFixture(browser, {hash='#/inventory',width=390,config={}}={}){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
  context.setDefaultTimeout(6500);
  await context.addInitScript(config=>{
    Object.assign(globalThis,{__checks:[],__calls:[],__values:{},__rpcValues:{},__owner:true,__probeDelay:0,__probeError:null,__missingRelation:null,
      __readiness:{job_id:'11111111-1111-4111-8111-111111111111',evidence_state:'satisfied',completion_open:false,latest_completion_id:null,blocking_shortfalls:0,unconfigured_services:[],policy_version:1,lock_version:1}},config);
    if(config.__offline)Object.defineProperty(navigator,'onLine',{get:()=>false});
  },config);
  await context.route('**/*',route=>new URL(route.request().url()).origin===BASE?route.continue():route.abort('internetdisconnected'));
  await context.route(BASE+'/shared/supabase.js',route=>route.fulfill({contentType:'application/javascript',body:auth}));
  await context.route(BASE+'/admin/js/lib/api.js',route=>route.fulfill({contentType:'application/javascript',body:api}));
  if(process.env.OPERATIONS_BREAK==='routes'){
    const body=execFileSync('git',['show','ae6fb6b:admin/js/main.js'],{encoding:'utf8'});
    await context.route(BASE+'/admin/js/main.js',route=>route.fulfill({contentType:'application/javascript',body}));
  }
  const page=await context.newPage();const errors=[];
  page.on('pageerror',err=>errors.push(err.message));
  await page.goto(BASE+'/admin/index.html'+hash);
  return {page,context,errors};
}
