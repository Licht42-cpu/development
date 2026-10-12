// Enabled against daily-load-contract v2.1 at b7f0a22. Backend migrations
// remain unapplied: unavailable RPCs show a read failure, never a fake plan.
export const LOAD_INTERFACE_ENABLED = true;
export const LOAD_ENTRY_PATH = '/load';

export function unavailableLoadRoute(path) {
  return !LOAD_INTERFACE_ENABLED && /^\/load(?:\/|$)/.test(path);
}
