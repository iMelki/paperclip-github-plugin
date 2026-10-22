import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  awaitWithAbort, parseProjectReference, readProjectPreview,
  type BoardItem, type ProjectGraphql, type ProjectPreview,
} from './personal-projects.ts';

export interface BoardImportCapabilities {
  protocol: 'paperclip-github-board-import/v1';
  atomicTaskAndMembershipUpsert: boolean;
  durableNoDispatch: boolean;
  atomicOperationIntent: boolean;
}
export interface BoardImportContext {
  companyId: string | null;
  actor: { companyId: string | null; type?: string };
}
export interface BoardImportTask {
  id: string; companyId: string; projectId: string; githubIssueNodeId: string;
  title: string; sourceUrl: string; status: string;
  assigneeAgentId: string | null; assigneeUserId: string | null; noDispatch: boolean;
}
export interface BoardImportMembership {
  key: string; companyId: string; projectId: string; boardId: string; boardItemId: string;
  githubIssueNodeId: string; taskId: string; boardUrl: string; sourceUpdatedAt: string;
  fields: BoardItem['fields'];
}
export interface BoardImportIntent {
  operationId: string; intentHash: string; companyId: string; projectId: string;
  taskKey: string; membershipKey: string; boardId: string; boardItemId: string;
  githubIssueNodeId: string; boardUrl: string; sourceUpdatedAt: string;
  task: Omit<BoardImportTask, 'id'>;
  fields: BoardItem['fields'];
}
export interface BoardImportOperation {
  operationId: string; intentHash: string; companyId: string; projectId: string;
  intent: BoardImportIntent; state: 'prepared' | 'committed';
}
export interface BoardImportReceipt {
  operationId: string; task: BoardImportTask; membership: BoardImportMembership; createdTask: boolean;
}
export interface ProjectBoardSyncHost {
  getProject(projectId: string, companyId: string): Promise<{ id: string; companyId: string } | null>;
  getGraphql(companyId: string, projectId: string): Promise<ProjectGraphql>;
  getCapabilities(companyId: string): Promise<BoardImportCapabilities | null>;
  readTask(companyId: string, githubIssueNodeId: string): Promise<BoardImportTask | null>;
  readOperation(companyId: string, operationId: string): Promise<BoardImportOperation | null>;
  /** Atomic durable claim; false means another attempt owns this operation. */
  beginOperation(intent: BoardImportIntent, signal: AbortSignal): Promise<boolean>;
  /**
   * Host transaction MUST enforce unique taskKey and membershipKey, preserve foreign/nonneutral
   * tasks, persist the receipt and committed operation, and suppress dispatch DURABLY.
   * SDK create/update plus an in-process mutex does not satisfy this interface.
   */
  commitIssueAndMembershipAtomically(intent: BoardImportIntent, signal: AbortSignal): Promise<void>;
  /** Fresh native task/membership readback joined to the durable receipt, not an echoed request. */
  readReceipt(companyId: string, operationId: string): Promise<BoardImportReceipt | null>;
}
export interface BoardImportInput extends Record<string, unknown> {
  companyId: string; projectId: string; boardUrl: string;
  selectedItemIds?: string[]; maxSelected?: number; planId?: string;
}
export interface BoardImportPlan {
  planId: string; companyId: string; projectId: string; boardId: string; boardUrl: string;
  sourceUpdatedAt: string; selectedItemIds: string[]; supported: boolean;
  intents: BoardImportIntent[];
  skipped: Array<{ boardItemId: string; reason: string }>;
  conflicts: Array<{ boardItemId: string; reason: string }>;
  /** Task disposition only: even an unchanged task can acquire a new board membership. */
  rows: Array<{ boardItemId: string; disposition: 'create' | 'update' | 'unchanged' | 'conflict' | 'skip';
    existingTaskId: string | null }>;
}
export interface BoardImportItemResult {
  boardItemId: string | null; operationId: string | null; taskId: string | null;
  status: 'created' | 'reused' | 'conflict' | 'held'; reason: string | null;
}
export interface BoardImportResult {
  planId: string; complete: boolean; createdCount: number; reusedCount: number;
  skippedCount: number; conflictCount: number; heldCount: number; deferredCount: number;
  results: BoardImportItemResult[];
}

class SafeImportError extends Error {}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function supports(value: BoardImportCapabilities | null): boolean {
  return value?.protocol === 'paperclip-github-board-import/v1'
    && value.atomicTaskAndMembershipUpsert === true && value.durableNoDispatch === true
    && value.atomicOperationIntent === true;
}
function hostSupports(host: ProjectBoardSyncHost, value: BoardImportCapabilities | null): boolean {
  return supports(value) && ['readTask', 'readOperation', 'beginOperation',
    'commitIssueAndMembershipAtomically', 'readReceipt'].every(name =>
    typeof host[name as keyof ProjectBoardSyncHost] === 'function');
}
async function capabilities(host: ProjectBoardSyncHost, companyId: string) {
  return typeof host.getCapabilities === 'function' ? host.getCapabilities(companyId) : null;
}
async function authorize(host: ProjectBoardSyncHost, input: BoardImportInput, context: BoardImportContext) {
  const companyId = context?.companyId;
  if (!companyId || context.actor?.companyId !== companyId || input.companyId !== companyId) {
    throw new SafeImportError('Authenticated matching company scope is required.');
  }
  if (typeof input.projectId !== 'string' || !input.projectId.trim()) {
    throw new SafeImportError('Select an existing Paperclip project.');
  }
  const project = await host.getProject(input.projectId, companyId);
  if (!project || project.id !== input.projectId || project.companyId !== companyId) {
    throw new SafeImportError('The destination project does not belong to this company.');
  }
  return { companyId, projectId: project.id };
}
function selection(input: BoardImportInput, preview: ProjectPreview): BoardItem[] {
  const max = input.maxSelected ?? 1;
  if (!Number.isSafeInteger(max) || max < 1 || max > 20) {
    throw new SafeImportError('Select at most twenty board items; the first pilot defaults to one.');
  }
  const ids = input.selectedItemIds ?? preview.items.filter(item => item.eligible).slice(0, 1).map(item => item.id);
  if (!Array.isArray(ids) || ids.length > max || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 4096)) {
    throw new SafeImportError('Invalid or duplicate board item selection.');
  }
  const selected = ids.map(id => preview.items.find(item => item.id === id));
  if (selected.some(item => !item)) throw new SafeImportError('A selected item is absent from the complete board preview.');
  return (selected as BoardItem[]).sort((left, right) => left.id.localeCompare(right.id));
}
function neutral(task: BoardImportTask): boolean {
  return task.status === 'backlog' && task.assigneeAgentId === null && task.assigneeUserId === null
    && task.noDispatch === true;
}
function intentFor(scope: { companyId: string; projectId: string }, preview: ProjectPreview, item: BoardItem) {
  if (!item.issueNodeId || !item.url || !item.repository) throw new SafeImportError('Missing GitHub issue identity.');
  const task = { ...scope, githubIssueNodeId: item.issueNodeId, title: item.title, sourceUrl: item.url,
    status: 'backlog', assigneeAgentId: null, assigneeUserId: null, noDispatch: true };
  const data = { ...scope, taskKey: digest(['github-issue', scope.companyId, item.issueNodeId]),
    membershipKey: digest(['github-board-item', scope.companyId, preview.boardId, item.id]),
    boardId: preview.boardId, boardItemId: item.id, githubIssueNodeId: item.issueNodeId,
    boardUrl: preview.url, sourceUpdatedAt: preview.updatedAt, task, fields: structuredClone(item.fields) };
  const intentHash = digest(['board-import-v1', data]);
  return { ...data, operationId: intentHash, intentHash };
}
async function makePlan(host: ProjectBoardSyncHost, input: BoardImportInput,
  context: BoardImportContext, signal: AbortSignal): Promise<BoardImportPlan> {
  const scope = await awaitWithAbort(() => authorize(host, input, context), signal);
  let reference;
  try { reference = parseProjectReference(input.boardUrl); } catch {
    throw new SafeImportError('Use an exact HTTPS GitHub personal or organization Project URL.');
  }
  const graphql = await awaitWithAbort(() => host.getGraphql(scope.companyId, scope.projectId), signal);
  const preview = await readProjectPreview(graphql, reference, 1000, signal);
  if (!preview.complete) throw new SafeImportError('A complete board preview is required before import planning.');
  const selected = selection(input, preview);
  const intents: BoardImportIntent[] = [];
  const skipped: BoardImportPlan['skipped'] = [];
  const conflicts: BoardImportPlan['conflicts'] = [];
  const rows: BoardImportPlan['rows'] = [];
  for (const item of selected) {
    if (!item.eligible) {
      skipped.push({ boardItemId: item.id, reason: item.skipReason ?? 'Ineligible board item' });
      rows.push({ boardItemId: item.id, disposition: 'skip', existingTaskId: null }); continue;
    }
    const intent = intentFor(scope, preview, item);
    const existing = await awaitWithAbort(() => host.readTask(scope.companyId, intent.githubIssueNodeId), signal);
    if (existing && (existing.companyId !== scope.companyId || existing.projectId !== scope.projectId
      || existing.githubIssueNodeId !== intent.githubIssueNodeId || !neutral(existing))) {
      conflicts.push({ boardItemId: item.id, reason: 'Existing task has another destination or execution state; preserved.' });
      rows.push({ boardItemId: item.id, disposition: 'conflict', existingTaskId: existing.id });
    } else {
      intents.push(intent);
      rows.push({ boardItemId: item.id, existingTaskId: existing?.id ?? null,
        disposition: !existing ? 'create' : existing.title === item.title && existing.sourceUrl === item.url
          ? 'unchanged' : 'update' });
    }
  }
  const selectedItemIds = selected.map(item => item.id);
  return { ...scope, boardId: preview.boardId, boardUrl: preview.url, sourceUpdatedAt: preview.updatedAt,
    selectedItemIds, intents, skipped, conflicts, rows,
    supported: hostSupports(host, await awaitWithAbort(() => capabilities(host, scope.companyId), signal)),
    planId: digest(['board-plan-v1', scope, preview.boardId, preview.updatedAt, selectedItemIds,
      selected.map(item => [item.issueNodeId, item.title, item.url, item.fields, item.skipReason])]) };
}
function receiptMatches(receipt: BoardImportReceipt | null, intent: BoardImportIntent): receipt is BoardImportReceipt {
  if (!receipt || receipt.operationId !== intent.operationId || typeof receipt.createdTask !== 'boolean') return false;
  const task = receipt.task;
  const membership = receipt.membership;
  return Boolean(task?.id && task.companyId === intent.companyId && task.projectId === intent.projectId
    && task.githubIssueNodeId === intent.githubIssueNodeId && neutral(task)
    && task.title === intent.task.title && task.sourceUrl === intent.task.sourceUrl
    && membership?.key === intent.membershipKey && membership.companyId === intent.companyId
    && membership.projectId === intent.projectId && membership.boardId === intent.boardId
    && membership.boardItemId === intent.boardItemId && membership.taskId === task.id
    && membership.githubIssueNodeId === intent.githubIssueNodeId && membership.boardUrl === intent.boardUrl
    && membership.sourceUpdatedAt === intent.sourceUpdatedAt && isDeepStrictEqual(membership.fields, intent.fields));
}
function held(intent: BoardImportIntent): BoardImportItemResult {
  return { boardItemId: intent.boardItemId, operationId: intent.operationId, taskId: null, status: 'held',
    reason: 'Import outcome was not verified. Inspect this retained operation before any retry.' };
}
async function recover(host: ProjectBoardSyncHost, intent: BoardImportIntent, newlyClaimed = false,
  signal = AbortSignal.timeout(5000)) {
  try {
    const operation = await awaitWithAbort(() => host.readOperation(intent.companyId, intent.operationId), signal);
    if (operation?.state !== 'committed' || operation.companyId !== intent.companyId
      || operation.projectId !== intent.projectId || operation.operationId !== intent.operationId
      || operation.intentHash !== intent.intentHash || !isDeepStrictEqual(operation.intent, intent)) return held(intent);
    const receipt = await awaitWithAbort(() => host.readReceipt(intent.companyId, intent.operationId), signal);
    if (!receiptMatches(receipt, intent)) return held(intent);
    return { boardItemId: intent.boardItemId, operationId: intent.operationId, taskId: receipt.task.id,
      status: newlyClaimed && receipt.createdTask ? 'created' as const : 'reused' as const, reason: null };
  } catch { return held(intent); }
}
async function importOne(host: ProjectBoardSyncHost, intent: BoardImportIntent, signal: AbortSignal) {
  let claimed = false;
  try {
    const retained = await awaitWithAbort(() => host.readOperation(intent.companyId, intent.operationId), signal);
    if (retained) return recover(host, intent);
    const claim = await awaitWithAbort(() => host.beginOperation(intent, signal), signal);
    if (claim !== true) return recover(host, intent);
    claimed = true;
    await awaitWithAbort(() => host.commitIssueAndMembershipAtomically(intent, signal), signal);
    return recover(host, intent, true);
  } catch { return recover(host, intent, claimed); }
}
async function safe<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof SafeImportError) throw error;
    throw new SafeImportError('Board import could not be verified. Inspect retained operations; do not blindly retry.');
  }
}
export interface BoardImportRecoveryInput extends Record<string, unknown> {
  companyId: string; projectId: string; operationIds: string[]; boardUrl?: string;
}
async function recoverScoped(host: ProjectBoardSyncHost, input: BoardImportRecoveryInput,
  context: BoardImportContext): Promise<BoardImportResult> {
  const signal = AbortSignal.timeout(20000);
  const scope = await awaitWithAbort(() => authorize(host, input as BoardImportInput, context), signal);
  const ids = input.operationIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
    throw new SafeImportError('Select one to twenty exact retained operation IDs.');
  }
  let boardUrl: string | undefined;
  if (input.boardUrl !== undefined) {
    try { boardUrl = parseProjectReference(input.boardUrl).url; } catch {
      throw new SafeImportError('Use an exact GitHub Project URL for scoped recovery.');
    }
  }
  const results: BoardImportItemResult[] = [];
  for (const operationId of ids) {
    let result: BoardImportItemResult = { boardItemId: null, operationId, taskId: null, status: 'held',
      reason: 'No scoped saved result was verified. Recovery performed no writes or automatic retries.' };
    try {
      const operation = await awaitWithAbort(() => host.readOperation(scope.companyId, operationId), signal);
      const intent = operation?.intent;
      if (operation?.companyId === scope.companyId && operation.projectId === scope.projectId
        && operation.operationId === operationId && intent?.companyId === scope.companyId
        && intent.projectId === scope.projectId && intent.operationId === operationId
        && intent.intentHash === operation.intentHash && (!boardUrl || intent.boardUrl === boardUrl)) {
        result = await recover(host, intent, false, signal);
      }
    } catch { /* Retain unknown without exposing backend errors or repeating writes. */ }
    results.push(result);
  }
  const reusedCount = results.filter(result => result.status === 'reused').length;
  return { planId: digest(['board-recovery-v1', scope, ids]), complete: reusedCount === ids.length,
    createdCount: 0, reusedCount, skippedCount: 0, conflictCount: 0,
    heldCount: ids.length - reusedCount, deferredCount: 0, results };
}
export function createProjectBoardSyncActions(host: ProjectBoardSyncHost) {
  return {
    recover: (input: BoardImportRecoveryInput, context: BoardImportContext) => safe(() => recoverScoped(host, input, context)),
    plan: (input: BoardImportInput, context: BoardImportContext) => safe(() =>
      makePlan(host, input, context, AbortSignal.timeout(20000))),
    execute: (input: BoardImportInput, context: BoardImportContext) => safe(async (): Promise<BoardImportResult> => {
      if (context?.actor?.type !== 'user') throw new SafeImportError('Only a signed-in operator can import board items.');
      const signal = AbortSignal.timeout(30000);
      const scope = await awaitWithAbort(() => authorize(host, input, context), signal);
      if (!hostSupports(host, await awaitWithAbort(() => capabilities(host, scope.companyId), signal))) {
        throw new SafeImportError('Import disabled: the host must enforce atomic upsert, durable intent and durable no-dispatch.');
      }
      const plan = await makePlan(host, input, context, signal);
      if (!plan.supported) throw new SafeImportError('Host import guarantees changed; no writes were attempted.');
      if (typeof input.planId !== 'string' || input.planId !== plan.planId) {
        throw new SafeImportError('The import plan is stale or missing. Plan again before executing.');
      }
      const results: BoardImportItemResult[] = plan.conflicts.map(conflict => ({ ...conflict,
        operationId: null, taskId: null, status: 'conflict' }));
      let processed = 0;
      for (const intent of plan.intents) {
        const result = await importOne(host, intent, signal);
        results.push(result); processed += 1;
        if (result.status === 'held') break;
      }
      const count = (status: BoardImportItemResult['status']) => results.filter(result => result.status === status).length;
      return { planId: plan.planId, complete: count('held') === 0 && count('conflict') === 0,
        createdCount: count('created'), reusedCount: count('reused'), skippedCount: plan.skipped.length,
        conflictCount: count('conflict'), heldCount: count('held'), deferredCount: plan.intents.length - processed, results };
    }),
  };
}
