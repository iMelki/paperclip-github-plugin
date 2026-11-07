# Fresh-project import characterization

Tracking: [Paperclip #126](https://github.com/iMelki/paperclip/issues/126).
Source under test: secured plugin `2cff6ee7414ea6dcd4a8982aa5974781d213ce01`.

Run `pnpm test:import-contract` with the package's pinned Node/pnpm versions.
The default `pnpm test` now runs this command first, and hosted CI invokes that
default gate. The command also runs `scripts/verify-import-contract-gate.mjs`:
one isolated child must fail with exit 1 at the outer violation ledger after a
synthetic mutation attempt, then a fresh child must pass with exit 0. Neither
child contacts GitHub or a live Paperclip instance. Set no proof environment
variables in normal use; the runner scopes and removes its test-only toggle.
The fixture reuses `@paperclipai/plugin-sdk/testing`, the real worker, saved
registration settings, and the public `sync.runNow` action. All GitHub responses
and secrets are synthetic; it never contacts a live host or account.

## Observed behavior

- Company/project scope excludes a mapping belonging to another project.
- One fresh repository mapping imports one fixture issue. The second run creates
  zero issues and preserves the original Paperclip issue ID.
- Two mappings in that same project import two fixture issues. Project scope is
  **not** an exact-repository selector or maximum-one-import control.
- In these fresh, unassigned, non-maintainer, no-PR fixtures, backlog defaults
  remain unassigned, no wakeups occur, and GitHub calls are reads only. The fixture
  rejects unexpected origins, repository paths, HTTP methods and GraphQL mutations.
  An outer violation ledger catches forbidden attempts even if the worker catches
  their exceptions. A deliberately denied mutation proves that assertion fails.
  Read-only GraphQL queries use POST; the boundary is no mutation, not no POST.

## What this does not prove

This is characterization, not a production safety mode or host integration test.
There is no `importOnly`, `maxIssues`, `noDispatch` or `dryRun` argument in the
reviewed action. Existing issues can carry assignments or pending wakeups, and
maintainer-authored issues can bypass backlog defaults. The SDK fixture is not
proof that the real host has no implicit dispatch behavior.

Do not use this result to authorize a live broad sync. Before the bounded live
trial, independently qualify the exact host/artifact, recovery path, exact single
mapping, input bound, no-dispatch and no-GitHub-write boundaries. Capture stable
IDs and a fresh readback after both runs. Broader repository rollout and GitHub
Projects permissions remain separate work.

The ordinary minute-scheduled sync can later activate imported work. A mutex
around one import action is not a durable no-dispatch boundary. The live pilot
still needs a persisted, company-scoped quarantine covering every scheduled,
manual, retry, full-sync and wake path with independently proven release/races.

## Validation

2026-09-18: Node 24.21.0, two fixture cases and one negative control passed. Production worker code is
unchanged. This receipt does not certify a live migration, installation or import.
