import * as api from '../lib/api.js';
import { el, clear, toast, select, confirmAction } from '../../../shared/dom.js';
import { money, date, humanise } from '../../../shared/format.js';
import { createMeasurementsPanel } from './measurements.js';
import { createQuotePanel } from './quote.js';
import { reviewFlag } from '../components/review-flag.js';
import { trySave } from '../lib/save.js';
import { jobSteps, STEP_DONE, STEP_NOW } from '../components/next-step.js';
import { activityRows, groupByDay } from '../components/job-activity.js';
import { createJobMaterialsPanel } from '../components/job-materials.js';
import { createJobMaterialSheetPanel } from '../components/job-material-sheet.js';

const JOB_STATUSES = ['new','reviewing','estimate_drafted','site_visit_scheduled','assessed',
  'quote_sent','accepted','declined','scheduled','in_progress','completed','invoiced','paid',
  'closed','lost'];

/** timestamptz -> the local "YYYY-MM-DDTHH:mm" an <input type="datetime-local">
 *  expects. Built from the local getters rather than toISOString().slice(),
 *  which would shift the displayed time by the UTC offset. */
function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatWhen(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null
    : d.toLocaleString('en-CA', { weekday: 'short', year: 'numeric', month: 'short',
                                  day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/* ------------------------------------------------------------- job list -- */

/* Schedule buckets are named here but DEFINED in the search_jobs RPC, which
   is also what the dashboard counts with -- so "On today" on the dashboard
   and this filter always mean the same window. */
const SCHEDULE_BUCKETS = [
  { value: '',            label: 'Any schedule' },
  { value: 'today',       label: 'Today' },
  { value: 'upcoming',    label: 'Next 7 days' },
  { value: 'overdue',     label: 'Overdue (past date, not complete)' },
  { value: 'unscheduled', label: 'No date set' }
];

const SORTS = [
  { value: 'updated_desc',   label: 'Recently updated' },
  { value: 'scheduled_asc',  label: 'Scheduled — soonest first' },
  { value: 'scheduled_desc', label: 'Scheduled — latest first' },
  { value: 'created_desc',   label: 'Newest job first' },
  { value: 'customer_asc',   label: 'Customer A–Z' }
];

/* Quote status drives a colour, and the mapping is deliberate: accepted is
   the only 'ok'. declined/expired/superseded must never render the same as
   a win -- that was a real defect on the job page's own badge. */
const QUOTE_TONE = {
  draft: 'badge--muted', sent: 'badge--warn', accepted: 'badge--ok',
  declined: 'badge--muted', expired: 'badge--muted', superseded: 'badge--muted'
};

export async function renderJobs({ mount, params, replaceQuery }) {
  // Deep-link state from the dashboard, e.g. #/jobs?bucket=today
  const state = {
    query: params?.get('q') || '',
    status: params?.get('status') || '',
    bucket: params?.get('bucket') || '',
    needsReview: params?.get('needs_review') === '1',
    sort: params?.get('sort') || 'updated_desc'
  };

  const searchInput = el('input', {
    type: 'search', value: state.query, 'aria-label': 'Search jobs',
    placeholder: 'Customer, address, postcode, phone, email or job reference'
  });
  const statusSelect = select(
    [{ value: '', label: 'Any status' },
     ...JOB_STATUSES.map(s => ({ value: s, label: humanise(s) }))],
    state.status, () => { state.status = statusSelect.value; load(); }
  );
  const bucketSelect = select(SCHEDULE_BUCKETS, state.bucket,
    () => { state.bucket = bucketSelect.value; load(); });
  const sortSelect = select(SORTS, state.sort,
    () => { state.sort = sortSelect.value; load(); });
  const reviewBox = el('input', { type: 'checkbox', checked: state.needsReview });
  const reviewLabel = el('label', { class: `check ${state.needsReview ? 'is-on' : ''}` }, [
    reviewBox, el('span', { text: 'Only jobs flagged for review' })
  ]);
  reviewBox.addEventListener('change', () => {
    state.needsReview = reviewBox.checked;
    reviewLabel.className = `check ${reviewBox.checked ? 'is-on' : ''}`;
    load();
  });

  // Typing is debounced so a search is one request per pause, not per
  // keystroke -- the whole point of filtering server-side.
  let typingTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { state.query = searchInput.value; load(); }, 250);
  });

  const summaryLine = el('p', { class: 'hint', style: 'margin:0 0 10px' });
  const list = el('div', {});

  function clearAll() {
    state.query = ''; state.status = ''; state.bucket = ''; state.needsReview = false;
    state.sort = 'updated_desc';
    searchInput.value = ''; statusSelect.value = ''; bucketSelect.value = '';
    sortSelect.value = 'updated_desc'; reviewBox.checked = false;
    reviewLabel.className = 'check';
    load();
  }

  const filtersActive = () =>
    !!(state.query || state.status || state.bucket || state.needsReview);

  /* Keep the address bar in step with the filters, WITHOUT pushing a
     history entry per keystroke or per dropdown change. That makes a
     filtered list reloadable and shareable, while leaving Android's Back
     to mean "previous screen" rather than "undo my last filter" -- see
     main.js's replaceQuery for why that distinction is the whole point. */
  function syncUrl() {
    if (!replaceQuery) return;              // field console / tests may omit it
    const qs = new URLSearchParams();
    if (state.query) qs.set('q', state.query);
    if (state.status) qs.set('status', state.status);
    if (state.bucket) qs.set('bucket', state.bucket);
    if (state.needsReview) qs.set('needs_review', '1');
    if (state.sort && state.sort !== 'updated_desc') qs.set('sort', state.sort);
    replaceQuery(qs.toString());
  }

  function jobRow(j) {
    const flags = Number(j.review_flags?.total || 0);
    const q = j.latest_quote;
    const requested = Array.isArray(j.requested_services) ? j.requested_services : [];
    const when = j.scheduled_for ? formatWhen(j.scheduled_for) : null;
    const overdue = j.scheduled_for && !j.completed_at &&
                    new Date(j.scheduled_for) < new Date();

    const meta = [
      j.reference,
      [j.property?.address_line1, j.property?.city].filter(Boolean).join(', ')
    ].filter(Boolean).join(' · ');

    return el('div', { class: 'row-item' }, [
      el('div', { class: 'row-item__main' }, [
        el('strong', { text: j.customer?.name || 'Unnamed customer' }),
        el('span', { class: 'row-item__meta', text: meta || 'No address on file' }),
        // Service context: what was originally requested, which is the only
        // service information a job row can show without another query.
        requested.length
          ? el('span', { class: 'row-item__meta',
                         text: `Requested: ${requested.slice(0, 3).join(', ')}` +
                               (requested.length > 3 ? ` +${requested.length - 3}` : '') })
          : null,
        el('span', { class: 'row-item__meta',
                     text: when ? (overdue ? `${when} — date has passed` : when)
                                : 'No date set' })
      ]),
      el('span', { class: 'row-item__badges' }, [
        el('span', { class: 'badge badge--muted', text: humanise(j.status) }),
        q ? el('span', { class: `badge ${QUOTE_TONE[q.status] || 'badge--muted'}`,
                         text: `Quote v${q.version} ${humanise(q.status)}` })
          : el('span', { class: 'badge badge--muted', text: 'No quote' }),
        j.has_unapproved_pricing
          ? el('span', { class: 'badge badge--warn', text: 'Pricing not approved' }) : null,
        flags
          ? el('span', { class: 'badge badge--warn',
                         text: `${flags} flagged for review` }) : null,
        overdue ? el('span', { class: 'badge badge--warn', text: 'Overdue' }) : null
      ]),
      el('a', { class: 'btn btn--sm', href: `#/jobs/${j.id}`, text: 'Open' })
    ]);
  }

  async function load() {
    syncUrl();
    clear(list).append(el('div', { class: 'loading', text: 'Loading…' }));
    summaryLine.textContent = '';

    let result;
    try {
      result = await api.searchJobs({
        query: state.query,
        statuses: state.status ? [state.status] : null,
        scheduleBucket: state.bucket,
        needsReview: state.needsReview,
        sort: state.sort,
        limit: 50
      });
    } catch (err) {
      clear(list).append(
        el('div', { class: 'card' }, [
          el('h2', { text: 'Could not load jobs' }),
          el('p', { class: 'error-text', text: err.message }),
          el('div', { class: 'btn-row', style: 'margin-top:12px' }, [
            el('button', { class: 'btn', text: 'Retry', onClick: load })
          ])
        ])
      );
      return;
    }

    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const total = Number(result?.total || 0);

    summaryLine.textContent = total
      ? `${total} job${total === 1 ? '' : 's'}` +
        (rows.length < total ? ` · showing the first ${rows.length}` : '') +
        (filtersActive() ? ' matching these filters' : '')
      : '';

    if (!rows.length) {
      // Two genuinely different empty states: nothing matched a filter
      // (offer to clear it) versus no jobs exist at all (offer the real
      // next step, which is converting a request).
      clear(list).append(
        filtersActive()
          ? el('div', { class: 'card' }, [
              el('div', { class: 'empty', text: 'No jobs match these filters.' }),
              el('div', { class: 'btn-row', style: 'margin-top:12px;justify-content:center' }, [
                el('button', { class: 'btn btn--sm', text: 'Clear filters', onClick: clearAll })
              ])
            ])
          : el('div', { class: 'empty',
                        text: 'No jobs yet. Convert a request to get started.' })
      );
      return;
    }

    clear(list).append(...rows.map(jobRow));
  }

  clear(mount).append(
    el('div', { class: 'page-head' }, [
      el('h1', { text: 'Jobs' }),
      el('p', { text: 'Search and filter every job. Searching covers the customer, ' +
                      'the property and the job reference.' })
    ]),
    el('div', { class: 'card' }, [
      el('label', { class: 'field' }, [el('span', { text: 'Search' }), searchInput]),
      el('div', { class: 'grid grid--3' }, [
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Job status' }), statusSelect
        ]),
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Schedule' }), bucketSelect
        ]),
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Sort by' }), sortSelect
        ])
      ]),
      reviewLabel,
      el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
        el('button', { class: 'btn btn--sm', text: 'Clear filters', onClick: clearAll })
      ])
    ]),
    summaryLine,
    list
  );

  await load();
}

/* ----------------------------------------------------------- job detail -- */

export async function renderJob({ mount }, jobId) {
  const [job, services, modifiers, siteFactors, flags, flagMap, pricingRules, currentUserId] =
    await Promise.all([
      api.getJob(jobId),
      api.listServices(),
      api.listModifiers(),
      api.listSiteFactors(),
      api.listInspectionFlags(),
      api.listServiceFlagMap(),
      api.listPricingRules(),
      api.currentUserId()
    ]);

  const refs = { services, modifiers, siteFactors, flags, flagMap, pricingRules, sections: [] };

  /* The section vocabulary is shared across services, so derive it from the
     price book rather than hardcoding it in the UI. */
  function vocabulary(groupKey) {
    const seen = new Map();
    for (const m of modifiers) {
      if (m.group_key !== groupKey) continue;
      if (!seen.has(m.option_key)) seen.set(m.option_key, { value: m.option_key, label: m.label, sort: m.sort_order });
    }
    return [...seen.values()].sort((a, b) => a.sort - b.sort);
  }

  function siteVocabulary(groupKey) {
    return refs.siteFactors
      .filter(f => f.group_key === groupKey)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(f => ({ value: f.option_key, label: f.label }));
  }

  const HEIGHT_OPTS = vocabulary('height');
  const ACCESS_OPTS = vocabulary('access');

  const sectionsHost = el('div', {});
  const photosHost = el('div', {});
  const inspectionHost = el('div', {});
  const pricingHost = el('div', {});

  /* Batch 8.1. Sits after pricing because it reads the same measurements,
     and before the quote because it is not part of it: nothing on this
     panel reaches a customer total. It loads on demand -- see the
     component's own comment for why. */
  const materialsPanel = createJobMaterialsPanel({ jobId: job.id });
  /* Batch 9.1 corrective. The estimate above says what the templates imply;
     this says what a person chose, and it is the only thing that reserves
     stock. The two are deliberately adjacent and deliberately separate. */
  const materialSheetPanel = createJobMaterialSheetPanel({ jobId: job.id });
  const nextStepHost = el('div', {});
  const requestedHost = el('div', {});
  const notesHost = el('div', {});
  const attentionHost = el('div', {});
  const activityHost = el('div', {});
  const measurementsPanel = createMeasurementsPanel({ job, refs, onChange: reload });
  const quotePanel = createQuotePanel({ job, onChange: reload });

  /* ------------------------------------------------------------ sections -- */

  function sectionReviewToggle(section) {
    return reviewFlag({
      required: section.review_required, reason: section.review_reason,
      label: 'Flag this elevation for review',
      save: (patch) => api.updateSection(section.id, patch)
    });
  }

  function renderSections() {
    const rows = refs.sections.map(section => {
      function patch(field) {
        return async e => {
          const control = e.target;
          const before = section[field];
          // Full reload, not refreshPricing(): height and access feed the
          // per-service totals rendered by the measurements panel as well as
          // the subtotal card, so repainting only the latter left the service
          // cards showing the old money next to a new total.
          await trySave(
            async () => {
              await api.updateSection(section.id, { [field]: control.value });
              section[field] = control.value;
            },
            { revert: () => { control.value = before; }, after: reload }
          );
        };
      }

      return el('div', { class: 'section-box' }, [
        el('div', { class: 'section-box__head' }, [
          el('input', {
            value: section.name, 'aria-label': 'Section name', style: 'max-width:240px',
            onChange: async e => {
              const control = e.target;
              const before = section.name;
              const name = control.value.trim() || 'Section';
              await trySave(
                async () => {
                  await api.updateSection(section.id, { name });
                  section.name = name;
                },
                { revert: () => { control.value = before; } }
              );
            }
          }),
          el('button', {
            class: 'btn btn--sm btn--danger', text: 'Remove',
            onClick: async (e) => {
              if (!confirmAction(`Remove "${section.name}"? Measurements using it will lose their section.`)) return;
              const btn = e.target;
              btn.disabled = true;
              await trySave(() => api.deleteSection(section.id), { after: reload });
              btn.disabled = false;
            }
          })
        ]),
        el('div', { class: 'grid grid--2' }, [
          el('label', { class: 'field', style: 'margin:0' }, [
            el('span', { text: 'Height' }), select(HEIGHT_OPTS, section.storeys, patch('storeys'))
          ]),
          el('label', { class: 'field', style: 'margin:0' }, [
            el('span', { text: 'Access' }), select(ACCESS_OPTS, section.access, patch('access'))
          ])
        ]),
        el('div', { class: 'grid grid--3', style: 'margin-top:10px' }, [
          el('label', { class: 'field', style: 'margin:0' }, [
            el('span', { text: 'Ground' }), select(siteVocabulary('ground'), section.ground, patch('ground'))
          ]),
          el('label', { class: 'field', style: 'margin:0' }, [
            el('span', { text: 'Ladder' }), select(siteVocabulary('ladder'), section.ladder, patch('ladder'))
          ]),
          el('label', { class: 'field', style: 'margin:0' }, [
            el('span', { text: 'Distance' }), select(siteVocabulary('distance'), section.distance, patch('distance'))
          ])
        ]),
        sectionReviewToggle(section)
      ]);
    });

    clear(sectionsHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: 'Property layout' }),
            el('p', { text: 'The front can be one storey while the rear is two. These values drive the price.' })
          ]),
          el('button', {
            class: 'btn btn--sm', text: '+ Add section',
            onClick: async (e) => {
              // Disabled during the write: a double-tap used to create two
              // sections, and there is no undo.
              const btn = e.target;
              btn.disabled = true;
              const names = ['Front','Rear','Left side','Right side','Garage','Addition'];
              await trySave(
                () => api.createSection(job.id, {
                  name: names[refs.sections.length] || 'Other',
                  sort_order: refs.sections.length + 1
                }),
                { after: reload }
              );
              btn.disabled = false;
            }
          })
        ]),
        rows.length ? el('div', {}, rows)
                    : el('div', { class: 'empty', text: 'No sections yet.' })
      ])
    );
  }

  /* ---------------------------------------------------------- next steps -- */

  function renderNextStep(measurements, quotes, jobFlags) {
    const steps = jobSteps({ job, measurements, sections: refs.sections, quotes, jobFlags });
    const now = steps.find(s => s.state === STEP_NOW);

    clear(nextStepHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: now ? `Next: ${now.label}` : 'Nothing outstanding' }),
            el('p', { text: now ? now.detail
              : job.completed_at ? 'This job is complete.'
              : 'Nothing is waiting on you right now.' })
          ]),
          now ? el('span', { class: 'badge badge--warn', text: 'Action needed' })
              : el('span', { class: 'badge badge--ok', text: 'Clear' })
        ]),
        // The whole ladder, so it is obvious what has already been done and
        // what is still ahead -- not just the current step in isolation.
        steps.length
          ? el('div', {}, steps.map(s => el('div', {
              class: 'qline',
              style: s.state === STEP_NOW ? 'font-weight:600' : ''
            }, [
              el('span', {}, [
                s.state === STEP_DONE ? '✓ ' : s.state === STEP_NOW ? '→ ' : '· ',
                s.label
              ]),
              // nowrap: at 390px the squeezed .qline right-hand column broke
              // "done" across two lines as "don / e".
              el('span', { class: 'hint', style: 'white-space:nowrap',
                           text: s.state === STEP_DONE ? 'done' : s.state })
            ])))
          : null
      ])
    );
  }

  /* ------------------------------------------------- review-flag rollup -- */

  /** review_required already existed per measurement and per elevation with
   *  no rollup, so a flag typed by a tech was only visible by scrolling to
   *  that one row and expanding it. This aggregates them and shows each
   *  reason, which is the actual content of the flag. Visibility only: it
   *  does not block quoting, because no existing business rule says it
   *  should. */
  function renderAttention(measurements) {
    const flaggedMeasurements = measurements.filter(m => m.review_required);
    const flaggedSections = refs.sections.filter(s => s.review_required);
    const total = flaggedMeasurements.length + flaggedSections.length;

    if (!total) { clear(attentionHost); return; }

    const serviceName = (id) => (services.find(s => s.id === id)?.name) || 'Service';

    clear(attentionHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: 'Needs review' }),
            el('p', { text: 'Someone flagged these on site. Clear them before treating the ' +
                            'quote as final.' })
          ]),
          el('span', { class: 'badge badge--warn',
                       text: `${total} item${total === 1 ? '' : 's'}` })
        ]),
        el('div', {}, [
          ...flaggedMeasurements.map(m => el('div', { class: 'row-item' }, [
            el('div', { class: 'row-item__main' }, [
              el('strong', { text: `${serviceName(m.service_id)}${m.label ? ` — ${m.label}` : ''}` }),
              el('span', { class: 'row-item__meta',
                           text: m.review_reason || 'No reason given' })
            ]),
            el('span', { class: 'badge badge--muted', text: 'Measurement' })
          ])),
          ...flaggedSections.map(s => el('div', { class: 'row-item' }, [
            el('div', { class: 'row-item__main' }, [
              el('strong', { text: s.name || 'Elevation' }),
              el('span', { class: 'row-item__meta',
                           text: s.review_reason || 'No reason given' })
            ]),
            el('span', { class: 'badge badge--muted', text: 'Elevation' })
          ]))
        ])
      ])
    );
  }

  /* -------------------------------------------------------- activity -- */

  /** Chronological activity, from job_activity(). One query across nine
   *  tables; components/job-activity.js owns the wording. Nothing here is
   *  derived or guessed -- see that module for the list of events the schema
   *  cannot support (viewed, supersession timing, replies/calls/texts). */
  async function renderActivity() {
    clear(activityHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [el('h2', { text: 'Activity' }),
                         el('p', { text: 'Loading…' })])
        ]),
        el('div', { class: 'loading', text: 'Loading…' })
      ])
    );

    let events;
    try {
      events = await api.jobActivity(job.id);
    } catch (err) {
      clear(activityHost).append(
        el('div', { class: 'card' }, [
          el('div', { class: 'card__head' }, [
            el('div', {}, [el('h2', { text: 'Activity' })])
          ]),
          el('p', { class: 'error-text', text: `Could not load activity: ${err.message}` }),
          el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
            el('button', { class: 'btn btn--sm', text: 'Retry', onClick: renderActivity })
          ])
        ])
      );
      return;
    }

    const rows = activityRows(events, { currentUserId });
    const days = groupByDay(rows);

    clear(activityHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: 'Activity' }),
            el('p', { text: 'Everything the system actually recorded, newest first.' })
          ]),
          el('span', { class: 'badge badge--muted',
                       text: `${rows.length} event${rows.length === 1 ? '' : 's'}` })
        ]),
        rows.length
          ? el('div', {}, days.map(day => el('div', { style: 'margin-bottom:8px' }, [
              el('p', { class: 'hint', style: 'margin:10px 0 4px', text: date(day.at) }),
              ...day.rows.map(r => el('div', { class: 'row-item' }, [
                el('div', { class: 'row-item__main' }, [
                  el('strong', { text: r.label }),
                  r.detail ? el('span', { class: 'row-item__meta', text: r.detail }) : null,
                  // Notes carry their text, and internal vs customer-visible
                  // has to be unmistakable on screen.
                  r.body
                    ? el('span', {
                        class: 'row-item__meta',
                        style: r.visibility === 'customer'
                          ? 'white-space:pre-wrap;border-left:3px solid var(--gold);padding-left:8px'
                          : 'white-space:pre-wrap;border-left:3px solid var(--line);padding-left:8px',
                        text: r.body
                      })
                    : null,
                  r.actor ? el('span', { class: 'row-item__meta', text: `by ${r.actor}` }) : null
                ]),
                el('span', { class: 'row-item__badges' }, [
                  r.visibility
                    ? el('span', {
                        class: `badge ${r.visibility === 'customer' ? 'badge--warn' : 'badge--muted'}`,
                        text: r.visibility === 'customer' ? 'Customer-visible' : 'Internal'
                      })
                    : null,
                  r.sourceLabel
                    ? el('span', { class: 'badge badge--muted', text: r.sourceLabel }) : null
                ])
              ]))
            ])))
          : el('div', { class: 'empty',
                        text: 'Nothing recorded for this job yet.' })
      ])
    );
  }

  /* --------------------------------------------------- requested services -- */

  /** What the customer originally asked for, read from the request through
   *  the normalized quote_request_services relationship. Read-only by
   *  design: this is history, and quoting must never rewrite it. */
  function renderRequested() {
    const request = job.quote_requests;
    if (!request) { clear(requestedHost); return; }

    const asked = (request.quote_request_services || [])
      .map(r => r.services?.name || (r.other_label ? `${r.other_label} (other)` : null))
      .filter(Boolean);

    clear(requestedHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: 'Originally requested' }),
            el('p', { text: 'What the customer asked for on the website. Kept as history — ' +
                            'quoting below can differ from it.' })
          ]),
          el('a', { class: 'btn btn--sm', href: '#/requests', text: 'All requests' })
        ]),
        asked.length
          ? el('p', { style: 'margin:0 0 8px' }, asked.map(name =>
              el('span', { class: 'badge', style: 'margin:0 6px 6px 0', text: name })))
          : el('p', { class: 'hint', style: 'margin:0 0 8px',
                      text: 'No specific services were selected on the request.' }),
        request.customer_message
          ? el('div', { class: 'field', style: 'margin:0' }, [
              el('span', { text: 'Their message' }),
              el('p', { style: 'margin:0', text: request.customer_message })
            ])
          : null,
        request.preferred_schedule
          ? el('p', { class: 'hint', style: 'margin:8px 0 0',
                      text: `Preferred timing: ${request.preferred_schedule}` })
          : null,
        request.submitted_at
          ? el('p', { class: 'hint', style: 'margin:6px 0 0',
                      text: `Submitted ${date(request.submitted_at)}` })
          : null
      ])
    );
  }

  /* --------------------------------------------------------------- notes -- */

  function renderNotes(notes, currentUserId) {
    const body = el('textarea', {
      placeholder: 'What happened, what to watch out for, what you told the customer…',
      'aria-label': 'Note'
    });
    const visibility = select(
      [{ value: 'internal', label: 'Internal — staff only' },
       { value: 'customer', label: 'Customer-visible — can appear on the completion report' }],
      'internal'
    );
    const addBtn = el('button', { class: 'btn btn--sm btn--primary', text: 'Add note' });

    addBtn.addEventListener('click', async () => {
      const text = body.value.trim();
      if (!text) return toast('Write something first', 'error');
      addBtn.disabled = true;
      addBtn.textContent = 'Saving…';
      const saved = await trySave(
        () => api.addNote(job.id, text, visibility.value),
        { success: 'Note added', after: reload }
      );
      if (saved) body.value = '';
      addBtn.disabled = false;
      addBtn.textContent = 'Add note';
    });

    clear(notesHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: 'Notes' }),
            el('p', { text: 'Newest first. Internal notes are never shown to the customer.' })
          ]),
          notes.length
            ? el('span', { class: 'badge badge--muted',
                           text: `${notes.length} note${notes.length === 1 ? '' : 's'}` })
            : null
        ]),
        el('label', { class: 'field' }, [el('span', { text: 'New note' }), body]),
        el('label', { class: 'field' }, [el('span', { text: 'Who can see it' }), visibility]),
        el('div', { class: 'btn-row', style: 'margin-bottom:12px' }, [addBtn]),
        notes.length
          ? el('div', {}, notes.map(n => el('div', { class: 'section-box' }, [
              el('div', { class: 'section-box__head' }, [
                el('div', {}, [
                  el('span', {
                    class: `badge ${n.visibility === 'customer' ? 'badge--warn' : 'badge--muted'}`,
                    text: n.visibility === 'customer' ? 'Customer-visible' : 'Internal'
                  }),
                  // job_notes.author_id references auth.users and admin_users
                  // holds only user_id, so there is no name to show -- "you"
                  // vs "another admin" is the honest limit of what we know.
                  el('span', { class: 'hint', style: 'margin-left:8px',
                    text: [
                      n.author_id
                        ? (n.author_id === currentUserId ? 'you' : 'another admin')
                        : 'unattributed',
                      date(n.created_at)
                    ].join(' · ') })
                ]),
                el('button', {
                  class: 'btn btn--sm btn--danger', text: 'Delete',
                  onClick: async (e) => {
                    if (!confirmAction('Delete this note?')) return;
                    const btn = e.target;
                    btn.disabled = true;
                    await trySave(() => api.deleteNote(n.id), { after: reload });
                    btn.disabled = false;
                  }
                })
              ]),
              el('p', { style: 'margin:8px 0 0;white-space:pre-wrap', text: n.body })
            ])))
          : el('div', { class: 'empty', text: 'No notes yet.' })
      ])
    );
  }

  /* -------------------------------------------------------------- photos -- */

  async function renderPhotos(attachments) {
    if (!attachments.length) {
      clear(photosHost).append(
        el('div', { class: 'card' }, [
          el('div', { class: 'card__head' }, [
            el('div', {}, [
              el('h2', { text: 'Photos' }),
              el('p', { text: 'Nothing attached. Customer uploads from the website appear here.' })
            ])
          ])
        ])
      );
      return;
    }

    const grid = el('div', {
      style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px'
    });

    clear(photosHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: 'Photos' }),
            el('p', { text: `${attachments.length} attached · links expire after 15 minutes` })
          ])
        ]),
        grid
      ])
    );

    for (const a of attachments) {
      const tile = el('div', {
        style: 'border:1px solid var(--line);border-radius:10px;overflow:hidden;' +
               'aspect-ratio:1;background:var(--surface-2);display:grid;place-items:center'
      });
      grid.append(tile);
      try {
        const url = await api.signedPhotoUrl(a.storage_path, 900, api.attachmentBucket(a));
        clear(tile).append(el('a', { href: url, target: '_blank', rel: 'noopener',
          style: 'display:block;width:100%;height:100%' }, [
          el('img', { src: url, alt: a.caption || `${humanise(a.kind)} photo`,
                      style: 'width:100%;height:100%;object-fit:cover;display:block' })
        ]));
      } catch (err) {
        clear(tile).append(el('span', { class: 'hint', style: 'padding:8px;text-align:center',
                                        text: 'Preview unavailable' }));
      }
    }
  }

  /* ---------------------------------------------------------- inspection -- */

  function renderInspection(measurements, jobFlags) {
    const activeFlagIds = new Set(jobFlags.map(f => f.flag_id));
    const noteByFlagId = new Map(jobFlags.map(f => [f.flag_id, f.note || '']));
    const serviceIds = new Set(measurements.map(m => m.service_id));
    const relevant = new Set(
      flagMap.filter(r => serviceIds.has(r.service_id)).map(r => r.flag_id)
    );
    const shown = flags.filter(f => relevant.has(f.id));

    const checks = shown.map(flag => {
      const on = activeFlagIds.has(flag.id);
      const box = el('input', { type: 'checkbox', checked: on });
      const label = el('label', { class: `check ${on ? 'is-on' : ''}` }, [
        box, el('span', { text: flag.name })
      ]);
      box.addEventListener('change', async () => {
        const before = !box.checked;
        await trySave(
          () => api.setJobFlag(job.id, flag.id, box.checked),
          { revert: () => { box.checked = before; }, after: reload }
        );
      });
      return label;
    });

    /* A ticked check on its own says "something is up here" without saying
       what. job_inspection_flags.note has always existed and nothing wrote
       it, so the observation lived only in the tech's head. One note input
       per ticked flag, saved on blur. No severity or category: those
       columns do not exist on inspection_flags and inventing them would be
       fabricating data. */
    const noteRows = shown.filter(f => activeFlagIds.has(f.id)).map(flag => {
      const input = el('input', {
        value: noteByFlagId.get(flag.id) || '',
        placeholder: 'What did you see? (e.g. "Soffit rotted above the bay window")',
        'aria-label': `Note for ${flag.name}`
      });
      input.addEventListener('change', async () => {
        const before = noteByFlagId.get(flag.id) || '';
        const next = input.value.trim();
        await trySave(
          async () => {
            await api.setJobFlagNote(job.id, flag.id, next);
            noteByFlagId.set(flag.id, next);
          },
          { revert: () => { input.value = before; }, after: reload }
        );
      });
      return el('label', { class: 'field', style: 'margin:0 0 10px' }, [
        el('span', { text: flag.name }), input
      ]);
    });

    const warnings = flags
      .filter(f => activeFlagIds.has(f.id) && relevant.has(f.id))
      .map(f => el('div', { class: 'warn' }, [
        el('strong', { text: f.name }), el('span', { text: f.warning })
      ]));

    clear(inspectionHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: 'Site inspection' }),
            el('p', { text: shown.length
              ? 'Only showing checks relevant to the services on this job.'
              : 'Add a service to see the relevant checks.' })
          ]),
          activeFlagIds.size
            ? el('span', { class: 'badge badge--warn', text: `${activeFlagIds.size} flagged` })
            : null
        ]),
        shown.length ? el('div', { class: 'check-grid' }, checks) : null,
        ...warnings,
        noteRows.length
          ? el('div', { style: 'margin-top:12px' }, [
              el('p', { class: 'hint', style: 'margin:0 0 8px',
                        text: 'Say what you saw for each check you ticked.' }),
              ...noteRows
            ])
          : null
      ])
    );
  }

  /* ------------------------------------------------------------- pricing -- */

  function renderPricing(pricing) {
    const subtotal = pricing.reduce((sum, p) => sum + Number(p.amount), 0);

    clear(pricingHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: 'Calculated price' }),
            el('p', { text: 'What the price book says. You still decide the final number.' })
          ])
        ]),
        ...pricing.map(p => el('div', { class: 'qline' }, [
          el('span', {}, [
            p.service_name,
            el('span', { class: 'qline__sub',
              text: p.minimum_applied ? 'minimum charge applied' : '' })
          ]),
          el('span', { class: 'money', text: money(p.amount) })
        ])),
        el('div', { class: 'qline qline--total' }, [
          el('span', { text: 'Calculated subtotal' }),
          el('span', { class: 'money total-hero', text: money(subtotal) })
        ])
      ])
    );
  }

  async function refreshPricing() {
    const pricing = await api.calculatePricing(job.id);
    renderPricing(pricing);
    return pricing;
  }

  /* -------------------------------------------------------------- reload -- */

  async function reload() {
    const [fresh, sections, measurements, jobFlags, pricing, quotes, attachments, notes] =
      await Promise.all([
        api.getJob(job.id),
        api.listSections(job.id),
        api.listMeasurements(job.id),
        api.listJobFlags(job.id),
        api.calculatePricing(job.id),
        api.listQuotes(job.id),
        api.listAttachments(job.id),
        api.listNotes(job.id)
      ]);

    // sending a quote advances the job server-side, so re-sync the header
    // rather than leaving a stale status in the dropdown. scheduled_for and
    // completed_at are re-synced for the same reason: the field console can
    // move them while this page is open.
    job.status = fresh.status;
    job.scheduled_for = fresh.scheduled_for;
    job.completed_at = fresh.completed_at;
    job.quote_requests = fresh.quote_requests;
    if (statusSelect.value !== fresh.status) statusSelect.value = fresh.status;
    scheduleInput.value = toLocalInputValue(fresh.scheduled_for);
    paintCompletion();

    refs.sections = sections;
    renderSections();
    renderRequested();
    measurementsPanel.render({ measurements, pricing });
    renderInspection(measurements, jobFlags);
    renderPricing(pricing);
    quotePanel.render({ quotes, measurements, services });
    renderNotes(notes, currentUserId);
    renderAttention(measurements);
    renderNextStep(measurements, quotes, jobFlags);
    renderPhotos(attachments);   // async, fills in as signed URLs resolve
    renderActivity();            // async, its own query + its own error state
  }

  /* --------------------------------------------------------------- shell -- */

  const statusSelect = select(
    JOB_STATUSES.map(s => ({ value: s, label: humanise(s) })),
    job.status,
    async e => {
      const control = e.target;
      const before = job.status;
      await trySave(
        async () => {
          await api.updateJob(job.id, { status: control.value });
          job.status = control.value;
        },
        { revert: () => { control.value = before; }, success: 'Status updated' }
      );
    }
  );

  /* ------------------------------------------------- schedule + complete -- */

  const scheduleInput = el('input', {
    type: 'datetime-local', 'aria-label': 'Scheduled for',
    value: toLocalInputValue(job.scheduled_for)
  });
  const scheduleSaveBtn = el('button', { class: 'btn btn--sm btn--primary', text: 'Save date' });
  const scheduleClearBtn = el('button', { class: 'btn btn--sm', text: 'Clear' });
  const scheduleWhen = el('p', { class: 'hint', style: 'margin:6px 0 0' });

  function paintSchedule() {
    const when = formatWhen(job.scheduled_for);
    scheduleWhen.textContent = when
      ? `Booked for ${when}${new Date(job.scheduled_for) < new Date() ? ' (in the past)' : ''}`
      : 'Not booked in. The field console only lists jobs that have a date.';
  }

  async function saveSchedule(value) {
    // Disabled during the write so a double-tap cannot fire two updates.
    scheduleSaveBtn.disabled = true;
    scheduleClearBtn.disabled = true;
    const label = scheduleSaveBtn.textContent;
    scheduleSaveBtn.textContent = 'Saving…';
    await trySave(
      async () => {
        const saved = await api.scheduleJob(job.id, value);
        job.scheduled_for = saved.scheduled_for;
      },
      {
        revert: () => { scheduleInput.value = toLocalInputValue(job.scheduled_for); },
        success: value ? 'Scheduled' : 'Schedule cleared',
        after: reload
      }
    );
    scheduleSaveBtn.textContent = label;
    scheduleSaveBtn.disabled = false;
    scheduleClearBtn.disabled = false;
    paintSchedule();
  }

  scheduleSaveBtn.addEventListener('click', () => {
    const raw = scheduleInput.value;
    if (!raw) return toast('Pick a date and time first', 'error');
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) return toast('That is not a valid date and time', 'error');
    saveSchedule(when.toISOString());
  });
  scheduleClearBtn.addEventListener('click', () => {
    if (!job.scheduled_for) return toast('Nothing to clear');
    if (!confirmAction('Clear the scheduled date? The job will drop off the field schedule.')) return;
    scheduleInput.value = '';
    saveSchedule(null);
  });

  const completeBtn = el('button', { class: 'btn btn--primary', text: 'Mark job complete' });
  const completeWhen = el('p', { class: 'hint', style: 'margin:6px 0 0' });

  function paintCompletion() {
    const when = formatWhen(job.completed_at);
    completeWhen.textContent = when
      ? `Completed ${when}`
      : 'Not completed yet. Completing stamps the time used by the completion report.';
    completeBtn.disabled = !!job.completed_at;
    completeBtn.textContent = job.completed_at ? 'Already complete' : 'Mark job complete';
    paintSchedule();
  }

  completeBtn.addEventListener('click', async () => {
    if (job.completed_at) return;
    if (!confirmAction('Mark this job complete? This stamps the completion time on the record.')) return;
    completeBtn.disabled = true;
    completeBtn.textContent = 'Completing…';
    await trySave(
      async () => {
        const saved = await api.completeJob(job.id);
        // completeJob only matches a row whose completed_at is still null, so
        // a second submit returns null rather than moving the timestamp.
        if (!saved) throw new Error('This job was already marked complete.');
        job.completed_at = saved.completed_at;
        job.status = saved.status;
      },
      { success: 'Job marked complete', after: reload }
    );
    paintCompletion();
  });

  const address = [job.properties?.address_line1, job.properties?.city, job.properties?.postal_code]
    .filter(Boolean).join(', ');

  clear(mount).append(
    el('div', { class: 'page-head' }, [
      el('a', { href: '#/jobs', text: '← All jobs', class: 'hint' }),
      el('h1', { text: job.customers?.name || 'Job' }),
      el('p', { text: [job.reference, address].filter(Boolean).join(' · ') })
    ]),

    /* The job stays the operational screen; these are the two doors out of
       it to the persistent records. Deliberately links, not a copy of the
       customer's or property's details -- duplicating them here is how the
       two drift apart. */
    el('div', { class: 'btn-row', style: 'margin-bottom:12px' }, [
      job.customers?.id
        ? el('a', { class: 'btn btn--sm', href: `#/customers/${job.customers.id}`,
                    text: `Customer: ${job.customers.name || 'view'}` })
        : null,
      job.properties?.id
        ? el('a', { class: 'btn btn--sm', href: `#/properties/${job.properties.id}`,
                    text: 'Property Passport' })
        : null
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'grid grid--3' }, [
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Status' }), statusSelect
        ]),
        el('div', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Phone' }),
          el('p', {}, [el('a', { href: `tel:${job.customers?.phone || ''}`,
                                 text: job.customers?.phone || '—' })])
        ]),
        el('div', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Email' }),
          el('p', {}, [el('a', { href: `mailto:${job.customers?.email || ''}`,
                                 text: job.customers?.email || '—' })])
        ])
      ]),
      el('div', { class: 'grid grid--2', style: 'margin-top:12px' }, [
        el('div', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Scheduled for' }),
          scheduleInput,
          el('div', { class: 'btn-row', style: 'margin-top:8px' }, [scheduleSaveBtn, scheduleClearBtn]),
          scheduleWhen
        ]),
        el('div', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Completion' }),
          el('div', { class: 'btn-row' }, [completeBtn]),
          completeWhen
        ])
      ])
    ]),
    nextStepHost,
    attentionHost,
    requestedHost,
    sectionsHost,
    photosHost,
    measurementsPanel.root,
    inspectionHost,
    pricingHost,
    materialsPanel.root,
    materialSheetPanel.root,
    el('div', { class: 'card' }, [quotePanel.root]),
    notesHost,
    activityHost
  );

  paintCompletion();
  await reload();
}
