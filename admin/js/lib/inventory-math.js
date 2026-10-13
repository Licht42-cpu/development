/* Batch 8.1 -- the two conversions the inventory screens depend on, in their
 * own module.
 *
 * WHY THEY ARE NOT INLINE IN api.js
 *
 * The browser tests replace api.js wholesale with a stub, which is the right
 * shape for testing a view's behaviour but means any arithmetic living in
 * api.js is tested only against a copy of itself in the mock -- so the copy
 * can agree with a test while the real function is wrong. A purchase order
 * is counted in packs and the stock ledger in material units, so getting
 * this conversion wrong is a silent 150x error in the on-hand figure, which
 * is not something a duplicated implementation should be guarding.
 *
 * These are pure: no network, no Supabase, no DOM. The tests import this
 * module directly, un-mocked. */

/** Material units for `packs` packs of `material`.
 *
 *  A missing or nonsensical pack_quantity falls back to 1 rather than
 *  throwing: the database constrains the column to > 0, so a bad value here
 *  means a row that predates the constraint or a partial join, and treating
 *  one pack as one unit under-credits the shelf (visible, correctable)
 *  instead of crediting it by NaN (silently poisons every later sum). */
export function packsToUnits(material, packs) {
  const packQty = Number(material?.pack_quantity);
  const per = Number.isFinite(packQty) && packQty > 0 ? packQty : 1;
  const n = Number(packs);
  if (!Number.isFinite(n)) return 0;
  return n * per;
}

/** Whole packs needed to cover `shortfall` material units. Rounds UP: 150 ft
 *  short of a 500 ft roll is still one roll, and a fractional pack is not
 *  something a supplier will ship. A surplus is 0, never a negative order. */
export function packsForShortfall(material, shortfall) {
  const need = Number(shortfall);
  if (!Number.isFinite(need) || need <= 0) return 0;
  const packQty = Number(material?.pack_quantity);
  const per = Number.isFinite(packQty) && packQty > 0 ? packQty : 1;
  return Math.ceil(need / per);
}

/** The signed delta a manual movement should post.
 *
 *  `signForReason` is the direction the reason implies: +1 adds to the
 *  shelf, -1 takes off it, 0 means the operator's own sign is the intent.
 *  Anything other than 0 overrides what was typed, so "used 40" cannot be
 *  entered as +40 and quietly add stock -- the database refuses a positive
 *  'consumed', so without this the entry becomes an error the operator
 *  cannot explain. A correction keeps its sign, because a negative
 *  correction has to be possible to enter at all. */
export function signedDelta(signForReason, entered) {
  const n = Number(entered);
  if (!Number.isFinite(n) || n === 0) return 0;
  return signForReason === 0 ? n : signForReason * Math.abs(n);
}
