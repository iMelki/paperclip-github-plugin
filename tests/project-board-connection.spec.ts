import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createProjectBoardActions } from '../src/project-board-connection.ts';
import type { ProjectGraphql } from '../src/personal-projects.ts';

type Host = Parameters<typeof createProjectBoardActions>[0];
type Context = Parameters<ReturnType<typeof createProjectBoardActions>['preview']>[1];
type JsonRecord = Record<string, unknown>;
const companyId = 'company-asi';
const projectId = 'project-memsys';
const boardUrl = 'https://github.com/users/fixture-owner/projects/12';
const updatedAt = '2026-10-12T00:00:00Z';
const context: Context = { companyId, actor: { companyId, type: 'user' } };
const input = { companyId, projectId, boardUrl, boardId: 'board-12', updatedAt };

function response(options: { updatedAt?: string; totalCount?: number } = {}) {
  return { user: { projectV2: {
    id: 'board-12', title: 'Synthetic MemSys board', url: boardUrl,
    updatedAt: options.updatedAt ?? updatedAt,
    items: { totalCount: options.totalCount ?? 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
      id: 'item-1', isArchived: false,
      content: { __typename: 'Issue', id: 'issue-node-1', number: 7, title: 'Synthetic issue', state: 'OPEN',
        url: 'https://github.com/fixture-owner/memsys/issues/7', repository: { nameWithOwner: 'fixture-owner/memsys' } },
      fieldValues: { pageInfo: { hasNextPage: false }, nodes: [
        { name: 'Ready for Agent', field: { name: 'Readiness' } },
      ] },
    }] },
  } } };
}

function harness() {
  const records = new Map<string, unknown>();
  const ledger = {
    projectReads: [] as Array<{ projectId: string; companyId: string }>,
    credentialReads: [] as string[], graphqlCalls: 0,
    connectionReads: [] as string[], connectionWrites: [] as string[],
  };
  const graphql: ProjectGraphql = async (query, variables) => {
    ledger.graphqlCalls += 1;
    assert.match(query, /^\s*query\b/);
    assert.doesNotMatch(query, /\bmutation\b/);
    assert.equal(variables.owner, 'fixture-owner');
    assert.equal(variables.number, 12);
    return response();
  };
  const key = (company: string, project: string) => `${company}:${project}`;
  const host: Host = {
    async getProject(project, company) {
      ledger.projectReads.push({ projectId: project, companyId: company });
      return { id: projectId, companyId };
    },
    async getGraphql(company) { ledger.credentialReads.push(company); return graphql; },
    async getConnection(company, project) {
      const selected = key(company, project);
      ledger.connectionReads.push(selected);
      return records.get(selected) ?? null;
    },
    async setConnection(company, project, value) {
      const selected = key(company, project);
      ledger.connectionWrites.push(selected);
      records.set(selected, structuredClone(value));
    },
  };
  return { host, ledger, records, key: key(companyId, projectId), actions: createProjectBoardActions(host) };
}

async function assertSecretSafeRejection(action: Promise<unknown>, secret: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
}

test('preview performs no persisted-state reads or writes and imports no tasks', async () => {
  const fixture = harness();
  fixture.records.set(fixture.key, { boardId: 'existing-board' });
  const before = structuredClone([...fixture.records]);
  const preview = await fixture.actions.preview(input, context);
  assert.equal(preview.complete, true);
  assert.equal(preview.importEnabled, false);
  assert.deepEqual(preview.items[0].fields, [{ name: 'Readiness', value: 'Ready for Agent' }]);
  assert.equal('assigneeAgentId' in preview.items[0], false);
  assert.deepEqual([...fixture.records], before);
  assert.deepEqual(fixture.ledger.connectionReads, []);
  assert.deepEqual(fixture.ledger.connectionWrites, []);
  assert.deepEqual(fixture.ledger.credentialReads, [companyId]);
  assert.equal(fixture.ledger.graphqlCalls, 1);
});

const invalidContexts: Array<{ name: string; value: unknown }> = [
  { name: 'missing context', value: undefined },
  { name: 'missing host company', value: { companyId: null, actor: { companyId } } },
  { name: 'missing actor', value: { companyId } },
  { name: 'missing actor company', value: { companyId, actor: { companyId: null } } },
  { name: 'foreign actor company', value: { companyId, actor: { companyId: 'company-other' } } },
];
for (const candidate of invalidContexts) {
  test(`untrusted context rejects before project or credential access: ${candidate.name}`, async () => {
    const fixture = harness();
    await assert.rejects(fixture.actions.preview(input, candidate.value as Context), /matching company scope/);
    assert.deepEqual(fixture.ledger.projectReads, []);
    assert.deepEqual(fixture.ledger.credentialReads, []);
    assert.deepEqual(fixture.ledger.connectionWrites, []);
  });
}

test('input-company mismatch rejects preview, save and get before credentials or state access', async () => {
  const fixture = harness();
  const foreign = { ...input, companyId: 'company-other' };
  for (const operation of [
    () => fixture.actions.preview(foreign, context), () => fixture.actions.save(foreign, context),
    () => fixture.actions.get(foreign, context),
  ]) await assert.rejects(operation(), /matching company scope/);
  assert.deepEqual(fixture.ledger.projectReads, []);
  assert.deepEqual(fixture.ledger.credentialReads, []);
  assert.deepEqual(fixture.ledger.connectionReads, []);
  assert.deepEqual(fixture.ledger.connectionWrites, []);
});

test('foreign, mismatching or absent project rejects before credential resolution', async () => {
  for (const project of [null, { id: projectId, companyId: 'company-other' }, { id: 'project-other', companyId }]) {
    const fixture = harness();
    fixture.host.getProject = async () => project;
    await assert.rejects(fixture.actions.preview(input, context), /does not belong/);
    await assert.rejects(fixture.actions.save(input, context), /does not belong/);
    assert.deepEqual(fixture.ledger.credentialReads, []);
    assert.equal(fixture.ledger.graphqlCalls, 0);
    assert.deepEqual(fixture.ledger.connectionWrites, []);
  }
});

test('missing or blank destination project rejects before credentials', async () => {
  const fixture = harness();
  for (const project of [undefined, '', ' ', 12]) {
    await assert.rejects(fixture.actions.preview({ ...input, projectId: project }, context), /existing Paperclip project/);
  }
  assert.deepEqual(fixture.ledger.projectReads, []);
  assert.deepEqual(fixture.ledger.credentialReads, []);
});

test('hostile board URL rejects before credentials and before any persisted-state write', async () => {
  const fixture = harness();
  const hostile = { ...input, boardUrl: 'https://github.com.evil.invalid/users/fixture-owner/projects/12' };
  await assert.rejects(fixture.actions.preview(hostile, context), /board connection|exact HTTPS/);
  await assert.rejects(fixture.actions.save(hostile, context), /board connection|exact HTTPS/);
  assert.deepEqual(fixture.ledger.credentialReads, []);
  assert.equal(fixture.ledger.graphqlCalls, 0);
  assert.deepEqual(fixture.ledger.connectionWrites, []);
});

test('save association twice retains one stable company-project key, not a task-import result', async () => {
  const fixture = harness();
  const first = await fixture.actions.save(input, context);
  const second = await fixture.actions.save(input, context);
  assert.deepEqual(first, second);
  assert.equal(fixture.records.size, 1);
  assert.deepEqual([...fixture.records.keys()], [fixture.key]);
  assert.deepEqual(fixture.ledger.connectionWrites, [fixture.key, fixture.key]);
  assert.deepEqual(second, {
    companyId, projectId,
    reference: { ownerType: 'user', owner: 'fixture-owner', number: 12, url: boardUrl },
    boardId: 'board-12', title: 'Synthetic MemSys board', updatedAt,
    mode: 'reference-and-preview', importEnabled: false,
  });
  assert.equal('createdIssuesCount' in (second as JsonRecord), false);
  assert.equal('assigneeAgentId' in (second as JsonRecord), false);
});

test('saved association get uses trusted scope and does not resolve any GitHub credential', async () => {
  const fixture = harness();
  fixture.records.set(fixture.key, { boardId: 'board-12', importEnabled: false });
  assert.deepEqual(await fixture.actions.get(input, context), { boardId: 'board-12', importEnabled: false });
  assert.deepEqual(fixture.ledger.connectionReads, [fixture.key]);
  assert.deepEqual(fixture.ledger.credentialReads, []);
  assert.equal(fixture.ledger.graphqlCalls, 0);
  assert.deepEqual(fixture.ledger.connectionWrites, []);
});

for (const actorType of ['agent', 'system', undefined]) {
  test(`association save requires a signed-in user rather than actor type ${String(actorType)}`, async () => {
    const fixture = harness();
    const caller: Context = { companyId, actor: { companyId, type: actorType } };
    await assert.rejects(fixture.actions.save(input, caller), /Only a signed-in operator/);
    assert.deepEqual(fixture.ledger.projectReads, []);
    assert.deepEqual(fixture.ledger.credentialReads, []);
    assert.equal(fixture.ledger.graphqlCalls, 0);
    assert.deepEqual(fixture.ledger.connectionReads, []);
    assert.deepEqual(fixture.ledger.connectionWrites, []);
  });
}

test('company-authorized agent can preview and get but cannot acquire save authority', async () => {
  const fixture = harness();
  const caller: Context = { companyId, actor: { companyId, type: 'agent' } };
  const preview = await fixture.actions.preview(input, caller);
  assert.equal(preview.complete, true);
  assert.equal(await fixture.actions.get(input, caller), null);
  await assert.rejects(fixture.actions.save(input, caller), /Only a signed-in operator/);
  assert.deepEqual(fixture.ledger.connectionWrites, []);
  assert.equal(fixture.records.size, 0);
});

test('concurrent different-board saves select one connection and preserve the losing board conflict', async () => {
  const fixture = harness();
  const otherUrl = 'https://github.com/users/fixture-owner/projects/13';
  fixture.host.getGraphql = async () => async (query, variables) => {
    assert.doesNotMatch(query, /\bmutation\b/);
    const result = response();
    if (variables.number === 13) {
      result.user.projectV2.id = 'board-13';
      result.user.projectV2.url = otherUrl;
      result.user.projectV2.title = 'Other synthetic board';
    }
    return result;
  };
  const results = await Promise.allSettled([
    fixture.actions.save(input, context),
    fixture.actions.save({ ...input, boardUrl: otherUrl, boardId: 'board-13' }, context),
  ]);
  const successes = results.filter(result => result.status === 'fulfilled');
  const conflicts = results.filter(result => result.status === 'rejected');
  assert.equal(successes.length, 1);
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0].status === 'rejected');
  assert.match(String(conflicts[0].reason), /different board connection/);
  assert.equal(fixture.records.size, 1);
  assert.deepEqual(fixture.ledger.connectionWrites, [fixture.key]);
  assert.ok(successes[0].status === 'fulfilled');
  assert.deepEqual(fixture.records.get(fixture.key), successes[0].value);
});

test('save readback permits equivalent JSON property order without inventing a verification failure', async () => {
  const fixture = harness();
  fixture.host.setConnection = async (_company, _project, value) => {
    fixture.ledger.connectionWrites.push(fixture.key);
    fixture.records.set(fixture.key, Object.fromEntries(Object.entries(value).reverse()));
  };
  const saved = await fixture.actions.save(input, context);
  assert.deepEqual(saved, fixture.records.get(fixture.key));
  assert.equal((saved as JsonRecord).boardId, 'board-12');
  assert.deepEqual(fixture.ledger.connectionWrites, [fixture.key]);
});

test('stale board ID or timestamp refuses saving and preserves existing state', async () => {
  for (const stale of [{ boardId: 'board-other' }, { updatedAt: '2026-10-11T00:00:00Z' }]) {
    const fixture = harness();
    fixture.records.set(fixture.key, { boardId: 'board-12', title: 'Retained' });
    const before = structuredClone([...fixture.records]);
    await assert.rejects(fixture.actions.save({ ...input, ...stale }, context), /preview is stale/);
    assert.deepEqual([...fixture.records], before);
    assert.deepEqual(fixture.ledger.connectionWrites, []);
  }
});

test('board changing after the displayed preview refuses saving its association', async () => {
  const fixture = harness();
  fixture.host.getGraphql = async () => async () => response({ updatedAt: '2026-10-12T00:01:00Z' });
  await assert.rejects(fixture.actions.save(input, context), /preview is stale/);
  assert.deepEqual(fixture.ledger.connectionWrites, []);
});

test('incomplete preview cannot be saved even if board identity and timestamp match', async () => {
  const fixture = harness();
  fixture.host.getGraphql = async () => async () => response({ totalCount: 2 });
  const preview = await fixture.actions.preview(input, context);
  assert.equal(preview.complete, false);
  await assert.rejects(fixture.actions.save(input, context), /complete board preview/);
  assert.deepEqual(fixture.ledger.connectionWrites, []);
});

test('different preexisting board is preserved, never silently replaced', async () => {
  const fixture = harness();
  const original = { boardId: 'board-other', title: 'Keep existing connection', marker: 'retain' };
  fixture.records.set(fixture.key, original);
  await assert.rejects(fixture.actions.save(input, context), /different board connection/);
  assert.deepEqual(fixture.records.get(fixture.key), original);
  assert.deepEqual(fixture.ledger.connectionWrites, []);
});

test('credential and transport errors are redacted without writes or retry', async () => {
  const secret = 'synthetic_secret_marker';
  for (const failCredential of [true, false]) {
    const fixture = harness();
    fixture.host.getGraphql = async () => {
      fixture.ledger.credentialReads.push(companyId);
      if (failCredential) throw new Error(`credential ${secret}`);
      return async () => { fixture.ledger.graphqlCalls += 1; throw new Error(`transport ${secret}`); };
    };
    await assertSecretSafeRejection(fixture.actions.preview(input, context), secret);
    assert.equal(fixture.ledger.credentialReads.length, 1);
    assert.equal(fixture.ledger.graphqlCalls, failCredential ? 0 : 1);
    assert.deepEqual(fixture.ledger.connectionWrites, []);
  }
});

test('unknown write result does not retry and redacts backend error details', async () => {
  const fixture = harness();
  const secret = 'synthetic_secret_marker';
  fixture.host.setConnection = async (_company, _project, value) => {
    fixture.ledger.connectionWrites.push(fixture.key);
    fixture.records.set(fixture.key, structuredClone(value));
    throw new Error(`uncertain write ${secret}`);
  };
  await assertSecretSafeRejection(fixture.actions.save(input, context), secret);
  assert.deepEqual(fixture.ledger.connectionWrites, [fixture.key]);
  assert.equal(fixture.records.size, 1);
});

test('failed save readback retains its single write and never blindly retries', async () => {
  const fixture = harness();
  let reads = 0;
  fixture.host.getConnection = async () => ++reads === 1 ? null : { boardId: 'wrong-readback' };
  await assert.rejects(fixture.actions.save(input, context), /save was not verified.*do not blindly retry/);
  assert.equal(reads, 2);
  assert.deepEqual(fixture.ledger.connectionWrites, [fixture.key]);
  assert.equal(fixture.records.size, 1);
});

test('thrown save readback redacts errors while preserving the unknown saved result', async () => {
  const fixture = harness();
  const secret = 'synthetic_secret_marker';
  let reads = 0;
  fixture.host.getConnection = async () => {
    if (++reads === 1) return null;
    throw new Error(`readback ${secret}`);
  };
  await assertSecretSafeRejection(fixture.actions.save(input, context), secret);
  assert.equal(reads, 2);
  assert.deepEqual(fixture.ledger.connectionWrites, [fixture.key]);
  assert.equal(fixture.records.size, 1);
});

test('initial connection-read failure and ordinary get failure expose no secret details', async () => {
  const secret = 'synthetic_secret_marker';
  const fixture = harness();
  fixture.host.getConnection = async () => { throw new Error(`read ${secret}`); };
  await assertSecretSafeRejection(fixture.actions.save(input, context), secret);
  await assertSecretSafeRejection(fixture.actions.get(input, context), secret);
  assert.deepEqual(fixture.ledger.connectionWrites, []);
});
