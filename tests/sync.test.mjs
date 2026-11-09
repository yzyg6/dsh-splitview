import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

// Execute the shipped bundle and its real Takeover effects. The host's
// session projection and React commit scheduling are controlled by the test.
function harness({ element = null, deferTransitions = false } = {}) {
  let hooks = [], cursor = 0, effects = [], api;
  let stateWrites = 0;
  const transitions = [];
  const React = {
    createElement: (type, props, ...children) => {
      if (element && typeof type === "string" && props?.ref) {
        const node = element.panes?.get(props["data-dsv-group"]) || element;
        if (typeof props.ref === "function") props.ref(node); else props.ref.current = node;
      }
      return { type, props, children };
    },
    createContext: value => ({ Provider() {}, value }),
    createPortal: (children, container) => ({ type: "portal", props: { container }, children: [children] }),
    startTransition: run => { if (deferTransitions) transitions.push(run); else run(); },
    useContext: context => context.value,
    useModalLayer() {},
    cloneElement: (element, props) => ({ ...element, props: { ...element.props, ...props } }),
    createRef: () => ({ current: null }),
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value }; },
    useState(value) { const ref = React.useRef(value); return [ref.current, next => { const value = typeof next === "function" ? next(ref.current) : next; if (!Object.is(value, ref.current)) stateWrites++; ref.current = value; }]; },
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
  source = source.replace("return module.exports;", "return { Takeover, StableTakeover, ReadingTab, TabContent, store, runtime, installer, listGroups, useReferenceReady, useHeldReferences, createReadingMemory, captureReading, restoreReading, Resizer, PaneBody, WidthControls, installNativeHeader, nativeSlotName, WorkspaceTabs, createStore, readingMemory, readingCaptures, persistWorkspace, loadReadingHistory, createNativeReadingStore, installGlobalDrop, PaneAttachments, PaneContext, fileDropTarget, createSidebarPreferences, partitionSidebarPanels, sidebarPreferences, SidebarRail, CompactSidebar, installCompactSidebar };");
  source = source.replace("return { Takeover,", "return { installPluginRail, installSidebarShortcut, railColumns, Takeover,");
  const documentListeners = new Map();
  const timers = new Map();
  const frames = new Map();
  const createdNodes = [];
  const savedStorage = new Map();
  const mutations = [], resizes = [];
  const observer = collection => class {
    constructor(callback) { this.callback = callback; this.targets = []; collection.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.targets = []; }
  };
  const storage = { getItem: key => savedStorage.get(key) ?? null, setItem: (key, value) => savedStorage.set(key, value) };
  let timerId = 0;
  const context = {
    window: { __ModuleLoader__: { load({ factory }) { api = factory(() => React); } }, addEventListener() {}, removeEventListener() {} },
    MutationObserver: observer(mutations), ResizeObserver: observer(resizes),
    localStorage: storage,
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timers.delete(id), console,
    requestAnimationFrame: fn => { frames.set(++timerId, fn); return timerId; },
    cancelAnimationFrame: id => frames.delete(id),
    document: {
      querySelectorAll: () => [],
      createElement: () => { const node = { style: {}, setAttribute() {}, remove() { node.removed = true; node.parentNode = null; } }; createdNodes.push(node); return node; },
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
    ...api, left, right, list, writes, documentListeners, createdNodes, storage, mutations, resizes, document: context.document,
    get pendingFrames() { return frames.size; },
    get stateWrites() { return stateWrites; },
    runTransitions() { for (const run of transitions.splice(0)) run(); },
    cleanup() { for (const hook of hooks) hook?.cleanup?.(); hooks = []; },
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

function readingFixture() {
  const listeners = new Map();
  let scans = 0;
  const anchor = {
    getAttribute: name => name === "data-chat-anchor-key" ? "message-1" : null,
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
  };
  const scroller = {
    scrollTop: 0, clientHeight: 500, scrollHeight: 10000,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => anchor,
    querySelectorAll: selector => {
      if (selector === "[data-chat-anchor-key]") { scans++; return [anchor]; }
      return [];
    },
  };
  const node = {
    querySelector: () => scroller,
    appendChild(target) { target.parentNode = node; target.removed = false; },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
  };
  return { node, scroller, listeners, get scans() { return scans; } };
}

test("performance: a scroll burst captures reading once per frame and flushes the final position", () => {
  const fixture = readingFixture(), h = harness({ element: fixture.node });
  h.component(h.ReadingTab, { tab: { id: "perf", sessionId: "A" }, active: true });
  fixture.listeners.get("wheel")({ type: "wheel", target: fixture.scroller });
  for (let i = 1; i <= 120; i++) {
    fixture.scroller.scrollTop = i;
    fixture.listeners.get("scroll")({ target: fixture.scroller });
  }
  assert.equal(fixture.scans, 0, "scroll handlers must not synchronously scan the conversation");
  assert.equal(h.pendingFrames, 1);
  h.runFrames();
  assert.equal(fixture.scans, 1);
  assert.equal(h.readingMemory.get("perf:A").top, 120);
  fixture.scroller.scrollTop = 999;
  fixture.listeners.get("scroll")({ target: fixture.scroller });
  h.cleanup();
  assert.equal(h.readingMemory.get("perf:A").top, 999, "switching away must capture before cancelling the queued frame");
  assert.equal(h.pendingFrames, 0);
  h.runFrames();
  assert.equal(fixture.scans, 2, "a detached tab must not capture again");
});

test("performance: tabs without saved reading do not observe streaming mutations", () => {
  const fixture = readingFixture(), h = harness({ element: fixture.node });
  h.component(h.ReadingTab, { tab: { id: "fresh", sessionId: "A" }, active: true });
  assert.equal(h.mutations.filter(observer => observer.targets.length).length, 0);
  assert.equal(h.resizes.filter(observer => observer.targets.length).length, 0);
  h.cleanup();
});

test("performance: disclosure capture scans each owning row once in long tool output", () => {
  const h = harness();
  let scans = 0;
  const row = {
    getAttribute: name => name === "data-chat-anchor-key" ? "tools" : null,
    getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }),
    querySelectorAll: () => { scans++; return controls; },
  };
  const controls = Array.from({ length: 200 }, (_, index) => ({
    tagName: "BUTTON", closest: () => row, getAttribute: () => String(index % 2 === 0),
  }));
  const scroller = {
    scrollTop: 10, clientHeight: 500, scrollHeight: 10000,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: selector => selector === "[data-chat-anchor-key]" ? [row] : controls,
  };
  const saved = h.captureReading(scroller);
  assert.equal(saved.disclosures.length, 64);
  assert.equal(saved.disclosures[63].index, 63);
  assert.equal(saved.disclosures[0].open, true);
  assert.ok(scans <= 1, `one tool row was scanned ${scans} times`);
  scans = 0;
  h.restoreReading(scroller, saved);
  assert.ok(scans <= 1, `restoring one tool row scanned it ${scans} times`);
});

test("performance: streaming changes inside the overlay do not remeasure the host seat", () => {
  const h = harness();
  let reads = 0;
  const seat = { getBoundingClientRect: () => { reads++; return { left: 10, top: 20, width: 1000, height: 800 }; } };
  h.document.querySelector = () => seat;
  h.component(h.StableTakeover, {});
  const observer = h.mutations[0];
  const content = { closest: selector => selector === ".dsv-surface" ? {} : null };
  for (let i = 0; i < 120; i++) { observer.callback([{ target: content }]); h.runFrames(); }
  assert.equal(reads, 1, "streaming content cannot move its fixed overlay's host seat");
  observer.callback([{ target: { closest: () => null } }]); h.runFrames();
  assert.equal(reads, 2, "changes outside the overlay must still refresh the seat");
  h.cleanup();
});

test("reading restoration refreshes controls after expansion replaces nested DOM", () => {
  const h = harness();
  let controls, firstOpen = false, secondOpen = false, staleClicks = 0;
  const row = { getAttribute: () => "tools", querySelectorAll: () => controls };
  const second = { tagName: "BUTTON", closest: () => row, getAttribute: () => String(secondOpen), click: () => { secondOpen = true; } };
  const stale = { ...second, click: () => { staleClicks++; } };
  const first = {
    tagName: "BUTTON", closest: () => row, getAttribute: () => String(firstOpen),
    click() { firstOpen = true; controls = [first, second]; },
  };
  controls = [first, stale];
  const scroller = { clientHeight: 500, scrollHeight: 1000, querySelectorAll: () => [row] };
  h.restoreReading(scroller, { bottom: true, disclosures: [
    { key: "tools", index: 0, open: true }, { key: "tools", index: 1, open: true },
  ] });
  assert.equal(firstOpen, true);
  assert.equal(secondOpen, true, "the second state must reach the newly rendered control");
  assert.equal(staleClicks, 0);
});

test("reading capture keeps independent indices for nested message anchors", () => {
  const h = harness();
  const outer = { getAttribute: name => name === "data-chat-anchor-key" ? "outer" : null, getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }) };
  const inner = { getAttribute: () => "inner" };
  const control = (row, open) => ({ tagName: "BUTTON", closest: () => row, getAttribute: () => String(open) });
  const controls = [control(null, false), control(outer, true), control(inner, false), control(inner, true), control(outer, false)];
  const scroller = {
    scrollTop: 0, clientHeight: 500, scrollHeight: 1000, getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: selector => selector === "[data-chat-anchor-key]" ? [outer, inner] : controls,
  };
  const saved = h.captureReading(scroller);
  assert.deepEqual(Array.from(saved.disclosures, item => [item.key, item.index, item.open]), [
    ["outer", 0, true], ["inner", 0, false], ["inner", 1, true], ["outer", 1, false],
  ]);
});

test("saved reading observes late content only until restoration settles", () => {
  const fixture = readingFixture(), h = harness({ element: fixture.node });
  h.readingMemory.put("saved:A", { top: 123, bottom: false, anchorKey: "message-1", anchorTop: -123 });
  h.component(h.ReadingTab, { tab: { id: "saved", sessionId: "A" }, active: true });
  assert.equal(h.mutations[0].targets.length, 1);
  h.runFrames(); h.runFrames();
  assert.equal(fixture.scroller.scrollTop, 123);
  h.runTimers(1000);
  assert.equal(h.mutations[0].targets.length, 0);
  assert.equal(h.resizes[0].targets.length, 0);
  fixture.scroller.scrollTop = 456;
  fixture.listeners.get("wheel")({ type: "wheel", target: fixture.scroller });
  fixture.listeners.get("scroll")({ target: fixture.scroller });
  h.persistWorkspace();
  const saved = JSON.parse(h.storage.getItem("dsh-splitview:reading:v1"));
  assert.equal(saved.find(([key]) => key === "saved:A")[1].top, 456, "page exit must flush a capture even before the animation frame");
  h.cleanup();
  assert.equal(h.pendingFrames, 0);
});

test("scrolls inside a nested tool card do not capture the conversation", () => {
  const fixture = readingFixture(), h = harness({ element: fixture.node });
  h.component(h.ReadingTab, { tab: { id: "nested", sessionId: "A" }, active: true });
  fixture.listeners.get("scroll")({ target: {} });
  assert.equal(h.pendingFrames, 0);
  assert.equal(fixture.scans, 0);
  h.cleanup();
});

test("performance: sidebar seat resizing changes geometry without scheduling a conversation render", () => {
  const surface = { style: {} }, h = harness({ element: surface });
  const box = { left: 0, top: 40, width: 1000, height: 700 };
  h.document.querySelector = () => ({ getBoundingClientRect: () => ({ ...box }) });
  h.component(h.StableTakeover, {});
  const writes = h.stateWrites;
  box.left = 280; box.width = 720;
  for (let i = 0; i < 20; i++) h.resizes[0].callback();
  assert.equal(h.pendingFrames, 1);
  h.runFrames();
  assert.equal(h.stateWrites, writes, "a sidebar animation must not invalidate the React conversation tree");
  assert.equal(surface.style.left, "280px");
  assert.equal(surface.style.width, "720px");
  h.cleanup();
});

function paneGeometryFixture() {
  let firstWidth = 500;
  const layout = { panes: new Map(), style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelectorAll: () => seats };
  const h = harness({ element: layout });
  const seats = [h.left, h.right].map((id, index) => ({ dataset: { dsvGroupSeat: id }, getBoundingClientRect: () => ({ left: index ? firstWidth : 0, top: 0, width: index ? 1000 - firstWidth : firstWidth, height: 700 }) }));
  for (const id of [h.left, h.right]) layout.panes.set(id, { style: {} });
  return { h, layout, resize: value => { firstWidth = value; } };
}

test("performance: pane resize notifications are batched without rerendering native content", () => {
  const { h, layout, resize } = paneGeometryFixture();
  h.render("A");
  const writes = h.stateWrites;
  resize(600);
  for (let i = 0; i < 20; i++) h.resizes[0].callback();
  h.runFrames();
  assert.equal(h.stateWrites, writes, "pane coordinates must not become React conversation state");
  assert.equal(layout.panes.get(h.left).style.width, "600px");
  assert.equal(layout.panes.get(h.right).style.left, "600px");
  h.cleanup();
});

test("performance: changing tabs keeps the existing geometry observers", () => {
  const { h } = paneGeometryFixture();
  h.render("A");
  const observers = h.resizes.length;
  h.store.actions.addTab(h.left); h.render("A");
  assert.equal(h.resizes.length, observers, "a tab edit does not change the pane skeleton");
  h.cleanup();
});

test("performance: an unrelated host render reuses the conversation workspace element", () => {
  const h = harness(), props = { renderSlot() {}, SessionProvider() {} };
  h.document.querySelector = () => null;
  const first = h.component(h.StableTakeover, props);
  const next = h.component(h.StableTakeover, { ...props, sidebarWidth: 280 });
  assert.equal(next.children[0], first.children[0], "host layout props do not affect the session workspace");
  h.cleanup();
});

test("performance: layout-driven scrolls and header clicks do not scan reading anchors", () => {
  const fixture = readingFixture(), h = harness({ element: fixture.node });
  h.component(h.ReadingTab, { tab: { id: "layout", sessionId: "A" }, active: true });
  fixture.scroller.scrollTop = 300;
  fixture.listeners.get("scroll")({ target: fixture.scroller });
  assert.equal(h.pendingFrames, 0, "scroll anchoring during pane resizing is not user scrolling");
  fixture.listeners.get("click")({ target: { closest: selector => selector === ".dsv-native-header" ? {} : null } });
  assert.equal(h.pendingFrames, 0, "opening a header sidebar must not force a reading capture");
  assert.equal(fixture.scans, 0);
  h.cleanup();
  assert.equal(h.readingMemory.get("layout:A").top, 300, "leaving the tab must still save the actual current position");
});

test("reading clicks in message content still capture disclosure changes", () => {
  const fixture = readingFixture(), h = harness({ element: fixture.node });
  h.component(h.ReadingTab, { tab: { id: "disclosure", sessionId: "A" }, active: true });
  fixture.listeners.get("click")({ target: { closest: () => null } });
  h.runFrames();
  assert.equal(fixture.scans, 1);
  h.cleanup();
});

test("performance: width observer uses supplied geometry and batches repeated writes", () => {
  const h = harness(), css = new Map(); let reads = 0;
  const container = { get offsetWidth() { reads++; return 620; }, parentElement: { style: { setProperty: (key, value) => css.set(key, value), removeProperty: key => css.delete(key) } } };
  h.component(h.WidthControls, { container, phase: "active" });
  reads = 0;
  const entries = [{ target: container, borderBoxSize: [{ inlineSize: 620 }] }];
  for (let i = 0; i < 20; i++) h.resizes[0].callback(entries);
  assert.equal(reads, 0, "ResizeObserver already supplied the width; offsetWidth would force another layout");
  assert.equal(h.pendingFrames, 1);
  h.runFrames();
  assert.equal(css.get("--dsh-conversation-column-width"), "620px");
  h.resizes[0].callback(entries);
  assert.equal(h.pendingFrames, 0, "height-only changes must not republish the same width");
  h.cleanup();
});

test("inactive panes keep native content but suspend invisible header extensions", () => {
  const h = harness(), calls = [];
  h.component(h.PaneBody, { sessionId: "A", tabId: "tab-A", active: false,
    renderSlot: name => { calls.push(name); return null; },
    renderFactorySlot: name => { calls.push(name); return null; },
  });
  assert.deepEqual(calls, ["conversation.content"], "hidden tabs do not need header extension observers");
});

test("inactive width controls do not retain resize observers", () => {
  const h = harness();
  h.PaneContext.value = { active: false };
  h.component(h.WidthControls, { container: { offsetWidth: 0, style: { setProperty() {}, removeProperty() {} } }, phase: "active" });
  assert.equal(h.resizes.length, 0);
});

test("ready conversations mount in a transition and obsolete completions cannot replace a retry", async () => {
  const h = harness({ deferTransitions: true });
  const first = { kind: "held", reference: { ready: Promise.resolve() } };
  h.component(h.useReferenceReady, first);
  await Promise.resolve();
  assert.equal(h.component(h.useReferenceReady, first).kind, "loading", "native content must not mount in the urgent layout update");
  const fresh = { kind: "held", reference: { ready: Promise.resolve() } };
  h.component(h.useReferenceReady, fresh);
  h.runTransitions();
  assert.equal(h.component(h.useReferenceReady, fresh).kind, "loading");
  await Promise.resolve(); h.runTransitions();
  assert.equal(h.component(h.useReferenceReady, fresh).kind, "ready");
});

test("parking a tab reuses its portal container and saves before hiding", () => {
  const fixture = readingFixture(), h = harness({ element: fixture.node });
  Object.defineProperty(fixture.scroller, "clientHeight", { get: () => fixture.node.hidden ? 0 : 500 });
  const props = { tab: { id: "parked", sessionId: "A" }, children: { draft: "unchanged draft" } };
  const first = h.component(h.ReadingTab, { ...props, active: true });
  const container = first.children[0].props.container;
  assert.equal(container.parentNode, fixture.node);
  fixture.scroller.scrollTop = 321;
  fixture.listeners.get("wheel")({ type: "wheel", target: fixture.scroller });
  fixture.listeners.get("scroll")({ target: fixture.scroller });
  const parked = h.component(h.ReadingTab, { ...props, active: false });
  assert.equal(h.readingMemory.get("parked:A").top, 321, "flush before hiding or detaching the viewport");
  assert.equal(parked.children[0].props.container, container);
  assert.equal(container.removed, true);
  const restored = h.component(h.ReadingTab, { ...props, active: true });
  assert.equal(restored.children[0].props.container, container);
  assert.equal(restored.children[0].children[0], props.children);
  assert.equal(container.removed, false);
  assert.equal(h.createdNodes.length, 1);
  h.cleanup();
});

test("tab content reuses its native slot and refreshes visibility and retry status", () => {
  const h = harness(), calls = [], retries = [];
  const group = h.listGroups(h.store.getSnapshot().root).find(g => g.id === h.left);
  const props = { groupId: h.left, tabId: group.activeTabId, sessionId: "A", active: true,
    status: { kind: "held", reference: {} }, SessionProvider() {}, retrySession: id => retries.push(id),
    renderSlot: (name, owner) => { calls.push({ name, owner }); return { name, owner }; },
  };
  const first = h.component(h.TabContent, props);
  assert.equal(h.component(h.TabContent, { ...props, paneWidth: 600 }), first);
  assert.equal(calls.length, 1);
  h.component(h.TabContent, { ...props, active: false });
  assert.equal(calls.at(-1).owner.active, false);
  const fresh = { ...props, status: { kind: "held", reference: {} } };
  const retried = h.component(h.TabContent, fresh);
  assert.equal(retried.props.status, fresh.status);
  retried.props.onRetry(); assert.deepEqual(retries, ["A"]);
  retried.props.onChoose(); assert.equal(h.active(), null);
});

test("width monitoring resumes on reveal and cancels queued writes on hide", () => {
  const h = harness(), writes = [];
  const container = { offsetWidth: 600, style: { setProperty: (...args) => writes.push(args), removeProperty() {} } };
  h.PaneContext.value = { active: false };
  h.component(h.WidthControls, { container, phase: "active" });
  h.PaneContext.value = { active: true };
  h.component(h.WidthControls, { container, phase: "active" });
  h.resizes[0].callback([{ target: container, borderBoxSize: [{ inlineSize: 600 }] }]);
  assert.equal(h.pendingFrames, 1);
  h.PaneContext.value = { active: false };
  h.component(h.WidthControls, { container, phase: "active" });
  assert.equal(h.resizes[0].targets.length, 0);
  assert.equal(h.pendingFrames, 0);
  h.runFrames(); assert.equal(writes.length, 0);
  h.cleanup();
});

test("embedded pages stay attached across tab hiding and reveal", () => {
  const fixture = readingFixture(), h = harness({ element: fixture.node });
  let appends = 0;
  fixture.node.appendChild = target => { appends++; target.parentNode = fixture.node; target.removed = false; };
  const props = { tab: { id: "embedded", sessionId: "A" }, children: {} };
  const tree = h.component(h.ReadingTab, { ...props, active: true });
  const target = tree.children[0].props.container;
  target.querySelector = () => ({ tagName: "IFRAME" });
  h.component(h.ReadingTab, { ...props, active: false });
  assert.equal(target.parentNode, fixture.node, "hiding an embedded page must not destroy its browsing context");
  assert.equal(fixture.node.hidden, true);
  h.component(h.ReadingTab, { ...props, active: true });
  assert.equal(appends, 1, "even re-appending an attached iframe can reload it");
  assert.equal(fixture.node.hidden, false);
  h.cleanup();
});

test("leaving the conversation slot hides the entire overlay including explicitly visible panes", () => {
  const surface = { style: {} }, h = harness({ element: surface });
  let seat = { getBoundingClientRect: () => ({ left: 280, top: 40, width: 1000, height: 700 }) };
  h.document.querySelector = () => seat;
  h.component(h.StableTakeover, {});
  seat = null;
  h.mutations[0].callback([{ target: { closest: () => null } }]); h.runFrames();
  assert.equal(surface.style.display, "none", "visibility:hidden alone can be overridden by a visible descendant");
  assert.equal(surface.inert, true, "off-page conversation controls must not accept focus");
  h.cleanup();
});

test("host panel selection hides immediately even while its old conversation seat remains", () => {
  const surface = { style: {} }, h = harness({ element: surface }), listeners = new Set();
  let activePanelId = null, width = 1000;
  h.runtime.layout = { panelInfo: {
    getSnapshot: () => ({ activePanelId }),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  } };
  h.document.querySelector = () => ({ getBoundingClientRect: () => ({ left: 280, top: 40, width, height: 700 }) });
  h.component(h.StableTakeover, {});
  activePanelId = "plugins"; for (const listener of listeners) listener();
  assert.equal(surface.style.display, "none", "route state must hide before the next animation frame");
  assert.equal(surface.inert, true);
  h.runFrames(); assert.equal(surface.style.display, "none", "a stale seat cannot reveal the overlay on another page");
  activePanelId = null; width = 800; for (const listener of listeners) listener(); h.runFrames();
  assert.equal(surface.style.display, "");
  assert.equal(surface.style.width, "800px");
  assert.equal(surface.inert, false);
  h.cleanup(); assert.equal(listeners.size, 0);
});

test("initializing on a global page ignores stale conversation geometry", () => {
  const surface = { style: {} }, h = harness({ element: surface });
  let measured = 0;
  h.runtime.layout = { panelInfo: {
    getSnapshot: () => ({ activePanelId: "plugins" }),
    subscribe: () => () => {},
  } };
  h.document.querySelector = () => ({ getBoundingClientRect: () => { measured++; return { width: 1000, height: 700 }; } });
  h.component(h.StableTakeover, {});
  assert.equal(surface.style.display, "none");
  assert.equal(surface.inert, true);
  assert.equal(measured, 0, "global pages must not trigger conversation layout work");
  h.cleanup();
});

test("leaving a host panel captures reading before hiding and tolerates detached content", () => {
  const surface = { style: {} }, h = harness({ element: surface }), listeners = new Set(), captures = [];
  let activePanelId = null;
  h.runtime.layout = { panelInfo: {
    getSnapshot: () => ({ activePanelId }),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  } };
  h.document.querySelector = () => ({ getBoundingClientRect: () => ({ left: 280, top: 40, width: 1000, height: 700 }) });
  h.component(h.StableTakeover, {});
  h.readingCaptures.add(() => { throw Error("detached content"); });
  h.readingCaptures.add(() => captures.push(surface.style.display));
  activePanelId = "plugins"; for (const listener of listeners) listener();
  assert.deepEqual(captures, [""], "capture must see the original viewport dimensions");
  assert.equal(surface.style.display, "none");
  for (const listener of listeners) listener();
  assert.equal(captures.length, 1, "repeated hidden notifications must not overwrite reading with zero geometry");
  h.cleanup();
});

test("compact sidebar ranks three available panels by usage with stable native tie order", () => {
  const h = harness();
  const panels = ["plugins", "market", "tasks", "ssh", "agents"].map(id => ({ id, label: id }));
  const defaultRank = h.partitionSidebarPanels(panels, {});
  assert.deepEqual(Array.from(defaultRank.common, p => p.id), ["plugins", "market", "tasks"]);
  const ranked = h.partitionSidebarPanels(panels, { ssh: 8, agents: 3, tasks: 3, removed: 100 });
  assert.deepEqual(Array.from(ranked.common, p => p.id), ["ssh", "tasks", "agents"]);
  assert.deepEqual(Array.from(ranked.more, p => p.id), ["plugins", "market"]);
  assert.deepEqual(panels.map(p => p.id), ["plugins", "market", "tasks", "ssh", "agents"], "host registry must remain unchanged");
});

test("sidebar usage persists across launches and one click records one navigation", () => {
  const h = harness(), preferences = h.createSidebarPreferences(h.storage), notifications = [];
  const initial = preferences.getSnapshot(), off = preferences.subscribe(() => notifications.push(1));
  assert.equal(preferences.getSnapshot(), initial, "external store reads must be stable");
  preferences.record("ssh"); preferences.record("ssh"); preferences.record("plugins");
  assert.equal(preferences.getSnapshot().usage.ssh, 2);
  assert.equal(notifications.length, 3);
  preferences.setCompact(false); preferences.setCompact(false);
  const restored = h.createSidebarPreferences(h.storage).getSnapshot();
  assert.equal(restored.compact, false); assert.equal(restored.usage.ssh, 2);
  assert.equal(restored.usage.plugins, 1); assert.equal(notifications.length, 4);
  off(); preferences.record("ssh"); assert.equal(notifications.length, 4);
  preferences.resetUsage();
  assert.deepEqual(Object.keys(preferences.getSnapshot().usage), []);
  assert.equal(h.createSidebarPreferences(h.storage).getSnapshot().compact, false);
});

test("sidebar storage corruption, blocked storage and inherited property ids cannot break navigation", () => {
  const h = harness();
  const corrupt = h.createSidebarPreferences({ getItem: () => "invalid json" });
  assert.equal(corrupt.getSnapshot().compact, true);
  const blocked = h.createSidebarPreferences({ getItem() { throw Error("blocked"); }, setItem() { throw Error("full"); } });
  assert.doesNotThrow(() => blocked.record("plugins"));
  blocked.record("__proto__"); blocked.record("toString");
  assert.equal(blocked.getSnapshot().usage.__proto__, 1);
  assert.equal(blocked.getSnapshot().usage.toString, 1);
  const restored = h.createSidebarPreferences({ getItem: () => JSON.stringify({ compact: false, usage: { good: 2, negative: -3, fractional: 1.2, huge: 2e12, text: "4" } }) });
  assert.deepEqual(Object.keys(restored.getSnapshot().usage), ["good"]);
  assert.equal(restored.getSnapshot().compact, false);
});

function findTree(tree, match) {
  if (!tree || typeof tree !== "object") return null;
  if (match(tree)) return tree;
  return (tree.children || []).flat(Infinity).map(child => findTree(child, match)).find(Boolean) || null;
}

test("sidebar rail opens native panels without moving pinned entries after usage changes", () => {
  const h = harness(), selected = [];
  const props = { panels: ["A", "B", "C", "D"].map(id => ({ id, label: id })), selectPanel: id => selected.push(id),
    usePanelInfo: select => select({ activePanelId: "A" }), renderSlot: () => null };
  const first = h.component(h.SidebarRail, props);
  const overflow = findTree(first, node => node.props?.["data-dsv-sidebar-menu-panel"] === "D");
  overflow.props.onSelect();
  assert.deepEqual(selected, ["D"]); assert.equal(h.sidebarPreferences.getSnapshot().usage.D, 1);
  const next = h.component(h.SidebarRail, props);
  assert.equal(findTree(next, node => node.props?.["data-dsv-sidebar-panel"] === "D"), null);
  assert.ok(findTree(next, node => node.props?.["data-dsv-sidebar-menu-panel"] === "D"));
  const common = findTree(next, node => node.props?.["data-dsv-sidebar-panel"] === "A");
  assert.equal(common.props["aria-current"], "page");
  common.props.onClick(); assert.deepEqual(selected, ["D", "A"]);
  h.cleanup();
});

test("compact shell reuses workspace content across panel changes and honors session permissions", () => {
  const h = harness(), slots = [], started = [];
  const props = { collapsed: false, width: 280, drawer: false, startSession: () => started.push(1), toggleSidebar() {}, selectPanel() {},
    useRemoteAccess: () => false, usePanels: select => select([]), usePanelInfo: select => select({ activePanelId: null }),
    renderSlot: (name, owner) => { slots.push({ name, owner }); return { native: name }; } };
  const first = h.component(h.CompactSidebar, props);
  const second = h.component(h.CompactSidebar, props);
  assert.equal(slots.filter(s => s.name === "sidebar.workspaces").length, 1);
  assert.equal(first.props.style.width, "280px"); assert.equal(second.props.style.width, "280px");
  assert.equal(findTree(first, n => n.props?.className === "dsv-sidebar__new"), null);
  assert.equal(findTree(first, n => n.props?.className === "dsv-sidebar__icon dsv-sidebar__brand").props.disabled, true);
  const collapsed = h.component(h.CompactSidebar, { ...props, collapsed: true });
  assert.equal(findTree(collapsed, n => n.props?.className === "dsv-sidebar__workspaces").props.inert, true);
  assert.equal(collapsed.props.style.width, "56px");
  assert.deepEqual(started, []); h.cleanup();
});

test("compact sidebar restores native registration when disabled and releases every subscription", () => {
  const h = harness(), listeners = new Set(), rows = [{ options: {}, inject() {}, children: { "sidebar.workspaces": { kind: "single", scope: "root" } } }], registered = [];
  const native = rows[0];
  const ctx = { shortcuts: { registry: { commands: new Map() }, catalog: { subscribe: () => () => {} } }, slots: {
    entries: () => rows,
    subscribe: (name, fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    register: (options, component) => {
      const entry = { options, component }; rows.unshift(entry); registered.push(entry);
      for (const fn of listeners) fn();
      return () => { rows.splice(rows.indexOf(entry), 1); for (const fn of listeners) fn(); };
    },
  } };
  const dispose = h.installCompactSidebar(ctx);
  assert.equal(registered.length, 1); assert.equal(registered[0].options.inject, native.inject);
  assert.deepEqual(Object.keys(registered[0].options.children), ["dsh-splitview.native.sidebar.workspaces"], "native child slots keep their original declarations; copies use the plugin namespace");
  assert.equal(registered[0].options.children["dsh-splitview.native.sidebar.workspaces"].scope, "root");
  h.sidebarPreferences.record("A"); assert.equal(registered.length, 1, "usage must not remount the shell");
  h.sidebarPreferences.setCompact(false); assert.equal(rows.length, 1); assert.equal(rows[0], native);
  h.sidebarPreferences.setCompact(true); assert.equal(registered.length, 2);
  dispose(); assert.equal(rows.length, 1); assert.equal(listeners.size, 0);
});

test("sidebar upgrade freezes the initial recommendations once and persists the chosen order", () => {
  const h = harness();
  const storage = { getItem: () => JSON.stringify({ compact: true, usage: { D: 8 } }), setItem: h.storage.setItem };
  const p = h.createSidebarPreferences(storage), panels = ["A", "B", "C", "D"].map(id => ({ id }));
  p.initializePins([]); assert.equal(p.getSnapshot().pinned, null);
  p.initializePins(panels); assert.deepEqual(Array.from(p.getSnapshot().pinned), ["D", "A", "B"]);
  for (let i = 0; i < 20; i++) p.record("C");
  p.initializePins(panels);
  assert.deepEqual(Array.from(p.getSnapshot().pinned), ["D", "A", "B"], "clicks and later registry updates must not change fixed positions");
  assert.deepEqual(Array.from(h.createSidebarPreferences(h.storage).getSnapshot().pinned), ["D", "A", "B"]);
});

test("manual favorites enforce three slots and leave deliberately emptied slots empty", () => {
  const h = harness(), p = h.createSidebarPreferences(h.storage);
  p.setPinned(["A", "B", "C"]); p.pin("D", true);
  assert.deepEqual(Array.from(p.getSnapshot().pinned), ["A", "B", "C"]);
  p.pin("B", false); p.pin("D", true); p.pin("D", true);
  assert.deepEqual(Array.from(p.getSnapshot().pinned), ["A", "C", "D"]);
  p.setPinned([]); p.initializePins(["A", "B", "C"].map(id => ({ id })));
  assert.equal(p.getSnapshot().pinned.length, 0, "manual empty slots must not be filled automatically");
  p.resetUsage(); assert.equal(p.getSnapshot().pinned.length, 0);
});

test("manual ordering survives malformed storage and temporarily removed plugins", () => {
  const h = harness();
  const p = h.createSidebarPreferences({ getItem: () => JSON.stringify({ pinned: ["C", "C", null, "A", "B", "D"], usage: {} }) });
  assert.deepEqual(Array.from(p.getSnapshot().pinned), ["C", "A", "B"]);
  let rows = h.partitionSidebarPanels(["A", "B", "D"].map(id => ({ id })), {}, p.getSnapshot().pinned);
  assert.deepEqual(Array.from(rows.common, p => p.id), ["A", "B"]);
  assert.deepEqual(Array.from(rows.more, p => p.id), ["D"]);
  rows = h.partitionSidebarPanels(["A", "B", "C", "D"].map(id => ({ id })), { D: 100 }, p.getSnapshot().pinned);
  assert.deepEqual(Array.from(rows.common, p => p.id), ["C", "A", "B"]);
});

test("favorites move up and down without changing membership or accepting unknown drag targets", () => {
  const h = harness(), p = h.createSidebarPreferences(h.storage);
  p.setPinned(["A", "B", "C"]); p.movePin("A", "C");
  assert.deepEqual(Array.from(p.getSnapshot().pinned), ["B", "C", "A"]);
  p.movePin("A", "B"); assert.deepEqual(Array.from(p.getSnapshot().pinned), ["A", "B", "C"]);
  const same = p.getSnapshot(); p.movePin("D", "A"); p.movePin("A", undefined); p.movePin("A", "A");
  assert.equal(p.getSnapshot(), same);
});

test("dragging favorites reorders the rail without accidentally navigating and supports keyboard moves", () => {
  const h = harness(), selected = [];
  const props = { panels: ["A", "B", "C", "D"].map(id => ({ id, label: id })), selectPanel: id => selected.push(id),
    usePanelInfo: select => select({ activePanelId: null }), renderSlot: () => null };
  let tree = h.component(h.SidebarRail, props);
  const button = id => findTree(tree, n => n.props?.["data-dsv-sidebar-panel"] === id);
  const data = new Map(), event = { dataTransfer: { setData: (key, value) => data.set(key, value) }, preventDefault() {}, stopPropagation() {} };
  button("A").props.onDragStart(event); button("C").props.onDragOver(event); button("C").props.onDrop(event);
  button("A").props.onClick(); assert.equal(selected.length, 0, "the click after a drag must not open the plugin");
  assert.equal(data.get("application/x-dsv-sidebar-pin"), "A");
  assert.deepEqual(Array.from(h.sidebarPreferences.getSnapshot().pinned), ["B", "C", "A"]);
  h.runTimers(0); tree = h.component(h.SidebarRail, props);
  button("A").props.onKeyDown({ ...event, altKey: true, key: "ArrowUp" });
  assert.deepEqual(Array.from(h.sidebarPreferences.getSnapshot().pinned), ["B", "A", "C"]);
  button("A").props.onClick(); assert.deepEqual(selected, ["A"]);
  h.cleanup();
});

test("favorites manager lets users replace a pin and move it with accessible buttons", () => {
  const h = harness(), panels = ["A", "B", "C", "D"].map(id => ({ id, label: id }));
  const rail = h.component(h.SidebarRail, { panels, selectPanel() {}, usePanelInfo: fn => fn({ activePanelId: null }), renderSlot: () => null });
  const Manager = findTree(rail, n => n.type?.name === "SidebarFavorites").type;
  h.cleanup();
  let tree = h.component(Manager, { open: true, onClose() {}, panels, renderSlot: () => null });
  const choices = () => findTree(tree, n => n.props?.className === "dsv-favorites__choices");
  const inputs = () => choices().children[0].map(n => findTree(n, n => n.type === "input"));
  assert.equal(inputs()[3].props.disabled, true);
  inputs()[1].props.onChange({ target: { checked: false } });
  tree = h.component(Manager, { open: true, onClose() {}, panels, renderSlot: () => null });
  assert.equal(inputs()[3].props.disabled, false); inputs()[3].props.onChange({ target: { checked: true } });
  assert.deepEqual(Array.from(h.sidebarPreferences.getSnapshot().pinned), ["A", "C", "D"]);
  assert.equal(h.component(Manager, { open: false, panels }), null);
  h.cleanup();
});

test("collapsed rail changes only the sidebar grid track and preserves the native center and right tracks", () => {
  const h = harness();
  assert.equal(h.railColumns("0px minmax(400px, 1fr) minmax(0px, 480px)"), "56px minmax(400px, 1fr) minmax(0px, 480px)");
  assert.equal(h.railColumns("320.5px minmax(0px, 1fr) minmax(0px, 0px)"), "56px minmax(0px, 1fr) minmax(0px, 0px)");
  assert.equal(h.railColumns("unknown"), "");
});

test("collapsed plugin rail stays interactive and removes only its own frame changes on disposal", () => {
  const h = harness(), properties = new Map(), attributes = new Set(["data-sidebar-collapsed", "data-sidebar-drawer"]);
  const frame = { style: { gridTemplateColumns: "0px minmax(0px, 1fr) minmax(0px, 0px)",
    getPropertyValue: name => properties.get(name), setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) },
    hasAttribute: name => attributes.has(name), setAttribute: name => attributes.add(name), removeAttribute: name => attributes.delete(name) };
  const columnAttrs = new Set();
  const column = { parentElement: frame, inert: true, setAttribute: name => columnAttrs.add(name), removeAttribute: name => columnAttrs.delete(name) };
  const off = h.installPluginRail({ closest: () => ({ parentElement: column }) });
  assert.equal(column.inert, false); assert.equal(properties.get("--dsv-rail-columns"), "56px minmax(0px, 1fr) minmax(0px, 0px)");
  frame.style.gridTemplateColumns = "0px minmax(400px, 1fr) minmax(0px, 460px)";
  h.mutations[0].callback();
  assert.equal(properties.get("--dsv-rail-columns"), "56px minmax(400px, 1fr) minmax(0px, 460px)");
  assert.equal(frame.style.gridTemplateColumns, "0px minmax(400px, 1fr) minmax(0px, 460px)", "the host keeps ownership of its inline geometry");
  assert.equal(h.stateWrites, 0); assert.equal(h.mutations[0].targets.length, 2);
  off(); assert.equal(properties.size, 0); assert.equal(attributes.has("data-dsv-plugin-rail"), false); assert.equal(columnAttrs.size, 0);
  assert.equal(column.inert, true, "return control of a hidden native drawer to its host");
  assert.equal(h.mutations[0].targets.length, 0);
});

test("Ctrl+B ignores hidden skin dialogs but respects visible modals and sidebar drawers", () => {
  const h = harness(), listeners = new Set(), calls = [];
  let modals = [];
  const original = context => { calls.push(context); return { status: context.modal === null || context.modal === "sidebar" ? "handled" : "pass" }; };
  const command = { resolve: original }, commands = new Map([["sidebar.left.toggle", command]]);
  const ctx = { shortcuts: { registry: { commands }, catalog: { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } } } };
  const node = (width, visible = true, modal) => ({ hidden: false, getAttribute: () => null, checkVisibility: () => visible, getBoundingClientRect: () => ({ width, height: width }), dataset: { shortcutModal: modal } });
  h.document.querySelectorAll = () => modals;
  const off = h.installSidebarShortcut(ctx), target = {};
  modals = [node(0), node(100, false)];
  assert.equal(command.resolve({ modal: "other", region: "editable", target }).status, "handled");
  assert.equal(calls.at(-1).target, target); assert.equal(calls.at(-1).region, "editable");
  modals = [node(100), node(0)];
  assert.equal(command.resolve({ modal: "other" }).status, "pass", "a real modal must keep focus and keyboard ownership");
  modals = [node(100, true, "sidebar"), node(0)];
  assert.equal(command.resolve({ modal: "other" }).status, "handled", "the visible sidebar wins over a later hidden skin dialog");
  off(); assert.equal(command.resolve, original); assert.equal(listeners.size, 0);
});

test("shortcut bridge follows host command replacement and does not overwrite another extension on disposal", () => {
  const h = harness(), listeners = new Set(), commands = new Map();
  const ctx = { shortcuts: { registry: { commands }, catalog: { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } } } };
  const first = { resolve: () => ({ status: "pass" }) }, firstOriginal = first.resolve;
  const second = { resolve: () => ({ status: "handled" }) }, secondOriginal = second.resolve;
  commands.set("sidebar.left.toggle", first); const off = h.installSidebarShortcut(ctx);
  commands.set("sidebar.left.toggle", second); for (const fn of listeners) fn();
  assert.equal(first.resolve, firstOriginal); assert.notEqual(second.resolve, secondOriginal);
  const later = () => ({ status: "blocked" }); second.resolve = later; off();
  assert.equal(second.resolve, later); assert.equal(listeners.size, 0);
});

test("workspace folding restores the user's expanded width and leaves the plugin rail at 56px", () => {
  const h = harness(), widths = [];
  h.runtime.layout = { panels: { setSidebar: width => widths.push(width) } };
  const props = { collapsed: false, width: 320, drawer: false, startSession() {}, toggleSidebar() {}, selectPanel() {},
    useRemoteAccess: () => false, usePanels: select => select([]), usePanelInfo: select => select({ activePanelId: null }), renderSlot: () => null };
  h.component(h.CompactSidebar, props);
  const folded = h.component(h.CompactSidebar, { ...props, collapsed: true, width: 0 });
  assert.equal(folded.props.style.width, "56px");
  h.component(h.CompactSidebar, { ...props, width: 280 });
  assert.deepEqual(widths, [320]); h.component(h.CompactSidebar, props); assert.deepEqual(widths, [320]); h.cleanup();
});

test("workspace icon is a separate accessible rail control sharing the native fold action", () => {
  const h = harness(), toggles = [];
  const props = { collapsed: false, width: 280, drawer: false, startSession() {}, toggleSidebar: () => toggles.push(1), selectPanel() {},
    useRemoteAccess: () => false, usePanels: select => select([]), usePanelInfo: select => select({ activePanelId: null }), renderSlot: () => null };
  let tree = h.component(h.CompactSidebar, props);
  let button = findTree(tree, n => n.props?.["data-dsv-workspace-button"] !== undefined);
  assert.equal(button.props["aria-label"], "workspaceEntry");
  assert.equal(button.props["aria-expanded"], true);
  const workspaces = findTree(tree, n => n.props?.className === "dsv-sidebar__workspaces");
  assert.equal(button.props["aria-controls"], workspaces.props.id);
  button.props.onClick(); assert.equal(toggles.length, 1);
  tree = h.component(h.CompactSidebar, { ...props, collapsed: true, width: 0 });
  button = findTree(tree, n => n.props?.["data-dsv-workspace-button"] !== undefined);
  assert.equal(button.props["aria-expanded"], false); assert.equal(button.props.title, "sidebarExpand");
  button.props.onClick(); assert.equal(toggles.length, 2);
  assert.equal(h.writes.length, 0, "the workspace control must not change the selected conversation");
  h.cleanup();
});
