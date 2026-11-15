import { parseProjectReference, projectItemsQuery, awaitWithAbort, type ProjectGraphql } from './personal-projects.ts';

export interface GitHubProjectConnectionOption {
  connectionId: string; name: string; accountId: number; login: string; lastVerifiedAt: string | null;
}
export interface GitHubProjectBinding {
  version: 1; companyId: string; projectId: string; boardUrl: string; boardId: string; connectionId: string;
  accountId: number; login: string; boundByUserId: string; boundAt: string;
}
interface NativeClient {
  importedBoard?(input: { companyId: string; op: string; [key: string]: unknown }): Promise<unknown>;
}
interface Context { companyId: string | null; actor: { companyId: string | null; type?: string } }
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0;
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
function checked<T>(value: unknown, valid: boolean): T {
  if (!valid) throw new Error('Native GitHub board OAuth readback was incomplete or mismatched.');
  return value as T;
}
export function checkedGitHubProjectBinding(value: unknown, companyId: string, projectId: string) {
  if (value === null) return null;
  const binding = checked<GitHubProjectBinding>(value, record(value) && value.version === 1
    && value.companyId === companyId && value.projectId === projectId && uuid(value.connectionId)
    && Object.keys(value).every(key => ['version', 'companyId', 'projectId', 'boardUrl', 'boardId', 'connectionId',
      'accountId', 'login', 'boundByUserId', 'boundAt'].includes(key))
    && text(value.boardUrl) && text(value.boardId) && Number.isSafeInteger(value.accountId) && (value.accountId as number) > 0
    && text(value.login) && text(value.boundByUserId) && text(value.boundAt) && Number.isFinite(Date.parse(value.boundAt)));
  if (parseProjectReference(binding.boardUrl).url !== binding.boardUrl) throw new Error('Noncanonical native board binding.');
  return binding;
}

/** The worker never resolves OAuth secrets or sends a bearer, query or caller URL to the host bridge. */
export function createProjectBoardOAuth(client: unknown) {
  const native = client as NativeClient;
  const call = async (companyId: string, op: string, args: Record<string, unknown>) => {
    if (typeof native.importedBoard !== 'function') throw new Error('Native GitHub board OAuth bridge is unavailable. No PAT fallback.');
    try { return await native.importedBoard({ companyId, op, ...args }); }
    catch { throw new Error('Native GitHub board OAuth request failed. Load the saved binding before retrying a save.'); }
  };
  function scope(input: Record<string, unknown>, context: Context) {
    if (!uuid(input.companyId) || !uuid(input.projectId) || input.companyId !== context?.companyId
      || context.actor?.companyId !== input.companyId || context.actor?.type !== 'user') {
      throw new Error('A signed-in operator and matching company/project scope are required.');
    }
    return { companyId: input.companyId, projectId: input.projectId };
  }
  async function get(companyId: string, projectId: string) {
    return checkedGitHubProjectBinding(await call(companyId, 'readProjectBinding', { projectId }), companyId, projectId);
  }
  return {
    list: async (input: Record<string, unknown>, context: Context) => {
      const target = scope(input, context), value = await call(target.companyId, 'listProjectConnections', { projectId: target.projectId });
      return checked<{ companyId: string; projectId: string; connections: GitHubProjectConnectionOption[] }>(value,
        record(value) && value.companyId === target.companyId && value.projectId === target.projectId
        && Array.isArray(value.connections) && value.connections.length <= 100
        && value.connections.every(item => record(item) && uuid(item.connectionId) && text(item.name)
          && Number.isSafeInteger(item.accountId) && (item.accountId as number) > 0 && text(item.login)
          && Object.keys(item).every(key => ['connectionId', 'name', 'accountId', 'login', 'lastVerifiedAt'].includes(key))
          && (item.lastVerifiedAt === null || (text(item.lastVerifiedAt) && Number.isFinite(Date.parse(item.lastVerifiedAt))))));
    },
    get: async (input: Record<string, unknown>, context: Context) => {
      const target = scope(input, context);
      return get(target.companyId, target.projectId);
    },
    bind: async (input: Record<string, unknown>, context: Context) => {
      const target = scope(input, context);
      const reference = parseProjectReference(input.boardUrl);
      if (!uuid(input.connectionId)) throw new Error('Explicitly select a native GitHub OAuth connection.');
      const saved = checkedGitHubProjectBinding(await call(target.companyId, 'bindProjectBoard', {
        projectId: target.projectId, boardUrl: reference.url, connectionId: input.connectionId,
      }), target.companyId, target.projectId);
      if (!saved || saved.connectionId !== input.connectionId || saved.boardUrl !== reference.url) {
        throw new Error('Native board binding save is unverified. Load it; do not blindly retry.');
      }
      const readback = await get(target.companyId, target.projectId);
      if (!readback || Object.keys(saved).some(key => saved[key as keyof GitHubProjectBinding] !== readback[key as keyof GitHubProjectBinding])) {
        throw new Error('Native board binding readback is unverified. Load it; do not blindly retry.');
      }
      return readback;
    },
    getGraphql: async (companyId: string, projectId: string): Promise<ProjectGraphql> => {
      const binding = await get(companyId, projectId);
      if (!binding) throw new Error('Bind the selected native GitHub OAuth connection first. No PAT fallback.');
      const reference = parseProjectReference(binding.boardUrl);
      return async (query, variables, signal) => {
        if (query !== projectItemsQuery(reference.ownerType) || variables.owner !== reference.owner
          || variables.number !== reference.number || Object.keys(variables).some(key => !['owner', 'number', 'after', 'first'].includes(key))
          || !Number.isSafeInteger(variables.first) || (variables.first as number) < 1 || (variables.first as number) > 50
          || (variables.after !== null && (typeof variables.after !== 'string'
            || !/^[A-Za-z0-9_+/=-]{1,512}$/.test(variables.after)))) {
          throw new Error('Only the fixed bound board page reader is permitted.');
        }
        return awaitWithAbort(() => call(companyId, 'readProjectPage', { projectId, page: {
          ownerType: reference.ownerType, owner: reference.owner, number: reference.number,
          after: variables.after, first: variables.first,
        } }), signal);
      };
    },
  };
}
