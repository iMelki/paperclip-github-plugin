import { isDeepStrictEqual } from 'node:util';
import { awaitWithAbort, parseProjectReference, readProjectPreview, type ProjectGraphql } from './personal-projects.ts';

interface BoardHost {
  getProject(projectId: string, companyId: string): Promise<{ id: string; companyId: string } | null>;
  getGraphql(companyId: string, projectId: string): Promise<ProjectGraphql>;
  getConnection(companyId: string, projectId: string): Promise<unknown>;
  setConnection(companyId: string, projectId: string, value: Record<string, unknown>): Promise<void>;
}
interface TrustedContext { companyId: string | null; actor: { companyId: string | null; type?: string } }
const saveLocks = new Map<string, Promise<void>>();

async function serializeSave<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = saveLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => held);
  saveLocks.set(key, tail);
  await previous;
  try { return await action(); } finally {
    release();
    if (saveLocks.get(key) === tail) saveLocks.delete(key);
  }
}

class SafeBoardError extends Error {}
function referenceFromInput(input: Record<string, unknown>) {
  try { return parseProjectReference(input.boardUrl); } catch {
    throw new SafeBoardError('Use an exact HTTPS github.com/users/OWNER/projects/NUMBER or orgs URL.');
  }
}
async function safe<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof SafeBoardError) throw error;
    throw new SafeBoardError('Could not verify the board connection. No tasks were imported. Load the saved association before retrying a save.');
  }
}

async function authorize(host: BoardHost, input: Record<string, unknown>, context: TrustedContext) {
  const companyId = context?.companyId;
  if (!companyId || context.actor?.companyId !== companyId || input.companyId !== companyId) {
    throw new SafeBoardError('An authenticated matching company scope is required.');
  }
  if (typeof input.projectId !== 'string' || !input.projectId.trim()) throw new SafeBoardError('Select an existing Paperclip project.');
  const project = await host.getProject(input.projectId, companyId);
  if (!project || project.id !== input.projectId || project.companyId !== companyId) {
    throw new SafeBoardError('The destination project does not belong to this company.');
  }
  return { companyId, projectId: project.id };
}

// These handlers deliberately expose no task, assignment, wakeup, job or repository-mapping API.
export function createProjectBoardActions(host: BoardHost) {
  async function preview(input: Record<string, unknown>, context: TrustedContext) {
      const timer = new AbortController();
      const deadline = setTimeout(() => timer.abort(new SafeBoardError('Board preview timed out. No tasks were imported.')), 20000);
      try {
        const scope = await awaitWithAbort(() => authorize(host, input, context), timer.signal);
        const reference = referenceFromInput(input);
        const graphql = await awaitWithAbort(() => host.getGraphql(scope.companyId, scope.projectId), timer.signal);
        return await readProjectPreview(graphql, reference, 1000, timer.signal);
      } catch (error) {
        if (error instanceof SafeBoardError) throw error;
        throw new SafeBoardError('Board preview failed or was incomplete. Verify this company\'s Project-capable GitHub credential and retry. No tasks were imported.');
      } finally { clearTimeout(deadline); }
  }
  return {
    preview: (input: Record<string, unknown>, context: TrustedContext) => safe(() => preview(input, context)),
    save: (input: Record<string, unknown>, context: TrustedContext) => safe(async () => {
      if (context?.actor?.type !== 'user') throw new SafeBoardError('Only a signed-in operator can save a board association.');
      const scope = await awaitWithAbort(() => authorize(host, input, context), AbortSignal.timeout(10000));
      const reference = referenceFromInput(input);
      const result = await preview(input, context);
      if (!result.complete) throw new SafeBoardError('A complete board preview is required before saving its association.');
      if (input.boardId !== result.boardId || input.updatedAt !== result.updatedAt) {
        throw new SafeBoardError('The preview is stale. Preview the board again before saving.');
      }
      return serializeSave(JSON.stringify([scope.companyId, scope.projectId]), async () => {
      const existing = await host.getConnection(scope.companyId, scope.projectId);
      if (existing && typeof existing === 'object' && 'boardId' in existing && existing.boardId !== result.boardId) {
        throw new SafeBoardError('This project already has a different board connection. No association was replaced.');
      }
      const connection = { ...scope, reference, boardId: result.boardId, title: result.title,
        updatedAt: result.updatedAt, mode: 'reference-and-preview', importEnabled: false };
      await host.setConnection(scope.companyId, scope.projectId, connection);
      const saved = await host.getConnection(scope.companyId, scope.projectId);
      if (!isDeepStrictEqual(saved, connection)) {
        throw new SafeBoardError('Connection save was not verified. Load the saved association; do not blindly retry.');
      }
      return saved;
      });
    }),
    get: (input: Record<string, unknown>, context: TrustedContext) => safe(async () => {
      const scope = await awaitWithAbort(() => authorize(host, input, context), AbortSignal.timeout(10000));
      return host.getConnection(scope.companyId, scope.projectId);
    })
  };
}
