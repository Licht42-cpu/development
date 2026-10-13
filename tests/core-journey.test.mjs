import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {coreJourneyFixture,BASE,JOB} from './core-journey-fixture.mjs';
const {default:pw}=await import(process.env.PLAYWRIGHT_MODULE||'/opt/node-tools/node_modules/playwright/index.js');
const browser=await pw.chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM||'/usr/bin/chromium'});
const folder=process.env.CORE_JOURNEY_EVIDENCE||join(tmpdir(),'nova-core-journey');mkdirSync(folder,{recursive:true});
const results=[];
async function test(name,fn){if(process.env.CORE_JOURNEY_ONLY&&!name.includes(process.env.CORE_JOURNEY_ONLY))return;
  try{await fn();results.push({name,ok:true});console.log('PASS - '+name);}
  catch(error){results.push({name,ok:false,error:error.stack});console.log('FAIL - '+name+'\n'+error.stack);}}
async function fixture(fn,options={}){const f=await coreJourneyFixture(browser,options);
  if(process.env.CORE_JOURNEY_BREAK==='work_date') {
    const src=readFileSync(new URL('../admin/js/views/field-dispatch.js',import.meta.url),'utf8');
    assert.ok(src.includes('#/load?vehicle=${encodeURIComponent(value.location_code)}&day='));
    await f.context.route('**/admin/js/views/field-dispatch.js',route=>route.fulfill({contentType:'application/javascript',body:src.replace('&day=${encodeURIComponent(value.work_date)}','&date=${encodeURIComponent(value.work_date)}')}));
  }
  try{await fn(f);assert.deepEqual(f.errors,[]);}finally{f.load.release?.();f.completion.release?.();await f.context.close();}}
async function loadFromDispatch(f,{waitWindow=true}={}){await f.openDispatch();await f.page.getByRole('link',{name:'Review vehicle load',exact:true}).focus();await f.page.keyboard.press('Enter');
  await f.page.getByRole('heading',{name:'Vehicle load',exact:true}).waitFor();if(waitWindow)await f.page.getByText('Window:',{exact:false}).waitFor();}
async function openVisit(f){await f.page.getByRole('link',{name:'Open visit',exact:true}).click();
  await f.page.getByRole('heading',{name:'Saved Customer A',exact:true,level:1}).waitFor();await f.page.locator('[data-completion-review]').waitFor();}
async function submit(f){await f.page.locator('[data-completion-review]').click();const dialog=f.page.getByRole('dialog',{name:'Review provisional completion',exact:true});
  await dialog.getByLabel('I reviewed the evidence, material usage and work finished declaration.',{exact:true}).check();
  await dialog.getByRole('button',{name:'Submit reviewed completion',exact:true}).click();}

await test('dispatch-to-load preserves the selected operating date on a clean device',()=>fixture(async f=>{
  const request=f.page.waitForRequest('**/__field_load/get_load_plan');
  await loadFromDispatch(f,{waitWindow:false});
  assert.equal((await request).postDataJSON().p_work_date,f.date);
  assert.equal(await f.page.getByLabel('Work date',{exact:true}).inputValue(),f.date);
  const call=f.load.calls.find(c=>c.name==='get_load_plan');assert.equal(call.args.p_work_date,f.date);assert.equal(call.args.p_location_code,f.code);
  assert.equal(f.load.effects,0);
}));
for(const code of ['car_a','car_b'])await test(`${code}: same-context loading → visit → accepted completion → closing`,()=>fixture(async f=>{
  await loadFromDispatch(f);await f.confirmLoad();assert.equal(f.load.effects,1);
  await openVisit(f);await submit(f);await f.page.locator('.field-completion .completion-accepted').waitFor();assert.equal(f.completion.effects,1);
  assert.equal(f.state.writes.some(w=>w.name==='completeJob'),false);
  await f.page.goto(`${BASE}/admin/field.html#/load/closing?vehicle=${f.code}&day=${f.date}`);
  await f.page.getByRole('heading',{name:'End-of-day count',exact:true}).waitFor();
  assert.equal(await f.page.getByLabel('Work date',{exact:true}).inputValue(),f.date);
  assert.equal(f.load.effects,1,'opening closing must post no stock operation');
  const line=f.closingReceipt.lines[0];
  await f.page.getByLabel(`Usable count (litre) — ${line.material_name}`,{exact:true}).fill(String(line.counted_qty));
  await f.page.getByLabel(`Count accuracy — ${line.material_name}`,{exact:true}).selectOption('estimated');
  await f.page.getByLabel(`Variance reason — ${line.material_name}`,{exact:true}).selectOption('miscounted');
  f.load.result=f.closingReceipt;
  await f.page.getByRole('button',{name:'Record observations and close day',exact:true}).click();
  await f.page.getByText('Closing receipt:',{exact:false}).waitFor();
  const closing=f.load.calls.find(c=>c.name==='reconcile_day_end');
  assert.equal(closing.args.p_location_code,f.code);assert.equal(closing.args.p_work_date,f.date);
  assert.equal(closing.args.p_lines[0].precision,'estimated');assert.equal(f.load.effects,2);assert.equal(f.completion.effects,1);
  await f.page.evaluate(()=>window.scrollTo(0,0));
  await f.page.screenshot({path:join(folder,`${code}-closing.png`),fullPage:true});
},{code}));
await test('confirmed load → offline reviewed finish → restart → replay retains original key',()=>fixture(async f=>{
  await loadFromDispatch(f);await f.confirmLoad();await openVisit(f);
  await f.page.goto(BASE+'/admin/field.html#/');await f.page.getByRole('heading',{name:"Today's schedule"}).waitFor();await f.prepare();
  await f.page.goto(BASE+'/admin/field.html#/visit/'+JOB);await f.page.locator('[data-completion-review]').waitFor();
  await f.offline();await f.page.evaluate(()=>window.dispatchEvent(new Event('offline')));await f.page.reload();
  await f.page.locator('[data-completion-review]').waitFor();await submit(f);
  await f.page.getByText('Work finished provisionally — queued for server review',{exact:true}).waitFor();
  const payload=await f.page.evaluate(async job=>(await (await import('/admin/js/lib/offline-queue.js')).completionState(job)).pending.args.payload,JOB);
  assert.equal(f.completion.effects,0);
  await f.page.reload();await f.page.getByText('Work finished provisionally — queued for server review',{exact:true}).waitFor();
  await f.offline(false);await f.page.evaluate(async()=>{await (await import('/admin/js/lib/offline-queue.js')).flush();});
  assert.equal(f.completion.effects,1);assert.deepEqual(f.completion.calls.find(c=>c.name==='complete_job_with_evidence').args,payload);
  await f.page.reload();await f.page.locator('.completion-accepted').waitFor();
}));
await test('lost completion response requires deliberate recovery with no second backend-double effect',()=>fixture(async f=>{
  await loadFromDispatch(f);await f.confirmLoad();await openVisit(f);f.completion.lost=true;await submit(f);
  await f.page.getByText('No response — completion outcome unknown',{exact:true}).waitFor();
  const request=f.completion.calls.find(c=>c.name==='complete_job_with_evidence').args;
  await f.page.reload();await f.page.getByText('No response — completion outcome unknown',{exact:true}).waitFor();
  f.completion.lost=false;await f.page.getByRole('button',{name:'Recover original completion receipt',exact:true}).click();
  await f.page.locator('.completion-accepted').waitFor();assert.equal(f.completion.effects,1);
  assert.deepEqual(f.completion.calls.filter(c=>c.name==='complete_job_with_evidence').at(-1).args,request);
}));
await browser.close();const summary={kind:'browser-doubles',android_device_result:'UNRUN',integrated_backend_result:'UNRUN',
  passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length,skipped:0,results};
writeFileSync(join(folder,process.env.CORE_JOURNEY_RESULTS||'results.json'),JSON.stringify(summary,null,2)+'\n');
console.log(`${summary.passed} PASS / ${summary.failed} FAIL / 0 SKIP`);if(summary.failed)process.exitCode=1;
