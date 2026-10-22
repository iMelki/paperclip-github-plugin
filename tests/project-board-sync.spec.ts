import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  createProjectBoardSyncActions,
  type BoardImportCapabilities, type BoardImportContext, type BoardImportInput,
  type BoardImportIntent, type BoardImportMembership, type BoardImportOperation,
  type BoardImportTask, type ProjectBoardSyncHost,
} from '../src/project-board-sync.ts';

type JsonRecord = Record<string, unknown>;
const context: BoardImportContext = { companyId: 'company-asi', actor: { companyId: 'company-asi', type: 'user' } };
const input: BoardImportInput = {
  companyId: 'company-asi', projectId: 'project-memsys', boardUrl: 'https://github.com/users/fixture/projects/12',
};
const neutralTask = {
  id: 'existing-task', companyId: input.companyId, projectId: input.projectId,
  githubIssueNodeId: 'github-issue-1', title: 'Issue 1', sourceUrl: 'https://github.com/fixture/memsys/issues/1',
  status: 'backlog', assigneeAgentId: null, assigneeUserId: null, noDispatch: true,
};

function item(id = 'item-1', issueNumber = 1): JsonRecord {
  return { id, isArchived: false, content: {
    __typename: 'Issue', id: `github-issue-${issueNumber}`, title: `Issue ${issueNumber}`,
    number: issueNumber, state: 'OPEN', url: `https://github.com/fixture/memsys/issues/${issueNumber}`,
    repository: { nameWithOwner: 'fixture/memsys' },
  }, fieldValues: { pageInfo: { hasNextPage: false }, nodes: [
    { name: 'Ready for Agent', field: { name: 'Readiness' } },
  ] } };
}

function response(number: number, items: JsonRecord[], updatedAt = '2026-10-12T00:00:00Z', total = items.length) {
  return { user: { projectV2: {
    id: `board-${number}`, title: `Board ${number}`, url: `https://github.com/users/fixture/projects/${number}`,
    updatedAt, items: { totalCount: total, pageInfo: { hasNextPage: false, endCursor: null }, nodes: items },
  } } };
}

function harness() {
  const tasks = new Map<string, BoardImportTask>();
  const memberships = new Map<string, BoardImportMembership>();
  const operations = new Map<string, BoardImportOperation>();
  const receipts = new Map<string, { taskKey: string; membershipKey: string; createdTask: boolean }>();
  const ledger = { projectReads: 0, credentialReads: 0, graphReads: 0, capabilityReads: 0,
    begins: [] as BoardImportIntent[], commits: [] as BoardImportIntent[], forbidden: [] as string[] };
  let source = (number: number) => response(number, [item(`item-${number}`)]);
  let taskSequence = 0;
  const caps: BoardImportCapabilities = { protocol: 'paperclip-github-board-import/v1',
    atomicTaskAndMembershipUpsert: true, durableNoDispatch: true, atomicOperationIntent: true };
  const host: ProjectBoardSyncHost = {
    async getProject(projectId, companyId) { ledger.projectReads++; return { id: projectId, companyId }; },
    async getGraphql() {
      ledger.credentialReads++;
      return async (query, variables) => {
        ledger.graphReads++;
        assert.match(query, /^\s*query\b/); assert.doesNotMatch(query, /\bmutation\b/);
        return source(Number(variables.number));
      };
    },
    async getCapabilities() { ledger.capabilityReads++; return { ...caps }; },
    async readTask(companyId, issueId) {
      return [...tasks.values()].find(task => task.companyId === companyId && task.githubIssueNodeId === issueId) ?? null;
    },
    async readOperation(companyId, operationId) {
      const retained = operations.get(operationId);
      return retained?.companyId === companyId ? retained : null;
    },
    async beginOperation(intent) {
      ledger.begins.push(structuredClone(intent));
      if (operations.has(intent.operationId)) return false;
      operations.set(intent.operationId, { operationId: intent.operationId, intentHash: intent.intentHash,
        companyId: intent.companyId, projectId: intent.projectId, intent: structuredClone(intent), state: 'prepared' });
      return true;
    },
    async commitIssueAndMembershipAtomically(intent) { commit(intent); },
    async readReceipt(companyId, operationId) {
      const receipt = receipts.get(operationId);
      if (!receipt) return null;
      const task = tasks.get(receipt.taskKey);
      const membership = memberships.get(receipt.membershipKey);
      if (!task || !membership || task.companyId !== companyId) return null;
      return { operationId, task: structuredClone(task), membership: structuredClone(membership),
        createdTask: receipt.createdTask };
    },
  };
  function commit(intent: BoardImportIntent) {
    ledger.commits.push(structuredClone(intent));
    const existing = tasks.get(intent.taskKey);
    if (existing && (existing.companyId !== intent.companyId || existing.projectId !== intent.projectId
      || existing.status !== 'backlog' || existing.assigneeAgentId || existing.assigneeUserId || !existing.noDispatch)) {
      throw new Error('Synthetic atomic destination/state conflict');
    }
    assert.equal(intent.task.status, 'backlog'); assert.equal(intent.task.noDispatch, true);
    assert.equal(intent.task.assigneeAgentId, null); assert.equal(intent.task.assigneeUserId, null);
    const task = { ...intent.task, id: existing?.id ?? `task-${++taskSequence}` };
    const membership: BoardImportMembership = { key: intent.membershipKey, companyId: intent.companyId,
      projectId: intent.projectId, boardId: intent.boardId, boardItemId: intent.boardItemId,
      githubIssueNodeId: intent.githubIssueNodeId, taskId: task.id, boardUrl: intent.boardUrl,
      sourceUpdatedAt: intent.sourceUpdatedAt, fields: structuredClone(intent.fields) };
    // One synchronous synthetic transaction models the REQUIRED host primitive, not a native-host proof.
    tasks.set(intent.taskKey, task); memberships.set(intent.membershipKey, membership);
    receipts.set(intent.operationId, { taskKey: intent.taskKey, membershipKey: intent.membershipKey, createdTask: !existing });
    operations.set(intent.operationId, { operationId: intent.operationId, intentHash: intent.intentHash,
      companyId: intent.companyId, projectId: intent.projectId, intent: structuredClone(intent), state: 'committed' });
  }
  return { host, caps, tasks, memberships, operations, receipts, ledger,
    actions: createProjectBoardSyncActions(host), setSource: (value: typeof source) => { source = value; } };
}

async function execute(fixture: ReturnType<typeof harness>, selected = input) {
  const plan = await fixture.actions.plan(selected, context);
  return fixture.actions.execute({ ...selected, planId: plan.planId }, context);
}
function assertNoWrites(fixture: ReturnType<typeof harness>) {
  assert.equal(fixture.ledger.begins.length, 0); assert.equal(fixture.ledger.commits.length, 0);
  assert.equal(fixture.memberships.size, 0); assert.equal(fixture.operations.size, 0);
  assert.deepEqual(fixture.ledger.forbidden, []);
}

test('plan is read-only, defaults to one item and retains readiness as metadata', async () => {
  const fixture = harness();
  fixture.setSource(number => response(number, [item('item-1'), item('item-2', 2)]));
  const plan = await fixture.actions.plan(input, context);
  assert.equal(plan.supported, true); assert.equal(plan.intents.length, 1);
  assert.deepEqual(plan.selectedItemIds, ['item-1']);
  assert.deepEqual(plan.intents[0].fields, [{ name: 'Readiness', value: 'Ready for Agent' }]);
  assert.equal(plan.intents[0].task.assigneeAgentId, null); assert.equal(plan.intents[0].task.status, 'backlog');
  assert.deepEqual(plan.rows, [{ boardItemId: 'item-1', disposition: 'create', existingTaskId: null }]);
  assertNoWrites(fixture); assert.equal(fixture.tasks.size, 0);
});

test('same import twice creates one stable task, membership and operation with no dispatch', async () => {
  const fixture = harness();
  const first = await execute(fixture); const second = await execute(fixture);
  assert.equal(first.complete, true); assert.equal(first.createdCount, 1);
  assert.equal(second.createdCount, 0); assert.equal(second.reusedCount, 1);
  assert.equal(first.results[0].taskId, second.results[0].taskId);
  assert.equal(fixture.tasks.size, 1); assert.equal(fixture.memberships.size, 1); assert.equal(fixture.operations.size, 1);
  assert.equal(fixture.ledger.begins.length, 1); assert.equal(fixture.ledger.commits.length, 1);
  assert.deepEqual(fixture.ledger.forbidden, []);
});

test('overlapping boards share one task while retaining two independent memberships', async () => {
  const fixture = harness();
  const first = await execute(fixture);
  const second = await execute(fixture, { ...input, boardUrl: 'https://github.com/users/fixture/projects/13' });
  assert.equal(first.createdCount + second.createdCount, 1); assert.equal(second.reusedCount, 1);
  assert.equal(first.results[0].taskId, second.results[0].taskId);
  assert.equal(fixture.tasks.size, 1); assert.equal(fixture.memberships.size, 2);
  assert.deepEqual([...fixture.memberships.values()].map(value => value.boardId).sort(), ['board-12', 'board-13']);
  assert.equal(fixture.ledger.commits[0].taskKey, fixture.ledger.commits[1].taskKey);
  assert.notEqual(fixture.ledger.commits[0].membershipKey, fixture.ledger.commits[1].membershipKey);
});

test('two board items for the same GitHub node also share one task', async () => {
  const fixture = harness();
  fixture.setSource(number => response(number, [item('item-a'), item('item-b')]));
  const result = await execute(fixture, { ...input, selectedItemIds: ['item-a', 'item-b'], maxSelected: 2 });
  assert.equal(result.createdCount, 1); assert.equal(result.reusedCount, 1);
  assert.equal(fixture.tasks.size, 1); assert.equal(fixture.memberships.size, 2);
});

test('twenty selected imports are bounded and sequential', async () => {
  const fixture = harness(); const items = Array.from({ length: 20 }, (_, index) => item(`item-${index}`, index + 1));
  fixture.setSource(number => response(number, items));
  let active = 0; let maximum = 0;
  const commit = fixture.host.commitIssueAndMembershipAtomically;
  fixture.host.commitIssueAndMembershipAtomically = async (intent, signal) => {
    active++; maximum = Math.max(maximum, active); await Promise.resolve();
    try { await commit(intent, signal); } finally { active--; }
  };
  const result = await execute(fixture, { ...input, selectedItemIds: items.map(value => String(value.id)), maxSelected: 20 });
  assert.equal(result.createdCount, 20); assert.equal(maximum, 1); assert.equal(result.deferredCount, 0);
});

test('overlarge, duplicate or absent selections refuse before any write', async () => {
  for (const selection of [
    { selectedItemIds: ['item-12', 'item-12'], maxSelected: 2 },
    { selectedItemIds: ['missing'] }, { maxSelected: 21 },
    { selectedItemIds: ['item-12', 'missing'], maxSelected: 1 },
  ]) {
    const fixture = harness();
    await assert.rejects(fixture.actions.plan({ ...input, ...selection }, context)); assertNoWrites(fixture);
  }
});

for (const disabled of ['atomicTaskAndMembershipUpsert', 'durableNoDispatch', 'atomicOperationIntent'] as const) {
  test(`missing host guarantee ${disabled} fails closed before credentials and all writes`, async () => {
    const fixture = harness(); fixture.caps[disabled] = false;
    await assert.rejects(fixture.actions.execute({ ...input, planId: 'unused' }, context), /Import disabled/);
    assert.equal(fixture.ledger.credentialReads, 0); assertNoWrites(fixture);
  });
}

test('missing capability provider, missing atomic method or wrong protocol cannot authorize writes', async () => {
  for (const missing of ['getCapabilities', 'commitIssueAndMembershipAtomically', 'readReceipt']) {
    const fixture = harness(); delete (fixture.host as unknown as JsonRecord)[missing];
    await assert.rejects(fixture.actions.execute({ ...input, planId: 'unused' }, context), /Import disabled/);
    assertNoWrites(fixture);
  }
  const fixture = harness(); fixture.host.getCapabilities = async () => null;
  await assert.rejects(fixture.actions.execute(input, context), /Import disabled/); assertNoWrites(fixture);
  fixture.host.getCapabilities = async () => ({ ...fixture.caps,
    protocol: 'unsupported' as BoardImportCapabilities['protocol'] });
  await assert.rejects(fixture.actions.execute(input, context), /Import disabled/); assertNoWrites(fixture);
});

test('concurrent repeated execution relies on the host atomic claim, not an in-process import mutex', async () => {
  const fixture = harness(); const plan = await fixture.actions.plan(input, context);
  const selected = { ...input, planId: plan.planId };
  const results = await Promise.all([
    fixture.actions.execute(selected, context), fixture.actions.execute(selected, context),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.createdCount, 0), 1);
  assert.equal(fixture.tasks.size, 1); assert.equal(fixture.memberships.size, 1);
  assert.equal(fixture.ledger.commits.length, 1);
  const recovered = await fixture.actions.execute(selected, context);
  assert.equal(recovered.reusedCount, 1); assert.equal(fixture.ledger.commits.length, 1);
});

test('concurrent overlapping-board operations use one atomic company-issue task identity', async () => {
  const fixture = harness(); const other = { ...input, boardUrl: 'https://github.com/users/fixture/projects/13' };
  const plans = await Promise.all([fixture.actions.plan(input, context), fixture.actions.plan(other, context)]);
  const results = await Promise.all([
    fixture.actions.execute({ ...input, planId: plans[0].planId }, context),
    fixture.actions.execute({ ...other, planId: plans[1].planId }, context),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.createdCount, 0), 1);
  assert.equal(fixture.tasks.size, 1); assert.equal(fixture.memberships.size, 2);
  assert.equal(results[0].results[0].taskId, results[1].results[0].taskId);
  assert.deepEqual(fixture.ledger.forbidden, []);
});

test('capability changes between admission and fresh plan refuse before intent persistence', async () => {
  const fixture = harness(); let reads = 0;
  fixture.host.getCapabilities = async () => ({ ...fixture.caps, durableNoDispatch: ++reads === 1 });
  await assert.rejects(fixture.actions.execute({ ...input, planId: 'unused' }, context), /guarantees changed/);
  assertNoWrites(fixture);
});

test('drafts, PRs, null content, closed and archived are skipped explicitly, never converted into tasks', async () => {
  const fixture = harness();
  const draft = { ...item('draft'), content: { __typename: 'DraftIssue', title: 'Draft' } };
  const pr = { ...item('pr'), content: { __typename: 'PullRequest', title: 'PR',
    url: 'https://github.com/fixture/memsys/pull/1', repository: { nameWithOwner: 'fixture/memsys' } } };
  const closed = item('closed'); (closed.content as JsonRecord).state = 'CLOSED';
  const archived = { ...item('archived'), isArchived: true }; const inaccessible = { ...item('null'), content: null };
  fixture.setSource(number => response(number, [item('open'), draft, pr, closed, archived, inaccessible]));
  const selected = { ...input, selectedItemIds: ['open', 'draft', 'pr', 'closed', 'archived', 'null'], maxSelected: 6 };
  const plan = await fixture.actions.plan(selected, context);
  assert.equal(plan.skipped.length, 5);
  const result = await fixture.actions.execute({ ...selected, planId: plan.planId }, context);
  assert.equal(result.createdCount, 1); assert.equal(result.skippedCount, 5); assert.equal(fixture.tasks.size, 1);
});

test('partial preview and stale plan are rejected without any operations', async () => {
  const fixture = harness(); fixture.setSource(number => response(number, [item()], undefined, 2));
  await assert.rejects(fixture.actions.plan(input, context), /complete board preview/); assertNoWrites(fixture);
  fixture.setSource(number => response(number, [item()]));
  const plan = await fixture.actions.plan(input, context);
  fixture.setSource(number => response(number, [item()], '2026-10-12T00:01:00Z'));
  await assert.rejects(fixture.actions.execute({ ...input, planId: plan.planId }, context), /stale or missing/);
  assertNoWrites(fixture);
});

test('existing task in another project is a preserved conflict, not a move', async () => {
  const fixture = harness(); const foreign = { ...neutralTask, projectId: 'other-project' };
  fixture.tasks.set('retained-foreign', foreign);
  const result = await execute(fixture);
  assert.equal(result.conflictCount, 1); assert.equal(result.complete, false);
  assert.deepEqual(fixture.tasks.get('retained-foreign'), foreign); assertNoWrites(fixture);
});

test('existing assigned, active or dispatch-capable tasks remain untouched', async () => {
  for (const patch of [{ assigneeAgentId: 'existing-agent' }, { assigneeUserId: 'existing-user' },
    { status: 'in_progress' }, { noDispatch: false }]) {
    const fixture = harness(); const retained = { ...neutralTask, ...patch };
    fixture.tasks.set('retained', retained); const result = await execute(fixture);
    assert.equal(result.conflictCount, 1); assert.deepEqual(fixture.tasks.get('retained'), retained);
    assertNoWrites(fixture);
  }
});

test('foreign company, foreign project and nonoperator execution fail before credential access', async () => {
  const fixture = harness();
  await assert.rejects(fixture.actions.execute({ ...input, companyId: 'other' }, context), /matching company/);
  await assert.rejects(fixture.actions.execute(input, { ...context, actor: { companyId: 'other', type: 'user' } }),
    /matching company/);
  await assert.rejects(fixture.actions.execute(input, { ...context, actor: { companyId: input.companyId, type: 'agent' } }),
    /signed-in operator/);
  fixture.host.getProject = async () => ({ id: input.projectId, companyId: 'other' });
  await assert.rejects(fixture.actions.plan(input, context), /does not belong/);
  assert.equal(fixture.ledger.credentialReads, 0); assertNoWrites(fixture);
});

test('hostile board URL cannot reach credentials or writes', async () => {
  const fixture = harness();
  await assert.rejects(fixture.actions.plan({ ...input, boardUrl: 'https://evil.invalid/users/fixture/projects/12' }, context),
    /exact HTTPS/);
  assert.equal(fixture.ledger.credentialReads, 0); assertNoWrites(fixture);
});

test('precommit failure retains intent and repeat execution does not blindly retry the write', async () => {
  const fixture = harness(); let attempts = 0;
  fixture.host.commitIssueAndMembershipAtomically = async () => { attempts++; throw new Error('synthetic_secret_marker'); };
  const first = await execute(fixture); const second = await execute(fixture);
  assert.equal(first.heldCount, 1); assert.equal(second.heldCount, 1); assert.equal(attempts, 1);
  assert.equal(fixture.operations.size, 1); assert.equal([...fixture.operations.values()][0].state, 'prepared');
  assert.equal(fixture.tasks.size, 0); assert.doesNotMatch(JSON.stringify(first), /synthetic_secret_marker/);
});

test('postcommit acknowledgement failure is recovered only through authoritative receipt readback', async () => {
  const fixture = harness(); const commit = fixture.host.commitIssueAndMembershipAtomically;
  fixture.host.commitIssueAndMembershipAtomically = async (intent, signal) => {
    await commit(intent, signal); throw new Error('synthetic_secret_marker');
  };
  const first = await execute(fixture); const second = await execute(fixture);
  assert.equal(first.createdCount, 1); assert.equal(first.complete, true); assert.equal(second.reusedCount, 1);
  assert.equal(fixture.ledger.commits.length, 1); assert.equal(fixture.tasks.size, 1);
  assert.doesNotMatch(JSON.stringify(first), /synthetic_secret_marker/);
});

test('unknown intent claim outcome never invokes the task upsert', async () => {
  const fixture = harness(); const begin = fixture.host.beginOperation;
  fixture.host.beginOperation = async (intent, signal) => { await begin(intent, signal); throw new Error('synthetic_secret_marker'); };
  const result = await execute(fixture);
  assert.equal(result.heldCount, 1); assert.equal(fixture.operations.size, 1);
  assert.equal(fixture.ledger.commits.length, 0); assert.equal(fixture.tasks.size, 0);
});

test('missing or failing receipt preserves unknown saved results and never retries commit', async () => {
  for (const fail of [false, true]) {
    const fixture = harness(); fixture.host.readReceipt = async () => {
      if (fail) throw new Error('synthetic_secret_marker'); return null;
    };
    const first = await execute(fixture); const second = await execute(fixture);
    assert.equal(first.heldCount, 1); assert.equal(second.heldCount, 1);
    assert.equal(fixture.tasks.size, 1); assert.equal(fixture.ledger.commits.length, 1);
    assert.doesNotMatch(JSON.stringify(first), /synthetic_secret_marker/);
  }
});

test('wrong company or board membership readback is held rather than counted as imported', async () => {
  for (const mismatch of ['company', 'board']) {
    const fixture = harness(); const read = fixture.host.readReceipt;
    fixture.host.readReceipt = async (company, operation) => {
      const receipt = await read(company, operation); if (!receipt) return null;
      if (mismatch === 'company') receipt.task.companyId = 'other'; else receipt.membership.boardId = 'other';
      return receipt;
    };
    const result = await execute(fixture); assert.equal(result.heldCount, 1); assert.equal(result.createdCount, 0);
    assert.equal(fixture.ledger.commits.length, 1);
  }
});

test('uncertain first item stops the batch and reports the remaining selection as deferred', async () => {
  const fixture = harness(); fixture.setSource(number => response(number, [item('first'), item('second', 2)]));
  fixture.host.commitIssueAndMembershipAtomically = async () => { throw new Error('synthetic failure'); };
  const result = await execute(fixture, { ...input, selectedItemIds: ['first', 'second'], maxSelected: 2 });
  assert.equal(result.heldCount, 1); assert.equal(result.deferredCount, 1); assert.equal(result.complete, false);
  assert.equal(fixture.ledger.begins.length, 1); assert.equal(fixture.tasks.size, 0);
});

test('host atomic transaction enforces destination conflict even when preflight reads race', async () => {
  const fixture = harness(); const plan = await fixture.actions.plan(input, context);
  const intent = plan.intents[0]; const retained = { ...neutralTask, projectId: 'other-project' };
  fixture.tasks.set(intent.taskKey, retained);
  fixture.host.readTask = async () => null; // Deliberately stale reader; native transaction must still refuse.
  const result = await fixture.actions.execute({ ...input, planId: plan.planId }, context);
  assert.equal(result.heldCount, 1); assert.deepEqual(fixture.tasks.get(intent.taskKey), retained);
  assert.equal(fixture.memberships.size, 0); assert.equal(fixture.tasks.size, 1);
});

test('company participates in task identity independently of board membership identity', async () => {
  const fixture = harness(); const plan = await fixture.actions.plan(input, context);
  const otherCompany = 'company-other';
  const otherContext = { companyId: otherCompany, actor: { companyId: otherCompany, type: 'user' } };
  const other = await fixture.actions.plan({ ...input, companyId: otherCompany }, otherContext);
  assert.notEqual(plan.intents[0].taskKey, other.intents[0].taskKey);
  assert.notEqual(plan.intents[0].membershipKey, other.intents[0].membershipKey);
  assert.equal(plan.intents[0].githubIssueNodeId, other.intents[0].githubIssueNodeId);
  assertNoWrites(fixture);
});

test('task-only plan dispositions distinguish create, update, unchanged and conflict without changing operation IDs', async () => {
  const fixture = harness(); const original = await fixture.actions.plan(input, context);
  await fixture.actions.execute({ ...input, planId: original.planId }, context);
  const unchanged = await fixture.actions.plan(input, context);
  assert.equal(unchanged.rows[0].disposition, 'unchanged');
  assert.equal(unchanged.rows[0].existingTaskId, [...fixture.tasks.values()][0].id);
  assert.equal(unchanged.intents[0].operationId, original.intents[0].operationId);
  [...fixture.tasks.values()][0].title = 'Locally changed title';
  const update = await fixture.actions.plan(input, context);
  assert.equal(update.rows[0].disposition, 'update');
  [...fixture.tasks.values()][0].projectId = 'other-project';
  const conflict = await fixture.actions.plan(input, context);
  assert.equal(conflict.rows[0].disposition, 'conflict');
});

test('read-only recovery verifies the saved task and membership without GraphQL, credentials or new writes', async () => {
  const fixture = harness(); const first = await execute(fixture);
  const operationIds = first.results.map(result => String(result.operationId));
  const before = { graph: fixture.ledger.graphReads, credentials: fixture.ledger.credentialReads,
    begins: fixture.ledger.begins.length, commits: fixture.ledger.commits.length };
  const caller = { ...context, actor: { companyId: input.companyId, type: 'agent' } };
  const recovered = await fixture.actions.recover({ ...input, operationIds }, caller);
  assert.equal(recovered.reusedCount, 1); assert.equal(recovered.createdCount, 0);
  assert.equal(recovered.results[0].taskId, first.results[0].taskId);
  assert.deepEqual({ graph: fixture.ledger.graphReads, credentials: fixture.ledger.credentialReads,
    begins: fixture.ledger.begins.length, commits: fixture.ledger.commits.length }, before);
});

test('read-only recovery holds a prepared operation and never resumes its unverified commit', async () => {
  const fixture = harness(); const plan = await fixture.actions.plan(input, context);
  await fixture.host.beginOperation(plan.intents[0], new AbortController().signal);
  const result = await fixture.actions.recover({ ...input, operationIds: [plan.intents[0].operationId] }, context);
  assert.equal(result.heldCount, 1); assert.equal(fixture.ledger.commits.length, 0);
  assert.equal(fixture.tasks.size, 0); assert.equal(fixture.ledger.begins.length, 1);
});

test('recovery refuses wrong project or board operation scope without reading its receipt', async () => {
  const fixture = harness(); const imported = await execute(fixture);
  const operationIds = imported.results.map(result => String(result.operationId));
  let receiptReads = 0; const read = fixture.host.readReceipt;
  fixture.host.readReceipt = async (company, operation) => { receiptReads++; return read(company, operation); };
  const wrongProject = await fixture.actions.recover({ ...input, projectId: 'other-project', operationIds }, context);
  const wrongBoard = await fixture.actions.recover({ ...input,
    boardUrl: 'https://github.com/users/fixture/projects/13', operationIds }, context);
  assert.equal(wrongProject.heldCount, 1); assert.equal(wrongBoard.heldCount, 1); assert.equal(receiptReads, 0);
});

test('recovery validates bounded operation identifiers and trusted company scope before any write', async () => {
  const fixture = harness();
  for (const operationIds of [[], ['bad'], ['a'.repeat(64), 'a'.repeat(64)], Array(21).fill('a'.repeat(64))]) {
    await assert.rejects(fixture.actions.recover({ ...input, operationIds }, context), /exact retained operation IDs/);
  }
  await assert.rejects(fixture.actions.recover({ ...input, companyId: 'other', operationIds: ['a'.repeat(64)] }, context),
    /matching company/);
  assert.equal(fixture.ledger.credentialReads, 0); assertNoWrites(fixture);
});
