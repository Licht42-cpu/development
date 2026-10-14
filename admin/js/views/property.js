import * as api from '../lib/api.js';
import { el, clear, select } from '../../../shared/dom.js';
import { money, date, humanise, num } from '../../../shared/format.js';
import { trySave } from '../lib/save.js';

/* The Property Passport.
 *
 * THE PASSPORT ALREADY EXISTED. properties.passport is a jsonb column that
 * the FIELD CONSOLE has been writing for some time (see field-workspace.js
 * passportPanel/checklistPanel), with a settled shape:
 *
 *   { siding: { material, color, elevations_note, heavy_algae_sides },
 *     roof:   { shingle_type, pitch, moss_severity },
 *     access: { water_tap_location, electrical_receptacle_location,
 *               gate_width, ladder_access_restrictions },
 *     preferences: "free text",
 *     checklist:   { <flag key>: boolean } }
 *
 * This screen READS that same structure rather than inventing a second one.
 * It deliberately does not offer editing of those fields: the field console
 * owns that form, it writes through the offline queue, and a second editor
 * on the same jsonb would be a lost-update race with a tech on site. The
 * admin-editable fields here are the property's own COLUMNS, which the
 * field console does not touch.
 *
 * PERMANENT vs TODAY. Everything under "Passport" and the property columns
 * is standing knowledge about the building. Everything under "History" is
 * job-scoped -- measurements, photos, inspections and quotes all hang off
 * ns_jobs.property_id and none of them carries a property_id of its own, so
 * each is shown with the job and date it came from and is never presented
 * as a current fact. That distinction is the whole point of the screen.
 *
 * NOT DONE HERE, deliberately: no measurement versioning (measurements are
 * mutable today; that is stated on screen rather than papered over with an
 * invented audit trail), no permanent-lighting schema, and no moving of
 * job-scoped rows up to the property.
 */

const PROPERTY_TYPES = [
  { value: '',            label: 'Not stated' },
  { value: 'residential', label: 'Residential' },
  { value: 'commercial',  label: 'Commercial' },
  { value: 'strata',      label: 'Strata' },
  { value: 'industrial',  label: 'Industrial' }
];

const QUOTE_TONE = {
  draft: 'badge--muted', sent: 'badge--warn', accepted: 'badge--ok',
  declined: 'badge--muted', expired: 'badge--muted', superseded: 'badge--muted'
};

/** Passport sections, in the order the field console presents them, so the
 *  two screens describe the same property in the same language. */
const PASSPORT_SECTIONS = [
  { key: 'siding', label: 'Siding', fields: [
    ['material', 'Material'], ['color', 'Colour'],
    ['elevations_note', 'Elevation heights'], ['heavy_algae_sides', 'Heavy algae sides']
  ] },
  { key: 'roof', label: 'Roof', fields: [
    ['shingle_type', 'Shingle type'], ['pitch', 'Pitch'], ['moss_severity', 'Moss severity']
  ] },
  { key: 'access', label: 'Access & utilities', fields: [
    ['water_tap_location', 'Water tap'],
    ['electrical_receptacle_location', 'Electrical receptacle'],
    ['gate_width', 'Gate width'],
    ['ladder_access_restrictions', 'Ladder access restrictions']
  ] }
];

function addressOf(p) {
  return [p?.address_line1, p?.address_line2].filter(Boolean).join(', ');
}
function regionOf(p) {
  return [p?.city, p?.province, p?.postal_code].filter(Boolean).join(', ');
}

export async function renderProperty({ mount, setContextParent }, propertyId) {
  const data = await api.propertyHistory(propertyId);
  const property = data.property || {};
  const customer = property.customer || null;

  /* Back from here should return to the owning customer, not the generic
     customer list -- that is the screen this was almost certainly opened
     from, and on Android it is what the hardware Back must do. */
  if (customer?.id) setContextParent?.(`/customers/${customer.id}`);

  const passport = property.passport && typeof property.passport === 'object'
    ? property.passport : {};

  const jobs         = Array.isArray(data.jobs) ? data.jobs : [];
  const quotes       = Array.isArray(data.quotes) ? data.quotes : [];
  const measurements = Array.isArray(data.measurements) ? data.measurements : [];
  const inspections  = Array.isArray(data.inspections) ? data.inspections : [];
  const photos       = Array.isArray(data.photos) ? data.photos : [];

  const detailsHost = el('div', {});
  const photosHost  = el('div', {});

  /* -------------------------------------------------- editable columns -- */

  function renderDetails() {
    const line1  = el('input', { value: property.address_line1 || '', 'aria-label': 'Address line 1' });
    const line2  = el('input', { value: property.address_line2 || '', 'aria-label': 'Address line 2' });
    const city   = el('input', { value: property.city || '', 'aria-label': 'City' });
    const prov   = el('input', { value: property.province || '', 'aria-label': 'Province' });
    const post   = el('input', { value: property.postal_code || '', 'aria-label': 'Postal code' });
    const type   = select(PROPERTY_TYPES, property.property_type || '', () => {});
    const storey = el('input', { value: property.storeys_note || '', 'aria-label': 'Storeys note',
                                 placeholder: 'e.g. Front 1-storey, rear 2-storey' });
    const access = el('textarea', { rows: '2', 'aria-label': 'Access note',
                                    placeholder: 'Permanent access facts: gate codes, parking, restrictions' });
    access.value = property.access_note || '';
    const notes  = el('textarea', { rows: '3', 'aria-label': 'Property notes' });
    notes.value = property.notes || '';

    const errorEl = el('p', { class: 'error-text', style: 'margin:8px 0 0', hidden: true });
    const saveBtn = el('button', { class: 'btn btn--primary', text: 'Save property' });
    const cancelBtn = el('button', { class: 'btn', text: 'Cancel' });

    cancelBtn.addEventListener('click', () => renderDetails());

    saveBtn.addEventListener('click', async () => {
      if (!line1.value.trim()) {
        errorEl.textContent = 'An address line is required — it is how this property is identified.';
        errorEl.hidden = false;
        return;
      }
      errorEl.hidden = true;

      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      const label = saveBtn.textContent;
      saveBtn.textContent = 'Saving…';

      /* Only columns. passport is deliberately absent from this patch: the
         field console owns that jsonb and writes it through the offline
         queue, so sending it from here could clobber a tech's save. */
      const patch = {
        address_line1: line1.value.trim(),
        address_line2: line2.value.trim() || null,
        city: city.value.trim() || null,
        province: prov.value.trim() || null,
        postal_code: post.value.trim().toUpperCase() || null,
        property_type: type.value || null,
        storeys_note: storey.value.trim() || null,
        access_note: access.value.trim() || null,
        notes: notes.value.trim() || null
      };

      const ok = await trySave(
        async () => { Object.assign(property, await api.updateProperty(property.id, patch)); },
        { success: 'Property updated' }
      );

      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = label;
      if (ok) renderDetails();
    });

    clear(detailsHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: 'Property details' }),
            el('p', { text: 'Standing facts about the building itself.' })
          ])
        ]),
        el('div', { class: 'grid grid--2' }, [
          el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Address' }), line1]),
          el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Address line 2' }), line2])
        ]),
        el('div', { class: 'grid grid--3', style: 'margin-top:10px' }, [
          el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'City' }), city]),
          el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Province' }), prov]),
          el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Postal code' }), post])
        ]),
        el('div', { class: 'grid grid--2', style: 'margin-top:10px' }, [
          el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Property type' }), type]),
          el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Storeys' }), storey])
        ]),
        el('label', { class: 'field', style: 'margin-top:10px' }, [
          el('span', { text: 'Permanent access notes' }), access
        ]),
        el('label', { class: 'field' }, [el('span', { text: 'Property notes' }), notes]),
        el('p', { class: 'hint', style: 'margin:0',
                  text: 'The address is how a new website request is matched to this ' +
                        'property. Changing it means a future request using the old ' +
                        'address will create a separate property.' }),
        errorEl,
        el('div', { class: 'btn-row', style: 'margin-top:12px' }, [saveBtn, cancelBtn])
      ])
    );
  }

  /* ---------------------------------------------------------- passport -- */

  function passportCard() {
    const filled = PASSPORT_SECTIONS
      .map(sec => ({
        sec,
        entries: sec.fields
          .map(([k, label]) => [label, passport?.[sec.key]?.[k]])
          .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
      }))
      .filter(x => x.entries.length);

    const preferences = typeof passport.preferences === 'string' ? passport.preferences.trim() : '';
    const checklist = passport.checklist && typeof passport.checklist === 'object'
      ? Object.entries(passport.checklist).filter(([, v]) => v === true) : [];

    const anything = filled.length || preferences || checklist.length;

    return el('div', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('div', {}, [
          el('h2', { text: 'Property Passport' }),
          el('p', { text: 'Recorded on site by the field console, and kept for every ' +
                          'future visit and quote.' })
        ]),
        el('span', { class: `badge ${anything ? 'badge--ok' : 'badge--muted'}`,
                     text: anything ? 'On file' : 'Not filled in yet' })
      ]),

      anything
        ? el('div', {}, [
            ...filled.map(({ sec, entries }) => el('div', { style: 'margin-bottom:10px' }, [
              el('h3', { style: 'margin:10px 0 6px;font-size:.78rem;text-transform:uppercase;' +
                                'letter-spacing:.06em;color:var(--muted)', text: sec.label }),
              ...entries.map(([label, value]) => el('div', { class: 'row-item' }, [
                el('div', { class: 'row-item__main' }, [
                  el('strong', { text: label }),
                  el('span', { class: 'row-item__meta', text: String(value) })
                ])
              ]))
            ])),

            preferences
              ? el('div', {}, [
                  el('h3', { style: 'margin:10px 0 6px;font-size:.78rem;text-transform:uppercase;' +
                                    'letter-spacing:.06em;color:var(--muted)',
                             text: 'Customer preferences' }),
                  el('p', { style: 'white-space:pre-wrap;margin:0', text: preferences })
                ])
              : null,

            checklist.length
              ? el('div', {}, [
                  el('h3', { style: 'margin:14px 0 6px;font-size:.78rem;text-transform:uppercase;' +
                                    'letter-spacing:.06em;color:var(--muted)',
                             text: 'Confirmed on site' }),
                  el('p', { style: 'margin:0' }, checklist.map(([k]) =>
                    el('span', { class: 'badge badge--ok', style: 'margin:0 6px 6px 0',
                                 text: humanise(k) })))
                ])
              : null
          ])
        : el('div', { class: 'empty',
                      text: 'Nothing recorded yet. The passport is filled in from the ' +
                            'field console during a visit.' })
    ]);
  }

  /* ----------------------------------------------------------- history -- */

  function historyCard(title, subtitle, rows, renderRow, emptyText) {
    return el('div', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('div', {}, [
          el('h2', { text: title }),
          subtitle ? el('p', { text: subtitle }) : null
        ]),
        el('span', { class: 'badge badge--muted', text: String(rows.length) })
      ]),
      rows.length
        ? el('div', {}, rows.map(renderRow))
        : el('div', { class: 'empty', text: emptyText })
    ]);
  }

  const jobsCard = () => historyCard(
    'Service history', 'Every job carried out at this property.',
    jobs,
    (j) => el('div', { class: 'row-item' }, [
      el('div', { class: 'row-item__main' }, [
        el('strong', { text: j.reference || j.title || 'Job' }),
        el('span', { class: 'row-item__meta', text: `Created ${date(j.created_at)}` }),
        Array.isArray(j.services) && j.services.length
          ? el('span', { class: 'row-item__meta', text: j.services.join(', ') })
          : el('span', { class: 'row-item__meta', text: 'No services measured on this job' }),
        j.completed_at
          ? el('span', { class: 'row-item__meta', text: `Completed ${date(j.completed_at)}` })
          : null
      ]),
      el('span', { class: 'row-item__badges' }, [
        el('span', { class: 'badge badge--muted', text: humanise(j.status) })
      ]),
      el('a', { class: 'btn btn--sm', href: `#/jobs/${j.id}`, text: 'Open' })
    ]),
    'No jobs recorded at this property yet.'
  );

  const quotesCard = () => historyCard(
    'Quotes', 'Every quote raised for this property, through its jobs.',
    quotes,
    (q) => el('div', { class: 'row-item' }, [
      el('div', { class: 'row-item__main' }, [
        el('strong', { text: `v${q.version}${q.option_label ? ` · ${q.option_label}` : ''}` }),
        el('span', { class: 'row-item__meta',
                     text: [q.job_reference, date(q.created_at)].filter(Boolean).join(' · ') }),
        q.total !== null && q.total !== undefined
          ? el('span', { class: 'row-item__meta', text: money(q.total) })
          : null
      ]),
      el('span', { class: 'row-item__badges' }, [
        el('span', { class: `badge ${QUOTE_TONE[q.status] || 'badge--muted'}`,
                     text: humanise(q.status) })
      ]),
      el('a', { class: 'btn btn--sm', href: `#/jobs/${q.job_id}`, text: 'Open job' })
    ]),
    'No quotes for this property yet.'
  );

  const measurementsCard = () => historyCard(
    'Measurements',
    'What has been measured here before — each one as recorded on that job, ' +
    'not a running total.',
    measurements,
    (m) => el('div', { class: 'row-item' }, [
      el('div', { class: 'row-item__main' }, [
        el('strong', { text: m.service || 'Service' }),
        el('span', { class: 'row-item__meta',
                     text: [m.label, m.section].filter(Boolean).join(' · ') ||
                           'No label or elevation' }),
        el('span', { class: 'row-item__meta',
                     text: `${num(m.quantity)} ${humanise(m.unit || '')} · ` +
                           `${m.job_reference || 'job'} · ${date(m.created_at)}` }),
        m.review_required
          ? el('span', { class: 'row-item__meta',
                         text: m.review_reason
                           ? `Flagged: ${m.review_reason}`
                           : 'Flagged for review, no reason given' })
          : null
      ]),
      el('span', { class: 'row-item__badges' }, [
        m.review_required
          ? el('span', { class: 'badge badge--warn', text: 'Needs review' }) : null
      ]),
      el('a', { class: 'btn btn--sm', href: `#/jobs/${m.job_id}`, text: 'Open job' })
    ]),
    'Nothing measured at this property yet.'
  );

  const inspectionsCard = () => historyCard(
    'Inspection history', 'Findings flagged on site, with the job they came from.',
    inspections,
    (f) => el('div', { class: 'row-item' }, [
      el('div', { class: 'row-item__main' }, [
        el('strong', { text: f.flag || 'Inspection finding' }),
        el('span', { class: 'row-item__meta',
                     text: [f.job_reference, f.noted_at ? date(f.noted_at) : null]
                       .filter(Boolean).join(' · ') }),
        el('span', { class: 'row-item__meta',
                     text: f.note || 'No note recorded' })
      ]),
      el('a', { class: 'btn btn--sm', href: `#/jobs/${f.job_id}`, text: 'Open job' })
    ]),
    'No inspection findings recorded at this property.'
  );

  /* Photos are job-owned and both buckets are PRIVATE, so each thumbnail
     needs its own signed URL. Rendered async and one at a time rather than
     eagerly: a property with a long history could otherwise mint dozens of
     signatures for images nobody scrolls to. */
  async function renderPhotos() {
    clear(photosHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: 'Photos' }),
            el('p', { text: 'From previous jobs at this property. Each still belongs ' +
                            'to the job it was taken on.' })
          ]),
          el('span', { class: 'badge badge--muted', text: String(photos.length) })
        ]),
        photos.length
          ? el('div', { class: 'loading', text: 'Preparing photo links…' })
          : el('div', { class: 'empty', text: 'No photos taken at this property yet.' })
      ])
    );

    if (!photos.length) return;

    const shown = photos.slice(0, 24);
    const urls = await Promise.all(shown.map(async (p) => {
      try {
        // attachmentBucket routes by request_id: a photo the customer
        // attached to their original request lives in a different private
        // bucket from one a tech took on site.
        return await api.signedPhotoUrl(p.storage_path, 900, api.attachmentBucket(p));
      } catch {
        return null;   // one unsignable photo must not blank the whole card
      }
    }));

    clear(photosHost).append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: 'Photos' }),
            el('p', { text: 'From previous jobs at this property. Each still belongs ' +
                            'to the job it was taken on.' })
          ]),
          el('span', { class: 'badge badge--muted', text: String(photos.length) })
        ]),
        el('div', { class: 'grid grid--3' }, shown.map((p, i) => el('div', {}, [
          urls[i]
            ? el('img', { src: urls[i], alt: p.caption || p.kind || 'Job photo',
                          loading: 'lazy',
                          style: 'width:100%;border-radius:var(--radius);display:block' })
            : el('div', { class: 'empty', style: 'margin:0',
                          text: 'Could not load this photo' }),
          el('span', { class: 'row-item__meta',
                       text: [p.kind && humanise(p.kind), p.elevation_tag,
                              p.job_reference, date(p.created_at)]
                         .filter(Boolean).join(' · ') }),
          p.caption ? el('span', { class: 'row-item__meta', text: p.caption }) : null
        ]))),
        photos.length > shown.length
          ? el('p', { class: 'hint', style: 'margin:10px 0 0',
                      text: `Showing the ${shown.length} most recent of ${photos.length}.` })
          : null
      ])
    );
  }

  renderDetails();

  /* WHY THIS IS AN ARRAY AND NOT A LIST OF ARGUMENTS. Element.append() is
     the DOM's own method, not el()'s children handling: el() skips a null
     child, append() stringifies it, so `customer ? null : el(...)` printed
     the word "null" on the screen of every property that HAS a customer --
     which is almost all of them. Filtering here keeps the conditional
     sections readable and keeps the shared helper untouched. */
  clear(mount).append(...[
    el('div', { class: 'page-head' }, [
      el('h1', { text: addressOf(property) || 'Property' }),
      el('p', { text: regionOf(property) || 'No city or postcode on file' })
    ]),

    el('div', { class: 'btn-row', style: 'margin-bottom:12px' }, [
      customer?.id
        ? el('a', { class: 'btn btn--sm', href: `#/customers/${customer.id}`,
                    text: `← ${customer.name || 'Customer'}` })
        : el('a', { class: 'btn btn--sm', href: '#/customers', text: '← All customers' }),
      property.latitude && property.longitude
        ? el('a', { class: 'btn btn--sm', target: '_blank', rel: 'noopener',
                    href: `https://maps.google.com/?q=${encodeURIComponent(
                      [addressOf(property), regionOf(property)].filter(Boolean).join(', '))}`,
                    text: 'Navigate' })
        : null
    ]),

    /* A property whose owner was removed is a real state this schema allows
       (properties.customer_id is ON DELETE SET NULL), so say so plainly
       rather than rendering a blank where a name should be. */
    customer
      ? null
      : el('div', { class: 'card' }, [
          el('p', { class: 'warn', style: 'margin:0',
                    text: 'This property has no customer on file. That happens when a ' +
                          'customer record was deleted — the property and its history ' +
                          'were kept.' })
        ]),

    passportCard(),
    detailsHost,
    jobsCard(),
    quotesCard(),
    measurementsCard(),
    inspectionsCard(),
    photosHost,

    el('p', { class: 'hint', style: 'margin-top:10px',
              text: 'Measurements, photos, inspections and quotes belong to the job they ' +
                    'were recorded on. They are shown here as history — a measurement is ' +
                    'what was true on that visit, not a standing figure for the property.' })
  ].filter(Boolean));

  await renderPhotos();
}
