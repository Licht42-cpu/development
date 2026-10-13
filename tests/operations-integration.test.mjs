import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { integrationFixture, JOB, PROPERTY, CUSTOMER } from './operations-integration-fixture.mjs';
import { mobileFixture, finishSave } from './mobile-reliability-fixture.mjs';
import { createRecorder, finishAndReport } from './test-harness.mjs';
const { default: pw } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await pw.chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM });
const { results, record } = createRecorder();
const evidence = process.env.OPERATIONS_EVIDENCE || '/tmp/nova-operations-integration';
mkdirSync(evidence, { recursive: true });
async function check(name, fn) {
  if (process.env.OPERATIONS_ONLY && !name.includes(process.env.OPERATIONS_ONLY)) return;
  await record(name, fn);
}
async function fixture(options, fn) {
  const f = await integrationFixture(browser, options);
  try { await fn(f); assert.deepEqual(f.errors, []); } finally { await f.context.close(); }
}

await check('Inventory is reached by keyboard from the real admin nav', () => fixture({}, async ({page}) => {
  await page.getByRole('button',{name:'Menu',exact:true}).click();
  const link = page.getByRole('link', {name:'Inventory',exact:true});
  await link.focus(); await page.keyboard.press('Enter');
  await page.getByRole('heading', {name:'Inventory',exact:true}).waitFor();
  await page.getByText('FIXTURE Cable', {exact:true}).waitFor();
  assert.equal(await page.locator('#nav a[data-nav="inventory"]').getAttribute('aria-current'), 'page');
}));

await check('An inventory tab rewrites the query without adding history and survives reload', () => fixture({}, async ({page}) => {
  await page.getByRole('button', {name:'Purchasing',exact:true}).waitFor();
  const depth = await page.evaluate(() => history.state.nsDepth);
  const tab = page.getByRole('button', {name:'Purchasing',exact:true});
  await tab.focus(); await page.keyboard.press('Enter');
  assert.match(page.url(), /#\/inventory\?tab=purchasing$/);
  assert.equal(await page.evaluate(() => history.state.nsDepth), depth);
  await page.reload();
  assert.equal(await page.getByRole('button', {name:'Purchasing',exact:true}).getAttribute('aria-pressed'), 'true');
}));

await check('Dispatch preserves vehicle and day on reload and selector changes', () => fixture({hash:'#/dispatch?location=car_b&day=2027-07-06'}, async ({page}) => {
  await page.getByRole('heading', {name:'Dispatch',exact:true}).waitFor();
  await page.getByLabel('Day', {exact:true}).fill('2027-07-08');
  await page.getByLabel('Day', {exact:true}).dispatchEvent('change');
  await page.waitForURL(/location=car_b&day=2027-07-08/);
  await page.getByLabel(/^Vehicle/).selectOption('car_a');
  await page.waitForURL(/location=car_a&day=2027-07-08/);
  assert.equal(await page.getByRole('link',{name:'Review this vehicle’s loading',exact:true}).getAttribute('href'),
    'field.html#/load?vehicle=car_a&day=2027-07-08');
  await page.reload();
  await page.getByRole('heading', {name:'Dispatch',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Day',{exact:true}).inputValue(), '2027-07-08');
  const calls = await page.evaluate(() => __calls.filter(c=>c.name==='getDispatchDay'));
  assert.ok(calls.some(c=>c.args[0].locationCode==='car_a'&&c.args[0].workDate==='2027-07-08'));
  const nav = await page.evaluate(async () => (await import('/admin/js/lib/navigation.js')).parentOf('/dispatch'));
  assert.equal(nav, '/jobs?bucket=today');
}));

await check('Invalid calendar dates do not probe or silently choose another day', () => fixture({hash:'#/dispatch?day=2027-02-30'}, async ({page}) => {
  await page.getByRole('heading', {name:'Dispatch selection is invalid'}).waitFor();
  assert.deepEqual(await page.evaluate(() => __checks), []);
}));

await check('Property access mounts on the passport and keeps the customer Back parent', () => fixture({hash:`#/properties/${PROPERTY}`}, async ({page}) => {
  await page.getByLabel('Entrance',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Entrance',{exact:true}).inputValue(),'Use the front gate');
  const parent = await page.evaluate(async customer => (await import('/admin/js/lib/navigation.js')).parentOf(location.hash.slice(1),{contextParent:'/customers/'+customer}), CUSTOMER);
  assert.equal(parent, '/customers/'+CUSTOMER);
  const stored = await page.evaluate(() => JSON.stringify({...localStorage}));
  assert.ok(!stored.includes('FIXTURE-MEMORY-ONLY'));
}));

for (const accepted of [false,true]) await check(`Handover uses an authoritative ${accepted?'accepted':'absent'} completion, beside evidence`, () => fixture({hash:`#/jobs/${JOB}`,config:{__readiness:{job_id:JOB,evidence_state:'satisfied',completion_open:accepted,latest_completion_id:'accepted-completion-id',blocking_shortfalls:0,unconfigured_services:[],policy_version:1,lock_version:1}}}, async ({page}) => {
  await page.getByRole('heading', {name:'Customer handover',exact:true}).waitFor();
  await page.getByText('No report yet.', {exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Generate the report',exact:true}).count(),accepted?1:0);
  if(accepted){
    const button=page.getByRole('button',{name:'Generate the report',exact:true});
    await button.focus();await page.keyboard.press('Enter');
    const calls=await page.evaluate(()=>__calls.filter(c=>c.name==='generateCompletionReport'));
    assert.equal(calls.length,1);assert.equal(calls[0].args[0].completionId,'accepted-completion-id');
  }
  assert.ok(await page.locator('section[aria-label="Job operations"] h2').count()>=3);
  assert.equal(await page.getByRole('button',{name:/Pay now|Create payment/}).count(),0);
}));

const surfaces = [
  ['inventory','#/inventory','Inventory'],
  ['dispatch','#/dispatch?location=car_a&day=2027-07-06','Dispatch'],
  ['property',`#/properties/${PROPERTY}`,'Property access and work zones'],
  ['handover',`#/jobs/${JOB}`,'Customer handover']
];
for (const [slug,hash,title] of surfaces) await check(`${title}: missing backend is reachable, named and offers no writes`, () => fixture({hash,config:{__probeError:{code:'PGRST202',message:'SECRET ACCESS CODE must not render'}}}, async ({page}) => {
  await page.getByRole('heading',{name:title+' — unavailable',exact:true}).waitFor();
  assert.match(await page.locator('#view').innerText(),/required backend functions or tables are not available/);
  assert.ok(!(await page.locator('#view').innerText()).includes('SECRET ACCESS CODE'));
  assert.equal(await page.getByRole('button',{name:/Generate the report|Move stock|Save access/}).count(),0);
  if(slug==='handover') assert.equal(await page.getByRole('button',{name:'Mark job complete'}).isDisabled(),true);
  assert.equal((await page.evaluate(()=>__checks)).some(c=>!['table','rpc'].includes(c.kind)),false);
}));

await check('Partially applied inventory relations fail closed before the Stock actions mount', () => fixture({config:{__missingRelation:'ns_seasonal_assignments'}},async ({page})=>{
  await page.getByRole('heading',{name:'Inventory — unavailable',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Purchasing',exact:true}).count(),0);
  assert.equal((await page.evaluate(()=>__calls)).some(c=>c.name==='listMaterials'),false);
}));

await check('Retry rechecks real availability and opens the original feature when reads succeed', () => fixture({config:{__probeError:{code:'42P01',message:'missing'}}},async ({page})=>{
  await page.getByRole('heading',{name:'Inventory — unavailable',exact:true}).waitFor();
  await page.evaluate(()=>{__probeError=null;});
  const retry=page.getByRole('button',{name:'Check inventory again'});
  await retry.focus();await page.keyboard.press('Enter');
  await page.getByText('FIXTURE Cable',{exact:true}).waitFor();
}));

for(const [state,config,pattern] of [
  ['refused',{__probeError:{code:'42501',message:'denied'}},/server refused access/],
  ['offline',{__offline:true},/No connection/],
  ['unknown',{__probeError:{message:'Failed to fetch'}},/Availability is unconfirmed/],
  ['crew',{__owner:false},/owner management panel/]
]) await check(`Availability keeps ${state} distinct from a missing backend`,()=>fixture({config},async({page})=>{
  await page.getByRole('heading',{name:'Inventory — unavailable',exact:true}).waitFor();
  assert.match(await page.locator('#view').innerText(),pattern);
  if(state==='offline')assert.deepEqual(await page.evaluate(()=>__checks),[]);
}));

await check('Availability timeout resolves without leaving a permanent spinner',()=>fixture({},async({page})=>{
  const result=await page.evaluate(async()=>{
    const {operationsAvailability}=await import('/admin/js/lib/operations-availability.js');
    return operationsAvailability('Timeout probe',()=>new Promise(()=>{}),{timeoutMs:30});
  });
  assert.equal(result.state,'timeout');
}));

await check('The unchanged real API preserves read parameters, rendered locks and movement precision',()=>fixture({},async({page})=>{
  const result=await page.evaluate(async({job,property})=>{
    // Query suffix bypasses only the test fixture's API stub. This imports
    // the actual copied API and uses the browser-only SDK transport double.
    const api=await import('/admin/js/lib/api.js?integration-boundary');
    __rpcValues.get_load_plan={state:'none',plan:null,can_build:true};
    const read=await api.getLoadPlan({locationCode:'car_b',workDate:'2027-07-06'});
    await api.getPropertyAccess(property);
    await api.confirmLoadPlan({clientOperationId:'original-key',planId:'plan-id',expectedRevision:3,
      expectedFingerprint:'basis-shown',expectedLinesFingerprint:'lines-shown'});
    await api.postStockMovement({clientOperationId:'movement-key',materialId:'material-id',quantity:2,
      reason:'consumed',jobId:job,condition:'damaged',countPrecision:'estimated'});
    return {read,calls:__checks};
  },{job:JOB,property:PROPERTY});
  assert.deepEqual(result.read,{state:'none',plan:null,can_build:true});
  const call=name=>result.calls.find(c=>c.name===name)?.args;
  assert.deepEqual(call('get_load_plan'),{p_location_code:'car_b',p_work_date:'2027-07-06'});
  assert.deepEqual(call('get_property_access'),{p_property_id:PROPERTY});
  assert.deepEqual(call('confirm_load_plan'),{p_client_operation_id:'original-key',p_plan_id:'plan-id',
    p_expected_revision:3,p_expected_fingerprint:'basis-shown',p_expected_lines_fingerprint:'lines-shown',p_note:null});
  assert.equal(call('post_stock_movement').p_condition,'damaged');
  assert.equal(call('post_stock_movement').p_count_precision,'estimated');
  assert.equal(call('post_stock_movement').p_quantity,2);
}));

await check('An old availability read cannot replace a newer route',()=>fixture({config:{__probeDelay:150}},async({page})=>{
  await page.getByRole('heading',{name:'Inventory',level:1,exact:true}).waitFor();
  await page.getByRole('button',{name:'Menu',exact:true}).click();
  await page.getByRole('link',{name:'Dispatch',exact:true}).click();
  await page.getByRole('heading',{name:'Dispatch',exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Inventory',exact:true}).count(),0);
}));

await check('Escape closes the existing overlay before changing a newly wired route',()=>fixture({hash:'#/dispatch'},async({page})=>{
  await page.getByRole('heading',{name:'Dispatch',exact:true}).waitFor();
  const before=page.url();
  await page.evaluate(async()=>{const nav=await import('/admin/js/lib/navigation.js');__dismissed=false;nav.pushOverlay(()=>{__dismissed=true;});});
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>__dismissed),true);assert.equal(page.url(),before);
}));

await check('A deep-linked dispatch uses its Jobs parent on the mocked Android Back binding',()=>fixture({hash:'#/dispatch'},async({page})=>{
  await page.getByRole('heading',{name:'Dispatch',exact:true}).waitFor();
  const result=await page.evaluate(async()=>{
    const {installBackHandler}=await import('/admin/js/lib/navigation.js');
    let parent=null;
    const binding=await installBackHandler({currentPath:()=>'/dispatch',canGoBack:()=>false,native:()=>true,
      keyboardOpen:()=>false,navigate:path=>{parent=path;},
      loadApp:async()=>({App:{addListener:async()=>({remove(){}}),exitApp(){throw Error('Must not exit from dispatch');}}})});
    await binding.handler();await binding.remove();return parent;
  });
  assert.equal(result,'/jobs?bucket=today');
}));

await check('Field-to-management navigation waits for the pending measurement save',async()=>{
  const {page,context}=await mobileFixture(browser,{layout:'field',width:390});
  try{
    const before=page.url();
    await page.getByRole('spinbutton',{name:'Quantity',exact:true}).fill('9');
    await page.getByRole('link',{name:'Management',exact:true}).click();
    await page.waitForFunction(()=>__saves.length===1);
    assert.equal(page.url(),before);
    await finishSave(page);
    await page.waitForURL('**/admin/index.html#/inventory');
  }finally{await context.close();}
});

for(const width of [390,430,1280]) await check(`All inventory tabs remain reachable at ${width}px`,()=>fixture({width},async({page})=>{
  for(const [key,label] of [['purchasing','Purchasing'],['mapping','Service parts'],['sets','Christmas sets'],['kits','Kits & pieces'],['load','Daily load']]){
    const button=page.getByRole('button',{name:label,exact:true});
    await button.focus();await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('button',{name:label,exact:true}).getAttribute('aria-pressed'),'true');
    // Allow the real panel's initial asynchronous reads to paint.
    await page.waitForFunction(()=>!document.querySelector('#view').textContent.includes('Loading…'));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:join(evidence,`inventory-${key}-${width}.png`),fullPage:true});
  }
}));

for(const width of [390,430,1280]) await check(`New routes render at ${width}px with screenshot artifacts and no overflow`,async()=>{
  for(const [slug,hash,title] of surfaces) for(const available of [true,false]) await fixture({hash,width,config:available?{}:{__probeError:{code:'PGRST202',message:'missing'}}},async({page})=>{
    if(available){
      if(slug==='inventory')await page.getByText('FIXTURE Cable',{exact:true}).waitFor();
      else if(slug==='handover')await page.getByText('No report yet.',{exact:true}).waitFor();
      else if(slug==='dispatch')await page.getByRole('heading',{name:'Dispatch',exact:true}).waitFor();
      else await page.getByLabel('Entrance',{exact:true}).waitFor();
    }else await page.getByRole('heading',{name:title+' — unavailable',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>innerWidth),width);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:join(evidence,`${slug}-${available?'available':'pending'}-${width}.png`),fullPage:true});
  });
});
await finishAndReport(browser, results);
