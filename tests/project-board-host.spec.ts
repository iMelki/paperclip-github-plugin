import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  createNativeBoardImportHost, readBoardImportExclusions, isManualBoardOrigin,
} from '../src/project-board-host.ts';
import {
  createProjectBoardSyncActions, type BoardImportCapabilities, type BoardImportIntent,
  type BoardImportOperation, type BoardImportReceipt, type BoardImportTask,
} from '../src/project-board-sync.ts';

type JsonRecord = Record<string, unknown>;
const companyId = 'company-asi';
const projectId = 'project-memsys';
const operationId = 'a'.repeat(64);
const sourceUrl = 'https://github.com/fixture/memsys/issues/1';
const caps: BoardImportCapabilities = { protocol: 'paperclip-github-board-import/v1',
  atomicTaskAndMembershipUpsert: true, durableNoDispatch: true, atomicOperationIntent: true };
const task: BoardImportTask = { id: 'task-1', companyId, projectId, githubIssueNodeId: 'issue-node-1',
  title: 'Synthetic issue', sourceUrl, status: 'backlog', assigneeAgentId: null, assigneeUserId: null,
  noDispatch: true };
const { id: _taskId, ...payload } = task;
const intent: BoardImportIntent = { operationId, intentHash: operationId, companyId, projectId,
  taskKey: 'b'.repeat(64), membershipKey: 'c'.repeat(64), boardId: 'board-12', boardItemId: 'item-1',
  githubIssueNodeId: task.githubIssueNodeId, boardUrl: 'https://github.com/users/fixture/projects/12',
  sourceUpdatedAt: '2026-10-12T00:00:00Z', task: payload, fields: [{ name: 'Readiness', value: 'Ready for Agent' }] };
const operation: BoardImportOperation = { operationId, intentHash: operationId, companyId, projectId,
  intent, state: 'committed' };
const receipt: BoardImportReceipt = { operationId, task,
  membership: { key: intent.membershipKey, companyId, projectId, boardId: intent.boardId,
    boardItemId: intent.boardItemId, githubIssueNodeId: task.githubIssueNodeId, taskId: task.id,
    boardUrl: intent.boardUrl, sourceUpdatedAt: intent.sourceUpdatedAt, fields: intent.fields }, createdTask: true };

function readers() {
  const ledger = { projects: 0, credentials: 0, graphs: 0 };
  return { ledger, getProject: async (id: string, company: string) => {
    ledger.projects++; return { id, companyId: company };
  }, getGraphql: async () => {
    ledger.credentials++; return async () => { ledger.graphs++; throw new Error('No GraphQL expected in adapter tests'); };
  } };
}

test('old host reports unavailable capabilities and never falls back to SDK create, update or wakeup', async () => {
  const sideEffects: string[] = [];
  const client = {
    create: async () => { sideEffects.push('create'); throw new Error('Forbidden SDK fallback'); },
    update: async () => { sideEffects.push('update'); throw new Error('Forbidden SDK fallback'); },
    requestWakeup: async () => { sideEffects.push('wakeup'); throw new Error('Forbidden SDK fallback'); },
  };
  const source = readers(); const host = createNativeBoardImportHost(client, source);
  assert.equal(await host.getCapabilities(companyId), null);
  assert.equal(await host.readTask(companyId, task.githubIssueNodeId), null);
  await assert.rejects(host.beginOperation(intent, new AbortController().signal), /host is unavailable/);
  await assert.rejects(host.commitIssueAndMembershipAtomically(intent, new AbortController().signal), /host is unavailable/);
  const actions = createProjectBoardSyncActions(host);
  await assert.rejects(actions.execute({ companyId, projectId, boardUrl: intent.boardUrl, planId: 'unused' },
    { companyId, actor: { companyId, type: 'user' } }), /Import disabled/);
  assert.equal(source.ledger.credentials, 0); assert.deepEqual(sideEffects, []);
});

test('native adapter sends exact operation names, company scope and typed identity arguments', async () => {
  const requests: JsonRecord[] = [];
  const host = createNativeBoardImportHost({ importedBoard: async (request: JsonRecord) => {
    requests.push(request);
    switch (request.op) {
      case 'capabilities': return caps;
      case 'readTask': return task;
      case 'readOperation': return operation;
      case 'begin': return true;
      case 'commit': return { committed: true };
      case 'readReceipt': return receipt;
      default: throw new Error('Unexpected synthetic native operation');
    }
  } }, readers());
  assert.deepEqual(await host.getCapabilities(companyId), caps);
  assert.deepEqual(await host.readTask(companyId, task.githubIssueNodeId), task);
  assert.deepEqual(await host.readOperation(companyId, operationId), operation);
  assert.equal(await host.beginOperation(intent, new AbortController().signal), true);
  await host.commitIssueAndMembershipAtomically(intent, new AbortController().signal);
  assert.deepEqual(await host.readReceipt(companyId, operationId), receipt);
  assert.deepEqual(requests, [
    { companyId, op: 'capabilities' }, { companyId, op: 'readTask', githubIssueNodeId: task.githubIssueNodeId },
    { companyId, op: 'readOperation', operationId }, { companyId, op: 'begin', intent },
    { companyId, op: 'commit', intent }, { companyId, op: 'readReceipt', operationId },
  ]);
});

test('explicit native unsupported/fetch errors propagate and are not interpreted as empty saved state', async () => {
  const client = { importedBoard: async () => { throw new Error('Native API unsupported or fetch failed'); } };
  const host = createNativeBoardImportHost(client, readers());
  await assert.rejects(host.getCapabilities(companyId), /unsupported or fetch failed/);
  await assert.rejects(host.readTask(companyId, task.githubIssueNodeId), /unsupported or fetch failed/);
  await assert.rejects(host.readOperation(companyId, operationId), /unsupported or fetch failed/);
  await assert.rejects(host.readReceipt(companyId, operationId), /unsupported or fetch failed/);
  await assert.rejects(readBoardImportExclusions(client, companyId), /unsupported or fetch failed/);
});

test('malformed capability descriptors fail rather than becoming an implicit permission grant', async () => {
  for (const value of [undefined, false, [], {}, { ...caps, protocol: 'unknown' },
    { ...caps, durableNoDispatch: 'true' }, { protocol: caps.protocol }]) {
    const host = createNativeBoardImportHost({ importedBoard: async () => value }, readers());
    await assert.rejects(host.getCapabilities(companyId), /incomplete or mismatched/);
  }
  const host = createNativeBoardImportHost({ importedBoard: async () => ({ ...caps, durableNoDispatch: false }) }, readers());
  assert.equal((await host.getCapabilities(companyId))?.durableNoDispatch, false);
});

test('native task null is permitted but unknown, partial, foreign or different-identity records fail closed', async () => {
  const empty = createNativeBoardImportHost({ importedBoard: async () => null }, readers());
  assert.equal(await empty.readTask(companyId, task.githubIssueNodeId), null);
  for (const value of [{}, { ...task, companyId: 'company-other' }, { ...task, githubIssueNodeId: 'different' },
    { ...task, sourceUrl: 'https://evil.invalid/issues/1' }, { ...task, assigneeAgentId: undefined }]) {
    const host = createNativeBoardImportHost({ importedBoard: async () => value }, readers());
    await assert.rejects(host.readTask(companyId, task.githubIssueNodeId), /incomplete or mismatched/);
  }
});

test('native operation record must match requested company and exact operation identity', async () => {
  for (const value of [{}, { ...operation, companyId: 'company-other' }, { ...operation, operationId: 'other' },
    { ...operation, intentHash: 'other' }, { ...operation, intent: null }, { ...operation, state: 'unknown' }]) {
    const host = createNativeBoardImportHost({ importedBoard: async () => value }, readers());
    await assert.rejects(host.readOperation(companyId, operationId), /incomplete or mismatched/);
  }
});

test('native begin requires a Boolean result, not a truthy acknowledgement object', async () => {
  for (const value of [undefined, null, 'true', { acknowledged: true }, 1]) {
    const host = createNativeBoardImportHost({ importedBoard: async () => value }, readers());
    await assert.rejects(host.beginOperation(intent, new AbortController().signal), /incomplete or mismatched/);
  }
});

test('native receipt rejects partial or mismatched task/operation/company readback', async () => {
  for (const value of [{}, { ...receipt, operationId: 'other' }, { ...receipt, createdTask: 'true' },
    { ...receipt, task: { ...task, companyId: 'other' } }, { ...receipt, membership: { ...receipt.membership, companyId: 'other' } }]) {
    const host = createNativeBoardImportHost({ importedBoard: async () => value }, readers());
    await assert.rejects(host.readReceipt(companyId, operationId), /incomplete or mismatched/);
  }
});

test('old host has no native manual import enrollment sources and invokes no SDK mutation fallback', async () => {
  let mutations = 0;
  assert.deepEqual(await readBoardImportExclusions({ create: () => { mutations++; } }, companyId), new Set());
  assert.equal(mutations, 0);
});

test('complete native source exclusion set is exact company-scoped and deduplicated', async () => {
  const requests: unknown[] = [];
  const result = await readBoardImportExclusions({ importedBoard: async (request: unknown) => {
    requests.push(request); return { companyId, sourceUrls: [sourceUrl, sourceUrl] };
  } }, companyId);
  assert.deepEqual(result, new Set([sourceUrl]));
  assert.deepEqual(requests, [{ companyId, op: 'sources' }]);
});

const invalidSources: unknown[] = [
  null, undefined, [], {}, { companyId: 'other', sourceUrls: [] },
  { companyId, sourceUrls: null }, { companyId, sourceUrls: 'unknown' },
  { companyId, sourceUrls: [], errors: [{ message: 'partial response' }] },
  { companyId, sourceUrls: [], complete: false }, { companyId, sourceUrls: [], partial: true },
  { companyId, sourceUrls: [], hasNextPage: true }, { companyId, sourceUrls: [null] },
];
for (const [index, response] of invalidSources.entries()) {
  test(`unknown or partial exclusion state refuses stock enrollment ${index + 1}`, async () => {
    await assert.rejects(readBoardImportExclusions({ importedBoard: async () => response }, companyId),
      /isolation could not be verified/);
  });
}

const invalidUrls = [
  'http://github.com/fixture/memsys/issues/1', 'https://github.com.evil.invalid/fixture/memsys/issues/1',
  'https://synthetic:secret@github.com/fixture/memsys/issues/1', 'https://github.com/fixture/memsys/issues/0',
  'https://github.com/fixture/memsys/issues/01', 'https://github.com/fixture/memsys/issues/1?query=true',
  'https://github.com/fixture/memsys?query=/issues/1', 'https://github.com/fixture/../issues/1',
  'https://github.com/fixture/memsys/issues/1#fragment', 'https://github.com/fixture/memsys/issues/1\n',
  'https://github.com/fixture/memsys/pull/1',
];
for (const [index, url] of invalidUrls.entries()) {
  test(`host exclusion rejects noncanonical or malicious issue URL ${index + 1}`, async () => {
    await assert.rejects(readBoardImportExclusions({ importedBoard: async () => ({ companyId, sourceUrls: [url] }) }, companyId),
      /isolation could not be verified/);
  });
}

test('native exclusion list over its explicit size bound is refused, not partially accepted', async () => {
  await assert.rejects(readBoardImportExclusions({ importedBoard: async () => ({
    companyId, sourceUrls: Array(2001).fill(sourceUrl),
  }) }, companyId), /isolation could not be verified/);
});

test('manual/quarantine fence uses exact durable origin metadata, not prose or label hints', () => {
  for (const suffix of ['manual', 'quarantine']) {
    assert.equal(isManualBoardOrigin({ originKind: `plugin:paperclip-github-plugin:github-board-${suffix}` }), true);
  }
  assert.equal(isManualBoardOrigin({ originKind: 'plugin:paperclip-github-plugin:github-issue' }), false);
  assert.equal(isManualBoardOrigin({ description: 'github-board-manual', labels: ['quarantine'] } as never), false);
  for (const value of [undefined, null, {}, { originKind: null },
    { originKind: 'plugin:paperclip-github-plugin:github-board-manual-legacy' },
    { originKind: 'prefix plugin:paperclip-github-plugin:github-board-manual' },
    { originKind: 'plugin:other plugin:github-board-manual' },
    { originKind: 'plugin:paperclip-github-plugin:github-board-manual\n' },
    { originKind: 'plugin:paperclip-github-plugin:github-board-quarantine ' }]) {
    assert.equal(isManualBoardOrigin(value), false);
  }
});
