import * as api from '../lib/api.js';
import { el, select, confirmAction } from '../../../shared/dom.js';
import { trySave, describeWriteError } from '../lib/save.js';
import { humanise, date } from '../../../shared/format.js';

/* What this job has to prove, and whether it has.
 *
 * THE IDEA THIS SCREEN EXISTS TO HOLD ON TO: unknown is not zero.
 *
 * A service with no evidence policy reads `Nobody has said` -- not "0 of 0",
 * not a green tick, and not a blank. A requirement the owner has merely had
 * PROPOSED to them reads as a suggestion and cannot stop anyone. Only a
 * requirement the owner confirmed and marked blocking shows as something
 * that will refuse the completion, and when it does it says so before the
 * crew drives away rather than after.
 *
 * WHY THE PHOTO LIST IS A REGISTRATION AND NOT AN UPLOAD. The photographs
 * are already on the job -- the field console put them there. What is
 * missing is WHICH PURPOSE each one serves, and that is a different fact
 * from the file. So this screen attaches existing attachments to purposes,
 * and one image can legitimately be attached to several: a shot of the deck
 * with the siding behind it is the `before` for both, and making the crew
 * take it twice would be a worse record, not a better one.
 *
 * Nothing here uploads, draws a watermark, or decides a price. */

const REQUIREMENTS = [
  { value: 'before',         label: 'Before — the state we found it in' },
  { value: 'after',          label: 'After — the state we left it in' },
  { value: 'installation',   label: 'Installation — the run as it was left' },
  { value: 'component',      label: 'Component — what came out of the box' },
  { value: 'winter_proof',   label: 'Winter proof — somebody was there' },
  { value: 'site_condition', label: 'Site condition' },
  { value: 'access_hazard',  label: 'Access or hazard' }
];

const STATE_COPY = {
  satisfied:    { badge: 'badge--ok',    text: 'Satisfied' },
  excepted:     { badge: 'badge--muted', text: 'Excused' },
  short:        { badge: 'badge--warn',  text: 'Short' },
  unconfigured: { badge: 'badge--muted', text: 'Nobody has said' }
};

const READINESS_COPY = {
  satisfied: {
    badge: 'badge--ok',
    text: 'Everything this job has to prove is proved.'
  },
  advisory_short: {
    badge: 'badge--warn',
    text: 'Something is missing, and no confirmed rule requires it. The '
      + 'completion will be accepted and will record the gap.'
  },
  unconfigured: {
    badge: 'badge--muted',
    text: 'At least one service on this job has no evidence rule at all, so '
      + 'nobody can say whether it is proved. The completion will be '
      + 'accepted and will record exactly that.'
  },
  blocked: {
    badge: 'badge--warn',
    text: 'A requirement the owner confirmed is not met. Completion will be '
      + 'refused until it is, or until the owner excuses it with a reason.'
  }
};

/** One evidence row, described by its STATES. Never "taken just now" for a
 *  photo whose device said nothing: the states are the facts. */
function evidenceLine(e) {
  return [
    e.capture_time_state === 'device_reported'
      ? `taken ${date(e.captured_at)}`
      : `capture time ${humanise(e.capture_time_state)}`,
    `location ${humanise(e.gps_state)}`,
    `received ${date(e.received_at)}`,
    e.frozen_by_completion ? 'frozen by an accepted completion' : null
  ].filter(Boolean).join(' · ');
}

/** `count` of `required`, with unknown left as unknown. */
function countText(row) {
  if (row.required_count === null || row.required_count === undefined) {
    return `${row.satisfied_count} on file, no requirement set`;
  }
  return `${row.satisfied_count} of ${row.required_count}`;
}

/* OWNER-ONLY CONTROLS ARE RENDERED FOR EVERYONE, and the server refuses
 * them. That is the idiom the seasonal and load panels already use: there is
 * no is_owner() the browser can trust anyway -- it is a database predicate
 * over ns_crew_members -- so a UI gate would be decoration over the real
 * rule and would also hide the action from the owner if it guessed wrong.
 * What the crew sees instead is a sentence saying who can do it, and a
 * refusal with the backend's own words if they try. */
export function jobEvidencePanel({ jobId, onChanged } = {}) {
  const host = el('div', {});

  async function load() {
    const [requirements, readiness, evidence, attachments, exceptions] =
      await Promise.all([
        api.jobEvidenceRequirements(jobId),
        api.jobEvidenceReadiness(jobId),
        api.listJobEvidence(jobId),
        api.listAttachments(jobId),
        api.listEvidenceExceptions(jobId)
      ]);
    paint({ requirements, readiness, evidence, attachments, exceptions });
  }

  function requirementRow(row, evidence) {
    const copy = STATE_COPY[row.state] || STATE_COPY.unconfigured;
    // A row with no policy cannot enforce anything, whatever the
    // enforcement column coalesced to. Belt and braces: the view already
    // reports 'advisory' for an unconfigured row, and printing "will refuse
    // completion" next to "nobody has said" would be a contradiction on
    // screen.
    const enforcing = row.enforcement === 'blocking' && !!row.policy_id;
    const mine = evidence.filter((e) =>
      e.requirement === row.requirement
      && (row.coverage === 'per_job' || e.service_id === row.service_id));

    return el('div', { class: 'row-item' }, [
      el('div', {}, [
        el('strong', { text: `${row.service_name || row.service_key} — ${humanise(row.requirement || 'unconfigured')}` }),
        el('div', { class: 'hint', text: [
          countText(row),
          row.coverage ? humanise(row.coverage) : null,
          row.requires_geotag ? 'device location required' : null,
          // A proposal is OUR guess and says so. This is the line that
          // stops a seeded assumption reading as a business rule.
          row.spec_state === 'proposed' ? 'proposed, not confirmed by the owner' : null,
          row.spec_state === 'unconfigured' ? 'no rule on file' : null,
          enforcing ? 'will refuse completion' : null
        ].filter(Boolean).join(' · ') }),
        mine.length ? el('ul', { class: 'hint', style: 'margin:4px 0 0 16px' },
          mine.map((e) => el('li', { text: evidenceLine(e) }))) : null
      ]),
      el('span', { class: `badge ${copy.badge}`, text: copy.text })
    ]);
  }

  function registerForm(requirements, attachments) {
    const unregistered = attachments;
    const attachmentPick = select(
      unregistered.map((a) => ({
        value: a.id,
        label: `${a.caption || a.storage_path.split('/').pop()}${a.kind ? ` (${humanise(a.kind)})` : ''}`
      })),
      unregistered[0] ? unregistered[0].id : '');
    const requirementPick = select(REQUIREMENTS, 'before');
    // Scope: the whole job, or one of the services actually on it.
    const scopeOptions = [{ value: '', label: 'The whole job' }].concat(
      [...new Map(requirements
        .filter((r) => r.service_key)
        .map((r) => [r.service_key, { value: r.service_key, label: r.service_name || r.service_key }])
      ).values()]);
    const scopePick = select(scopeOptions, '');

    const button = el('button', {
      class: 'btn btn--sm btn--primary', text: 'Register as evidence',
      onClick: async () => {
        if (!attachmentPick.value) return;
        await trySave(async () => {
          await api.registerJobEvidence({
            jobId,
            attachmentId: attachmentPick.value,
            requirement: requirementPick.value,
            serviceKey: scopePick.value || null,
            // NOT SENT: a capture time or a location this screen invented.
            // The desk did not take the photograph, so it has no claim to
            // make, and the backend records `unknown` rather than now().
            source: 'desk'
          });
          await load();
          onChanged?.();
        }, { success: 'Registered' });
      }
    });

    if (!unregistered.length) {
      return el('p', { class: 'hint', text:
        'No photographs on this job yet. The field console puts them here; '
        + 'this screen says what each one proves.' });
    }

    return el('div', { class: 'grid grid--3', style: 'margin-top:10px' }, [
      el('label', { class: 'field', style: 'margin:0' },
        [el('span', { text: 'Photograph' }), attachmentPick]),
      el('label', { class: 'field', style: 'margin:0' },
        [el('span', { text: 'Proves' }), requirementPick]),
      el('label', { class: 'field', style: 'margin:0' },
        [el('span', { text: 'Scope' }), scopePick]),
      el('div', { style: 'display:flex;align-items:flex-end' }, [button])
    ]);
  }

  function exceptionForm(requirements) {
    const reason = el('textarea', {
      placeholder: 'Why this job is being excused — the camera died, the owner inspected it personally…',
      'aria-label': 'Reason for the exception', rows: '2'
    });
    const requirementPick = select(
      [{ value: '', label: 'Every requirement on this job' }].concat(REQUIREMENTS), '');
    const scopePick = select(
      [{ value: '', label: 'Every service' }].concat(
        [...new Map(requirements.filter((r) => r.service_key).map((r) =>
          [r.service_key, { value: r.service_key, label: r.service_name || r.service_key }]
        )).values()]), '');

    const errorLine = el('p', { class: 'error-text' });

    return el('div', { style: 'margin-top:10px' }, [
      el('p', { class: 'hint', text:
        'An exception is a named, reasoned exemption for THIS job, recorded '
        + 'against your name. It does not change the rule for anything else.' }),
      el('div', { class: 'grid grid--2' }, [
        el('label', { class: 'field', style: 'margin:0' },
          [el('span', { text: 'Excuse which requirement' }), requirementPick]),
        el('label', { class: 'field', style: 'margin:0' },
          [el('span', { text: 'For which service' }), scopePick])
      ]),
      el('label', { class: 'field' }, [el('span', { text: 'Reason' }), reason]),
      el('button', {
        class: 'btn btn--sm', text: 'Authorise the exception',
        onClick: async () => {
          if (!reason.value.trim()) {
            errorLine.textContent =
              'An exception without a reason is not an exception.';
            return;
          }
          errorLine.textContent = '';
          if (!confirmAction('Authorise this exception?')) return;
          await trySave(async () => {
            await api.authoriseEvidenceException({
              jobId,
              reason: reason.value.trim(),
              requirement: requirementPick.value || null,
              serviceKey: scopePick.value || null
            });
            await load();
            onChanged?.();
          }, { success: 'Exception authorised' });
        }
      }),
      errorLine
    ]);
  }

  function paint({ requirements, readiness, evidence, attachments, exceptions }) {
    const state = READINESS_COPY[readiness?.evidence_state] || READINESS_COPY.unconfigured;

    host.replaceChildren(el('div', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('div', {}, [
          el('h2', { text: 'Evidence' }),
          el('p', { text: 'What this job has to prove before it can be '
            + 'completed, per service. Set by the owner; unknown is its own '
            + 'answer and is never read as "nothing needed".' })
        ]),
        el('span', { class: `badge ${state.badge}`, text: humanise(readiness?.evidence_state || 'unconfigured') })
      ]),

      el('p', { class: 'hint', text: state.text }),
      readiness?.unconfigured_services?.length
        ? el('p', { class: 'hint', text:
            `No rule on file for: ${readiness.unconfigured_services.join(', ')}.` })
        : null,

      requirements.length
        ? el('div', {}, requirements.map((r) => requirementRow(r, evidence)))
        : el('div', { class: 'empty', text:
            'This job has no measured services, so there is nothing to '
            + 'require evidence of yet.' }),

      /* EVIDENCE THAT COUNTS TOWARDS NOTHING. A photograph registered
         against the whole job does not satisfy a per-service-scope
         requirement -- that is the rule the view enforces and this screen
         mirrors -- so without this section it would be registered,
         attributed, stored, and invisible. An operator who cannot see a
         photo they just filed will file it again. */
      (() => {
        const counted = new Set();
        for (const r of requirements) {
          for (const e of evidence) {
            if (e.requirement === r.requirement
                && (r.coverage === 'per_job' || e.service_id === r.service_id)) {
              counted.add(e.id);
            }
          }
        }
        const spare = evidence.filter((e) => !counted.has(e.id));
        if (!spare.length) return null;
        return el('div', { style: 'margin-top:10px' }, [
          el('h3', { text: 'On file, counting towards nothing' }),
          el('p', { class: 'hint', text:
            'Registered, attributed and kept — but no requirement on this job '
            + 'is satisfied by it. Usually it is scoped to the whole job while '
            + 'the requirement wants one per service.' }),
          el('div', {}, spare.map((e) => el('div', { class: 'row-item' }, [
            el('div', {}, [
              el('strong', { text: humanise(e.requirement) }),
              el('div', { class: 'hint', text: evidenceLine(e) })
            ]),
            el('span', { class: 'badge badge--muted', text: 'Not counted' })
          ])))
        ]);
      })(),

      exceptions.length ? el('div', { style: 'margin-top:10px' }, [
        el('h3', { text: 'Exceptions on this job' }),
        el('div', {}, exceptions.map((x) => el('div', { class: 'row-item' }, [
          el('div', {}, [
            el('strong', { text: x.requirement
              ? humanise(x.requirement) : 'Every requirement' }),
            el('div', { class: 'hint', text: [
              x.services ? x.services.name : 'every service',
              date(x.authorised_at)
            ].filter(Boolean).join(' · ') }),
            el('div', { class: 'hint', text: x.reason })
          ]),
          el('span', { class: 'badge badge--muted', text: 'Excused' })
        ])))
      ]) : null,

      el('h3', { text: 'Say what a photograph proves', style: 'margin-top:14px' }),
      registerForm(requirements, attachments),

      el('div', {}, [
        el('h3', { text: 'Excuse this job', style: 'margin-top:14px' }),
        el('p', { class: 'hint', text:
          'Owner only. A crew that could excuse its own photographs would be '
          + 'the absence of a rule rather than an exception to one, so the '
          + 'backend refuses it.' }),
        exceptionForm(requirements)
      ])
    ]));
  }

  load().catch((err) => {
    host.replaceChildren(el('div', { class: 'card' }, [
      el('h2', { text: 'Evidence' }),
      el('p', { class: 'error-text', text: describeWriteError(err) })
    ]));
  });

  return { root: host, reload: load };
}
