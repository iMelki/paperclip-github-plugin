// GraphQL read shape adapted from Mission Control Kanban's MIT reader.
// See THIRD_PARTY_NOTICES.md. No SQL persistence, status transitions or dispatch is reused.
export interface ProjectReference {
  ownerType: 'user' | 'organization';
  owner: string;
  number: number;
  url: string;
}
export interface BoardItem {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  issueNodeId: string | null;
  repository: string | null;
  fields: Array<{ name: string; value: string }>;
  eligible: boolean;
  skipReason: string | null;
}
export interface ProjectPreview {
  boardId: string;
  title: string;
  url: string;
  updatedAt: string;
  totalCount: number;
  retrievedCount: number;
  eligibleCount: number;
  skippedCount: number;
  complete: boolean;
  importEnabled: false;
  fieldCoverage: 'text-single-select-number-date';
  items: BoardItem[];
}
type RecordValue = Record<string, unknown>;
export type ProjectGraphql = (query: string, variables: RecordValue, signal: AbortSignal) => Promise<unknown>;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed GitHub response.');
  return value as RecordValue;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing GitHub identity or metadata.');
  if (value.length > 4096) throw new Error('Oversized GitHub identity or metadata.');
  return value;
}
export async function awaitWithAbort<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([action(), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
export function parseProjectReference(value: unknown): ProjectReference {
  if (typeof value !== 'string') throw new Error('Enter a GitHub Project URL.');
  const url = new URL(value);
  const match = url.pathname.match(/^\/(users|orgs)\/([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/projects\/([1-9]\d*)\/?$/i);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password
    || url.search || url.hash || !match || value.trim() !== url.href) {
    throw new Error('Use an exact HTTPS github.com/users/OWNER/projects/NUMBER or orgs URL.');
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number > 2147483647) throw new Error('Invalid GitHub Project number.');
  return { ownerType: match[1].toLowerCase() === 'users' ? 'user' : 'organization', owner: match[2], number,
    url: `https://github.com/${match[1].toLowerCase()}/${match[2]}/projects/${number}` };
}

export function projectItemsQuery(ownerType: ProjectReference['ownerType']): string {
  if (ownerType !== 'user' && ownerType !== 'organization') throw new Error('Invalid Project owner type.');
  return `query($owner:String!,$number:Int!,$after:String,$first:Int!){
    ${ownerType}(login:$owner){projectV2(number:$number){id title url updatedAt
      items(first:$first,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{
        id isArchived content{__typename
          ... on Issue{id number title url state repository{nameWithOwner}}
          ... on PullRequest{title url repository{nameWithOwner}}
          ... on DraftIssue{title}}
        fieldValues(first:100){pageInfo{hasNextPage} nodes{
          ... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{name}}}
          ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}
          ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}
          ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}}
        }}
      }}
    }}
  }`;
}

function normalizeFields(value: unknown): BoardItem['fields'] {
  const connection = record(value);
  if (record(connection.pageInfo).hasNextPage !== false || !Array.isArray(connection.nodes) || connection.nodes.length > 100) {
    throw new Error('Incomplete GitHub Project fields; preview refused.');
  }
  return connection.nodes.flatMap((node) => {
    const field = record(node);
    if (!field.field) return [];
    const name = string(record(field.field).name);
    const result = field.text ?? field.name ?? field.number ?? field.date;
    if (name.length > 128 || (typeof result === 'string' && result.length > 4096)) {
      throw new Error('Oversized GitHub Project field.');
    }
    return typeof result === 'string' || (typeof result === 'number' && Number.isFinite(result))
      ? [{ name, value: String(result) }] : [];
  });
}

function normalizeItem(value: unknown): BoardItem {
  const item = record(value);
  if (typeof item.isArchived !== 'boolean') throw new Error('Missing Project archive state.');
  const content = item.content ? record(item.content) : null;
  const kind = content ? string(content.__typename) : 'Unavailable';
  const fields = normalizeFields(item.fieldValues);
  const issue = kind === 'Issue' && content ? content : null;
  const repository = content?.repository ? string(record(content.repository).nameWithOwner) : null;
  const url = typeof content?.url === 'string' ? content.url : null;
  if (url && (new URL(url).origin !== 'https://github.com' || new URL(url).username || new URL(url).password)) {
    throw new Error('Untrusted GitHub content URL.');
  }
  if (issue && (!repository || !Number.isSafeInteger(issue.number) || Number(issue.number) < 1
    || url !== `https://github.com/${repository}/issues/${issue.number}` || !['OPEN', 'CLOSED'].includes(String(issue.state)))) {
    throw new Error('Malformed GitHub issue identity.');
  }
  const skipReason = item.isArchived ? 'Archived board item' : !content ? 'Inaccessible or deleted content'
    : !issue ? `${kind} is reference-only` : issue.state !== 'OPEN' ? 'Closed issue' : null;
  return { id: string(item.id), kind, title: content ? string(content.title) : 'Unavailable content', url,
    issueNodeId: issue ? string(issue.id) : null, repository, fields, eligible: skipReason === null, skipReason };
}

function parsePage(value: unknown, reference: ProjectReference, requestedSize: number) {
  const response = record(value);
  if ('errors' in response) throw new Error('Partial GitHub GraphQL response; preview refused.');
  const project = record(record(response[reference.ownerType]).projectV2);
  if (project.url !== reference.url) throw new Error('GitHub returned a different Project.');
  const connection = record(project.items);
  const pageInfo = record(connection.pageInfo);
  if (!Number.isSafeInteger(connection.totalCount) || Number(connection.totalCount) < 0
    || !Array.isArray(connection.nodes) || typeof pageInfo.hasNextPage !== 'boolean') {
    throw new Error('Malformed GitHub pagination.');
  }
  if (connection.nodes.length > requestedSize) throw new Error('GitHub exceeded the preview bound.');
  return { id: string(project.id), title: string(project.title), updatedAt: string(project.updatedAt),
    totalCount: Number(connection.totalCount), items: connection.nodes.map(normalizeItem),
    hasNextPage: pageInfo.hasNextPage, cursor: pageInfo.endCursor };
}

export async function readProjectPreview(graphql: ProjectGraphql, reference: ProjectReference,
  maxItems = 1000, signal = AbortSignal.timeout(15000)): Promise<ProjectPreview> {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 1000) throw new Error('Invalid preview bound.');
  const items: BoardItem[] = [];
  const itemIds = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  let firstPage: ReturnType<typeof parsePage> | null = null;
  let complete = false;
  for (let pageNumber = 0; pageNumber < 20 && items.length < maxItems; pageNumber++) {
    signal.throwIfAborted();
    const first = Math.min(50, maxItems - items.length);
    const page = parsePage(await awaitWithAbort(() => graphql(projectItemsQuery(reference.ownerType),
      { owner: reference.owner, number: reference.number, first, after }, signal), signal), reference, first);
    signal.throwIfAborted();
    if (firstPage && (page.id !== firstPage.id || page.updatedAt !== firstPage.updatedAt
      || page.totalCount !== firstPage.totalCount)) throw new Error('GitHub Project changed during preview; read it again.');
    firstPage ??= page;
    if (page.items.length > first) throw new Error('GitHub exceeded the preview bound.');
    for (const item of page.items) {
      if (itemIds.has(item.id)) throw new Error('Duplicate GitHub Project item across pages.');
      itemIds.add(item.id);
      items.push(item);
    }
    if (!page.hasNextPage) { complete = items.length === page.totalCount; break; }
    const cursor = string(page.cursor);
    if (!page.items.length || cursors.has(cursor)) throw new Error('GitHub pagination did not advance.');
    cursors.add(cursor);
    after = cursor;
  }
  if (!firstPage) throw new Error('Missing GitHub Project.');
  const eligibleCount = items.filter((item) => item.eligible).length;
  return { boardId: firstPage.id, title: firstPage.title, updatedAt: firstPage.updatedAt, url: reference.url,
    totalCount: firstPage.totalCount, retrievedCount: items.length, eligibleCount,
    skippedCount: items.length - eligibleCount, complete, importEnabled: false,
    fieldCoverage: 'text-single-select-number-date', items };
}
