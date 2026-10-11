// Local navigation names only. No load renderer, RPC, or wire contract exists.
// Enabling this entry point requires the frozen 10.1 contract and a later batch.
export const LOAD_INTERFACE_ENABLED = false;
export const LOAD_ENTRY_PATH = '/load';

export function unavailableLoadRoute(path) {
  return !LOAD_INTERFACE_ENABLED && /^\/load(?:\/|$)/.test(path);
}
