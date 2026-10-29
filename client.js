/**
 * dsh-splitview — VSCode-style tabs + splits for the DSH Web UI.
 *
 * The browser half is a single plain-JS bundle: no JSX, no build step.
 * Everything is registered through the Client `slots` service.
 */
window.__ModuleLoader__.load({
	id: "dsh-splitview",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		//#region constants
		const NS = "dsh-splitview";
		const PANEL_ID = "splitview";
		const MAX_GROUPS = 3;
		const MIN_FRACTION = 0.15;
		const STORAGE_KEY = "dsh-splitview:layout:v1";
		const SOURCE = "splitview";
		//#endregion

		//#region styles
		const CSS = `
.dsv-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;background:var(--dsw-alias-bg-base)}
.dsv-stack{flex:1 1 auto;min-width:0;min-height:0;display:flex}
.dsv-root[data-orientation="row"] .dsv-stack{flex-direction:row}
.dsv-root[data-orientation="col"] .dsv-stack{flex-direction:column}
.dsv-group{display:flex;flex-direction:column;flex-grow:1;flex-shrink:1;flex-basis:0;min-width:0;min-height:0;outline:1px solid transparent;outline-offset:-1px;transition:outline-color var(--ds-transition-duration-slow) var(--ds-ease-in-out)}
.dsv-group--active{outline-color:var(--dsw-alias-border-l3)}
.dsv-tabbar{display:flex;align-items:stretch;gap:2px;flex:0 0 30px;height:30px;padding:0 2px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;border-bottom:1px solid var(--dsw-alias-border-l3)}
.dsv-tabbar::-webkit-scrollbar{display:none}
.dsv-tab{display:inline-flex;align-items:center;gap:6px;max-width:220px;min-width:0;margin:3px 0;padding:0 6px 0 9px;font-size:12px;line-height:1;color:var(--dsw-alias-fg-secondary);background:transparent;border:0;border-radius:5px;cursor:pointer;white-space:nowrap}
.dsv-tab:hover{background:var(--dsw-alias-bg-l2)}
.dsv-tab--active{background:var(--dsw-alias-bg-l2);color:inherit;box-shadow:inset 0 -2px 0 0 currentColor}
.dsv-tab--broken .dsv-tab__label{text-decoration:line-through;opacity:.55}
.dsv-tab__label{overflow:hidden;text-overflow:ellipsis}
.dsv-tab__close{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:16px;height:16px;border:0;border-radius:4px;background:transparent;color:inherit;opacity:.6;cursor:pointer;font-size:11px;line-height:1;padding:0}
.dsv-tab__close:hover{opacity:1;background:var(--dsw-alias-bg-l3,#00000014)}
.dsv-tabbar__add{flex:0 0 auto;width:22px;margin:3px 0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-fg-secondary);cursor:pointer;font-size:14px;line-height:1;padding:0}
.dsv-tabbar__add:hover{background:var(--dsw-alias-bg-l2)}
.dsv-tabbar__add[disabled]{opacity:.35;cursor:default}
.dsv-body{flex:1 1 auto;min-width:0;min-height:0;display:flex;overflow:hidden}
.dsv-body>*{flex:1 1 0;min-width:0;min-height:0}
.dsv-resizer{flex:0 0 6px;position:relative;background:transparent;touch-action:none}
.dsv-resizer::after{content:"";position:absolute;background:var(--dsw-alias-border-l3);opacity:.6}
.dsv-root[data-orientation="row"] .dsv-resizer{cursor:col-resize}
.dsv-root[data-orientation="row"] .dsv-resizer::after{top:0;bottom:0;left:50%;width:1px}
.dsv-root[data-orientation="col"] .dsv-resizer{cursor:row-resize}
.dsv-root[data-orientation="col"] .dsv-resizer::after{left:0;right:0;top:50%;height:1px}
.dsv-resizer:hover::after,.dsv-resizer:active::after{opacity:1}
.dsv-toolbar{position:absolute;right:10px;bottom:10px;z-index:5;display:flex;gap:2px;padding:3px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);box-shadow:0 2px 10px #0000001f;opacity:.5;transition:opacity var(--ds-transition-duration-slow) var(--ds-ease-in-out)}
.dsv-toolbar:hover,.dsv-toolbar:focus-within{opacity:1}
.dsv-tool{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;padding:0}
.dsv-tool:hover{background:var(--dsw-alias-bg-l2)}
.dsv-tool[disabled]{opacity:.3;cursor:default}
.dsv-picker{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px;padding:12px}
.dsv-picker__search{width:100%;box-sizing:border-box;padding:6px 8px;font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-bg-l2);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;outline:none}
.dsv-picker__search:focus{border-color:var(--dsw-alias-fg-secondary)}
.dsv-picker__list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:1px}
.dsv-picker__row{display:flex;flex-direction:column;gap:2px;text-align:left;padding:7px 8px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit}
.dsv-picker__row:hover{background:var(--dsw-alias-bg-l2)}
.dsv-picker__title{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsv-picker__meta{font-size:11px;color:var(--dsw-alias-fg-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsv-empty{flex:1 1 auto;display:flex;align-items:center;justify-content:center;padding:16px;font-size:12px;color:var(--dsw-alias-fg-secondary);text-align:center;line-height:1.6}
.dsv-empty--error{color:var(--dsw-alias-fg-secondary)}
.dsv-empty__actions{display:flex;gap:8px;justify-content:center;margin-top:10px}
.dsv-linkbtn{padding:4px 10px;font:inherit;font-size:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.dsv-linkbtn:hover{background:var(--dsw-alias-bg-l2)}
.dsv-hbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;padding:0}
.dsv-hbtn:hover{background:var(--dsw-alias-bg-l2)}
.dsv-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-fg-secondary);animation:dsv-spin .8s linear infinite}
@keyframes dsv-spin{to{transform:rotate(360deg)}}
`;
		(function installStyles() {
			if (typeof document === "undefined") return;
			const tagId = NS + "/client.js";
			if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = NS;
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		})();
		//#endregion

		//#region state model
		let uidCounter = 0;
		function uid(prefix) {
			uidCounter += 1;
			return prefix + Date.now().toString(36) + uidCounter.toString(36);
		}

		function clampSizes(sizes, count) {
			if (count <= 0) return [];
			let arr = Array.isArray(sizes) ? sizes.slice(0, count).map(Number) : [];
			while (arr.length < count) arr.push(1 / count);
			if (arr.some((n) => !Number.isFinite(n) || n <= 0)) arr = arr.map(() => 1 / count);
			const min = Math.min(MIN_FRACTION, 1 / count);
			for (let pass = 0; pass < 2; pass += 1) {
				const total = arr.reduce((a, b) => a + b, 0);
				if (!(total > 0)) return arr.map(() => 1 / count);
				arr = arr.map((n) => n / total);
				let over = 0;
				arr = arr.map((n) => {
					if (n < min) {
						over += min - n;
						return min;
					}
					return n;
				});
				if (over <= 0) break;
				let room = 0;
				for (const n of arr) if (n > min) room += n - min;
				if (room <= 0) break;
				arr = arr.map((n) => (n > min ? n - ((n - min) / room) * over : n));
			}
			const total = arr.reduce((a, b) => a + b, 0);
			return arr.map((n) => n / total);
		}

		function defaultState() {
			const tab = { id: uid("tab"), sessionId: null };
			const group = { id: uid("pane"), activeTabId: tab.id, tabs: [tab] };
			return { version: 1, orientation: "row", groups: [group], activeGroupId: group.id, sizes: [1] };
		}

		function normalizeState(raw) {
			const fallback = defaultState();
			if (!raw || typeof raw !== "object" || raw.version !== 1) return fallback;
			const groupsIn = Array.isArray(raw.groups) ? raw.groups : [];
			const groups = [];
			const seenGroups = new Set();
			const seenTabs = new Set();
			for (const g of groupsIn) {
				if (groups.length >= MAX_GROUPS) break;
				if (!g || typeof g !== "object" || !Array.isArray(g.tabs)) continue;
				const tabs = [];
				for (const tb of g.tabs) {
					if (!tb || typeof tb !== "object") continue;
					let id = typeof tb.id === "string" && tb.id ? tb.id : uid("tab");
					if (seenTabs.has(id)) id = uid("tab");
					seenTabs.add(id);
					tabs.push({ id, sessionId: typeof tb.sessionId === "string" && tb.sessionId ? tb.sessionId : null });
				}
				if (tabs.length === 0) continue;
				let id = typeof g.id === "string" && g.id ? g.id : uid("pane");
				if (seenGroups.has(id)) id = uid("pane");
				seenGroups.add(id);
				const activeTabId = tabs.some((t) => t.id === g.activeTabId) ? g.activeTabId : tabs[0].id;
				groups.push({ id, activeTabId, tabs });
			}
			if (groups.length === 0) return fallback;
			const orientation = raw.orientation === "col" ? "col" : "row";
			const sizes = Array.isArray(raw.sizes) && raw.sizes.length === groups.length ? clampSizes(raw.sizes, groups.length) : clampSizes(groups.map(() => 1 / groups.length), groups.length);
			const activeGroupId = typeof raw.activeGroupId === "string" && groups.some((g) => g.id === raw.activeGroupId) ? raw.activeGroupId : groups[0].id;
			return { version: 1, orientation, groups, activeGroupId, sizes };
		}

		function loadState() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (!raw) return defaultState();
				return normalizeState(JSON.parse(raw));
			} catch (error) {
				return defaultState();
			}
		}

		function createStore() {
			let state = loadState();
			const listeners = new Set();
			let timer = null;
			const persist = () => {
				if (timer !== null) return;
				timer = setTimeout(() => {
					timer = null;
					try {
						localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
					} catch (error) {
						/* storage unavailable: degrade to memory-only */
					}
				}, 250);
			};
			const set = (next) => {
				if (next === state) return;
				state = next;
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch (error) {
						console.error("[dsh-splitview] state listener failed", error);
					}
				}
				persist();
			};
			const findGroup = (id) => state.groups.find((g) => g.id === id);
			const actions = {
				setOrientation(value) {
					const orientation = value === "col" ? "col" : "row";
					if (state.orientation === orientation) return;
					set({ ...state, orientation });
				},
				setActiveGroup(groupId) {
					if (state.activeGroupId === groupId) return;
					if (!findGroup(groupId)) return;
					set({ ...state, activeGroupId: groupId });
				},
				setActiveTab(groupId, tabId) {
					const group = findGroup(groupId);
					if (!group || group.activeTabId === tabId) return;
					if (!group.tabs.some((t) => t.id === tabId)) return;
					const groups = state.groups.map((g) => (g.id === groupId ? { ...g, activeTabId: tabId } : g));
					set({ ...state, groups, activeGroupId: groupId });
				},
				split() {
					if (state.groups.length >= MAX_GROUPS) return false;
					const index = Math.max(0, state.groups.findIndex((g) => g.id === state.activeGroupId));
					const tab = { id: uid("tab"), sessionId: null };
					const group = { id: uid("pane"), activeTabId: tab.id, tabs: [tab] };
					const groups = state.groups.slice();
					groups.splice(index + 1, 0, group);
					const sizes = state.sizes.slice();
					const half = (sizes[index] ?? 1) / 2;
					sizes[index] = half;
					sizes.splice(index + 1, 0, half);
					set({ ...state, groups, sizes: clampSizes(sizes, groups.length), activeGroupId: group.id });
					return true;
				},
				closeGroup(groupId) {
					if (state.groups.length <= 1) return false;
					const index = state.groups.findIndex((g) => g.id === groupId);
					if (index < 0) return false;
					const groups = state.groups.filter((_, i) => i !== index);
					const sizes = state.sizes.filter((_, i) => i !== index);
					const activeGroupId = state.activeGroupId === groupId ? groups[Math.min(index, groups.length - 1)].id : state.activeGroupId;
					set({ ...state, groups, sizes: clampSizes(sizes, groups.length), activeGroupId });
					return true;
				},
				setSizes(sizes) {
					set({ ...state, sizes: clampSizes(sizes, state.groups.length) });
				},
				addTab(groupId) {
					const group = findGroup(groupId);
					if (!group) return;
					const tab = { id: uid("tab"), sessionId: null };
					const groups = state.groups.map((g) => (g.id === groupId ? { ...g, tabs: [...g.tabs, tab], activeTabId: tab.id } : g));
					set({ ...state, groups, activeGroupId: groupId });
				},
				closeTab(groupId, tabId) {
					const group = findGroup(groupId);
					if (!group) return;
					const index = group.tabs.findIndex((t) => t.id === tabId);
					if (index < 0) return;
					const tabs = group.tabs.filter((t) => t.id !== tabId);
					if (tabs.length === 0) {
						if (state.groups.length > 1) {
							const groupIndex = state.groups.findIndex((g) => g.id === groupId);
							const groups = state.groups.filter((g) => g.id !== groupId);
							const sizes = state.sizes.filter((_, i) => i !== groupIndex);
							const activeGroupId = state.activeGroupId === groupId ? groups[Math.min(groupIndex, groups.length - 1)].id : state.activeGroupId;
							set({ ...state, groups, sizes: clampSizes(sizes, groups.length), activeGroupId });
							return;
						}
						const fresh = { id: uid("tab"), sessionId: null };
						const groups = state.groups.map((g) => (g.id === groupId ? { ...g, tabs: [fresh], activeTabId: fresh.id } : g));
						set({ ...state, groups });
						return;
					}
					const activeTabId = group.activeTabId === tabId ? tabs[Math.max(0, index - 1)].id : group.activeTabId;
					const groups = state.groups.map((g) => (g.id === groupId ? { ...g, tabs, activeTabId } : g));
					set({ ...state, groups });
				},
				setSession(groupId, tabId, sessionId) {
					const groups = state.groups.map((g) => {
						if (g.id !== groupId) return g;
						return { ...g, activeTabId: tabId, tabs: g.tabs.map((t) => (t.id === tabId ? { ...t, sessionId } : t)) };
					});
					set({ ...state, groups, activeGroupId: groupId });
				},
				moveTab(tabId, fromGroupId, toGroupId, index) {
					const from = findGroup(fromGroupId);
					const to = findGroup(toGroupId);
					if (!from || !to) return;
					const tab = from.tabs.find((t) => t.id === tabId);
					if (!tab) return;
					if (fromGroupId === toGroupId) {
						const tabs = from.tabs.filter((t) => t.id !== tabId);
						const at = Math.max(0, Math.min(index, tabs.length));
						tabs.splice(at, 0, tab);
						set({ ...state, groups: state.groups.map((g) => (g.id === fromGroupId ? { ...g, tabs } : g)) });
						return;
					}
					const fromTabs = from.tabs.filter((t) => t.id !== tabId);
					const toTabs = to.tabs.slice();
					const at = Math.max(0, Math.min(index, toTabs.length));
					toTabs.splice(at, 0, tab);
					let groups = state.groups.map((g) => {
						if (g.id === fromGroupId) return { ...g, tabs: fromTabs, activeTabId: g.activeTabId === tabId ? (fromTabs[0] ? fromTabs[0].id : null) : g.activeTabId };
						if (g.id === toGroupId) return { ...g, tabs: toTabs, activeTabId: tab.id };
						return g;
					});
					let sizes = state.sizes;
					if (fromTabs.length === 0) {
						const removeIndex = groups.findIndex((g) => g.id === fromGroupId);
						groups = groups.filter((g) => g.id !== fromGroupId);
						sizes = sizes.filter((_, i) => i !== removeIndex);
					}
					set({ ...state, groups, sizes: clampSizes(sizes, groups.length), activeGroupId: toGroupId });
				},
				openInSplit(sessionId) {
					for (const group of state.groups) {
						const tab = group.tabs.find((t) => t.sessionId === sessionId);
						if (tab) {
							const groups = state.groups.map((g) => (g.id === group.id ? { ...g, activeTabId: tab.id } : g));
							set({ ...state, groups, activeGroupId: group.id });
							return;
						}
					}
					const active = findGroup(state.activeGroupId) ?? state.groups[0];
					if (!active) return;
					const current = active.tabs.find((t) => t.id === active.activeTabId) ?? active.tabs[0];
					let groups;
					if (current && current.sessionId === null) {
						groups = state.groups.map((g) => (g.id === active.id ? { ...g, activeTabId: current.id, tabs: g.tabs.map((t) => (t.id === current.id ? { ...t, sessionId } : t)) } : g));
					} else {
						const tab = { id: uid("tab"), sessionId };
						groups = state.groups.map((g) => (g.id === active.id ? { ...g, tabs: [...g.tabs, tab], activeTabId: tab.id } : g));
					}
					set({ ...state, groups, activeGroupId: active.id });
				},
				reset() {
					set(defaultState());
				},
			};
			return {
				getSnapshot: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				actions,
			};
		}

		const store = createStore();
		//#endregion

		//#region runtime wiring
		const runtime = { ctx: null, sessions: null, t: null };

		function useLayout() {
			return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
		}

		function sessionListSource() {
			const list = runtime.sessions ? runtime.sessions.list : undefined;
			if (!list) return null;
			return list;
		}

		function useSessionList() {
			const list = sessionListSource();
			const subscribe = React.useCallback((listener) => (list && typeof list.subscribe === "function" ? list.subscribe(listener) : () => {}), [list]);
			const getSnapshot = React.useCallback(() => (list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null), [list]);
			return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}

		/**
		 * Root sessions as picker rows.
		 * The projected list rows use the DISPLAY field names, not the engine ones:
		 * `id` (not `sessionId`), `parentId` (not `parentSessionId`), `displayTitle`.
		 * Normalising here keeps the rest of this file on one vocabulary.
		 */
		function rowsOf(list) {
			if (!list || !list.byId) return [];
			const rows = [];
			for (const row of Object.values(list.byId)) {
				if (!row || row.parentId !== undefined) continue;
				rows.push({ ...row, sessionId: row.id });
			}
			return rows;
		}

		function titleOf(row, sessionId) {
			if (row && typeof row.displayTitle === "string" && row.displayTitle.trim()) return row.displayTitle.trim();
			if (row && typeof row.title === "string" && row.title.trim()) return row.title.trim();
			if (row && typeof row.cwd === "string" && row.cwd.trim()) {
				const parts = row.cwd.split(/[\\/]+/).filter(Boolean);
				if (parts.length > 0) return parts[parts.length - 1];
			}
			return String(sessionId).slice(0, 8);
		}

		function describeError(error) {
			if (!error) return "unknown error";
			if (typeof error === "string") return error;
			return error.message || String(error);
		}

		function releaseEntry(entry) {
			if (entry && entry.kind === "held" && entry.reference && typeof entry.reference.release === "function") {
				try {
					entry.reference.release();
				} catch (error) {
					/* already released */
				}
			}
		}

		/**
		 * Hold a live SessionReference for every id we actually render.
		 * Incremental: ids that stay keep their reference (no release/re-retain churn,
		 * which would retire and reopen the session on every tab switch); ids that
		 * leave are released. Everything is released when the panel unmounts.
		 */
		function useHeldReferences(ids) {
			const key = ids.slice().sort().join("|");
			const mapRef = React.useRef(new Map());
			const [, force] = React.useReducer((n) => n + 1, 0);

			React.useEffect(() => {
				const sessions = runtime.sessions;
				const map = mapRef.current;
				const wanted = new Set(ids);
				for (const [id, entry] of [...map]) {
					if (wanted.has(id)) continue;
					releaseEntry(entry);
					map.delete(id);
				}
				if (sessions && typeof sessions.retain === "function") {
					for (const id of ids) {
						if (map.has(id)) continue;
						try {
							map.set(id, { kind: "held", reference: sessions.retain(id, { source: SOURCE }) });
						} catch (error) {
							map.set(id, { kind: "failed", message: describeError(error) });
						}
					}
				}
				force();
				return undefined;
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [key]);

			React.useEffect(
				() => () => {
					for (const entry of mapRef.current.values()) releaseEntry(entry);
					mapRef.current.clear();
				},
				[],
			);

			return mapRef.current;
		}
		//#endregion

		//#region small parts
		function IconSplit() {
			return h(
				"svg",
				{ width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinejoin: "round", "aria-hidden": true },
				h("rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5 }),
				h("path", { d: "M8 2.5v11" }),
			);
		}
		function IconOrientation() {
			return h(
				"svg",
				{ width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinejoin: "round", "aria-hidden": true },
				h("rect", { x: 1.5, y: 2.5, width: 5, height: 11, rx: 1 }),
				h("rect", { x: 9.5, y: 2.5, width: 5, height: 5, rx: 1 }),
				h("rect", { x: 9.5, y: 9.5, width: 5, height: 4, rx: 1 }),
			);
		}
		function IconClose() {
			return h(
				"svg",
				{ width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", "aria-hidden": true },
				h("path", { d: "M4 4l8 8M12 4l-8 8" }),
			);
		}

		function SplitviewIcon(props) {
			const size = typeof props.size === "number" ? props.size : 18;
			const opacity = props.active ? 1 : 0.82;
			return h(
				"svg",
				{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinejoin: "round", style: { opacity }, "aria-hidden": true },
				h("rect", { x: 1.2, y: 2.2, width: 5.4, height: 11.6, rx: 1 }),
				h("rect", { x: 8.4, y: 2.2, width: 6.4, height: 5.2, rx: 1 }),
				h("rect", { x: 8.4, y: 8.8, width: 6.4, height: 5, rx: 1 }),
			);
		}

		function IconOpenSplit() {
			return h(
				"svg",
				{ width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinejoin: "round", "aria-hidden": true },
				h("rect", { x: 1.5, y: 2.5, width: 5.6, height: 11, rx: 1.2 }),
				h("rect", { x: 9, y: 2.5, width: 5.5, height: 11, rx: 1.2 }),
			);
		}
		//#endregion

		//#region conversation pane
		function FixedChatView(props) {
			return h(React.Fragment, null, props.renderSlot("conversation.session", { view: "chat" }));
		}

		function PaneBody(props) {
			const { renderFactorySlot, useSession, useSessions, useConversation, sessionId } = props;
			// Every one of these is a uSES selector hook built by the renderer
			// (bindSnapshotSelector): the selector argument is mandatory, so pass an
			// identity function even when we want the whole snapshot.
			const session = typeof useSession === "function" ? useSession((value) => value) : undefined;
			const summaryBlank = typeof useSessions === "function" ? useSessions((state) => (state && state.byId && sessionId !== undefined ? state.byId[sessionId] && state.byId[sessionId].blank : undefined)) : undefined;
			const conversation = typeof useConversation === "function" ? useConversation((value) => value) : undefined;

			let phase = "active";
			let hero = false;
			if (session) {
				const targets = conversation && conversation.activeTargets;
				const hasTargets = targets && typeof targets.size === "number" && targets.size > 0;
				const shellPhase = hasTargets || (!session.blank && !session.awaitingFirstTurn) || session.running ? "active" : session.promptAttempted ? "engaging" : "blank";
				const subagent = session.subagent;
				const parentPending = subagent && subagent.address && subagent.address.mode === "continuable" && subagent.parentAvailable === undefined;
				const settling = (shellPhase === "blank" && session.openState === "loading" && summaryBlank !== true) || parentPending;
				hero = shellPhase === "blank" && (session.openState === "open" || summaryBlank === true);
				phase = settling ? "settling" : hero ? "hero" : "active";
			}

			return renderFactorySlot("conversation.content", { variant: "embedded", phase, hero }, { slots: { views: FixedChatView }, fallback: ConversationUnavailable(props) });
		}

		function ConversationUnavailable(props) {
			const t = props.t || runtime.t;
			return h("div", { className: "dsv-empty" }, t("conversationUnavailable"));
		}

		function useReferenceReady(status) {
			const [ready, setReady] = React.useState(false);
			React.useEffect(() => {
				setReady(false);
				if (!status || status.kind !== "held") return undefined;
				const reference = status.reference;
				let cancelled = false;
				const promise = reference && reference.ready;
				if (promise && typeof promise.then === "function") {
					promise.then(
						() => {
							if (!cancelled) setReady(true);
						},
						() => {
							if (!cancelled) setReady(false);
						},
					);
				} else {
					setReady(true);
				}
				return () => {
					cancelled = true;
				};
			}, [status]);
			return ready;
		}

		function SessionHost(props) {
			const { status, onRemove, children } = props;
			const t = runtime.t;
			const ready = useReferenceReady(status);
			if (!status || status.kind === "missing") return h("div", { className: "dsv-empty" }, t("loading"));
			if (status.kind === "failed") {
				return h(
					"div",
					{ className: "dsv-empty dsv-empty--error" },
					h(
						"div",
						null,
						t("failedSession"),
						h("div", { className: "dsv-picker__meta" }, status.message || ""),
						h("div", { className: "dsv-empty__actions" }, h("button", { type: "button", className: "dsv-linkbtn", onClick: onRemove }, t("removeTab"))),
					),
				);
			}
			if (!ready) {
				return h("div", { className: "dsv-empty" }, h("div", { className: "dsv-spin", "aria-hidden": true }));
			}
			const SessionProvider = props.SessionProvider;
			if (typeof SessionProvider !== "function") return h("div", { className: "dsv-empty" }, t("conversationUnavailable"));
			return h(SessionProvider, { session: status.reference }, children);
		}
		//#endregion

		//#region session picker
		function SessionPicker(props) {
			const { onPick } = props;
			const t = runtime.t;
			const list = useSessionList();
			const [query, setQuery] = React.useState("");
			const rows = React.useMemo(() => {
				const all = rowsOf(list);
				const needle = query.trim().toLowerCase();
				const filtered = needle === "" ? all : all.filter((row) => titleOf(row, row.sessionId).toLowerCase().includes(needle) || String(row.cwd || "").toLowerCase().includes(needle));
				return filtered.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
			}, [list, query]);

			if (!list) return h("div", { className: "dsv-empty" }, t("loading"));

			return h(
				"div",
				{ className: "dsv-picker" },
				h("input", {
					className: "dsv-picker__search",
					type: "search",
					value: query,
					placeholder: t("pickerSearch"),
					onChange: (event) => setQuery(event.target.value),
				}),
				rows.length === 0
					? h("div", { className: "dsv-empty" }, t("emptyPickerHint"))
					: h(
							"div",
							{ className: "dsv-picker__list" },
							rows.map((row) =>
								h(
									"button",
									{ key: row.sessionId, type: "button", className: "dsv-picker__row", onClick: () => onPick(row.sessionId), title: titleOf(row, row.sessionId) },
									h("span", { className: "dsv-picker__title" }, (row.running ? "● " : "") + titleOf(row, row.sessionId)),
									h("span", { className: "dsv-picker__meta" }, String(row.cwd || row.sessionId)),
								),
							),
						),
			);
		}
		//#endregion

		//#region resizer
		function Resizer(props) {
			const { index, orientation, stackRef } = props;
			const dragRef = React.useRef(null);
			const frameRef = React.useRef(0);

			const applyDelta = (pixels) => {
				const drag = dragRef.current;
				if (!drag) return;
				const box = stackRef.current ? stackRef.current.getBoundingClientRect() : null;
				const extent = box ? (orientation === "row" ? box.width : box.height) : 0;
				if (!(extent > 0)) return;
				const fraction = pixels / extent;
				const a0 = drag.base[index];
				const b0 = drag.base[index + 1];
				const pair = a0 + b0;
				const min = Math.min(MIN_FRACTION, pair / 2);
				const a = Math.min(Math.max(a0 + fraction, min), pair - min);
				const next = drag.base.slice();
				next[index] = a;
				next[index + 1] = pair - a;
				store.actions.setSizes(next);
			};

			const onPointerDown = (event) => {
				if (event.button !== undefined && event.button !== 0) return;
				event.preventDefault();
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch (error) {
					/* capture unsupported */
				}
				const snapshot = store.getSnapshot();
				dragRef.current = {
					base: snapshot.sizes.slice(),
					pos: orientation === "row" ? event.clientX : event.clientY,
				};
			};

			const onPointerMove = (event) => {
				const drag = dragRef.current;
				if (!drag) return;
				const pos = orientation === "row" ? event.clientX : event.clientY;
				const delta = pos - drag.pos;
				if (frameRef.current !== 0) return;
				frameRef.current = requestAnimationFrame(() => {
					frameRef.current = 0;
					applyDelta(delta);
				});
			};

			const finish = () => {
				dragRef.current = null;
				if (frameRef.current !== 0) {
					cancelAnimationFrame(frameRef.current);
					frameRef.current = 0;
				}
			};

			return h("div", {
				className: "dsv-resizer",
				role: "separator",
				"aria-orientation": orientation === "row" ? "vertical" : "horizontal",
				onPointerDown,
				onPointerMove,
				onPointerUp: finish,
				onPointerCancel: finish,
				onLostPointerCapture: finish,
			});
		}
		//#endregion

		//#region main panel
		function SplitViewRoot(props) {
			const { renderSlot, SessionProvider } = props;
			const t = runtime.t;
			const snap = useLayout();
			const list = useSessionList();
			const stackRef = React.useRef(null);
			const dragTabRef = React.useRef(null);
			// The drop target lives in a ref, not in state: dragstart/dragover/drop can
			// land in the same React tick, and reading state there would see the value
			// from before the dragover that just computed it.
			const dropTargetRef = React.useRef(null);
			const setDropTarget = React.useCallback((next) => {
				dropTargetRef.current = next;
			}, []);

			const sessionIds = React.useMemo(() => {
				const ids = [];
				const seen = new Set();
				for (const group of snap.groups) {
					for (const tab of group.tabs) {
						if (tab.sessionId && !seen.has(tab.sessionId)) {
							seen.add(tab.sessionId);
							ids.push(tab.sessionId);
						}
					}
				}
				return ids;
			}, [snap.groups]);
			const held = useHeldReferences(sessionIds);

			const rowOf = (sessionId) => (list && list.byId ? list.byId[sessionId] : undefined);

			const brokenIds = React.useMemo(() => {
				const set = new Set();
				for (const [id, entry] of held) if (entry.kind === "failed") set.add(id);
				return set;
			}, [held]);

			const renderTabStrip = (group) => {
				const canAdd = true;
				const barDrop = (event) => {
					// Dropping on the empty part of the strip appends to the end.
					if (!dragTabRef.current) return;
					event.preventDefault();
					event.stopPropagation();
					setDropTarget({ groupId: group.id, index: group.tabs.length });
				};
				const barDropCommit = (event) => {
					event.preventDefault();
					event.stopPropagation();
					const drag = dragTabRef.current;
					dragTabRef.current = null;
					const target = dropTargetRef.current;
					setDropTarget(null);
					if (!drag) return;
					const index = target && target.groupId === group.id ? target.index : group.tabs.length;
					store.actions.moveTab(drag.tabId, drag.groupId, group.id, index);
				};
				return h(
					"div",
					{
						className: "dsv-tabbar",
						role: "tablist",
						onDragOver: barDrop,
						onDrop: barDropCommit,
						onDragLeave: (event) => {
							if (event.currentTarget.contains(event.relatedTarget)) return;
							setDropTarget(null);
						},
					},
					group.tabs.map((tab, tabIndex) =>
						h(
							"div",
							{
								key: tab.id,
								role: "tab",
								tabIndex: 0,
								"aria-selected": group.activeTabId === tab.id,
								className: "dsv-tab" + (group.activeTabId === tab.id ? " dsv-tab--active" : "") + (tab.sessionId && brokenIds.has(tab.sessionId) ? " dsv-tab--broken" : ""),
								title: tab.sessionId ? titleOf(rowOf(tab.sessionId), tab.sessionId) : t("addTab"),
								draggable: true,
								onClick: () => store.actions.setActiveTab(group.id, tab.id),
								onKeyDown: (event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										store.actions.setActiveTab(group.id, tab.id);
									}
								},
								onDragStart: (event) => {
									dragTabRef.current = { tabId: tab.id, groupId: group.id };
									try {
										event.dataTransfer.effectAllowed = "move";
										event.dataTransfer.setData("text/plain", tab.id);
									} catch (error) {
										/* ignore */
									}
								},
								onDragEnd: () => {
									dragTabRef.current = null;
									setDropTarget(null);
								},
								onDragOver: (event) => {
									if (!dragTabRef.current) return;
									event.preventDefault();
									event.stopPropagation();
									const box = event.currentTarget.getBoundingClientRect();
									const after = event.clientX > box.left + box.width / 2;
									setDropTarget({ groupId: group.id, index: tabIndex + (after ? 1 : 0) });
								},
								onDrop: (event) => {
									event.preventDefault();
									event.stopPropagation();
									const drag = dragTabRef.current;
									dragTabRef.current = null;
									const target = dropTargetRef.current;
									setDropTarget(null);
									if (!drag) return;
									const fallbackIndex = group.tabs.findIndex((item) => item.id === tab.id) + 1;
									const index = target && target.groupId === group.id ? target.index : fallbackIndex;
									store.actions.moveTab(drag.tabId, drag.groupId, group.id, index);
								},
							},
							h("span", { className: "dsv-tab__label" }, tab.sessionId ? titleOf(rowOf(tab.sessionId), tab.sessionId) : t("addTab")),
							h(
								"button",
								{
									type: "button",
									className: "dsv-tab__close",
									title: t("closeTab"),
									onClick: (event) => {
										event.stopPropagation();
										store.actions.closeTab(group.id, tab.id);
									},
								},
								"✕",
							),
						),
					),
					h(
						"button",
						{
							type: "button",
							className: "dsv-tabbar__add",
							title: t("addTab"),
							disabled: !canAdd,
							onClick: () => store.actions.addTab(group.id),
						},
						"＋",
					),
				);
			};

			const renderBody = (group) => {
				const tab = group.tabs.find((item) => item.id === group.activeTabId) || group.tabs[0];
				if (!tab) return h("div", { className: "dsv-empty" }, t("emptyPickerHint"));
				if (!tab.sessionId) {
					return h(SessionPicker, {
						onPick: (sessionId) => {
							if (typeof sessionId !== "string" || sessionId === "") return;
							store.actions.setSession(group.id, tab.id, sessionId);
						},
					});
				}
				const status = held.get(tab.sessionId);
				return h(
					SessionHost,
					{
						status: status || { kind: "missing" },
						SessionProvider,
						onRemove: () => store.actions.closeTab(group.id, tab.id),
					},
					renderSlot("splitview.pane", { groupId: group.id, tabId: tab.id }, { only: "body" }),
				);
			};

			const nodes = [];
			snap.groups.forEach((group, index) => {
				const isActive = group.id === snap.activeGroupId;
				nodes.push(
					h(
						"div",
						{
							key: group.id,
							className: "dsv-group" + (isActive ? " dsv-group--active" : "") + "",
							"data-dsv-group": group.id,
							style: { flexGrow: snap.sizes[index] ?? 1 / snap.groups.length, flexShrink: 1, flexBasis: 0 },
							onMouseDownCapture: () => store.actions.setActiveGroup(group.id),
							onFocusCapture: () => store.actions.setActiveGroup(group.id),
						},
						renderTabStrip(group),
						h("div", { className: "dsv-body" }, renderBody(group)),
					),
				);
				if (index < snap.groups.length - 1) {
					nodes.push(h(Resizer, { key: "resize-" + group.id, index, orientation: snap.orientation, stackRef }));
				}
			});

			const canSplit = snap.groups.length < MAX_GROUPS;
			const activeGroup = snap.groups.find((group) => group.id === snap.activeGroupId) || snap.groups[0];

			return h(
				"div",
				{ className: "dsv-root", "data-orientation": snap.orientation, "data-panel": PANEL_ID },
				h("div", { className: "dsv-stack", ref: stackRef }, nodes),
				h(
					"div",
					{ className: "dsv-toolbar" },
					h("button", { type: "button", className: "dsv-tool", title: canSplit ? t("splitTitle") : t("maxGroups"), disabled: !canSplit, onClick: () => store.actions.split() }, h(IconSplit)),
					h("button", {
						type: "button",
						className: "dsv-tool",
						title: t("orientation"),
						onClick: () => store.actions.setOrientation(snap.orientation === "row" ? "col" : "row"),
					}, h(IconOrientation)),
					h(
						"button",
						{
							type: "button",
							className: "dsv-tool",
							title: t("closeGroup"),
							disabled: snap.groups.length < 2 || !activeGroup,
							onClick: () => activeGroup && store.actions.closeGroup(activeGroup.id),
						},
						h(IconClose),
					),
				),
			);
		}
		//#endregion

		//#region conversation header entry
		function OpenInSplitButton(props) {
			const t = runtime.t;
			const list = useSessionList();
			const explicit = typeof props.sessionId === "string" ? props.sessionId : undefined;
			const current = explicit || (list && list.byId ? (Object.values(list.byId).find((row) => row && row.retainedBy && (row.retainedBy.mainView ?? 0) > 0) || {}).id : undefined);
			const onClick = () => {
				if (!current) return;
				store.actions.openInSplit(current);
				const ctx = runtime.ctx;
				if (ctx && ctx.layout && typeof ctx.layout.selectPanel === "function") {
					try {
						ctx.layout.selectPanel(PANEL_ID);
					} catch (error) {
						console.error("[dsh-splitview] selectPanel failed", error);
					}
				}
			};
			return h(
				"button",
				{
					type: "button",
					className: "dsv-hbtn",
					title: t("openInSplit"),
					"aria-label": t("openInSplit"),
					disabled: !current,
					onClick,
				},
				h(IconOpenSplit),
			);
		}
		//#endregion

		//#region locale
		const MESSAGES = {
			zh: {
				panel: "分屏视图",
				split: "拆分",
				splitTitle: "拆分当前分组（右侧新增一个空分组）",
				splitDown: "向下拆分",
				orientation: "切换排列方向（横向 / 纵向）",
				closeGroup: "关闭当前分组",
				closeTab: "关闭标签",
				addTab: "新建标签",
				pickerSearch: "搜索标题或工作目录",
				emptyPickerHint: "还没有会话。在左侧栏新建或打开一个会话后，它会出现在这里。",
				loading: "正在打开会话…",
				failedSession: "该会话已不可用",
				removeTab: "移除标签",
				openInSplit: "在分屏中打开",
				maxGroups: "最多只能拆成 3 个分组",
				noFocus: "先让页面获得焦点",
				conversationUnavailable: "对话视图暂时不可用",
				cmdSplitRight: "分屏：向右拆分",
				cmdSplitDown: "分屏：向下拆分",
				cmdCloseTab: "分屏：关闭当前标签",
				cmdNextGroup: "分屏：下一个分组",
				cmdPrevGroup: "分屏：上一个分组",
			},
			en: {
				panel: "Split View",
				split: "Split",
				splitTitle: "Split the active group (adds an empty group to the right)",
				splitDown: "Split down",
				orientation: "Toggle orientation (horizontal / vertical)",
				closeGroup: "Close the active group",
				closeTab: "Close tab",
				addTab: "New tab",
				pickerSearch: "Search title or working directory",
				emptyPickerHint: "No sessions yet. Create or open a session in the sidebar and it shows up here.",
				loading: "Opening session…",
				failedSession: "This session is no longer available",
				removeTab: "Remove tab",
				openInSplit: "Open in Split View",
				maxGroups: "At most 3 groups",
				noFocus: "Focus the page first",
				conversationUnavailable: "The conversation view is unavailable",
				cmdSplitRight: "Split View: split right",
				cmdSplitDown: "Split View: split down",
				cmdCloseTab: "Split View: close active tab",
				cmdNextGroup: "Split View: next group",
				cmdPrevGroup: "Split View: previous group",
			},
		};
		//#endregion

		//#region shortcuts
		/**
		 * Build the per-profile defaults for one chord.
		 *
		 * `web:linux` is deliberately absent: the shortcut registry validates every
		 * declared default against the browser reservation table, and that profile only
		 * admits three fixed chords (Primary+Slash, Primary+Shift+Comma, Primary+Shift+Period).
		 * Declaring our chord there makes register() throw "Unsupported Web shortcut".
		 * Omitting the profile leaves the command unbound on Linux browsers only.
		 */
		function defaultsFor(code, modifiers) {
			const binding = { code, modifiers };
			return {
				"desktop:macos": binding,
				"desktop:windows": binding,
				"desktop:linux": binding,
				"web:macos": binding,
				"web:windows": binding,
			};
		}

		function activateSplitPanel() {
			const ctx = runtime.ctx;
			if (!ctx || !ctx.layout || typeof ctx.layout.selectPanel !== "function") return;
			try {
				ctx.layout.selectPanel(PANEL_ID);
			} catch (error) {
				console.error("[dsh-splitview] selectPanel failed", error);
			}
		}
		//#endregion

		//#region apply
		const inject = ["slots", "sessions", "locale", "layout", "shortcuts"];

		function apply(ctx) {
			runtime.ctx = ctx;
			runtime.sessions = ctx.sessions;

			ctx.effect(() => ctx.locale.register(NS, MESSAGES), "dsh-splitview: messages");
			runtime.t = ctx.locale.bind(NS);

			ctx.effect(() => {
				const disposers = [];
				const register = (id, labelKey, aliases, defaults, run) => {
					if (!ctx.shortcuts || typeof ctx.shortcuts.register !== "function") return;
					try {
						disposers.push(
							ctx.shortcuts.register({
								id,
								label: () => runtime.t(labelKey),
								// `aliases` is required in practice: ShortcutRegistry#refreshLabels copies
								// command.aliases into the catalog row and the shortcuts palette spreads it
								// (`...row.aliases`), so leaving it out crashes that slot with
								// "row.aliases is not iterable".
								aliases: aliases,
								defaults,
								regions: ["page", "editable", "terminal"],
								modals: [],
								resolve: ({ target }) => (target === undefined ? { status: "blocked", reason: runtime.t("noFocus") } : { status: "handled", run }),
							}),
						);
					} catch (error) {
						console.error("[dsh-splitview] shortcut registration failed:", id, error);
					}
				};

				register("splitview.split.right", "cmdSplitRight", ["split", "split right", "split view"], defaultsFor("Backslash", ["primary", "shift"]), () => {
					activateSplitPanel();
					store.actions.split();
				});
				register("splitview.split.down", "cmdSplitDown", ["split down", "split below"], defaultsFor("Backslash", ["primary", "shift", "alt"]), () => {
					activateSplitPanel();
					store.actions.setOrientation("col");
					store.actions.split();
				});
				register("splitview.close.tab", "cmdCloseTab", ["close tab", "close split tab"], defaultsFor("KeyW", ["primary", "shift"]), () => {
					const snap = store.getSnapshot();
					const group = snap.groups.find((g) => g.id === snap.activeGroupId) || snap.groups[0];
					if (!group) return;
					const tab = group.tabs.find((item) => item.id === group.activeTabId) || group.tabs[0];
					if (tab) store.actions.closeTab(group.id, tab.id);
				});
				register("splitview.next.group", "cmdNextGroup", ["next group", "next split"], defaultsFor("BracketRight", ["primary", "shift"]), () => {
					const snap = store.getSnapshot();
					const index = snap.groups.findIndex((g) => g.id === snap.activeGroupId);
					const next = snap.groups[(index + 1) % snap.groups.length];
					if (next) store.actions.setActiveGroup(next.id);
				});
				register("splitview.prev.group", "cmdPrevGroup", ["previous group", "previous split"], defaultsFor("BracketLeft", ["primary", "shift"]), () => {
					const snap = store.getSnapshot();
					const index = snap.groups.findIndex((g) => g.id === snap.activeGroupId);
					const prev = snap.groups[(index - 1 + snap.groups.length) % snap.groups.length];
					if (prev) store.actions.setActiveGroup(prev.id);
				});

				return () => {
					for (const dispose of disposers) {
						try {
							if (typeof dispose === "function") dispose();
						} catch (error) {
							/* ignore */
						}
					}
				};
			}, "dsh-splitview: shortcuts");

			ctx.effect(
				() =>
					ctx.slots.inject("main", () =>
						ctx.slots.register(
							{
								name: "main",
								key: PANEL_ID,
								locale: NS,
								children: { "splitview.pane": { kind: "list", scope: "session" } },
							},
							SplitViewRoot,
						),
					),
				"dsh-splitview: main panel",
			);

			ctx.effect(
				() =>
					ctx.slots.inject("splitview.pane", () =>
						ctx.slots.register({ name: "splitview.pane", id: "body", locale: NS }, PaneBody),
					),
				"dsh-splitview: pane body",
			);

			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.panellist", () =>
						ctx.slots.register(
							{
								name: "sidebar.panellist",
								id: PANEL_ID,
								order: 30,
								locale: NS,
								label: () => runtime.t("panel"),
							},
							SplitviewIcon,
						),
					),
				"dsh-splitview: sidebar entry",
			);

			ctx.effect(
				() =>
					ctx.slots.inject("conversation.session.header.utilities", () =>
						ctx.slots.register(
							{
								name: "conversation.session.header.utilities",
								id: "splitview.open",
								order: 40,
								locale: NS,
								label: () => runtime.t("openInSplit"),
							},
							OpenInSplitButton,
						),
					),
				"dsh-splitview: header button",
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
