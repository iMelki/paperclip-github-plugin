import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  awaitWithAbort,
  parseProjectReference, projectItemsQuery, readProjectPreview,
  type ProjectGraphql, type ProjectReference,
} from '../src/personal-projects.ts';

type JsonRecord = Record<string, unknown>;
const boardUrl = 'https://github.com/users/fixture-owner/projects/12';
const reference = parseProjectReference(boardUrl);

test('deadline races a transport that ignores cancellation without retaining listeners', async () => {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('synthetic deadline')), 10);
  try {
    await assert.rejects(awaitWithAbort(() => new Promise(() => {}), controller.signal), /synthetic deadline/);
  } finally { clearTimeout(deadline); }
});

test('oversized page is rejected before malformed item normalization', async () => {
  const fixture = transport([page([{}])]);
  const result = fixture as unknown as { graphql: ProjectGraphql };
  result.graphql = async () => page(Array.from({ length: 51 }, () => ({})));
  await assert.rejects(readProjectPreview(result.graphql, reference), /exceeded the preview bound/);
});

test('oversized field arrays and strings are refused', async () => {
  const item = issueItem();
  item.fieldValues = { pageInfo: { hasNextPage: false }, nodes: Array.from({ length: 101 }, () => ({})) };
  await assert.rejects(readProjectPreview(transport([page([item])]).graphql, reference), /Incomplete GitHub Project fields/);
  item.fieldValues = { pageInfo: { hasNextPage: false }, nodes: [{ text: 'x'.repeat(4097), field: { name: 'Notes' } }] };
  await assert.rejects(readProjectPreview(transport([page([item])]).graphql, reference), /Oversized GitHub Project field/);
});

function issueItem(id = 'item-1', content: JsonRecord = {}): JsonRecord {
  return {
    id, isArchived: false,
    content: {
      __typename: 'Issue', id: `issue-${id}`, number: 7, title: 'Synthetic issue',
      url: 'https://github.com/fixture-owner/memsys/issues/7', state: 'OPEN',
      repository: { nameWithOwner: 'fixture-owner/memsys' }, ...content,
    },
    fieldValues: { pageInfo: { hasNextPage: false }, nodes: [] },
  };
}

function page(items: JsonRecord[], options: {
  totalCount?: number; hasNextPage?: boolean; cursor?: unknown;
  metadata?: JsonRecord; reference?: ProjectReference;
} = {}): JsonRecord {
  const selected = options.reference ?? reference;
  return {
    [selected.ownerType]: {
      projectV2: {
        id: 'board-12', title: 'Synthetic MemSys board', url: selected.url,
        updatedAt: '2026-10-12T00:00:00Z', ...options.metadata,
        items: {
          totalCount: options.totalCount ?? items.length,
          pageInfo: { hasNextPage: options.hasNextPage ?? false, endCursor: options.cursor ?? null },
          nodes: items,
        },
      },
    },
  };
}

function transport(pages: unknown[]) {
  const calls: Array<{ query: string; variables: JsonRecord }> = [];
  const graphql: ProjectGraphql = async (query, variables, signal) => {
    assert.match(query, /^\s*query\b/);
    assert.doesNotMatch(query, /\bmutation\b/);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    calls.push({ query, variables });
    assert.ok(calls.length <= pages.length, 'unexpected additional synthetic request');
    return pages[calls.length - 1];
  };
  return { graphql, calls };
}

test('exact personal and organization board URLs resolve owner kind and canonical identity', () => {
  assert.deepEqual(reference, {
    ownerType: 'user', owner: 'fixture-owner', number: 12, url: boardUrl,
  });
  assert.deepEqual(parseProjectReference('https://github.com/orgs/fixture-org/projects/3/'), {
    ownerType: 'organization', owner: 'fixture-org', number: 3,
    url: 'https://github.com/orgs/fixture-org/projects/3',
  });
});

const maliciousUrls = [
  'http://github.com/users/fixture-owner/projects/12',
  'https://github.com.evil.invalid/users/fixture-owner/projects/12',
  'https://evil.invalid/github.com/users/fixture-owner/projects/12',
  'https://user:password@github.com/users/fixture-owner/projects/12',
  'https://github.com:8443/users/fixture-owner/projects/12',
  'https://github.com:443/users/fixture-owner/projects/12',
  'https://github.com/users/fixture-owner/projects/12?token=synthetic',
  'https://github.com/users/fixture-owner/projects/12#fragment',
  'https://github.com/users/fixture-owner/projects/0',
  'https://github.com/users/fixture-owner/projects/01',
  'https://github.com/users/fixture-owner/projects/-1',
  'https://github.com/users/fixture-owner/projects/2147483648',
  'https://github.com/users/fixture-owner/projects/12/items',
  'https://github.com/users/fixture-owner/projects/%31%32',
  'https://github.com/users/other/../fixture-owner/projects/12',
  'https://github.com/fixture-owner/memsys',
];
for (const [index, url] of maliciousUrls.entries()) {
  test(`URL allowlist rejects hostile or noncanonical input ${index + 1}`, () => {
    assert.throws(() => parseProjectReference(url));
  });
}

test('URL allowlist rejects absent, non-string and malformed inputs', () => {
  for (const value of [null, undefined, 12, {}, '', 'not a URL']) {
    assert.throws(() => parseProjectReference(value));
  }
});

test('personal and organization GraphQL queries are read-only and variable-bound', () => {
  for (const ownerType of ['user', 'organization'] as const) {
    const query = projectItemsQuery(ownerType);
    assert.match(query, /^\s*query\b/);
    assert.doesNotMatch(query, /\bmutation\b/);
    assert.ok(query.includes(`${ownerType}(login:$owner)`));
    assert.ok(query.includes('projectV2(number:$number)'));
    assert.ok(query.includes('pageInfo{hasNextPage endCursor}'));
    assert.ok(query.includes('fieldValues(first:100){pageInfo{hasNextPage}'));
    assert.equal(query.includes('fixture-owner'), false);
  }
  assert.throws(() => projectItemsQuery('repository' as ProjectReference['ownerType']));
});

test('two pages use the returned cursor and preserve one complete unwrapped GraphQL board', async () => {
  const fixture = transport([
    page([issueItem('item-1')], { totalCount: 2, hasNextPage: true, cursor: 'next-1' }),
    page([issueItem('item-2')], { totalCount: 2 }),
  ]);
  const preview = await readProjectPreview(fixture.graphql, reference);
  assert.deepEqual(fixture.calls.map(call => call.variables), [
    { owner: 'fixture-owner', number: 12, first: 50, after: null },
    { owner: 'fixture-owner', number: 12, first: 50, after: 'next-1' },
  ]);
  assert.equal(preview.complete, true);
  assert.equal(preview.retrievedCount, 2);
  assert.equal(preview.totalCount, 2);
  assert.equal(preview.importEnabled, false);
  assert.deepEqual(preview.items.map(item => item.id), ['item-1', 'item-2']);
});

test('organization preview uses the organization response root rather than a personal board', async () => {
  const org = parseProjectReference('https://github.com/orgs/fixture-org/projects/3');
  const fixture = transport([page([], { reference: org })]);
  const preview = await readProjectPreview(fixture.graphql, org);
  assert.ok(fixture.calls[0].query.includes('organization(login:$owner)'));
  assert.equal(preview.url, org.url);
  assert.equal(preview.complete, true);
});

test('empty board is complete without an invented missing-content failure', async () => {
  const fixture = transport([page([])]);
  const preview = await readProjectPreview(fixture.graphql, reference);
  assert.equal(preview.complete, true);
  assert.equal(preview.totalCount, 0);
  assert.equal(preview.eligibleCount, 0);
  assert.equal(preview.skippedCount, 0);
  assert.deepEqual(preview.items, []);
});

test('item cap returns an explicit incomplete preview and performs no extra page request', async () => {
  const fixture = transport([page([issueItem()], { totalCount: 2, hasNextPage: true, cursor: 'next' })]);
  const preview = await readProjectPreview(fixture.graphql, reference, 1);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].variables.first, 1);
  assert.equal(preview.complete, false);
  assert.equal(preview.totalCount, 2);
  assert.equal(preview.retrievedCount, 1);
  assert.equal(preview.importEnabled, false);
});

test('terminal page with missing declared items remains incomplete', async () => {
  const preview = await readProjectPreview(transport([page([issueItem()], { totalCount: 2 })]).graphql, reference);
  assert.equal(preview.complete, false);
  assert.equal(preview.retrievedCount, 1);
  assert.equal(preview.totalCount, 2);
});

test('preview rejects invalid item bounds before any transport request', async () => {
  const fixture = transport([]);
  for (const value of [0, -1, 1001, 1.5, NaN, Infinity]) {
    await assert.rejects(readProjectPreview(fixture.graphql, reference, value), /Invalid preview bound/);
  }
  assert.equal(fixture.calls.length, 0);
});

test('partial GraphQL data or null project is refused rather than treated as an empty board', async () => {
  await assert.rejects(readProjectPreview(transport([{ ...page([]), errors: [{ message: 'partial' }] }]).graphql,
    reference), /Partial GitHub GraphQL/);
  for (const response of [null, {}, { user: null }, { user: { projectV2: null } }]) {
    await assert.rejects(readProjectPreview(transport([response]).graphql, reference), /Malformed GitHub response/);
  }
});

for (const metadata of [
  { id: 'different-board' }, { updatedAt: '2026-10-12T00:01:00Z' },
]) {
  test(`mid-pagination board drift is rejected: ${Object.keys(metadata)[0]}`, async () => {
    const fixture = transport([
      page([issueItem()], { totalCount: 2, hasNextPage: true, cursor: 'next' }),
      page([issueItem('item-2')], { totalCount: 2, metadata }),
    ]);
    await assert.rejects(readProjectPreview(fixture.graphql, reference), /changed during preview/);
  });
}

test('mid-pagination item-count drift is rejected', async () => {
  const fixture = transport([
    page([issueItem()], { totalCount: 2, hasNextPage: true, cursor: 'next' }),
    page([issueItem('item-2')], { totalCount: 3 }),
  ]);
  await assert.rejects(readProjectPreview(fixture.graphql, reference), /changed during preview/);
});

test('different returned board URL is rejected', async () => {
  const fixture = transport([page([], { metadata: { url: 'https://github.com/users/other/projects/12' } })]);
  await assert.rejects(readProjectPreview(fixture.graphql, reference), /different Project/);
});

test('missing or non-string next cursor is rejected', async () => {
  for (const cursor of [null, '', 1, {}]) {
    const fixture = transport([page([issueItem()], { totalCount: 2, hasNextPage: true, cursor })]);
    await assert.rejects(readProjectPreview(fixture.graphql, reference), /Missing GitHub identity/);
  }
});

test('empty advancing page and repeated cursor are rejected', async () => {
  const empty = transport([page([], { totalCount: 1, hasNextPage: true, cursor: 'next' })]);
  await assert.rejects(readProjectPreview(empty.graphql, reference), /did not advance/);
  const repeated = transport([
    page([issueItem()], { totalCount: 3, hasNextPage: true, cursor: 'next' }),
    page([issueItem('item-2')], { totalCount: 3, hasNextPage: true, cursor: 'next' }),
  ]);
  await assert.rejects(readProjectPreview(repeated.graphql, reference), /did not advance/);
});

test('repeated board item IDs and server page overflow are refused', async () => {
  const repeated = transport([
    page([issueItem()], { totalCount: 2, hasNextPage: true, cursor: 'next' }),
    page([issueItem()], { totalCount: 2 }),
  ]);
  await assert.rejects(readProjectPreview(repeated.graphql, reference), /Duplicate GitHub Project item/);
  await assert.rejects(readProjectPreview(transport([page([issueItem(), issueItem('item-2')])]).graphql,
    reference, 1), /exceeded the preview bound/);
});

test('incomplete nested field pagination is refused', async () => {
  const item = issueItem();
  item.fieldValues = { pageInfo: { hasNextPage: true }, nodes: [] };
  await assert.rejects(readProjectPreview(transport([page([item])]).graphql, reference), /Incomplete GitHub Project fields/);
});

test('raw status, readiness, zero estimate and custom date remain metadata, not assignments', async () => {
  const item = issueItem();
  item.fieldValues = { pageInfo: { hasNextPage: false }, nodes: [
    { name: 'In Progress', field: { name: 'Status' } },
    { name: 'Ready for Agent', field: { name: 'Readiness' } },
    { number: 0, field: { name: 'Estimate' } },
    { date: '2026-10-13', field: { name: 'Target date' } },
  ] };
  const preview = await readProjectPreview(transport([page([item])]).graphql, reference);
  assert.deepEqual(preview.items[0].fields, [
    { name: 'Status', value: 'In Progress' }, { name: 'Readiness', value: 'Ready for Agent' },
    { name: 'Estimate', value: '0' }, { name: 'Target date', value: '2026-10-13' },
  ]);
  assert.equal('assigneeAgentId' in preview.items[0], false);
  assert.equal('status' in preview.items[0], false);
  assert.equal(preview.importEnabled, false);
});

test('drafts, PRs, closed, archived and null content remain explicit reference-only rows', async () => {
  const draft = { ...issueItem('draft'), content: { __typename: 'DraftIssue', title: 'Draft' } };
  const pr = { ...issueItem('pr'), content: {
    __typename: 'PullRequest', title: 'PR', url: 'https://github.com/fixture-owner/memsys/pull/9',
    repository: { nameWithOwner: 'fixture-owner/memsys' },
  } };
  const closed = issueItem('closed', { state: 'CLOSED' });
  const archived = { ...issueItem('archived'), isArchived: true };
  const inaccessible = { ...issueItem('null'), content: null };
  const preview = await readProjectPreview(transport([page([
    issueItem(), draft, pr, closed, archived, inaccessible,
  ])]).graphql, reference);
  assert.equal(preview.complete, true);
  assert.equal(preview.eligibleCount, 1);
  assert.equal(preview.skippedCount, 5);
  assert.deepEqual(preview.items.slice(1).map(item => item.skipReason), [
    'DraftIssue is reference-only', 'PullRequest is reference-only', 'Closed issue',
    'Archived board item', 'Inaccessible or deleted content',
  ]);
  assert.equal(preview.items[5].issueNodeId, null);
});

test('malformed issue identity, missing archive state and hostile content URL are rejected', async () => {
  const missingArchive = issueItem();
  delete missingArchive.isArchived;
  for (const item of [
    missingArchive, issueItem('bad-number', { number: 0 }), issueItem('bad-node', { id: null }),
    issueItem('bad-repo', { repository: null }),
    issueItem('bad-url', { url: 'https://evil.invalid/fixture-owner/memsys/issues/7' }),
    issueItem('credential-url', { url: 'https://synthetic:secret@github.com/fixture-owner/memsys/issues/7' }),
  ]) {
    await assert.rejects(readProjectPreview(transport([page([item])]).graphql, reference));
  }
});
