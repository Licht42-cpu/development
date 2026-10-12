import { el, clear, field as baseField, select } from '../../../shared/dom.js';
import * as api from '../lib/api.js';
import * as queue from '../lib/offline-queue.js';
import { readDraft, writeDraft, forget } from '../lib/field-cache.js';
import { localAccount, accessDenied } from '../lib/field-identity.js';
import { readCompletion, completionCatalogue, completionReceipt } from '../lib/field-completion-api.js';
import { evidenceRequest, sendEvidence } from '../lib/field-evidence-work.js';
import { pushOverlay } from '../lib/navigation.js';
import { savedCaptures } from '../lib/field-captures.js';

const text = value => el('p', { text: value });
const human = value => String(value || '').replaceAll('_', ' ');
const btn = (title, action, props = {}) => el('button', { type: 'button', class: 'btn', text: title, onClick: action, ...props });
function field(title, control) { control.setAttribute('aria-label', title); return baseField(title, control); }
function notice(message, kind = '') { return el('div', { class: `completion-notice completion-${kind}`, role: 'status', text: message }); }

export function createFieldCompletion({ jobId, ownerId, offline = false, beforeReview = async () => true, onAccepted }) {
  const root = el('section', { class: 'card field-completion', 'aria-label': 'Completion and evidence' });
  const status = el('div', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const outcome = el('div', {}), contents = el('div', {});
  root.append(el('h2', { text: 'Completion and evidence' }), status, outcome, contents);
  let facts = null, catalogue = null, stored = { pending: null, accepted: null }, draft = {}, request = null;
  let saving = Promise.resolve(), saveError = null, readBusy = false, sequence = 0, locked = false, reviewDialog = null;
  let unsubscribe, observedAcceptance;
  let accessChecked = false, accessRefused = false;
  const current = async () => root.isConnected && await localAccount() === ownerId;
  const observer = new MutationObserver(() => {
    if (root.isConnected) return;
    sequence++; unsubscribe?.(); closeReview(); observer.disconnect();
    window.removeEventListener('offline', connectionChanged); window.removeEventListener('online', connectionChanged);
  });
  function persist() {
    const value = structuredClone(draft);
    status.textContent = 'Saving completion draft on this device…';
    saving = saving.catch(() => {}).then(() => writeDraft(jobId, 'completion-draft', value, ownerId))
      .then(() => { saveError = null; if (root.isConnected) status.textContent = 'Completion draft saved on this device.'; })
      .catch(error => { saveError = error; if (root.isConnected) status.textContent = `Draft not saved: ${error.message}`; });
  }
  function connectionChanged() {
    closeReview();
    status.textContent = navigator.onLine ? 'Reconnect: refresh requirements before reviewing a new completion.' : 'Offline: finished work remains provisional. A saved request will need server acceptance.';
    root.querySelector('[data-completion-review]')?.setAttribute('disabled', '');
  }
  async function refresh() {
    if (readBusy) return;
    readBusy = true; const attempt = ++sequence;
    root.setAttribute('aria-busy','true');
    root.querySelectorAll('[data-completion-refresh], [data-completion-review]').forEach(control=>control.disabled=true);
    try {
      await saving; if (saveError) throw saveError;
      const owner = await localAccount(); if (owner !== ownerId || !root.isConnected) return;
      draft = (await readDraft(jobId, 'completion-draft'))?.value || {};
      request = await evidenceRequest(jobId);
      stored = await queue.completionState(jobId);
      offline = !navigator.onLine;
      if (offline) {
        const row = await readDraft(jobId, 'completion-read');
        const age = Date.now()-row?.savedAt;
        facts = age >= 0 && age <= 24*60*60*1000 ? row.value : null;
        catalogue = (await readDraft(jobId, 'completion-catalogue'))?.value || null;
        accessChecked = !!facts;
      } else {
        facts = await readCompletion(jobId);
        accessChecked = true; accessRefused = false;
        await writeDraft(jobId, 'completion-read', facts, ownerId);
        try { catalogue = await completionCatalogue(); await writeDraft(jobId, 'completion-catalogue', catalogue, ownerId); }
        catch (error) { catalogue = null; status.textContent = `Usage catalogue unavailable: ${error.message}. Existing draft usage is retained.`; }
      }
      if (attempt !== sequence || !await current()) return;
      locked = !!facts?.readiness.completion_open || !!stored.accepted && (offline || facts?.readiness.lock_version < stored.accepted.receipt.job.lock_version);
      await paint();
    } catch (error) {
      if (attempt !== sequence || !root.isConnected) return;
      facts = null;
      if (accessDenied(error)) {
        accessRefused = true;
        await writeDraft(jobId, 'completion-read', null, ownerId).catch(() => {});
        await forget(ownerId).catch(() => {});
      }
      const sentence=String(error.message || 'The read failed.');
      clear(contents).append(notice(`Completion requirements unavailable: ${sentence}${/[.!?]$/.test(sentence) ? '' : '.'} No completion was inferred.`, 'refused'), btn('Retry completion requirements', refresh, {'data-completion-refresh':true,disabled:true}));
      await paintOutcome().catch(() => {});
    } finally {
      readBusy = false;root.setAttribute('aria-busy','false');
      root.querySelectorAll('[data-completion-refresh]').forEach(control=>control.disabled=false);
      const review=root.querySelector('[data-completion-review]');if(review)review.disabled=locked || !!stored.pending || !facts;
    }
  }
  async function paintOutcome() {
    stored = await queue.completionState(jobId);
    if (!await current()) return;
    clear(outcome);
    if ((!offline && !accessChecked) || accessRefused) {
      outcome.append(notice(accessRefused ? 'Completion access was refused. Saved requests, originals and drafts remain with this account; cached private history is hidden.' : 'Checking current completion access…'));
      return;
    }
    if (stored.pending) {
      const row = stored.pending;
      const unknown = row.state === 'sending' || row.outcome === 'unknown';
      const heading = unknown ? 'No response — completion outcome unknown' : row.state === 'conflict' ? 'Completion conflict — not accepted' : row.outcome === 'refused' ? 'Completion refused — not accepted' : 'Work finished provisionally — queued for server review';
      outcome.append(notice(heading, row.state), text(row.lastError || 'Saved locally; this has not marked the job complete.'),
        text('Saved evidence, notes and usage remain recoverable. The request keeps its original job/policy versions and retry key.'));
      if (unknown) outcome.append(btn('Recover original completion receipt', async () => {
        try { await queue.confirmRetry(row.id); await queue.flush(); await paintOutcome(); }
        catch (error) { status.textContent = error.message; }
      }, { disabled: !navigator.onLine }));
      else if (row.outcome === 'refused') outcome.append(btn('Keep draft and remove refused request', async () => {
        if (!window.confirm('Remove the refused request from the outbox? Your draft and photos remain. Refresh and review before creating a replacement.')) return;
        try { await queue.discard(row.id); await refresh(); } catch (error) { status.textContent = error.message; }
      }));
    }
    if (stored.accepted) {
      status.textContent='The server accepted the reviewed completion. Draft fields below are copies; the receipt shows the accepted values.';
      const frozen = stored.accepted.receipt.completion;
      const box = notice(`Accepted completion ${frozen.completion_id}. Server acceptance: ${frozen.accepted_at}.`, 'accepted');
      box.append(text(`Evidence: ${human(frozen.evidence_state)}. Work finish: ${frozen.work_finished_state === 'reported' ? frozen.work_finished_at : 'unknown'}. Device finish time is a claim; server acceptance is separate.`),
        text(`Accepted internal note: ${frozen.note || 'none recorded'}.`),
        text('Accepted evidence and material history are locked. Ask the owner for an attributed correction or reopening; this screen does not rewrite them.'));
      for (const line of frozen.consumption_snapshot) box.append(text(`${line.material_id}: ${line.level ? `level ${line.level}` : `${line.quantity} (${line.count_precision})`}. Recorded operation: ${line.operation_id || 'none — level observation'}.`));
      outcome.append(box);
      if (observedAcceptance !== frozen.completion_id) {
        observedAcceptance = frozen.completion_id;
        if (offline || stored.accepted.receipt.readiness?.completion_open) {
          locked = true;
          root.querySelectorAll('[data-completion-edit]').forEach(control => control.disabled = true);
          root.querySelector('[data-completion-review]')?.setAttribute('disabled','');
          if (!offline) onAccepted?.(stored.accepted.receipt);
        }
      }
    }
  }
  async function paint() {
    clear(contents);
    await paintOutcome();
    if (!facts) { contents.append(notice('No recent saved evidence policy. Reconnect to read it before a completion can be saved.')); return; }
    const r = facts.readiness;
    contents.append(notice(offline ? 'Saved requirements — up to 24 hours old. Server permission, policy and job version will be checked on sync.' : `Current readiness: ${human(r.evidence_state)}. Job version ${r.lock_version}; policy version ${r.policy_version}.`),
      btn('Refresh completion requirements', refresh, {'data-completion-refresh':true,disabled:readBusy}), text('Proposed/advisory requirements report gaps. Only owner-confirmed blocking requirements can refuse completion.'));
    for (const requirement of facts.requirements) contents.append(el('div', { class: 'section-box' }, [
      el('strong', { text: `${requirement.service_key}: ${human(requirement.requirement) || 'no policy'}` }),
      text(requirement.required_count == null ? 'Unconfigured — nobody has said what evidence is required.' : `${requirement.satisfied_count} of ${requirement.required_count}; ${human(requirement.state)}. ${requirement.enforcement}, ${human(requirement.spec_state)}; ${human(requirement.coverage)}.`),
      requirement.requires_geotag ? text('This policy requires a device-reported capture location. A location recorded later at review does not qualify.') : null
    ]));
    for (const evidence of facts.evidence) {
      contents.append(text(`On file: ${human(evidence.requirement)}, attachment ${evidence.attachment_id}; capture time ${human(evidence.capture_time_state)}, capture GPS ${human(evidence.gps_state)}; server received ${evidence.received_at}; ${evidence.frozen ? 'locked' : 'registered'}.`));
      const matching=facts.requirements.filter(row=>row.requirement===evidence.requirement);
      if(!evidence.service_id && matching.length && matching.every(row=>row.coverage==='per_service_scope'))
        contents.append(text('On file, counting towards no per-service requirement: no service scope was named. The uploaded photo is retained.'));
    }
    for (const exception of facts.exceptions || []) contents.append(text(`Owner-authorised exception: ${exception.reason}. Authorised ${exception.authorised_at}. This screen does not grant an exception.`));
    if (!offline && r.latest_completion_id) {
      const host = el('details', {}, [el('summary', { text: 'Server completion history and corrections' })]); contents.append(host);
      void completionReceipt(r.latest_completion_id).then(receipt => {
        if (!host.isConnected) return;
        host.append(text(`Frozen acceptance ${receipt.completion.completion_id}, ${receipt.completion.accepted_at}. Current job: ${receipt.job.status}.`));
        for (const line of receipt.completion.consumption_snapshot) host.append(text(`Locked material ${line.material_id}: ${line.level || `${line.quantity} ${line.count_precision}`}.`));
        for (const correction of receipt.corrections) host.append(text(`Correction: ${correction.reason}. Original acceptance remains unchanged.`));
      }).catch(error => { if (host.isConnected) host.append(text(`History unavailable: ${error.message}`)); });
    }
    if (!locked) await evidenceForm();
    const notes = el('textarea', { rows: '3', text: draft.note || '', 'data-completion-edit': true, disabled: locked,
      onInput: event => { draft.note = event.target.value; persist(); } });
    contents.append(field('Internal completion note', notes), text('This note is staff-facing. Customer-visible notes use the separate reviewed Notes audience control.'));
    const additional = el('textarea', { rows: '2', text: draft.additional || '', 'data-completion-edit': true, disabled: locked,
      onInput: event => { draft.additional = event.target.value; persist(); } });
    contents.append(field('Additional work for owner review (optional)', additional), text('A proposal only. No price or crew approval is submitted; sent and accepted quotes remain protected.'));
    const finish = el('input', { type: 'datetime-local', value: draft.finish || '', 'data-completion-edit': true, disabled: locked,
      onInput: event => { draft.finish = event.target.value; persist(); } });
    contents.append(field('Reported work finish time — device local time (optional)', finish), text('Blank means unknown; it is not replaced with the time this screen opened.'));
    usageForm();
    contents.append(btn('Review completion', openReview, { 'data-completion-review': true, disabled: readBusy || locked || !!stored.pending || !facts }));
  }
  function usageForm() {
    const usage = el('details', {}, [el('summary', { text: 'Material usage — physical observations' }),
      text('Enter only what was actually used. Existing reservations are reconciled by the backend; this screen does not debit or subtract them twice. Levels are observations, not quantities.')]); contents.append(usage);
    if (!catalogue) { usage.append(notice('Usage catalogue unavailable. Saved usage remains in the draft and is not silently discarded.')); return; }
    const materials = catalogue.materials;
    const locations = catalogue.locations;
    draft.usage ||= [];
    const rows = el('div', {}); usage.append(rows);
    function draw() {
      clear(rows);
      draft.usage.forEach((line,index) => {
        const material = materials.find(m => m.id === line.material_id);
        const row = el('div', { class: 'section-box' }, [el('strong', { text: material?.name || line.material_id })]); rows.append(row);
        const update = (key,value) => { line[key] = value; persist(); };
        if (!material) row.append(text('Material is no longer in the catalogue. Review with the owner; this draft is retained.'));
        else if (material.tracking_mode === 'level') row.append(field(`Used supply level — ${material.name}`, select([{value:'',label:'Choose observation'},...['full','part','low','empty'].map(v=>({value:v,label:human(v)}))],line.level || '',event=>update('level',event.target.value),{'data-completion-edit':true,disabled:locked})));
        else row.append(field(`Used quantity (${material.unit}) — ${material.name}`,el('input',{type:'number',min:'0',step:'any',inputmode:'decimal',value:line.quantity ?? '', 'data-completion-edit':true,disabled:locked,onInput:event=>update('quantity',event.target.value)})),
          field(`Usage accuracy — ${material.name}`,select([{value:'',label:'Choose accuracy'},{value:'exact',label:'Exact'},{value:'estimated',label:'Estimated'}],line.count_precision || '',event=>update('count_precision',event.target.value),{'data-completion-edit':true,disabled:locked})));
        row.append(field(`Usage location — ${material?.name || line.material_id}`,select([{value:'',label:'Choose location'},...locations.map(v=>({value:v.code,label:v.name}))],line.location_code || '',event=>update('location_code',event.target.value),{'data-completion-edit':true,disabled:locked})),
          btn('Remove usage draft line',()=>{draft.usage.splice(index,1);persist();draw();},{disabled:locked,'data-completion-edit':true}));
      });
    }
    draw();
    const picker = select(materials.map(m=>({value:m.id,label:m.name})),materials[0]?.id);
    usage.append(field('Material to report',picker),btn('Add usage observation',()=>{
      if (draft.usage.some(line=>line.material_id===picker.value)) {status.textContent='That material already has a usage line. Review its quantity instead.';return;}
      draft.usage.push({material_id:picker.value});persist();draw();
    },{disabled:locked || !materials.length,'data-completion-edit':true}));
    picker.disabled=locked;
  }
  async function evidenceForm() {
    const section=el('details',{open:!!request},[el('summary',{text:'Register an uploaded photo as evidence'})]);contents.append(section);
    if (request) {
      section.append(notice(request.state==='accepted' ? `Evidence registered: ${request.receipt.evidence_id}; capture time ${human(request.receipt.capture_time_state)}, GPS ${human(request.receipt.gps_state)}.` : request.message || 'Evidence registration outcome unknown. Preserve the original request.'));
      if (['sending','unknown'].includes(request.state)) {
        section.append(btn('Retry original evidence registration',async()=>{
          try { request=await sendEvidence(jobId,null,ownerId,true);await refresh(); } catch(error){status.textContent=error.message;}
        },{disabled:offline}));return;
      }
    }
    if (offline) {section.append(text('Upload/sync photos first. Registration needs the server attachment ID; no path or guessed ID can qualify.'));return;}
    const requirements=facts.requirements.filter(row=>row.requirement);
    if (!requirements.length) {section.append(text('No configured evidence purpose. Ask the owner to configure it; unknown is not sufficient evidence.'));return;}
    let attachments;
    try {attachments=await api.listAttachments(jobId);}catch(error){section.append(text(`Attachments unavailable: ${error.message}`));return;}
    if (!attachments.length) {section.append(text('Add a photo using Photos, then refresh requirements after its upload is confirmed.'));return;}
    const saved=(await readDraft(jobId,'evidence-draft'))?.value || {};
    const attachment=select(attachments.map(row=>({value:row.id,label:`${row.kind || 'Photo'} · ${row.caption || row.id}`})),attachments.some(row=>row.id===saved.attachment) ? saved.attachment : attachments[0].id);
    const purpose=select(requirements.map((row,i)=>({value:String(i),label:`${row.service_key} · ${human(row.requirement)}`})),saved.purpose || '0');
    const gps=select([{value:'unknown',label:'Unknown capture GPS'},{value:'denied',label:'Capture GPS was denied'},{value:'unavailable',label:'Capture GPS was unavailable'}],saved.gps || 'unknown');
    const watermark=el('p',{class:'completion-watermark'});
    const originals=await savedCaptures(jobId,ownerId).catch(()=>[]);
    function display() {
      const chosen=requirements[Number(purpose.value)] || requirements[0];
      const original=originals.find(row=>row.metadata.uploadedAttachmentId===attachment.value);
      watermark.textContent=`Device claim: attachment ${attachment.value}; purpose ${human(chosen.requirement)}; capture time unknown; capture GPS ${gps.value}. ${original ? `Original selected ${original.metadata.selectedAt}. ` : ''}A location recorded at review is not a capture geotag. Server receipt is separate.`;
    }
    async function save() {
      await writeDraft(jobId,'evidence-draft',{attachment:attachment.value,purpose:purpose.value,gps:gps.value},ownerId);
    }
    for(const control of [attachment,purpose,gps])control.addEventListener('change',()=>{display();void save().catch(error=>{status.textContent=error.message;});});
    display();section.append(field('Uploaded evidence photo',attachment),field('Evidence purpose and service scope',purpose),field('Capture GPS state',gps),watermark,
      text('This watermark is displayed and registered as a device claim. Original bytes are preserved; no timestamp or GPS is burnt into them.'),
      btn('Register evidence purpose',async()=>{
        try {
          const row=requirements[Number(purpose.value)];
          request=await sendEvidence(jobId,{p_job_id:jobId,p_attachment_id:attachment.value,p_requirement:row.requirement,p_service_key:row.coverage==='per_service_scope' ? row.service_key : null,
            p_captured_at:null,p_capture_time_state:null,p_captured_lat:null,p_captured_lon:null,p_captured_accuracy_m:null,p_gps_state:gps.value==='unknown' ? null : gps.value,p_client_watermark:watermark.textContent,p_source:'field_console'},ownerId);
          await refresh();
        }catch(error){status.textContent=error.message;}
      }));
  }
  function closeReview() {
    if (!reviewDialog) return;
    const { dialog, remove }=reviewDialog;reviewDialog=null;remove();dialog.close();dialog.remove();
    root.querySelector('[data-completion-review]')?.focus();
  }
  async function openReview() {
    if (readBusy) {status.textContent='Still reading completion requirements. Wait before reviewing.';return;}
    if (reviewDialog || locked || stored.pending || !await current()) return;
    if (!facts) { status.textContent='Read the completion requirements before making a finish declaration.';return; }
    if (!await beforeReview()) return;
    await saving;if(saveError){status.textContent=saveError.message;return;}
    if (!await current()) return;
    const consumption=[];
    try {
      for(const line of draft.usage || []) {
        const material=catalogue?.materials.find(m=>m.id===line.material_id);
        if(!material || !catalogue.locations.some(place=>place.code===line.location_code))throw new Error('Review every saved usage line against the current catalogue and choose its physical location.');
        const entry={material_id:line.material_id,location_code:line.location_code};
        if(material.tracking_mode==='level') {
          if(!['full','part','low','empty'].includes(line.level))throw new Error('Choose the observed supply level.');entry.level=line.level;
        }else {
          if(line.quantity==null || line.quantity==='' || !Number.isFinite(Number(line.quantity)) || Number(line.quantity)<=0 || !['exact','estimated'].includes(line.count_precision))throw new Error('Enter a positive used quantity and choose its accuracy. Remove the line if nothing was used.');
          entry.quantity=Number(line.quantity);entry.count_precision=line.count_precision;
        }
        consumption.push(entry);
      }
    }catch(error){status.textContent=error.message;return;}
    const rendered=structuredClone(facts.readiness), value=structuredClone(draft);
    const payload={p_client_operation_id:`field-completion-${crypto.randomUUID()}`,p_job_id:jobId,p_job_lock_version:rendered.lock_version,p_policy_version:rendered.policy_version,
      p_work_finished_at:value.finish ? new Date(value.finish).toISOString() : null,p_consumption:consumption,p_additional_work:value.additional?.trim() ? [{description:value.additional.trim()}] : [],p_note:value.note?.trim() || null};
    const check=el('input',{type:'checkbox','aria-label':'I reviewed the evidence, material usage and work finished declaration.'});
    const dialog=el('dialog',{class:'completion-review field-completion','aria-label':'Review provisional completion'},[
      el('h2',{text:'Review before completing'}),text(`Job version ${rendered.lock_version}; policy version ${rendered.policy_version}. Readiness: ${human(rendered.evidence_state)}.`),
      text('Offline finish is provisional. Only the server can accept completion and lock history. Missing owner-confirmed evidence can refuse it; proposed policies only advise. Submitting saves a request; closing this review afterwards does not cancel that request.'),
      ...consumption.map(line=>text(`${line.material_id}: ${line.level || `${line.quantity} ${line.count_precision}`} from ${line.location_code}.`)),
      text(value.additional ? 'Additional work is proposed for owner review, with no price or crew approval.' : 'No additional paid work proposed.'),
      el('label',{class:'completion-check'},[check,el('span',{text:'I reviewed the evidence, material usage and work finished declaration.'})])
    ]);
    const result=el('div',{role:'status'});
    const commit=btn('Submit reviewed completion',async()=>{
      if(!check.checked){result.textContent='Review and check the declaration first.';check.focus();return;}
      commit.disabled=true;
      try {
        if(!await current())throw new Error('Account or visit changed. Completion not submitted.');
        await queue.callOrQueue('completeJobWithEvidence',{jobId,payload},'Reviewed job completion',{ownerId,jobId});
        closeReview();await paintOutcome();await refresh();
      }catch(error){
        if(dialog.isConnected)result.textContent=error.message;
        const saved=await queue.completionState(jobId).catch(()=>null);
        if(error.code || saved?.pending){closeReview();await refresh();}
        await paintOutcome().catch(()=>{});
      }
      finally{commit.disabled=false;}
    });
    dialog.append(result,el('div',{class:'btn-row'},[btn('Cancel completion',closeReview),commit]));
    reviewDialog={dialog,remove:pushOverlay(closeReview)};
    dialog.addEventListener('cancel',event=>{event.preventDefault();closeReview();});
    document.body.append(dialog);dialog.showModal();dialog.querySelector('button').focus();
  }
  function start() {
    observer.observe(document.body,{childList:true,subtree:true});
    window.addEventListener('offline',connectionChanged);window.addEventListener('online',connectionChanged);
    unsubscribe=queue.subscribe(()=>{if(root.isConnected)void paintOutcome().catch(error=>{status.textContent=error.message;});});
    void refresh();
  }
  return {root,start,refresh,openReview};
}
