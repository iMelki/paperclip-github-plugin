import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const TYPED_TOKEN = 'typed-token-company-a';
const refresh = () => undefined;

type SettingsRecord = Record<string, unknown>;

const host: { companyId: string | null; companyPrefix: string | null } = {
  companyId: 'company-a',
  companyPrefix: 'ca'
};
const readyCompanies = new Set<string>();
const settingsByCompany = new Map<string, SettingsRecord>();
const actionLog: string[] = [];
const httpLog: Array<{ method: string; url: string }> = [];

function idleData(loading: boolean, data?: SettingsRecord) {
  return { data, loading, error: null, refresh };
}

function installBrowser() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://paperclip.invalid/',
    pretendToBeVisual: true
  });
  const { window } = dom;
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      }
    });
  }

  const defineGlobal = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  defineGlobal('window', window);
  defineGlobal('document', window.document);
  defineGlobal('HTMLElement', window.HTMLElement);
  defineGlobal('HTMLInputElement', window.HTMLInputElement);
  defineGlobal('Node', window.Node);
  defineGlobal('navigator', window.navigator);
  defineGlobal('MutationObserver', window.MutationObserver);
  defineGlobal('Event', window.Event);
  defineGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const target = globalThis as typeof globalThis & {
    fetch: typeof fetch;
    __paperclipPluginBridge__: {
      sdkUi: Record<string, unknown>;
    };
  };
  target.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    const url = String(input);
    httpLog.push({ method, url });
    if (method !== 'GET' && method !== 'HEAD') {
      throw new Error(`forbidden ${method} ${url}`);
    }
    const body = url.includes('/api/companies/') ? { id: host.companyId, name: 'Company' } : [];
    return new window.Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  target.__paperclipPluginBridge__ = {
    sdkUi: {
      useHostContext: () => host,
      usePluginToast: () => () => undefined,
      usePluginData: (key: string, params?: Record<string, unknown>) => {
        if (key !== 'settings.registration') {
          return idleData(false);
        }
        const companyId = typeof params?.companyId === 'string' ? params.companyId : '';
        if (!companyId || !readyCompanies.has(companyId)) {
          return idleData(true);
        }
        return idleData(false, settingsByCompany.get(companyId));
      },
      usePluginAction: (key: string) => async () => {
        actionLog.push(key);
        throw new Error(`forbidden action ${key}`);
      }
    }
  };
  return dom;
}

const dom = installBrowser();

function baseSettings(companyId: string, extra: SettingsRecord = {}): SettingsRecord {
  return {
    mappings: [
      {
        id: `map-${companyId}`,
        repositoryUrl: 'https://github.com/acme/widgets',
        paperclipProjectName: 'Widgets',
        companyId
      }
    ],
    syncState: { status: 'idle' },
    scheduleFrequencyMinutes: 30,
    advancedSettings: { ignoredIssueAuthorUsernames: [] },
    githubTokenConfigured: false,
    paperclipBoardAccessConfigured: false,
    totalSyncedIssuesCount: 7,
    availableAssignees: [],
    updatedAt: '2026-10-22T12:00:00.000Z',
    ...extra
  };
}

function resetHarness() {
  host.companyId = 'company-a';
  host.companyPrefix = 'ca';
  readyCompanies.clear();
  settingsByCompany.clear();
  actionLog.length = 0;
  httpLog.length = 0;
  dom.window.document.getElementById('root')?.replaceChildren();
}

let settingsPage: (typeof import('./index.tsx'))['GitHubSyncSettingsPage'] | undefined;

async function loadPage() {
  if (!settingsPage) {
    settingsPage = (await import('./index.tsx')).GitHubSyncSettingsPage;
  }
  return settingsPage;
}

async function mount(): Promise<Root> {
  const Page = await loadPage();
  const container = dom.window.document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Page />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  console.log('mount-done', tokenInput()?.value ?? '<missing>');
  return root;
}

function tokenInput(): HTMLInputElement | null {
  const node = dom.window.document.getElementById('github-token');
  return node instanceof dom.window.HTMLInputElement ? node : null;
}

function exposeInput(): HTMLInputElement | null {
  const node = dom.window.document.getElementById('github-token-expose-host-secret');
  return node instanceof dom.window.HTMLInputElement ? node : null;
}

async function typeToken(root: Root, value: string) {
  const input = tokenInput();
  assert.ok(input, 'GitHub token field is visible');
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps'));
    const props = propsKey ? (input as unknown as Record<string, { onChange?: (event: { currentTarget: HTMLInputElement; target: HTMLInputElement }) => void }>)[propsKey] : undefined;
    props?.onChange?.({ currentTarget: input, target: input });
  });
  assert.equal(tokenInput()?.value, value, 'typed token is stored before a company switch');
  await tick(root);
  assert.equal(tokenInput()?.value, value, 'typed token stays in React state before a company switch');
  assert.deepEqual(actionLog, [], 'typing does not save or validate the token');
}

async function tick(root: Root) {
  const Page = await loadPage();
  await act(async () => {
    root.render(<Page />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function assertNoActions() {
  assert.deepEqual(actionLog, []);
  assert.deepEqual(
    httpLog.filter((entry) => entry.method !== 'GET' && entry.method !== 'HEAD'),
    []
  );
}

beforeEach(() => {
  resetHarness();
});

afterEach(() => {
  dom.window.document.getElementById('root')?.replaceChildren();
});

test('initial real settings export does not save, connect, or sync', async () => {
  readyCompanies.add('company-a');
  settingsByCompany.set(
    'company-a',
    baseSettings('company-a', {
      githubTokenConfigured: true,
      githubTokenLogin: 'octocat',
      updatedAt: '2026-10-22T12:04:00.000Z'
    })
  );

  const root = await mount();
  await tick(root);

  assert.match(dom.window.document.body.textContent ?? '', /Authenticated as octocat/);
  assert.equal(tokenInput()?.value ?? '', '');
  assert.equal(dom.window.document.body.textContent?.includes(TYPED_TOKEN), false);
  assertNoActions();
  root.unmount();
});

test('a typed company A token is cleared before company B settings reply', async () => {
  readyCompanies.add('company-a');
  settingsByCompany.set('company-a', baseSettings('company-a'));

  const root = await mount();
  await tick(root);
  await typeToken(root, TYPED_TOKEN);

  host.companyId = 'company-b';
  host.companyPrefix = 'cb';
  await tick(root);

  assert.equal(tokenInput()?.value ?? '', '');
  assert.equal(dom.window.document.body.textContent?.includes(TYPED_TOKEN), false);
  assertNoActions();
  root.unmount();
});

test('host-secret exposure opt-in clears immediately on company switch', async () => {
  readyCompanies.add('company-a');
  settingsByCompany.set('company-a', baseSettings('company-a'));

  const root = await mount();
  await tick(root);
  const checkbox = exposeInput();
  assert.ok(checkbox, 'host-secret opt-in is visible');
  await act(async () => {
    checkbox.click();
  });
  assert.equal(exposeInput()?.checked, true);

  host.companyId = 'company-b';
  host.companyPrefix = 'cb';
  await tick(root);

  assert.equal(exposeInput()?.checked ?? false, false);
  assertNoActions();
  root.unmount();
});

test('typed token is cleared after the fresh company B response', async () => {
  readyCompanies.add('company-a');
  settingsByCompany.set('company-a', baseSettings('company-a'));

  const root = await mount();
  await tick(root);
  await typeToken(root, TYPED_TOKEN);

  host.companyId = 'company-b';
  host.companyPrefix = 'cb';
  await tick(root);

  readyCompanies.add('company-b');
  settingsByCompany.set(
    'company-b',
    baseSettings('company-b', {
      githubTokenConfigured: false,
      updatedAt: '2026-10-22T12:08:00.000Z'
    })
  );
  await tick(root);

  assert.equal(tokenInput()?.value ?? '', '');
  assert.equal(dom.window.document.body.textContent?.includes(TYPED_TOKEN), false);
  assertNoActions();
  root.unmount();
});
