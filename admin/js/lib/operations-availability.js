import { supabase } from '../../../shared/supabase.js';

// Read-only, per-visit checks. No cached authority, writes, stored working
// details or assumptions that a checked-in migration has reached a server.
// These establish the screen's read prerequisites, not a schema-version or
// grant audit. The server still authorizes every operation when submitted.
export async function operationsAvailability(feature, read, { timeoutMs = 12000, ownerOnly = true } = {}) {
  if (!navigator.onLine) return { state: 'offline', feature };
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error('Availability check timed out'), { code: 'CHECK_TIMEOUT' }));
      }, timeoutMs);
    });
    const check = (async () => {
      const owner = await supabase.rpc('is_owner').abortSignal(controller.signal);
      if (owner.error) throw owner.error;
      if (owner.data !== true) {
        if (ownerOnly) return { state: 'owner_only', feature };
        // Dispatch's reviewed contract permits the vehicle's crew. Establish
        // current membership, then let its scoped read authorize the vehicle.
        const admin = await supabase.rpc('is_admin').abortSignal(controller.signal);
        if (admin.error) throw admin.error;
        if (admin.data !== true) return { state: 'denied', feature };
      }
      const value = await read(controller.signal);
      return { state: 'available', feature, value };
    })();
    return await Promise.race([check, timeout]);
  } catch (err) {
    // Do not display or log raw backend messages: access notes and tokens
    // can appear in an error. Codes suffice to distinguish the recovery.
    const code = String(err?.code || '');
    const state = ['PGRST202', 'PGRST204', 'PGRST205', '42883', '42P01', '42703'].includes(code)
      ? 'backend_missing'
      : ['42501', 'PGRST301', 'PGRST302', 'PGRST303'].includes(code)
        ? 'denied' : code === 'CHECK_TIMEOUT' ? 'timeout' : 'unconfirmed';
    return { state, feature };
  } finally {
    clearTimeout(timer);
  }
}

export function readResult(result) {
  if (result.error) throw result.error;
  return result.data;
}

export async function readRelations(names, signal) {
  for (const name of names) {
    // limit(0) checks availability without downloading business records.
    readResult(await supabase.from(name).select('*').limit(0).abortSignal(signal));
  }
}
