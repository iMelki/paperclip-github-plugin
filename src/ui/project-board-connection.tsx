import React, { useEffect, useReducer, useRef } from 'react';
import { ProjectPicker, useHostContext, usePluginAction } from '@paperclipai/plugin-sdk/ui';
import type { BoardItem, ProjectPreview } from '../personal-projects.ts';
import { parseProjectReference } from '../personal-projects.ts';
import type { BoardImportPlan, BoardImportResult } from '../project-board-sync.ts';
import type { GitHubProjectBinding, GitHubProjectConnectionOption } from '../project-board-oauth.ts';

const PAGE_SIZE = 20;
const MAX_SELECTED = 20;
interface Submission {
  companyId: string; projectId: string; boardUrl: string; planId: string;
  operationIds: string[]; reconciled: boolean;
}
interface State {
  connectionId: string; connections: GitHubProjectConnectionOption[];
  binding: GitHubProjectBinding | null; bindingUnverified: boolean;
  boardUrl: string; projectId: string; preview: ProjectPreview | null;
  selectedItemIds: string[]; maxSelected: number; query: string; page: number;
  plan: BoardImportPlan | null; result: BoardImportResult | null;
  submission: Submission | null; error: string | null; message: string | null; busy: boolean;
}
const INITIAL_STATE: State = {
  connectionId: '', connections: [], binding: null, bindingUnverified: false,
  boardUrl: '', projectId: '', preview: null, selectedItemIds: [], maxSelected: 1, query: '', page: 0,
  plan: null, result: null, submission: null, error: null, message: null, busy: false,
};
const reducer = (state: State, patch: Partial<State>): State => ({ ...state, ...patch });
const storageKey = (companyId: string, projectId: string) =>
  'paperclip.github-board.last-submission:' + companyId + ':' + projectId;

function readSubmission(companyId: string, projectId: string): Submission | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(companyId, projectId)) ?? 'null') as Submission | null;
    if (!value || value.companyId !== companyId || value.projectId !== projectId
      || typeof value.boardUrl !== 'string' || !/^https:\/\/github\.com\/(users|orgs)\//.test(value.boardUrl)
      || typeof value.planId !== 'string' || !/^[a-f0-9]{64}$/.test(value.planId)
      || !Array.isArray(value.operationIds) || !value.operationIds.length || value.operationIds.length > MAX_SELECTED
      || value.operationIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      || new Set(value.operationIds).size !== value.operationIds.length || typeof value.reconciled !== 'boolean') return null;
    return value;
  } catch { return null; }
}
function retainSubmission(value: Submission): void {
  const key = storageKey(value.companyId, value.projectId);
  const serialized = JSON.stringify(value);
  sessionStorage.setItem(key, serialized);
  if (sessionStorage.getItem(key) !== serialized) throw new Error('Recovery identifiers were not retained.');
}
function sameIds(left: string[], right: string[]): boolean {
  const sorted = [...right].sort();
  return left.length === right.length && [...left].sort().every((id, index) => id === sorted[index]);
}
export function checkedGitHubProjectBinding(value: unknown, companyId: string, projectId: string): GitHubProjectBinding | null {
  if (value === null) return null;
  const binding = value as GitHubProjectBinding;
  if (!binding || binding.version !== 1 || binding.companyId !== companyId || binding.projectId !== projectId
    || typeof binding.boardUrl !== 'string' || parseProjectReference(binding.boardUrl).url !== binding.boardUrl
    || !['boardId', 'connectionId', 'login', 'boundByUserId'].every(key => typeof binding[key as keyof GitHubProjectBinding] === 'string'
      && String(binding[key as keyof GitHubProjectBinding]).trim().length > 0)
    || !Number.isSafeInteger(binding.accountId) || binding.accountId <= 0
    || typeof binding.boundAt !== 'string' || !Number.isFinite(Date.parse(binding.boundAt))) {
    throw new Error('Saved GitHub connection scope or identity did not match.');
  }
  return binding;
}
function checkedConnections(value: unknown, companyId: string, projectId: string): GitHubProjectConnectionOption[] {
  const response = value as { companyId: string; projectId: string; connections: GitHubProjectConnectionOption[] };
  if (!response || response.companyId !== companyId || response.projectId !== projectId || !Array.isArray(response.connections)
    || response.connections.length > 100 || new Set(response.connections.map(row => row?.connectionId)).size !== response.connections.length
    || response.connections.some(row => !row || !['connectionId', 'name', 'login'].every(key => typeof row[key as keyof GitHubProjectConnectionOption] === 'string'
      && String(row[key as keyof GitHubProjectConnectionOption]).trim().length > 0)
      || !Number.isSafeInteger(row.accountId) || row.accountId <= 0
      || (row.lastVerifiedAt !== null && (typeof row.lastVerifiedAt !== 'string' || !Number.isFinite(Date.parse(row.lastVerifiedAt)))))) {
    throw new Error('GitHub connection listing did not match the selected scope.');
  }
  return response.connections;
}
function sameBinding(left: GitHubProjectBinding, right: GitHubProjectBinding): boolean {
  return (['version', 'companyId', 'projectId', 'boardUrl', 'boardId', 'connectionId', 'accountId', 'login', 'boundByUserId', 'boundAt'] as const)
    .every(key => left[key] === right[key]);
}
function checkedResult(value: unknown, submission: Submission, recovery = false): BoardImportResult {
  const result = value as BoardImportResult;
  const counts = result && [result.createdCount, result.reusedCount, result.skippedCount,
    result.conflictCount, result.heldCount, result.deferredCount];
  const operationIds = Array.isArray(result?.results)
    ? result.results.flatMap(row => row.operationId ? [row.operationId] : []) : [];
  const rowCount = (status: string) => result.results.filter(row => row.status === status).length;
  if (!result || !Array.isArray(result.results) || result.results.length > MAX_SELECTED
    || (!recovery && result.planId !== submission.planId) || typeof result.complete !== 'boolean'
    || !counts?.every(count => Number.isSafeInteger(count) && count >= 0 && count <= MAX_SELECTED)
    || result.results.some(row => !['created', 'reused', 'conflict', 'held'].includes(row.status)
      || (row.operationId !== null && !submission.operationIds.includes(row.operationId))
      || (['created', 'reused'].includes(row.status) && (typeof row.taskId !== 'string' || !row.taskId)))
    || new Set(operationIds).size !== operationIds.length
    || result.createdCount !== rowCount('created') || result.reusedCount !== rowCount('reused')
    || result.conflictCount !== rowCount('conflict') || result.heldCount !== rowCount('held')
    || (result.complete && (result.results.length !== submission.operationIds.length
      || !sameIds(operationIds, submission.operationIds)
      || result.results.some(row => !['created', 'reused'].includes(row.status) || !row.taskId)
      || result.heldCount !== 0 || result.conflictCount !== 0 || result.deferredCount !== 0))) {
    throw new Error('Import result does not match retained operation identifiers.');
  }
  return result;
}
function taskHref(companyPrefix: string | null, taskId: string | null): string | null {
  return companyPrefix && taskId
    ? '/' + encodeURIComponent(companyPrefix) + '/issues/' + encodeURIComponent(taskId) : null;
}

function useRequestRunner(patch: React.Dispatch<Partial<State>>, companyId: string | null | undefined) {
  const generation = useRef(0);
  const scope = useRef(companyId);
  if (scope.current !== companyId) { scope.current = companyId; generation.current++; }
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  function invalidate() { generation.current++; }
  async function run(action: (commit: (value: Partial<State>) => void, current: () => boolean) => Promise<void>, error: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = ++generation.current;
    const isCurrent = () => mounted.current && generation.current === current && scope.current === companyId;
    const commit = (value: Partial<State>) => { if (isCurrent()) patch(value); };
    commit({ busy: true, error: null, message: null });
    try { await action(commit, isCurrent); } catch { commit({ error }); }
    finally { inFlight.current = false; commit({ busy: false }); }
  }
  return { run, invalidate, locked: () => inFlight.current };
}

function BoardItemRow(props: {
  item: BoardItem; checked: boolean; disabled: boolean; onChange: () => void;
}): React.JSX.Element {
  const { item } = props;
  return <li className="ghsync__mapping-card">
    <label className="ghsync__field" style={{ minHeight: 44 }}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled}
        onChange={props.onChange} aria-label={'Select ' + item.title + ' for import'} />
      <span>{item.title}</span>
    </label>
    {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">Open GitHub item</a> : null}
    <p>{item.skipReason ?? 'Eligible open issue; not yet imported.'}</p>
  </li>;
}

function BoardSelection(props: {
  state: State; onFilter: (query: string) => void; onPage: (page: number) => void;
  onLimit: (maxSelected: number) => void; onSelect: (id: string) => void;
}): React.JSX.Element | null {
  const { state } = props;
  if (!state.preview) return null;
  const query = state.query.trim().toLowerCase();
  const filtered = state.preview.items.filter(item => (item.title + ' ' + (item.repository ?? '')).toLowerCase().includes(query));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(state.page, pages - 1);
  const start = page * PAGE_SIZE;
  return <div aria-labelledby="gh-board-items-title">
    <h5 id="gh-board-items-title">{state.preview.title}</h5>
    <p>{state.preview.retrievedCount} of {state.preview.totalCount} board items read; {state.preview.eligibleCount} open issues;
      {' '}{state.preview.skippedCount} skipped. {state.preview.complete ? 'Complete listing.' : 'Partial listing — import disabled.'}</p>
    <fieldset disabled={state.busy}>
      <label htmlFor="gh-board-filter">Find board items</label>
      <input id="gh-board-filter" className="ghsync__input" value={state.query}
        onChange={event => props.onFilter(event.target.value)} />
      <label htmlFor="gh-board-limit">Selection limit (first import defaults to one)</label>
      <input id="gh-board-limit" className="ghsync__input" type="number" min={1} max={MAX_SELECTED}
        value={state.maxSelected} onChange={event => props.onLimit(Number(event.target.value))} />
      <p>{state.selectedItemIds.length} selected, including selections on other pages. Maximum {state.maxSelected}.</p>
      <ul>{filtered.slice(start, start + PAGE_SIZE).map(item => <BoardItemRow key={item.id} item={item}
        checked={state.selectedItemIds.includes(item.id)}
        disabled={!item.eligible || !state.preview?.complete
          || (!state.selectedItemIds.includes(item.id) && state.selectedItemIds.length >= state.maxSelected)}
        onChange={() => props.onSelect(item.id)} />)}</ul>
      <p>Showing {filtered.length ? start + 1 : 0}–{Math.min(start + PAGE_SIZE, filtered.length)} of {filtered.length} matching items.</p>
      <button type="button" className="ghsync__button" disabled={page === 0}
        onClick={() => props.onPage(page - 1)}>Previous items</button>
      <button type="button" className="ghsync__button" disabled={page === pages - 1}
        onClick={() => props.onPage(page + 1)}>Next items</button>
    </fieldset>
    <p>Text, single-select, number and date fields are metadata only; they do not route agent work.</p>
  </div>;
}

function ImportPlan(props: {
  plan: BoardImportPlan | null; preview: ProjectPreview | null; companyPrefix: string | null;
}): React.JSX.Element | null {
  if (!props.plan) return null;
  const { plan } = props;
  return <div aria-labelledby="gh-board-plan-title">
    <h5 id="gh-board-plan-title">Selected import preview</h5>
    <p>{plan.selectedItemIds.length} selected; {plan.intents.length} eligible writes;
      {' '}{plan.conflicts.length} conflicts; {plan.skipped.length} skipped.</p>
    <ul>{plan.rows.map(row => {
      const href = taskHref(props.companyPrefix, row.existingTaskId);
      const title = props.preview?.items.find(item => item.id === row.boardItemId)?.title ?? 'Selected issue';
      const reason = plan.conflicts.find(entry => entry.boardItemId === row.boardItemId)?.reason
        ?? plan.skipped.find(entry => entry.boardItemId === row.boardItemId)?.reason;
      return <li key={row.boardItemId}>
        <strong>{row.disposition}</strong>{' — '}{title}
        {href ? <>{' — '}<a href={href}>Existing Paperclip task</a></> : null}
        {reason ? <p>{reason}</p> : null}
      </li>;
    })}</ul>
    <p>{plan.supported
      ? 'The host reports the protected import interface is available. Execution audit is checked separately.'
      : 'Import unavailable: this host does not provide verified duplicate-safe, no-dispatch import capabilities.'}</p>
    <p>Import updates only these selected tasks and their board metadata. It does not enable repository sync or request agent runs.</p>
  </div>;
}

function ImportResults(props: { result: BoardImportResult | null; companyPrefix: string | null }): React.JSX.Element | null {
  if (!props.result) return null;
  const { result } = props;
  return <div aria-labelledby="gh-board-result-title">
    <h5 id="gh-board-result-title">Last saved-task readback</h5>
    <p>{result.createdCount} created; {result.reusedCount} existing tasks reused; {result.conflictCount} conflicts;
      {' '}{result.heldCount} unverified; {result.deferredCount} deferred.</p>
    <ul>{result.results.map(row => {
      const href = taskHref(props.companyPrefix, row.taskId);
      return <li key={row.operationId ?? row.boardItemId}>
        {row.status}{' — '}{row.boardItemId}
        {href ? <>{' — '}<a href={href}>Open saved Paperclip task</a></> : null}
        {row.operationId ? <p>Operation: <code style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}>
          {row.operationId}</code></p> : null}
        {row.reason ? <p>{row.reason}</p> : null}
      </li>;
    })}</ul>
    <p>Task receipt: {result.complete ? 'read back' : 'incomplete — reconcile before another import'}.
      {' '}Agent-run audit: not checked by this screen.</p>
  </div>;
}

export function GitHubProjectBoardConnection(): React.JSX.Element {
  const { companyId, companyPrefix } = useHostContext();
  const previewAction = usePluginAction('project.board.preview');
  const saveAction = usePluginAction('project.board.save');
  const getAction = usePluginAction('project.board.get');
  const planAction = usePluginAction('project.board.plan');
  const importAction = usePluginAction('project.board.import');
  const resultAction = usePluginAction('project.board.result');
  const connectionsAction = usePluginAction('project.board.oauth.list');
  const bindAction = usePluginAction('project.board.oauth.bind');
  const bindingAction = usePluginAction('project.board.oauth.get');
  const [state, patch] = useReducer(reducer, INITIAL_STATE);
  const requests = useRequestRunner(patch, companyId);
  // The settings mount is company-keyed; retain this boundary for standalone reuse too.
  useEffect(() => { requests.invalidate(); patch({ ...INITIAL_STATE }); }, [companyId]);
  const input = { companyId, projectId: state.projectId, boardUrl: state.boardUrl,
    selectedItemIds: state.selectedItemIds, maxSelected: state.maxSelected };

  function changeDraft(value: Partial<State>) {
    if (requests.locked()) return;
    requests.invalidate();
    patch({ binding: null, preview: null, selectedItemIds: [], plan: null, result: null, page: 0,
      error: null, message: null, ...value });
  }
  function select(id: string) {
    const item = state.preview?.items.find(candidate => candidate.id === id);
    if (requests.locked() || !item?.eligible || !state.preview?.complete) return;
    const selectedItemIds = state.selectedItemIds.includes(id)
      ? state.selectedItemIds.filter(selected => selected !== id) : [...state.selectedItemIds, id];
    if (selectedItemIds.length > state.maxSelected) return;
    requests.invalidate(); patch({ selectedItemIds, plan: null, result: null, error: null, message: null });
  }
  const draftReady = Boolean(companyId && state.projectId && state.boardUrl && state.connectionId);
  const scopeReady = Boolean(draftReady && state.binding && !state.bindingUnverified
    && state.binding.companyId === companyId && state.binding.projectId === state.projectId
    && state.binding.boardUrl === state.boardUrl && state.binding.connectionId === state.connectionId);
  const recoveryPending = Boolean(state.submission && !state.submission.reconciled);
  const importReady = Boolean(scopeReady && state.plan?.supported === true && state.plan.intents.length
    && !state.plan.conflicts.length && !recoveryPending);

  async function listConnections() {
    if (!companyId || !state.projectId) return;
    await requests.run(async commit => {
      const connections = checkedConnections(await connectionsAction({ companyId, projectId: state.projectId }), companyId, state.projectId);
      const keepSelected = connections.some(row => row.connectionId === state.connectionId);
      commit({ connections, ...(!keepSelected ? { connectionId: '', binding: null, preview: null, plan: null } : {}),
        message: connections.length ? 'Saved connection metadata loaded. Choose explicitly; current permissions are checked when binding.'
          : 'No eligible native GitHub OAuth connections were listed. Connect GitHub in Paperclip Apps first.' });
    }, 'Could not list saved GitHub connections. No connection was selected or changed.');
  }
  async function loadBinding() {
    if (!companyId || !state.projectId) return;
    await requests.run(async commit => {
      const binding = checkedGitHubProjectBinding(await bindingAction({ companyId, projectId: state.projectId }), companyId, state.projectId);
      const connections = binding && !state.connections.some(row => row.connectionId === binding.connectionId)
        ? [...state.connections, { connectionId: binding.connectionId, name: 'Saved board connection', accountId: binding.accountId,
          login: binding.login, lastVerifiedAt: null }] : state.connections;
      commit({ binding, connections, bindingUnverified: false, preview: null, plan: null, result: null, selectedItemIds: [],
        ...(binding ? { connectionId: binding.connectionId, boardUrl: binding.boardUrl } : {}),
        message: binding ? 'Saved OAuth board binding read back. Preview to check current board access; no tasks were imported.'
          : 'No OAuth board binding is saved for this destination.' });
    }, 'Could not read the saved OAuth binding. No bind or import was retried.');
  }
  async function bindConnection() {
    if (!draftReady || !companyId || state.bindingUnverified) return;
    await requests.run(async (commit, current) => {
      const boardUrl = parseProjectReference(state.boardUrl).url;
      commit({ bindingUnverified: true, binding: null, preview: null, plan: null, result: null, selectedItemIds: [] });
      const saved = checkedGitHubProjectBinding(await bindAction({ companyId, projectId: state.projectId,
        boardUrl, connectionId: state.connectionId }), companyId, state.projectId);
      if (!current()) return;
      const readback = checkedGitHubProjectBinding(await bindingAction({ companyId, projectId: state.projectId }), companyId, state.projectId);
      if (!saved || !readback || !sameBinding(saved, readback) || readback.boardUrl !== boardUrl
        || readback.connectionId !== state.connectionId) throw new Error('Binding save was not read back exactly.');
      commit({ binding: readback, boardUrl, bindingUnverified: false,
        message: 'OAuth board binding saved and independently read back. No tasks or agent runs were requested.' });
    }, 'Connection save outcome unverified. Load saved OAuth binding before trying another bind; no import was requested.');
  }

  async function previewOrSave(save: boolean) {
    if (!scopeReady || (save && !state.preview?.complete)) return;
    await requests.run(async commit => {
      if (save && state.preview) {
        await saveAction({ ...input, boardId: state.preview.boardId, updatedAt: state.preview.updatedAt });
        commit({ message: 'Board association saved and read back. No task import was requested.' });
      } else {
        const preview = await previewAction(input) as ProjectPreview;
        commit({ boardUrl: preview.url, preview, selectedItemIds: [], plan: null, result: null, page: 0 });
      }
    }, save ? 'Save outcome unverified. Load saved association before retrying.'
      : 'Board preview failed. Check company credential and Project permissions. No tasks were imported.');
  }
  async function load() {
    if (!companyId || !state.projectId) return;
    await requests.run(async commit => {
      const saved = await getAction(input) as { companyId?: string; projectId?: string; reference?: { url?: string } } | null;
      if (saved && (saved.companyId !== companyId || saved.projectId !== state.projectId
        || typeof saved.reference?.url !== 'string'
        || parseProjectReference(saved.reference.url).url !== saved.reference.url)) {
        throw new Error('Saved association scope or canonical board URL did not match.');
      }
      commit({ preview: null, selectedItemIds: [], plan: null, result: null,
        ...(saved?.reference?.url !== state.binding?.boardUrl ? { binding: null } : {}),
        submission: readSubmission(companyId, state.projectId),
        ...(typeof saved?.reference?.url === 'string' ? { boardUrl: saved.reference.url } : {}),
        message: saved?.reference?.url ? 'Saved board association loaded. Preview to read current items.' : 'No association is saved.' });
    }, 'Could not load the association. No save was retried.');
  }
  async function planSelection() {
    const preview = state.preview;
    if (!scopeReady || !preview?.complete || !state.selectedItemIds.length || recoveryPending) return;
    await requests.run(async commit => {
      const plan = await planAction(input) as BoardImportPlan;
      if (plan.companyId !== companyId || plan.projectId !== state.projectId || plan.boardUrl !== state.boardUrl
        || typeof plan.supported !== 'boolean' || !Array.isArray(plan.rows) || !Array.isArray(plan.intents)
        || plan.boardId !== preview.boardId || plan.sourceUpdatedAt !== preview.updatedAt
        || !sameIds(plan.selectedItemIds, state.selectedItemIds)) throw new Error('Scope or revision changed.');
      commit({ plan, result: null });
    }, 'Selected-item planning failed or the board changed. Preview the board again; no import was attempted.');
  }
  async function execute() {
    const plan = state.plan;
    if (!importReady || !companyId || !plan) return;
    await requests.run(async commit => {
      const submission: Submission = { companyId, projectId: state.projectId, boardUrl: state.boardUrl,
        planId: plan.planId, operationIds: plan.intents.map(intent => intent.operationId), reconciled: false };
      try { retainSubmission(submission); } catch {
        commit({ error: 'Recovery identifiers could not be retained. No import was attempted.' }); return;
      }
      commit({ submission, result: null, plan: null });
      const result = checkedResult(await importAction({ ...input, planId: submission.planId }), submission);
      const verified = { ...submission, reconciled: result.complete };
      retainSubmission(verified);
      commit({ submission: verified, result,
        message: result.complete ? 'Saved tasks read back. Plan the selection again before a later sync.'
          : 'Some outcomes are unverified. Inspect retained operations before another import.' });
    }, 'Import outcome unverified. Inspect retained operations; do not repeat the import.');
  }
  async function recover() {
    const submission = state.submission;
    if (!companyId || !submission || submission.companyId !== companyId
      || submission.projectId !== state.projectId) return;
    await requests.run(async commit => {
      const result = checkedResult(await resultAction({ companyId, projectId: submission.projectId,
        boardUrl: submission.boardUrl, operationIds: submission.operationIds }), submission, true);
      const verified = { ...submission, reconciled: result.complete };
      retainSubmission(verified);
      commit({ submission: verified, result, plan: null,
        message: result.complete ? 'Retained operation receipts read back. No import was retried.'
          : 'Retained operation is still unverified. No import was retried.' });
    }, 'Could not verify retained operations. No import or retry was requested.');
  }

  return <section className="ghsync__section" aria-labelledby="gh-project-board-title" aria-busy={state.busy}>
    <h4 id="gh-project-board-title">GitHub Projects</h4>
    <p>Connect an existing GitHub board, then preview a finite selection before import. Previews save host verification records;
      they create no tasks, agent runs or GitHub writes.</p>
    <fieldset disabled={state.busy || !companyId}>
      <label htmlFor="gh-project-board-url">GitHub Project URL</label>
      <input id="gh-project-board-url" className="ghsync__input" type="url" value={state.boardUrl}
        placeholder="https://github.com/users/OWNER/projects/12"
        onChange={event => changeDraft({ boardUrl: event.target.value })} />
      <div id="gh-project-destination-label">Existing Paperclip destination</div>
      <div role="group" aria-labelledby="gh-project-destination-label">
        <ProjectPicker companyId={companyId} value={state.projectId} includeArchived={false}
          onChange={value => changeDraft({ projectId: value, connections: [], connectionId: '', bindingUnverified: false,
            submission: companyId ? readSubmission(companyId, value) : null })}
          placeholder="Select the existing destination project" />
      </div>
      <label htmlFor="gh-project-oauth-connection">Saved GitHub OAuth connection</label>
      <select id="gh-project-oauth-connection" className="ghsync__input" value={state.connectionId}
        onChange={event => changeDraft({ connectionId: event.target.value })}>
        <option value="">Choose a saved connection — none selected automatically</option>
        {state.connections.map(row => <option key={row.connectionId} value={row.connectionId}>
          {row.name}{' — @'}{row.login}{' (account '}{row.accountId}{')'}</option>)}
      </select>
      <button type="button" className="ghsync__button" disabled={!state.projectId}
        onClick={() => void listConnections()}>Load GitHub connections</button>
      <button type="button" className="ghsync__button" disabled={!draftReady || state.bindingUnverified}
        onClick={() => void bindConnection()}>Bind OAuth connection to board</button>
      <button type="button" className="ghsync__button" disabled={!state.projectId}
        onClick={() => void loadBinding()}>Load saved OAuth binding</button>
      {companyPrefix ? <p><a href={'/' + encodeURIComponent(companyPrefix) + '/apps/connect?source=github'}>Connect GitHub in Paperclip Apps</a></p> : null}
      <p>Connection names and account details are saved metadata, not a current permission or live-health check.</p>
      {state.binding ? <p>Saved binding: @{state.binding.login} (account {state.binding.accountId}); connection <code>{state.binding.connectionId}</code>;
        {' '}board <a href={state.binding.boardUrl} target="_blank" rel="noopener noreferrer">{state.binding.boardUrl}</a>.
        {' '}Read back for this company and destination.</p> : null}
      <button type="button" className="ghsync__button" disabled={!scopeReady}
        onClick={() => void previewOrSave(false)}>Preview board</button>
      <button type="button" className="ghsync__button" disabled={!state.projectId}
        onClick={() => void load()}>Load saved association</button>
      <button type="button" className="ghsync__button" disabled={!scopeReady || !state.preview?.complete}
        onClick={() => void previewOrSave(true)}>Save board association</button>
    </fieldset>
    <div role="status" aria-live="polite">{state.busy ? 'Checking selected GitHub Project items…' : state.message}</div>
    {state.error ? <p role="alert">{state.error}</p> : null}
    {state.bindingUnverified ? <p role="alert">A binding outcome is unverified. Load its saved state before another bind or import.</p> : null}
    <BoardSelection state={state} onSelect={select} onFilter={query => patch({ query, page: 0 })}
      onPage={page => patch({ page })} onLimit={maxSelected => {
        if (requests.locked() || !Number.isSafeInteger(maxSelected) || maxSelected < 1 || maxSelected > MAX_SELECTED) return;
        requests.invalidate(); patch({ maxSelected, selectedItemIds: state.selectedItemIds.slice(0, maxSelected), plan: null, result: null });
      }} />
    <ImportPlan plan={state.plan} preview={state.preview} companyPrefix={companyPrefix} />
    <fieldset disabled={state.busy || !companyId}>
      <button type="button" className="ghsync__button"
        disabled={!scopeReady || !state.preview?.complete || !state.selectedItemIds.length || recoveryPending}
        onClick={() => void planSelection()}>Preview selected changes</button>
      <button type="button" className="ghsync__button" disabled={!importReady} onClick={() => void execute()}>
        {state.plan && !state.plan.rows.some(row => row.disposition === 'create') ? 'Sync selected items' : 'Import selected items'}
      </button>
      <button type="button" className="ghsync__button" disabled={!state.submission}
        onClick={() => void recover()}>Inspect last submitted operations</button>
    </fieldset>
    {recoveryPending ? <p role="alert">An earlier import outcome is unverified. Inspect its retained operations before another import.</p> : null}
    <ImportResults result={state.result} companyPrefix={companyPrefix} />
    <p>Board association and import are separate from scheduled repository sync. No stock sync or agent run is requested here.</p>
  </section>;
}
