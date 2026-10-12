import { el, clear, select } from '../../../shared/dom.js';
import { localAccount, accessDenied } from '../lib/field-identity.js';
import { dispatchRead, propertyRead } from '../lib/field-dispatch-api.js';
import { loadVehicles } from '../lib/field-load-api.js';
import { saveDispatch, savedDispatch, dispatchEpoch, retireDispatch } from '../lib/field-dispatch-work.js';
import { createFieldProperty } from '../components/field-property.js';
import { looksOffline } from '../lib/offline-queue.js';

const calendarDate=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
export async function renderFieldDispatch({mount,navigate,offline=false}) {
  const owner=await localAccount();
  const root=el('div',{class:'field-dispatch'}),content=el('div',{}),status=el('p',{role:'status'});
  clear(mount).append(root);
  let attempt=0,day=null,views=[],cacheMode=offline;
  const params=new URLSearchParams(location.hash.split('?')[1]||'');
  const date=el('input',{type:'date','aria-label':'Dispatch work date',value:params.get('date')||calendarDate()});
  const vehicle=select([],params.get('vehicle')||'');vehicle.setAttribute('aria-label','Dispatch vehicle');
  const refresh=el('button',{class:'btn',text:'Refresh ordered day'});
  const save=el('button',{class:'btn',text:'Save dispatch instructions offline'});
  root.append(el('h1',{text:'Ordered dispatch day'}),el('a',{href:'#/',text:'← Device-calendar schedule'}),
    el('p',{class:'hint',text:'Choose the work date in the operating timezone. The initial date is this device’s calendar date; the server determines the day window.'}),
    el('label',{class:'field'},[el('span',{text:'Vehicle'}),vehicle]),el('label',{class:'field'},[el('span',{text:'Work date'}),date]),
    el('div',{class:'btn-row'},[refresh,save]),status,content);
  let dead=false;
  const dispose=()=>{dead=true;attempt++;views.forEach(v=>v.dispose());cleanup();};
  const deny=event=>{if(event.detail?.ownerId!==owner)return;attempt++;day=null;views.forEach(v=>v.dispose());views=[];
    clear(content);status.textContent='Not yours to open. Saved dispatch details retired. Refresh after the owner checks assignment.';};
  const cleanup=()=>{window.removeEventListener('hashchange',dispose);window.removeEventListener('ns-field-auth-changed',dispose);
    window.removeEventListener('ns-field-dispatch-denied',deny);window.removeEventListener('ns-field-access-denied',deny);};
  window.addEventListener('hashchange',dispose);window.addEventListener('ns-field-auth-changed',dispose);
  window.addEventListener('ns-field-dispatch-denied',deny);window.addEventListener('ns-field-access-denied',deny);
  async function draw(value,offline=false,properties={}) {
    day=value;views.forEach(v=>v.dispose());views=[];clear(content);
    content.append(el('p',{text:`${value.location_name} — ${value.work_date}; dispatch revision ${value.revision}.`}),
      el('p',{text:value.work_day_timezone_state==='configured'?`Operating day: ${value.work_day_timezone}.`:'Operating timezone unconfigured — day boundaries are UTC.'}),
      el('p',{class:'hint',text:`Window: ${value.window_starts_at} to ${value.window_ends_at}.`}),
      el('p',{text:`Load: ${value.load_plan.state}${value.load_plan.needs_rebuild?' — owner rebuild required':''}. ${value.load_plan.invalidated_reason||''}`}),
      el('a',{class:'btn',href:`#/load?vehicle=${encodeURIComponent(value.location_code)}&date=${encodeURIComponent(value.work_date)}`,text:'Review vehicle load'}));
    if(!value.stops.length)content.append(el('p',{text:'No stops on this vehicle’s operating day.'}));
    for(const stop of value.stops) {
      const card=el('article',{class:'card','data-dispatch-job':stop.job_id},[
        el('h2',{text:stop.customer_name || 'Visit'}),
        el('p',{text:`Order: ${stop.order_state}${stop.position===null?'':` (${stop.position})`}. ${stop.order_state==='stale'?'Previous order is stale; displayed in server order.':''}`}),
        el('p',{text:`${stop.assigned?'Explicit vehicle assignment':'One-vehicle default; not an explicit assignment'}. Commercial status: ${stop.status}.`}),
        el('button',{class:'btn',text:'Open visit workspace',onClick:()=>navigate(`/visit/${stop.job_id}`)})]);
      content.append(card);
      if(stop.property_id) {
        if(offline&&!properties[stop.property_id])card.append(el('p',{text:'Property instructions were not saved. Reconnect for scoped access.'}));
        else {const view=createFieldProperty({jobId:stop.job_id,propertyId:stop.property_id,ownerId:owner,
          offlineValue:offline?properties[stop.property_id]:null});views.push(view);
          const details=el('details',{},[el('summary',{text:'Property instructions and crew actions'}),view.root]);
          let started=false;
          details.addEventListener('toggle',()=>{if(details.open&&!started){started=true;void view.start();}});
          card.append(details);}
      } else card.append(el('p',{text:'No property linked to this stop.'}));
    }
    if(value.unassigned_jobs.length)content.append(el('section',{class:'card'},[el('h2',{text:'Work needing vehicle assignment'}),
      el('p',{text:'With two active vehicles this work belongs to neither plan. Ask the owner to assign it.'}),
      ...value.unassigned_jobs.map(job=>el('p',{text:job.customer_name || job.job_id}))]));
  }
  async function openSaved(token) {
    const cached=await savedDispatch();if(!cached)throw new Error('No recent authorized dispatch snapshot is saved. Reconnect to prepare work.');
    if(token!==attempt||dead||await localAccount()!==owner)return;
    const requestedCode=vehicle.value||params.get('vehicle'),requestedDate=params.get('date')||(!cacheMode?date.value:null);
    if(requestedCode&&requestedCode!==cached.day.location_code || requestedDate&&requestedDate!==cached.day.work_date)
      throw new Error('That vehicle/day was not saved. No other day was substituted.');
    vehicle.replaceChildren(el('option',{value:cached.day.location_code,text:cached.day.location_name}));date.value=cached.day.work_date;
    vehicle.disabled=true;date.disabled=true;cacheMode=true;
    await draw(cached.day,true,cached.properties);
    status.textContent=`Saved ${new Date(cached.savedAt).toLocaleString()}; not current server data. Offline access expires after 24 hours.`;
  }
  async function read() {
    const token=++attempt;views.forEach(v=>v.dispose());views=[];day=null;clear(content);
    status.textContent='Ordered route pending — reading the server…';refresh.disabled=true;save.disabled=true;
    try {
      if(cacheMode || !navigator.onLine) {cacheMode=true;await openSaved(token);return;}
      vehicle.disabled=false;date.disabled=false;
      const vehicles=await loadVehicles();if(await localAccount()!==owner||token!==attempt||dead)return;
      const code=vehicle.value||params.get('vehicle')||vehicles[0]?.code;
      vehicle.replaceChildren(...vehicles.map(v=>el('option',{value:v.code,text:v.name})));vehicle.value=code||'';
      if(!vehicles.some(v=>v.code===code))throw Object.assign(new Error('No authorized vehicle selected. No vehicle was guessed.'),{code:'42501'});
      const result=await dispatchRead(code,date.value);
      if(await localAccount()!==owner||token!==attempt||dead)return;
      await draw(result);status.textContent='Ordered day received from the server. No routing, ETA or stock movement was calculated.';
    } catch(error) {
      if(dead||token!==attempt||await localAccount()!==owner)return;
      if(accessDenied(error))await retireDispatch(owner);
      else if(!cacheMode && looksOffline(error)) {
        try {await openSaved(token);}
        catch {status.textContent='No recent authorized dispatch snapshot for this vehicle/day. Reconnect to prepare work.';}
      }
      else status.textContent=`Ordered day unavailable: ${error.code==='PGRST202'?'Dispatch backend not available in this environment.':error.message}. No cached details were substituted.`;
    } finally {refresh.disabled=false;save.disabled=cacheMode||!navigator.onLine||!day;}
  }
  refresh.onclick=()=>{cacheMode=false;return read();};vehicle.onchange=read;date.onchange=read;
  save.onclick=async()=>{
    if(!day || !navigator.onLine)return;
    save.disabled=true;status.textContent='Saving instructions — checking current access…';
    const epoch=dispatchEpoch(owner),token=attempt;
    try {
      const current=await dispatchRead(day.location_code,day.work_date),properties={};
      if(current.stops.length>20)throw new Error('This day exceeds the 20-stop offline limit.');
      for(const stop of current.stops)if(stop.property_id&&!properties[stop.property_id])properties[stop.property_id]=await propertyRead(stop.property_id);
      if(dead||token!==attempt||await localAccount()!==owner)return;
      await saveDispatch(current,properties,owner,epoch);
      status.textContent='Dispatch coordinates, zones and operational notes saved for 24 hours. Access codes and private internal notes were excluded. Writes and navigation maps are not cached.';
    } catch(error) {if(accessDenied(error))await retireDispatch(owner);
      else if(!dead&&token===attempt)status.textContent=`Dispatch not saved: ${error.message}`;
    } finally {save.disabled=!navigator.onLine||!day;}
  };
  await read();
}
