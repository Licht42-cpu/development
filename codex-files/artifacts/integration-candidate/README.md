# Integration candidate evidence

Code candidate: `de9e5d76e576ec1d6334ffe14fabd465fbf53fab`.
See `docs/integration-candidate.md` for ownership, routes, findings and limits.

- `summary.json`: deduplicated suite inventory and separate outcome categories.
- `shared-regression.txt`: complete shared invocation before the last handoff
  case; final affected-suite logs are named `final-*.txt`.
- `expected-*.txt`: the two deliberately broken route/note protections.
- `record-checks.txt`: validator tests, not handset tests.
- `qualification-record.json`: exact candidate/APK binding and 16 UNRUN cases.
- `assemble-debug.txt`, `cap-sync.txt`: actual local native build/copy evidence.
- `claude-observations.json`: read-only creation-form options, with no writes.
- `screenshots/`: browser fixtures at actual 390/430/1280 widths. All contacts,
  addresses, access codes and stock figures in these captures are labeled
  synthetic fixtures, not production/customer data.

No APK binary is committed or published. No database/provider/device result is
implied by these browser and build logs. Source provenance is separately listed
in `codex-files/handoffs/integration-source.json`.
