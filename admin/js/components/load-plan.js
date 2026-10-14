import * as api from '../lib/api.js';
import { el, select, confirmAction } from '../../../shared/dom.js';
import { fill } from '../lib/admin-dom.js';
import { trySave, describeWriteError } from '../lib/save.js';
import { date, dateTime } from '../../../shared/format.js';

/* What a car should carry on a given day.
 *
 * THE DISTINCTION THIS SCREEN KEEPS. Building a plan recommends. Confirming
 * it moves stock. They are two buttons for a reason: a crew looking at a
 * list has not yet loaded anything, and a screen that blurred the two would
 * let a van's balance change because somebody opened a page.
 *
 * SIX NUMBERS, NOT ONE. "Needed: 12" tells you nothing about whether you
 * have it, whether it is promised elsewhere, or whether Base can cover the
 * gap. Required / aboard / reserved / available / damaged / shortage are
 * shown separately because they are six different questions, and an
 * operator standing at a van needs the one that applies.
 *
 * A LEVEL IS NOT A NUMBER. Empty / Low / Enough is the whole answer for a
 * level-tracked supply. This screen renders the level and never a zero;
 * the backend will not even store a quantity beside one.
 *
 * NEEDS REVIEW IS NOT A SHORTAGE. "We are 20 L short" is a known gap.
 * "Nobody recorded how much this job uses" is missing information. They get
 * different treatment because they need different action. */

const ACTIONS = [
  ['keep',   'Keep aboard',  'What stays on the van.'],
  ['add',    'Add',          'What to put on before leaving.'],
  ['return', 'Return',       'What to take off and leave at Base.'],
  /* 'skip' is a line the OWNER authorised going without. Confirming does
     not transfer it. It had no group here, so an authorised departure was
     invisible on this screen while being perfectly visible in the backend's
     response -- the half of finding 6 that lived in the admin console. */
  ['skip',   'Set aside',
   'The owner authorised going without these. Confirming does not move them.']
];

const LEVEL_LABEL = { empty: 'Empty', low: 'Low', enough: 'Enough' };
const LEVEL_BADGE = { empty: 'badge--warn', low: 'badge--warn', enough: 'badge--ok' };

function labelled(text, control, hint) {
  return el('div', { style: 'margin:0' }, [
    el('label', { class: 'field', style: 'margin:0' }, [
      el('span', { text }),
      control
    ]),
    hint ? el('p', { class: 'hint', style: 'margin:4px 0 0', text: hint }) : null
  ].filter(Boolean));
}

const todayISO = () => new Date().toISOString().slice(0, 10);

/** The quantity line. Deliberately spells out which number is which: an
 *  unlabelled row of figures is how "available" gets read as "aboard". */
function quantityText(line) {
  if (line.level_state) return null;
  // A line with NO quantities at all is a seasonal set: an asset the crew
  // carries, with no balance anywhere. Defaulting aboard to 0 printed
  // "aboard 0" against a set, which reads as "we have none of it" -- the
  // same mistake as rendering a level supply as zero.
  const QUANTITIES = ['required_qty', 'aboard_qty', 'reserved_qty',
                      'available_qty', 'damaged_qty', 'shortage_qty'];
  if (QUANTITIES.every((f) => line[f] === null || line[f] === undefined)) return null;
  const bits = [];
  if (line.required_qty !== null && line.required_qty !== undefined) {
    bits.push(`needs ${line.required_qty}`);
  }
  bits.push(`aboard ${line.aboard_qty ?? 0}`);
  if (Number(line.reserved_qty) > 0) bits.push(`${line.reserved_qty} promised elsewhere`);
  if (line.available_qty !== null && line.available_qty !== undefined) {
    bits.push(`${line.available_qty} free at Base`);
  }
  if (Number(line.damaged_qty) > 0) bits.push(`${line.damaged_qty} damaged`);
  return bits.join(' · ') + (line.unit ? ` (${line.unit})` : '');
}

/** A calendar date, or null. The `type=date` input yields '' when the
 *  operator clears it and a browser that falls back to a text input can
 *  yield anything at all, so a selection is only reported once it is a date
 *  the backend could be asked about. No timezone arithmetic happens here on
 *  purpose: `work_date` is a bare calendar date and the OPERATING DAY it
 *  stands for is resolved server-side from the owner's timezone setting
 *  (see timezoneNotice below and docs/daily-load-contract-v1.md v2.1 §2a).
 *  Normalising it against the device clock is precisely the bug that
 *  notice exists to report. */
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects 2026-02-31, which the regex accepts and Date rolls forward.
  return parsed.toISOString().slice(0, 10) === value ? value : null;
}

/* THE SELECTION INTERFACE (integration hooks).
 *
 *   loadPlanPanel({ locationCode, workDate, onSelectionChange })
 *
 *   locationCode       which vehicle to open on. Default 'car_a'. An unknown
 *                      or absent code is kept and shown as itself rather than
 *                      silently swapped for a real one: the panel must not
 *                      invent a vehicle, and Car B is optional data that may
 *                      not exist -- nothing here seeds or activates it.
 *   workDate           the calendar date to open on, 'YYYY-MM-DD'. Anything
 *                      that is not a valid date is ignored in favour of
 *                      today, which is the pre-existing default.
 *   onSelectionChange  optional. Called as ({ locationCode, workDate }) each
 *                      time the operator makes a VALID change -- after the
 *                      panel has adopted it and before the reload settles.
 *                      Not called on mount, so a caller cannot mistake the
 *                      defaults for a choice somebody made, and not called
 *                      for an invalid or unchanged selection. A throwing
 *                      caller cannot take the panel down with it.
 *
 * Existing callers that pass nothing keep today's behaviour exactly: Car A,
 * today, and no notification. The caller decides what to do with a change
 * (the Inventory view puts it in the query string so a reload keeps it);
 * this panel deliberately does not touch the router itself, because it is
 * also mounted on screens that own their own URL. */
export function loadPlanPanel({ locationCode = 'car_a', workDate, onSelectionChange } = {}) {
  const host = el('div', {});
  let code = locationCode;
  let day = validDay(workDate) || todayISO();

  /** Reports a selection the panel has actually adopted. Swallows a caller's
   *  error on purpose: a router that throws must not leave the operator
   *  looking at a half-painted load plan. */
  function announce() {
    if (typeof onSelectionChange !== 'function') return;
    try {
      onSelectionChange({ locationCode: code, workDate: day });
    } catch (err) {
      console.warn('loadPlanPanel: onSelectionChange threw', err);
    }
  }

  let dayRead = null;
  let plan = null;
  let locations = [];
  let suggestions = null;
  let loading = true;
  let loadError = null;
  let busy = false;

  async function act(btn, fn, success) {
    if (busy) return false;
    const was = btn ? btn.textContent : null;
    busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    const ok = await trySave(fn, { success, after: async () => { await load(); } });
    busy = false;
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = was; }
    return ok;
  }

  async function load() {
    loading = true; loadError = null; paint();
    try {
      /* getLoadPlan now returns the contract's ENVELOPE, not the plan:
         `state`, `can_build`, the two counts and the day's visits sit
         beside it. The 10.1 corrective moved the read to get_load_plan()
         because the DTO this component used to be handed had drifted from
         the frozen document -- see docs/daily-load-contract-v1.md v2 §1. */
      const [locs, read] = await Promise.all([
        api.listStockLocations(),
        api.getLoadPlan({ locationCode: code, workDate: day })
      ]);
      locations = locs.filter((l) => l.kind === 'vehicle');
      dayRead = read;
      plan = read ? read.plan : null;
      suggestions = plan
        ? await api.nextDaySuggestions({ locationCode: code, workDate: day })
        : null;
    } catch (err) {
      loadError = describeWriteError(err);
    } finally {
      loading = false; paint();
    }
  }

  /* THE SELECTED CODE IS ALWAYS ONE OF THE OPTIONS. A <select> given a
     value none of its options carries falls back to the FIRST option, so a
     URL naming a vehicle the backend has never heard of used to request the
     right van (`code` keeps its value, and the plan read is correct) while
     the control displayed a different one -- Car A's name over Car B's
     plan. Car B is optional data: it may not exist, and this panel may
     neither seed it nor quietly substitute a van that does. So an unknown
     code is listed as itself, marked as unknown, and stays selected. */
  function vehicleOptions() {
    const opts = locations.map((l) => ({ value: l.code, label: l.name }));
    if (!opts.some((o) => o.value === code)) {
      opts.unshift({
        value: code,
        label: locations.length ? `${code} (not a known vehicle)` : code
      });
    }
    return opts;
  }

  function paint() {
    fill(host, [
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head', style: 'flex-wrap:wrap;gap:8px' }, [
          el('div', {}, [
            el('h2', { text: 'Daily load' }),
            el('p', { text:
              'What this car should carry, decided once for the whole day. '
              + 'Building a plan recommends; confirming it is what actually '
              + 'moves stock between Base and the van.' })
          ]),
          el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, [
            labelled('Vehicle', select(
              vehicleOptions(),
              code,
              async (e) => {
                if (e.target.value === code) return;
                code = e.target.value;
                announce();
                await load();
              })),
            labelled('Day', el('input', {
              class: 'input', type: 'date', value: day,
              onChange: async (e) => {
                const picked = validDay(e.target.value);
                // A cleared or unparseable date leaves the panel on the day
                // it was already showing, and the input is put back to it --
                // the alternative is a plan screen with no day, which asks
                // the backend a question it cannot answer.
                if (!picked) { e.target.value = day; return; }
                if (picked === day) return;
                day = picked;
                announce();
                await load();
              }
            }))
          ])
        ]),

        loadError
          ? el('p', { class: 'error-text', text: `Could not load: ${loadError}` })
          : loading
            ? el('p', { class: 'hint', text: 'Loading…' })
            : plan ? planBody() : emptyBody()
      ])
    ]);
  }

  /* WHICH DAY IS THIS. `work_date` is a bare calendar date; the backend
     turns it into a range of instants using the operating timezone the
     owner has set in Settings. Until one is set it uses UTC, which west of
     Greenwich puts a late-afternoon visit on the NEXT day's plan -- while
     the field console's own visit list, bounded at the device's local
     midnight, shows it today. Saying so is the whole point: the previous
     version had an answer nobody had chosen and no way to see it.
     See docs/daily-load-contract-v1.md v2.1 §2a. */
  function timezoneNotice() {
    if (!dayRead || dayRead.work_day_timezone_state !== 'unconfigured') return null;
    return el('p', { class: 'hint', style: 'margin:0 0 8px', text:
      'The operating day has no timezone set, so this plan counts a day as '
      + 'midnight to midnight UTC. Work booked late in the afternoon can '
      + 'fall on the next day’s plan. Set it in Settings to match the '
      + 'day the crew actually works.' });
  }

  function emptyBody() {
    /* `can_build` comes from the backend, because build_load_plan is
       owner-only and a crew facing an empty day needs to be told to ring
       the office rather than shown a button that will refuse it. That was
       the other half of the review's finding 1: the old read path could not
       say who was allowed to do anything. */
    const canBuild = dayRead ? dayRead.can_build : true;
    return el('div', {}, [
      timezoneNotice(),
      el('p', { class: 'hint', text:
        `No plan for ${date(day)} yet. `
        + (canBuild
            ? 'Building one reads the day\u2019s booked work and works out '
              + 'what the van needs. It moves nothing.'
            : 'Only the owner builds a plan \u2014 ring the office and it '
              + 'will appear here.') }),
      canBuild
        ? el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, [
            el('button', {
              class: 'btn btn--sm btn--primary', type: 'button', text: 'Build the plan',
              disabled: busy ? true : undefined,
              onClick: (e) => act(e.currentTarget,
                () => api.buildLoadPlan({ locationCode: code, workDate: day }),
                'Plan built.')
            })
          ])
        : null
    ]);
  }

  function planBody() {
    const review = plan.lines.filter((l) => l.data_state === 'needs_review');
    const short = plan.lines.filter((l) => Number(l.shortage_qty) > 0);

    return el('div', {}, [
      el('p', { class: 'hint', style: 'margin:0 0 8px', text:
        `Revision ${plan.revision}, built ${dateTime(plan.generated_at)}`
        + (plan.confirmed_at ? ` · confirmed ${dateTime(plan.confirmed_at)}` : '')
        + (plan.closed_at ? ` · day closed ${dateTime(plan.closed_at)}` : '') }),

      timezoneNotice(),

      review.length
        ? el('div', { class: 'section-box', style: 'margin:0 0 10px' }, [
            el('h3', { text: 'Needs review', style: 'margin:0 0 6px' }),
            el('p', { class: 'hint', style: 'margin:0 0 6px', text:
              'Not a shortage — something the plan could not work out. Check '
              + 'these before relying on the figures.' }),
            el('ul', { style: 'margin:0;padding-left:18px' }, review.map((l) =>
              el('li', { class: 'hint',
                text: `${l.material_name || l.set_code}: ${l.reason}` })))
          ])
        : null,

      short.length
        ? el('div', { class: 'section-box', style: 'margin:0 0 10px' }, [
            el('h3', { text: 'Short', style: 'margin:0 0 6px' }),
            el('p', { class: 'hint', style: 'margin:0 0 6px', text:
              'Known gaps: the day needs more than the van and Base together '
              + 'can supply.' }),
            el('ul', { style: 'margin:0;padding-left:18px' }, short.map((l) =>
              el('li', { class: 'hint', text:
                `${l.material_name}: short ${l.shortage_qty} ${l.unit || ''}`.trim() })))
          ])
        : null,

      ...ACTIONS.map(([action, title, blurb]) => {
        const lines = plan.lines.filter((l) => l.action === action);
        if (lines.length === 0) return null;
        return el('div', { style: 'margin:0 0 12px' }, [
          el('h3', { text: `${title} (${lines.length})`, style: 'margin:0 0 4px' }),
          el('p', { class: 'hint', style: 'margin:0 0 6px', text: blurb }),
          el('div', {}, lines.map(lineRow))
        ]);
      }).filter(Boolean),

      el('div', { class: 'btn-row', style: 'margin-top:10px;flex-wrap:wrap' }, [
        el('button', {
          class: 'btn btn--sm', type: 'button', text: 'Rebuild',
          disabled: busy ? true : undefined,
          title: 'Reads the schedule again and makes a new revision.',
          onClick: (e) => act(e.currentTarget,
            () => api.buildLoadPlan({ locationCode: code, workDate: day }),
            'Plan rebuilt.')
        }),
        plan.status === 'current'
          ? el('button', {
              class: 'btn btn--sm btn--primary', type: 'button',
              text: 'Confirm the load',
              disabled: busy ? true : undefined,
              onClick: async (e) => {
                if (!confirmAction(
                  'Confirm that the van now matches this plan? This posts the '
                  + 'transfers between Base and the vehicle — it is the step '
                  + 'that actually moves stock.')) return;
                /* All three are quoted from the plan THIS SCREEN rendered,
                   never re-read first: re-reading would defeat the point,
                   which is to catch a change the operator has not seen.
                   `lines_fingerprint` is the recommendation lock — a Manual
                   Keep or an authorised exception moves it while the
                   revision and the basis both stay put. */
                const ok = await act(e.currentTarget, () => api.confirmLoadPlan({
                  planId: plan.plan_id,
                  expectedRevision: plan.revision,
                  expectedFingerprint: plan.basis_fingerprint,
                  expectedLinesFingerprint: plan.lines_fingerprint
                }), 'Load confirmed and transfers posted.');
                /* A refusal here means the screen is out of date, so the
                   recovery is to show what the plan says NOW. The toast
                   carries the reason and is not cleared by the repaint.
                   trySave's `after` deliberately runs on success only, so
                   this reload is the caller's job. */
                if (!ok) await load();
              }
            })
          : null
      ].filter(Boolean)),

      plan.status === 'confirmed'
        ? el('p', { class: 'hint', style: 'margin-top:8px', text:
            'Confirmed. The transfers are in the ledger; the van\'s balances '
            + 'have changed.' })
        : null,

      suggestionsBox()
    ].filter(Boolean));
  }

  function lineRow(line) {
    const qty = quantityText(line);
    return el('div', {
      class: 'row-item',
      dataset: { planLine: line.line_id },
      style: 'flex-direction:column;align-items:stretch;gap:6px'
    }, [
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:baseline' }, [
        el('strong', { text: line.material_name || line.set_code || 'item' }),
        line.line_kind === 'seasonal_set'
          ? el('span', { class: 'badge', text: 'Christmas set' }) : null,
        line.level_state
          ? el('span', { class: `badge ${LEVEL_BADGE[line.level_state] || ''}`,
              text: LEVEL_LABEL[line.level_state] || line.level_state })
          : null,
        line.manual_keep
          ? el('span', { class: 'badge badge--ok', text: 'Kept on purpose' }) : null,
        line.data_state === 'needs_review'
          ? el('span', { class: 'badge badge--warn', text: 'Needs review' }) : null,
        // An owner authorisation is a state of the line, like Needs review
        // and Estimated, and is badged the same way so it is scannable
        // rather than only readable in the reason sentence.
        line.data_state === 'exception'
          ? el('span', { class: 'badge badge--warn', text: 'Owner authorised' }) : null,
        line.precision === 'estimated'
          ? el('span', { class: 'badge badge--warn', text: 'Estimated' }) : null,
        line.confirmed_operation
          ? el('span', { class: 'badge badge--ok', text: 'Moved' }) : null
      ].filter(Boolean)),

      el('p', { class: 'hint', style: 'margin:0', text: line.reason }),

      qty ? el('p', { class: 'hint', style: 'margin:0', text: qty }) : null,

      line.level_state
        ? el('p', { class: 'hint', style: 'margin:0', text:
            'Tracked as Empty / Low / Enough, so there is no quantity to show.' })
        : null,

      /* NO MANUAL-KEEP CONTROL ON AN OWNER-AUTHORISED SET-ASIDE. A keep is
         "do not take it off the van"; a skip is "the owner said go without
         it". They are different decisions by different people, and offering
         the crew a button that reads as overriding an authorisation is
         misleading even though the backend refuses to overwrite it. */
      line.material_id && plan.status === 'current' && line.action !== 'skip'
        ? el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, [
            el('button', {
              class: 'btn btn--sm', type: 'button',
              text: line.manual_keep ? 'Stop keeping it back' : 'Keep it back',
              disabled: busy ? true : undefined,
              title: line.manual_keep
                ? 'Let the plan decide again.'
                : 'Hold this on the van whatever the plan says. It survives a rebuild.',
              onClick: (e) => act(e.currentTarget, () => api.setManualKeep({
                locationCode: code,
                workDate: day,
                materialId: line.material_id,
                keep: !line.manual_keep,
                reason: line.manual_keep ? null : 'Kept back by the crew'
              }), line.manual_keep ? 'No longer held back.' : 'Held back.')
            })
          ])
        : null
    ].filter(Boolean));
  }

  function suggestionsBox() {
    if (!suggestions) return null;
    const gaps = suggestions.baseline_gaps || [];
    const shorts = suggestions.shortages || [];
    if (gaps.length === 0 && shorts.length === 0) return null;
    return el('details', { style: 'margin-top:10px' }, [
      el('summary', { class: 'hint', style: 'cursor:pointer',
        text: 'What to buy or top up' }),
      el('p', { class: 'hint', style: 'margin:6px 0', text: suggestions.note }),
      gaps.length
        ? el('ul', { style: 'margin:6px 0;padding-left:18px' }, gaps.map((g) =>
            el('li', { class: 'hint', text:
              `${g.material_name}: ${g.aboard_qty} aboard against a baseline of `
              + `${g.target_qty} — ${g.gap_qty} short of the standing load` })))
        : null,
      shorts.length
        ? el('ul', { style: 'margin:6px 0;padding-left:18px' }, shorts.map((s) =>
            el('li', { class: 'hint', text:
              `${s.material_name}: ${s.shortage_qty} ${s.unit || ''} short for today`.trim() })))
        : null
    ].filter(Boolean));
  }

  load();
  return host;
}
