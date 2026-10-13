import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync,readFileSync,mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { completionFixture,scenarios,receiptFor,clone,JOB,BASE } from './field-completion-fixture.mjs';
const {default:pw}=await import(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright/index.js');
const launch={executablePath:process.env.PLAYWRIGHT_CHROMIUM || '/usr/bin/chromium'};
const browser=await pw.chromium.launch(launch), results=[];
const evidence=process.env.COMPLETION_EVIDENCE || join(tmpdir(),'nova-completion');mkdirSync(evidence,{recursive:true});
async function test(name,fn){if(process.env.COMPLETION_ONLY&&!name.includes(process.env.COMPLETION_ONLY))return;try{await fn();results.push({name,ok:true});console.log('PASS - '+name);}catch(error){results.push({name,ok:false,error:error.stack});console.log('FAIL - '+name+'\n'+error.stack);}}
async function fixture(fn,options={}){
 const f=await completionFixture(browser,options);
 const faults={versions:['admin/js/components/field-completion.js','p_job_lock_version:rendered.lock_version','p_job_lock_version:999'],marker:['admin/js/lib/offline-queue.js',"recordVersion: COMPLETION_RECORD_VERSION });","recordVersion: 1 });"]};
 if(faults[process.env.COMPLETION_BREAK]){const [file,from,to]=faults[process.env.COMPLETION_BREAK];const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');assert.ok(source.includes(from));await f.context.route('**/'+file,route=>route.fulfill({contentType:'application/javascript',body:source.replace(from,to)}));}
 try{await fn(f);assert.deepEqual(f.errors,[]);}finally{f.completion.release?.();await f.context.close();}
}
const calls=(f,name)=>f.completion.calls.filter(row=>row.name===name);
async function review(f){await f.page.locator('[data-completion-review]').click();await f.page.getByRole('dialog',{name:'Review provisional completion',exact:true}).waitFor();}
async function submit(f){await review(f);const dialog=f.page.getByRole('dialog',{name:'Review provisional completion',exact:true});await dialog.getByLabel('I reviewed the evidence, material usage and work finished declaration.',{exact:true}).check();await dialog.getByRole('button',{name:'Submit reviewed completion',exact:true}).click();}
const saved=f=>f.page.evaluate(async job=>(await import('/admin/js/lib/offline-queue.js')).completionState(job),JOB);
async function acceptance(f){await f.page.locator('.field-completion .completion-accepted').waitFor();await f.page.getByRole('dialog',{name:'Review provisional completion',exact:true}).waitFor({state:'detached'});await f.page.waitForFunction(()=>document.querySelector('section.field-completion')?.getAttribute('aria-busy')==='false');}

await test('frozen fixture contains 14 scenarios and matches the reviewed upstream snapshot',async()=>{
 const file=readFileSync(new URL('./data/field-completion-v1.json',import.meta.url));const data=JSON.parse(file);assert.equal(Object.keys(data.scenarios).length,14);
 // The immutable checksum is filled from the read-only upstream copy.
 assert.equal(createHash('sha256').update(file).digest('hex'),'85e9b74e087f76514e0d8363efd2e92806ec7c96a1cf11cb820529dc2f30e0ca');
});
await test('cleaning_before_and_after: requirements show confirmed blocking shortfalls and no status bypass',()=>fixture(async f=>{
 await f.open();assert.match(await f.page.locator('.field-completion').innerText(),/blocking, owner confirmed/);
 assert.equal(await f.page.locator('select option[value="completed"]').count(),0);assert.equal(calls(f,'complete_job_with_evidence').length,0);
 await review(f);await f.page.getByRole('button',{name:'Submit reviewed completion',exact:true}).click();
 assert.equal(calls(f,'complete_job_with_evidence').length,0);await f.page.getByRole('button',{name:'Cancel completion',exact:true}).click();
 assert.equal((await saved(f)).pending,null);
}));
await test('Cancel, Escape and Android overlay Back never submit a reviewed declaration',()=>fixture(async f=>{
 await f.open();for(const action of ['cancel','escape','back']){await review(f);if(action==='cancel')await f.page.getByRole('button',{name:'Cancel completion',exact:true}).click();else if(action==='escape')await f.page.keyboard.press('Escape');else await f.page.evaluate(async()=>{(await import('/admin/js/lib/navigation.js')).dismissTopOverlay();});
 assert.equal(await f.page.getByRole('dialog').count(),0);assert.equal(calls(f,'complete_job_with_evidence').length,0);}
}));
await test('late route/account change during review cannot submit and preserves notes',()=>fixture(async f=>{
 await f.open();await f.page.getByLabel('Internal completion note',{exact:true}).fill('keep this raw note');await f.page.getByText('Completion draft saved on this device.',{exact:true}).waitFor();await review(f);
 await f.page.evaluate(()=>__switchAccount('other-staff'));await f.page.waitForFunction(()=>!document.querySelector('dialog.completion-review'));
 assert.equal(calls(f,'complete_job_with_evidence').length,0);
}));
await test('confirmation quotes rendered versions, null finish stays unknown and no fresh read precedes send',()=>fixture(async f=>{
 await f.open();const reads=calls(f,'ns_job_evidence_readiness').length;f.completion.readiness.lock_version=44;f.completion.readiness.policy_version=99;
 await submit(f);await acceptance(f);const sent=calls(f,'complete_job_with_evidence')[0];assert.equal(sent.args.p_job_lock_version,1);assert.equal(sent.args.p_policy_version,3);assert.equal(sent.args.p_work_finished_at,null);
 const at=f.completion.calls.findIndex(row=>row.name==='complete_job_with_evidence');assert.equal(f.completion.calls.slice(0,at).filter(row=>row.name==='ns_job_evidence_readiness').length,reads);
 assert.equal(f.state.writes.filter(row=>row.name==='completeJob'||row.name==='updateJob').length,0);
}));
await test('policy changing between independent reads cannot produce a mixed reviewable snapshot',()=>fixture(async f=>{
 f.completion.policyChangeDuringRead=true;await f.page.goto(`${BASE}/admin/field.html#/visit/${JOB}`);
 await f.page.getByText('Completion requirements unavailable: Evidence policy changed while loading. Refresh requirements before reviewing completion. No completion was inferred.',{exact:true}).waitFor();
 assert.equal(await f.page.locator('[data-completion-review]').count(),0);assert.equal(calls(f,'complete_job_with_evidence').length,0);
}));
await test('quick_winter_proof remains advisory/proposed; one reviewed operation',()=>fixture(async f=>{
 f.completion.requirements=clone(scenarios.quick_winter_proof.requirements);f.completion.readiness.evidence_state='advisory_short';f.completion.readiness.blocking_shortfalls=0;f.completion.receipt=receiptFor(scenarios.quick_winter_proof.accepted);
 await f.open();assert.match(await f.page.locator('.field-completion').innerText(),/advisory, proposed/);await submit(f);await acceptance(f);assert.equal(f.completion.effects,1);
}));
await test('lighting_installation_and_component: proposed installation/component requirements stay visible and advisory',()=>fixture(async f=>{
 f.completion.requirements=clone(scenarios.lighting_installation_and_component.requirements_proposed_only);
 f.completion.receipt=receiptFor(scenarios.lighting_installation_and_component.accepted);await f.open();
 assert.match(await f.page.locator('.field-completion').innerText(),/installation/);assert.match(await f.page.locator('.field-completion').innerText(),/component/);await submit(f);await acceptance(f);
}));
await test('unconfigured_is_not_satisfied: unknown required count is not zero; acceptance retains unconfigured state',()=>fixture(async f=>{
 f.completion.requirements=clone(scenarios.unconfigured_is_not_satisfied.requirements);f.completion.readiness.evidence_state='unconfigured';f.completion.receipt=receiptFor(scenarios.unconfigured_is_not_satisfied.accepted);
 await f.open();assert.match(await f.page.locator('.field-completion').innerText(),/nobody has said/);await submit(f);await acceptance(f);assert.match(await f.page.locator('.completion-accepted').innerText(),/unconfigured/);
}));
for(const scenario of ['stale_job_version','stale_policy_version'])await test(`stale_policy_and_job/${scenario}: conflict blocks automatic replay; original draft retained`,()=>fixture(async f=>{
 f.completion.fail=scenarios.stale_policy_and_job[scenario];await f.open();await f.page.getByLabel('Internal completion note',{exact:true}).fill('must survive refusal');await submit(f);
 await f.page.getByText(f.completion.fail.message,{exact:true}).waitFor();let row=(await saved(f)).pending;assert.equal(row.state,'conflict');assert.equal(row.args.payload.p_note,'must survive refusal');
 await f.page.evaluate(async()=>{await (await import('/admin/js/lib/offline-queue.js')).flush();});assert.equal(calls(f,'complete_job_with_evidence').length,1);
}));
await test('missing_blocking_evidence: 23514 sentence remains visible; photos and original request retained',()=>fixture(async f=>{
 f.completion.fail=scenarios.cleaning_before_and_after.refused_without_evidence;await f.open();await submit(f);await f.page.getByText(f.completion.fail.message,{exact:true}).waitFor();assert.equal((await saved(f)).pending.state,'conflict');assert.equal(f.completion.effects,0);
}));
await test('denied_access: 42501 is refusal, not offline or accepted; stored work remains scoped',()=>fixture(async f=>{
 f.completion.fail=scenarios.denied_access.crew_completing_other_cars_job;await f.open();await submit(f);await f.page.locator('.field-completion').getByText(f.completion.fail.message,{exact:true}).waitFor();const state=await saved(f);assert.equal(state.pending.outcome,'refused');assert.equal(state.pending.state,'needs-review');assert.equal(state.accepted,null);
}));
await test('same_key_retry_lost_response: original key/payload recovery has one effect and no duplicate debit',()=>fixture(async f=>{
 await f.open();f.completion.lost=true;await submit(f);await f.page.getByText('No response — completion outcome unknown',{exact:true}).waitFor();const original=clone(calls(f,'complete_job_with_evidence')[0].args);assert.equal(f.completion.effects,1);
 await f.page.evaluate(async()=>{await (await import('/admin/js/lib/offline-queue.js')).flush();});assert.equal(calls(f,'complete_job_with_evidence').length,1);
 f.completion.lost=false;await f.page.getByRole('button',{name:'Recover original completion receipt',exact:true}).click();await acceptance(f);
 assert.deepEqual(calls(f,'complete_job_with_evidence')[1].args,original);assert.equal(f.completion.effects,1);assert.equal((await saved(f)).accepted.receipt.replayed,true);
}));
await test('malformed acceptance stays unknown; original receipt recovery does not post a second effect',()=>fixture(async f=>{
 await f.open();f.completion.malformed=true;await submit(f);await f.page.getByText('No response — completion outcome unknown',{exact:true}).waitFor();assert.equal((await saved(f)).accepted,null);
 f.completion.malformed=false;await f.page.getByRole('button',{name:'Recover original completion receipt',exact:true}).click();await acceptance(f);assert.equal(f.completion.effects,1);
}));
await test('permission loss hides cached private acceptance but retains its immutable local record',()=>fixture(async f=>{
 await f.open();await submit(f);await acceptance(f);f.completion.readDenied=true;await f.page.getByRole('button',{name:'Refresh completion requirements',exact:true}).click();
 await f.page.getByText('Completion access was refused.',{exact:false}).waitFor();assert.equal(await f.page.locator('.completion-accepted').count(),0);assert.ok((await saved(f)).accepted);
}));
await test('changed_intent_same_key: 23505 is conflict, not success or a new automatic retry',()=>fixture(async f=>{
 f.completion.fail=scenarios.changed_intent_same_key.changed_payload;await f.open();await submit(f);await f.page.getByText(f.completion.fail.message,{exact:true}).waitFor();assert.equal((await saved(f)).pending.state,'conflict');assert.equal(f.completion.effects,0);
}));
await test('leaving the visit closes the review overlay without declaring completion',()=>fixture(async f=>{
 await f.open();await review(f);await f.page.evaluate(()=>location.hash='/');await f.page.getByRole('heading',{name:"Today's schedule",exact:true}).waitFor();assert.equal(await f.page.getByRole('dialog').count(),0);assert.equal(f.completion.effects,0);
}));
await test('offline finish is provisional, saved queue survives reload, reconnect is server acceptance only',()=>fixture(async f=>{
 await f.open();await f.page.goto(`${BASE}/admin/field.html`);await f.page.getByRole('heading',{name:"Today's schedule",exact:true}).waitFor();await f.prepare();await f.offline();await f.page.goto(`${BASE}/admin/field.html#/visit/${JOB}`);await f.page.locator('.field-completion').getByText('Saved requirements',{exact:false}).waitFor();
 await f.page.getByRole('button',{name:'Refresh completion requirements',exact:true}).click();await submit(f);
 await f.page.getByText('Work finished provisionally — queued for server review',{exact:true}).waitFor();assert.equal(f.completion.effects,0);const before=(await saved(f)).pending;
 await f.page.reload();await f.page.getByText('Work finished provisionally — queued for server review',{exact:true}).waitFor();assert.deepEqual((await saved(f)).pending.args,before.args);
 await f.offline(false);await f.page.evaluate(async()=>{await (await import('/admin/js/lib/offline-queue.js')).flush();});await acceptance(f);assert.equal(f.completion.effects,1);
}));
await test('active marker 2 blocks the old app validator without deleting pending completion or legacy bytes',()=>fixture(async f=>{
 await f.open();await f.offline();await submit(f);
 const error=await f.page.evaluate(async()=>{const req=indexedDB.open('ns-field-outbox');const db=await new Promise(resolve=>req.onsuccess=()=>resolve(req.result));try{await (await import('/tests/data/outbox-schema-before-completion.mjs')).validateOutbox(db);return 'wrongly accepted';}catch(error){return error.message;}finally{db.close();}});
 assert.match(error,/unknown schema version/);assert.equal((await saved(f)).pending.recordVersion,2);
}));
await test('real Chromium process restart retains request bytes, explicit retry key and one acceptance effect',async()=>{
 const profile=mkdtempSync(join(tmpdir(),'nova-completion-restart-'));let context=await pw.chromium.launchPersistentContext(profile,{...launch,viewport:{width:390,height:900},serviceWorkers:'block'});
 let f=await completionFixture(browser,{persistentContext:context});const state=f.completion;
 try {
  await f.open();state.lost=true;await submit(f);await f.page.getByText('No response — completion outcome unknown',{exact:true}).waitFor();const before=clone((await saved(f)).pending.args);
  await context.close();context=await pw.chromium.launchPersistentContext(profile,{...launch,viewport:{width:390,height:900},serviceWorkers:'block'});f=await completionFixture(browser,{persistentContext:context,completionState:state});state.lost=false;await f.open();
  assert.deepEqual((await saved(f)).pending.args,before);await f.page.getByRole('button',{name:'Recover original completion receipt',exact:true}).click();await acceptance(f);assert.equal(state.effects,1);assert.deepEqual(calls(f,'complete_job_with_evidence').at(-1).args,before.payload);
 }finally{await context.close();}
});
await test('legacy File/Blob actions retain bytes beside marker-2 completion and all five drain once',()=>fixture(async f=>{
 await f.open();await f.offline();
 await f.page.evaluate(async job=>{const q=await import('/admin/js/lib/offline-queue.js');
  await q.callOrQueue('updateProperty',{id:'property-'+job,patch:{passport:{preferences:'Legacy bytes'}}},'Legacy passport',{jobId:job});
  await q.callOrQueue('createMeasurement',{jobId:job,measurement:{quantity:9}},'Legacy measurement',{jobId:job});
  await q.callOrQueue('uploadJobPhoto',{jobId:job,file:new File([new Uint8Array([0,255,42])],'legacy.png',{type:'image/png'}),opts:{kind:'before'}},'Legacy photo',{jobId:job});
  await q.callOrQueue('saveSignature',{jobId:job,quoteId:'quote-1',pngBlob:new Blob([new Uint8Array([9,0,255])],{type:'image/png'}),signerName:'Legacy'},'Legacy signature',{jobId:job});
 },JOB);
 await submit(f);await f.page.getByText('Work finished provisionally — queued for server review',{exact:true}).waitFor();const rows=await f.page.evaluate(async()=>{const r=indexedDB.open('ns-field-outbox');const db=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result));try{const t=db.transaction('queue');const req=t.objectStore('queue').getAll();return await new Promise(resolve=>req.onsuccess=async()=>{const rows=req.result;resolve({count:rows.length,file:Array.from(new Uint8Array(await rows.find(r=>r.type==='uploadJobPhoto').args.file.arrayBuffer())),signature:Array.from(new Uint8Array(await rows.find(r=>r.type==='saveSignature').args.pngBlob.arrayBuffer()))});});}finally{db.close();}});
 assert.equal(rows.count,5);assert.deepEqual(rows.file,[0,255,42]);assert.deepEqual(rows.signature,[9,0,255]);await f.offline(false);await f.page.evaluate(async()=>{await (await import('/admin/js/lib/offline-queue.js')).flush();});await acceptance(f);
 assert.equal(f.completion.effects,1);assert.deepEqual(f.state.writes.map(row=>row.name),['updateProperty','createMeasurement','uploadJobPhoto','uploadSignature','saveQuoteSignature']);
}));
await test('an unanswered completion cannot be discarded or replaced by a second key',()=>fixture(async f=>{
 await f.open();f.completion.lost=true;await submit(f);await f.page.getByText('No response — completion outcome unknown',{exact:true}).waitFor();
 await assert.rejects(f.page.evaluate(async job=>{const q=await import('/admin/js/lib/offline-queue.js');const s=await q.completionState(job);await q.discard(s.pending.id);},JOB),/may already be accepted/);
 assert.equal((await saved(f)).pending.outcome,'unknown');assert.equal(f.completion.effects,1);
}));
await test('storage failure before completion commit sends nothing and keeps the raw draft',()=>fixture(async f=>{
 await f.open();await review(f);await f.page.evaluate(()=>{indexedDB.open=()=>{throw new DOMException('Injected completion quota','QuotaExceededError');};});
 const d=f.page.getByRole('dialog');await d.getByLabel('I reviewed the evidence, material usage and work finished declaration.',{exact:true}).check();await d.getByRole('button',{name:'Submit reviewed completion'}).click();
 await f.page.getByText('Injected completion quota',{exact:true}).waitFor();assert.equal(calls(f,'complete_job_with_evidence').length,0);
}));
await test('usage records explicit location/precision, level remains nonnumeric, additional work has no amount',()=>fixture(async f=>{
 await f.open();await f.page.getByText('Material usage — physical observations',{exact:true}).click();await f.page.getByRole('button',{name:'Add usage observation',exact:true}).click();
 await f.page.getByLabel('Used quantity (litre) — Cleaning product',{exact:true}).fill('12.5');await f.page.getByLabel('Usage accuracy — Cleaning product',{exact:true}).selectOption('estimated');await f.page.getByLabel('Usage location — Cleaning product',{exact:true}).selectOption('car_a');
 await f.page.getByLabel('Material to report',{exact:true}).selectOption('material-level');await f.page.getByRole('button',{name:'Add usage observation',exact:true}).click();
 await f.page.getByLabel('Used supply level — Cheap supply',{exact:true}).selectOption('low');await f.page.getByLabel('Usage location — Cheap supply',{exact:true}).selectOption('car_a');await f.page.getByLabel('Additional work for owner review (optional)',{exact:true}).fill('Extra windows');await submit(f);await acceptance(f);
 const payload=calls(f,'complete_job_with_evidence')[0].args;assert.deepEqual(payload.p_consumption,[{material_id:'material-product',location_code:'car_a',quantity:12.5,count_precision:'estimated'},{material_id:'material-level',location_code:'car_a',level:'low'}]);assert.deepEqual(payload.p_additional_work,[{description:'Extra windows'}]);
}));
await test('locked_history: accepted ledger and evidence are read-only; current reopening does not mutate receipt',()=>fixture(async f=>{
 await f.open();await submit(f);await acceptance(f);assert.equal(await f.page.getByLabel('Internal completion note',{exact:true}).isDisabled(),true);assert.equal((await saved(f)).accepted.receipt.completion.completion_id,f.completion.receipt.completion.completion_id);
 assert.equal(await f.page.getByRole('button',{name:'Register evidence purpose',exact:true}).count(),0);
}));
await test('register uses attachment ID and purpose/scope, never a guessed path or review GPS',()=>fixture(async f=>{
 f.state.attachments=[{id:'attachment-before',storage_path:'known/photo.png',kind:'before',size_bytes:20}];await f.open();await f.page.getByText('Register an uploaded photo as evidence',{exact:true}).click();await f.page.getByLabel('Capture GPS state',{exact:true}).selectOption('denied');
 await f.page.getByRole('button',{name:'Register evidence purpose',exact:true}).click();await f.page.getByText('Evidence registered:',{exact:false}).waitFor();
 const payload=calls(f,'register_job_evidence')[0].args;assert.equal(payload.p_attachment_id,'attachment-before');assert.equal(payload.p_service_key,'siding');assert.equal(payload.p_captured_at,null);assert.equal(payload.p_captured_lat,null);assert.equal(payload.p_gps_state,'denied');assert.match(payload.p_client_watermark,/capture time unknown/);
}));
await test('evidence lost response retains immutable request for explicit same-key retry',()=>fixture(async f=>{
 f.state.attachments=[{id:'attachment-before',kind:'before'}];f.completion.registerLost=true;await f.open();await f.page.getByText('Register an uploaded photo as evidence',{exact:true}).click();await f.page.getByRole('button',{name:'Register evidence purpose',exact:true}).click();
 await f.page.getByRole('button',{name:'Retry original evidence registration',exact:true}).waitFor();const first=clone(calls(f,'register_job_evidence')[0].args);f.completion.registerLost=false;f.completion.registerReplayed=true;
 await f.page.getByRole('button',{name:'Retry original evidence registration',exact:true}).click();await f.page.getByText('Evidence registered:',{exact:false}).waitFor();assert.deepEqual(calls(f,'register_job_evidence')[1].args,first);assert.equal(f.completion.registrations,1);
}));
await test('one_image_two_scopes: same attachment is registered deliberately twice without uploading twice',()=>fixture(async f=>{
 f.state.attachments=[{id:'one-image',kind:'after'}];f.completion.requirements=clone(scenarios.one_image_two_scopes.requirements);await f.open();
 await f.page.getByText('Register an uploaded photo as evidence',{exact:true}).click();await f.page.getByRole('button',{name:'Register evidence purpose',exact:true}).click();await f.page.getByText('Evidence registered:',{exact:false}).waitFor();
 await f.page.getByLabel('Evidence purpose and service scope',{exact:true}).selectOption('1');
 await Promise.all([f.page.waitForResponse(response=>response.url().endsWith('/__completion_fixture/register_job_evidence')),f.page.getByRole('button',{name:'Register evidence purpose',exact:true}).click()]);
 assert.equal(calls(f,'register_job_evidence').length,2);assert.equal(calls(f,'register_job_evidence')[0].args.p_attachment_id,'one-image');assert.equal(calls(f,'register_job_evidence')[1].args.p_attachment_id,'one-image');assert.equal(f.state.writes.filter(row=>row.name==='uploadJobPhoto').length,0);
}));
await test('job-scoped evidence on file remains visible when no per-service requirement counts it',()=>fixture(async f=>{
 f.completion.evidence=[{attachment_id:'job-photo',requirement:'before',service_id:null,capture_time_state:'unknown',gps_state:'unknown',received_at:'<timestamp>',frozen:false}];await f.open();assert.match(await f.page.locator('.field-completion').innerText(),/counting towards no per-service requirement/);
}));
await test('authorised_exception and reasoned_correction are read-only server facts, not crew approval controls',()=>fixture(async f=>{
 f.completion.requirements=clone(scenarios.authorised_exception.requirements_after);f.completion.exceptions=[{reason:scenarios.authorised_exception.exception.reason || 'owner-approved circumstance',authorised_at:'<timestamp>'}];
 f.completion.readiness.latest_completion_id=scenarios.reasoned_correction.corrected.completion.completion_id;f.completion.receipt=receiptFor(scenarios.reasoned_correction.corrected);
 await f.open();assert.match(await f.page.locator('.field-completion').innerText(),/Owner-authorised exception/);await f.page.getByText('Server completion history and corrections',{exact:true}).click();await f.page.getByText('Frozen acceptance',{exact:false}).waitFor();
 assert.equal(calls(f,'authorise_evidence_exception').length,0);assert.equal(calls(f,'correct_job_consumption').length,0);
}));
await test('accepted evidence photo removal is refused before the legacy delete API',()=>fixture(async f=>{
 f.state.attachments=[{id:'locked-photo',kind:'after',storage_path:'locked/photo.png'}];f.completion.evidence=[{attachment_id:'locked-photo',requirement:'after',frozen:true}];await f.open();
 f.page.once('dialog',dialog=>dialog.accept());await f.page.locator('.photo-grid__tile').first().click();await f.page.getByText('This photo is locked by an accepted completion. Ask the owner for a reasoned correction.',{exact:true}).waitFor();assert.equal(f.state.writes.filter(row=>row.name==='deleteAttachment').length,0);
}));
for(const width of [390,430,1200])await test(`review, keyboard cancellation, notes/usage controls and overflow at ${width}px`,()=>fixture(async f=>{
 f.state.attachments=[{id:'fixture-screenshot-photo',kind:'before',storage_path:'fixture.png'}];
 await f.open();await f.page.getByLabel('Internal completion note',{exact:true}).fill('Reviewed field note');await review(f);
 assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await f.page.getByRole('dialog',{name:'Review provisional completion',exact:true}).screenshot({path:join(evidence,`${width}-review.png`)});await f.page.keyboard.press('Escape');
 assert.equal(await f.page.locator('[data-completion-review]').evaluate(node=>node===document.activeElement),true);
 await f.page.locator('section.field-completion').screenshot({path:join(evidence,`${width}-evidence.png`),style:'.field-topbar{display:none !important}'});
 await f.page.getByText('Register an uploaded photo as evidence',{exact:true}).click();
 await f.page.getByLabel('Capture GPS state',{exact:true}).selectOption('unavailable');
 await f.page.locator('section.field-completion').screenshot({path:join(evidence,`${width}-registration.png`),style:'.field-topbar{display:none !important}'});
 await submit(f);await acceptance(f);await f.page.locator('section.field-completion').screenshot({path:join(evidence,`${width}-accepted.png`),style:'.field-topbar{display:none !important}'});
 assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
}, {width,hasTouch:true}));
await browser.close();writeFileSync(join(evidence,'results.json'),JSON.stringify({results,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length},null,2)+'\n');console.log(`${results.filter(r=>r.ok).length} PASS / ${results.filter(r=>!r.ok).length} FAIL`);if(results.some(r=>!r.ok))process.exitCode=1;
