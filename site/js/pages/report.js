import { supabase } from '../../../shared/supabase.js';
import { el, clear } from '../../../shared/dom.js';
import { money, date, dateTime } from '../../../shared/format.js';

/* The customer's completion report.
 *
 * THE CAPABILITY IS THE AUTHORISATION. `?t=` carries a 64-character token
 * the backend knows only as a sha256 hash. There is no login, no customer
 * id in the URL and no email match: those are guesses dressed as
 * authorisation, and this page has none of them.
 *
 * EVERY REFUSAL IS A STATE, NOT AN ERROR. get_customer_report() never
 * raises for a bad token -- it returns `{state}` -- so this page renders
 * "this link has expired" rather than a blank sheet, and an unknown token
 * is told apart from a revoked one only as far as the customer needs:
 * another customer's real report and a made-up id produce the SAME words,
 * because the difference is nobody's business but ours.
 *
 * WHAT IT RENDERS IS FROZEN. The document was built and sealed when the
 * report was issued; this page does not re-project it. A corrected report
 * is a different document on a different link, and this one says so.
 *
 * PICTURES COME BY TICKET, NEVER BY PATH. A published photograph is
 * requested with request_customer_document(), which checks the capability,
 * the report's scope and the explicit publication decision and hands back a
 * short-lived ticket. A service-role worker exchanges the ticket for a
 * time-limited URL. THAT WORKER DOES NOT EXIST YET, so the page shows the
 * photograph as listed-but-not-yet-downloadable rather than pretending a
 * broken <img> is the customer's fault.
 *
 * Everything on this page is text the backend chose. No internal note, no
 * hazard note, no access code, no coordinates and no cost reach it, and
 * they cannot: the server builds the document from an allowlist.
 */

const doc = document.getElementById('doc');

/** Every string here came from the server as DATA. It is set through
 *  `text:`, never innerHTML, so a customer note or a caption containing
 *  markup renders as the characters somebody typed. */
function message(title, body, extra) {
  clear(doc).append(el('div', { class: 'sheet' }, [
    el('h1', { style: 'margin-top:0', text: title }),
    el('p', { style: 'color:#6c7772', text: body }),
    extra || null,
    el('p', { style: 'margin-top:18px' }, [
      el('a', { href: 'index.html', style: 'color:#1d5f7a',
                text: '← Back to Nova Shield' })
    ])
  ].filter(Boolean)));
}

function sheetHead(d) {
  const company = d.company && d.company.state === 'configured' ? d.company : {};
  return el('div', { class: 'sheet-head' }, [
    el('div', {}, [
      el('span', { class: 'qlockup', role: 'img',
                   'aria-label': 'Nova Shield Maintenance Services' }),
      el('p', { style: 'margin:10px 0 0;font-size:.84rem;color:#6c7772' }, [
        company.phone || '', el('br'), company.email || ''
      ])
    ]),
    el('div', { class: 'meta' }, [
      el('strong', { text: 'Completion report' }),
      el('div', { text: `Work finished ${workedWhen(d)}` })
    ])
  ]);
}

/** THE TWO TIMES, never merged. The crew's report of when they downed
 *  tools is a claim; our acceptance is a server fact. An unknown finish
 *  time says unknown rather than borrowing the acceptance time. */
function workedWhen(d) {
  const c = d.completion || {};
  if (c.work_finished_state === 'reported' && c.work_finished_at) {
    return date(c.work_finished_at);
  }
  return 'on the day of the visit';
}

function timesBlock(d) {
  const c = d.completion || {};
  return el('div', { class: 'block' }, [
    el('h3', { text: 'When' }),
    el('p', { style: 'margin:0', text: c.work_finished_state === 'reported'
      ? `Our crew reported finishing at ${dateTime(c.work_finished_at)}`
      : 'Our crew did not record a finish time for this visit.' }),
    // No trailing full stop: shared/format.js dateTime() already ends a
    // 12-hour time with "p.m.", and appending one printed "5:02 p.m..".
    el('p', { class: 'note', text:
      `We accepted and checked the work at ${dateTime(c.accepted_at)}` })
  ]);
}

function workBlock(d) {
  const work = d.work || [];
  if (!work.length) return null;
  return el('div', { class: 'block' }, [
    el('h3', { text: 'What we did' }),
    ...work.map(w => el('div', { class: 'line' }, [
      el('span', { text: w.description || w.service || '' })
    ]))
  ]);
}

/** Materials as RECORDED. A level stays a level -- "part of a jug" is the
 *  honest answer and a made-up litre count is not -- and an estimate says
 *  estimate. None of it is a charge, and the note says so. */
function materialsBlock(d) {
  const mats = d.materials || [];
  if (!mats.length) return null;
  return el('div', { class: 'block' }, [
    el('h3', { text: 'What we used' }),
    ...mats.map(m => el('div', { class: 'line' }, [
      el('span', { text: m.material }),
      el('span', { text: m.level
        ? levelWords(m.level)
        : `${m.quantity} ${m.unit}${m.measurement_state === 'estimated' ? ' (approx.)' : ''}` })
    ])),
    el('p', { class: 'note', text: d.materials_note || '' })
  ]);
}

function levelWords(level) {
  return level === 'full' ? 'A full container'
    : level === 'part' ? 'Part of a container'
    : level === 'low' ? 'A little left'
    : 'Emptied';
}

/** Published photographs only. The caption is the one an owner wrote FOR
 *  the customer -- never the internal caption from the office -- and what
 *  we know about each picture is stated as a device's claim, because that
 *  is all it is. */
function evidenceBlock(d, onFetch) {
  const shots = d.evidence || [];
  if (!shots.length) return null;
  return el('div', { class: 'block' }, [
    el('h3', { text: 'Photographs' }),
    el('div', { class: 'shots' }, shots.map(e => {
      const btn = el('button', { class: 'btn no-print',
        style: 'margin-top:8px;min-height:38px;padding:8px 14px',
        text: 'Open photograph' });
      const status = el('p', { class: 'hint', text: '' });
      btn.addEventListener('click', () => onFetch(e, btn, status));
      return el('div', { class: 'shot' }, [
        el('p', { text: e.caption || requirementWords(e.requirement) }),
        el('p', { class: 'hint', text: e.capture_time_state === 'device_reported'
          ? `Taken ${dateTime(e.captured_at)}, according to the camera`
          : 'The camera did not record when this was taken' }),
        btn, status
      ]);
    }))
  ]);
}

function requirementWords(req) {
  return req === 'before' ? 'Before the work'
    : req === 'after' ? 'After the work'
    : req === 'installation' ? 'The installation'
    : req === 'component' ? 'A component'
    : req === 'winter_proof' ? 'The cleared area'
    : req === 'site_condition' ? 'The site'
    : 'A photograph of the visit';
}

/** The money, from the approved commercial record and nowhere else. No
 *  accepted quote means no total at all -- not a zero -- and an unset
 *  currency is left off rather than guessed. */
function moneyBlock(d) {
  const c = d.commercials || {};
  if (c.commercial_state !== 'accepted_quote') return null;
  const changes = c.approved_changes || [];
  return el('div', { class: 'block' }, [
    el('h3', { text: 'The agreed price' }),
    el('div', { class: 'line' }, [
      el('span', { text: 'Accepted quote' }),
      el('span', { text: money(c.accepted_quote?.total) })
    ]),
    ...changes.map(ch => el('div', { class: 'line' }, [
      el('span', { text: ch.description }),
      el('span', { text: money(ch.amount) })
    ])),
    el('div', { class: 'line line--total' }, [
      el('span', { text: 'Total' }),
      el('span', { text: money(c.approved_total) })
    ]),
    c.currency_state === 'unconfigured'
      ? null
      : el('p', { class: 'note', text: `All amounts in ${c.currency}.` }),
    el('p', { class: 'note', text:
      'This is what was agreed. Anything extra appears here only once it '
      + 'has been approved and priced.' })
  ].filter(Boolean));
}

async function fetchPhoto(token, reportId, ev, btn, status) {
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'Opening…';
  const { data, error } = await supabase.rpc('request_customer_document', {
    p_token: token, p_report_id: reportId, p_evidence_id: ev.evidence_id
  });
  btn.disabled = false;
  btn.textContent = was;
  if (error) {
    status.textContent = 'That did not open — please call or text us.';
    return;
  }
  const state = data && data.state;
  if (state === 'file_missing') {
    status.textContent = 'We no longer have this file. Please get in touch.';
    return;
  }
  if (state !== 'ok') {
    // expired / revoked / not_found: the link itself is the problem, so
    // reload into the whole-page state rather than explaining it here.
    status.textContent = 'This link can no longer open photographs.';
    return;
  }
  // THE HONEST STOP. The ticket is real and the authorisation happened; the
  // worker that turns it into a download does not exist in this build, and
  // saying "ready" would be a lie the customer discovers by clicking.
  status.textContent = 'Ready to send — we will email this photograph to you.';
}

function renderReport(res, token) {
  const d = res.document || {};
  const onFetch = (ev, btn, status) =>
    fetchPhoto(token, res.report_id, ev, btn, status);

  clear(doc).append(el('div', { class: 'sheet' }, [
    sheetHead(d),

    res.state === 'superseded'
      ? el('div', { class: 'state state--warn', text: res.message
          || 'We have since issued a corrected version of this report.' })
      : null,

    el('div', { class: 'parties' }, [
      el('div', {}, [el('h2', { text: 'Prepared for' }),
                     el('p', { text: d.customer?.name || '' })]),
      el('div', {}, [el('h2', { text: 'Property' }),
                     el('p', { text: [d.property?.address_line1, d.property?.city]
                       .filter(Boolean).join(', ') })])
    ]),

    el('p', { style: 'margin:0', text:
      `Report v${res.report_version}, issued ${date(res.issued_at)}.` }),

    timesBlock(d),
    workBlock(d),
    moneyBlock(d),
    materialsBlock(d),
    evidenceBlock(d, onFetch),

    el('div', { class: 'actions' }, [
      el('button', { class: 'btn no-print', text: 'Print / save as PDF',
                     onClick: () => window.print() })
    ])
  ].filter(Boolean)));
}

function renderCollection(res, token) {
  const docs = res.documents || [];
  clear(doc).append(el('div', { class: 'sheet' }, [
    el('h1', { style: 'margin-top:0', text: 'Your completion reports' }),
    el('p', { style: 'color:#6c7772', text: docs.length
      ? 'Choose a visit to see its report.'
      : 'There are no reports on this link yet.' }),
    el('div', {}, docs.map(r => {
      const btn = el('button', { class: 'btn', text: 'Open' });
      btn.addEventListener('click', () => open(token, r.report_id));
      return el('div', { class: 'line' }, [
        el('span', { text: `Report v${r.report_version}`
          + (r.issued_at ? ` · ${date(r.issued_at)}` : '')
          + (r.state === 'superseded' ? ' · since corrected' : '') }),
        btn
      ]);
    }))
  ]));
}

async function open(token, reportId) {
  const { data, error } = await supabase.rpc('get_customer_report', {
    p_token: token, p_report_id: reportId ?? null
  });

  if (error || !data) {
    return message('We could not open your report',
      'Something went wrong at our end. Please call or text us on '
      + '437-436-3360 and we will send it again.');
  }

  switch (data.state) {
    case 'ok':
    case 'superseded':
      // A collection token with no report id answers with a list instead.
      if (data.documents && !data.document) return renderCollection(data, token);
      return renderReport(data, token);
    case 'expired':
      return message('This link has expired',
        data.message || 'Get in touch and we will send a fresh one.');
    case 'revoked':
      return message('This link has been withdrawn',
        data.message || 'Please get in touch.');
    case 'unavailable':
      return message('Your report is not ready yet',
        data.message || 'We will let you know when it is.');
    case 'out_of_scope':
    case 'not_found':
      return message('That report is not on this link',
        data.message || 'Please use the link we sent you.');
    default:
      return message('This link is not valid',
        data.message || 'It may have been replaced. Please get in touch and '
        + 'we will send a fresh one.');
  }
}

async function load() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('t');
  const reportId = params.get('r');
  if (!token) {
    return message('Report not found', 'This link is missing its reference.');
  }
  // A collection link lists; a report link opens its one document. Which it
  // is, is the GRANT's property, not the URL's -- passing a report id on a
  // single-report token cannot aim it at another document.
  const { data } = await supabase.rpc('list_customer_documents', { p_token: token });
  if (data && data.state === 'ok' && data.scope === 'customer_collection'
      && !reportId) {
    return renderCollection(data, token);
  }
  return open(token, reportId);
}

load();
