import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Uses only caller-selected demo sessions and locally generated files. No
// message is sent; draft fixtures and temporary tabs are removed afterwards.
const sessionA = process.env.DSH_TEST_SESSION_A, sessionB = process.env.DSH_TEST_SESSION_B;
assert.ok(sessionA && sessionB, 'Set DSH_TEST_SESSION_A and DSH_TEST_SESSION_B to two demo sessions');
const targets = await fetch(`http://127.0.0.1:${Number(process.env.DSH_DEBUG_PORT || 9227)}/json/list`).then(r => r.json());
const target = targets.find(t => t.url.startsWith('dsh-app:'));
assert.ok(target, 'No running DSH page found');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let counter = 0;
const pending = new Map(), added = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data), p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id); clearTimeout(p.timer);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
};
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++counter, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
});
const run = async (fn, ...args) => {
  const r = await call('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const settledLayout = async () => {
  for (let i = 0; i < 40; i++) {
    const raw = await run(() => {
      const raw = localStorage.getItem('dsh-splitview:layout:v3'), snap = JSON.parse(raw);
      const groups = node => node.type === 'group' ? [node] : node.children.flatMap(groups);
      const saved = groups(snap.root), ids = saved.flatMap(g => g.tabs.map(t => t.id));
      const dom = [...document.querySelectorAll('.dsv-tab')].map(t => t.dataset.dsvTab);
      const selected = document.querySelector('.dsv-tab[aria-selected=true]')?.dataset.dsvTab;
      return JSON.stringify(ids) === JSON.stringify(dom) && saved.find(g => g.id === snap.activeGroupId)?.activeTabId === selected ? raw : null;
    });
    if (raw) return raw;
    await wait(100);
  }
  throw new Error('Workspace persistence did not catch up with the rendered tabs');
};
const point = selector => run(selector => {
  const e = document.querySelector(selector);
  if (!e || !e.getBoundingClientRect().height) throw new Error(`Missing visible target: ${selector}`);
  const r = e.getBoundingClientRect(); return { x: r.x + r.width * .55, y: r.y + r.height * .35 };
}, selector);
const check = (name, condition) => { assert.ok(condition, name); console.log(`PASS ${name}`); };
const cleanupFiles = () => run(() => {
  for (const e of document.querySelectorAll('[contenteditable="true"]')) {
    const editor = e.__lexicalEditor;
    if (!editor) continue;
    editor.update(() => {
      for (const node of editor.getEditorState()._nodeMap.values()) {
        const data = node.exportJSON();
        if (data.type === 'reference-chip' && JSON.stringify(data).includes('dsv-drop-regression-')) node.remove();
      }
    }, { discrete: true });
  }
  for (const b of document.querySelectorAll('button[aria-label]')) {
    const label = b.getAttribute('aria-label');
    if (label.includes('dsv-drop-regression-') && /移除|删除|remove/i.test(label)) b.click();
  }
});
const draftHashes = ids => run(async ids => {
  const result = {};
  for (const id of ids) {
    const element = document.querySelector(`[data-dsv-tab-body="${id}"] [contenteditable="true"]`);
    const editor = element && element.__lexicalEditor;
    if (!editor) continue;
    const bytes = new TextEncoder().encode(JSON.stringify(editor.getEditorState().toJSON()));
    result[id] = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  return result;
}, ids);
const addTab = async title => {
  await run(() => document.querySelector('.dsv-workspace-actions button:first-child').click()); await wait(150);
  const id = await run(() => document.querySelector('.dsv-tab[aria-selected=true]').dataset.dsvTab); added.push(id);
  await run(title => { const row = [...document.querySelectorAll('.dsv-picker__row')].find(e => e.title === title); if (!row) throw new Error('Demo session not found'); row.click(); }, title);
  for (let i = 0; i < 40; i++) { await wait(150); if (await run(id => !!document.querySelector(`[data-dsv-tab-body="${id}"] [data-conversation-scroll]`), id)) return id; }
  throw new Error('Demo session did not load');
};
const receivers = name => run(name => [...document.querySelectorAll('.dsv-tabbody')].filter(e =>
  e.textContent.includes(name) || [...e.querySelectorAll('[aria-label],[alt],[title]')].some(n =>
    ['aria-label', 'alt', 'title'].some(a => n.getAttribute(a)?.includes(name))))
  .map(e => e.dataset.dsvTabBody), name);
const fixtureDir = fileURLToPath(new URL('../_scratch/tmp/file-drop-ui/', import.meta.url));
mkdirSync(fixtureDir, { recursive: true });
let fixtureIndex = 0, baseline;
const fixture = image => {
  const name = `dsv-drop-regression-${process.pid}-${++fixtureIndex}.${image ? 'png' : 'txt'}`;
  const path = fileURLToPath(new URL(name, new URL('../_scratch/tmp/file-drop-ui/', import.meta.url)));
  writeFileSync(path, image ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGPUWPCBARtgwio6aCUAWp8ByEW6pxkAAAAASUVORK5CYII=', 'base64') : 'Local file-drop regression fixture.\n');
  return { name, path };
};
const dropFile = async (selector, expected, { image = false, mixed = false } = {}) => {
  const f = fixture(image), before = await settledLayout();
  const at = await point(selector), data = { items: mixed ? [{ mimeType: 'text/plain', data: f.path }] : [], files: [f.path], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) { await call('Input.dispatchDragEvent', { type, ...at, data }); await wait(100); }
  await wait(500);
  check('native file-drop overlay closes', await run(() => !document.querySelector('[class*="mwbuSa_mask"]')));
  assert.deepEqual(await receivers(f.name), [expected], 'file must enter only the pointed conversation');
  assert.equal(await settledLayout(), before, 'file drop cannot change layout or active sessions');
  console.log(`PASS ${image ? 'image' : mixed ? 'file with text/plain' : 'file'} routes only to its target`);
  await cleanupFiles(); await wait(100);
};
try {
  await settledLayout();
  baseline = await run(() => ({ ids: [...document.querySelectorAll('.dsv-tab')].map(t => t.dataset.dsvTab),
    selected: document.querySelector('.dsv-tab[aria-selected=true]')?.dataset.dsvTab,
    panes: document.querySelectorAll('.dsv-group').length, layout: localStorage.getItem('dsh-splitview:layout:v3') }));
  assert.equal(baseline.panes, 1, 'Start from one pane so existing split proportions remain untouched');
  baseline.drafts = await draftHashes(baseline.ids);
  const a = await addTab(sessionA), b = await addTab(sessionB); await wait(400);
  const canceled = fixture(false), cancelAt = await point(`[data-dsv-tab-body="${b}"]`);
  const canceledData = { items: [], files: [canceled.path], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver']) { await call('Input.dispatchDragEvent', { type, ...cancelAt, data: canceledData }); await wait(100); }
  await call('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data: canceledData });
  // CDP cancellation itself emits no DOM terminal event. Deliver the viewport
  // leave that the browser sends when an external drag exits the application.
  await run(name => {
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File([''], name));
    document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer, clientX: 0, clientY: 0, relatedTarget: null }));
  }, canceled.name); await wait(250);
  check('leaving the window during a file drag dismisses the overlay', await run(() => !document.querySelector('[class*="mwbuSa_mask"]')));
  assert.deepEqual(await receivers(canceled.name), []);
  await dropFile(`[data-dsv-tab-body="${b}"]`, b);
  await dropFile(`[data-dsv-tab-body="${b}"]`, b, { mixed: true });
  await dropFile('.dsv-tabbar', b);
  // Use a native browser drop to detach A; B remains in the original pane.
  await run(id => document.querySelector(`[data-dsv-tab="${id}"]`).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })), a);
  const at = await run(() => { const r = document.querySelector('.dsv-group').getBoundingClientRect(); return { x: r.right - 8, y: r.top + r.height * .4 }; });
  const data = { items: [{ mimeType: 'text/plain', data: a }, { mimeType: 'application/x-dsv-tab', data: '1' }], dragOperationsMask: 16 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) { await call('Input.dispatchDragEvent', { type, ...at, data }); await wait(90); }
  await run(() => document.dispatchEvent(new DragEvent('dragend', { bubbles: true }))); await wait(450);
  check('session tab dragging still creates a split', await run(() => document.querySelectorAll('.dsv-group').length === 2));
  await dropFile(`[data-dsv-tab-body="${b}"]`, b, { mixed: true });
  await dropFile(`[data-dsv-tab-body="${a}"]`, a, { image: true });
  // The file picker uses the same native intake callback outside any drop.
  const f = fixture(false), doc = await call('DOM.getDocument');
  const input = await call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `[data-dsv-tab-body="${a}"] input[type=file]` });
  assert.ok(input.nodeId, 'Native file picker input must exist');
  await call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [f.path] }); await wait(600);
  assert.deepEqual(await receivers(f.name), [a]); console.log('PASS native file picker remains functional');
  await cleanupFiles();
  check('no render errors', await run(() => !document.querySelector('[data-slot-error],[data-factory-error]')));
} catch (error) {
  console.error('File-drop UI regression failed:', error.message);
  throw error;
} finally {
  await run(() => window.dispatchEvent(new DragEvent('dragend', { bubbles: true }))).catch(() => {});
  await cleanupFiles().catch(() => {});
  for (const id of added) await run(id => document.querySelector(`[data-dsv-tab="${id}"] .dsv-tab__close`)?.click(), id).catch(() => {});
  if (baseline?.selected) await run(id => document.querySelector(`[data-dsv-tab="${id}"]`)?.click(), baseline.selected).catch(() => {});
  await settledLayout();
  if (baseline?.drafts) {
    const restored = await draftHashes(baseline.ids);
    assert.deepEqual(Object.fromEntries(Object.keys(baseline.drafts).map(id => [id, restored[id]])), baseline.drafts, 'Original drafts must remain unchanged');
  }
  if (baseline?.layout) assert.deepEqual(await run(() => JSON.parse(localStorage.getItem('dsh-splitview:layout:v3'))), JSON.parse(baseline.layout), 'Original workspace must be restored');
  ws.close();
}
