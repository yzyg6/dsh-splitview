import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Run against an already running DSH with --remote-debugging-port=9227.
// Only new workspace tabs are moved/closed; sessions and messages are untouched.
const port = Number(process.env.DSH_DEBUG_PORT || 9227);
const sessionA = process.env.DSH_TEST_SESSION_A;
const sessionB = process.env.DSH_TEST_SESSION_B;
assert.ok(sessionA && sessionB, 'Set DSH_TEST_SESSION_A and DSH_TEST_SESSION_B to two existing history sessions');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
const target = targets.find(t => t.url.startsWith('dsh-app:'));
assert.ok(target, 'No running DSH page found');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let counter = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data), p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id); clearTimeout(p.timer);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
};
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++counter;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
});
const run = async (fn, ...args) => {
  const r = await call('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const state = () => run(() => ({
  groups: [...document.querySelectorAll('.dsv-tabbar')].map(bar => ({ id: bar.dataset.dsvTabGroup,
    tabs: [...bar.querySelectorAll('.dsv-tab')].map(t => ({ id: t.dataset.dsvTab, title: t.title, selected: t.getAttribute('aria-selected') === 'true' })) })),
  paneCount: document.querySelectorAll('.dsv-group').length,
  errors: [...document.querySelectorAll('[data-slot-error],[data-factory-error]')].map(e => e.textContent),
}));
const tabGroup = async id => (await state()).groups.find(g => g.tabs.some(t => t.id === id));
const check = (name, value) => { assert.ok(value, name); console.log(`PASS ${name}`); };
const clickTab = async id => { await run(id => document.querySelector(`[data-dsv-tab="${id}"]`).click(), id); await wait(180); };
const addTab = async (title) => {
  await run(() => document.querySelector('.dsv-workspace-actions button:first-child').click()); await wait(100);
  const id = await run(() => document.querySelector('.dsv-tab[aria-selected=true]').dataset.dsvTab);
  if (title) {
    await run(title => { const row = [...document.querySelectorAll('.dsv-picker__row')].find(b => b.title === title); if (!row) throw new Error(`Session not found: ${title}`); row.click(); }, title);
    await wait(600);
  }
  return id;
};
const mouseClick = async (selector, button = 'left') => {
  const p = await run(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, selector);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button, clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button, clickCount: 1 }); await wait(200);
};
const key = async (name, code) => {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code }); await wait(200);
};
const beginDrag = async id => {
  await run(id => { const e = document.querySelector(`[data-dsv-tab="${id}"]`); window.__dsvTabQA.source = e; e.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })); }, id);
  return { items: [{ mimeType: 'text/plain', data: id }, { mimeType: 'application/x-dsv-tab', data: '1' }], dragOperationsMask: 16 };
};
const drop = async (id, target) => {
  const data = await beginDrag(id);
  const p = await run(target => {
    const e = target.tab ? document.querySelector(`[data-dsv-tab="${target.tab}"]`) : document.querySelector(`[data-dsv-group="${target.group}"]`);
    const r = e.getBoundingClientRect();
    return { x: target.tab ? r.left + (target.after ? r.width - 3 : 3) : target.edge === 'left' ? r.left + 8 : target.edge === 'right' ? r.right - 8 : r.left + r.width / 2,
      y: target.tab ? r.top + r.height / 2 : target.edge === 'top' ? r.top + 8 : target.edge === 'bottom' ? r.bottom - 8 : r.top + r.height / 2 };
  }, target);
  for (const type of ['dragEnter', 'dragOver', 'drop']) { await call('Input.dispatchDragEvent', { type, ...p, data }); await wait(70); }
  await run(() => document.dispatchEvent(new DragEvent('dragend', { bubbles: true }))); await wait(350);
};
const closeTab = id => mouseClick(`[data-dsv-tab="${id}"] .dsv-tab__close`);
const contextAction = async (id, label) => {
  await run(id => { const e = document.querySelector(`[data-dsv-tab="${id}"]`), r = e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.bottom })); }, id);
  await wait(100);
  await run(label => { const b = [...document.querySelectorAll('.dsv-ctx__item')].find(e => e.textContent === label); if (!b || b.disabled) throw new Error(`Unavailable context action: ${label}`); b.click(); }, label);
  await wait(200);
};
let baseline;
try {
  baseline = await run(() => {
    if (window.__dsvTabQA) throw new Error('A previous DSH UI test is still registered');
    const tabs = [...document.querySelectorAll('.dsv-tab')];
    const selected = tabs.find(t => t.getAttribute('aria-selected') === 'true');
    if (!selected) throw new Error('Open a DSH conversation before testing');
    const original = { ids: tabs.map(t => t.dataset.dsvTab), selected: selected.dataset.dsvTab, group: selected.closest('.dsv-tabbar').dataset.dsvTabGroup, panes: document.querySelectorAll('.dsv-group').length };
    if (original.panes !== 1) throw new Error('Run the full UI matrix from one pane so existing split proportions remain untouched');
    const savedLayout = JSON.parse(localStorage.getItem('dsh-splitview:layout:v3') || '{}');
    if (original.panes >= (savedLayout.maxPanes || 4)) throw new Error('One free pane is required for UI tests');
    const roots = [...document.querySelectorAll('.dsv-tabbody:not([hidden]) [data-conversation-content]')];
    const scrolls = [...document.querySelectorAll('.dsv-tabbody:not([hidden]) [data-conversation-scroll]')].map(node => ({ node, top: node.scrollTop }));
    const test = window.__dsvTabQA = { original, roots, scrolls, events: [], errors: [] };
    test.onDrop = e => { if (e.isTrusted) setTimeout(() => test.events.push({ allowed: e.dataTransfer.effectAllowed, effect: e.dataTransfer.dropEffect, accepted: e.defaultPrevented }), 0); };
    test.onError = e => test.errors.push(e.message);
    document.addEventListener('drop', test.onDrop, true); window.addEventListener('error', test.onError);
    return original;
  });
  const b = await addTab(sessionA);
  const c = await addTab(sessionB);
  await drop(c, { tab: b });
  let group = await tabGroup(b);
  check('same-pane backward reorder follows insertion marker', group.tabs.findIndex(t => t.id === c) + 1 === group.tabs.findIndex(t => t.id === b));
  await drop(c, { tab: b, after: true });
  group = await tabGroup(b);
  check('same-pane forward reorder follows insertion marker', group.tabs.findIndex(t => t.id === b) + 1 === group.tabs.findIndex(t => t.id === c));
  await drop(b, { group: baseline.group, edge: 'left' });
  let bpane = await tabGroup(b);
  check('drag to left edge detaches original tab', bpane.id !== baseline.group && (await state()).paneCount === baseline.panes + 1);
  check('left edge creates a pane on the left', await run((left, right) => document.querySelector(`[data-dsv-group="${left}"]`).getBoundingClientRect().left < document.querySelector(`[data-dsv-group="${right}"]`).getBoundingClientRect().left, bpane.id, baseline.group));
  const separator = await run(() => { const r = document.querySelector('.dsv-resizer').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const originalWidth = await run(id => document.querySelector(`[data-dsv-group="${id}"]`).getBoundingClientRect().width, bpane.id);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...separator, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: separator.x + 45, y: separator.y, button: 'left', buttons: 1 }); await wait(100);
  check('divider moves only a preview during native mouse dragging', await run((id, width) => !!document.querySelector('.dsv-resize-preview') && Math.abs(document.querySelector(`[data-dsv-group="${id}"]`).getBoundingClientRect().width - width) < 1, bpane.id, originalWidth));
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: separator.x + 45, y: separator.y, button: 'left', clickCount: 1 }); await wait(300);
  check('divider commits the width once without remounting existing content', await run((id, width) => !document.querySelector('.dsv-resize-preview') && document.querySelector(`[data-dsv-group="${id}"]`).getBoundingClientRect().width > width + 30 && window.__dsvTabQA.roots.every(n => n.isConnected), bpane.id, originalWidth));
  await clickTab(c);
  await run(id => {
    const scroll = document.querySelector(`[data-dsv-tab-body="${id}"] [data-conversation-scroll]`);
    scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    scroll.scrollTop = Math.min(1600, (scroll.scrollHeight - scroll.clientHeight) / 2);
    scroll.dispatchEvent(new Event('scroll'));
  }, c);
  await wait(300);
  const reading = await run(id => {
    const scroll = document.querySelector(`[data-dsv-tab-body="${id}"] [data-conversation-scroll]`), edge = scroll.getBoundingClientRect().top;
    const anchor = [...scroll.querySelectorAll('[data-chat-anchor-key]')].find(n => { const r = n.getBoundingClientRect(); return r.height > 0 && r.bottom > edge && r.top < edge + scroll.clientHeight; });
    return { key: anchor?.getAttribute('data-chat-anchor-key'), offset: anchor ? anchor.getBoundingClientRect().top - edge : 0, top: scroll.scrollTop };
  }, c);
  await drop(c, { tab: b, after: true });
  check('cross-pane move keeps the tab ID and selects its target', (await tabGroup(c)).id === bpane.id && (await tabGroup(c)).tabs.find(t => t.id === c).selected);
  await wait(700);
  check('cross-pane move restores the semantic reading anchor', await run((id, saved) => {
    const scroll = document.querySelector(`[data-dsv-tab-body="${id}"] [data-conversation-scroll]`);
    const anchor = [...scroll.querySelectorAll('[data-chat-anchor-key]')].find(n => n.getAttribute('data-chat-anchor-key') === saved.key);
    return anchor ? Math.abs(anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - saved.offset) < 4 : Math.abs(scroll.scrollTop - saved.top) < 4;
  }, c, reading));
  if (process.env.DSH_UI_SCREENSHOT) {
    assert.ok(isAbsolute(process.env.DSH_UI_SCREENSHOT), 'Screenshot output must be an absolute path');
    const width = await run(() => innerWidth);
    const shot = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: 190, scale: 1 } });
    writeFileSync(process.env.DSH_UI_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await drop(c, { tab: baseline.selected, after: true });
  check('cross-pane return keeps original pane mounted', (await tabGroup(c)).id === baseline.group && await run(() => window.__dsvTabQA.roots.every(node => node.isConnected)));
  await drop(b, { group: baseline.group, edge: 'bottom' });
  bpane = await tabGroup(b);
  check('moving a sole tab to a lower edge collapses its old pane', (await state()).paneCount === baseline.panes + 1);
  check('bottom edge places the moved pane below the target', await run((a, b) => document.querySelector(`[data-dsv-group="${a}"]`).getBoundingClientRect().top > document.querySelector(`[data-dsv-group="${b}"]`).getBoundingClientRect().top, bpane.id, baseline.group));
  for (const edge of ['top', 'right']) {
    await drop(b, { group: baseline.group, edge }); bpane = await tabGroup(b);
    check(`${edge} edge positions the moved pane correctly`, await run((a, b, edge) => {
      const x = document.querySelector(`[data-dsv-group="${a}"]`).getBoundingClientRect(), y = document.querySelector(`[data-dsv-group="${b}"]`).getBoundingClientRect();
      return edge === 'top' ? x.top < y.top : x.left > y.left;
    }, bpane.id, baseline.group, edge));
  }
  await closeTab(b);
  check('closing the last tab collapses its pane', (await state()).paneCount === baseline.panes);
  await clickTab(baseline.selected); await closeTab(c);
  check('closing a background tab preserves the selected session', (await tabGroup(baseline.selected)).tabs.find(t => t.id === baseline.selected).selected);

  const disposable = await addTab();
  await drop(disposable, { group: baseline.group, edge: 'right' });
  const menuTab = await addTab(sessionA);
  await closeTab(disposable);
  await addTab(); await addTab();
  await contextAction(menuTab, '关闭右侧标签');
  check('context menu closes tabs to the right only', (await tabGroup(menuTab)).tabs.length === 1);
  await addTab(); await addTab();
  await contextAction(menuTab, '关闭其他标签');
  check('context menu closes other tabs only in its pane', (await tabGroup(menuTab)).tabs.length === 1 && await run(ids => ids.every(id => document.querySelector(`[data-dsv-tab="${id}"]`)), baseline.ids));
  const middle = await addTab();
  await mouseClick(`[data-dsv-tab="${middle}"]`, 'middle');
  check('middle click closes a tab', !(await tabGroup(middle)));
  const deleted = await addTab();
  await run(id => document.querySelector(`[data-dsv-tab="${id}"]`).focus(), deleted);
  await key('Delete', 46);
  check('Delete closes the focused tab and restores focus', !(await tabGroup(deleted)) && await run(id => document.activeElement?.dataset.dsvTab === id, menuTab));
  await run(id => document.querySelector(`[data-dsv-tab="${id}"]`).focus(), menuTab);
  await key('Home', 36);
  check('Home activates the first workspace tab', await run(id => document.querySelector('.dsv-tab[aria-selected=true]')?.dataset.dsvTab === id, baseline.ids[0]));
  const nextTab = await run(() => document.querySelectorAll('.dsv-tab')[1].dataset.dsvTab);
  await key('ArrowRight', 39);
  check('Right arrow activates the next tab', await run(id => document.querySelector('.dsv-tab[aria-selected=true]')?.dataset.dsvTab === id, nextTab));
  await key('ArrowLeft', 37);
  check('Left arrow activates the previous tab', await run(id => document.querySelector('.dsv-tab[aria-selected=true]')?.dataset.dsvTab === id, baseline.ids[0]));
  await key('End', 35);
  check('End activates the last workspace tab', await run(id => document.querySelector('.dsv-tab[aria-selected=true]')?.dataset.dsvTab === id, menuTab));
  await closeTab(menuTab);
  check('close button removes the active tab and restores the layout', (await state()).paneCount === baseline.panes);

  await clickTab(baseline.selected);
  const overflow = [];
  for (let i = 0; i < 16; i++) overflow.push(await addTab());
  await wait(350);
  check('overflow adds navigation buttons and reveals the selected tab', await run(() => { const n = document.querySelector('.dsv-workspace-tabs'), tab = n.querySelector('[aria-selected=true]'), r = n.getBoundingClientRect(), t = tab.getBoundingClientRect(); return document.querySelectorAll('.dsv-tabscroll').length === 2 && t.left >= r.left - 1 && t.right <= r.right + 1; }));
  const before = await run(() => document.querySelector('.dsv-workspace-tabs').scrollLeft);
  await mouseClick('.dsv-tabscroll');
  check('overflow navigation scrolls the strip', await run(before => document.querySelector('.dsv-workspace-tabs').scrollLeft < before, before));
  await clickTab(overflow.at(-1)); await wait(150);
  const data = await beginDrag(overflow.at(-1));
  const p = await run(() => { const r = document.querySelector('.dsv-workspace-tabs').getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2 }; });
  const previous = await run(() => document.querySelector('.dsv-workspace-tabs').scrollLeft);
  for (const type of ['dragEnter', 'dragOver', 'dragOver']) { await call('Input.dispatchDragEvent', { type, ...p, data }); await wait(70); }
  check('dragging near an overflow edge scrolls towards hidden tabs', await run(previous => document.querySelector('.dsv-workspace-tabs').scrollLeft < previous, previous));
  await call('Input.dispatchDragEvent', { type: 'dragCancel', ...p, data });
  await run(() => document.dispatchEvent(new DragEvent('dragend', { bubbles: true }))); await wait(150);
  check('cancelled drag removes all insertion and split previews', await run(() => !document.querySelector('.dsv-tab[data-insert],.dsv-drop')));
  const evidence = await run(() => ({ events: window.__dsvTabQA.events, errors: window.__dsvTabQA.errors }));
  check('Chromium accepted move-only native drops', evidence.events.length >= 7 && evidence.events.every(e => e.allowed === 'move' && e.effect === 'move' && e.accepted));
  check('no host rendering or JavaScript errors', evidence.errors.length === 0 && (await state()).errors.length === 0);
} finally {
  if (baseline) {
    await run(() => {
      const q = window.__dsvTabQA;
      document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      for (const e of [...document.querySelectorAll('.dsv-tab')]) if (!q.original.ids.includes(e.dataset.dsvTab)) e.querySelector('.dsv-tab__close').click();
      document.querySelector(`[data-dsv-tab="${q.original.selected}"]`)?.click();
    });
    await wait(700);
    const cleanup = await run(() => {
      const q = window.__dsvTabQA;
      q.scrolls.forEach(({ node, top }) => { if (node.isConnected) node.scrollTop = top; });
      const result = { ids: [...document.querySelectorAll('.dsv-tab')].map(t => t.dataset.dsvTab), panes: document.querySelectorAll('.dsv-group').length,
        selected: document.querySelector('.dsv-tab[aria-selected=true]')?.dataset.dsvTab,
        originalDOM: q.roots.every(node => node.isConnected), readingRestored: q.scrolls.every(({ node, top }) => node.isConnected && Math.abs(node.scrollTop - top) < 1) };
      document.removeEventListener('drop', q.onDrop, true); window.removeEventListener('error', q.onError); delete window.__dsvTabQA;
      return result;
    });
    assert.deepEqual(cleanup.ids, baseline.ids, 'Original tabs must be restored');
    assert.equal(cleanup.panes, baseline.panes, 'Original pane count must be restored');
    assert.equal(cleanup.selected, baseline.selected, 'Original selection must be restored');
    assert.ok(cleanup.originalDOM, 'Original conversation DOM must stay mounted');
    assert.ok(cleanup.readingRestored, 'Original reading position must be restored');
    console.log('PASS restored original tabs, panes, selection and reading position');
  }
  ws.close();
}
