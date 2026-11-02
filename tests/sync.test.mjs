import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

// Execute the shipped bundle and its real Takeover effects. The host's
// session projection and React commit scheduling are controlled by the test.
function harness() {
  let hooks = [], cursor = 0, effects = [], api;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    createContext: value => ({ Provider() {}, value }),
    useContext: context => context.value,
    cloneElement: (element, props) => ({ ...element, props: { ...element.props, ...props } }),
    createRef: () => ({ current: null }),
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value }; },
    useState(value) { const ref = React.useRef(value); return [ref.current, next => { ref.current = next; }]; },
    useReducer(fn, value) { const ref = React.useRef(value); return [ref.current, () => { ref.current = fn(ref.current); }]; },
    useMemo(fn, deps) {
      const i = cursor++, prev = hooks[i];
      if (!prev || deps.some((v, n) => !Object.is(v, prev.deps[n]))) hooks[i] = { deps, value: fn() };
      return hooks[i].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const i = cursor++, prev = hooks[i];
      if (!prev || deps.some((v, n) => !Object.is(v, prev.deps[n]))) {
        effects.push(() => { prev?.cleanup?.(); hooks[i] = { deps, cleanup: fn() }; });
      }
    },
    useLayoutEffect(fn, deps) { return React.useEffect(fn, deps); },
    useSyncExternalStore(subscribe, get) { return get(); },
  };
  let source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  source = source.replace("return module.exports;", "return { Takeover, store, runtime, installer, listGroups, useReferenceReady, useHeldReferences, createReadingMemory, captureReading, restoreReading, Resizer, PaneBody, installNativeHeader, nativeSlotName, WorkspaceTabs, createStore, readingMemory, readingCaptures, persistWorkspace, loadReadingHistory, createNativeReadingStore, installGlobalDrop, PaneAttachments, PaneContext, fileDropTarget };");
  const documentListeners = new Map();
  const timers = new Map();
  const frames = new Map();
  const createdNodes = [];
  const savedStorage = new Map();
  const storage = { getItem: key => savedStorage.get(key) ?? null, setItem: (key, value) => savedStorage.set(key, value) };
  let timerId = 0;
  const context = {
    window: { __ModuleLoader__: { load({ factory }) { api = factory(() => React); } } },
    localStorage: storage,
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timers.delete(id), console,
    requestAnimationFrame: fn => { frames.set(++timerId, fn); return timerId; },
    cancelAnimationFrame: id => frames.delete(id),
    document: {
      querySelectorAll: () => [],
      createElement: () => { const node = { style: {}, setAttribute() {}, remove() { node.removed = true; } }; createdNodes.push(node); return node; },
      body: { appendChild() {} },
      addEventListener: (name, fn) => documentListeners.set(name, fn),
      removeEventListener: name => documentListeners.delete(name),
    },
  };
  vm.runInNewContext(source, context);
  const list = { ids: ["A", "B", "C"], byId: { A: {}, B: {}, C: {} } };
  const writes = [];
  api.runtime.t = key => key;
  api.runtime.sessions = {
    list: { getSnapshot: () => list },
    retain: () => ({ release() {} }),
  };
  api.runtime.uiWorkspace = { openSession: id => writes.push(id) };
  const left = api.store.getSnapshot().root.id;
  api.store.actions.adoptSession("A");
  const right = api.store.actions.splitGroup(left, "row", "after", "B");
  api.store.actions.focusGroup(left);
  return {
    ...api, left, right, list, writes, documentListeners, createdNodes, storage, document: context.document,
    runTimers(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } },
    runFrames() { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } },
    component(Component, props) {
      cursor = 0; effects = [];
      const result = Component(props);
      for (const effect of effects) effect();
      return result;
    },
    render(mainSession, remount = false) {
      if (remount) { for (const hook of hooks) hook?.cleanup?.(); hooks = []; }
      cursor = 0; effects = [];
      const tree = api.Takeover({ sessionId: mainSession, renderSlot: () => null, SessionProvider() {} });
      for (const effect of effects) effect();
      return tree;
    },
    active() {
      const state = api.store.getSnapshot();
      const group = api.listGroups(state.root).find(g => g.id === state.activeGroupId);
      return group.tabs.find(t => t.id === group.activeTabId).sessionId;
    },
  };
}

function groupElement(tree, id) {
  if (!tree || typeof tree !== "object") return undefined;
  if (tree.props?.["data-dsv-group"] === id) return tree;
  return (tree.children || []).flat(Infinity).map(child => groupElement(child, id)).find(Boolean);
}

test("composer autofocus cannot take ownership from another pane", () => {
  const h = harness();
  const tree = h.render("A");
  groupElement(tree, h.right).props.onFocusCapture();
  assert.equal(h.active(), "A");
});

test("pointer input and Tab navigation still select panes", () => {
  const h = harness();
  const tree = h.render("A");
  groupElement(tree, h.right).props.onPointerDownCapture();
  assert.equal(h.active(), "B");
  h.documentListeners.get("keydown")({ key: "Tab" });
  groupElement(tree, h.left).props.onFocusCapture();
  assert.equal(h.active(), "A");
  // A following programmatic focus must not reuse the Tab intent.
  groupElement(tree, h.right).props.onFocusCapture();
  assert.equal(h.active(), "A");
});

test("focusing A → B → A updates the host each time", () => {
  const h = harness();
  h.render("A");
  h.store.actions.focusGroup(h.right); h.render("A");
  assert.equal(h.writes.at(-1), "B");
  h.render("B");
  h.store.actions.focusGroup(h.left); h.render("B");
  assert.equal(h.writes.at(-1), "A");
});

test("a sidebar switch and a list update cannot push the previous pane back", () => {
  const h = harness();
  h.render("A");
  h.list.ids.push("D"); h.list.byId.D = {};
  h.render("C");
  assert.equal(h.active(), "C");
  assert.deepEqual(h.writes, []);
});

test("host remount during a pane switch keeps the chosen pane", () => {
  const h = harness();
  h.render("A");
  h.store.actions.focusGroup(h.right); h.render("A");
  h.render("B", true);
  assert.equal(h.active(), "B");
  assert.deepEqual(h.writes, ["B"]);
});

test("list churn and resize commits cannot repeatedly open a pending session", () => {
  const h = harness();
  h.render("A");
  h.store.actions.focusGroup(h.right); h.render("A");
  for (let i = 0; i < 100; i++) {
    h.list.byId = { ...h.list.byId };
    h.list.ids = [...h.list.ids, `new-${i}`];
    const root = h.store.getSnapshot().root;
    h.store.actions.setSizes(root.id, [0.3 + i / 1000, 0.7 - i / 1000]);
    h.render("A");
  }
  assert.equal(h.active(), "B");
  assert.deepEqual(h.writes, ["B"]);
  h.render("B");
  h.render("A"); // Sidebar is allowed to revisit a previously selected session.
  assert.equal(h.active(), "A");
  assert.deepEqual(h.writes, ["B"]);
});

test("an unknown restored session retries when it becomes known at the same list size", () => {
  const h = harness();
  h.render("A");
  delete h.list.byId.B;
  h.store.actions.focusGroup(h.right); h.render("A");
  assert.deepEqual(h.writes, []);
  h.list.byId.B = {}; h.render("A");
  assert.deepEqual(h.writes, ["B"]);
});

test("workspace tabs persist in one pane and disabling hands back the native host", () => {
  const h = harness();
  let installs = 0, disposals = 0;
  h.installer.ctx = { slots: { inject() { installs++; return () => disposals++; } } };
  h.installer.sync(); h.installer.sync();
  assert.equal(installs, 2);
  h.store.actions.setEnabled(false); h.installer.sync();
  assert.equal(disposals, 2);
  h.store.actions.setEnabled(true); h.installer.sync();
  assert.equal(installs, 4);
  h.store.actions.closeGroup(h.right); h.installer.sync();
  assert.equal(disposals, 2);
  h.store.actions.setEnabled(false); h.installer.sync();
  assert.equal(disposals, 4);
});

test("failed readiness becomes a visible error rather than an endless spinner", async () => {
  const h = harness();
  const status = { kind: "held", reference: { ready: Promise.reject(new Error("offline")) } };
  h.component(h.useReferenceReady, status);
  await Promise.resolve();
  const result = h.component(h.useReferenceReady, status);
  assert.equal(result.kind, "failed");
  assert.match(result.message, /offline/);
});

test("manual retry acquires a fresh reference before releasing the failed one", () => {
  const h = harness(), calls = [];
  h.runtime.sessions.retain = id => { calls.push(`retain:${id}`); return { release: () => calls.push(`release:${id}`) }; };
  const use = () => h.useHeldReferences(["A", "B"], "A|B");
  h.component(use);
  const held = h.component(use);
  held.retry("A");
  assert.deepEqual(calls, ["retain:A", "retain:B", "retain:A", "release:A"]);
});

test("inactive session tabs stay mounted while another tab is selected", () => {
  const h = harness();
  h.store.actions.adoptSession("C");
  const tree = h.render("C");
  const nodes = [];
  const walk = node => { if (!node || typeof node !== "object") return; nodes.push(node); (node.children || []).flat(Infinity).forEach(walk); };
  walk(tree);
  const tabs = nodes.filter(n => n.props?.["data-dsv-tab-body"]);
  assert.equal(tabs.length, 3);
  assert.equal(tabs.filter(n => n.props.hidden).length, 1);
});

test("reading memory persists each tab independently and tolerates unavailable storage", () => {
  const h = harness();
  let value = "[]";
  const storage = { getItem: () => value, setItem: (_, next) => { value = next; } };
  const first = h.createReadingMemory(storage);
  first.put("tab1:A", { top: 100, bottom: false });
  first.put("tab2:A", { top: 900, bottom: true });
  first.flush();
  const restored = h.createReadingMemory(storage);
  assert.equal(restored.get("tab1:A").top, 100);
  assert.equal(restored.get("tab2:A").top, 900);
  const blocked = h.createReadingMemory({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
  blocked.put("A", { top: 50, bottom: false }); blocked.flush();
  assert.equal(blocked.get("A").top, 50);
});

test("reading restore follows a semantic anchor after reflow and preserves bottom following", () => {
  const h = harness();
  let offset = 10;
  const anchor = { getAttribute: () => "message-1", getBoundingClientRect: () => ({ top: offset, bottom: offset + 100, height: 100 }) };
  const scroller = { scrollTop: 100, clientHeight: 500, scrollHeight: 2000, getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: selector => selector === "[data-chat-anchor-key]" ? [anchor] : [] };
  const position = h.captureReading(scroller);
  offset = 160;
  h.restoreReading(scroller, position);
  assert.equal(scroller.scrollTop, 250);
  h.restoreReading(scroller, { top: 0, bottom: true });
  assert.equal(scroller.scrollTop, 1500);
  scroller.clientHeight = 0;
  assert.equal(h.captureReading(scroller), null);
});

test("a hung open times out and late results cannot overwrite a retry", async () => {
  const h = harness();
  let rejectOld;
  const old = { kind: "held", reference: { ready: new Promise((_, reject) => { rejectOld = reject; }) } };
  h.component(h.useReferenceReady, old);
  h.runTimers(30000);
  assert.equal(h.component(h.useReferenceReady, old).kind, "failed");
  const fresh = { kind: "held", reference: { ready: Promise.resolve() } };
  h.component(h.useReferenceReady, fresh);
  await Promise.resolve();
  rejectOld(new Error("old request failed"));
  await Promise.resolve();
  assert.equal(h.component(h.useReferenceReady, fresh).kind, "ready");
});

test("choosing another session keeps the tab and pane", () => {
  const h = harness();
  const before = h.store.getSnapshot().root;
  const group = h.listGroups(before).find(g => g.id === h.left);
  h.store.actions.setSession(h.left, group.activeTabId, null);
  const next = h.listGroups(h.store.getSnapshot().root).find(g => g.id === h.left);
  assert.equal(next.tabs[0].id, group.tabs[0].id);
  assert.equal(next.tabs[0].sessionId, null);
  assert.equal(h.listGroups(h.store.getSnapshot().root).length, 2);
});

test("hidden duplicates do not mount a second input editor for a visible session", () => {
  const h = harness();
  h.store.actions.addTab(h.left);
  const group = h.listGroups(h.store.getSnapshot().root).find(g => g.id === h.left);
  h.store.actions.setSession(h.left, group.activeTabId, "B");
  h.store.actions.setActiveTab(h.left, group.tabs[0].id);
  const tree = h.render("A"), nodes = [];
  const walk = node => { if (!node || typeof node !== "object") return; nodes.push(node); (node.children || []).flat(Infinity).forEach(walk); };
  walk(tree);
  const duplicate = nodes.find(n => n.props?.["data-dsv-tab-body"] === group.activeTabId);
  assert.equal(duplicate.props.hidden, true);
  assert.deepEqual(duplicate.children, [null]);
});

test("expanded reading cards restore only when their state differs", () => {
  const h = harness();
  let expanded = true, clicks = 0;
  const row = { getAttribute: () => "tool-1", getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }), querySelectorAll: () => [control] };
  const control = { tagName: "BUTTON", closest: () => row, getAttribute: () => String(expanded), click: () => { clicks++; expanded = !expanded; } };
  const scroller = { scrollTop: 10, clientHeight: 300, scrollHeight: 1000, getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: selector => selector === "[data-chat-anchor-key]" ? [row] : [control] };
  const saved = h.captureReading(scroller);
  expanded = false;
  h.restoreReading(scroller, saved);
  assert.equal(expanded, true);
  h.restoreReading(scroller, saved);
  assert.equal(clicks, 1);
});

test("resizer uses the latest move and commits the pointer-up position", () => {
  const h = harness(), root = h.store.getSnapshot().root;
  const panes = [0, 1].map(() => ({ style: { flexGrow: 0.5 }, classList: { contains: () => false } }));
  let geometryReads = 0;
  const stack = { children: panes, getBoundingClientRect: () => { geometryReads++; return { width: 1000, height: 600 }; }, setAttribute() {}, removeAttribute() {} };
  const element = h.component(h.Resizer, { splitId: root.id, index: 0, orientation: "row", sizes: [0.5, 0.5], stackRef: { current: stack } });
  let updates = 0; h.store.subscribe(() => updates++);
  const event = x => ({ button: 0, pointerId: 1, clientX: x, preventDefault() {}, stopPropagation() {}, currentTarget: { setPointerCapture() {}, getBoundingClientRect: () => ({ left: 500, top: 0, width: 6, height: 600 }) } });
  element.props.onPointerDown(event(100));
  element.props.onPointerMove(event(120));
  element.props.onPointerMove(event(240));
  h.runFrames();
  assert.match(h.createdNodes[0].style.transform, /^translate3d\(140(?:\.\d+)?px,0,0\)$/);
  assert.equal(Number(panes[0].style.flexGrow), 0.5);
  assert.equal(h.store.getSnapshot().root.sizes[0], 0.5);
  assert.equal(updates, 0);
  element.props.onPointerMove(event(260));
  element.props.onPointerUp({ ...event(300), type: "pointerup" });
  assert.equal(h.store.getSnapshot().root.sizes[0], 0.7);
  assert.equal(updates, 1);
  assert.equal(h.createdNodes[0].removed, true);
  assert.equal(geometryReads, 1);
});

test("cancelled vertical resizing removes the guide without changing layout", () => {
  const h = harness(), root = h.store.getSnapshot().root;
  const panes = [0, 1].map(() => ({ style: { flexGrow: 0.5 }, classList: { contains: () => false } }));
  const stack = { children: panes, getBoundingClientRect: () => ({ width: 1000, height: 600 }), setAttribute() {}, removeAttribute() {} };
  const element = h.component(h.Resizer, { splitId: root.id, index: 0, orientation: "col", sizes: [0.5, 0.5], stackRef: { current: stack } });
  const event = y => ({ button: 0, pointerId: 2, clientY: y, preventDefault() {}, stopPropagation() {}, currentTarget: { setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 300, width: 1000, height: 6 }) } });
  let updates = 0; h.store.subscribe(() => updates++);
  element.props.onPointerDown(event(300));
  element.props.onPointerMove(event(900)); h.runFrames();
  assert.match(h.createdNodes[0].style.transform, /^translate3d\(0,228(?:\.\d+)?px,0\)$/);
  element.props.onPointerCancel(); h.runFrames();
  assert.equal(updates, 0);
  assert.equal(h.createdNodes[0].removed, true);
  assert.equal(h.store.getSnapshot().root, root);
});

test("conversation trees belong to the root overlay while the host session owns only a seat", () => {
  const h = harness(), registrations = [];
  h.installer.ctx = { slots: {
    inject(name, callback) { callback(); return () => {}; },
    register(options, component) { registrations.push({ options, component }); return () => {}; },
  } };
  h.installer.sync();
  const main = registrations.find(r => r.options.name === "main.conversation");
  const stable = registrations.find(r => r.options.name === "shell.overlay");
  assert.equal(main.component.name, "TakeoverSeat");
  assert.equal(main.options.children, undefined);
  assert.equal(stable.component.name, "StableTakeover");
  assert.equal(stable.options.children["splitview.pane"].scope, "session");
});

test("split proportions reach the rendered panes rather than remaining equal flex weights", () => {
  const h = harness(), root = h.store.getSnapshot().root;
  h.store.actions.setSizes(root.id, [0.7, 0.3]);
  const tree = h.render("A");
  const seats = nodesOf(tree).filter(n => n.props?.["data-dsv-group-seat"]);
  assert.equal(seats.find(n => n.props["data-dsv-group-seat"] === h.left).props.style.flexGrow, 0.7);
  assert.equal(seats.find(n => n.props["data-dsv-group-seat"] === h.right).props.style.flexGrow, 0.3);
});

test("conversation panes keep the same parent layer when split ancestry changes", () => {
  const h = harness();
  const before = nodesOf(h.render("A")).find(n => n.props?.className === "dsv-pane-layer");
  h.store.actions.splitGroup(h.left, "col", "before", "C");
  const after = nodesOf(h.render("A")).find(n => n.props?.className === "dsv-pane-layer");
  for (const id of [h.left, h.right]) {
    assert.ok(before.children.flat().some(n => n.props?.["data-dsv-group"] === id));
    assert.ok(after.children.flat().some(n => n.props?.["data-dsv-group"] === id));
  }
});

test("native headers preserve scoped stores and forward extension slots without taking ownership", () => {
  const h = harness(), entries = new Map(), listeners = new Map(), registrations = [], removed = [];
  const storeHandle = {}, inject = () => ({ selectView() {} });
  const child = "conversation.session.header.actions";
  const source = { options: {}, component: props => props.renderSlot(child, { session: "A" }), store: storeHandle, inject, locale: "native", children: { [child]: { kind: "list", scope: "session" } } };
  const action = { options: { id: "team" }, component() {} };
  entries.set("conversation.header", [source]); entries.set(child, [action]);
  const slots = {
    entries: name => entries.get(name) || [],
    subscribe(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    inject(name, fn) { const off = fn(); return () => { removed.push(name); off(); }; },
    register(options, component) { registrations.push({ options, component }); return () => {}; },
  };
  const cleanup = h.installNativeHeader({ slots });
  const header = registrations[0];
  assert.equal(header.options.name, "splitview.hostHeader");
  assert.equal(header.options.store, storeHandle);
  assert.equal(header.options.inject, inject);
  assert.equal(header.options.locale, "native");
  assert.equal(header.options.children[child], undefined);
  const forwarded = header.component({ renderSlot: name => name });
  assert.equal(forwarded.type(forwarded.props), h.nativeSlotName(child));
  entries.set(child, []); listeners.get(child)();
  assert.ok(removed.includes(h.nativeSlotName(child)));
  cleanup(); assert.equal(listeners.size, 0);
});

test("pane content uses the native header and keeps native view selection enabled", () => {
  const h = harness(), calls = [];
  const tree = h.component(h.PaneBody, {
    sessionId: "A", renderSlot: name => { calls.push(name); return null; },
    renderFactorySlot(name, props, options) { calls.push({ name, options }); return null; },
  });
  assert.equal(tree.children[0].props.className, "dsv-conversation-shell");
  assert.equal(calls[0], "splitview.hostHeader");
  assert.equal(calls[1].name, "conversation.content");
  assert.equal(calls[1].options.slots.views.name, "NativePaneViews");
});

test("the horizontal workspace tab bar remains visible with one pane", () => {
  const h = harness(); h.store.actions.closeGroup(h.right);
  const tree = h.render("A"), nodes = [];
  const walk = node => { if (!node || typeof node !== "object") return; nodes.push(node); (node.children || []).flat(Infinity).forEach(walk); };
  walk(tree);
  assert.equal(nodes.filter(n => n.props?.className === "dsv-workspace-bar").length, 1);
  assert.equal(nodes.filter(n => n.type === h.WorkspaceTabs).length, 1);
});

test("a fresh empty workspace adopts the current host session once", () => {
  const h = harness(); h.store.actions.reset(); h.render("C");
  assert.equal(h.active(), "C");
  const group = h.store.getSnapshot().root; h.store.actions.addTab(group.id); h.render("C");
  assert.equal(h.active(), null);
});

for (const single of [true, false]) test(`sidebar move-only drags can split ${single ? "one pane" : "an existing split"}`, () => {
  const h = harness();
  if (single) h.store.actions.closeGroup(h.right);
  const before = h.listGroups(h.store.getSnapshot().root).length;
  const tree = h.render("A");
  const pane = groupElement(tree, h.left);
  let accepted = false;
  // Native sidebar dragStart only permits move. The browser never sends drop
  // if the target requests copy, even though a synthetic drop would succeed.
  const dataTransfer = { types: ["text/plain"], effectAllowed: "move", dropEffect: "none", getData: () => "C" };
  const event = { dataTransfer, clientX: 990, clientY: 300,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, right: 1000, top: 0, bottom: 600, width: 1000, height: 600 }) },
    preventDefault() { accepted = true; }, stopPropagation() {},
  };
  pane.props.onDragOver(event);
  assert.equal(accepted, true);
  assert.equal(dataTransfer.dropEffect, "move", "target operation must be allowed by the native sidebar");
  if (accepted && dataTransfer.dropEffect === dataTransfer.effectAllowed) pane.props.onDrop(event);
  assert.equal(h.listGroups(h.store.getSnapshot().root).length, before + 1);
  assert.equal(h.active(), "C");
});

test("ending a sidebar drag without a drop removes the pane preview", () => {
  const h = harness();
  groupElement(h.render("A"), h.left).props.onDragOver({
    dataTransfer: { types: ["text/plain"] }, clientX: 990, clientY: 300,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }) },
    preventDefault() {}, stopPropagation() {},
  });
  assert.match(groupElement(h.render("A"), h.left).props.className, /dsv-group--drop/);
  h.documentListeners.get("dragend")?.();
  assert.doesNotMatch(groupElement(h.render("A"), h.left).props.className, /dsv-group--drop/);
});

for (const types of [["Files"], ["Files", "text/plain", "text/uri-list"]]) {
  test(`file drops reach the native attachment handler and dismiss its overlay (${types.join(", ")})`, () => {
    const h = harness(), pane = groupElement(h.render("A"), h.left);
    const before = JSON.stringify(h.store.getSnapshot());
    let overlayVisible = true, stopped = false, prevented = false, attached = 0;
    const event = {
      dataTransfer: { types, files: [{ name: "attachment.txt" }], items: [{ kind: "file" }],
        dropEffect: "copy", getData: () => "C" },
      clientX: 990, clientY: 300,
      currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }) },
      preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
    };
    pane.props.onDragOver(event);
    pane.props.onDrop(event);
    // DSH's document-level upload listener must receive the bubbling drop.
    if (!stopped) { overlayVisible = false; attached++; }
    assert.equal(overlayVisible, false, "native file-drop overlay must not remain stuck");
    assert.equal(attached, 1, "native attachment handler must receive the file");
    assert.equal(prevented, false, "workspace must not consume file drops");
    assert.equal(event.dataTransfer.dropEffect, "copy");
    assert.equal(JSON.stringify(h.store.getSnapshot()), before, "file drops cannot change sessions or split panes");
  });
  test(`tab bars leave native file drops alone (${types.join(", ")})`, () => {
    const h = harness(), bar = nodesOf(h.render("A")).find(n => n.props?.className === "dsv-tabbar");
    let stopped = false, prevented = false;
    const event = {
      dataTransfer: { types, files: [{ name: "attachment.txt" }], items: [{ kind: "file" }], getData: () => "C" },
      clientX: 50, currentTarget: { querySelectorAll: () => [] },
      preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
    };
    bar.props.onDragOver(event); bar.props.onDrop(event);
    assert.equal(stopped, false, "native file drop must reach document listeners from a tab bar");
    assert.equal(prevented, false);
  });
  test(`global fallback ignores file drops even after a session preview (${types.join(", ")})`, () => {
    const h = harness(); h.installer.isInstalled = () => false;
    const attrs = new Map(), node = {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }),
      setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k),
    };
    h.document.querySelector = () => node;
    const cleanup = h.installGlobalDrop();
    const at = { clientX: 990, clientY: 300 };
    h.documentListeners.get("dragover")({ ...at, dataTransfer: { types: ["text/plain"] }, preventDefault() {} });
    assert.ok(attrs.has("data-dsv-drop"));
    let stopped = false, prevented = false;
    const event = { ...at, dataTransfer: { types, files: [{ name: "attachment.txt" }], getData: () => "C" },
      preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
    h.documentListeners.get("drop")(event);
    assert.equal(stopped, false, "stale session preview cannot intercept a file drop");
    assert.equal(prevented, false);
    assert.equal(attrs.has("data-dsv-drop"), false);
    cleanup();
  });
}

test("native attachment intake routes a document drop to one tab and preserves file pickers", () => {
  const h = harness(), calls = [], files = [{ name: "attachment.txt" }], directories = new Set(files);
  const owner = tabId => {
    h.PaneContext.value = tabId ? { tabId } : null;
    return h.component(h.PaneAttachments, {
      attachments: [], canAcceptDrop: true, uploads: {},
      onAddFiles: (...args) => calls.push({ tabId, args }), renderSlot: (name, props) => props,
    });
  };
  const left = owner("left"), right = owner("right"), outside = owner(null);
  h.fileDropTarget.current = { tabId: "left" };
  for (const props of [left, right, outside]) props.onAddFiles(files, directories);
  assert.deepEqual(calls.map(c => c.tabId), ["left"]);
  assert.equal(calls[0].args[0], files); assert.equal(calls[0].args[1], directories);
  h.fileDropTarget.current = null;
  right.onAddFiles(files, directories); outside.onAddFiles(files, directories);
  assert.deepEqual(calls.map(c => c.tabId), ["left", "right", null]);
});

test("file-drop capture chooses the pointed tab instead of the active pane and clears its routing", () => {
  const h = harness(); h.installer.isInstalled = () => true;
  const cleanup = h.installGlobalDrop();
  const target = { closest: selector => selector === "[data-dsv-tab-body]" ? { getAttribute: () => "pointed-tab" } : null };
  h.documentListeners.get("drop")({ target, dataTransfer: { types: ["Files"] } });
  assert.equal(h.fileDropTarget.current.tabId, "pointed-tab");
  h.runTimers(0); assert.equal(h.fileDropTarget.current, null);
  const right = h.listGroups(h.store.getSnapshot().root).find(g => g.id === h.right);
  h.documentListeners.get("drop")({ dataTransfer: { types: ["Files"] },
    target: { closest: selector => selector === "[data-dsv-tab-group]" ? { getAttribute: () => h.right } : null } });
  assert.equal(h.fileDropTarget.current.tabId, right.activeTabId);
  cleanup(); assert.equal(h.fileDropTarget.current, null);
});

test("native attachment mirroring excludes its proxy and retains the original renderer", () => {
  const h = harness(), registrations = [], slot = "conversation.input.attachments";
  const native = { options: {}, component() {}, locale: "conversation" };
  const proxy = { options: { id: "dsh-splitview.attachments" }, children: { [h.nativeSlotName(slot)]: { kind: "single" } } };
  const cleanup = h.installNativeHeader({ slots: {
    entries: name => name === slot ? [proxy, native] : [], subscribe: () => () => {},
    inject: (name, fn) => fn(), register: (options, component) => { registrations.push({ options, component }); return () => {}; },
  } });
  assert.equal(registrations.length, 1);
  const mirrored = registrations[0];
  assert.equal(mirrored.options.name, h.nativeSlotName(slot));
  assert.equal(mirrored.options.locale, "conversation");
  assert.equal(mirrored.component({}).type, native.component);
  cleanup();
});

function nodesOf(tree) {
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...(tree.children || []).flat(Infinity).flatMap(nodesOf)];
}
function addSessionTab(h, groupId, sessionId) {
  h.store.actions.addTab(groupId);
  const group = h.listGroups(h.store.getSnapshot().root).find(g => g.id === groupId);
  h.store.actions.setSession(groupId, group.activeTabId, sessionId);
  return group.activeTabId;
}

test("reordering uses the shown gap in both directions and keeps the moved tab active", () => {
  const h = harness();
  const a = h.listGroups(h.store.getSnapshot().root)[0].tabs[0].id;
  const c = addSessionTab(h, h.left, "C");
  const d = addSessionTab(h, h.left, "D");
  h.store.actions.moveTab(a, h.left, h.left, 2); // gap before D
  let group = h.listGroups(h.store.getSnapshot().root).find(g => g.id === h.left);
  assert.deepEqual(Array.from(group.tabs, t => t.id), [c, a, d]);
  assert.equal(group.activeTabId, a);
  h.store.actions.moveTab(d, h.left, h.left, 0);
  group = h.listGroups(h.store.getSnapshot().root).find(g => g.id === h.left);
  assert.deepEqual(Array.from(group.tabs, t => t.id), [d, c, a]);
  h.store.actions.moveTab(d, h.left, h.left, 3);
  group = h.listGroups(h.store.getSnapshot().root).find(g => g.id === h.left);
  assert.deepEqual(Array.from(group.tabs, t => t.id), [c, a, d]);
});

test("moving a last tab into another pane preserves its identity and collapses the source", () => {
  const h = harness();
  const source = h.listGroups(h.store.getSnapshot().root).find(g => g.id === h.right);
  h.store.actions.moveTab(source.activeTabId, h.right, h.left, 0);
  const groups = h.listGroups(h.store.getSnapshot().root);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].tabs[0].id, source.activeTabId);
  assert.equal(groups[0].activeTabId, source.activeTabId);
  assert.equal(h.store.getSnapshot().activeGroupId, h.left);
});

for (const [orientation, position] of [["row", "before"], ["row", "after"], ["col", "before"], ["col", "after"]]) {
  test(`detaching a tab preserves its reading identity at ${orientation}/${position}`, () => {
    const h = harness(), tab = addSessionTab(h, h.left, "C");
    const pane = h.store.actions.moveTabToNewGroup(tab, h.left, orientation, position, h.right);
    const groups = h.listGroups(h.store.getSnapshot().root);
    const newIndex = groups.findIndex(g => g.id === pane), targetIndex = groups.findIndex(g => g.id === h.right);
    assert.equal(newIndex - targetIndex, position === "before" ? -1 : 1);
    assert.equal(groups[newIndex].tabs[0].id, tab);
    assert.equal(groups[newIndex].tabs[0].sessionId, "C");
    assert.equal(groups.find(g => g.id === h.left).tabs.length, 1);
  });
}

test("moving a one-tab pane to another edge works at the pane limit", () => {
  const h = harness(); h.store.actions.setMaxPanes(2);
  const tab = h.listGroups(h.store.getSnapshot().root).find(g => g.id === h.left).activeTabId;
  const pane = h.store.actions.moveTabToNewGroup(tab, h.left, "col", "before", h.right);
  const groups = h.listGroups(h.store.getSnapshot().root);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].id, pane);
  assert.equal(groups[0].tabs[0].id, tab);
});

test("splitting the only tab opens the same session rather than an empty pane", () => {
  const h = harness();
  const tab = h.listGroups(h.store.getSnapshot().root).find(g => g.id === h.left).activeTabId;
  const pane = h.store.actions.moveTabToNewGroup(tab, h.left, "row", "before");
  const groups = h.listGroups(h.store.getSnapshot().root);
  assert.equal(groups[0].id, pane);
  assert.equal(groups[0].tabs[0].sessionId, "A");
  assert.notEqual(groups[0].tabs[0].id, tab);
});

test("closing background, active and final tabs preserves the other pane and a usable workspace", () => {
  const h = harness(); h.render("A");
  const original = h.listGroups(h.store.getSnapshot().root).find(g => g.id === h.left).activeTabId;
  const c = addSessionTab(h, h.left, "C"), d = addSessionTab(h, h.left, "D");
  h.store.actions.closeTab(h.left, c);
  assert.equal(h.active(), "D");
  h.store.actions.closeTab(h.left, d);
  assert.equal(h.active(), "A");
  h.store.actions.closeTab(h.left, original);
  assert.equal(h.listGroups(h.store.getSnapshot().root).length, 1);
  assert.equal(h.active(), "B");
  const final = h.listGroups(h.store.getSnapshot().root)[0]; h.render("B");
  h.store.actions.closeTab(final.id, final.activeTabId); h.render("B");
  assert.equal(h.active(), null);
  assert.equal(h.listGroups(h.store.getSnapshot().root)[0].tabs.length, 1);
});

test("layout can be flushed before its delayed write when refreshing immediately", () => {
  const h = harness();
  h.store.actions.setSizes(h.store.getSnapshot().root.id, [.37, .63]);
  const tab = addSessionTab(h, h.left, "C");
  h.store.actions.moveTab(tab, h.left, h.left, 0);
  const expected = h.store.getSnapshot();
  assert.equal(typeof h.store.flush, "function");
  h.store.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(h.createStore().getSnapshot())), JSON.parse(JSON.stringify(expected)));
});

test("nested split ratios, tab order and selections survive a storage round trip", () => {
  const h = harness();
  addSessionTab(h, h.left, "C");
  h.store.actions.splitGroup(h.right, "col", "before", "C");
  let root = h.store.getSnapshot().root;
  h.store.actions.setSizes(root.id, [.37, .63]);
  root = h.store.getSnapshot().root;
  h.store.actions.setSizes(root.children[1].id, [.62, .38]);
  h.persistWorkspace();
  assert.deepEqual(JSON.parse(JSON.stringify(h.createStore().getSnapshot())), JSON.parse(JSON.stringify(h.store.getSnapshot())));
});

test("leaving the page captures the latest reading before flushing both stores", () => {
  const h = harness();
  h.readingCaptures.add(() => h.readingMemory.put("exit:A", { top: 777, bottom: false, historySeq: 20 }));
  h.persistWorkspace();
  assert.equal(JSON.parse(h.storage.getItem("dsh-splitview:reading:v1")).find(([key]) => key === "exit:A")[1].top, 777);
  assert.equal(JSON.parse(h.storage.getItem("dsh-splitview:layout:v3")).activeGroupId, h.left);
});

test("restoring an older reading window loads through its saved sequence only when necessary", async () => {
  const h = harness(), calls = [];
  let firstSeq = 100;
  h.runtime.sessions.binding = () => ({
    eventSource: { getSnapshot: () => ({ entries: [{ type: "event", event: { seq: firstSeq } }] }) },
    session: { loadThrough: async seq => { calls.push(seq); firstSeq = seq; } },
  });
  await h.loadReadingHistory("A", { historySeq: 20, bottom: false });
  assert.deepEqual(calls, [20]);
  assert.equal(h.loadReadingHistory("A", { historySeq: 20, bottom: false }), null);
  assert.equal(h.loadReadingHistory("A", { historySeq: 5, bottom: true }), null);
  assert.equal(h.loadReadingHistory("A", { bottom: false }), null);
  assert.deepEqual(calls, [20]);
});

test("a restored historical anchor waits for its node rather than accepting a wrong pixel fallback", () => {
  const h = harness();
  const scroller = { scrollTop: 900, clientHeight: 300, querySelectorAll: () => [] };
  assert.equal(h.restoreReading(scroller, { top: 100, bottom: false, anchorKey: "old-message" }, true), false);
  assert.equal(scroller.scrollTop, 900);
});

test("native readers initialize from each tab's position without overwriting restoration targets", () => {
  const h = harness();
  h.readingMemory.put("tab1:A", { top: 123, bottom: false, anchorKey: "old-node", anchorTop: -20 });
  h.readingMemory.put("tab2:A", { top: 900, bottom: true });
  const first = h.createNativeReadingStore("tab1:A"), second = h.createNativeReadingStore("tab2:A");
  assert.equal(first.read().scrollTop, 123);
  assert.equal(first.read().anchorKey, "old-node");
  assert.equal(second.read(), null);
  first.save({ scrollTop: 400, anchorKey: "new-node", anchorTop: 0 });
  assert.equal(first.read().scrollTop, 400);
  assert.equal(h.readingMemory.get("tab1:A").top, 123);
});

test("a restored active pane wins over the host's initial session hydration", () => {
  const h = harness();
  h.render(undefined);
  h.render("B");
  assert.equal(h.active(), "A");
  assert.equal(h.writes.at(-1), "A");
  h.render("A");
  h.render("B");
  assert.equal(h.active(), "B", "later sidebar navigation must still work");
});
