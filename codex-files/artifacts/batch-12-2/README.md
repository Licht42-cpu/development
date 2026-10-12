# Batch 12.2 evidence

The implementation/handoff is `tests/field-dispatch.md` on
`codex/batch-12-2`, based on `c8666dd`. Contract/fixture source: Claude
`b21d082`; assignment: `7a27bb3`. No branches merged.

- `verification.json`: final counts, unrun categories and scope.
- `results.json`, `field-dispatch.log`: 45 new browser checks.
- Other suite logs: 391 registered + 290 existing standalone checks, plus
  geofence. Total 726 counted local checks, no final normal failure/skip.
- `fault-secrets-*` / `fault-secrets.log`: declared negative probe, one
  expected failure; excluded from passing counts.
- `dispatch-*`, `zones-*`, `actions-*`: 12 screenshots at actual
  390/430/1280 widths, inspected. Fixture data is synthetic.
- `cap-sync.log`, `verify-mobile.log`, `assemble-debug.log`,
  `apk-assets.json`, `debug-signature.log`: local packaging/debug build;
  all staged files verified against the APK. No APK binary published.
- `protected-files.txt`: unchanged owner/integration boundaries.

Browser fixtures and a compiled APK are not backend, delivery, emulator or
physical-device proof. Those outcomes are explicitly unrun in the handoff.
The assembly log's trailing whitespace is normalized; its task output and
result are otherwise unchanged.
