import * as api from '../lib/api.js';
import { el, clear } from '../../../shared/dom.js';
import { money, unitLabel, humanise } from '../../../shared/format.js';
import { evidencePolicyPanel } from '../components/evidence-policy.js';
import { settingField, validators, readAll, mergePreserving,
         createSaveControl } from '../lib/settings-form.js';

/** Settings edits CONFIGURATION and PRICING INPUTS. It never computes a quote
 *  figure: calculate_job_pricing() and the quote RPCs remain the only places
 *  money is worked out. Everything here feeds those. */

/* Currencies the quote pipeline actually stores. ns_quotes.currency defaults
   to CAD and the pricing rules carry CAD; this is a guard against a typo
   silently entering a currency nothing downstream understands, not an
   invitation to trade in others. */
const CURRENCIES = ['CAD', 'USD'];

export async function renderSettings({ mount }) {
  const [rules, settings, services] = await Promise.all([
    api.listPricingRules(),
    api.getSettings(),
    api.listServices()
  ]);

  /* ------------------------------------------------------------ pricing -- */

  const APPROVAL_BADGE = {
    approved:    { cls: 'badge--ok',    text: 'Approved' },
    provisional: { cls: 'badge--warn',  text: 'Provisional' },
    unpriced:    { cls: 'badge--muted', text: 'Unpriced' }
  };

  function approvalBadge(status) {
    const spec = APPROVAL_BADGE[status] || { cls: 'badge--muted', text: humanise(status || 'unknown') };
    return el('span', { class: `badge ${spec.cls}`, text: spec.text });
  }

  function rateRow(rule) {
    const service = rule.services || {};
    const unit = unitLabel(service.unit);

    const rateField = settingField({
      key: 'rate', label: `Rate ($ / ${unit})`, value: rule.rate,
      type: 'number', attrs: { step: '0.01', min: '0' },
      validate: validators.money({ required: true, min: 0 })
    });
    const minField = settingField({
      key: 'minimum', label: 'Minimum charge ($)', value: rule.minimum,
      type: 'number', attrs: { step: '1', min: '0' },
      validate: validators.money({ required: true, min: 0 })
    });

    const currentRate = el('span', { class: 'badge badge--muted', text: money(rule.rate) });

    const save = createSaveControl({
      label: 'Save rate',
      onSave: async () => {
        // Re-read at save time, not at click time: a coalesced trailing run
        // must write what is on screen now.
        const edits = readAll([rateField, minField]);
        if (!edits) return false;
        await api.updatePricingRule(rule.service_id, {
          rate: edits.rate, minimum: edits.minimum
        });
        // Keep the local copy in step so the badge and any later save reflect
        // what was actually stored.
        rule.rate = edits.rate;
        rule.minimum = edits.minimum;
        currentRate.textContent = money(edits.rate);
      }
    });

    return el('div', { class: 'section-box' }, [
      el('div', { class: 'section-box__head' }, [
        el('div', {}, [
          el('h3', { text: service.name || 'Unnamed service' }),
          el('span', { class: 'hint', text: `per ${unit} · ${humanise(service.category || '')}` })
        ]),
        el('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' }, [
          approvalBadge(rule.approval_status),
          currentRate
        ])
      ]),
      el('div', { class: 'grid grid--2' }, [rateField.node, minField.node]),
      save.node,
      rule.approval_status === 'provisional'
        ? el('p', { class: 'hint', style: 'margin:4px 0 0',
            text: 'Provisional: quotes using this rate are shown to the customer as an ' +
                  'estimate. Saving a new number here does not approve it.' })
        : el('p', { class: 'hint', style: 'margin:4px 0 0',
            text: 'Saving starts a new rate version. Quotes already sent keep the rate ' +
                  'they were built on, and the approval state above carries forward unchanged.' })
    ]);
  }

  /* Every category that actually has rules, rather than a hardcoded two.
     The previous version listed only 'cleaning' and 'lighting', so the
     'winter' rules -- Heating Wire Installation and Walkway, Step & Deck Snow
     Removal, both provisional -- could not be edited here at all, even though
     setting the winter rates before the snow is the task START_HERE sends the
     owner to this screen to do. Deriving the groups from the data means a new
     category appears here the day it is created. */
  const CATEGORY_BLURB = {
    cleaning: 'Changing a rate starts a new version — quotes already sent keep the rate they were built on.',
    lighting: 'Permanent and seasonal are priced independently, including their jump-wire runs.',
    winter:   'Set these before the season. Both start provisional until the rate is approved.'
  };

  const byCategory = new Map();
  for (const rule of rules) {
    const category = rule.services?.category || 'other';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(rule);
  }
  const categories = [...byCategory.keys()].sort();

  function pricingCard(category) {
    const group = byCategory.get(category);
    const provisional = group.filter(r => r.approval_status === 'provisional').length;
    return el('div', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('div', {}, [
          el('h2', { text: `${humanise(category)} rates` }),
          el('p', { text: CATEGORY_BLURB[category] ||
            'Changing a rate starts a new version — quotes already sent are unaffected.' })
        ]),
        provisional
          ? el('span', { class: 'badge badge--warn',
              text: `${provisional} provisional` })
          : null
      ]),
      ...group.map(rateRow)
    ]);
  }

  /* ----------------------------------------------------------- settings -- */

  /** A structured editor over one app_settings row.
   *
   *  updateSetting() replaces the whole stored JSON, and these editors expose
   *  only the fields they know about, so edits are merged over the original
   *  (mergePreserving). Without that, saving Tax would drop tax.note and
   *  tax.registration_number, which are really in the database today. */
  function settingsCard({ key, title, description, fields, note = null, footer = null }) {
    const original = settings[key] || {};
    const built = fields.map(spec => settingField({ ...spec, value: original[spec.key] }));

    const save = createSaveControl({
      label: `Save ${title.toLowerCase()}`,
      onSave: async () => {
        const edits = readAll(built);
        if (!edits) return false;
        const next = mergePreserving(original, edits);
        await api.updateSetting(key, next);
        // Keep the in-memory copy current so a second save merges over the
        // new state rather than resurrecting the values this one replaced.
        settings[key] = next;
        Object.assign(original, next);
      }
    });

    return el('div', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('div', {}, [el('h2', { text: title }), el('p', { text: description })])
      ]),
      note,
      el('div', { class: 'grid grid--2' }, built.map(f => f.node)),
      footer,
      save.node
    ].filter(Boolean));
  }

  /* Tax is the one setting with a standing instruction attached: it stays off
     until GST/HST registration completes. The warning is preserved, and
     'enabled' is a deliberate two-value choice rather than a checkbox that
     could be flipped by a stray click -- nothing here enables tax on its own. */
  const taxWarning = settings.tax && settings.tax.enabled === false
    ? el('div', { class: 'warn', style: 'margin-bottom:12px' }, [
        el('strong', { style: 'display:block;margin-bottom:4px', text: 'Tax is switched off' }),
        el('span', { text: 'Leave it off until GST/HST registration is complete — quotes will ' +
              'show no tax line. Turning this on changes what every new quote charges.' })
      ])
    : null;

  const companyCard = settingsCard({
    key: 'company', title: 'Company details',
    description: 'Used on quotes, the customer quote page and the public site.',
    fields: [
      { key: 'legal_name', label: 'Legal name', validate: validators.text({ required: true }) },
      { key: 'display_name', label: 'Display name', validate: validators.text({ required: true }) },
      { key: 'email', label: 'Email', validate: validators.email({ required: true }) },
      { key: 'phone', label: 'Phone', validate: validators.text({ required: true }) },
      { key: 'website', label: 'Website', validate: validators.url({ required: true }),
        hint: 'Also the base for the customer quote link in the quote email.' },
      { key: 'city', label: 'City', validate: validators.text({ required: false }) },
      { key: 'province', label: 'Province', validate: validators.text({ required: false }) },
      { key: 'service_area', label: 'Service area', validate: validators.text({ required: false }) }
    ]
  });

  const taxCard = settingsCard({
    key: 'tax', title: 'Tax',
    description: 'Leave disabled until you are registered to collect.',
    note: taxWarning,
    fields: [
      { key: 'enabled', label: 'Charge tax on new quotes', type: 'select',
        options: [{ value: 'false', label: 'No — not registered' },
                  { value: 'true', label: 'Yes — registered and collecting' }],
        validate: validators.boolean() },
      { key: 'label', label: 'Tax label', validate: validators.text({ required: true }),
        hint: 'Shown on the quote, e.g. HST.' },
      { key: 'rate', label: 'Rate (fraction)', type: 'number',
        attrs: { step: '0.001', min: '0', max: '1' },
        validate: validators.fraction({ required: true }),
        hint: '0.13 means 13%.' },
      { key: 'registration_number', label: 'GST/HST registration number',
        validate: validators.text({ required: false }),
        hint: 'Leave blank until registered.' }
    ]
  });

  const quoteDefaultsCard = settingsCard({
    key: 'quote_defaults', title: 'Quote defaults',
    description: 'Applied to every newly created quote. Changing these does not alter existing quotes.',
    fields: [
      { key: 'validity_days', label: 'Valid for (days)', type: 'number',
        attrs: { step: '1', min: '1' },
        validate: validators.integer({ required: true, min: 1, max: 365 }) },
      { key: 'currency', label: 'Currency', type: 'select',
        options: CURRENCIES.map(c => ({ value: c, label: c })),
        validate: validators.choice(CURRENCIES, { required: true }) },
      { key: 'customer_note', label: 'Default note to the customer', type: 'textarea',
        validate: validators.text({ required: false }),
        hint: 'Appears on the customer quote page. Editable per quote.' },
      { key: 'terms', label: 'Default terms', type: 'textarea',
        validate: validators.text({ required: false }),
        hint: 'Appears at the bottom of the customer quote. Editable per quote.' }
    ]
  });

  /* app_settings.admin.base_url exists in the database and is what staff
     emails build their links from, but no screen has ever exposed it. */
  const adminCard = settingsCard({
    key: 'admin', title: 'Staff email links',
    description: 'The address staff notification emails link back to.',
    fields: [
      { key: 'base_url', label: 'Admin base URL', validate: validators.url({ required: true }),
        hint: 'e.g. https://novashieldmaintenance.com/admin — staff emails link here.' }
    ]
  });

  /* The lighting programme keeps a generic editor: its fields are public-site
     copy rather than anything the quote engine reads, and the existing shape
     is still being settled. Typed where the type is obvious, text otherwise. */
  const lightingCard = settingsCard({
    key: 'lighting', title: 'Lighting programme',
    description: 'Warranty and seasonal windows shown on the website.',
    fields: Object.keys(settings.lighting || {}).map(k => {
      const current = (settings.lighting || {})[k];
      if (typeof current === 'boolean') {
        return { key: k, label: humanise(k), type: 'select',
          options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
          validate: validators.boolean() };
      }
      if (typeof current === 'number') {
        return { key: k, label: humanise(k), type: 'number', attrs: { step: '1', min: '0' },
          validate: validators.integer({ required: true, min: 0 }) };
      }
      return { key: k, label: humanise(k), validate: validators.text({ required: false }) };
    })
  });

  const unpriced = services.filter(s =>
    s.quotable && !rules.some(r => r.service_id === s.id));

  clear(mount).append(...[
    el('div', { class: 'page-head' }, [
      el('h1', { text: 'Settings' }),
      el('p', { text: 'Rates, company details and quote defaults. No code changes needed.' })
    ]),

    unpriced.length
      ? el('div', { class: 'warn' }, [
          el('strong', { style: 'display:block;margin-bottom:4px',
            text: `${unpriced.length} quotable service${unpriced.length === 1 ? '' : 's'} with no rate` }),
          el('span', { text: `${unpriced.map(s => s.name).join(', ')} — these price as unpriced ` +
                'until a rate exists, and a quote including them cannot be approved pricing.' })
        ])
      : null,

    ...categories.map(pricingCard),

    companyCard,
    quoteDefaultsCard,
    taxCard,
    adminCard,
    lightingCard,

    /* Batch 11.1. The one place the owner can turn what this system
       GUESSED a job has to prove into what it actually has to prove. It
       loads itself, because the rules live in their own table rather than
       in app_settings -- a requirement with a version, a confirmation date
       and a name on it is not a settings key. */
    evidencePolicyPanel().root
  ].filter(Boolean));
}
