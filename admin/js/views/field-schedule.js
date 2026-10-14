import * as api from '../lib/api.js';
import { el, clear, toast } from '../../../shared/dom.js';
import { money, humanise } from '../../../shared/format.js';
import { onMyWayLink } from '../lib/messaging.js';
import { getDevicePosition } from '../lib/native.js';
import { hasArrived } from '../lib/geofence.js';
import { describeWriteError } from '../lib/save.js';
import { prepareWork, refreshReferences } from '../lib/field-cache.js';

function timeOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null
    : d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
}

function dayAndTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null
    : d.toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric',
                                  hour: 'numeric', minute: '2-digit' });
}

function latestQuoteTotal(job) {
  const quotes = job.ns_quotes || [];
  if (!quotes.length) return null;
  return quotes.reduce((a, b) => (b.version > a.version ? b : a)).total;
}

/** Today's Schedule Overview: every job booked for today, each with its own
 *  one-tap action bar. This is the field console's home screen. */
export async function renderSchedule({ mount, navigate }) {
  const [visits, upcoming] = await Promise.all([
    api.listTodaysVisits(),
    api.listUpcomingVisits()
  ]);
  const cardByJobId = new Map();
  const preparationStatus = el('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const prepareButton = el('button', { class: 'btn', text: 'Save work for offline', onClick: async () => {
    prepareButton.disabled = true;
    preparationStatus.textContent = 'Saving visits and notes on this device…';
    try {
      const result = await prepareWork(visits, upcoming);
      preparationStatus.textContent = `${result.count} visits saved for offline reading for 24 hours.` +
        ' Preparation covers today and the next seven days.' +
        (result.truncated ? ' Only the first 20 visits fit this preparation.' : '') +
        (result.excluded ? ` ${result.excluded} visits outside that window were not saved.` : '') +
        (result.persistent ? '' : ' Device storage may be removed by the browser or operating system.');
    } catch (error) { preparationStatus.textContent = `Work not saved: ${error.message}`; }
    finally { prepareButton.disabled = false; }
  } });
  const referenceStatus = el('p', { class: 'hint', role: 'status' });
  const referenceButton = el('button', { class: 'btn', text: 'Refresh offline reference data', onClick: async () => {
    referenceButton.disabled = true;
    try {
      const savedAt = await refreshReferences();
      referenceStatus.textContent = `Reference data saved ${new Date(savedAt).toLocaleString()} for seven days. Visit facts were not refreshed; prices still need a connection.`;
    } catch (error) { referenceStatus.textContent = `Reference data not refreshed: ${error.message}`; }
    finally { referenceButton.disabled = false; }
  } });

  async function startVisit(job) {
    try {
      if (job.status !== 'in_progress') await api.updateJob(job.id, { status: 'in_progress' });
    } catch (err) {
      // Still open the workspace -- the tech is on site and the work matters
      // more than the status flag -- but say so rather than swallowing it.
      // Silently failing here meant the office never saw the job start, and
      // the arrival banner kept re-offering a visit already under way.
      toast(`Opened the visit, but could not mark it in progress: ${describeWriteError(err)}`, 'error');
    }
    navigate(`/visit/${job.id}`);
  }

  function actionBar(job) {
    const phone = job.customers?.phone;
    const address = [job.properties?.address_line1, job.properties?.city, job.properties?.postal_code]
      .filter(Boolean).join(', ');

    return el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
      el('button', {
        class: 'btn btn--primary', text: 'Start Site Visit',
        onClick: (e) => { e.preventDefault(); startVisit(job); }
      }),
      address ? el('a', {
        class: 'btn btn--sm', target: '_blank', rel: 'noopener',
        href: `https://maps.google.com/?q=${encodeURIComponent(address)}`,
        onClick: (e) => e.stopPropagation(), text: 'Navigate'
      }) : null,
      phone ? el('a', { class: 'btn btn--sm', href: `tel:${phone}`,
        onClick: (e) => e.stopPropagation(), text: 'Call' }) : null,
      phone ? el('a', { class: 'btn btn--sm', href: `sms:${phone}`,
        onClick: (e) => e.stopPropagation(), text: 'Text' }) : null,
      phone ? el('a', {
        class: 'btn btn--sm', onClick: (e) => e.stopPropagation(),
        href: onMyWayLink(phone, job.customers?.name, address), text: 'On My Way'
      }) : null
    ]);
  }

  /** Prepended into a visit's card once the device's position confirms it
   *  is within ARRIVAL_RADIUS_METERS -- see checkArrival() below. The
   *  banner itself is the fast path to the same action the card's own
   *  "Start Site Visit" button already offers, just a bigger, unmissable
   *  target for the moment it's actually relevant (one-handed, stepping
   *  out of the truck). */
  function arrivalBanner(job) {
    return el('button', {
      type: 'button', class: 'warn arrival-banner', style: 'display:block;width:100%;text-align:left;' +
        'margin-bottom:10px;border:0;cursor:pointer;font:inherit',
      onClick: () => startVisit(job)
    }, [
      el('strong', { text: '📍 Near scheduled site — Review Visit' })
    ]);
  }

  function visitCard(job) {
    const time = timeOnly(job.scheduled_for);
    const address = [job.properties?.address_line1, job.properties?.city].filter(Boolean).join(', ');
    const total = latestQuoteTotal(job);

    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('div', {}, [
          el('h2', { text: job.customers?.name || 'Unnamed customer' }),
          el('p', { text: address || 'No address on file' })
        ]),
        el('span', { class: 'badge badge--muted', text: humanise(job.status) })
      ]),
      el('p', { style: 'margin:0;display:flex;gap:14px;flex-wrap:wrap' }, [
        time ? el('span', { class: 'visit-card__time', text: time }) : null,
        total != null ? el('span', { class: 'money', text: `Quoted ${money(total)}` }) : null
      ]),
      actionBar(job)
    ]);
    cardByJobId.set(job.id, card);
    return card;
  }

  /** One device-position fix, reused against every visit (rather than one
   *  GPS read per job) -- checked once per page load/refresh rather than
   *  continuously, since this is "did I just pull up to this property",
   *  not a live-tracking feature. Silently does nothing if the device
   *  never resolves a position (no permission, no signal, plain web) --
   *  the card's ordinary "Start Site Visit" button is always still there. */
  async function checkArrival() {
    const here = await getDevicePosition();
    if (!here) return;
    for (const job of visits) {
      if (job.status === 'in_progress' || job.status === 'completed') continue;
      if (!hasArrived(here, job.properties)) continue;
      const card = cardByJobId.get(job.id);
      if (card && !card.querySelector('.arrival-banner')) card.prepend(arrivalBanner(job));
    }
  }

  /* Upcoming is deliberately a compact list, not another stack of action
     cards: it answers "what's coming" at a glance. The one-tap action bar
     belongs to today's work. */
  function upcomingRow(job) {
    const when = dayAndTime(job.scheduled_for);
    const address = [job.properties?.address_line1, job.properties?.city].filter(Boolean).join(', ');
    return el('div', { class: 'row-item' }, [
      el('div', { class: 'row-item__main' }, [
        el('strong', { text: job.customers?.name || 'Unnamed customer' }),
        el('span', { class: 'row-item__meta', text: [when, address].filter(Boolean).join(' · ') })
      ]),
      el('a', { class: 'btn btn--sm', href: `#/visit/${job.id}`, text: 'Open' })
    ]);
  }

  clear(mount).append(...[
    el('div', { class: 'page-head', style: 'padding:0 0 10px' }, [
      el('h1', { text: "Today's schedule" }),
      el('p', { class: 'hint', text: 'Device-calendar visits. Use Ordered day for the server operating-day window and dispatch order. Proximity does not confirm arrival.' }),
      el('a', { class: 'btn', href: '#/dispatch', text: 'Open ordered dispatch day' }),
      el('p', { text: visits.length
        ? `${visits.length} visit${visits.length === 1 ? '' : 's'} booked for today`
        : 'Nothing booked for today' }),
      el('a', { href: 'index.html#/winter', class: 'hint', text: 'Winter & seasonal operations →' })
    ]),
    el('div', { class: 'card' }, [prepareButton, preparationStatus, referenceButton, referenceStatus]),
    visits.length
      ? el('div', {}, visits.map(visitCard))
      : el('div', { class: 'empty', text: 'No visits scheduled for today. Set a job’s "Scheduled for" date and time on the job page to see it here.' }),
    upcoming.length
      ? el('div', { class: 'card' }, [
          el('div', { class: 'card__head' }, [
            el('div', {}, [
              el('h2', { text: 'Coming up' }),
              el('p', { text: 'The next 7 days.' })
            ])
          ]),
          el('div', {}, upcoming.map(upcomingRow))
        ])
      : null
  ].filter(Boolean));

  if (visits.length) checkArrival();
}
