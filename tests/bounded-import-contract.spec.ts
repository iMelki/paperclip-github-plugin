import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import manifest from '../src/manifest.ts';
import plugin from '../src/worker.ts';

// Characterizes the existing fresh-project path; it is NOT a live no-dispatch gate.
async function createHarness(selectedRepositories: string[]) {
  const companyId = 'company-contract';
  const projectId = 'project-contract';
  const secretId = '00000000-0000-4000-8000-000000000001';
  const harness = createTestHarness({
    manifest,
    config: { githubTokenRefs: { [companyId]: { type: 'secret_ref', secretId } } },
  });
  harness.ctx.secrets.resolve = async (_ref, options) => {
    assert.equal(options?.companyId, companyId);
    return 'synthetic-contract-token';
  };
  await plugin.definition.setup(harness.ctx);
  await harness.performAction('settings.saveRegistration', {
    companyId,
    mappings: [
      ...selectedRepositories.map(repository => ({
        id: repository, companyId, paperclipProjectId: projectId,
        paperclipProjectName: 'Selected', repositoryUrl: `fixture/${repository}`,
      })),
      { id: 'excluded', companyId, paperclipProjectId: 'project-other',
        paperclipProjectName: 'Excluded', repositoryUrl: 'fixture/excluded' },
    ],
    advancedSettings: { defaultStatus: 'backlog', ignoredIssueAuthorUsernames: [] },
  });

  return { harness, companyId, projectId };
}

function createGitHubFixture(repositories: string[], requests: string[], violations: string[]): typeof fetch {
  const respond: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    requests.push(`${method} ${url.origin}${url.pathname}`);
    assert.equal(url.origin, 'https://api.github.com');
    if (url.pathname === '/graphql') {
      assert.equal(method, 'POST');
      const { query, variables } = JSON.parse(String(init?.body));
      requests.push(`GraphQL ${String(query).trim().split(/[\s({]/, 2).join(' ')}`);
      assert.match(query, /^\s*query\s/);
      assert.doesNotMatch(query, /\bmutation\b/);
      assert.equal(variables.owner, 'fixture');
      assert.ok(repositories.includes(variables.repo));
      if (query.includes('query GitHubIssueStatusSnapshot')) {
        return Response.json({ data: { repository: { issue: {
          number: 1, state: 'OPEN', stateReason: null, comments: { totalCount: 0 },
          closedByPullRequestsReferences: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        } } } });
      }
      if (query.includes('query GitHubRepositoryOpenIssueLinkedPullRequests')) {
        return Response.json({ data: { repository: { issues: {
          pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 1,
            closedByPullRequestsReferences: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          }],
        } } } });
      }
      throw new Error(`Unexpected GraphQL query: ${query}`);
    }
    const repository = url.pathname.match(/^\/repos\/fixture\/([^/]+)\/issues$/)?.[1];
    assert.ok(repository && repositories.includes(repository));
    assert.equal(method, 'GET');
    return new Response(JSON.stringify([{
      id: 1001 + repositories.indexOf(repository), number: 1,
      title: `Synthetic ${repository} issue`, body: 'No real account data',
      html_url: `https://github.com/fixture/${repository}/issues/1`, state: 'open', comments: 0,
    }]), { headers: { 'content-type': 'application/json' } });
  };
  return async (input, init) => {
    try { return await respond(input, init); }
    catch (error) {
      violations.push(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
}

function assertNoForbiddenAttempts(violations: string[]) {
  assert.deepEqual(violations, [], 'forbidden GitHub request attempt');
}

function assertFreshIssues(issues: Array<{
  projectId?: string | null; status: string; assigneeAgentId?: string | null; assigneeUserId?: string | null;
}>, projectId: string, count: number) {
  assert.equal(issues.length, count);
  for (const issue of issues) {
    assert.equal(issue.projectId, projectId);
    assert.equal(issue.status, 'backlog');
    assert.ok(!issue.assigneeAgentId && !issue.assigneeUserId);
  }
}

test('outer guard detects a forbidden mutation even when its request error is swallowed', async () => {
  const violations: string[] = [];
  const fixture = createGitHubFixture(['selected'], [], violations);
  await fixture('https://api.github.com/graphql', {
    method: 'POST', body: JSON.stringify({ query: 'mutation Forbidden { noop }', variables: {} }),
  }).catch(() => undefined);
  assert.equal(violations.length, 1);
  // The proof runner deliberately lets this assertion escape to verify CLI exit status.
  if (process.env.PAPERCLIP_IMPORT_CONTRACT_NEGATIVE_PROOF === '1') {
    assertNoForbiddenAttempts(violations);
  }
  assert.throws(() => assertNoForbiddenAttempts(violations), /forbidden GitHub request attempt/);
});

for (const repositories of [['selected'], ['selected', 'also-selected']]) {
  test(`project sync imports all ${repositories.length} fresh mapping(s), then reuses issue IDs`, async () => {
  const { harness, companyId, projectId } = await createHarness(repositories);
  let wakeups = 0;
  harness.ctx.issues.requestWakeup = async () => {
    wakeups += 1;
    throw new Error('Unexpected wakeup in fresh-project fixture');
  };
  const requests: string[] = [];
  const violations: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createGitHubFixture(repositories, requests, violations);
  try {
    const run = () => harness.performAction('sync.runNow', {
      companyId, projectId, waitForCompletion: true,
    }) as Promise<{ syncState: { status: string; createdIssuesCount?: number } }>;
    const first = await run();
    assertNoForbiddenAttempts(violations);
    assert.equal(first.syncState.status, 'success', JSON.stringify(first));
    assert.equal(first.syncState.createdIssuesCount, repositories.length);
    const before = await harness.ctx.issues.list({ companyId });
    assertFreshIssues(before, projectId, repositories.length);
    const second = await run();
    assertNoForbiddenAttempts(violations);
    assert.equal(second.syncState.status, 'success', JSON.stringify(second));
    assert.equal(second.syncState.createdIssuesCount, 0);
    const after = await harness.ctx.issues.list({ companyId });
    assertFreshIssues(after, projectId, repositories.length);
    assert.deepEqual(after.map(issue => issue.id), before.map(issue => issue.id));
    assert.equal(wakeups, 0);
    assert.ok(requests.length >= 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
  });
}
