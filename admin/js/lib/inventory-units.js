import { unitLabel as sharedUnitLabel } from '../../../shared/format.js';

/* Unit presentation for the inventory screens.
 *
 * WHY THIS IS NOT IN shared/format.js
 *
 * The revised roadmap after Batch 7 makes shared/format.js read-only to both
 * tracks. Its UNIT_LABELS knows the four SERVICE units (sq_ft, linear_ft,
 * each, fixed) and its unitLabel() falls through to the raw key for anything
 * else -- so the material units added in Batch 8.1 would render as "litre"
 * and "kilogram" rather than "L" and "kg". This module layers the material
 * units on top and delegates everything it does not know, so a unit nobody
 * has mapped degrades to something readable rather than blank.
 *
 * Two different vocabularies, deliberately: a SERVICE is measured in linear
 * feet, a MATERIAL is counted in sticks. They overlap (linear_ft is both)
 * and must not be merged, which is why this delegates instead of replacing. */

/** Short form, for a figure that already carries its own number. */
const MATERIAL_UNITS = {
  litre:    'L',
  kilogram: 'kg',
  stick:    'stick',
  level:    '',            // a level has no unit: "Low" is the whole answer
  box:      'box',
  roll:     'roll',
  kit:      'kit',
  set:      'set'
};

/** Plural, for the cases where the count is not 1. English only; this app
 *  has no localisation and inventing one here would be the wrong place. */
const PLURALS = {
  stick: 'sticks',
  box:   'boxes',
  roll:  'rolls',
  kit:   'kits',
  set:   'sets'
};

export function materialUnitLabel(unit) {
  if (unit in MATERIAL_UNITS) return MATERIAL_UNITS[unit];
  return sharedUnitLabel(unit);
}

/* ------------------------------------------------- choosing a unit --- */

/* WHY THERE IS A SECOND SET OF LABELS. materialUnitLabel() is the SHORT
   form, for a figure that already carries its number: "40 L" reads
   correctly, "40 Litres" does not. In a <select> there is no number beside
   it, so "L" on its own is a riddle. These are the long forms, and they
   include the short form in brackets where the two differ so the operator
   can see which abbreviation the rest of the screen will use.

   'level' is NOT in this list on purpose. unit='level' is not a unit the
   operator picks; it is implied by choosing level tracking, and the
   database enforces that the two agree:

     ns_materials_level_unit_agrees check ((tracking_mode = 'level') = (unit = 'level'))

   Offering 'level' here as well would let a form produce the one
   combination that constraint exists to refuse. The order matches the
   constraint's own list, with the counted units first and the measured
   ones after, because that is how the catalogue divides in practice. */
export const MATERIAL_UNIT_CHOICES = [
  { value: 'each',      label: 'Each' },
  { value: 'linear_ft', label: 'Linear feet (ft)' },
  { value: 'box',       label: 'Boxes' },
  { value: 'roll',      label: 'Rolls' },
  { value: 'kit',       label: 'Kits' },
  { value: 'set',       label: 'Sets' },
  { value: 'litre',     label: 'Litres (L)' },
  { value: 'kilogram',  label: 'Kilograms (kg)' },
  { value: 'stick',     label: 'Channel sticks' }
];

/** The unit a level-tracked material must carry, named once so a form does
 *  not have to know the string. */
export const LEVEL_UNIT = 'level';

/** The two tracking modes, with the words that say what each one means
 *  rather than the column value. "Quantity" alone does not tell an operator
 *  that picking it commits them to counting the thing. */
export const TRACKING_MODES = [
  { value: 'quantity',
    label: 'Counted',
    hint: 'A number on the shelf, in a unit you choose, with a movement ledger behind it.' },
  { value: 'level',
    label: 'Checked as a level',
    hint: 'Empty / Low / Enough, recorded per location. No count, no pack '
        + 'conversion, no reorder point and nothing to reserve — a level is '
        + 'somebody’s observation, not a number to do arithmetic on.' }
];

/** "40 L", "3 sticks", "1 stick". Takes the number so it can get the plural
 *  right, which "3 stick" does not. A level-tracked supply has no unit, so
 *  this returns the bare quantity for it. */
export function quantityWithUnit(quantity, unit) {
  const label = materialUnitLabel(unit);
  if (!label) return String(quantity);
  const plural = Math.abs(Number(quantity)) === 1 ? label : (PLURALS[unit] || label);
  return `${quantity} ${plural}`;
}

/* ------------------------------------------------------------ levels --- */

/** Empty / Low / Enough, in the order a shelf empties. */
export const LEVEL_STATES = ['empty', 'low', 'enough'];

export const LEVEL_LABELS = {
  empty:  'Empty',
  low:    'Low',
  enough: 'Enough'
};

/** Which badge a level deserves. Empty is a problem, Low is a warning, and
 *  Enough is the only one that is not asking for attention. */
export function levelBadgeClass(state) {
  if (state === 'empty') return 'badge badge--warn';
  if (state === 'low') return 'badge badge--warn';
  if (state === 'enough') return 'badge badge--ok';
  return 'badge badge--muted';         // never checked
}

export function levelLabel(state) {
  return LEVEL_LABELS[state] || 'Not checked';
}

/* ------------------------------------------------- condition, precision -- */

/** A balance that any estimate contributed to must say so. The database
 *  flags it (ns_material_stock.is_estimated); this is the words for it. */
export function precisionNote(isEstimated) {
  return isEstimated
    ? 'Includes an estimated count, so treat this as approximate.'
    : null;
}

export const MOVEMENT_CONDITIONS = [
  ['usable',  'Usable'],
  ['damaged', 'Damaged']
];

export const COUNT_PRECISIONS = [
  ['exact',     'Counted exactly'],
  ['estimated', 'Estimated']
];
