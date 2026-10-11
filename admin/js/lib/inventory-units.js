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
