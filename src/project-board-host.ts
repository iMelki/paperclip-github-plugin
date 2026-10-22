import type {
  BoardImportCapabilities, BoardImportIntent, BoardImportOperation,
  BoardImportReceipt, BoardImportTask, ProjectBoardSyncHost,
} from './project-board-sync.ts';

interface NativeBoardClient {
  importedBoard?(input: { companyId: string; op: string; [key: string]: unknown }): Promise<unknown>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0;
const sourceUrl = (value: unknown): value is string => typeof value === 'string'
  && /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(value)
  && new URL(value).href === value;
function task(value: unknown, companyId: string): value is BoardImportTask {
  return record(value) && value.companyId === companyId && text(value.id) && text(value.projectId)
    && text(value.githubIssueNodeId) && text(value.title) && sourceUrl(value.sourceUrl) && text(value.status)
    && (value.assigneeAgentId === null || text(value.assigneeAgentId))
    && (value.assigneeUserId === null || text(value.assigneeUserId)) && typeof value.noDispatch === 'boolean';
}
function checked<T>(value: unknown, valid: boolean): T {
  if (!valid) throw new Error('Native board import returned incomplete or mismatched readback.');
  return value as T;
}

/** No SDK-create fallback: older hosts remain read-only until the native transaction is adopted. */
export function createNativeBoardImportHost(
  client: unknown,
  readers: Pick<ProjectBoardSyncHost, 'getProject' | 'getGraphql'>,
): ProjectBoardSyncHost {
  const native = client as NativeBoardClient;
  const call = async <T>(companyId: string, op: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (typeof native.importedBoard !== 'function') throw new Error('Atomic board import host is unavailable.');
    return await native.importedBoard({ companyId, op, ...args }) as T;
  };
  return {
    ...readers,
    getCapabilities: async companyId => {
      if (typeof native.importedBoard !== 'function') return null;
      const value = await call<unknown>(companyId, 'capabilities');
      return checked<BoardImportCapabilities | null>(value, value === null || (record(value)
        && value.protocol === 'paperclip-github-board-import/v1'
        && ['atomicTaskAndMembershipUpsert', 'durableNoDispatch', 'atomicOperationIntent']
          .every(key => typeof value[key] === 'boolean')));
    },
    readTask: async (companyId, githubIssueNodeId) => {
      if (typeof native.importedBoard !== 'function') return null;
      const value = await call<unknown>(companyId, 'readTask', { githubIssueNodeId });
      return checked<BoardImportTask | null>(value, value === null || (task(value, companyId) && value.githubIssueNodeId === githubIssueNodeId));
    },
    readOperation: async (companyId, operationId) => {
      const value = await call<unknown>(companyId, 'readOperation', { operationId });
      return checked<BoardImportOperation | null>(value, value === null || (record(value)
        && value.companyId === companyId && value.operationId === operationId && value.intentHash === operationId
        && text(value.projectId) && record(value.intent)
        && (value.state === 'prepared' || value.state === 'committed')));
    },
    beginOperation: async (intent: BoardImportIntent) => {
      const value = await call<unknown>(intent.companyId, 'begin', { intent });
      return checked<boolean>(value, typeof value === 'boolean');
    },
    commitIssueAndMembershipAtomically: async (intent: BoardImportIntent) => {
      await call(intent.companyId, 'commit', { intent });
    },
    readReceipt: async (companyId, operationId) => {
      const value = await call<unknown>(companyId, 'readReceipt', { operationId });
      return checked<BoardImportReceipt | null>(value, value === null || (record(value)
        && value.operationId === operationId && task(value.task, companyId)
        && record(value.membership) && value.membership.companyId === companyId
        && typeof value.createdTask === 'boolean'));
    },
  };
}

/** Stock cron/recovery must never enroll board-only records. Native origin/journal readback is authoritative. */
export async function readBoardImportExclusions(client: unknown, companyId: string): Promise<Set<string>> {
  const native = client as NativeBoardClient;
  if (typeof native.importedBoard !== 'function') return new Set();
  const result = await native.importedBoard({ companyId, op: 'sources' });
  if (!record(result) || result.companyId !== companyId || !Array.isArray(result.sourceUrls)
    || Object.keys(result).some(key => key !== 'companyId' && key !== 'sourceUrls')
    || result.sourceUrls.length > 2000 || result.sourceUrls.some(url => !sourceUrl(url))) {
    throw new Error('Board-import isolation could not be verified. Stock sync was stopped before enrollment.');
  }
  return new Set(result.sourceUrls as string[]);
}

export function isManualBoardOrigin(issue: { originKind?: string | null } | null | undefined): boolean {
  return typeof issue?.originKind === 'string'
    && /^plugin:[^:\s]+:github-board-(?:manual|quarantine)$/.test(issue.originKind)
    && issue.originKind.trim() === issue.originKind;
}
