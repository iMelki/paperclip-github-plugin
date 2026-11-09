import { createHash } from 'node:crypto';
import type { IssueInteractionEvent } from './issue-interactions.ts';

// Selective Apache-2.0 reuse: upstream PR #211, merge d06bf866f5b80a949aa0127e755c3ef1c6df95f3.
// Its eight structural fields include reviewDecision; explicit lifecycle is an owned extension.
// Recovery is deliberately stricter: proposals, failed calls and current-state matches are not receipts.
export interface ExternalPullRequestState {
  repositoryUrl: string;
  number: number;
  headSha?: string | null;
  mergeability: string;
  mergeStateStatus: string;
  ciState: string;
  hasUnresolvedReviewThreads: boolean;
  reviewDecision: string;
  lifecycleState?: 'open' | 'closed' | 'merged';
}

export interface PullRequestCommentCountRecord {
  number: number;
  repositoryUrl: string;
  topLevelCommentCount: number;
  reviewCommentCount: number;
}

export type ExternalPrWaitLedgerEvent = IssueInteractionEvent & {
  externalPullRequestStateHash?: string;
};

export interface ExternalPrWaitLedgerInput {
  events: readonly ExternalPrWaitLedgerEvent[];
  companyId: string;
  paperclipIssueId: string;
  previousUnblockedExternalStateHash?: unknown;
  previousUnblockedReceiptDedupeKey?: unknown;
  integrity: { malformedRows: number; conflictingKeys: number; scanTruncated: boolean };
}

export interface ExternalPrWaitLedgerProjection {
  status: 'ready' | 'hold';
  unblockedExternalStateHash?: string;
  unblockedReceiptDedupeKey?: string;
  reason?: string;
}

export function normalizeExternalPullRequestStateHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export function normalizeExternalPrBudgetReceiptKey(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 256 && !/\s/.test(value)
    && /^sync:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*:mutation:result:changed$/.test(value) ? value : undefined;
}

export function buildExternalPullRequestStateHash(
  records: readonly ExternalPullRequestState[]
): string | undefined {
  if (records.length === 0) return undefined;
  // Callers supply repository URLs canonicalized by the existing repository-reference module.
  const canonical = records.map((record) => ({
    repositoryUrl: record.repositoryUrl.trim().toLowerCase(),
    number: record.number,
    headSha: record.headSha ?? null,
    mergeability: record.mergeability,
    mergeStateStatus: record.mergeStateStatus,
    ciState: record.ciState,
    hasUnresolvedReviewThreads: record.hasUnresolvedReviewThreads,
    reviewDecision: record.reviewDecision,
    ...(record.lifecycleState ? { lifecycleState: record.lifecycleState } : {})
  })).sort((left, right) =>
    compareCanonicalStrings(left.repositoryUrl, right.repositoryUrl)
    || left.number - right.number
    || compareCanonicalStrings(JSON.stringify(left), JSON.stringify(right))
  );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function shouldPreserveDeliberateBlockedWait(input: {
  currentStatus: string;
  nextStatus: string;
  hasTrustedComment: boolean;
  hasPullRequests: boolean;
  unblockedExternalStateHash?: unknown;
  externalStateHash?: unknown;
}): boolean {
  const previous = normalizeExternalPullRequestStateHash(input.unblockedExternalStateHash);
  const current = normalizeExternalPullRequestStateHash(input.externalStateHash);
  return input.currentStatus === 'blocked' && input.nextStatus !== 'blocked'
    && !input.hasTrustedComment && input.hasPullRequests && Boolean(previous && current && previous === current);
}

export function resolveUnblockedExternalStateHash(input: {
  currentStatus: string;
  nextStatus: string;
  externalStateHash?: unknown;
  previousUnblockedExternalStateHash?: unknown;
}): string | undefined {
  if (input.nextStatus === 'blocked' && input.currentStatus !== 'blocked') return undefined;
  if (input.currentStatus === 'blocked' && input.nextStatus !== 'blocked') {
    return normalizeExternalPullRequestStateHash(input.externalStateHash);
  }
  return normalizeExternalPullRequestStateHash(input.previousUnblockedExternalStateHash);
}

function ledgerHold(reason: string): ExternalPrWaitLedgerProjection {
  return { status: 'hold', reason };
}

function validateLedger(input: ExternalPrWaitLedgerInput): string | undefined {
  const integrity = input.integrity;
  if (!input.companyId || !input.paperclipIssueId || !integrity
    || !Number.isSafeInteger(integrity.malformedRows) || integrity.malformedRows !== 0
    || !Number.isSafeInteger(integrity.conflictingKeys) || integrity.conflictingKeys !== 0
    || integrity.scanTruncated !== false) return 'incomplete_ledger';
  const byKey = new Map<string, string>();
  for (const event of input.events) {
    if (event.companyId !== input.companyId || event.paperclipIssueId !== input.paperclipIssueId) {
      return 'scope_mismatch';
    }
    if (!event.dedupeKey || !Number.isFinite(Date.parse(event.occurredAt))) return 'malformed_receipt';
    if (event.externalPullRequestStateHash !== undefined
      && !normalizeExternalPullRequestStateHash(event.externalPullRequestStateHash)) return 'malformed_digest';
    const serialized = JSON.stringify(event);
    const existing = byKey.get(event.dedupeKey);
    if (existing !== undefined && existing !== serialized) return 'conflicting_receipts';
    byKey.set(event.dedupeKey, serialized);
  }
  return undefined;
}

function hasUnsettledSyncIntent(events: readonly ExternalPrWaitLedgerEvent[]): boolean {
  return events.some((intent) => {
    if (intent.source !== 'sync' || intent.outcome !== 'observed'
      || !['update_issue', 'add_issue_comment'].includes(intent.action)
      || !intent.dedupeKey.endsWith(':intent')) return false;
    const base = intent.dedupeKey.slice(0, -':intent'.length);
    return !events.some((result) => result.source === 'sync' && result.action === intent.action
      && Date.parse(result.occurredAt) >= Date.parse(intent.occurredAt)
      && ((result.outcome === 'changed' && result.dedupeKey === `${base}:result:changed`)
        || (result.outcome === 'noop' && result.dedupeKey === `${base}:result:noop`)));
  });
}

function receiptBudgetEffect(event: ExternalPrWaitLedgerEvent): string | undefined {
  if (event.source !== 'sync' || event.action !== 'update_issue' || event.outcome !== 'changed') {
    return undefined;
  }
  const from = event.transition?.from;
  const to = event.transition?.to;
  if (!from || !to) return undefined; // Legacy receipts do not invent a budget.
  if (from !== 'blocked' && to === 'blocked') return 'reset';
  if (from === 'blocked' && to !== 'blocked') {
    return normalizeExternalPullRequestStateHash(event.externalPullRequestStateHash) ?? 'reset';
  }
  return undefined;
}

function validatePreviousBudgetBinding(input: ExternalPrWaitLedgerInput): string | undefined {
  const previous = normalizeExternalPullRequestStateHash(input.previousUnblockedExternalStateHash);
  if (input.previousUnblockedReceiptDedupeKey !== undefined) {
    const key = normalizeExternalPrBudgetReceiptKey(input.previousUnblockedReceiptDedupeKey);
    if (!key || !previous) return 'malformed_budget_binding';
    if (!input.events.some((event) => event.dedupeKey === key && receiptBudgetEffect(event) === previous)) {
      return 'missing_budget_receipt';
    }
    return undefined;
  }
  if (previous && !input.events.some((event) => receiptBudgetEffect(event) === previous)) {
    return 'missing_budget_receipt';
  }
  return undefined;
}

function projectBudgetReceipts(events: readonly ExternalPrWaitLedgerEvent[]): ExternalPrWaitLedgerProjection {
  const groups = new Map<number, Map<string, Set<string>>>();
  for (const event of events) {
    const effect = receiptBudgetEffect(event);
    if (!effect) continue;
    const key = normalizeExternalPrBudgetReceiptKey(event.dedupeKey);
    if (!key) return ledgerHold('malformed_budget_receipt');
    const time = Date.parse(event.occurredAt);
    const group = groups.get(time) ?? new Map<string, Set<string>>();
    const keys = group.get(effect) ?? new Set<string>();
    keys.add(key);
    group.set(effect, keys);
    groups.set(time, group);
  }
  let unblockedExternalStateHash: string | undefined;
  let unblockedReceiptDedupeKey: string | undefined;
  for (const [, effects] of [...groups.entries()].sort(([left], [right]) => left - right)) {
    if (effects.size > 1) return ledgerHold('ambiguous_transition_order');
    const [effect, keys] = [...effects.entries()][0]!;
    unblockedExternalStateHash = effect === 'reset' ? undefined : effect;
    unblockedReceiptDedupeKey = unblockedExternalStateHash ? [...keys].sort()[0] : undefined;
  }
  return { status: 'ready', ...(unblockedExternalStateHash && unblockedReceiptDedupeKey
    ? { unblockedExternalStateHash, unblockedReceiptDedupeKey } : {}) };
}

export function projectExternalPrWaitLedger(input: ExternalPrWaitLedgerInput): ExternalPrWaitLedgerProjection {
  const problem = validateLedger(input);
  if (problem) return ledgerHold(problem);
  if (hasUnsettledSyncIntent(input.events)) return ledgerHold('unsettled_sync_effect');
  const bindingProblem = validatePreviousBudgetBinding(input);
  if (bindingProblem) return ledgerHold(bindingProblem);
  const projection = projectBudgetReceipts(input.events);
  const previous = normalizeExternalPullRequestStateHash(input.previousUnblockedExternalStateHash);
  if (projection.status === 'ready' && previous && input.previousUnblockedReceiptDedupeKey === undefined
    && projection.unblockedExternalStateHash !== previous) return ledgerHold('ambiguous_legacy_budget_continuity');
  return projection;
}

export function buildSyncInteractionEvent(input: {
  companyId: string;
  issueId: string;
  occurredAt: string;
  currentStatus: string;
  nextStatus: string;
  reasonCode?: string;
  remote?: IssueInteractionEvent['remote'];
  outcome: IssueInteractionEvent['outcome'];
  action?: 'status_decision' | 'update_issue';
  dedupeKey: string;
  externalPullRequestStateHash?: unknown;
}): ExternalPrWaitLedgerEvent {
  const action = input.action ?? 'status_decision';
  const digest = normalizeExternalPullRequestStateHash(input.externalPullRequestStateHash);
  return {
    schemaVersion: 1,
    companyId: input.companyId,
    paperclipIssueId: input.issueId,
    occurredAt: input.occurredAt,
    category: 'sync', action, source: 'sync', outcome: input.outcome,
    ...(input.remote ? { remote: input.remote } : {}),
    transition: { from: input.currentStatus, to: input.nextStatus,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}) },
    ...(action === 'update_issue' && input.outcome === 'changed' && digest
      ? { externalPullRequestStateHash: digest } : {}),
    dedupeKey: input.dedupeKey
  };
}

// Existing owned-main helper moved unchanged; caller must first establish a genuine no-op.
export function findSettledNoopAttempt(
  events: IssueInteractionEvent[],
  attemptPrefix: string
): { dedupeBase: string; occurredAt: string } | undefined {
  const resultSuffix = ':result:noop';
  const settled = events
    .filter((candidate) => {
      if (!candidate.dedupeKey.startsWith(attemptPrefix)) return false;
      return /^[^:]+:result:noop$/.test(candidate.dedupeKey.slice(attemptPrefix.length));
    })
    .sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt)
      || right.dedupeKey.localeCompare(left.dedupeKey)
    );
  for (const event of settled) {
    const dedupeBase = event.dedupeKey.slice(0, -resultSuffix.length);
    const intent = events.find((candidate) => candidate.dedupeKey === `${dedupeBase}:intent`);
    if (intent) return { dedupeBase, occurredAt: intent.occurredAt };
  }
  return undefined;
}

export function canonicalizeGitHubPullRequestCommentCounts(
  records: PullRequestCommentCountRecord[]
): PullRequestCommentCountRecord[] {
  return [...records].sort((left, right) =>
    left.repositoryUrl.localeCompare(right.repositoryUrl) || left.number - right.number
  );
}

function normalizeCommentCountRecord(
  entry: unknown,
  normalizeRepositoryUrl: (url: string) => string
): PullRequestCommentCountRecord | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const record = entry as Record<string, unknown>;
  const number = typeof record.number === 'number' && Number.isInteger(record.number) && record.number > 0
    ? Math.floor(record.number) : undefined;
  const repositoryUrl = typeof record.repositoryUrl === 'string' && record.repositoryUrl.trim()
    ? normalizeRepositoryUrl(record.repositoryUrl) : undefined;
  const topLevelCommentCount = typeof record.topLevelCommentCount === 'number' && record.topLevelCommentCount >= 0
    ? Math.floor(record.topLevelCommentCount) : undefined;
  const reviewCommentCount = typeof record.reviewCommentCount === 'number' && record.reviewCommentCount >= 0
    ? Math.floor(record.reviewCommentCount) : undefined;
  if (number === undefined || !repositoryUrl || topLevelCommentCount === undefined || reviewCommentCount === undefined) {
    return undefined;
  }
  return { number, repositoryUrl, topLevelCommentCount, reviewCommentCount };
}

export function normalizeGitHubPullRequestCommentCountRecords(
  value: unknown,
  normalizeRepositoryUrl: (url: string) => string
): PullRequestCommentCountRecord[] {
  if (!Array.isArray(value)) return [];
  const recordsByKey = new Map<string, PullRequestCommentCountRecord>();
  for (const entry of value) {
    const record = normalizeCommentCountRecord(entry, normalizeRepositoryUrl);
    if (!record) continue;
    const key = `${normalizeRepositoryUrl(record.repositoryUrl).toLowerCase()}#${Math.max(1, Math.floor(record.number))}`;
    recordsByKey.set(key, record);
  }
  return [...recordsByKey.values()].sort((left, right) =>
    left.repositoryUrl.toLowerCase().localeCompare(right.repositoryUrl.toLowerCase()) || left.number - right.number
  ).slice(0, 128);
}
