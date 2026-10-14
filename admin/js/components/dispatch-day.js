import * as api from '../lib/api.js';
import { el, select, confirmAction } from '../../../shared/dom.js';
import { fill } from '../lib/admin-dom.js';
import { trySave } from '../lib/save.js';
import { date, dateTime } from '../../../shared/format.js';

/* Today's work, in order, for one or two cars.
 *
 * WHAT THIS SCREEN IS. Help the owner plan the day and understand delays.
 * It is not a fleet command centre: there is no routing, no optimisation,
 * no travel time, no map and no tracking. The order is the owner's, set by
 * hand, and the backend holds the version so two people editing at once
 * refuse each other instead of overwriting.
 *
 * THREE THINGS THIS SCREEN WILL NOT DO, each because the backend will not
 * either and a screen that implied otherwise would be lying:
 *
 *  * It does not move stock. Reassigning a job re-plans both cars' loads
 *    and transfers nothing; the washer is still wherever it physically is.
 *  * It does not complete anything. "Work finished" is the crew downing
 *    tools; an accepted completion needs evidence and goes through the
 *    completion screen. Both states are shown, separately, always.
 *  * It does not send a message by being opened. The two customer messages
 *    are buttons, and their outcome is reported honestly -- including
 *    "no SMS provider is configured", which is not a send.
 *
 * REORDERING IS KEYBOARD-FIRST. Move up / move down buttons, not drag and
 * drop: a drag handle is unusable with a keyboard and awkward with gloves.
 */

const STATE_LABEL = {
  planned: 'Planned',
  skipped: 'Skipped',
  blocked: 'Blocked',
  work_finished: 'Work finished'
};
const STATE_BADGE = {
  planned: 'badge--muted',
  skipped: 'badge--warn',
  blocked: 'badge--warn',
  work_finished: 'badge--ok'
};

/* The six conflict answers, in the words an operator can act on. */
const CONFLICT = {
  none: null,
  shared_scarce: ['badge--warn', 'Both cars need it',
    'There is not enough to go round. Decide which car has it.'],
  unavailable: ['badge--warn', 'None usable',
    'Nothing usable at Base or on either car.'],
  damaged_only: ['badge--warn', 'Only damaged ones',
    'What we have is in the damaged pool, so it is not available to load.'],
  location_unknown: ['badge--warn', 'Where is it?',
    'The ledger has one, but not at Base or on a car. Find it before relying on it.'],
  missing_data: ['badge--warn', 'Never counted',
    'Nothing records how many we have. That is missing information, not zero.']
};

const todayISO = () => new Date().toISOString().slice(0, 10);

export function dispatchDayPanel({ locationCode = 'car_a', workDate } = {}) {
  const host = el('div', {});
  let code = locationCode;
  let day = workDate || todayISO();
  let read = null;
  let conflicts = null;
  let statuses = new Map();
  let loading = true;
  let loadError = null;
  let busy = false;

  function paint() { fill(host, body()); }

  async function act(btn, fn, success) {
    if (busy) return false;
    const was = btn ? btn.textContent : null;
    busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    const ok = await trySave(fn, { success, after: async () => { await load(); } });
    busy = false;
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = was; }
    /* A refusal here means this screen is out of date -- somebody else
       reordered, reassigned or rescheduled. The recovery is to show what
       the day says NOW; the toast keeps the reason. */
    if (!ok) await load();
    return ok;
  }

  async function load() {
    loading = true; loadError = null; paint();
    try {
      const [r, c] = await Promise.all([
        api.getDispatchDay({ locationCode: code, workDate: day }),
        api.dispatchEquipmentConflicts({ workDate: day })
      ]);
      read = r;
      conflicts = c;
      /* The four states per stop, read one job at a time rather than
         joined into the day: the dispatch read is about the day, and
         inventing a combined DTO here is exactly the drift the load
         contract was corrected for. */
      statuses = new Map();
      for (const stop of r.stops || []) {
        try {
          const s = await api.jobDispatchStatus(stop.job_id);
          if (s) statuses.set(stop.job_id, s);
        } catch { /* a status that cannot be read is simply not shown */ }
      }
    } catch (err) {
      read = null; conflicts = null;
      loadError = err?.message || 'Could not load the day.';
    } finally {
      loading = false; paint();
    }
  }

  /* ------------------------------------------------------- the header -- */

  function controls() {
    const vehicles = (read?.readable_vehicles || []);
    return el('div', { class: 'grid grid--2', style: 'margin:0 0 10px' }, [
      el('div', {}, [
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Vehicle' }),
          select(
            vehicles.length
              ? vehicles.map((v) => ({ value: v.code, label: v.name }))
              : [{ value: code, label: code }],
            code,
            // select() passes the change EVENT, as every other admin view
            // expects; a callback taking a value would be handed an Event.
            (e) => { code = e.target.value; load(); })
        ])
      ]),
      el('div', {}, [
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Day' }),
          el('input', {
            type: 'date', value: day,
            onChange: (e) => { day = e.target.value || todayISO(); load(); }
          })
        ])
      ])
    ]);
  }

  /* WHICH DAY IS THIS. Same notice the load screen carries, from the same
     backend fields: until the owner sets an operating timezone the backend
     counts a day as midnight to midnight UTC, which can put a
     late-afternoon visit on the next day's list. */
  function timezoneNotice() {
    if (!read || read.work_day_timezone_state !== 'unconfigured') return null;
    return el('p', { class: 'hint', style: 'margin:0 0 8px', text:
      'The operating day has no timezone set, so this list counts a day as '
      + 'midnight to midnight UTC. Work booked late in the afternoon can '
      + 'appear on the next day. Set it in Settings.' });
  }

  function loadPlanNotice() {
    const lp = read?.load_plan;
    if (!lp || !lp.needs_rebuild) return null;
    return el('div', { class: 'section-box', style: 'margin:0 0 10px' }, [
      el('h3', { text: 'The load plan needs rebuilding', style: 'margin:0 0 6px' }),
      el('p', { class: 'hint', style: 'margin:0 0 6px', text:
        `Revision ${lp.revision} was built before this day changed `
        + `(${lp.invalidated_reason || 'a dispatch change'}). Confirming it `
        + 'is refused until it is rebuilt — rebuilding recommends and moves '
        + 'nothing.' }),
      el('p', { class: 'hint', style: 'margin:0', text:
        'Rebuild it on the Daily load screen for this car.' })
    ]);
  }

  /* --------------------------------------------------------- the stops -- */

  function moveStop(fromIndex, delta) {
    const ids = read.stops.map((s) => s.job_id);
    const to = fromIndex + delta;
    if (to < 0 || to >= ids.length) return null;
    const next = ids.slice();
    [next[fromIndex], next[to]] = [next[to], next[fromIndex]];
    return next;
  }

  function stopRow(stop, index) {
    const status = statuses.get(stop.job_id);
    const state = status?.dispatch_state || 'planned';
    const vehicles = (read.readable_vehicles || []);

    return el('div', { class: 'row-item' }, [
      el('div', { style: 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap' }, [
        el('strong', { text: `${index + 1}. ${stop.customer_name || 'Customer'}` }),
        el('span', { class: `badge ${STATE_BADGE[state] || 'badge--muted'}`,
          text: STATE_LABEL[state] || state }),
        /* THE COMPLETION STATE IS ITS OWN BADGE. "Work finished" and
           "completed" are two different things and are never merged. */
        status?.completion_state === 'accepted'
          ? el('span', { class: 'badge badge--ok', text: 'Completion accepted' })
          : null,
        status && Number(status.open_issue_count) > 0
          ? el('span', { class: 'badge badge--warn',
              text: `${status.open_issue_count} open issue` })
          : null,
        stop.order_state === 'stale'
          ? el('span', { class: 'badge badge--warn', text: 'Order from another day' })
          : null
      ].filter(Boolean)),

      el('p', { class: 'hint', style: 'margin:0', text:
        (stop.scheduled_for ? dateTime(stop.scheduled_for) : 'No time set')
        + ` · job status ${stop.status || 'unknown'}`
        + (stop.assigned ? ' · assigned to this car'
                         : ' · not explicitly assigned') }),

      status?.dispatch_reason
        ? el('p', { class: 'hint', style: 'margin:0', text: status.dispatch_reason })
        : null,

      /* A CREW GETS NO PLANNING CONTROLS AT ALL, not disabled ones. A
         button it can never use is noise on a small screen, and the
         backend would refuse it anyway (`can_plan` is is_owner()). */
      el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, (!read.can_plan ? [] : [
        el('button', {
          class: 'btn btn--sm', type: 'button', text: 'Move up',
          disabled: busy || index === 0 ? true : undefined,
          title: 'Earlier in the day.',
          onClick: (e) => {
            const next = moveStop(index, -1);
            if (!next) return;
            return act(e.currentTarget, () => api.reorderDispatchDay({
              locationCode: code, workDate: day, jobIds: next,
              expectedRevision: read.revision
            }), 'Order saved.');
          }
        }),
        el('button', {
          class: 'btn btn--sm', type: 'button', text: 'Move down',
          disabled: busy || index === read.stops.length - 1 ? true : undefined,
          title: 'Later in the day.',
          onClick: (e) => {
            const next = moveStop(index, 1);
            if (!next) return;
            return act(e.currentTarget, () => api.reorderDispatchDay({
              locationCode: code, workDate: day, jobIds: next,
              expectedRevision: read.revision
            }), 'Order saved.');
          }
        }),
        vehicles.length > 1
          ? el('button', {
              class: 'btn btn--sm', type: 'button', text: 'Move to other car',
              disabled: busy ? true : undefined,
              title: 'Re-plans both cars’ loads. Moves no stock.',
              onClick: (e) => {
                const other = vehicles.find((v) => v.code !== code);
                if (!other) return;
                if (!confirmAction(
                  `Move this job to ${other.name}? Both cars’ load plans `
                  + 'will need rebuilding. No stock moves.')) return;
                return act(e.currentTarget, () => api.assignJobToVehicle({
                  jobId: stop.job_id, locationCode: other.code,
                  expectedRevision: read.revision,
                  reason: 'Moved on the dispatch screen'
                }), 'Moved. Both load plans need rebuilding.');
              }
            })
          : null,
        el('button', {
              class: 'btn btn--sm', type: 'button',
              text: state === 'skipped' ? 'Put back on the day' : 'Skip today',
              disabled: busy ? true : undefined,
              onClick: (e) => {
                const next = state === 'skipped' ? 'planned' : 'skipped';
                const reason = next === 'skipped'
                  ? window.prompt('Why is this stop being skipped today?')
                  : null;
                if (next === 'skipped' && !reason) return;
                return act(e.currentTarget, () => api.setDispatchStage({
                  jobId: stop.job_id, state: next, reason,
                  expectedVersion: status?.dispatch_lock_version ?? null
                }), next === 'skipped' ? 'Skipped today.' : 'Back on the day.');
              }
            })
      ]).filter(Boolean))
    ].filter(Boolean));
  }

  function stopsBody() {
    if (!read.stops.length) {
      return el('p', { class: 'hint', text:
        `Nothing on ${read.location_name || code} for ${date(day)}.`
        + (read.unassigned_jobs.length
            ? ' There is work below that needs a car.' : '') });
    }
    return el('div', {}, [
      el('p', { class: 'hint', style: 'margin:0 0 6px', text:
        `Revision ${read.revision}. `
        + (read.stops.every((s) => s.order_state === 'derived')
            ? 'Nobody has set an order, so these are in time order.'
            : 'Ordered by hand.') }),
      el('div', {}, read.stops.map(stopRow))
    ]);
  }

  /* ---------------------------------------------------- unassigned work -- */

  function unassignedBody() {
    const list = read.unassigned_jobs || [];
    if (!list.length) return null;
    const vehicles = read.readable_vehicles || [];
    return el('div', { class: 'section-box', style: 'margin:10px 0 0' }, [
      el('h3', { text: `Needs a car (${list.length})`, style: 'margin:0 0 6px' }),
      /* WHY THIS LIST EXISTS AT ALL. With two cars an unassigned job
         belongs to NEITHER plan. The backend reports it rather than
         guessing, and so does this screen: guessing a car is how a crew
         arrives without the kit. */
      el('p', { class: 'hint', style: 'margin:0 0 6px', text: read.can_plan
        ? 'Two cars are active, so work with no car named belongs to neither '
          + 'day. Nothing is guessed.'
        : 'Two cars are active, so work with no car named belongs to neither '
          + 'day. If you are the one doing it, say so \u2014 that is how the '
          + 'load plan and the paperwork know which car was there.' }),
      el('div', {}, list.map((u) => el('div', { class: 'row-item' }, [
        el('strong', { text: u.customer_name || 'Customer' }),
        el('p', { class: 'hint', style: 'margin:0', text:
          (u.scheduled_for ? dateTime(u.scheduled_for) : 'No time set')
          + ` · ${u.status || 'unknown'}` }),
        read.can_plan
          ? el('div', { class: 'btn-row', style: 'flex-wrap:wrap' },
              vehicles.map((v) => el('button', {
                class: 'btn btn--sm', type: 'button', text: `Give to ${v.name}`,
                disabled: busy ? true : undefined,
                onClick: (e) => act(e.currentTarget, () => api.assignJobToVehicle({
                  jobId: u.job_id, locationCode: v.code,
                  reason: 'Assigned on the dispatch screen'
                }), `Assigned to ${v.name}. That car’s load plan needs rebuilding.`)
              })))
          /* THE CREW'S OWN DOOR (15.1). An owner assigns; a crew says "this
             one is on my car". Before 15.1 a crew could complete an
             unassigned job that dispatch and the load plan both excluded,
             which is the mismatch the release review closed -- and closing
             it would have stranded a crew holding work it had already done
             if this control did not exist. It appears only for a crew,
             because `can_plan` is false for one and an owner has no car of
             their own to claim onto. */
          : el('div', { class: 'btn-row' }, [
              el('button', {
                class: 'btn', type: 'button', text: 'This one is on my car',
                disabled: busy ? true : undefined,
                onClick: (e) => act(e.currentTarget, () => api.claimJobForVehicle({
                  jobId: u.job_id,
                  reason: 'Claimed on the dispatch screen by the crew working it'
                }), 'Claimed. Your load plan needs rebuilding.')
              })
            ])
      ].filter(Boolean))))
    ]);
  }

  /* ------------------------------------------------------- conflicts -- */

  function conflictsBody() {
    const items = (conflicts?.items || []).filter(
      (i) => i.conflict && i.conflict !== 'none');
    if (!items.length) return null;
    return el('div', { class: 'section-box', style: 'margin:10px 0 0' }, [
      el('h3', { text: `Equipment to sort out (${items.length})`,
        style: 'margin:0 0 6px' }),
      el('p', { class: 'hint', style: 'margin:0 0 6px', text:
        'Whole-day needs against what the ledger actually says. Showing a '
        + 'conflict transfers, reserves and buys nothing.' }),
      el('div', {}, items.map((i) => {
        const [badge, label, explain] = CONFLICT[i.conflict] || [];
        return el('div', { class: 'row-item' }, [
          el('div', { style: 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap' }, [
            el('strong', { text: i.material_name || 'item' }),
            label ? el('span', { class: `badge ${badge}`, text: label }) : null
          ].filter(Boolean)),
          explain ? el('p', { class: 'hint', style: 'margin:0', text: explain }) : null,
          el('p', { class: 'hint', style: 'margin:0', text:
            `Needed by ${(i.needed_by || []).join(' and ')} · `
            /* UNKNOWN IS NEVER ZERO: null prints as "not recorded". */
            + (i.level_state
                ? `level at Base: ${i.level_state}`
                : `at Base: ${i.usable_at_base === null
                    ? 'not recorded' : i.usable_at_base}`)
            + (Number(i.damaged_at_base) > 0
                ? ` · ${i.damaged_at_base} damaged` : '') })
        ].filter(Boolean));
      }))
    ]);
  }

  /* ------------------------------------------------------------- body -- */

  function body() {
    return el('div', { class: 'card' }, [
      el('h2', { text: 'Dispatch', style: 'margin:0 0 4px' }),
      el('p', { class: 'hint', style: 'margin:0 0 10px', text:
        'Today’s work in order, for one car at a time. Ordering and '
        + 'reassigning are the owner’s; nothing here moves stock or '
        + 'completes work.' }),
      controls(),
      loading
        ? el('p', { class: 'hint', text: 'Loading the day…' })
        : loadError
          ? el('p', { class: 'error-text', text: loadError })
          : el('div', {}, [
              timezoneNotice(),
              loadPlanNotice(),
              stopsBody(),
              unassignedBody(),
              conflictsBody()
            ].filter(Boolean))
    ]);
  }

  paint();
  load();
  return host;
}
