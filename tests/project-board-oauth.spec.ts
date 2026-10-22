import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectBoardOAuth, checkedGitHubProjectBinding } from '../src/project-board-oauth.ts';
import { projectItemsQuery, readProjectPreview } from '../src/personal-projects.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333';
const boardUrl = 'https://github.com/users/example/projects/12';
const context = { companyId, actor: { companyId, type: 'user' } };
const input = { companyId, projectId, boardUrl, connectionId };
const nullContexts = [
  { name: 'context company', value: { companyId: null, actor: context.actor } },
  { name: 'actor company', value: { companyId, actor: { companyId: null, type: 'user' } } },
  { name: 'both companies', value: { companyId: null, actor: { companyId: null, type: 'user' } } },
];
const binding = { version: 1, companyId, projectId, boardUrl, connectionId, boardId: 'PVT_12',
  accountId: 42, login: 'example', boundByUserId: 'synthetic-operator', boundAt: '2026-10-13T00:00:00Z' };
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown>[] = [];
  const responses: Record<string, unknown> = { readProjectBinding: binding, bindProjectBoard: binding,
    listProjectConnections: { companyId, projectId, connections: [{ connectionId, name: 'Synthetic native OAuth',
      accountId: 42, login: 'example', lastVerifiedAt: null }] },
    readProjectPage: { user: { projectV2: { id: 'PVT_12', url: boardUrl, title: 'Synthetic board',
      updatedAt: '2026-10-13T00:00:00Z', items: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } },
    ...overrides };
  return { calls, actions: createProjectBoardOAuth({ importedBoard: async (request: Record<string, unknown>) => {
    calls.push(request); return responses[request.op as string];
  } }) };
}
test('explicit native options, binding save and readback return no credential values or task writes', async () => {
  const { actions, calls } = fixture();
  const list = await actions.list(input, context);
  assert.equal(list.connections.length, 1);
  assert.deepEqual(await actions.bind(input, context), binding);
  assert.deepEqual(calls.map(item => item.op), ['listProjectConnections', 'bindProjectBoard', 'readProjectBinding']);
  assert.ok(calls.every(item => !('query' in item) && !('headers' in item) && !('token' in item)));
});
test('repeated binding uses one explicit connection, never picks the first connection', async () => {
  const { actions, calls } = fixture();
  await actions.bind(input, context); await actions.bind(input, context);
  assert.equal(calls.filter(item => item.op === 'bindProjectBoard').length, 2);
  await assert.rejects(actions.bind({ ...input, connectionId: undefined }, context), /Explicitly select/);
  assert.equal(calls.length, 4);
});
for (const operation of ['list', 'get', 'bind'] as const) {
  for (const invalid of nullContexts) {
    test(`rejects null ${invalid.name} for ${operation} before any host call`, async () => {
      const { actions, calls } = fixture();
      await assert.rejects(actions[operation](input, invalid.value), /matching company\/project scope/);
      assert.equal(calls.length, 0);
    });
  }
}
test('reader converts only the incumbent fixed query into a typed page request', async () => {
  const { actions, calls } = fixture();
  const graphql = await actions.getGraphql(companyId, projectId);
  const preview = await readProjectPreview(graphql, { ownerType: 'user', owner: 'example', number: 12, url: boardUrl });
  assert.equal(preview.complete, true);
  assert.equal(preview.totalCount, 0);
  assert.deepEqual(calls[1], { companyId, op: 'readProjectPage', projectId,
    page: { ownerType: 'user', owner: 'example', number: 12, after: null, first: 50 } });
  assert.ok(!JSON.stringify(calls).includes('Bearer'));
});
for (const actorType of ['agent', 'system', undefined]) test('rejects nonoperator ' + actorType + ' before host call', async () => {
  const { actions, calls } = fixture();
  await assert.rejects(actions.bind(input, { companyId, actor: { companyId, type: actorType } }));
  assert.equal(calls.length, 0);
});
for (const invalid of [
  { ...input, companyId: connectionId }, { ...input, projectId: '' }, { ...input, projectId: '---' },
]) test('rejects invalid/mismatched signed scope before host call ' + JSON.stringify(invalid), async () => {
  const { actions, calls } = fixture();
  await assert.rejects(actions.list(invalid, context)); assert.equal(calls.length, 0);
});
test('older host and no binding fail closed without PAT or SDK task fallback', async () => {
  await assert.rejects(createProjectBoardOAuth({}).getGraphql(companyId, projectId), /No PAT fallback/);
  const { actions, calls } = fixture({ readProjectBinding: null });
  await assert.rejects(actions.getGraphql(companyId, projectId), /No PAT fallback/);
  assert.deepEqual(calls.map(call => call.op), ['readProjectBinding']);
});
for (const altered of [
  { ...binding, companyId: connectionId }, { ...binding, projectId: connectionId },
  { ...binding, boardUrl: boardUrl + '?x=1' }, { ...binding, accountId: null },
  { ...binding, connectionId: 'bad' }, { ...binding, access_token: 'synthetic-secret' },
]) test('binding readback rejects hostile/foreign/incomplete metadata ' + JSON.stringify(altered), () => {
  assert.throws(() => checkedGitHubProjectBinding(altered, companyId, projectId));
});
test('unknown save outcome is redacted and never blindly retried', async () => {
  const calls: unknown[] = [];
  const actions = createProjectBoardOAuth({ importedBoard: async (request: unknown) => {
    calls.push(request); throw new Error('Bearer synthetic-secret');
  } });
  await assert.rejects(actions.bind(input, context), error => error instanceof Error
    && !error.message.includes('synthetic-secret') && error.message.includes('before retrying'));
  assert.equal(calls.length, 1);
});
test('saved association mismatch readback never repeats binding write', async () => {
  const { actions, calls } = fixture({ readProjectBinding: { ...binding, boardId: 'PVT_other' } });
  await assert.rejects(actions.bind(input, context), /readback is unverified/);
  assert.equal(calls.filter(call => call.op === 'bindProjectBoard').length, 1);
});
for (const variables of [
  { owner: 'other', number: 12, after: null, first: 50 },
  { owner: 'example', number: 11, after: null, first: 50 },
  { owner: 'example', number: 12, after: null, first: 51 },
  { owner: 'example', number: 12, after: null, first: 50, url: 'https://evil.test' },
  { owner: 'example', number: 12, after: 'https://evil.test', first: 50 },
]) test('fixed reader rejects altered board/pagination/URLs ' + JSON.stringify(variables), async () => {
  const { actions, calls } = fixture(); const graphql = await actions.getGraphql(companyId, projectId);
  await assert.rejects(graphql(projectItemsQuery('user'), variables, AbortSignal.timeout(1000)));
  assert.equal(calls.length, 1);
});
test('arbitrary GraphQL mutation is never forwarded', async () => {
  const { actions, calls } = fixture(); const graphql = await actions.getGraphql(companyId, projectId);
  await assert.rejects(graphql('mutation{deleteProjectV2{clientMutationId}}', {}, AbortSignal.timeout(1000)));
  assert.equal(calls.length, 1);
});
test('aborted reader never starts a page call', async () => {
  const { actions, calls } = fixture(); const graphql = await actions.getGraphql(companyId, projectId);
  const controller = new AbortController(); controller.abort(new Error('synthetic cancel'));
  await assert.rejects(graphql(projectItemsQuery('user'), { owner: 'example', number: 12, after: null, first: 50 }, controller.signal));
  assert.equal(calls.length, 1);
});
test('options reject unexpected credential metadata', async () => {
  const { actions } = fixture({ listProjectConnections: { companyId, projectId,
    connections: [{ connectionId, name: 'Fixture', accountId: 42, login: 'example', lastVerifiedAt: null, token: 'no' }] } });
  await assert.rejects(actions.list(input, context));
});
