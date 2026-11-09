import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  buildExternalPullRequestStateHash,
  buildSyncInteractionEvent,
  normalizeExternalPullRequestStateHash,
  projectExternalPrWaitLedger,
  resolveUnblockedExternalStateHash,
  shouldPreserveDeliberateBlockedWait,
  type ExternalPullRequestState
} from '../src/external-pr-wait.ts';
import { sanitizeIssueInteractionEvent, type IssueInteractionEvent } from '../src/issue-interactions.ts';

let workerImportSerial = 0;

async function importFreshWorkerModule() {
  workerImportSerial += 1;
  const workerModuleUrl = new URL(`../src/worker.ts?worker-test=${workerImportSerial}`, import.meta.url);
  return await import(workerModuleUrl.href);
}

test('sync keeps completed healthy PR waits unassigned instead of restarting internal review', async () => {
  const workerModule = await importFreshWorkerModule();
  const syncContext = {
    assignee: { kind: 'agent', id: 'engineer-agent' },
    executionPolicy: {
      stages: [
        {
          id: 'architect-review',
          type: 'review',
          participants: [{ kind: 'agent', id: 'architect-agent' }]
        }
      ]
    },
    executionState: null
  };
  const advancedSettings = {
    defaultStatus: 'backlog',
    ignoredIssueAuthorUsernames: []
  };

  assert.equal(
    workerModule.__testing.isHealthyMaintainerWaitTransition({
      currentStatus: 'done',
      nextStatus: 'in_review',
      syncContext
    }),
    true
  );
  assert.equal(
    workerModule.__testing.resolveSyncTransitionAssignee({
      currentStatus: 'done',
      nextStatus: 'in_review',
      syncContext,
      advancedSettings
    }),
    null
  );
});

test('issue-linked remote fingerprints distinguish waiting from action-required', async () => {
  const workerModule = await importFreshWorkerModule();
  const pullRequest = (mergeStateStatus: 'unknown' | 'behind') => ({
    number: 88,
    repositoryUrl: 'https://github.com/paperclipai/example-repo',
    headSha: 'same-head',
    hasUnresolvedReviewThreads: false,
    ciState: 'unfinished',
    mergeability: 'mergeable',
    mergeStateStatus,
    reviewDecision: 'review_required'
  });
  const links = [{
    data: {
      repositoryUrl: 'https://github.com/paperclipai/example-repo',
      githubPullRequestNumber: 88,
      followThroughAssigneeAgentId: 'owner-88'
    }
  }];
  const snapshot = (linkedPullRequest: ReturnType<typeof pullRequest>) => ({
    issueNumber: 7,
    state: 'open',
    commentCount: 0,
    linkedPullRequests: [linkedPullRequest]
  });
  const waitingSnapshot = snapshot(pullRequest('unknown'));
  const actionableSnapshot = snapshot(pullRequest('behind'));
  const waitingGate = workerModule.__testing.selectEffectiveIssueLinkedPullRequestGate(
    waitingSnapshot.linkedPullRequests as never, [], false, links as never
  );
  const actionableGate = workerModule.__testing.selectEffectiveIssueLinkedPullRequestGate(
    actionableSnapshot.linkedPullRequests as never, [], false, links as never
  );

  assert.equal(waitingGate?.remoteCondition, 'waiting');
  assert.equal(actionableGate?.remoteCondition, 'action_required');
  assert.notEqual(
    workerModule.__testing.buildRemoteActionFingerprint(waitingSnapshot as never, waitingGate as never),
    workerModule.__testing.buildRemoteActionFingerprint(actionableSnapshot as never, actionableGate as never),
    'an actionable behind PR must re-arm issue-linked routing'
  );
});

test('issue-linked effective gate aligns status, owner, fingerprint, and wake routing', async () => {
  const workerModule = await importFreshWorkerModule();
  const pullRequest = (number: number, repositoryUrl = 'https://github.com/paperclipai/example-repo') => ({
    number,
    repositoryUrl,
    headSha: `head-${number}`,
    hasUnresolvedReviewThreads: false,
    ciState: 'green',
    mergeability: 'mergeable',
    mergeStateStatus: 'clean',
    reviewDecision: 'review_required'
  });
  const pullRequests = [pullRequest(10), pullRequest(20)];
  const sources = [{
    repositoryUrl: 'HTTPS://GITHUB.COM/paperclipai/example-repo/',
    number: 20,
    kind: 'top_level' as const
  }];
  const links = pullRequests.map((entry) => ({
    data: {
      repositoryUrl: entry.repositoryUrl,
      githubPullRequestNumber: entry.number,
      followThroughAssigneeAgentId: `owner-${entry.number}`
    }
  }));
  const gate = workerModule.__testing.selectEffectiveIssueLinkedPullRequestGate(
    pullRequests as never,
    sources,
    false,
    links as never
  );
  const reversedGate = workerModule.__testing.selectEffectiveIssueLinkedPullRequestGate(
    [...pullRequests].reverse() as never,
    sources,
    false,
    [...links].reverse() as never
  );
  assert.deepEqual(reversedGate, gate);
  assert.equal(gate?.number, 20);
  assert.equal(gate?.ownerCandidate, 'owner-20');

  const snapshot = {
    issueNumber: 7,
    state: 'open',
    commentCount: 1,
    linkedPullRequests: pullRequests
  };
  const status = workerModule.__testing.resolvePaperclipIssueStatus({
    currentStatus: 'in_review',
    snapshot,
    effectiveGate: gate,
    hasTrustedNewComment: true,
    wasImportedThisRun: false,
    defaultImportedStatus: 'backlog',
    hasExecutorHandoffTarget: Boolean(gate?.ownerCandidate)
  } as never);
  assert.equal(status, 'in_progress');
  assert.deepEqual(workerModule.__testing.resolveSyncTransitionAssignee({
    currentStatus: 'in_review',
    nextStatus: status,
    syncContext: { assignee: null, executionPolicy: null, executionState: null },
    advancedSettings: { defaultStatus: 'backlog', ignoredIssueAuthorUsernames: [] },
    followThroughAssigneeAgentId: gate?.ownerCandidate
  } as never), {
    principal: { kind: 'agent', id: 'owner-20' },
    role: 'executor'
  });
  assert.equal(
    workerModule.__testing.buildRemoteActionFingerprint(snapshot as never, gate as never),
    workerModule.__testing.buildRemoteActionFingerprint({
      ...snapshot,
      linkedPullRequests: [...pullRequests].reverse()
    } as never, reversedGate as never)
  );
});

test('sync preserves blocked maintainer approval waits for green mergeable pull requests', async () => {
  const workerModule = await importFreshWorkerModule();
  const testing = workerModule.__testing as typeof workerModule.__testing & {
    resolvePaperclipPullRequestIssueStatus?: (params: {
      currentStatus: string;
      pullRequest: {
        number: number;
        repositoryUrl: string;
        hasUnresolvedReviewThreads: boolean;
        ciState: string;
        mergeability: string;
        mergeStateStatus: string;
        reviewDecision: string;
      };
      hasExecutorHandoffTarget?: boolean;
    }) => string;
  };

  assert.equal(typeof testing.resolvePaperclipPullRequestIssueStatus, 'function');

  const basePullRequest = {
    number: 1305,
    repositoryUrl: 'https://github.com/micronaut-projects/micronaut-gradle-plugin',
    hasUnresolvedReviewThreads: false,
    ciState: 'green',
    mergeability: 'mergeable',
    mergeStateStatus: 'blocked',
    reviewDecision: 'review_required'
  };

  assert.equal(
    testing.resolvePaperclipPullRequestIssueStatus({
      currentStatus: 'blocked',
      pullRequest: basePullRequest
    }),
    'blocked'
  );

  assert.equal(
    testing.resolvePaperclipPullRequestIssueStatus({
      currentStatus: 'blocked',
      pullRequest: {
        ...basePullRequest,
        reviewDecision: 'unknown'
      }
    }),
    'blocked'
  );
});

test('sync still routes blocked pull requests with actionable PR work to an executor', async () => {
  const workerModule = await importFreshWorkerModule();
  const testing = workerModule.__testing as typeof workerModule.__testing & {
    resolvePaperclipPullRequestIssueStatus?: (params: {
      currentStatus: string;
      pullRequest: {
        number: number;
        repositoryUrl: string;
        hasUnresolvedReviewThreads: boolean;
        ciState: string;
        mergeability: string;
        mergeStateStatus: string;
        reviewDecision: string;
      };
      hasExecutorHandoffTarget?: boolean;
    }) => string;
  };

  assert.equal(typeof testing.resolvePaperclipPullRequestIssueStatus, 'function');

  const basePullRequest = {
    number: 1305,
    repositoryUrl: 'https://github.com/micronaut-projects/micronaut-gradle-plugin',
    hasUnresolvedReviewThreads: false,
    ciState: 'green',
    mergeability: 'mergeable',
    mergeStateStatus: 'blocked',
    reviewDecision: 'review_required'
  };

  assert.equal(
    testing.resolvePaperclipPullRequestIssueStatus({
      currentStatus: 'blocked',
      pullRequest: {
        ...basePullRequest,
        ciState: 'red'
      },
      hasExecutorHandoffTarget: true
    }),
    'in_progress'
  );

  assert.equal(
    testing.resolvePaperclipPullRequestIssueStatus({
      currentStatus: 'blocked',
      pullRequest: {
        ...basePullRequest,
        mergeability: 'conflicting',
        mergeStateStatus: 'dirty'
      },
      hasExecutorHandoffTarget: true
    }),
    'in_progress'
  );

  assert.equal(
    testing.resolvePaperclipPullRequestIssueStatus({
      currentStatus: 'blocked',
      pullRequest: {
        ...basePullRequest,
        hasUnresolvedReviewThreads: true
      },
      hasExecutorHandoffTarget: true
    }),
    'in_progress'
  );
});

test('remote action fingerprints ignore transient raw UNKNOWN jitter that preserves the effective action', async () => {
  const workerModule = await importFreshWorkerModule();
  const testing = workerModule.__testing as typeof workerModule.__testing & {
    buildRemoteActionFingerprint?: (snapshot: Record<string, unknown>) => string;
  };
  assert.equal(typeof testing.buildRemoteActionFingerprint, 'function');

  const basePullRequest = {
    number: 77,
    repositoryUrl: 'https://github.com/paperclipai/example-repo',
    headSha: 'a'.repeat(40),
    hasUnresolvedReviewThreads: false,
    ciState: 'unfinished',
    mergeability: 'unknown',
    mergeStateStatus: 'unknown',
    reviewDecision: 'unknown'
  };
  const baseSnapshot = {
    issueNumber: 7,
    state: 'open',
    commentCount: 10,
    linkedPullRequests: [basePullRequest]
  };

  const first = testing.buildRemoteActionFingerprint!(baseSnapshot);
  const rawJitter = testing.buildRemoteActionFingerprint!({
    ...baseSnapshot,
    commentCount: 999,
    linkedPullRequests: [{
      ...basePullRequest,
      mergeability: 'mergeable',
      mergeStateStatus: 'unknown',
      reviewDecision: 'review_required'
    }]
  });
  assert.equal(rawJitter, first);

  const actionableChange = testing.buildRemoteActionFingerprint!({
    ...baseSnapshot,
    linkedPullRequests: [{ ...basePullRequest, ciState: 'red' }]
  });
  assert.notEqual(actionableChange, first);
});

test('comment-count journal inputs are canonical across linked pull request order', async () => {
  const workerModule = await importFreshWorkerModule();
  const testing = workerModule.__testing as typeof workerModule.__testing & {
    canonicalizeGitHubPullRequestCommentCounts?: (records: Array<{
      number: number;
      repositoryUrl: string;
      topLevelCommentCount: number;
      reviewCommentCount: number;
    }>) => Array<Record<string, unknown>>;
  };
  assert.equal(typeof testing.canonicalizeGitHubPullRequestCommentCounts, 'function');

  const first = {
    number: 81,
    repositoryUrl: 'https://github.com/paperclipai/zeta',
    topLevelCommentCount: 3,
    reviewCommentCount: 2
  };
  const second = {
    number: 12,
    repositoryUrl: 'https://github.com/paperclipai/alpha',
    topLevelCommentCount: 5,
    reviewCommentCount: 1
  };

  assert.deepEqual(
    testing.canonicalizeGitHubPullRequestCommentCounts!([first, second]),
    testing.canonicalizeGitHubPullRequestCommentCounts!([second, first])
  );
});

test('remote action fingerprints ignore lower-priority sibling PR changes masked by the effective action', async () => {
  const workerModule = await importFreshWorkerModule();
  const testing = workerModule.__testing as typeof workerModule.__testing & {
    buildRemoteActionFingerprint?: (snapshot: Record<string, unknown>) => string;
    buildDirectPullRequestActionFingerprint?: (snapshots: Array<Record<string, unknown>>) => string;
  };
  assert.equal(typeof testing.buildDirectPullRequestActionFingerprint, 'function');

  const conflict = {
    number: 80,
    repositoryUrl: 'https://github.com/paperclipai/example-repo',
    headSha: 'a'.repeat(40),
    hasUnresolvedReviewThreads: false,
    ciState: 'green',
    mergeability: 'conflicting',
    mergeStateStatus: 'dirty',
    reviewDecision: 'review_required'
  };
  const waiting = {
    number: 81,
    repositoryUrl: 'https://github.com/paperclipai/example-repo',
    headSha: 'b'.repeat(40),
    hasUnresolvedReviewThreads: false,
    ciState: 'unfinished',
    mergeability: 'unknown',
    mergeStateStatus: 'unknown',
    reviewDecision: 'unknown'
  };
  const issueSnapshot = {
    issueNumber: 8,
    state: 'open',
    commentCount: 0,
    linkedPullRequests: [conflict, waiting]
  };
  const issueFingerprint = testing.buildRemoteActionFingerprint!(issueSnapshot);
  assert.equal(testing.buildRemoteActionFingerprint!({
    ...issueSnapshot,
    linkedPullRequests: [conflict, { ...waiting, headSha: 'c'.repeat(40), ciState: 'green', mergeability: 'mergeable' }]
  }), issueFingerprint);

  const toDirect = (pullRequest: Record<string, unknown>) => ({
    pullRequestLink: { data: { githubPullRequestNumber: pullRequest.number } },
    repository: { url: pullRequest.repositoryUrl },
    lifecycleState: 'open',
    pullRequest
  });
  const directFingerprint = testing.buildDirectPullRequestActionFingerprint!([toDirect(conflict), toDirect(waiting)]);
  assert.equal(testing.buildDirectPullRequestActionFingerprint!([
    toDirect(conflict),
    toDirect({ ...waiting, headSha: 'd'.repeat(40), ciState: 'green', mergeability: 'mergeable' })
  ]), directFingerprint);
});

test('remote action registry normalization deduplicates and deterministically caps records while retaining pending wakes', async () => {
  const workerModule = await importFreshWorkerModule();
  const testing = workerModule.__testing as typeof workerModule.__testing & {
    normalizeRemoteActionRegistry?: (value: unknown) => Array<Record<string, unknown>>;
  };
  assert.equal(typeof testing.normalizeRemoteActionRegistry, 'function');

  const digest = 'a'.repeat(64);
  const records: Array<Record<string, unknown>> = Array.from({ length: 300 }, (_, index) => ({
    key: `direct-pr:company:${String(index).padStart(3, '0')}`,
    fingerprint: digest
  }));
  records[0]!.linkedPullRequestCommentCounts = Array.from({ length: 300 }, (_, index) => ({
    number: index + 1,
    repositoryUrl: 'https://github.com/paperclipai/example-repo',
    topLevelCommentCount: index,
    reviewCommentCount: index
  }));
  records.push({
    key: 'direct-pr:company:299',
    fingerprint: 'b'.repeat(64),
    pendingWake: {
      fingerprint: 'b'.repeat(64),
      assigneeAgentId: 'agent-1',
      reason: 'retry wake',
      mutation: 'status_transition',
      nextStatus: 'in_progress'
    }
  });

  const normalized: Array<Record<string, unknown>> = testing.normalizeRemoteActionRegistry!(records);
  assert.equal(normalized.length, 256);
  assert.equal(new Set(normalized.map((entry: Record<string, unknown>) => entry.key)).size, normalized.length);
  assert.ok(normalized.some((entry: Record<string, unknown>) => entry.key === 'direct-pr:company:299' && entry.pendingWake));
  assert.equal(
    (normalized.find((entry: Record<string, unknown>) => entry.key === 'direct-pr:company:000')
      ?.linkedPullRequestCommentCounts as unknown[]).length,
    128
  );
  assert.deepEqual(
    normalized.map((entry: Record<string, unknown>) => entry.key),
    [...normalized.map((entry: Record<string, unknown>) => entry.key)].sort((left, right) => String(left).localeCompare(String(right)))
  );

  const overCapacityPending = Array.from({ length: 257 }, (_, index) => ({
    key: `direct-pr:company:pending-${String(index).padStart(3, '0')}`,
    pendingWake: {
      fingerprint: digest,
      assigneeAgentId: `agent-${index}`,
      reason: 'retry wake',
      mutation: 'status_transition',
      nextStatus: 'in_progress'
    }
  }));
  assert.throws(
    () => testing.normalizeRemoteActionRegistry!(overCapacityPending),
    /contains 257 pending wakes; maximum is 256/
  );
});

test('import registry normalization discards malformed legacy remote action state', async () => {
  const workerModule = await importFreshWorkerModule();
  const testing = workerModule.__testing as typeof workerModule.__testing & {
    normalizeImportRegistry?: (value: unknown) => Array<Record<string, unknown>>;
  };
  assert.equal(typeof testing.normalizeImportRegistry, 'function');

  const [record] = testing.normalizeImportRegistry!([{
    mappingId: 'mapping-legacy',
    githubIssueId: 9,
    paperclipIssueId: 'issue-legacy',
    importedAt: '2026-01-01T00:00:00.000Z',
    remoteActionFingerprint: 'not-a-digest',
    pendingRemoteActionWake: {
      fingerprint: 'also-invalid',
      assigneeAgentId: '',
      reason: 42
    }
  }]);

  assert.equal(record?.remoteActionFingerprint, undefined);
  assert.equal(record?.pendingRemoteActionWake, undefined);
});

const externalPullRequest: ExternalPullRequestState = {
  repositoryUrl: 'https://github.com/paperclipai/example-repo',
  number: 8,
  lifecycleState: 'open',
  headSha: 'a'.repeat(40),
  mergeability: 'mergeable',
  mergeStateStatus: 'clean',
  ciState: 'green',
  hasUnresolvedReviewThreads: false,
  reviewDecision: 'approved'
};
const externalStateHash = 'a'.repeat(64);
const ledgerIntegrity = { malformedRows: 0, conflictingKeys: 0, scanTruncated: false };

function confirmedReceipt(overrides: Partial<IssueInteractionEvent> = {}): IssueInteractionEvent {
  return sanitizeIssueInteractionEvent({
    schemaVersion: 1,
    companyId: 'company-one',
    paperclipIssueId: 'issue-one',
    occurredAt: '2026-10-04T00:00:00.000Z',
    category: 'sync',
    action: 'update_issue',
    source: 'sync',
    outcome: 'changed',
    dedupeKey: 'sync:one:mutation:result:changed',
    transition: { from: 'blocked', to: 'in_progress' },
    externalPullRequestStateHash: externalStateHash,
    ...overrides,
    ...((overrides.outcome && overrides.outcome !== 'changed')
      || (overrides.action && overrides.action !== 'update_issue')
      ? { externalPullRequestStateHash: undefined } : {})
  });
}

function projectLedger(events: IssueInteractionEvent[], integrity = ledgerIntegrity) {
  return projectExternalPrWaitLedger({
    events, companyId: 'company-one', paperclipIssueId: 'issue-one', integrity
  });
}

test('external PR state hashes bind eight structural fields plus lifecycle and ignore input order', () => {
  const sibling = { ...externalPullRequest, number: 9 };
  const first = buildExternalPullRequestStateHash([externalPullRequest, sibling]);
  assert.match(first!, /^[a-f0-9]{64}$/);
  assert.equal(first, buildExternalPullRequestStateHash([sibling, externalPullRequest]));
  assert.equal(buildExternalPullRequestStateHash([]), undefined);
  const changes: Array<Partial<ExternalPullRequestState>> = [
    { repositoryUrl: 'https://github.com/paperclipai/another-repo' }, { number: 10 },
    { lifecycleState: 'closed' }, { headSha: 'b'.repeat(40) }, { mergeability: 'conflicting' },
    { mergeStateStatus: 'dirty' }, { ciState: 'red' }, { hasUnresolvedReviewThreads: true },
    { reviewDecision: 'changes_requested' }
  ];
  for (const changed of changes) {
    assert.notEqual(buildExternalPullRequestStateHash([{ ...externalPullRequest, ...changed }, sibling]), first);
  }
  assert.equal(normalizeExternalPullRequestStateHash(externalStateHash), externalStateHash);
  for (const malformed of ['', 'bad', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 3, null]) {
    assert.equal(normalizeExternalPullRequestStateHash(malformed), undefined);
  }
});

test('a spent blocked wait preserves only the same external input without a trusted follow-up', () => {
  const input = {
    currentStatus: 'blocked', nextStatus: 'in_progress', hasTrustedComment: false,
    hasPullRequests: true, unblockedExternalStateHash: externalStateHash, externalStateHash
  };
  assert.equal(shouldPreserveDeliberateBlockedWait(input), true);
  assert.equal(shouldPreserveDeliberateBlockedWait({ ...input, hasTrustedComment: true }), false);
  assert.equal(shouldPreserveDeliberateBlockedWait({ ...input, hasPullRequests: false }), false);
  assert.equal(shouldPreserveDeliberateBlockedWait({ ...input, externalStateHash: 'b'.repeat(64) }), false);
  assert.equal(shouldPreserveDeliberateBlockedWait({ ...input, unblockedExternalStateHash: undefined }), false);
  assert.equal(shouldPreserveDeliberateBlockedWait({ ...input, currentStatus: 'in_progress' }), false);
  assert.equal(shouldPreserveDeliberateBlockedWait({ ...input, nextStatus: 'blocked' }), false);
});

test('unblock budgets reset on entering blocked and survive staying blocked', () => {
  const input = { currentStatus: 'blocked', nextStatus: 'in_progress', externalStateHash,
    previousUnblockedExternalStateHash: 'b'.repeat(64) };
  assert.equal(resolveUnblockedExternalStateHash(input), externalStateHash);
  assert.equal(resolveUnblockedExternalStateHash({ ...input, currentStatus: 'in_progress', nextStatus: 'blocked' }), undefined);
  assert.equal(resolveUnblockedExternalStateHash({ ...input, nextStatus: 'blocked' }), 'b'.repeat(64));
});

test('the canonical interaction schema preserves declared hashes and rejects malformed hashes', () => {
  assert.equal(confirmedReceipt().externalPullRequestStateHash, externalStateHash);
  const legacy = confirmedReceipt({ externalPullRequestStateHash: undefined });
  assert.equal(Object.hasOwn(legacy, 'externalPullRequestStateHash'), false);
  const eventInput = { companyId: 'company-one', issueId: 'issue-one', occurredAt: '2026-10-04T00:00:00.000Z',
    currentStatus: 'blocked', nextStatus: 'in_progress', dedupeKey: 'sync:one:mutation:intent',
    externalPullRequestStateHash: externalStateHash, action: 'update_issue' as const };
  assert.equal(buildSyncInteractionEvent({ ...eventInput, outcome: 'observed' }).externalPullRequestStateHash, undefined);
  assert.equal(buildSyncInteractionEvent({ ...eventInput, outcome: 'changed' }).externalPullRequestStateHash, externalStateHash);
  assert.equal(buildSyncInteractionEvent({ ...eventInput, outcome: 'failed' }).externalPullRequestStateHash, undefined);
  for (const misplaced of [{ outcome: 'observed' }, { action: 'status_decision' }, { source: 'operator_action' }]) {
    assert.throws(() => sanitizeIssueInteractionEvent({ ...confirmedReceipt(), ...misplaced } as IssueInteractionEvent),
      /externalPullRequestStateHash/);
  }
  for (const malformed of ['', 'bad', 'a'.repeat(63), 'a'.repeat(65), 3, null]) {
    assert.throws(() => sanitizeIssueInteractionEvent({
      ...confirmedReceipt(), externalPullRequestStateHash: malformed
    } as IssueInteractionEvent), /externalPullRequestStateHash/);
  }
});

test('confirmed unblock receipts recover only in their company and issue scope', () => {
  assert.equal(projectLedger([confirmedReceipt()]).unblockedExternalStateHash, externalStateHash);
  assert.equal(projectLedger([confirmedReceipt({ companyId: 'company-other' })]).unblockedExternalStateHash, undefined);
  assert.equal(projectLedger([confirmedReceipt({ companyId: 'company-other' })]).status, 'hold');
  assert.equal(projectLedger([confirmedReceipt({ paperclipIssueId: 'issue-other' })]).unblockedExternalStateHash, undefined);
  assert.equal(projectLedger([confirmedReceipt({ paperclipIssueId: 'issue-other' })]).status, 'hold');
  assert.equal(projectLedger([confirmedReceipt({ externalPullRequestStateHash: undefined })]).unblockedExternalStateHash, undefined);
  assert.equal(projectLedger([confirmedReceipt({ transition: undefined })]).unblockedExternalStateHash, undefined);
  const reset = confirmedReceipt({ dedupeKey: 'sync:two:mutation:result:changed',
    occurredAt: '2026-10-04T00:00:01.000Z', transition: { from: 'in_progress', to: 'blocked' } });
  assert.equal(projectLedger([reset, confirmedReceipt()]).unblockedExternalStateHash, undefined);
  const digestless = confirmedReceipt({ ...reset, transition: { from: 'blocked', to: 'in_progress' },
    externalPullRequestStateHash: undefined });
  assert.equal(projectLedger([confirmedReceipt(), digestless]).unblockedExternalStateHash, undefined);
  assert.equal(projectLedger([reset, confirmedReceipt({ occurredAt: reset.occurredAt })]).status, 'hold');
  const cached = { companyId: 'company-one', paperclipIssueId: 'issue-one', integrity: ledgerIntegrity,
    previousUnblockedExternalStateHash: externalStateHash };
  assert.equal(projectExternalPrWaitLedger({ ...cached, events: [] }).reason, 'missing_budget_receipt');
  assert.equal(projectExternalPrWaitLedger({ ...cached, events: [confirmedReceipt()] }).status, 'ready');
  assert.equal(projectExternalPrWaitLedger({ ...cached, events: [confirmedReceipt(), reset] }).status, 'hold');
  assert.equal(projectExternalPrWaitLedger({ ...cached, events: [confirmedReceipt(), reset] })
    .reason, 'ambiguous_legacy_budget_continuity');
});

test('incomplete or conflicting ledgers and unsettled intents never earn an unblock budget', () => {
  for (const integrity of [
    { ...ledgerIntegrity, malformedRows: 1 }, { ...ledgerIntegrity, conflictingKeys: 1 },
    { ...ledgerIntegrity, scanTruncated: true }
  ]) assert.equal(projectLedger([confirmedReceipt()], integrity).status, 'hold');
  const receipt = confirmedReceipt();
  assert.equal(projectLedger([receipt, { ...receipt, externalPullRequestStateHash: 'b'.repeat(64) }]).status, 'hold');
  const intent = confirmedReceipt({ outcome: 'observed', dedupeKey: 'sync:one:mutation:intent' });
  const failed = confirmedReceipt({ outcome: 'failed', dedupeKey: 'sync:one:mutation:result:failed' });
  assert.equal(projectLedger([intent]).status, 'hold');
  assert.equal(projectLedger([intent, failed]).status, 'hold');
  assert.equal(projectLedger([intent, failed]).unblockedExternalStateHash, undefined);
  assert.equal(projectLedger([intent, receipt]).status, 'ready');
  assert.equal(projectLedger([intent, receipt]).unblockedExternalStateHash, externalStateHash);
  assert.deepEqual(projectLedger([receipt, intent]), projectLedger([intent, receipt]));
  const noop = confirmedReceipt({ outcome: 'noop', dedupeKey: 'sync:one:mutation:result:noop' });
  assert.equal(projectLedger([intent, noop]).status, 'ready');
  assert.equal(projectLedger([intent, noop]).unblockedExternalStateHash, undefined);
  const commentIntent = confirmedReceipt({ action: 'add_issue_comment', category: 'comment',
    outcome: 'observed', dedupeKey: 'sync:one:comment:intent' });
  assert.equal(projectLedger([commentIntent]).status, 'hold');
});

test('both worker registry normalizers retain unblock budgets through serialization and reject malformed values', async () => {
  const { __testing: testing } = await importFreshWorkerModule();
  const normalizers = [
    { normalize: testing.normalizeImportRegistry, record: {
      mappingId: 'mapping-one', githubIssueId: 9, paperclipIssueId: 'issue-one',
      importedAt: '2026-10-04T00:00:00.000Z', unblockedExternalStateHash: externalStateHash
    } },
    { normalize: testing.normalizeRemoteActionRegistry, record: {
      key: 'direct-pr:company-one:issue-one', fingerprint: externalStateHash,
      unblockedExternalStateHash: externalStateHash
    } }
  ];
  for (const { normalize, record } of normalizers) {
    const normalized = normalize([record]);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0]?.unblockedExternalStateHash, externalStateHash);
    assert.equal(normalize(JSON.parse(JSON.stringify(normalized)))[0]?.unblockedExternalStateHash, externalStateHash);
    for (const malformed of ['bad', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 42, null, undefined]) {
      const [legacy] = normalize([{ ...record, unblockedExternalStateHash: malformed }]);
      assert.ok(legacy);
      assert.equal(Object.hasOwn(legacy, 'unblockedExternalStateHash'), false);
    }
    const { unblockedExternalStateHash: omitted, ...legacyRecord } = record;
    assert.equal(omitted, externalStateHash);
    assert.equal(Object.hasOwn(normalize([legacyRecord])[0]!, 'unblockedExternalStateHash'), false);
    const broken = normalized.map((entry: Record<string, unknown>) => ({ ...entry }));
    delete broken[0]!.unblockedExternalStateHash;
    assert.throws(() => assert.equal(broken[0]?.unblockedExternalStateHash, externalStateHash),
      { code: 'ERR_ASSERTION' });
    assert.equal(normalize([record])[0]?.unblockedExternalStateHash, externalStateHash);
  }
});
