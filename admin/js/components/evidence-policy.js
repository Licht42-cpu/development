import * as api from '../lib/api.js';
import { el, select, confirmAction } from '../../../shared/dom.js';
import { trySave, describeWriteError } from '../lib/save.js';
import { humanise, date } from '../../../shared/format.js';

/* What each service has to prove, set by the owner.
 *
 * WHY EVERY ROW ARRIVES MARKED "PROPOSED". Nobody has told this system what
 * the real evidence rules are. The rows that ship are what a careful reading
 * of the work suggests -- a cleaning service is proved by a before and an
 * after, a lighting run by what went up and what it was made of, a winter
 * check by one quick shot -- and they are stored as PROPOSALS so the owner
 * can correct them rather than discover them. A proposal reports a shortfall
 * and refuses nothing. Only a rule the owner has confirmed can be set to
 * BLOCKING, and the database enforces that pairing, so nothing guessed here
 * can ever stop a crew finishing a job.
 *
 * THE TWO DIALS THAT MATTER MOST, and the question behind each:
 *
 *   min_count        how many photographs settle it. One is the proposal
 *                    everywhere; nobody has said whether a long elevation
 *                    needs two.
 *   requires_geotag  whether the capture has to carry a device location.
 *                    Proposed OFF everywhere, including the winter check:
 *                    a crew in a basement or a steel garage has no GPS
 *                    through no fault of its own, and refusing those jobs
 *                    would stop the work rather than improve the record.
 *                    Turning it on for the winter visit is the open
 *                    business question, not a default this system picked.
 *
 * Saving a row CONFIRMS it, with your name and the date on it. */

const REQUIREMENTS = [
  { value: 'before',         label: 'Before' },
  { value: 'after',          label: 'After' },
  { value: 'installation',   label: 'Installation' },
  { value: 'component',      label: 'Component' },
  { value: 'winter_proof',   label: 'Winter proof' },
  { value: 'site_condition', label: 'Site condition' },
  { value: 'access_hazard',  label: 'Access or hazard' }
];

const COVERAGE = [
  { value: 'per_job',           label: 'One for the whole job' },
  { value: 'per_service_scope', label: 'One per service on the job' }
];

const ENFORCEMENT = [
  { value: 'advisory', label: 'Advisory — records the gap, accepts the job' },
  { value: 'blocking', label: 'Blocking — refuses the completion' }
];

/* As with the job panel: the controls are rendered for everyone and the
 * backend refuses a crew, because is_owner() is a database predicate the
 * browser cannot evaluate. The hint says who can. */
export function evidencePolicyPanel({ onChanged } = {}) {
  const host = el('div', {});

  async function load() {
    const [policies, version, services] = await Promise.all([
      api.listEvidencePolicies(),
      api.evidencePolicyVersion(),
      api.listServices()
    ]);
    paint({ policies, version, services });
  }

  function policyRow(p) {
    const proposed = p.spec_state === 'proposed';
    const serviceKey = p.services ? p.services.key : null;

    const minCount = el('input', {
      type: 'number', min: '1', step: '1', value: String(p.min_count),
      'aria-label': 'How many', style: 'width:72px'
    });
    const coverage = select(COVERAGE, p.coverage);
    const geotag = el('input', { type: 'checkbox', 'aria-label': 'Device location required' });
    geotag.checked = !!p.requires_geotag;
    const enforcement = select(ENFORCEMENT, p.enforcement);

    const controls = el('div', { class: 'grid grid--3', style: 'margin-top:6px' }, [
      el('label', { class: 'field', style: 'margin:0' },
        [el('span', { text: 'How many' }), minCount]),
      el('label', { class: 'field', style: 'margin:0' },
        [el('span', { text: 'Coverage' }), coverage]),
      el('label', { class: 'field', style: 'margin:0' },
        [el('span', { text: 'Enforcement' }), enforcement]),
      /* flex-wrap and a min-width:0 basis, because at 390px this cell was
         squeezing "Needs a device location" into a three-word column. The
         overflow probe passed it -- nothing spilled off the page -- which
         is exactly why the screenshots get looked at. */
      el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
        el('label', { style: 'display:flex;gap:6px;align-items:center;flex:1 1 auto;min-width:0' },
          [geotag, el('span', { text: 'Needs a device location' })])
      ]),
      el('div', { style: 'display:flex;align-items:flex-end;gap:8px' }, [
        el('button', {
          class: 'btn btn--sm btn--primary',
          text: proposed ? 'Confirm this rule' : 'Save',
          onClick: async () => {
            const n = Number(minCount.value);
            if (!Number.isInteger(n) || n < 1) return;
            await trySave(async () => {
              await api.setEvidencePolicy({
                serviceKey,
                requirement: p.requirement,
                minCount: n,
                coverage: coverage.value,
                requiresGeotag: geotag.checked,
                enforcement: enforcement.value,
                note: 'Confirmed by the owner from the settings screen'
              });
              await load();
              onChanged?.();
            }, { success: 'Rule confirmed' });
          }
        }),
        el('button', {
          class: 'btn btn--sm btn--danger', text: 'Withdraw',
          onClick: async () => {
            if (!confirmAction(
              `Withdraw the ${humanise(p.requirement)} requirement for `
              + `${p.services ? p.services.name : 'this service'}? Jobs will `
              + 'then read as having no rule for it.')) return;
            await trySave(async () => {
              await api.retireEvidencePolicy({
                serviceKey, requirement: p.requirement
              });
              await load();
              onChanged?.();
            }, { success: 'Requirement withdrawn' });
          }
        })
      ])
    ]);

    return el('div', { class: 'row-item', style: 'display:block' }, [
      /* Same reason: at 390 the badge beside the title left the heading
         about 40% of the width and it wrapped one word per line. Wrapping
         puts the badge on its own line on a phone and keeps it inline on a
         desktop, with no stylesheet change. */
      el('div', { style: 'display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap' }, [
        el('div', { style: 'flex:1 1 220px;min-width:0' }, [
          el('strong', { text: `${p.services ? p.services.name : 'Unknown service'} — ${humanise(p.requirement)}` }),
          el('div', { class: 'hint', text: [
            `${p.min_count} required`,
            humanise(p.coverage),
            p.requires_geotag ? 'device location required' : 'device location optional',
            p.enforcement === 'blocking' ? 'refuses completion' : 'advisory only',
            p.confirmed_at ? `confirmed ${date(p.confirmed_at)}` : null
          ].filter(Boolean).join(' · ') }),
          p.note ? el('div', { class: 'hint', text: p.note }) : null
        ]),
        el('span', {
          class: `badge ${proposed ? 'badge--warn' : 'badge--ok'}`,
          text: proposed ? 'Proposed — not confirmed' : 'Owner-confirmed'
        })
      ]),
      controls
    ]);
  }

  function addForm(services, policies) {
    const servicePick = select(
      services.map((s) => ({ value: s.key, label: s.name })),
      services[0] ? services[0].key : '');
    const requirementPick = select(REQUIREMENTS, 'before');
    const minCount = el('input', { type: 'number', min: '1', step: '1', value: '1',
      'aria-label': 'How many', style: 'width:72px' });
    const coverage = select(COVERAGE, 'per_job');
    const enforcement = select(ENFORCEMENT, 'advisory');

    return el('div', { style: 'margin-top:14px' }, [
      el('h3', { text: 'Add a requirement' }),
      el('div', { class: 'grid grid--3' }, [
        el('label', { class: 'field', style: 'margin:0' },
          [el('span', { text: 'Service' }), servicePick]),
        el('label', { class: 'field', style: 'margin:0' },
          [el('span', { text: 'Must prove' }), requirementPick]),
        el('label', { class: 'field', style: 'margin:0' },
          [el('span', { text: 'How many' }), minCount]),
        el('label', { class: 'field', style: 'margin:0' },
          [el('span', { text: 'Coverage' }), coverage]),
        el('label', { class: 'field', style: 'margin:0' },
          [el('span', { text: 'Enforcement' }), enforcement]),
        el('div', { style: 'display:flex;align-items:flex-end' }, [
          el('button', {
            class: 'btn btn--sm btn--primary', text: 'Add and confirm',
            onClick: async () => {
              const n = Number(minCount.value);
              if (!Number.isInteger(n) || n < 1) return;
              await trySave(async () => {
                await api.setEvidencePolicy({
                  serviceKey: servicePick.value,
                  requirement: requirementPick.value,
                  minCount: n,
                  coverage: coverage.value,
                  enforcement: enforcement.value,
                  note: 'Added by the owner from the settings screen'
                });
                await load();
                onChanged?.();
              }, { success: 'Requirement added' });
            }
          })
        ])
      ])
    ]);
  }

  function paint({ policies, version, services }) {
    const proposedCount = policies.filter((p) => p.spec_state === 'proposed').length;

    host.replaceChildren(el('div', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('div', {}, [
          el('h2', { text: 'Evidence requirements' }),
          el('p', { text: 'What each service has to prove before a job can '
            + 'be completed. A rule you have not confirmed records the gap '
            + 'and refuses nothing.' })
        ]),
        el('span', { class: 'badge badge--muted', text: `Version ${version}` })
      ]),

      proposedCount
        ? el('p', { class: 'hint', text:
            `${proposedCount} of these are PROPOSALS, not your rules. They were `
            + 'written down so you could correct them. Until you confirm one, '
            + 'it cannot stop a crew finishing a job.' })
        : null,

      policies.length
        ? el('div', {}, policies.map(policyRow))
        : el('div', { class: 'empty', text:
            'No evidence requirements on file. Every job will read as '
            + '"nobody has said" and will be accepted with that recorded.' }),

      el('p', { class: 'hint', style: 'margin-top:14px', text:
        'Owner only: setting what a job has to prove is a business rule, and '
        + 'the backend refuses a crew member who tries.' }),
      addForm(services, policies)
    ]));
  }

  load().catch((err) => {
    host.replaceChildren(el('div', { class: 'card' }, [
      el('h2', { text: 'Evidence requirements' }),
      el('p', { class: 'error-text', text: describeWriteError(err) })
    ]));
  });

  return { root: host, reload: load };
}
