import { el, clear } from '../../../shared/dom.js';
import { supabase } from '../../../shared/supabase.js';
import { operationsAvailability, readResult, readRelations } from '../lib/operations-availability.js';

const COPY = {
  backend_missing: 'The required backend functions or tables are not available on this server. The operations migrations may be pending, or its schema cache may need refreshing. An owner must verify the backend before this feature can be used.',
  owner_only: 'This is an owner management panel. Use the field console for your assigned work; owner controls are unavailable to this account.',
  denied: 'The server refused access. No saved working details are used to bypass that decision.',
  offline: 'No connection. This management feature needs an online backend check; no operation was submitted.',
  timeout: 'The backend check timed out. Availability is unconfirmed; no operation was submitted.',
  unconfirmed: 'The backend check did not succeed. Availability is unconfirmed; no operation was submitted.'
};

function statusCard(host, title, state, retry) {
  clear(host).append(el('section', { class: 'card', 'aria-label': title }, [
    el('h2', { text: `${title} — unavailable` }),
    el('p', { role: 'status', text: COPY[state] || COPY.unconfirmed }),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn', type: 'button', text: `Check ${title.toLowerCase()} again`, onClick: retry }),
      state === 'owner_only' ? el('a', { class: 'btn', href: 'field.html#/dispatch', text: 'Open field console' }) : null
    ].filter(Boolean))
  ]));
}

async function featurePanel(ctx, host, title, read, mount) {
  let attempt = 0;
  async function check() {
    const here = ++attempt;
    clear(host).append(el('section', { class: 'card', 'aria-label': title }, [
      el('h2', { text: title }),
      el('p', { role: 'status', text: 'Checking backend availability…' })
    ]));
    const result = await operationsAvailability(title, read);
    if (here !== attempt || ctx.isCurrent?.() === false) return;
    if (result.state !== 'available') return statusCard(host, title, result.state, check);
    try {
      await mount(result.value);
    } catch {
      if (here === attempt && ctx.isCurrent?.() !== false) statusCard(host, title, 'unconfirmed', check);
    }
  }
  await check();
}

export async function renderInventoryRoute(ctx) {
  ctx.setContextParent?.('/dashboard');
  const host = el('div');
  clear(ctx.mount).append(el('div', { class: 'page-head' }, [
    el('h1', { text: 'Inventory' }),
    el('p', { text: 'Stock, purchasing, Christmas sets, kits and daily loading.' })
  ]), host);
  await featurePanel(ctx, host, 'Inventory', signal => readRelations([
    'ns_materials', 'ns_material_stock', 'ns_stock_locations',
    'ns_material_stock_by_location', 'ns_stock_reservations',
    'ns_seasonal_assignments', 'ns_kit_sheets', 'ns_load_plans'
  ], signal), async () => {
    const { renderInventory } = await import('./inventory.js');
    if (ctx.isCurrent?.() === false) return;
    clear(ctx.mount).append(host);
    await renderInventory({ ...ctx, mount: host });
  });
}

function deviceDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export async function renderDispatchRoute(ctx) {
  ctx.setContextParent?.('/jobs?bucket=today');
  const rawDay = ctx.params?.get('day');
  let day = rawDay || deviceDay();
  let code = ctx.params?.get('location') || 'car_a';
  if (!validDay(day) || !['car_a', 'car_b'].includes(code)) {
    clear(ctx.mount).append(el('section', { class: 'card' }, [
      el('h1', { text: 'Dispatch selection is invalid' }),
      el('p', { text: 'Choose a valid calendar day and Car A or an existing Car B.' }),
      el('a', { class: 'btn', href: '#/dispatch', text: 'Choose today' })
    ]));
    return;
  }
  const query = () => new URLSearchParams({ location: code, day }).toString();
  ctx.replaceQuery?.(query());
  const host = el('div');
  clear(ctx.mount).append(el('div', { class: 'page-head' }, [
    el('a', { class: 'hint', href: '#/jobs?bucket=today', text: '← Today’s jobs' }),
    el('h1', { text: 'Dispatch day' }),
    el('p', { text: `Selected day: ${day}. A default day uses this device’s calendar; the backend’s operating window is shown when available.` })
  ]), host);
  await featurePanel(ctx, host, 'Dispatch', async signal => {
    readResult(await supabase.rpc('get_dispatch_day', { p_location_code: code, p_work_date: day }).abortSignal(signal));
    readResult(await supabase.rpc('dispatch_equipment_conflicts', { p_work_date: day }).abortSignal(signal));
  }, async () => {
    const { dispatchDayPanel } = await import('../components/dispatch-day.js');
    if (ctx.isCurrent?.() === false) return;
    const panel = dispatchDayPanel({ locationCode: code, workDate: day });
    // Capture selection before the unchanged component repaints its controls.
    panel.addEventListener('change', event => {
      if (event.target === panel.querySelector('select')) code = event.target.value;
      else if (event.target === panel.querySelector('input[type="date"]')) day = event.target.value || deviceDay();
      else return;
      ctx.replaceQuery?.(query());
      ctx.mount.querySelector('.page-head p').textContent = `Selected day: ${day}. The backend’s operating window is shown below.`;
    }, true);
    clear(host).append(panel);
  });
}

export async function mountPropertyAccess(ctx, propertyId) {
  const host = el('div');
  ctx.mount.append(host);
  await featurePanel(ctx, host, 'Property access and work zones', async signal => {
    readResult(await supabase.rpc('get_property_access', { p_property_id: propertyId }).abortSignal(signal));
  }, async () => {
    const { propertyAccessPanel } = await import('../components/property-access.js');
    if (ctx.isCurrent?.() !== false) clear(host).append(propertyAccessPanel({ propertyId }));
  });
}

export async function mountJobOperations(ctx, jobId) {
  const host = el('section', { 'aria-label': 'Job operations' });
  // The Codex job keeps its ordered measurement saves and quote action guard.
  // Add panels beside its pricing/quote area without rewriting Claude's view.
  const quotes = [...ctx.mount.querySelectorAll('h2')].find(h => h.textContent === 'Quotes');
  const quoteCard = quotes?.closest('.card');
  if (quoteCard) quoteCard.before(host); else ctx.mount.append(host);
  const materialHost = el('div'), evidenceHost = el('div'), handoverHost = el('div');
  host.append(materialHost, evidenceHost, handoverHost);
  const completeButton = [...ctx.mount.querySelectorAll('button')]
    .find(button => button.textContent === 'Mark job complete');
  let completionAvailable = false;
  if (completeButton) {
    // The imported API now completes through an RPC. Do not offer the old
    // desk button when that RPC's read prerequisites are unavailable.
    completeButton.disabled = true;
    ctx.mount.addEventListener('click', event => {
      if (!completionAvailable && (event.target === completeButton || completeButton.contains(event.target))) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, true);
  }
  await Promise.all([
    featurePanel(ctx, materialHost, 'Job materials', signal => readRelations([
      'ns_materials', 'ns_job_material_sheets', 'ns_job_material_sheet_lines'
    ], signal), async () => {
      const [materials, sheets] = await Promise.all([
        import('../components/job-materials.js'), import('../components/job-material-sheet.js')
      ]);
      if (ctx.isCurrent?.() !== false) clear(materialHost).append(
        materials.createJobMaterialsPanel({ jobId }).root,
        sheets.createJobMaterialSheetPanel({ jobId }).root
      );
    }),
    featurePanel(ctx, evidenceHost, 'Completion evidence', signal => readRelations([
      'ns_job_evidence_readiness', 'ns_job_evidence', 'ns_evidence_exceptions'
    ], signal), async () => {
      const { jobEvidencePanel } = await import('../components/job-evidence.js');
      if (ctx.isCurrent?.() !== false) {
        clear(evidenceHost).append(jobEvidencePanel({ jobId }).root);
        completionAvailable = true;
        ctx.onCompletionAvailable?.();
        if (completeButton) completeButton.disabled = false;
      }
    }),
    mountHandoverAgain()
  ]);
  async function mountHandoverAgain() {
    // Read a fresh authoritative accepted id after an evidence/completion change;
    // never infer it from job.status or a client-side completion gesture.
    await featurePanel(ctx, handoverHost, 'Customer handover', async signal => {
      readResult(await supabase.rpc('job_completion_reports', { p_job_id: jobId }).abortSignal(signal));
      readResult(await supabase.rpc('job_payment_state', { p_job_id: jobId }).abortSignal(signal));
      return readResult(await supabase.from('ns_job_evidence_readiness').select('completion_open,latest_completion_id')
        .eq('job_id', jobId).single().abortSignal(signal));
    }, async readiness => {
      const { customerHandoverPanel } = await import('../components/customer-handover.js');
      if (ctx.isCurrent?.() !== false) clear(handoverHost).append(
        el('button', { class: 'btn', type: 'button', text: 'Refresh accepted completion for handover', onClick: mountHandoverAgain }),
        customerHandoverPanel({ jobId, completionId: readiness?.completion_open === true ? readiness.latest_completion_id : null })
      );
    });
  }
}
