import { clear } from '../../../shared/dom.js';

/* DOM helpers for the admin operations screens.
 *
 * WHY THIS IS NOT IN shared/dom.js
 *
 * It was, briefly. The revised roadmap after Batch 7 makes shared/dom.js,
 * shared/format.js and the test harness READ-ONLY to both tracks unless an
 * assignment explicitly transfers ownership, so a helper added for the
 * inventory screens does not belong there. Nothing in this file is specific
 * to inventory, though, so if the field track ever needs the same thing the
 * right move is an owner-authorised transfer into shared/, not a second
 * copy here and there. */

/** Empties `node` and appends `children`, dropping the falsy ones.
 *
 *  el() already skips null/undefined/false children, so `cond ? x : null`
 *  reads as "omit this" everywhere inside an el() call. DOM append() does
 *  NOT: it stringifies, so the same expression passed to
 *  `clear(host).append(...)` paints the literal word "null" on the page.
 *
 *  Found in Batch 8.1 by looking at a screenshot. No DOM assertion caught
 *  it, because the tests looked for the elements they expected and found
 *  them -- the stray text nodes sat between them, invisible to any query.
 *
 *  Use this instead of clear(x).append(...) wherever any child is
 *  conditional. The same latent bug exists in pre-existing views that use
 *  the clear().append() pattern (winter.js is one); those are outside this
 *  batch and were deliberately left alone -- see
 *  docs/batch8-1-findings.md. */
export function fill(node, children) {
  clear(node);
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
