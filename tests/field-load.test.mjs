import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadFixture, scenarios, envelopeFor, clone, data } from './field-load-fixture.mjs';
const { default: pw } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright/index.js');
const launch = { executablePath: process.env.PLAYWRIGHT_CHROMIUM || '/usr/bin/chromium' };
const browser = await pw.chromium.launch(launch);
const evidence = process.env.FIELD_LOAD_EVIDENCE || join(tmpdir(), 'nova-field-load'); mkdirSync(evidence, { recursive: true });
const results = [];
async function test(name, fn) {
  if (process.env.FIELD_LOAD_ONLY && !name.includes(process.env.FIELD_LOAD_ONLY)) return;
  try { await fn(); results.push({ name, ok: true }); console.log('PASS - '+name); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.log('FAIL - '+name+'\n'+error.stack); }
}
async function fixture(fn, options = {}) {
  const f = await loadFixture(browser, options);
  if (process.env.FIELD_LOAD_BREAK === 'fingerprint') {
    const source=readFileSync(new URL('../admin/js/views/field-load.js',import.meta.url),'utf8');
    assert.ok(source.includes('p_expected_lines_fingerprint: plan.lines_fingerprint'));
    await f.context.route('**/admin/js/views/field-load.js',route=>route.fulfill({contentType:'application/javascript',body:source.replace('p_expected_lines_fingerprint: plan.lines_fingerprint','p_expected_lines_fingerprint: null')}));
  }
  try { await fn(f); assert.deepEqual(f.errors, []); }
  finally { f.load.release?.(); await f.context.close(); }
}
const request = (f, name) => f.load.calls.filter(c => c.name === name).at(-1)?.args;
async function confirm(f) {
  await f.page.getByLabel('I checked the physical loading', { exact: false }).check();
  await f.page.getByRole('button', { name: 'Confirm checked loading and returns', exact: true }).click();
}
async function accepted(f) { await f.page.getByText('Accepted by the server.', { exact: true }).waitFor(); }
const catalogueFrom = lines => lines.filter(l => l.material_id).map(l => ({ id: l.material_id, name: l.material_name, unit: l.unit, category: l.line_kind, tracking_mode: l.level_state ? 'level' : 'quantity' }));

await test('fixture snapshot is byte-identical to b7f0a22 and contains 24 v2.1 scenarios', async () => {
  const bytes = readFileSync(new URL('./data/field-daily-load-v2.json', import.meta.url));
  assert.equal(data.contract, 'daily-load-contract-v2.1'); assert.equal(Object.keys(scenarios).length, 24);
  // Verified against git show b7f0a22 during implementation. Running the
  // suite on a clean clone must not depend on fetching Claude's branch.
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'a024c0a10346273f22511fa51d35ff03b2659270129ff2da32924b04afb824f0');
});
for (const scenario of ['siding','no_bleach_day','no_bleach_day_with_manual_keep','mixed_services','permanent_lighting_with_offcut','named_christmas_set','winter_replenishment','repeated_jobs','car_b_assigned','car_a_with_unassigned_job','shortage_and_incomplete']) {
  await test(`${scenario}: render backend actions once per line, null stays unknown and levels have no quantities`, () => fixture(async f => {
    f.load.read = envelopeFor(scenarios[scenario].response); await f.open();
    for (const line of f.load.read.plan.lines) {
      const card = f.page.locator(`[data-line-id="${line.line_id}"]`); assert.equal(await card.count(), 1);
      assert.match(await card.innerText(), new RegExp(line.reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(await card.locator('.load-quantities').count(), line.level_state || line.rental_set_id ? 0 : 1);
      if (!line.level_state && !line.rental_set_id && line.reserved_qty === null) assert.equal(await card.getByText('Not recorded', { exact: true }).count() > 0, true);
      if (line.data_state === 'needs_review') assert.match(await card.innerText(), /not a known shortage/);
    }
    assert.equal(request(f,'confirm_load_plan'), undefined); assert.equal(request(f,'build_load_plan'), undefined);
  }));
}
await test('frozen_read_envelope: none means no built plan, crew cannot build, closing still available', () => fixture(async f => {
  f.load.read = clone(scenarios.frozen_read_envelope.no_plan_for_that_day); f.load.read.can_build = scenarios.frozen_read_envelope.as_crew_can_build;
  await f.open(); assert.match(await f.page.locator('#view').innerText(), /No plan has been built/);
  assert.equal(await f.page.getByRole('button', { name: 'Build whole-day plan', exact: true }).count(), 0);
  assert.equal(await f.page.getByRole('button', { name: 'End-of-day count', exact: true }).count(), 1);
}));
await test('closed_day_is_readable: closed plan shows lines without preparation mutations', () => fixture(async f => {
  f.load.read = clone(scenarios.closed_day_is_readable.read); await f.open();
  assert.match(await f.page.locator('#view').innerText(), /Closed day/);
  assert.equal(await f.page.locator('[data-load-send]').count(), 0);
}));
await test('operating_day_timezone: report UTC warning and configured bounds without rebucketing visits', () => fixture(async f => {
  await f.open(); assert.match(await f.page.locator('#view').innerText(), /unconfigured.*UTC/);
  const configured = scenarios.operating_day_timezone.configured;
  Object.assign(f.load.read, { work_day_timezone: configured.work_day_timezone, work_day_timezone_state: configured.work_day_timezone_state });
  Object.assign(f.load.read.day, { window_starts_at: configured.window_starts_at, window_ends_at: configured.window_ends_at });
  await f.page.getByRole('button', { name: 'Refresh this day', exact: true }).click();
  await f.page.getByText('Operating day: America/Edmonton.', { exact: true }).waitFor();
  assert.match(await f.page.locator('#view').innerText(), /2027-06-14T06:00:00/);
}));
await test('confirm quotes the rendered plan’s six parameters without a pre-confirm read', () => fixture(async f => {
  await f.open(); const rendered = clone(f.load.read.plan); const reads = f.load.calls.filter(c => c.name === 'get_load_plan').length;
  f.load.read.plan.revision = 99; f.load.read.plan.lines_fingerprint = 'NEW';
  await confirm(f); await accepted(f);
  const args = request(f,'confirm_load_plan'); assert.equal(Object.keys(args).length, 6);
  assert.equal(args.p_plan_id, rendered.plan_id); assert.equal(args.p_expected_revision, rendered.revision);
  assert.equal(args.p_expected_fingerprint, rendered.basis_fingerprint); assert.equal(args.p_expected_lines_fingerprint, rendered.lines_fingerprint);
  const callIndex = f.load.calls.findIndex(c => c.name === 'confirm_load_plan');
  assert.equal(f.load.calls.slice(0,callIndex).filter(c => c.name === 'get_load_plan').length, reads);
}));
for (const scenario of ['late_schedule_change','recommendation_lock']) {
  await test(`${scenario}: 23514 sentence remains visible after automatic re-read; no automatic retry`, () => fixture(async f => {
    await f.open(); f.load.fail = scenario === 'late_schedule_change' ? scenarios[scenario].conflict : scenarios[scenario].confirmation_with_the_stale_lock;
    const reads = f.load.calls.filter(c => c.name === 'get_load_plan').length; await confirm(f);
    await f.page.getByText(f.load.fail.message, { exact: true }).waitFor();
    assert.match(await f.page.locator('#view').innerText(), /Conflict/);
    assert.equal(f.load.calls.filter(c => c.name === 'get_load_plan').length, reads+1);
    assert.equal(f.load.calls.filter(c => c.name === 'confirm_load_plan').length, 1);
  }));
}
await test('manual_keep_clear_restores_recommendation: set and clear from same card; reload current state', () => fixture(async f => {
  const s = scenarios.manual_keep_clear_restores_recommendation;
  f.load.read = envelopeFor(scenarios.no_bleach_day.response); f.load.read.plan.lines = [clone(s.line_after_clear)];
  await f.open(); const title = s.line_after_clear.material_name;
  await f.page.getByLabel('Keep reason — '+title, { exact: true }).fill('rain tomorrow');
  f.load.result = s.keep_receipt; f.load.read.plan.lines = [clone(s.line_while_kept)];
  await f.page.getByRole('button',{ name: 'Manual Keep — '+title, exact:true }).click(); await accepted(f);
  assert.equal(request(f,'set_manual_keep').p_keep, true);
  f.load.result = s.clear_receipt; f.load.read.plan.lines = [clone(s.line_after_clear)];
  await f.page.getByRole('button',{ name:'Clear Manual Keep — '+title,exact:true }).click(); await f.page.locator('[data-load-group="return"] h3').waitFor();
  assert.equal(request(f,'set_manual_keep').p_keep, false);
}));
await test('keep_clear_whole_day: clearing does not turn a still-needed item into Return', () => fixture(async f => {
  const s=scenarios.keep_clear_whole_day.after_clearing;
  f.load.read=envelopeFor(scenarios.no_bleach_day.response);f.load.read.plan.lines=[clone(s.still_needed),clone(s.not_needed_today)];
  await f.open();
  assert.equal(await f.page.locator(`[data-load-group="keep"] [data-line-id="${s.still_needed.line_id}"]`).count(),1);
  assert.equal(await f.page.locator(`[data-load-group="return"] [data-line-id="${s.not_needed_today.line_id}"]`).count(),1);
}));
await test('duplicate_retry: owner build is explicit, never a cold-open side effect, replay keeps its key', () => fixture(async f => {
  f.load.read.can_build=true;f.load.result=scenarios.duplicate_retry.response;
  await f.open();assert.equal(request(f,'build_load_plan'),undefined);
  f.load.lost='build_load_plan';await f.page.getByRole('button',{name:'Rebuild whole-day plan',exact:true}).click();
  await f.page.getByText('No response — outcome unknown',{exact:true}).waitFor();const first=clone(request(f,'build_load_plan'));
  f.load.lost=null;await f.page.getByRole('button',{name:'Retry identical request',exact:true}).click();
  await f.page.getByText('Accepted — original receipt recovered.',{exact:true}).waitFor();
  assert.deepEqual(request(f,'build_load_plan'),first);assert.equal(f.load.effects,1);
}));
await test('exception_affects_confirmation: fourth skip group has owner reason and no crew override', () => fixture(async f => {
  const s = scenarios.exception_affects_confirmation; f.load.read = envelopeFor(s.confirmation); f.load.read.state = 'current'; f.load.read.plan.status = 'current';
  await f.open(); const skip = f.page.locator('[data-load-group="skip"]');
  assert.match(await skip.innerText(), /already a part jug on the van/); assert.equal(await skip.locator('button').count(),0);
  assert.equal(await f.page.getByLabel('Exception item').locator(`option[value="${s.skipped_line.line_id}"]`).count(),0);
}));
await test('crew_permission_failures: visible exception attempt receives honest 42501 refusal', () => fixture(async f => {
  await f.open(); await f.page.getByText('Request an owner-authorised exception',{exact:true}).click();
  await f.page.getByLabel('Exception reason (required)',{exact:true}).fill('van is full');
  f.load.fail = scenarios.crew_permission_failures.failures.authorise_load_exception;
  await f.page.getByRole('button',{name:'Ask server to authorise exception',exact:true}).click();
  await f.page.getByText(f.load.fail.message,{exact:true}).waitFor();
  assert.match(await f.page.locator('#view').innerText(), /Refused/); assert.equal(f.load.effects,0);
}));
await test('per_operation_retries: lost response survives reload and exact key/payload replay has one effect', () => fixture(async f => {
  await f.open(); f.load.lost = 'confirm_load_plan'; await confirm(f);
  await f.page.getByText('No response — outcome unknown',{exact:true}).waitFor();
  const original = clone(request(f,'confirm_load_plan')); assert.equal(f.load.effects,1);
  await f.page.reload(); await f.page.getByText('No response — outcome unknown',{exact:true}).waitFor();
  f.load.lost = null; await f.page.getByRole('button',{name:'Retry identical request',exact:true}).click();
  await f.page.getByText('Accepted — original receipt recovered.',{exact:true}).waitFor();
  assert.deepEqual(request(f,'confirm_load_plan'),original); assert.equal(f.load.effects,1);
}));
await test('23505 changed-intent conflict is distinct from unknown response and accepted', () => fixture(async f => {
  await f.open(); f.load.fail = scenarios.per_operation_retries.manual_keep.changed_intent; await confirm(f);
  await f.page.getByText(f.load.fail.message,{exact:true}).waitFor();
  assert.match(await f.page.locator('#view').innerText(), /Conflict/); assert.equal(await f.page.getByRole('button',{name:'Retry identical request'}).count(),0);
}));
await test('malformed acceptance response stays unknown and preserves original request', () => fixture(async f => {
  await f.open(); f.load.result={}; await confirm(f);
  await f.page.getByText('No response — outcome unknown',{exact:true}).waitFor();
  assert.equal(await f.page.getByText('Accepted by the server.',{exact:true}).count(),0);
  assert.equal(await f.page.getByRole('button',{name:'Retry identical request',exact:true}).count(),1);
}));
await test('per_operation_retries: late Keep replay receipt does not replace the current recommendation', () => fixture(async f => {
  const s=scenarios.manual_keep_clear_restores_recommendation;
  f.load.read=envelopeFor(scenarios.no_bleach_day.response);f.load.read.plan.lines=[clone(s.line_after_clear)];await f.open();
  await f.page.getByLabel('Keep reason — '+s.line_after_clear.material_name,{exact:true}).fill('rain');
  f.load.result=scenarios.per_operation_retries.manual_keep.late_retry_after_clear;
  await f.page.getByRole('button',{name:'Manual Keep — '+s.line_after_clear.material_name,exact:true}).click();
  await f.page.getByText('Accepted — original receipt recovered.',{exact:true}).waitFor();
  assert.equal(await f.page.locator('[data-load-group="return"] h3').count(),1);
  assert.equal(await f.page.locator('[data-load-group="keep"] h3').count(),0);
}));
await test('real browser process restart preserves the unanswered immutable request and recovers one receipt', async () => {
  const profile=mkdtempSync(join(tmpdir(),'nova-load-restart-'));
  let context=await pw.chromium.launchPersistentContext(profile,{...launch,viewport:{width:390,height:900},serviceWorkers:'block'});
  let f=await loadFixture(browser,{persistentContext:context});
  const state=f.load;
  try {
    await f.open();state.lost='confirm_load_plan';await confirm(f);await f.page.getByText('No response — outcome unknown',{exact:true}).waitFor();
    const original=clone(request(f,'confirm_load_plan'));
    await context.close();context=await pw.chromium.launchPersistentContext(profile,{...launch,viewport:{width:390,height:900},serviceWorkers:'block'});
    f=await loadFixture(browser,{persistentContext:context,loadState:state});state.lost=null;
    await f.open();await f.page.getByRole('button',{name:'Retry identical request',exact:true}).click();
    await f.page.getByText('Accepted — original receipt recovered.',{exact:true}).waitFor();
    assert.deepEqual(request(f,'confirm_load_plan'),original);assert.equal(state.effects,1);assert.deepEqual(f.errors,[]);
  } finally {await context.close();}
});
await test('device commit failure prevents any mutation; account change hides saved request', () => fixture(async f => {
  await f.open();
  await f.page.getByRole('button',{name:'Confirm checked loading and returns',exact:true}).waitFor();
  await f.page.evaluate(()=>{indexedDB.open=()=>{throw new DOMException('Injected storage full','QuotaExceededError');};});
  await confirm(f);await f.page.getByText('Injected storage full',{exact:true}).waitFor();
  assert.equal(request(f,'confirm_load_plan'),undefined);
  await f.page.evaluate(()=>__switchAccount('other-account'));
  await f.page.waitForFunction(()=>!document.querySelector('[data-load-group]'));
  assert.equal(await f.page.getByText('No response — outcome unknown',{exact:true}).count(),0);
}));
await test('unknown saved journal format is retained and fails closed', () => fixture(async f => {
  await f.open();
  await f.page.evaluate(async()=>{const {writeDraft}=await import('/admin/js/lib/field-cache.js');await writeDraft('field-load:car_a:2027-06-01','operation',{version:99,opaque:'preserve-me'});});
  await f.page.reload();await f.page.getByText('Could not read this day: This load request uses a newer device format. Saved work was preserved.',{exact:true}).waitFor();
  const row=await f.page.evaluate(async()=>{const {readDraft}=await import('/admin/js/lib/field-cache.js');return readDraft('field-load:car_a:2027-06-01','operation');});
  assert.deepEqual(row.value,{version:99,opaque:'preserve-me'});assert.equal(request(f,'confirm_load_plan'),undefined);
}));
await test('carry_extra accepts a catalogue item absent from the plan with a required operating quantity', () => fixture(async f => {
  const s=scenarios.exception_affects_confirmation;
  f.load.catalogue=[{id:s.added_line.material_id,name:s.added_line.material_name,unit:s.added_line.unit,tracking_mode:'quantity'}];f.load.result=s.carry_extra_receipt;
  await f.open();await f.page.getByText('Request an owner-authorised exception',{exact:true}).click();
  await f.page.getByLabel('Exception item',{exact:true}).selectOption(`material:${s.added_line.material_id}`);
  await f.page.getByLabel('Exception decision',{exact:true}).selectOption('carry_extra');
  await f.page.getByLabel('Exception reason (required)',{exact:true}).fill('spare jug');
  await f.page.getByLabel('Extra quantity (litre)',{exact:true}).fill('6');
  await f.page.getByRole('button',{name:'Ask server to authorise exception',exact:true}).click();await accepted(f);
  assert.equal(request(f,'authorise_load_exception').p_quantity,6);assert.equal(request(f,'authorise_load_exception').p_material_id,s.added_line.material_id);
}));
await test('closing_without_confirmation: estimate and blank untouched items; no plan needed; receipt uses live basis', () => fixture(async f => {
  const s = scenarios.closing_without_confirmation; const l = s.receipt.lines[0];
  f.load.read = clone(scenarios.frozen_read_envelope.no_plan_for_that_day); f.load.read.can_build=false;
  f.load.catalogue = [{ id:l.material_id,name:l.material_name,unit:'litre',tracking_mode:'quantity' }, { id:'untouched',name:'Uncounted',unit:'each',tracking_mode:'quantity' }]; f.load.result=s.receipt;
  await f.open({closing:true}); await f.page.getByLabel(`Usable count (litre) — ${l.material_name}`,{exact:true}).fill('9');
  await f.page.getByRole('button',{name:'Record observations and close day',exact:true}).click();
  await f.page.getByText(`Choose count accuracy and variance reason for ${l.material_name}. The server checks the live balance.`,{exact:true}).waitFor();
  assert.equal(request(f,'reconcile_day_end'),undefined);
  await f.page.getByLabel('Count accuracy — '+l.material_name,{exact:true}).selectOption('estimated');
  await f.page.getByLabel('Variance reason — '+l.material_name,{exact:true}).selectOption('used_more');
  await f.page.getByRole('button',{name:'Record observations and close day',exact:true}).click(); await accepted(f);
  assert.equal(request(f,'reconcile_day_end').p_lines.length,1); assert.equal(request(f,'reconcile_day_end').p_lines[0].precision,'estimated');
  assert.match(await f.page.locator('#view').innerText(), /live_usable_on_hand.*No plan was required/);
}));
await test('damaged_variance_pools: positive damaged refusal preserved, no client variance calculation', () => fixture(async f => {
  const s = scenarios.damaged_variance_pools, l=s.receipt.lines[0];
  f.load.catalogue = [{ id:l.material_id,name:l.material_name,unit:'each',tracking_mode:'quantity' }];
  await f.open({closing:true}); await f.page.getByLabel('Usable count (each) — '+l.material_name,{exact:true}).fill('12');
  await f.page.getByLabel('Count accuracy — '+l.material_name,{exact:true}).selectOption('exact');
  await f.page.getByLabel('Variance reason — '+l.material_name,{exact:true}).selectOption('damaged'); f.load.fail=s.surplus_called_damaged;
  await f.page.getByRole('button',{name:'Record observations and close day',exact:true}).click(); await f.page.getByText(s.surplus_called_damaged.message,{exact:true}).waitFor();
  assert.match(await f.page.locator('#view').innerText(), /Conflict/); assert.equal(request(f,'reconcile_day_end').p_lines[0].counted_qty,12);
}));
await test('level closing has only Empty/Low/Enough, no number or quantity in request', () => fixture(async f => {
  f.load.catalogue = [{id:'level-product',name:'Level product',unit:'level',tracking_mode:'level'}];
  await f.open({closing:true}); assert.equal(await f.page.locator('input[type="number"]').count(),0);
  await f.page.getByLabel('Observed level — Level product',{exact:true}).selectOption('low');
  f.load.result={...clone(scenarios.closing_without_confirmation.receipt),lines:[{material_id:'level-product',material_name:'Level product',level_state:'low',expected_qty:null,counted_qty:null,variance_qty:null,variance_reason:null,precision:'exact'}]};
  await f.page.getByRole('button',{name:'Record observations and close day',exact:true}).click(); await accepted(f);
  assert.equal(request(f,'reconcile_day_end').p_lines[0].level_state,'low'); assert.equal(Object.hasOwn(request(f,'reconcile_day_end').p_lines[0],'counted_qty'),false);
}));
await test('no signal: cached read is review-only and drafts remain separate per vehicle', () => fixture(async f => {
  const lines=scenarios.siding.response.lines; f.load.catalogue=catalogueFrom(lines);
  await f.open({closing:true}); const material=f.load.catalogue.find(m=>m.tracking_mode!=='level');
  const input=f.page.getByLabel(`Usable count (${material.unit}) — ${material.name}`,{exact:true}); await input.fill('17');
  await f.page.getByText('Draft saved here — not sent.',{exact:true}).waitFor();
  await f.offline(); await f.page.reload(); await f.page.getByText('Offline — saved recommendations',{exact:false}).waitFor();
  assert.equal(await f.page.getByLabel(`Usable count (${material.unit}) — ${material.name}`,{exact:true}).inputValue(),'17');
  assert.equal(await f.page.getByRole('button',{name:'Record observations and close day',exact:true}).isDisabled(),true);
  await f.offline(false);
  f.load.read.location_code='car_b';f.load.read.location_name='Car B';f.load.read.location_id=f.load.read.day.readable_vehicles.find(v=>v.code==='car_b').location_id;
  await f.page.getByLabel('Vehicle',{exact:true}).selectOption('car_b');
  await f.page.waitForFunction(()=>location.hash.includes('vehicle=car_b'));
  await f.page.getByLabel(`Usable count (${material.unit}) — ${material.name}`,{exact:true}).waitFor();
  assert.equal(await f.page.getByLabel(`Usable count (${material.unit}) — ${material.name}`,{exact:true}).inputValue(),'');
}));
await test('addresses/access notes remain in preparation; no client day re-bucketing', () => fixture(async f => {
  await f.open(); await f.page.getByText('123 Saved Street, Test City',{exact:true}).waitFor();
  assert.match(await f.page.locator('#view').innerText(), /Access: No access note recorded/);
  assert.equal(f.state.calls.filter(c=>c.name==='listTodaysVisits').length,0);
}));
await test('Car B crew bootstrap asks backend permission rather than choosing first readable metadata', () => fixture(async f => {
  f.load.locations=f.load.read.day.readable_vehicles.filter(v=>v.kind==='vehicle').map(v=>({...v,id:v.location_id}));
  f.load.read=envelopeFor(scenarios.car_b_assigned.response);
  f.load.read.day.readable_vehicles=f.load.read.day.readable_vehicles.filter(v=>v.kind==='base'||v.code==='car_b');
  await f.page.goto(`http://localhost:8743/admin/field.html#/load?day=${f.load.read.work_date}`);await f.page.getByText('Window:',{exact:false}).waitFor();
  assert.equal(request(f,'get_load_plan').p_location_code,'car_b');
  assert.equal(await f.page.getByLabel('Vehicle',{exact:true}).inputValue(),'car_b');
  assert.equal(f.load.calls.filter(c=>c.name==='can_see_location').length,2);
}));
await test('airplane-mode transition disables new sends immediately; reconnect requires refresh', () => fixture(async f => {
  await f.open();const confirmButton=f.page.getByRole('button',{name:'Confirm checked loading and returns',exact:true});await confirmButton.waitFor();
  await f.offline();await f.page.evaluate(()=>window.dispatchEvent(new Event('offline')));
  assert.equal(await confirmButton.isDisabled(),true);assert.equal(request(f,'confirm_load_plan'),undefined);
  await f.offline(false);await f.page.evaluate(()=>window.dispatchEvent(new Event('online')));
  assert.equal(await confirmButton.isDisabled(),true);
  await f.page.getByRole('button',{name:'Refresh this day',exact:true}).click();
  await f.page.waitForFunction(()=>!document.querySelector('[data-load-send]')?.disabled);
}));
for (const width of [390,430,1200]) {
  await test(`touch and keyboard preparation, exception, closing and no horizontal overflow at ${width}px`, () => fixture(async f => {
    f.load.read=envelopeFor(scenarios.siding.response); f.load.catalogue=catalogueFrom(f.load.read.plan.lines); await f.open();
    await f.page.getByText('Request an owner-authorised exception',{exact:true}).focus(); await f.page.keyboard.press('Enter');
    await f.page.getByLabel('Exception reason (required)',{exact:true}).fill('Reviewed exception');
    assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await f.page.evaluate(()=>scrollTo(0,0));
    await f.page.screenshot({path:join(evidence,`${width}-preparation.png`),fullPage:true});
    const closing=f.page.getByRole('button',{name:'End-of-day count',exact:true}); await closing.focus(); await f.page.keyboard.press('Enter');
    await f.page.getByRole('heading',{name:'Physical observations',exact:true}).waitFor();
    const count=f.page.locator('input[type="number"]').first();await count.fill('8');
    assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const targets=await f.page.locator('.field-load button, .field-load input, .field-load select').evaluateAll(els=>els.filter(e=>e.getBoundingClientRect().width&&e.type!=='checkbox').map(e=>e.getBoundingClientRect().height));
    assert.ok(targets.every(height=>height>=48));
    await f.page.evaluate(()=>scrollTo(0,0));
    await f.page.screenshot({path:join(evidence,`${width}-closing.png`),fullPage:true});
    f.load.read=envelopeFor(scenarios.no_bleach_day_with_manual_keep.response);
    await f.open();await f.page.getByText('Manual Keep is active',{exact:true}).waitFor();
    await f.page.evaluate(()=>scrollTo(0,0));
    await f.page.screenshot({path:join(evidence,`${width}-manual-keep.png`),fullPage:true});
    f.load.read=envelopeFor(scenarios.exception_affects_confirmation.confirmation);
    f.load.read.state='current';f.load.read.plan.status='current';await f.open();
    await f.page.locator('[data-load-group="skip"]').waitFor();
    await f.page.evaluate(()=>scrollTo(0,0));
    await f.page.screenshot({path:join(evidence,`${width}-skip.png`),fullPage:true});
  },{width,hasTouch:true}));
}
await browser.close();
writeFileSync(join(evidence,'results.json'),JSON.stringify({results,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length},null,2)+'\n');
console.log(`${results.filter(r=>r.ok).length} PASS / ${results.filter(r=>!r.ok).length} FAIL`);
if(results.some(r=>!r.ok))process.exitCode=1;
