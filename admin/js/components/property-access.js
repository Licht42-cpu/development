import * as api from '../lib/api.js';
import { el, select, confirmAction } from '../../../shared/dom.js';
import { fill } from '../lib/admin-dom.js';
import { trySave } from '../lib/save.js';
import { dateTime } from '../../../shared/format.js';

/* How to get in, what to watch for, and where the work actually is.
 *
 * THE SEPARATION THIS EDITOR EXISTS TO MAKE VISIBLE. Four of these fields
 * are ours and one is the customer's, and which is which is decided by the
 * field it is typed into rather than by somebody's judgement at send time:
 *
 *   entrance / hazard / parking  the crew going there sees them.
 *   internal note, access code   the office and the assigned crew only.
 *                                No column-level read exists for these two;
 *                                the backend serves them through a scoped
 *                                function and nothing else.
 *   customer note                the ONLY field that may ever appear on a
 *                                customer surface.
 *
 * WORK ZONES ARE DRAWINGS, NOT SURVEYS. A zone says "the work is here" or
 * "avoid this"; it is not a property boundary and nothing triggers on
 * entering one. Two coordinate spaces, declared rather than guessed:
 * geographic (real lat/lng) or image (0..1 fractions of a named photo).
 *
 * POINTER DRAWING IS NOT THE ONLY WAY IN. The point list is a table of
 * number inputs with Add and Remove buttons, usable with a keyboard alone.
 * The map/photo canvas is Codex's in 12.2; this editor is the data
 * contract, and it is complete without one.
 */

const ZONE_KINDS = [
  ['work_area', 'Work area'],
  ['hazard', 'Hazard'],
  ['parking', 'Parking'],
  ['access_path', 'Access path']
];

const blankZone = () => ({
  zone_id: null, label: '', kind: 'work_area', space: 'geographic',
  points: [], image_source: '', note: '', lock_version: null
});

export function propertyAccessPanel({ propertyId } = {}) {
  const host = el('div', {});
  let data = null;
  let loading = true;
  let loadError = null;
  let busy = false;
  let form = null;        // the access fields being edited
  let zone = null;        // the zone being drawn, or null
  let zoneError = null;

  function paint() { fill(host, body()); }

  async function act(btn, fn, success) {
    if (busy) return false;
    const was = btn ? btn.textContent : null;
    busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    const ok = await trySave(fn, { success, after: async () => { await load(); } });
    busy = false;
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = was; }
    if (!ok) await load();
    return ok;
  }

  async function load() {
    loading = true; loadError = null; paint();
    try {
      data = await api.getPropertyAccess(propertyId);
      const a = data.access || {};
      form = {
        entrance_note: a.entrance_note || '',
        hazard_note: a.hazard_note || '',
        parking_note: a.parking_note || '',
        internal_note: a.internal_note || '',
        access_code: a.access_code || '',
        customer_note: a.customer_note || '',
        // 0 is "there is nothing here yet", which the backend tells apart
        // from version 1 so a first save cannot silently overwrite a real
        // record that appeared in between.
        lock_version: a.lock_version ?? 0
      };
    } catch (err) {
      data = null;
      loadError = err?.message || 'Could not load the property details.';
    } finally {
      loading = false; paint();
    }
  }

  const field = (key, label, hint, attrs = {}) =>
    el('div', { style: 'margin:0 0 8px' }, [
      el('label', { class: 'field', style: 'margin:0' }, [
        el('span', { text: label }),
        el('input', {
          type: attrs.type || 'text', value: form[key],
          autocomplete: 'off',
          onInput: (e) => { form[key] = e.target.value; }
        })
      ]),
      hint ? el('p', { class: 'hint', style: 'margin:4px 0 0', text: hint }) : null
    ].filter(Boolean));

  /* ------------------------------------------------------ the details -- */

  function accessBody() {
    return el('div', {}, [
      el('p', { class: 'hint', style: 'margin:0 0 8px', text:
        data.address_line1
          ? `${data.address_line1}${data.city ? ', ' + data.city : ''}`
          : 'This property' }),

      /* MISSING COORDINATES STAY MISSING. No default pin, no city centre,
         no guessed entrance. */
      el('p', { class: 'hint', style: 'margin:0 0 8px', text:
        data.coordinates.state === 'known'
          ? `Coordinates on file: ${data.coordinates.lat}, ${data.coordinates.lng}`
          : 'No coordinates on file for this property. A geographic zone '
            + 'needs its own points; nothing is guessed from the address.' }),

      data.access_note
        ? el('div', { class: 'section-box', style: 'margin:0 0 10px' }, [
            el('h3', { text: 'Existing entrance note', style: 'margin:0 0 4px' }),
            el('p', { class: 'hint', style: 'margin:0', text: data.access_note }),
            el('p', { class: 'hint', style: 'margin:4px 0 0', text:
              'From the property record the field console already reads. It '
              + 'is not duplicated here — edit it on the property.' })
          ])
        : null,

      el('h3', { text: 'The crew sees these', style: 'margin:0 0 6px' }),
      field('entrance_note', 'Entrance', 'Where to go in.'),
      field('hazard_note', 'Hazard',
        'The dog, the loose step, the low cable. Its own line so it is not '
        + 'buried in a paragraph.'),
      field('parking_note', 'Parking', 'Where the van goes.'),

      el('h3', { text: 'Ours, never the customer’s', style: 'margin:10px 0 6px' }),
      field('internal_note', 'Internal note',
        'For the office and the assigned crew.'),
      field('access_code', 'Access code',
        'A key. Readable only by the owner and a crew with work here, and '
        + 'never echoed in a receipt or a message.'),

      el('h3', { text: 'The customer may see this', style: 'margin:10px 0 6px' }),
      field('customer_note', 'Customer-facing note',
        'The only field on this screen that may appear on a customer '
        + 'surface. Nothing else here is ever sent.'),

      el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, [
        el('button', {
          class: 'btn btn--sm btn--primary', type: 'button', text: 'Save details',
          disabled: busy ? true : undefined,
          onClick: (e) => act(e.currentTarget, () => api.setPropertyAccess({
            propertyId,
            entranceNote: form.entrance_note || null,
            hazardNote: form.hazard_note || null,
            parkingNote: form.parking_note || null,
            internalNote: form.internal_note || null,
            accessCode: form.access_code || null,
            customerNote: form.customer_note || null,
            expectedVersion: form.lock_version
          }), 'Details saved.')
        }),
        data.access
          ? el('span', { class: 'hint', style: 'align-self:center', text:
              `Version ${data.access.lock_version}, saved `
              + dateTime(data.access.updated_at) })
          : null
      ].filter(Boolean))
    ].filter(Boolean));
  }

  /* ---------------------------------------------------------- zones -- */

  function pointRow(point, index) {
    const geo = zone.space === 'geographic';
    const a = geo ? 'lat' : 'x';
    const b = geo ? 'lng' : 'y';
    return el('div', { class: 'row-item' }, [
      el('div', { class: 'grid grid--2' }, [
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { text: `${geo ? 'Latitude' : 'X'} (point ${index + 1})` }),
          el('input', {
            type: 'number', step: geo ? '0.000001' : '0.001',
            value: point[a] ?? '',
            onInput: (e) => {
              point[a] = e.target.value === '' ? null : Number(e.target.value);
            }
          })
        ]),
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { text: `${geo ? 'Longitude' : 'Y'} (point ${index + 1})` }),
          el('input', {
            type: 'number', step: geo ? '0.000001' : '0.001',
            value: point[b] ?? '',
            onInput: (e) => {
              point[b] = e.target.value === '' ? null : Number(e.target.value);
            }
          })
        ])
      ]),
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn btn--sm', type: 'button', text: 'Remove point',
          onClick: () => { zone.points.splice(index, 1); paint(); }
        })
      ])
    ]);
  }

  function zoneEditor() {
    const geo = zone.space === 'geographic';
    return el('div', { class: 'section-box', style: 'margin:10px 0 0' }, [
      el('h3', { text: zone.zone_id ? 'Edit zone' : 'New zone',
        style: 'margin:0 0 6px' }),

      el('p', { class: 'hint', style: 'margin:0 0 8px', text:
        'A zone is a drawing, not a surveyed boundary, and nothing triggers '
        + 'on entering one. Points are typed here; the map and photo canvas '
        + 'are the field app’s.' }),

      el('div', { style: 'margin:0 0 8px' }, [
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Label' }),
          el('input', {
            type: 'text', value: zone.label,
            onInput: (e) => { zone.label = e.target.value; }
          })
        ])
      ]),
      el('div', { class: 'grid grid--2', style: 'margin:0 0 8px' }, [
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Kind' }),
          // select() passes the change EVENT, not the value.
          select(ZONE_KINDS.map(([value, label]) => ({ value, label })),
            zone.kind, (e) => { zone.kind = e.target.value; })
        ]),
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Coordinate space' }),
          select([
            { value: 'geographic', label: 'Geographic (lat/lng)' },
            { value: 'image', label: 'On a photo (0–1 of the image)' }
          ], zone.space, (e) => {
            zone.space = e.target.value;
            /* The two spaces have different axes and different ranges, so
               points typed in one are not points in the other. Cleared
               deliberately rather than reinterpreted. */
            zone.points = [];
            paint();
          })
        ])
      ]),

      geo
        ? el('p', { class: 'hint', style: 'margin:0 0 8px', text:
            'Real latitude and longitude, so it can be put on a map.' })
        : el('div', { style: 'margin:0 0 8px' }, [
            el('label', { class: 'field', style: 'margin:0' }, [
              el('span', { text: 'Which image' }),
              el('input', {
                type: 'text', value: zone.image_source,
                placeholder: 'e.g. site-visit/front-elevation.jpg',
                onInput: (e) => { zone.image_source = e.target.value; }
              })
            ]),
            el('p', { class: 'hint', style: 'margin:4px 0 0', text:
              'Required: a drawing on a photo means nothing without saying '
              + 'which photo. Points are fractions from 0 to 1, so they '
              + 'scale to whatever size it is shown at.' })
          ]),

      el('div', {}, zone.points.map(pointRow)),

      el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, [
        el('button', {
          class: 'btn btn--sm', type: 'button', text: 'Add point',
          onClick: () => {
            zone.points.push(zone.space === 'geographic'
              ? { lat: null, lng: null } : { x: null, y: null });
            paint();
          }
        })
      ]),

      el('p', { class: 'hint', style: 'margin:8px 0 0', text:
        `${zone.points.length} point(s). A zone needs at least three: two `
        + 'points are a line.' }),

      el('div', { style: 'margin:8px 0 0' }, [
        el('label', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Note' }),
          el('input', {
            type: 'text', value: zone.note,
            onInput: (e) => { zone.note = e.target.value; }
          })
        ])
      ]),

      zoneError ? el('p', { class: 'error-text', text: zoneError }) : null,

      el('div', { class: 'btn-row', style: 'margin-top:8px;flex-wrap:wrap' }, [
        el('button', {
          class: 'btn btn--sm btn--primary', type: 'button', text: 'Save zone',
          disabled: busy ? true : undefined,
          onClick: (e) => {
            zoneError = null;
            /* Checked here so the operator gets the message beside the
               form, and checked again by the database because a screen is
               not an authorisation and not a validator. */
            if (!zone.label.trim()) { zoneError = 'Give the zone a label.'; paint(); return; }
            if (zone.points.length < 3) {
              zoneError = 'A zone needs at least three points.'; paint(); return;
            }
            if (zone.points.some((p) => Object.values(p).some(
              (v) => v === null || v === '' || Number.isNaN(v)))) {
              zoneError = 'Every point needs both numbers. A blank one is '
                + 'missing, not zero.';
              paint(); return;
            }
            if (zone.space === 'image' && !zone.image_source.trim()) {
              zoneError = 'Name the image these points are fractions of.';
              paint(); return;
            }
            return act(e.currentTarget, () => api.savePropertyWorkZone({
              propertyId,
              label: zone.label.trim(),
              kind: zone.kind,
              space: zone.space,
              points: zone.points,
              imageSource: zone.space === 'image' ? zone.image_source.trim() : null,
              note: zone.note || null,
              zoneId: zone.zone_id,
              expectedVersion: zone.lock_version
            }), 'Zone saved.').then((ok) => { if (ok) zone = null; });
          }
        }),
        el('button', {
          class: 'btn btn--sm', type: 'button', text: 'Cancel',
          onClick: () => { zone = null; zoneError = null; paint(); }
        })
      ].filter(Boolean))
    ].filter(Boolean));
  }

  function zonesBody() {
    const list = data.zones || [];
    return el('div', { style: 'margin:12px 0 0' }, [
      el('h3', { text: `Work zones (${list.length})`, style: 'margin:0 0 6px' }),
      list.length
        ? el('div', {}, list.map((z) => el('div', { class: 'row-item' }, [
            el('div', { style: 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap' }, [
              el('strong', { text: z.label }),
              el('span', { class: 'badge badge--muted',
                text: (ZONE_KINDS.find(([k]) => k === z.kind) || [, z.kind])[1] }),
              el('span', { class: 'badge badge--muted',
                text: z.space === 'geographic' ? 'Map coordinates' : 'On a photo' })
            ]),
            el('p', { class: 'hint', style: 'margin:0', text:
              `${(z.points || []).length} points`
              + (z.image_source ? ` · ${z.image_source}` : '')
              + (z.note ? ` · ${z.note}` : '') }),
            el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, [
              el('button', {
                class: 'btn btn--sm', type: 'button', text: 'Edit',
                onClick: () => {
                  zone = {
                    zone_id: z.zone_id, label: z.label, kind: z.kind,
                    space: z.space,
                    points: (z.points || []).map((p) => ({ ...p })),
                    image_source: z.image_source || '', note: z.note || '',
                    lock_version: z.lock_version
                  };
                  zoneError = null; paint();
                }
              }),
              el('button', {
                class: 'btn btn--sm', type: 'button', text: 'Retire',
                disabled: busy ? true : undefined,
                title: 'Keeps it on record with the reason.',
                onClick: (e) => {
                  const reason = window.prompt('Why does this zone no longer apply?');
                  if (!reason) return;
                  if (!confirmAction(`Retire "${z.label}"? It stays on record.`)) return;
                  return act(e.currentTarget, () => api.retirePropertyWorkZone({
                    zoneId: z.zone_id, reason
                  }), 'Zone retired.');
                }
              })
            ])
          ])))
        : el('p', { class: 'hint', style: 'margin:0', text:
            'No zones drawn. Nothing is assumed about where the work is.' }),
      zone
        ? zoneEditor()
        : el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
            el('button', {
              class: 'btn btn--sm', type: 'button', text: 'Add a zone',
              onClick: () => { zone = blankZone(); zoneError = null; paint(); }
            })
          ])
    ]);
  }

  function body() {
    return el('div', { class: 'card' }, [
      el('h2', { text: 'Access and work zones', style: 'margin:0 0 4px' }),
      el('p', { class: 'hint', style: 'margin:0 0 10px', text:
        'What the crew needs to get in and work safely, kept apart from what '
        + 'a customer may see.' }),
      loading
        ? el('p', { class: 'hint', text: 'Loading…' })
        : loadError
          ? el('p', { class: 'error-text', text: loadError })
          : el('div', {}, [accessBody(), zonesBody()])
    ]);
  }

  paint();
  load();
  return host;
}
