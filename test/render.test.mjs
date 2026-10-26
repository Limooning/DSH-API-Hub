// The client bundle is plain ESM evaluated inside the host page: a typo there
// does not fail any server test, it blanks the whole settings page. This test
// mounts the exported components against a stub React, so a broken render shows
// up in `npm test` instead of in the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const bundle = fileURLToPath(new URL('../lib/client.js', import.meta.url));

function loadPanel() {
  const h = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
  });
  const React = {
    createElement: h,
    Fragment: Symbol('Fragment'),
    useState: (init) => (typeof init === 'function' ? [init(), () => {}] : [init, () => {}]),
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    memo: (fn) => fn,
    __esModule: true,
  };

  let captured = null;
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (entry) => { captured = entry; } },
      addEventListener() {},
      removeEventListener() {},
      setTimeout,
      clearTimeout,
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild() {} },
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({}),
    }),
    location: { origin: 'http://127.0.0.1:1', pathname: '/', href: 'http://127.0.0.1:1/' },
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    AbortController,
    TextEncoder,
    TextDecoder,
    structuredClone,
    queueMicrotask,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.runInNewContext(readFileSync(bundle, 'utf8'), sandbox, { filename: 'client.js' });
  assert.ok(captured, 'the bundle never called __ModuleLoader__.load');
  const mod = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error('unexpected require: ' + name);
  });
  return mod.__components ?? {};
}

const PROVIDER = {
  id: 'demo',
  name: 'Demo',
  enabled: true,
  isDefault: true,
  kind: 'llm',
  kinds: ['llm'],
  types: ['text'],
  kindSource: 'auto',
  baseURL: 'https://api.example.com/v1',
  tag: '文本',
  keyMasked: 'sk-ab…cd12',
  keyPresent: true,
  defaultModel: 'demo-1',
  selectedModels: ['demo-1'],
  selectedCount: 1,
  cachedCount: 1,
  builtin: false,
  keySource: { type: 'file' },
  vision: null,
  usedBy: { llm: true },
};

const DRAG = {
  draggingId: null,
  overId: null,
  side: null,
  onStart() {},
  onOver() {},
  onEnd() {},
  onDrop() {},
};

test('every exported component renders without throwing', () => {
  const C = loadPanel();
  const cases = {
    ApiHubPanel: () => C.ApiHubPanel({ base: 'http://127.0.0.1:1', onNotice: () => {} }),
    ApiHubSettingsPage: () => C.ApiHubSettingsPage({ base: 'http://127.0.0.1:1' }),
    ProviderCard: () => C.ProviderCard({ provider: PROVIDER, balances: {}, drag: DRAG, edge: null }),
    'ProviderCard without a drag handle': () => C.ProviderCard({ provider: PROVIDER, balances: {} }),
    'ProviderCard while disabled': () => C.ProviderCard({ provider: { ...PROVIDER, enabled: false }, balances: {} }),
    Switch: () => C.Switch({ on: true, onChange() {} }),
    SkillRow: () => C.SkillRow({ skill: { id: 'demo', name: 'Demo', enabled: true, tags: ['x'], scope: 'global' } }),
    'SkillRow with a renameable tag': () => C.SkillRow({ skill: { id: 'demo', name: 'Demo', enabled: true, tags: ['x'], scope: 'global' }, onTagRename: async () => '' }),
    TagChip: () => C.TagChip({ tag: '生图', label: '生图 3', style: {}, onFilter() {}, onRename: async () => '' }),
    'TagChip without actions': () => C.TagChip({ tag: '生图', label: '生图', style: {} }),
    EmptyState: () => C.EmptyState({ title: '空', hint: '还没有东西' }),
  };
  for (const [label, render] of Object.entries(cases)) {
    assert.doesNotThrow(render, label + ' threw while rendering');
  }
  assert.ok(C.ApiHubPanel, 'ApiHubPanel is exported');
});
