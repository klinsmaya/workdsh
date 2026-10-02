import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as cordis from '@deepseek-ai/cordis';
import * as slots from '@deepseek-ai/dsh-client-ui-slots';
import * as React from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as Jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { DraftPanelModel } from '../dist/model.js';
import { archive, deferred, draft, facade, material, ref, sha, state } from './fixtures.mjs';

// Receive one published browser artifact in the public ModuleLoader format.
// No resolver, loader loop or product service is created by this test receiver.
async function receiveArtifact(url, imports, expectedId) {
  let declaration;
  const scope = { window: { __ModuleLoader__: { load(value) { assert.equal(declaration, undefined); declaration = value; } } }, AbortController, AbortSignal, crypto, TextEncoder, setTimeout, clearTimeout, console };
  vm.runInNewContext(await readFile(url, 'utf8'), scope, { filename: expectedId });
  assert.equal(declaration.id, expectedId);
  return declaration.factory(name => { assert.ok(Object.hasOwn(imports, name), `undeclared external ${name}`); return imports[name]; });
}
test('published official SlotRegistry gates declarations, paired entries revoke on feature disposal', async () => {
  const native = await receiveArtifact(new URL('../node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js', import.meta.url), {
    '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-ui-slots': slots,
    react: React, 'react-dom': ReactDom, 'react-dom/client': ReactDomClient, 'react/jsx-runtime': Jsx,
  }, '@deepseek-ai/dsh-client-ui-renderer');
  // Client bundle consumes only the native atoms and React, with WorkDSH UI bundled.
  const feature = await receiveArtifact(new URL('../dist/client.browser.js', import.meta.url), {
    '@deepseek-ai/dsh-client-ui-primitives': { Button: props => React.createElement('button', props), Input: props => React.createElement('input', props) },
    react: React, 'react-dom': ReactDom, 'react/jsx-runtime': Jsx,
  }, 'workdsh-plugin-enterprise-drafts');
  const ctx = new cordis.Context();
  const releases = [], opened = [], calls = [], response = deferred(); let generationListener;
  ctx.provide('connection', {
    rpc: { async call(channel, endpoint, payload, signal) { calls.push({ channel, endpoint, payload, signal }); return response.promise; } },
    generation: { getSnapshot: () => ({ id: 'fixture-generation' }), subscribe(listener) { generationListener = listener; return () => releases.push('generation'); } },
  });
  ctx.provide('layout', { selectPanel: key => opened.push(['panel', key]), toggleSidebar: () => opened.push(['sidebar']) });
  ctx.provide('uiWorkspace', { openSession: sessionId => opened.push(['session', sessionId]) });
  await ctx.plugin(native.SlotRegistry);
  const registry = ctx.get('slots'); assert.ok(registry);
  const fiber = ctx.plugin(feature); await fiber;
  assert.equal(registry.entries('main').length, 0); assert.equal(registry.entries('sidebar.panellist').length, 0);
  // Declare the official owner seats as a headless shell fixture. Actual SlotRegistry
  // performs declaration/registration effects; no GUI or replacement shell is mounted.
  const releaseOwner = registry.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
  } }, () => null);
  const main = registry.entries('main'), sidebar = registry.entries('sidebar.panellist');
  assert.equal(main.length, 1); assert.equal(sidebar.length, 1);
  assert.equal(main[0].options.key, feature.panelKey); assert.equal(sidebar[0].options.id, feature.panelKey);
  assert.equal(registry.entries('root').length, 1);
  const injected = main[0].inject();
  await injected.openSession('session-A'); assert.deepEqual(opened, [['session', 'session-A'], ['panel', null]]);
  const model = injected.model; const refreshing = model.refresh(); assert.equal(calls.length, 1);
  const active = calls[0].signal; await fiber.dispose(); assert.equal(active.aborted, true);
  response.resolve({ ok: true, value: state({ drafts: [draft()] }) }); await refreshing;
  assert.equal(model.getSnapshot().state, undefined); assert.equal(registry.entries('main').length, 0); assert.equal(registry.entries('sidebar.panellist').length, 0); assert.deepEqual(releases, ['generation']);
  assert.equal(registry.entries('root').length, 1); releaseOwner(); await ctx.fiber.dispose();
});
test('headless actual React panel escapes malicious material and draft text, shows receipt-only archive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'afos-draft-ssr-'));
  try {
    // The published atoms pull browser CSS/highlighters. Native atoms are a thin
    // host-element fixture here; actual Panel, shared WorkDSH controls, Modal,
    // React escaping and status/details are exercised. This is not a GUI test.
    const output = await build({ entryPoints: [new URL('../src/client/Panel.tsx', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'], plugins: [{ name: 'ssr-native-atoms-fixture', setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'native-atoms', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `import * as React from 'react'; export function Button({variant,size,...props}){return React.createElement('button',props)}; export function Input(props){return React.createElement('input',props)}`, loader: 'js' }));
    } }] });
    // Keep temporary bundle inside the package so React resolves the same pinned copy.
    const file = new URL('../dist/panel.ssr-test.mjs', import.meta.url); await writeFile(file, output.outputFiles[0].text);
    const { EnterpriseDraftPanel, archiveLabel, DraftDetails } = await import(file.href);
    const hostile = '<script>fixtureAttack()</script><img src=x onerror=fixtureAttack()>', row = draft({ content: hostile, sha256: sha(hostile), execution: 'cancel_requested' });
    const model = new DraftPanelModel(facade({ state: async () => state({ drafts: [row] }), materials: async () => [{ ...material(), name: hostile }] }));
    await model.refresh();
    const html = renderToStaticMarkup(React.createElement(EnterpriseDraftPanel, { model, openSession: async () => {}, toggleNavigation() {} }));
    assert.ok(!html.includes('<script>fixtureAttack()')); assert.ok(!html.includes('<img src=x')); assert.ok(html.includes('&lt;script&gt;fixtureAttack()&lt;/script&gt;'));
    assert.match(html, /已请求取消，等待停止确认/); assert.match(html, /本地工作副本 · 未归档/); assert.match(html, /待人工核对/); assert.match(html, /纯文本/);
    assert.ok(!html.includes('已归档 · 服务器回执确认'));
    assert.match(archiveLabel({ ...row, archive: 'receipt-recorded' }), /未归档/);
    const receiptHtml = renderToStaticMarkup(React.createElement(DraftDetails, { draft: archive(draft()) }));
    assert.match(receiptHtml, /已归档 · 服务器回执确认/); assert.match(receiptHtml, /receipt-A/); assert.match(receiptHtml, /artifact-revision-1/); model.close();
    await rm(file, { force: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
