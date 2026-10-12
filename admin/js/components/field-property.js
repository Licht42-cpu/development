import { el, clear, select } from '../../../shared/dom.js';
import { localAccount, accessDenied } from '../lib/field-identity.js';
import { readDraft } from '../lib/field-cache.js';
import { propertyRead, dispatchJobRead } from '../lib/field-dispatch-api.js';
import { dispatchWork, sendDispatch, pendingDispatch, reportLocalArrival, retireDispatch, dispatchEpoch, offlineProperty, savedDispatch } from '../lib/field-dispatch-work.js';
import { propertyMap } from './field-property-map.js';

export function createFieldProperty({jobId,propertyId,ownerId,offlineValue=null}) {
  const root=el('section',{class:'card field-property','data-property-job':jobId});
  const body=el('div',{}),status=el('p',{role:'status','aria-live':'polite'});
  let value=null,denied=false,alive=true,attempt=0;
  function deny() {
    denied=true;value=null;attempt++;
    clear(body).append(el('h2',{text:'Property access unavailable'}),
      el('p',{text:'Not yours to open. Saved working details have been retired. Ask the owner to check assignment.'}));
    status.textContent='Access denied. No cached details are shown.';
  }
  const onDenied=event=>{if(event.detail?.ownerId===ownerId)deny();};
  const onRoute=()=>{alive=false;value=null;clear(body);cleanup();};
  const onAuth=()=>{alive=false;value=null;clear(body);cleanup();};
  const onOffline=()=>{if(value&&!denied){offlineValue=offlineProperty(value);value=null;clear(body);void start();}};
  const cleanup=()=>{window.removeEventListener('ns-field-dispatch-denied',onDenied);window.removeEventListener('ns-field-access-denied',onDenied);
    window.removeEventListener('hashchange',onRoute);window.removeEventListener('ns-field-auth-changed',onAuth);window.removeEventListener('offline',onOffline);};
  window.addEventListener('ns-field-dispatch-denied',onDenied);
  window.addEventListener('ns-field-access-denied',onDenied);
  window.addEventListener('hashchange',onRoute);
  window.addEventListener('ns-field-auth-changed',onAuth);
  window.addEventListener('offline',onOffline);
  const refresh=el('button',{class:'btn',text:'Refresh property instructions',onClick:()=>{
    if(!navigator.onLine){status.textContent='Reconnect to check current property access.';return;}
    offlineValue=null;void start();
  }});
  root.append(body,status,refresh);
  const valid=async(epoch,token)=>alive && root.isConnected && token===attempt && await localAccount()===ownerId && dispatchEpoch(ownerId)===epoch;
  function arrival(record) {
    const output=el('p',{role:'status',text:record ? `Crew reported arrival on this device at ${record.reportedAt}. Not synced; location not verified.`
      : 'No crew arrival recorded on this device. Location does not confirm arrival.'});
    const check=el('input',{type:'checkbox'}),button=el('button',{class:'btn',text:'Record arrival on this device',onClick:async()=>{
      if(!check.checked)return void(output.textContent='Confirm that you are at this property before recording arrival.');
      button.disabled=true;
      try {if(denied)throw new Error('Assignment must be checked again.');const epoch=dispatchEpoch(ownerId),token=attempt;
        const saved=await reportLocalArrival(jobId,ownerId);
        if(await valid(epoch,token))output.textContent=`Crew reported arrival on this device at ${saved.reportedAt}. Not synced; location not verified.`;
      } catch {output.textContent='Arrival was not recorded. Check access and device storage.';}
      finally {button.disabled=false;}
    }});
    return el('section',{},[el('h3',{text:'Crew arrival'}),output,
      el('label',{class:'check'},[check,el('span',{text:'I am at this property. This is my report, not GPS verification.'})]),button]);
  }
  function instructions(data,offline) {
    const notes=el('section',{},[el('h2',{text:'Property instructions'}),
      el('p',{text:[data.address_line1,data.city].filter(Boolean).join(', ') || 'Address not recorded'})]);
    const access=data.access||{};
    for(const [label,text] of [['Existing access note',data.access_note],['Entrance',access.entrance_note],['Hazards',access.hazard_note],['Parking',access.parking_note],['Customer note',access.customer_note]])
      notes.append(el('h3',{text:label}),el('p',{text:text || 'Not recorded'}));
    if(offline)notes.append(el('p',{class:'hint',text:'Access codes and private internal notes are not saved. Reconnect to read them.'}));
    else {
      const details=el('details',{},[el('summary',{text:'Private access details (online only)'}),
        el('p',{text:`Access code: ${access.access_code || 'Not recorded'}`}),el('p',{text:`Internal note: ${access.internal_note || 'Not recorded'}`})]);
      notes.append(details);
    }
    return notes;
  }
  function receiptText(record) {
    if(pendingDispatch(record))return 'Outcome unknown — recover the original request. A pending request is not success.';
    if(record.state!=='accepted')return `${record.state==='conflict'?'Conflict':'Refused'}: ${record.message}`;
    if(record.name==='report_job_issue')return `Report accepted by the server${record.receipt.replayed?' (original receipt recovered)':''}. Dispatch: ${record.receipt.dispatch_state || 'unchanged'}; resolution: ${record.receipt.resolution_state}. Job status and completion were not changed.`;
    const r=record.receipt;
    return {accepted:'Message request accepted and queued — not delivered.',delivered:'Provider reports delivered.',
      provider_failed:'Provider reports failure.',unknown:'Delivery unknown. Do not create another request.',
      unavailable:`Message unavailable: ${r.reason || 'Configuration or recipient unavailable.'}`}[r.delivery_state];
  }
  async function actions(facts) {
    const host=el('section',{},[el('h3',{text:'Crew actions'}),
      el('p',{text:`Commercial: ${facts.status.job_status}; dispatch: ${facts.status.dispatch_state || 'planned'}; accepted completion: ${facts.status.completion_state}; open issues: ${facts.status.open_issue_count}.`})]);
    const output=el('p',{role:'status'}),recover=el('button',{class:'btn',text:'Recover original dispatch request',hidden:true});
    const kind=select([{value:'blocked_access',label:'Blocked access'},{value:'equipment_breakdown',label:'Equipment breakdown'}],'blocked_access');
    kind.setAttribute('aria-label','Issue type');
    const reason=el('textarea',{rows:'2','aria-label':'Issue reason',placeholder:'What prevented access or which tool broke? Do not include access codes.'});
    const submit=el('button',{class:'btn',text:'Submit issue report'});
    const way=el('button',{class:'btn',text:'Request On the way message'}),access=el('button',{class:'btn',text:'Request access message'});
    const controls=[submit,way,access];
    const liveKinds=new Set(facts.messages.requests.filter(request=>request.still_live).map(request=>request.kind));
    const paint=record=>{if(!alive||denied)return;output.textContent=record?receiptText(record):'Nothing submitted.';
      if(record?.state==='accepted'&&record.name==='request_job_notification') {
        const r=record.receipt;
        // A fresh outcome read supersedes the journal's older delivery state.
        const known=facts.messages.requests.find(request=>request.request_id===r.request_id);
        if(known) {output.textContent=receiptText({...record,receipt:{...r,delivery_state:known.delivery_state,reason:known.reason}});
          if(known.still_live)liveKinds.add(r.kind);else liveKinds.delete(r.kind);}
        else if(['accepted','unknown'].includes(r.delivery_state))liveKinds.add(r.kind);
      }
      recover.hidden=!pendingDispatch(record);submit.disabled=pendingDispatch(record);
      way.disabled=pendingDispatch(record)||liveKinds.has('on_the_way');access.disabled=pendingDispatch(record)||liveKinds.has('access_request');};
    async function send(name,payload,retry=false) {
      if(!navigator.onLine)return void(output.textContent='Reconnect before sending. Dispatch actions are not queued.');
      if(denied)return;
      controls.forEach(button=>button.disabled=true);recover.disabled=true;output.textContent='Request pending — waiting for the server.';
      const epoch=dispatchEpoch(ownerId),token=attempt;
      try {const record=await sendDispatch(jobId,name,payload,ownerId,retry);
        if(!await valid(epoch,token))return;
        paint(record);
        if(record.state==='accepted' && name==='report_job_issue')await start(record);
      } catch {if(await valid(epoch,token)){output.textContent='Request could not be confirmed. Review saved request before trying again.';
        try {paint(await dispatchWork(jobId));}
        catch {output.textContent='Request could not be confirmed. Device request storage is unavailable; restore storage before recovering the original request.';
          controls.forEach(button=>button.disabled=true);}}}
      finally {recover.disabled=false;}
    }
    submit.onclick=()=>{if(!reason.value.trim())return void(output.textContent='Enter a reason before reporting.');
      return send('report_job_issue',{p_kind:kind.value,p_reason:reason.value.trim(),p_material_id:null});};
    way.onclick=()=>send('request_job_notification',{p_kind:'on_the_way',p_channel:'sms'});
    access.onclick=()=>send('request_job_notification',{p_kind:'access_request',p_channel:'sms'});
    recover.onclick=()=>send(null,null,true);
    host.append(el('label',{class:'field'},[el('span',{text:'Issue type'}),kind]),reason,submit,
      el('p',{class:'hint',text:'Resolution and clearing a blocked stop belong to the owner. A breakdown does not automatically block or complete this visit.'}),
      el('div',{class:'btn-row'},[way,access]),output,recover);
    for(const issue of facts.issues)host.append(el('div',{class:'dispatch-issue'},[
      el('p',{text:`${issue.kind.replaceAll('_',' ')}: ${issue.reason}`}),
      el('p',{text:`Reported by ${issue.reported_by || 'actor not provided'}, at ${issue.reported_at}. Resolution: ${issue.resolution_state}. ${issue.resolution_note || ''}`})]));
    host.append(el('h3',{text:'Message outcomes'}),el('p',{text:facts.messages.provider_configured?'Provider configuration reported by server.':'SMS provider unconfigured. Nothing is sent automatically.'}));
    for(const message of facts.messages.requests)host.append(el('p',{text:`${message.kind.replaceAll('_',' ')}: ${message.delivery_state}. ${message.reason||''}`}));
    paint(await dispatchWork(jobId));return host;
  }
  async function start(afterRecord=null) {
    const token=++attempt,epoch=dispatchEpoch(ownerId);
    denied=false;value=null;clear(body);status.textContent='Loading scoped property instructions…';
    refresh.disabled=true;
    try {
      let offline=!!offlineValue || !navigator.onLine;
      if(offline && !offlineValue)throw new Error('No saved instructions.');
      const [data,facts,report]=await Promise.all([
        offline?offlineValue:propertyRead(propertyId),offline?null:dispatchJobRead(jobId),readDraft(jobId,'dispatch-arrival')
      ]);
      if(!await valid(epoch,token))return;
      offline ||= !navigator.onLine;
      value=offline?offlineProperty(data):data;body.append(instructions(value,offline),propertyMap(value,{offline}),arrival(report?.value));
      if(offline)body.append(el('p',{text:'Issue reports and customer messages require a connection. Saved coordinates do not establish current assignment.'}));
      else {const host=await actions(facts);if(await valid(epoch,token))body.append(host);}
      if(await valid(epoch,token))status.textContent=afterRecord?'Property instructions refreshed after the accepted report.':offline?'Showing saved instructions; current access has not been checked.':'Property access checked by the server.';
    } catch(error) {
      if(!alive || token!==attempt || await localAccount()!==ownerId)return;
      if(accessDenied(error)){await retireDispatch(ownerId);deny();}
      else {clear(body).append(el('h2',{text:'Property instructions unavailable'}));status.textContent='Could not read scoped instructions. Reconnect or ask the owner to check backend availability.';}
    } finally {refresh.disabled=!navigator.onLine;}
  }
  return {root,start,dispose:onRoute,get value(){return value;}};
}

export function propertyInstructionsLauncher({jobId,propertyId,ownerId}) {
  const root=el('section',{class:'card field-property'}),host=el('div',{});
  const button=el('button',{class:'btn',text:'Open property instructions and dispatch actions',onClick:async()=>{
    button.disabled=true;
    try {
      let offlineValue=null;
      if(!navigator.onLine){const cached=await savedDispatch();offlineValue=cached?.day.stops.some(stop=>stop.job_id===jobId&&stop.property_id===propertyId)
        ? cached.properties[propertyId] : null;
        if(!offlineValue)throw new Error('Reconnect and save dispatch instructions first. Access codes are never saved.');}
      if(!root.isConnected || await localAccount()!==ownerId)return;
      const view=createFieldProperty({jobId,propertyId,ownerId,offlineValue});clear(host).append(view.root);await view.start();
    } catch(error) {host.textContent=error.message;button.disabled=false;}
  }});
  root.append(button,host);return root;
}
