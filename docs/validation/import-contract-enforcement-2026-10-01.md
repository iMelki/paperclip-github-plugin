# Import characterization enforcement

Tracking: [Paperclip #126](https://github.com/iMelki/paperclip/issues/126).
Dependency: [plugin PR #5](https://github.com/iMelki/paperclip-github-plugin/pull/5),
exact base `c9ecbd97d3893d8acd2bb658df4c4b378c724ca6`.

## Change and boundaries

The existing synthetic characterization now runs first in default `pnpm test`.
CI calls that default command. A shell-free, windowless child runner proves that
a deliberately swallowed GraphQL mutation error still fails the outer ledger at
exit 1, then proves a fresh restored child exits 0. Child errors, timeout,
signals, unexpected exit codes and wrong failure attribution fail the runner.
The runner also checks the default-command prefix and CI invocation so these
callers cannot silently omit characterization while the dedicated gate is run.

This reuses PR #5's SDK harness, real worker and fixture. Production source,
manifest, credentials, live host, installation, scheduler and sync settings are
unchanged. It is not live import-only/no-dispatch proof or Factory qualification.

## Local validation

- Private Node `24.21.0`; existing pnpm `12.4.1` invoked via its JS entrypoint.
- Frozen dependency install passed in 9.6 seconds; no lockfile changes.
- `pnpm test:import-contract`: 3/3 passed, zero skips; broken child exit 1 with
  `forbidden GitHub request attempt`, restored child exit 0.
- `pnpm typecheck`: exit 0; `pnpm build`: exit 0.
- Remaining four TypeScript test files: 368/368 passed, zero skips, 31.7 seconds.
- Default `pnpm test` executed characterization/proof, then its build-script
  suite passed 6/7 and failed the pre-existing CRLF-only assertion in
  `tests/build-script.spec.mjs:151`. [PR #4](https://github.com/iMelki/paperclip-github-plugin/pull/4)
  repairs this separately; this patch does not copy that theme or claim full green.
- `git diff --check` and proof-runner JS syntax check passed.
- RAM sampled before remaining suite: 80.9% used (admission ceiling 90%).

Node ZIP provenance: official
[Node distribution](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt),
`node-v24.21.0-win-x64.zip` SHA-256
`158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`.
Checksum verified before extraction. No global runtime/package-manager changes.

Local logs: `C:\Dev\paperclip-plugin-proof-logs-20261001\`:
`install.log`, `import-contract-final.log`, `typecheck.log`, `test.log`,
`remaining-suite.log`, `build.log`. Negative proof is recorded in
`.gate-evidence.json`; child failure and restored-pass output are in the logs.

## Hosted evidence gap

Read-only GitHub APIs reported Actions enabled, allowed actions `all`, active CI
and Release workflows, and zero workflow runs. PR #4/#5 remain open, without
submitted reviews or hosted test/build evidence; neutral quota-exceeded Bugbot
is not validation. Current data does **not** establish why historical runs are
absent. No broad reruns, Actions permission edits, credentials or billing changes
were attempted. A fresh dependent PR event is a bounded trigger observation;
its actual run/check readback, not workflow-file presence, decides hosted proof.

[GitHub workflow trigger documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
supports using `pull_request` and the default command; the existing CI declares
unfiltered `pull_request` and push on `main`.

## Remaining rollout gates

Independent exact-head review and hosted validation are still needed. PR #4's
Windows fix must be considered separately. Before any live import, #126 still
requires qualified host/recovery, a company-scoped persisted quarantine covering
scheduled/manual/retry/full-sync and wake paths, explicit release/fencing tests,
and an exact-one idempotent unassigned/backlog import with no GitHub mutations.
The minute scheduled pass makes an import-action mutex insufficient.
