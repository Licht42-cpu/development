import { pollBrowser } from './poll-browser.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offlineFixture, BASE, JOB, OWNER } from './offline-work-fixture.mjs';
const {default:pw}=await import(process.env.PLAYWRIGHT_MODULE||'/opt/node-tools/node_modules/playwright/index.js');
const options={executablePath:process.env.PLAYWRIGHT_CHROMIUM||'/opt/pw-browsers/chromium'};
const browser=await pw.chromium.launch(options);
const evidence=process.env.OFFLINE_EVIDENCE||join(tmpdir(),'nova-offline-work');mkdirSync(evidence,{recursive:true});
const results=[];
async function check(name,fn){if(process.env.OFFLINE_ONLY&&!name.includes(process.env.OFFLINE_ONLY))return;try{await fn();results.push({name,ok:true});console.log('PASS - '+name);}catch(error){results.push({name,ok:false,error:error.stack});console.log('FAIL - '+name+'\n'+error.stack);}}
async function fixture(fn,options){const f=await offlineFixture(browser,options);try{await fn(f);assert.deepEqual(f.errors,[]);}finally{f.state.release?.();await f.context.close();}}
async function queue(page,type,args,label='Fixture action',scope){return page.evaluate(async({type,args,label,scope})=>(await import('/admin/js/lib/offline-queue.js')).callOrQueue(type,args,label,scope),{type,args,label,scope});}
async function flush(page){return page.evaluate(async()=>(await import('/admin/js/lib/offline-queue.js')).flush());}
async function records(page){return page.evaluate(async()=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open('ns-field-outbox');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});try{return await new Promise((res,rej)=>{const r=db.transaction('queue').objectStore('queue').getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}finally{db.close();}});}

await check('Prefetch, offline restart and visit navigation preserve addresses, passport and notes',()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.reload();await f.page.getByRole('heading',{name:'Saved schedule'}).waitFor();
  const calls=f.state.calls.length;await f.page.getByRole('button',{name:'Open saved visit'}).first().click();await f.page.getByRole('heading',{name:'Saved Customer A',exact:true,level:1}).waitFor();
  assert.match(await f.page.locator('#view').innerText(),/123 Saved Street/);assert.equal(await f.page.getByLabel('Water tap location',{exact:true}).inputValue(),'Rear tap');
  await f.page.getByText('Watch the garden hose',{exact:true}).waitFor();
  assert.match(await f.page.locator('#view').innerText(),/Watch the garden hose/);assert.equal(f.state.calls.length,calls);
  await f.page.screenshot({path:join(evidence,'saved-visit-390.png'),fullPage:true});
}));
await check('Passport and note drafts survive a closed page and are labeled unsent',()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.reload();await f.visit();
  await f.page.getByLabel('Note',{exact:true}).fill('Do not lose this note');
  await f.page.getByLabel('Material',{exact:true}).fill('Unsubmitted vinyl');
  await pollBrowser(f.page,async()=>{const c=await import('/admin/js/lib/field-cache.js');return (await c.readDraft('11111111-1111-4111-8111-111111111111','note'))?.value.body==='Do not lose this note'&&(await c.readDraft('11111111-1111-4111-8111-111111111111','passport'))?.value['siding.material']==='Unsubmitted vinyl';});
  await f.page.reload();await f.page.getByLabel('Material',{exact:true}).waitFor();await f.page.getByLabel('Note',{exact:true}).waitFor();await f.page.waitForFunction(()=>document.querySelector('textarea[aria-label="Note"]').value==='Do not lose this note');
  assert.equal(await f.page.getByLabel('Material',{exact:true}).inputValue(),'Unsubmitted vinyl');assert.match(await f.page.locator('#view').innerText(),/not submitted|not sent/);
}));
await check('A note cannot be edited before its draft listener is ready',()=>fixture(async f=>{
  await f.prepare();
  const file='admin/js/lib/field-cache.js';
  const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
  const marker="  const existing = await readDraft(jobId, 'note');";
  assert.ok(source.includes(marker));
  await f.context.route('**/'+file,route=>route.fulfill({contentType:'application/javascript',body:source.replace(marker,
    "  await new Promise(resolve=>{globalThis.__finishNoteRestore=resolve;});\n"+marker)}));
  if(process.env.OFFLINE_BREAK==='note_ready'){
    const path='admin/js/views/field-offline.js';
    await f.context.route('**/'+path,route=>route.fulfill({contentType:'application/javascript',
      body:execFileSync('git',['show','c35d92b:'+path],{encoding:'utf8'})}));
  }
  await f.offline();await f.page.reload();await f.visit();
  await f.page.waitForFunction(()=>typeof __finishNoteRestore==='function');
  const note=f.page.getByLabel('Note',{exact:true});
  assert.equal(await note.isDisabled(),true);
  await f.page.evaluate(()=>__finishNoteRestore());
  await note.fill('A safely retained early observation');
  await pollBrowser(f.page,async id=>(await(await import('/admin/js/lib/field-cache.js')).readDraft(id,'note'))?.value.body==='A safely retained early observation',JOB);
  assert.equal(await f.page.getByLabel('Who can see it',{exact:true}).isEnabled(),true);
}));
await check('Management handoff commits a newly typed note before changing documents',()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.reload();await f.visit();
  await f.page.getByLabel('Note',{exact:true}).fill('Retain across the management document handoff');
  await f.page.getByRole('link',{name:'Management',exact:true}).click();
  await f.page.waitForURL('**/admin/index.html#/inventory');
  const saved=await f.page.evaluate(async id=>(await(await import('/admin/js/lib/field-cache.js')).readDraft(id,'note'))?.value.body,JOB);
  assert.equal(saved,'Retain across the management document handoff');
}));
await check('Offline passport saves survive restart as pending property facts',()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.reload();await f.visit();
  await f.page.getByLabel('Customer preferences',{exact:true}).fill('Rear gate must stay shut');await f.page.getByRole('button',{name:'Save passport',exact:true}).click();
  await f.page.getByText('Passport saved on this device — waiting to sync.',{exact:true}).waitFor();await f.page.reload();await f.page.getByLabel('Customer preferences',{exact:true}).waitFor();
  assert.equal(await f.page.getByLabel('Customer preferences',{exact:true}).inputValue(),'Rear gate must stay shut');assert.equal(f.state.writes.length,0);
}));
await check('Offline new measurements are saved without invoking pricing or unsupported writes',()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.reload();await f.visit();const before=f.state.calls.length;
  await f.page.getByLabel('New measurement quantity',{exact:true}).fill('12');await f.page.getByRole('button',{name:'Save new measurement locally'}).click();
  await f.page.getByText('Measurement saved on this device. Pricing requires a connection.',{exact:true}).waitFor();
  assert.equal(f.state.calls.length,before);assert.equal((await records(f.page))[0].type,'createMeasurement');
  assert.equal(await f.page.getByRole('button',{name:'Mark Job Complete'}).count(),0);
}));
await check('An uncached deep link reports unavailable rather than another job’s data',()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.goto(BASE+'/admin/field.html#/visit/99999999-9999-4999-8999-999999999999');
  await f.page.getByRole('heading',{name:'Visit not saved on this device'}).waitFor();assert.doesNotMatch(await f.page.locator('#view').innerText(),/Saved Customer A/);
}));
await check('Expired snapshots stop offline access without destroying pending actions',()=>fixture(async f=>{
  await f.prepare();await f.offline();await queue(f.page,'createMeasurement',{jobId:JOB,measurement:{quantity:5}});
  await f.page.evaluate(async()=>{const db=await new Promise(res=>{const r=indexedDB.open('ns-field-work');r.onsuccess=()=>res(r.result);});await new Promise((res,rej)=>{const tx=db.transaction('accounts','readwrite');const s=tx.objectStore('accounts');const r=s.get('offline-staff-a');r.onsuccess=()=>s.put({...r.result,savedAt:Date.now()-25*3600000});tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});db.close();});
  await f.page.reload();await f.page.getByRole('heading',{name:'Work unavailable offline'}).waitFor();assert.equal((await records(f.page)).length,1);
}));
await check('Account switching hides another account’s visits, drafts and photo payloads',()=>fixture(async f=>{
  await f.prepare();await f.offline();await queue(f.page,'uploadJobPhoto',{jobId:JOB,file:'placeholder',opts:{}});
  await f.page.evaluate(()=>__switchAccount('staff-b'));await f.page.getByRole('heading',{name:'Work unavailable offline'}).waitFor();
  const info=await f.page.evaluate(async()=>{const q=await import('/admin/js/lib/offline-queue.js');return {items:await q.pending(),photos:await q.pendingPhotos('11111111-1111-4111-8111-111111111111')};});
  assert.deepEqual(info,{items:[],photos:[]});assert.equal((await flush(f.page)).flushed.length,0);assert.equal(f.state.writes.length,0);assert.equal((await records(f.page)).length,1);
}));
await check('Logout removes read snapshots and preserves owned unsent actions',()=>fixture(async f=>{
  await f.prepare();await f.offline();await queue(f.page,'createMeasurement',{jobId:JOB,measurement:{quantity:5}});
  await f.offline(false);await f.page.locator('#signOut').click();await f.page.getByRole('button',{name:'Sign in',exact:true}).waitFor();
  assert.equal((await records(f.page)).length,1);assert.equal(await f.page.evaluate(()=>localStorage.getItem('ns-field-active-account')),null);
  await f.page.evaluate(()=>__switchAccount( 'offline-staff-a'));await f.page.getByRole('heading',{name:"Today's schedule"}).waitFor();
  assert.equal(await f.page.evaluate(async()=>!!await(await import('/admin/js/lib/field-cache.js')).snapshot()),false);
}));
await check('Offline or rejected logout never falsely announces successful sign-out',()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.locator('#signOut').click();
  await f.page.getByText('Reconnect to sign out. Your saved work remains in this account.',{exact:true}).waitFor();
  await f.offline(false);await f.page.evaluate(()=>window.__logoutError=true);await f.page.locator('#signOut').click();
  await f.page.getByText('Could not sign out: Injected logout failed',{exact:true}).waitFor();
  assert.equal(await f.page.evaluate(()=>localStorage.getItem('ns-field-active-account')),OWNER);
  assert.equal(await f.page.evaluate(async()=>!!await(await import('/admin/js/lib/field-cache.js')).snapshot()),true);
}));
await check('Revoked online access never falls back to cached private work',()=>fixture(async f=>{
  await f.prepare();f.state.denied=true;await f.page.goto(BASE+'/admin/field.html#/visit/'+JOB);await f.page.getByRole('heading',{name:'Could not load this screen'}).waitFor();
  assert.match(await f.page.locator('#view').innerText(),/Permission denied/);await f.offline();await f.page.reload();await f.page.getByRole('heading',{name:'Work unavailable offline'}).waitFor();
}));
await check('Replay revalidates revoked targets before sending and retains their payload',()=>fixture(async f=>{
  await f.prepare();await f.offline();await queue(f.page,'createMeasurement',{jobId:JOB,measurement:{quantity:5}});await f.offline(false);f.state.denied=true;
  const result=await flush(f.page);assert.match(result.error,/Permission denied/);assert.equal(f.state.writes.length,0);assert.equal((await records(f.page)).length,1);
}));
await check('Reconnecting replays supported writes in order and removes them only after success',()=>fixture(async f=>{
  await f.prepare();await f.offline();await queue(f.page,'createMeasurement',{jobId:JOB,measurement:{quantity:5}},'First');await queue(f.page,'createMeasurement',{jobId:JOB,measurement:{quantity:6}},'Second');await f.offline(false);
  const result=await flush(f.page);assert.deepEqual(result.flushed,['First','Second']);assert.deepEqual(f.state.writes.map(x=>x.args[1].quantity),[5,6]);assert.equal((await records(f.page)).length,0);
}));
await check('Denied replay immediately hides an already-open cached visit and retains its unsent work',()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.reload();await f.visit();
  await f.page.getByLabel('Note',{exact:true}).fill('Retain my unsent observation');
  await pollBrowser(f.page,async()=>(await(await import('/admin/js/lib/field-cache.js')).readDraft('11111111-1111-4111-8111-111111111111','note'))?.value.body==='Retain my unsent observation');
  await queue(f.page,'createMeasurement',{jobId:JOB,measurement:{quantity:5}});
  f.state.denied=true;await f.offline(false);await flush(f.page);
  await f.page.getByRole('heading',{name:'Saved access no longer available'}).waitFor();
  assert.doesNotMatch(await f.page.locator('#view').innerText(),/Saved Customer A|123 Saved Street|Watch the garden hose/);
  assert.equal((await records(f.page)).length,1);assert.equal(f.state.writes.length,0);
  assert.equal(await f.page.evaluate(async()=>(await(await import('/admin/js/lib/field-cache.js')).readDraft('11111111-1111-4111-8111-111111111111','note')).value.body),'Retain my unsent observation');
  await f.page.screenshot({path:join(evidence,'denied-replay-390.png'),fullPage:true});
}));
await check('Denied work stays retired after reload even if its cache deletion failed',()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.reload();await f.visit();await queue(f.page,'createMeasurement',{jobId:JOB,measurement:{quantity:5}});
  await f.page.evaluate(()=>{const open=indexedDB.open.bind(indexedDB);indexedDB.open=(name,...args)=>{if(name==='ns-field-work')throw new DOMException('Cache cleanup unavailable','InvalidStateError');return open(name,...args);};});
  f.state.denied=true;await f.offline(false);await flush(f.page);await f.page.getByRole('heading',{name:'Saved access no longer available'}).waitFor();
  await f.offline();await f.page.reload();await f.page.getByRole('heading',{name:'Work unavailable offline'}).waitFor();
  assert.equal((await records(f.page)).length,1);
  assert.ok(await f.page.evaluate(async()=>(await(await import('/admin/js/lib/field-cache.js')).snapshot())),'Stored bytes still exist, so retirement rather than deletion must protect this read');
  f.state.denied=false;await f.offline(false);await f.page.evaluate(()=>location.hash='/');await f.page.getByRole('heading',{name:"Today's schedule"}).waitFor();await f.prepare();
  await f.offline();await f.page.reload();await f.page.getByRole('heading',{name:'Saved schedule'}).waitFor();
}));
await check('Photo bytes commit before network I/O; a lost response is held for explicit review',()=>fixture(async f=>{
  await f.prepare();f.state.lost='uploadJobPhoto';
  const result=await f.page.evaluate(async()=>{const q=await import('/admin/js/lib/offline-queue.js');return q.callOrQueue('uploadJobPhoto',{jobId:'11111111-1111-4111-8111-111111111111',file:new File(['original-photo-bytes'],'before.jpg',{type:'image/jpeg'}),opts:{kind:'before'}},'Photo upload');});
  assert.equal(result.queued,true);assert.equal(result.uncertain,true);const calls=f.state.writes.length;f.state.lost=null;await flush(f.page);assert.equal(f.state.writes.length,calls);
  await f.offline();await f.page.reload();await f.visit();
  const photo=await f.page.evaluate(async()=>{const rows=await(await import('/admin/js/lib/offline-queue.js')).pendingPhotos('11111111-1111-4111-8111-111111111111');return {text:await rows[0].file.text(),name:rows[0].file.name,state:rows[0].state};});
  assert.deepEqual(photo,{text:'original-photo-bytes',name:'before.jpg',state:'uncertain'});await f.page.locator('#syncBadge').click();await f.page.getByRole('button',{name:'Review and retry'}).waitFor();
  await f.page.screenshot({path:join(evidence,'uncertain-send-390.png'),fullPage:true});
}));
await check('A signature resumes its saved upload path without uploading again after a rejected RPC',()=>fixture(async f=>{
  f.state.fail.saveQuoteSignature='Quote cannot currently be accepted';
  await f.page.evaluate(async()=>{try{await(await import('/admin/js/lib/offline-queue.js')).callOrQueue('saveSignature',{jobId:'11111111-1111-4111-8111-111111111111',quoteId:'quote-1',pngBlob:new Blob(['png'],{type:'image/png'}),signerName:'Signer'},'Signature');}catch{}});
  assert.equal((await records(f.page))[0].uploadPath,'saved/signature.png');f.state.fail.saveQuoteSignature=null;await flush(f.page);
  assert.equal(f.state.writes.filter(x=>x.name==='uploadSignature').length,1);assert.equal(f.state.writes.filter(x=>x.name==='saveQuoteSignature').length,1);
}));
await check('A lost signature response reconciles the matching server signature after explicit review',()=>fixture(async f=>{
  f.state.lost='saveQuoteSignature';
  await f.page.evaluate(async()=>{await(await import('/admin/js/lib/offline-queue.js')).callOrQueue('saveSignature',{jobId:'11111111-1111-4111-8111-111111111111',quoteId:'quote-1',pngBlob:new Blob(['png'],{type:'image/png'}),signerName:'Signer'},'Signature');});
  f.state.lost=null;assert.equal((await records(f.page))[0].state,'uncertain');
  await f.page.evaluate(async()=>{const q=await import('/admin/js/lib/offline-queue.js');await q.confirmRetry((await q.pending())[0].id);await q.flush();});
  assert.equal(f.state.writes.filter(x=>x.name==='uploadSignature').length,1);assert.equal(f.state.writes.filter(x=>x.name==='saveQuoteSignature').length,1);assert.equal((await records(f.page)).length,0);
}));
await check('Different tabs share one replay lock and cannot execute the same head twice',()=>fixture(async f=>{
  await f.offline();await queue(f.page,'createMeasurement',{jobId:JOB,measurement:{quantity:5}});
  const second=await f.context.newPage();await second.goto(BASE+'/admin/field.html');await second.getByRole('heading',{name:'Work unavailable offline'}).waitFor();
  f.state.hold='createMeasurement';const accepted=new Promise(resolve=>f.state.onWrite=resolve);await f.offline(false);
  const attempts=Promise.all([flush(f.page),flush(second)]);
  // Hold the actual first server write while another tab requests replay.
  // This makes overlap deterministic rather than relying on request timing.
  try {
    await accepted;await pollBrowser(second,async()=>(await navigator.locks.query()).pending.some(lock=>lock.name==='ns-field-outbox-replay'));
    assert.equal(f.state.writes.filter(x=>x.name==='createMeasurement').length,1);
  } finally { f.state.release?.();await attempts;await second.close(); }
  assert.equal(f.state.writes.filter(x=>x.name==='createMeasurement').length,1);
}));
await check('Offline passport replay preserves unrelated server fields',()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.reload();await f.visit();await f.page.getByLabel('Material',{exact:true}).fill('Vinyl');await f.page.getByRole('button',{name:'Save passport',exact:true}).click();await f.page.getByText('Passport saved on this device — waiting to sync.',{exact:true}).waitFor();
  f.state.extraPassport={office_fact:'Keep me'};await f.offline(false);await flush(f.page);const passport=f.state.writes.find(x=>x.name==='updateProperty').args[1].passport;
  assert.equal(passport.office_fact,'Keep me');assert.equal(passport.siding.material,'Vinyl');
}));
await check('A conflicting server passport edit stops replay rather than overwriting it',()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.reload();await f.visit();await f.page.getByLabel('Customer preferences',{exact:true}).fill('My offline preference');await f.page.getByRole('button',{name:'Save passport',exact:true}).click();await f.page.getByText('Passport saved on this device — waiting to sync.',{exact:true}).waitFor();
  f.state.extraPassport={preferences:'Changed by office'};await f.offline(false);const result=await flush(f.page);assert.match(result.error,/Passport conflict/);assert.equal(f.state.writes.length,0);assert.equal((await records(f.page)).length,1);
}));
await check('Connection loss while the browser reports online uses the saved snapshot',()=>fixture(async f=>{
  await f.prepare();f.state.offline=true;await f.page.goto(BASE+'/admin/field.html#/visit/'+JOB);
  await f.page.getByRole('heading',{name:'Saved Customer A',exact:true,level:1}).waitFor();
  assert.match(await f.page.locator('#view').innerText(),/Showing saved work/);
}));
await check('Changing accounts closes private outbox dialogs immediately',()=>fixture(async f=>{
  await f.offline();await queue(f.page,'createMeasurement',{jobId:JOB,measurement:{quantity:5}},'Private action A');
  await f.page.locator('#syncBadge').click();await f.page.getByText('Private action A',{exact:true}).waitFor();
  await f.page.evaluate(()=>__switchAccount('staff-b'));await f.page.getByRole('heading',{name:'Work unavailable offline'}).waitFor();
  assert.equal(await f.page.getByRole('dialog').count(),0);assert.doesNotMatch(await f.page.locator('body').innerText(),/Private action A/);
}));
await check('A detached old-account action cannot be persisted as the new account’s action',()=>fixture(async f=>{
  await f.page.evaluate(()=>__switchAccount('staff-b'));
  const error=await f.page.evaluate(async()=>{try{await(await import('/admin/js/lib/offline-queue.js')).callOrQueue('createMeasurement',{jobId:'11111111-1111-4111-8111-111111111111',measurement:{quantity:5}},'Old action',{ownerId:'offline-staff-a'});}catch(error){return error.message;}});
  assert.match(error,/Account changed/);assert.equal((await records(f.page)).length,0);assert.equal(f.state.writes.length,0);
}));
await check('A pending quantity timer cannot save after its account’s screen is removed',()=>fixture(async f=>{
  await f.page.goto(BASE+'/admin/field.html#/visit/'+JOB);await f.page.getByRole('spinbutton',{name:'Quantity',exact:true}).waitFor();
  await f.page.getByRole('spinbutton',{name:'Quantity',exact:true}).fill('9');await f.page.evaluate(()=>__switchAccount('staff-b'));
  await f.page.getByRole('heading',{name:'Saved Customer A',exact:true,level:1}).waitFor();
  await f.page.waitForTimeout(450);
  assert.equal(f.state.writes.filter(x=>x.name==='updateMeasurement').length,0);
}));
await check('Storage failure refuses photo saving before any server upload',()=>fixture(async f=>{
  await f.page.evaluate(()=>indexedDB.open=()=>{throw new DOMException('Photo storage quota exceeded','QuotaExceededError');});
  const error=await f.page.evaluate(async()=>{try{await(await import('/admin/js/lib/offline-queue.js')).callOrQueue('uploadJobPhoto',{jobId:'11111111-1111-4111-8111-111111111111',file:new Blob(['keep-photo'],{type:'image/jpeg'}),opts:{}},'Photo');}catch(error){return error.message;}});
  assert.match(error,/quota exceeded/);assert.equal(f.state.writes.length,0);
}));
await check('An interrupted in-flight send survives page closure and does not replay automatically',()=>fixture(async f=>{
  f.state.hold='createMeasurement';
  const accepted=new Promise(resolve=>f.state.onWrite=resolve);
  await f.page.evaluate(()=>{window.__sending=(async()=>{await(await import('/admin/js/lib/offline-queue.js')).callOrQueue('createMeasurement',{jobId:'11111111-1111-4111-8111-111111111111',measurement:{quantity:5}},'Interrupted measurement');})();});
  await pollBrowser(f.page,async()=>{const q=await import('/admin/js/lib/offline-queue.js');return (await q.pending())[0]?.state==='uncertain';});
  await Promise.race([accepted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('The fixture never received the in-flight write.')),7000))]);
  const old=f.page;const replacement=await f.context.newPage();replacement.setDefaultTimeout(7000);await old.close();f.state.hold=null;f.state.release?.();
  await replacement.goto(BASE+'/admin/field.html');await replacement.getByRole('heading',{name:"Today's schedule"}).waitFor();await flush(replacement);
  assert.equal(f.state.writes.filter(x=>x.name==='createMeasurement').length,1);
  assert.equal(await replacement.evaluate(async()=>(await(await import('/admin/js/lib/offline-queue.js')).pending())[0].state),'uncertain');
  await replacement.close();
}));
await check('A failed preparation keeps the previous complete snapshot',()=>fixture(async f=>{
  await f.prepare();const savedAt=await f.page.evaluate(async()=>(await(await import('/admin/js/lib/field-cache.js')).snapshot()).savedAt);
  f.state.fail.listNotes='Notes temporarily unavailable';await f.page.getByRole('button',{name:'Save work for offline',exact:true}).click();await f.page.getByText('Work not saved: Notes temporarily unavailable',{exact:true}).waitFor();
  assert.equal(await f.page.evaluate(async()=>(await(await import('/admin/js/lib/field-cache.js')).snapshot()).savedAt),savedAt);
}));
await check('Prefetch is bounded to twenty visits and says when the schedule is truncated',()=>fixture(async f=>{
  await f.prepare();assert.equal(await f.page.evaluate(async()=>Object.keys((await(await import('/admin/js/lib/field-cache.js')).snapshot()).jobs).length),20);
  assert.match(await f.page.locator('#view').innerText(),/first 20 visits/);
},{jobs:21}));
await check('Storage failure never claims that work was saved',()=>fixture(async f=>{
  await f.page.evaluate(()=>indexedDB.open=()=>{throw new DOMException('Quota exceeded','QuotaExceededError');});
  await f.page.getByRole('button',{name:'Save work for offline',exact:true}).click();await f.page.getByText('Work not saved: Quota exceeded',{exact:true}).waitFor();
  assert.equal(await f.page.getByText(/visits saved for offline/).count(),0);
}));
await check('Preparation caches job flags and pricing-rule metadata without invoking pricing',()=>fixture(async f=>{
  await f.prepare();
  const saved=await f.page.evaluate(async()=>(await import('/admin/js/lib/field-cache.js')).usableSnapshot());
  assert.equal(saved.refs.pricingRules[0].description,'Original reference');
  assert.equal(saved.jobs[JOB].flags[0].note,'Keep the side gate clear');
  assert.equal(f.state.calls.filter(row=>row.name==='calculatePricing').length,0);
  await f.offline();await f.page.reload();await f.visit();
  assert.match(await f.page.locator('#view').innerText(),/Difficult access: Keep the side gate clear/);
}));
await check('Reference refresh is independent of visit facts and preparation reuses fresh references',()=>fixture(async f=>{
  await f.prepare();
  const first=await f.page.evaluate(async()=>({work:await(await import('/admin/js/lib/field-cache.js')).snapshot(),saved:await(await import('/admin/js/lib/field-cache.js')).usableSnapshot()}));
  const reads=f.state.calls.filter(row=>row.name==='listPricingRules').length;
  f.state.referenceText='Updated office reference';await f.prepare();
  assert.equal(f.state.calls.filter(row=>row.name==='listPricingRules').length,reads);
  const before=await f.page.evaluate(async()=>(await(await import('/admin/js/lib/field-cache.js')).snapshot()).savedAt);
  await f.page.getByRole('button',{name:'Refresh offline reference data',exact:true}).click();
  await f.page.getByText(/Reference data saved .* for seven days/).waitFor();
  const after=await f.page.evaluate(async()=>(await(await import('/admin/js/lib/field-cache.js')).usableSnapshot()));
  assert.equal(after.savedAt,before);assert.notEqual(after.refsSavedAt,first.saved.refsSavedAt);
  assert.equal(after.refs.pricingRules[0].description,'Updated office reference');
}));
await check('Expired references keep saved visit facts readable but stop new measurement entry',()=>fixture(async f=>{
  await f.prepare();
  await f.page.evaluate(async()=>{const db=await new Promise(res=>{const r=indexedDB.open('ns-field-work');r.onsuccess=()=>res(r.result);});await new Promise((res,rej)=>{const tx=db.transaction('references','readwrite');const store=tx.objectStore('references');const r=store.get('offline-staff-a');r.onsuccess=()=>store.put({...r.result,savedAt:Date.now()-8*86400000});tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});db.close();});
  await f.offline();await f.page.reload();await f.visit();
  assert.match(await f.page.locator('#view').innerText(),/Reference data expired or unavailable/);
  assert.equal(await f.page.getByRole('button',{name:'Save new measurement locally'}).isDisabled(),true);
  assert.match(await f.page.locator('#view').innerText(),/123 Saved Street/);
  await f.page.screenshot({path:join(evidence,'expired-references-390.png'),fullPage:true});
}));
await check('The seven-day horizon excludes later visits and duplicate rows do not consume the bound',()=>fixture(async f=>{
  const result=await f.page.evaluate(async jobId=>{
    const job=(await import('/admin/js/lib/api.js')).getJob;
    const today=await job(jobId);
    const day=new Date();day.setHours(12,0,0,0);day.setDate(day.getDate()+7);
    const seventh={...today,id:'seventh-day',scheduled_for:day.toISOString()};
    day.setDate(day.getDate()+1);
    const eighth={...today,id:'eighth-day',scheduled_for:day.toISOString()};
    const c=await import('/admin/js/lib/field-cache.js');const prepared=await c.prepareWork([today,today],[seventh,eighth]);
    return {prepared,data:await c.snapshot()};
  },JOB);
  assert.deepEqual(Object.keys(result.data.jobs),[JOB,'seventh-day']);
  assert.equal(result.prepared.excluded,1);assert.equal(result.prepared.truncated,false);
}));
await check('The ten-megabyte bound counts references and visit facts together',()=>fixture(async f=>{
  f.state.referenceText='R'.repeat(5*1024*1024);f.state.noteText='N'.repeat(6*1024*1024);
  await f.page.getByRole('button',{name:'Save work for offline',exact:true}).click();
  await f.page.getByText('Work not saved: Work exceeds the 10 MB offline limit. Reduce the selected schedule.',{exact:true}).waitFor();
  assert.equal(await f.page.evaluate(async()=>(await(await import('/admin/js/lib/field-cache.js')).snapshot())),undefined);
  assert.equal(await f.page.getByText(/visits saved for offline/).count(),0);
},{jobs:1}));
await check('An aborted write transaction cannot announce that work was saved',()=>fixture(async f=>{
  await f.page.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){const req=put.apply(this,args);if(this.name==='accounts')req.addEventListener('success',()=>this.transaction.abort(),{once:true});return req;};});
  await f.page.getByRole('button',{name:'Save work for offline',exact:true}).click();
  await f.page.getByText(/Work not saved:/).waitFor();
  assert.equal(await f.page.getByText(/visits saved for offline/).count(),0);
  assert.equal(await f.page.evaluate(async()=>(await(await import('/admin/js/lib/field-cache.js')).snapshot())),undefined);
}));
await check('An empty work store degrades truthfully and retains separately stored photo bytes',()=>fixture(async f=>{
  await f.prepare();await f.offline();
  await f.page.evaluate(async()=>{await(await import('/admin/js/lib/offline-queue.js')).callOrQueue('uploadJobPhoto',{jobId:'11111111-1111-4111-8111-111111111111',file:new Blob(['still-owned-photo']),opts:{}},'Saved photo');await new Promise((res,rej)=>{const r=indexedDB.deleteDatabase('ns-field-work');r.onsuccess=res;r.onerror=()=>rej(r.error);});});
  await f.page.reload();await f.page.getByRole('heading',{name:'Work unavailable offline'}).waitFor();
  assert.equal(await f.page.evaluate(async()=>(await(await import('/admin/js/lib/offline-queue.js')).pendingPhotos('11111111-1111-4111-8111-111111111111'))[0].file.text()),'still-owned-photo');
  await f.page.screenshot({path:join(evidence,'empty-work-390.png'),fullPage:true});
}));
await check('A blocked populated outbox upgrade has a retry screen and preserves full legacy bytes',()=>fixture(async f=>{
  const blocker=await f.context.newPage();await blocker.goto(BASE+'/tests/README.md');
  await blocker.evaluate(async()=>{window.__heldDb=await new Promise(res=>{const r=indexedDB.open('ns-field-outbox',1);r.onupgradeneeded=()=>r.result.createObjectStore('queue',{keyPath:'id',autoIncrement:true});r.onsuccess=()=>res(r.result);});await new Promise(res=>{const tx=__heldDb.transaction('queue','readwrite');tx.objectStore('queue').add({type:'uploadJobPhoto',createdAt:42,args:{jobId:'legacy-job',file:new Blob(['blocked-legacy-photo'])}});tx.oncomplete=res;});});
  await f.page.goto(BASE+'/admin/field.html');await f.page.getByRole('heading',{name:'Could not start Nova Shield'}).waitFor();
  assert.match(await f.page.locator('#view').innerText(),/Close other app tabs/);
  await f.page.screenshot({path:join(evidence,'blocked-upgrade-390.png'),fullPage:true});
  await blocker.evaluate(()=>__heldDb.close());await blocker.close();
  await f.page.getByRole('button',{name:'Retry startup'}).click();await f.page.getByRole('heading',{name:"Today's schedule"}).waitFor();
  const saved=await records(f.page);assert.equal(saved.length,1);
  assert.equal(await f.page.evaluate(async()=>{const db=await new Promise(res=>{const r=indexedDB.open('ns-field-outbox');r.onsuccess=()=>res(r.result);});try{return await new Promise(res=>{const r=db.transaction('queue').objectStore('queue').getAll();r.onsuccess=()=>res(r.result[0].args.file.text());});}finally{db.close();}}),'blocked-legacy-photo');
},{open:false}));
await check('Upgrading the populated work store preserves its snapshot and note draft',()=>fixture(async f=>{
  await f.page.goto(BASE+'/tests/README.md');
  await f.page.evaluate(async()=>{localStorage.setItem('ns-field-active-account','offline-staff-a');const db=await new Promise(res=>{const r=indexedDB.open('ns-field-work',1);r.onupgradeneeded=()=>{r.result.createObjectStore('accounts',{keyPath:'id'});r.result.createObjectStore('drafts',{keyPath:'key'});};r.onsuccess=()=>res(r.result);});await new Promise(res=>{const tx=db.transaction(['accounts','drafts'],'readwrite');tx.objectStore('accounts').put({id:'offline-staff-a',version:1,savedAt:Date.now(),jobs:{},refs:{services:[]},today:[],upcoming:[]});tx.objectStore('drafts').put({key:['offline-staff-a','old-job','note'],value:{body:'Old draft'},savedAt:42});tx.oncomplete=res;});db.close();});
  await f.offline();await f.page.goto(BASE+'/admin/field.html');await f.page.getByRole('heading',{name:'Saved schedule'}).waitFor();
  const info=await f.page.evaluate(async()=>{const c=await import('/admin/js/lib/field-cache.js');return {work:await c.snapshot(),draft:await c.readDraft('old-job','note')};});
  assert.equal(info.work.version,1);assert.equal(info.draft.value.body,'Old draft');assert.equal(info.draft.savedAt,42);
},{open:false}));
await check('A blocked work-store upgrade reports failure and recovers when its old tab closes',()=>fixture(async f=>{
  const blocker=await f.context.newPage();await blocker.goto(BASE+'/tests/README.md');
  await blocker.evaluate(async()=>{window.__heldDb=await new Promise(res=>{const r=indexedDB.open('ns-field-work',1);r.onupgradeneeded=()=>{r.result.createObjectStore('accounts',{keyPath:'id'});r.result.createObjectStore('drafts',{keyPath:'key'});};r.onsuccess=()=>res(r.result);});await new Promise(res=>{const tx=__heldDb.transaction('accounts','readwrite');tx.objectStore('accounts').put({id:'offline-staff-a',version:1,savedAt:Date.now(),refs:{services:[]},jobs:{},today:[],upcoming:[]});tx.oncomplete=res;});});
  await f.page.goto(BASE+'/tests/README.md');await f.page.evaluate(()=>localStorage.setItem('ns-field-active-account','offline-staff-a'));await f.offline();
  await f.page.goto(BASE+'/admin/field.html');await f.page.getByRole('heading',{name:'Could not load this screen'}).waitFor();
  assert.match(await f.page.locator('#view').innerText(),/Close other app tabs/);
  await blocker.evaluate(()=>__heldDb.close());await blocker.close();
  await f.page.getByRole('button',{name:'Retry',exact:true}).click();await f.page.getByRole('heading',{name:'Saved schedule'}).waitFor();
},{open:false}));
await check('A temporary storage exception can be retried without erasing saved work',()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.evaluate(()=>{window.__openIdb=indexedDB.open.bind(indexedDB);indexedDB.open=()=>{throw new DOMException('Temporary storage unavailable','InvalidStateError');};location.hash='/visit/11111111-1111-4111-8111-111111111111';});
  await f.page.getByRole('heading',{name:'Could not load this screen'}).waitFor();
  await f.page.evaluate(()=>indexedDB.open=__openIdb);
  await f.page.getByRole('button',{name:'Retry',exact:true}).click();await f.page.getByRole('heading',{name:'Saved Customer A',exact:true,level:1}).waitFor();
  assert.match(await f.page.locator('#view').innerText(),/123 Saved Street/);
}));
await check('Preparation never stores expiring signed URLs and online photo views re-sign',()=>fixture(async f=>{
  f.state.attachments=[{id:'attachment-1',kind:'before',storage_path:'existing/before.jpg'}];
  await f.prepare();assert.equal(f.state.calls.filter(row=>row.name==='signedPhotoUrl').length,0);
  await f.offline();await f.page.reload();await f.visit();
  await f.page.getByText('Server photo — preview needs a connection',{exact:true}).waitFor();
  assert.equal(f.state.calls.filter(row=>row.name==='signedPhotoUrl').length,0);
  await f.offline(false);await f.page.getByRole('button',{name:'Retry connection',exact:true}).click();
  await f.page.waitForFunction(()=>document.querySelector('img[src*="signed-preview="]'));
  await f.page.reload();await f.page.waitForFunction(()=>document.querySelector('img[src*="signed-preview=2"]'));
  assert.equal(f.state.calls.filter(row=>row.name==='signedPhotoUrl').length,2);
}));
await check('A v1 upgrade preserves full legacy bytes and blocks unowned replay',()=>fixture(async f=>{
  await f.page.goto(BASE+'/tests/README.md');await f.page.evaluate(async()=>{const db=await new Promise(res=>{const r=indexedDB.open('ns-field-outbox',1);r.onupgradeneeded=()=>r.result.createObjectStore('queue',{keyPath:'id',autoIncrement:true});r.onsuccess=()=>res(r.result);});await new Promise((res,rej)=>{const tx=db.transaction('queue','readwrite');tx.objectStore('queue').add({type:'uploadJobPhoto',label:'Private previous user',createdAt:42,args:{jobId:'legacy-job',file:new Blob(['legacy-bytes'],{type:'image/jpeg'})}});tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});db.close();});
  await f.page.goto(BASE+'/admin/field.html');await f.page.getByRole('heading',{name:"Today's schedule"}).waitFor();await flush(f.page);
  const info=await f.page.evaluate(async()=>{const q=await import('/admin/js/lib/offline-queue.js');return {pending:await q.pending(),bytes:await new Promise(res=>{const r=indexedDB.open('ns-field-outbox');r.onsuccess=()=>{const db=r.result;const get=db.transaction('queue').objectStore('queue').getAll();get.onsuccess=async()=>{res(await get.result[0].args.file.text());db.close();};};})};});
  assert.equal(info.bytes,'legacy-bytes');assert.equal(info.pending[0].state,'blocked');assert.doesNotMatch(info.pending[0].label,/Private previous user/);assert.equal(f.state.writes.length,0);
},{open:false}));
await check('The real Supabase SDK can reopen saved work with an expired offline access token',()=>fixture(async f=>{
  await f.page.goto(BASE+'/tests/README.md');
  await f.page.evaluate(()=>{
    const encode=v=>btoa(JSON.stringify(v)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const exp=Math.floor(Date.now()/1000)+3600;
    localStorage.setItem('sb-xrgutmdgjzclaeyugsqg-auth-token',JSON.stringify({access_token:encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:'offline-staff-a',exp})+'.fixture',refresh_token:'offline-fixture-refresh',expires_at:exp,expires_in:3600,token_type:'bearer',user:{id:'offline-staff-a',aud:'authenticated',role:'authenticated'}}));
  });
  await f.page.goto(BASE+'/admin/field.html');await f.page.getByRole('heading',{name:"Today's schedule"}).waitFor();await f.prepare();await f.offline();
  await f.page.evaluate(()=>{const key='sb-xrgutmdgjzclaeyugsqg-auth-token';const value=JSON.parse(localStorage.getItem(key));value.expires_at=Math.floor(Date.now()/1000)-30;localStorage.setItem(key,JSON.stringify(value));});
  await f.page.reload();await f.page.getByRole('heading',{name:'Saved schedule'}).waitFor();await f.visit();
  await f.page.evaluate(async()=>{const {supabase}=await import('/shared/supabase.js');await supabase.auth.initialize();await supabase.auth.getSession();});
  assert.equal(await f.page.getByLabel('Water tap location',{exact:true}).inputValue(),'Rear tap');assert.equal(await f.page.evaluate(()=>localStorage.getItem('ns-field-active-account')),OWNER);
  await f.page.evaluate(()=>localStorage.removeItem('sb-xrgutmdgjzclaeyugsqg-auth-token'));
  await f.page.reload();await f.page.getByRole('heading',{name:'Work unavailable offline'}).waitFor();
  assert.doesNotMatch(await f.page.locator('#view').innerText(),/Saved Customer A/);
},{open:false,realAuth:true}));
for(const width of [390,430,1200])await check(`Saved work at ${width}px fits and exposes real local photo previews`,()=>fixture(async f=>{
  await f.prepare();await f.offline();await f.page.evaluate(async()=>{const b=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII='),c=>c.charCodeAt(0));await(await import('/admin/js/lib/offline-queue.js')).callOrQueue('uploadJobPhoto',{jobId:'11111111-1111-4111-8111-111111111111',file:new File([b],'before.png',{type:'image/png'}),opts:{kind:'before'}},'Photo upload');});
  await f.page.reload();await f.visit();await f.page.waitForFunction(()=>document.querySelector('img[alt="Saved locally: Before"]')?.naturalWidth>0);
  assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await f.page.screenshot({path:join(evidence,`saved-photo-${width}.png`),fullPage:true});
},{width}));

await check('Actual Chromium process restart retains the prepared snapshot and photo Blob',async()=>{
  const profile=mkdtempSync(join(tmpdir(),'nova-offline-profile-'));
  let context=await pw.chromium.launchPersistentContext(profile,{...options,viewport:{width:390,height:900},serviceWorkers:'block'});
  let f=await offlineFixture(browser,{persistentContext:context});await f.prepare();await f.offline();await f.page.evaluate(async()=>{await(await import('/admin/js/lib/offline-queue.js')).callOrQueue('uploadJobPhoto',{jobId:'11111111-1111-4111-8111-111111111111',file:new Blob(['process-restart-photo'],{type:'image/jpeg'}),opts:{kind:'before'}},'Photo upload');});await context.close();
  context=await pw.chromium.launchPersistentContext(profile,{...options,viewport:{width:390,height:900},serviceWorkers:'block'});
  f=await offlineFixture(browser,{persistentContext:context,open:false});f.state.offline=true;
  try{await f.page.goto(BASE+'/admin/field.html');await f.page.getByRole('heading',{name:'Saved schedule'}).waitFor();assert.equal(await f.page.evaluate(async()=>{const photos=await(await import('/admin/js/lib/offline-queue.js')).pendingPhotos('11111111-1111-4111-8111-111111111111');return photos[0].file.text();}),'process-restart-photo');}finally{await context.close();}
});
await browser.close();console.log(`\n${results.filter(r=>r.ok).length}/${results.length} passed`);if(results.some(r=>!r.ok))process.exitCode=1;
