import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  normalizeExternalPrBudgetReceiptKey,
  projectExternalPrWaitLedger,
  type ExternalPrWaitLedgerInput
} from '../src/external-pr-wait.ts';
import { sanitizeIssueInteractionEvent, type IssueInteractionEvent } from '../src/issue-interactions.ts';

const hashH = 'a'.repeat(64);
const hashJ = 'b'.repeat(64);
const key = (episode: string) => `sync:${episode}:mutation:result:changed`;

function receipt(episode: string, second: number, hash: string, overrides: Partial<IssueInteractionEvent> = {}) {
  return sanitizeIssueInteractionEvent({
    schemaVersion: 1, companyId: 'company-one', paperclipIssueId: 'issue-one',
    occurredAt: `2026-10-04T00:00:0${second}.000Z`, category: 'sync', action: 'update_issue',
    source: 'sync', outcome: 'changed', transition: { from: 'blocked', to: 'in_progress' },
    externalPullRequestStateHash: hash, dedupeKey: key(episode), ...overrides
  });
}

function project(events: IssueInteractionEvent[], previous: Partial<ExternalPrWaitLedgerInput> = {}) {
  return projectExternalPrWaitLedger({
    events, companyId: 'company-one', paperclipIssueId: 'issue-one',
    integrity: { malformedRows: 0, conflictingKeys: 0, scanTruncated: false }, ...previous
  });
}

const firstH = receipt('first-h', 0, hashH);
const nextJ = receipt('next-j', 1, hashJ);
const latestH = receipt('latest-h', 2, hashH);
const boundH = { previousUnblockedExternalStateHash: hashH, previousUnblockedReceiptDedupeKey: key('latest-h') };

test('budget receipt keys require bounded nonempty sync changed-mutation structure', () => {
  assert.equal(normalizeExternalPrBudgetReceiptKey(key('episode')), key('episode'));
  const longest = key('x'.repeat(227));
  assert.equal(longest.length, 256);
  assert.equal(normalizeExternalPrBudgetReceiptKey(longest), longest);
  for (const invalid of [undefined, null, 1, '', ' sync:one:mutation:result:changed',
    'sync::mutation:result:changed', 'sync:one::mutation:result:changed',
    'sync:one:mutation:result:noop', 'other:one:mutation:result:changed',
    key('line\nbreak'), `${key('episode')}\n`, key('null\u0000byte'), key('x'.repeat(228))]) {
    assert.equal(normalizeExternalPrBudgetReceiptKey(invalid), undefined);
  }
});

test('intact H to J to H history retains the exact latest earning receipt across row ordering', () => {
  const expected = { status: 'ready', unblockedExternalStateHash: hashH,
    unblockedReceiptDedupeKey: key('latest-h') };
  assert.deepEqual(project([firstH, nextJ, latestH], boundH), expected);
  assert.deepEqual(project([latestH, firstH, nextJ], boundH), expected);
});

test('whole latest H episode compaction cannot substitute an older matching H receipt', () => {
  const recovered = project([firstH, nextJ], boundH);
  assert.deepEqual(recovered, { status: 'hold', reason: 'missing_budget_receipt' });
});

test('declared missing or digest-mismatched earning receipt binding holds', () => {
  assert.equal(project([firstH, nextJ, latestH], {
    ...boundH, previousUnblockedReceiptDedupeKey: key('not-retained')
  }).reason, 'missing_budget_receipt');
  assert.equal(project([firstH, nextJ, latestH], {
    ...boundH, previousUnblockedReceiptDedupeKey: key('next-j')
  }).reason, 'missing_budget_receipt');
  assert.equal(project([firstH, nextJ, latestH], {
    previousUnblockedReceiptDedupeKey: key('latest-h')
  }).reason, 'malformed_budget_binding');
  for (const receiptOverride of [{ source: 'operator_action' as const }, { action: 'status_decision' as const },
    { outcome: 'failed' as const }, { transition: { from: 'todo', to: 'in_progress' } }]) {
    assert.equal(project([{ ...latestH, ...receiptOverride }], boundH).reason, 'missing_budget_receipt');
  }
});

test('malformed declared earning keys hold instead of becoming legacy absence', () => {
  for (const malformed of [null, 7, '', 'sync:bad:mutation:result:noop', key('a'.repeat(228))]) {
    assert.equal(project([latestH], { ...boundH, previousUnblockedReceiptDedupeKey: malformed })
      .reason, 'malformed_budget_binding');
  }
  assert.equal(project([receipt('valid', 0, hashH, { dedupeKey: 'not-a-sync-receipt' })])
    .reason, 'malformed_budget_receipt');
});

test('exact prior binding cannot escape its company or issue scope', () => {
  assert.equal(project([{ ...latestH, companyId: 'company-other' }], boundH).reason, 'scope_mismatch');
  assert.equal(project([{ ...latestH, paperclipIssueId: 'issue-other' }], boundH).reason, 'scope_mismatch');
});

test('legacy digest cache seeds a receipt key only when the final earning digest still matches', () => {
  const legacy = { previousUnblockedExternalStateHash: hashH };
  assert.deepEqual(project([firstH, nextJ, latestH], legacy), {
    status: 'ready', unblockedExternalStateHash: hashH, unblockedReceiptDedupeKey: key('latest-h')
  });
  assert.equal(project([firstH, nextJ], legacy).reason, 'ambiguous_legacy_budget_continuity');
  assert.equal(project([], legacy).reason, 'missing_budget_receipt');
});

test('confirmed later earning receipt advances only while the bound prior receipt remains retained', () => {
  const boundFirstH = { previousUnblockedExternalStateHash: hashH,
    previousUnblockedReceiptDedupeKey: key('first-h') };
  assert.deepEqual(project([firstH, nextJ], boundFirstH), {
    status: 'ready', unblockedExternalStateHash: hashJ, unblockedReceiptDedupeKey: key('next-j')
  });
  assert.equal(project([nextJ], boundFirstH).reason, 'missing_budget_receipt');
});

test('confirmed reset clears both fields only with retained exact prior earning evidence', () => {
  const reset = receipt('reset', 3, hashH, { transition: { from: 'in_progress', to: 'blocked' },
    externalPullRequestStateHash: undefined });
  assert.deepEqual(project([firstH, nextJ, latestH, reset], boundH), { status: 'ready' });
  assert.equal(project([firstH, reset], boundH).reason, 'missing_budget_receipt');
  assert.equal(project([latestH, reset], { previousUnblockedExternalStateHash: hashH })
    .reason, 'ambiguous_legacy_budget_continuity');
});

test('digestless confirmed unblock clears a bound budget but cannot silently clear a legacy cache', () => {
  const digestless = receipt('digestless', 3, hashH, { externalPullRequestStateHash: undefined });
  assert.deepEqual(project([latestH, digestless], boundH), { status: 'ready' });
  assert.equal(project([latestH, digestless], { previousUnblockedExternalStateHash: hashH })
    .reason, 'ambiguous_legacy_budget_continuity');
});

test('both worker registries preserve exact earning keys and declared-invalid holds after serialization', async () => {
  const { __testing: testing } = await import('../src/worker.ts');
  const normalizers = [
    { normalize: testing.normalizeImportRegistry, base: { mappingId: 'mapping-one', githubIssueId: 9,
      paperclipIssueId: 'issue-one', importedAt: '2026-10-04T00:00:00.000Z' } },
    { normalize: testing.normalizeRemoteActionRegistry, base: { key: 'direct-pr:company-one:issue-one' } }
  ];
  for (const { normalize, base } of normalizers) {
    const bound = { ...base, unblockedExternalStateHash: hashH, unblockedReceiptDedupeKey: key('latest-h') };
    const [saved] = normalize(JSON.parse(JSON.stringify(normalize([bound]))));
    assert.equal(saved?.unblockedExternalStateHash, hashH);
    assert.equal(saved?.unblockedReceiptDedupeKey, key('latest-h'));
    assert.equal(saved?.invalidBudgetBinding, undefined);
    for (const malformed of [null, 7, '', key('line\nbreak'), `${key('latest-h')}\n`]) {
      const [held] = normalize([{ ...bound, unblockedReceiptDedupeKey: malformed }]);
      assert.equal(held?.invalidBudgetBinding, true);
      assert.equal(normalize(JSON.parse(JSON.stringify([held])))[0]?.invalidBudgetBinding, true);
    }
    assert.equal(normalize([{ ...bound, unblockedExternalStateHash: undefined }])[0]?.invalidBudgetBinding, true);
    const [legacy] = normalize([{ ...bound, unblockedReceiptDedupeKey: undefined }]);
    assert.equal(legacy?.invalidBudgetBinding, undefined);
    assert.equal(legacy?.unblockedReceiptDedupeKey, undefined);
  }
});
