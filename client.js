/**
 * dsh-splitview — VSCode-style editor groups for the DSH Web UI.
 *
 * The browser half is a single plain-JS bundle: no JSX, no build step.
 *
 * How it plugs into the host
 * --------------------------
 * The split view is not a separate panel. It takes over the shipped
 * `main.conversation` slot at `priority: -1`: the slot dispatcher sorts entries
 * by priority ascending and renders the lowest, so our entry shadows the
 * shipped conversation shell, and the shipped entry stays registered
 * underneath. Unregistering hands the panel straight back — no reload — which
 * is what the settings toggle and the "last pane closed" path use.
 *
 * The takeover is only installed while there are actually two or more panes,
 * so a user who never splits keeps the stock conversation panel, header,
 * view tabs and all.
 *
 * What a pane is
 * --------------
 * Every pane renders the shipped `conversation.content` factory through
 * `renderFactorySlot`, wrapped in the renderer's own `SessionProvider` bound to
 * that pane's live `SessionReference`. Nothing about the conversation itself is
 * re-implemented: message flow, composer, tool cards, approval prompts are all
 * the shipped components.
 *
 * Layout model
 * ------------
 * Groups live in a tree, not in a flat list with one global orientation: a flat
 * list can only express "N panes side by side", while the tree expresses "two
 * columns, the right one split horizontally".
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
		const STORAGE_KEY = "dsh-splitview:layout:v3";
		/** Retention source. Deliberately NOT "mainView": mainView decides which
		 * session the rest of the app calls "current", and that stays owned by the
		 * workspace controller. */
		const SOURCE = "splitview";
		const MIN_FRACTION = 0.12;
		const WIDTH_PREF_KEY = "dsh.conversation.contentWidth";
		const CONTENT_MIN = 640;
		const CONTENT_EDGE_BUDGET = 176;
		/** Edge band of a pane that means "split beside", as a fraction of the size. */
		const EDGE_BAND = 0.26;
		/** Drag type our own tab drags carry, so the global drop veil ignores them. */
		const TAB_DRAG_TYPE = "application/x-dsv-tab";
		//#endregion

		//#region styles
		const CSS = `
.dsv-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;background:var(--dsw-alias-bg-base)}
.dsv-node{flex:1 1 auto;min-width:0;min-height:0;display:flex}
.dsv-node[data-orientation="row"]{flex-direction:row}
.dsv-node[data-orientation="col"]{flex-direction:column}
.dsv-group{position:relative;display:flex;flex-direction:column;flex-grow:1;flex-shrink:1;flex-basis:0;min-width:0;min-height:0;outline:1px solid transparent;outline-offset:-1px;transition:outline-color var(--ds-transition-duration-slow) var(--ds-ease-in-out)}
.dsv-group--active{outline-color:var(--dsw-alias-border-l3)}
.dsv-group--drop{outline-color:var(--dsw-alias-brand-primary,#247bbf);outline-width:2px}
.dsv-tabbar{display:flex;align-items:stretch;gap:2px;flex:0 0 30px;height:30px;padding:0 2px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;border-bottom:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}
.dsv-tabbar::-webkit-scrollbar{display:none}
.dsv-tab{position:relative;display:inline-flex;align-items:center;gap:6px;max-width:220px;min-width:0;margin:3px 0;padding:0 6px 0 9px;font-size:12px;line-height:1;color:var(--dsw-alias-fg-secondary);background:transparent;border:0;border-radius:5px;cursor:pointer;white-space:nowrap;user-select:none}
.dsv-tab:hover{background:var(--dsw-alias-bg-l2)}
.dsv-tab--active{background:var(--dsw-alias-bg-l2);color:inherit;box-shadow:inset 0 -2px 0 0 currentColor}
.dsv-tab--broken .dsv-tab__label{text-decoration:line-through;opacity:.55}
.dsv-tab__label{overflow:hidden;text-overflow:ellipsis}
.dsv-tab__close{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:16px;height:16px;border:0;border-radius:4px;background:transparent;color:inherit;opacity:.55;cursor:pointer;font-size:11px;line-height:1;padding:0}
.dsv-tab__close:hover{opacity:1;background:var(--dsw-alias-bg-l3,#00000014)}
.dsv-ins{position:absolute;top:2px;bottom:2px;width:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,#247bbf);pointer-events:none}
.dsv-tabbar__add{flex:0 0 auto;width:22px;margin:3px 0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-fg-secondary);cursor:pointer;font-size:14px;line-height:1;padding:0}
.dsv-tabbar__add:hover{background:var(--dsw-alias-bg-l2)}
.dsv-tabbar__menu{flex:0 0 auto;width:22px;margin:3px 0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-fg-secondary);cursor:pointer;font-size:13px;line-height:1;padding:0}
.dsv-tabbar__menu:hover{background:var(--dsw-alias-bg-l2)}
.dsv-body{flex:1 1 auto;min-width:0;min-height:0;display:flex;overflow:hidden}
.dsv-body>*{flex:1 1 0;min-width:0;min-height:0}
.dsv-resizer{flex:0 0 6px;position:relative;background:transparent;touch-action:none}
.dsv-resizer::after{content:"";position:absolute;background:var(--dsw-alias-border-l3);opacity:.55}
.dsv-node[data-orientation="row"]>.dsv-resizer{cursor:col-resize}
.dsv-node[data-orientation="row"]>.dsv-resizer::after{top:0;bottom:0;left:50%;width:1px}
.dsv-node[data-orientation="col"]>.dsv-resizer{cursor:row-resize}
.dsv-node[data-orientation="col"]>.dsv-resizer::after{left:0;right:0;top:50%;height:1px}
.dsv-resizer:hover::after,.dsv-resizer:active::after{opacity:1}
.dsv-drop{position:absolute;z-index:2;pointer-events:none;background:var(--dsw-alias-brand-primary,#247bbf);opacity:.16;border-radius:6px}
.dsv-drop[data-zone="left"]{left:0;top:0;bottom:0;width:50%}
.dsv-drop[data-zone="right"]{right:0;top:0;bottom:0;width:50%}
.dsv-drop[data-zone="top"]{left:0;right:0;top:0;height:50%}
.dsv-drop[data-zone="bottom"]{left:0;right:0;bottom:0;height:50%}
.dsv-drop[data-zone="center"]{left:0;right:0;top:0;bottom:0;opacity:.08}
/* Painted on the conversation region itself while a session is dragged over
   it: no overlay component has to be mounted for the hint to appear. */
[data-dsv-drop]{position:relative;outline:2px dashed var(--dsw-alias-brand-primary,#247bbf);outline-offset:-2px}
[data-dsv-drop]::after{content:"";position:absolute;z-index:3;pointer-events:none;background:var(--dsw-alias-brand-primary,#247bbf);opacity:.14;border-radius:6px}
[data-dsv-drop="left"]::after{left:0;top:0;bottom:0;width:50%}
[data-dsv-drop="right"]::after{right:0;top:0;bottom:0;width:50%}
[data-dsv-drop="top"]::after{left:0;right:0;top:0;height:50%}
[data-dsv-drop="bottom"]::after{left:0;right:0;bottom:0;height:50%}
[data-dsv-drop="center"]::after{left:0;right:0;top:0;bottom:0;opacity:.07}
.dsv-ctx{position:fixed;z-index:1200;min-width:190px;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);box-shadow:0 6px 24px #0000002e}
.dsv-ctx__item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 9px;border:0;border-radius:5px;background:transparent;color:inherit;font-size:12px;line-height:1.4;text-align:left;cursor:pointer}
.dsv-ctx__item:hover{background:var(--dsw-alias-bg-l2)}
.dsv-ctx__item[disabled]{opacity:.4;cursor:default}
.dsv-ctx__sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l3)}
.dsv-picker{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px;padding:12px}
.dsv-picker__search{flex:0 0 auto;height:30px;padding:0 9px;font-size:12px;color:inherit;background:var(--dsw-alias-bg-l2);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;outline:0}
.dsv-picker__search:focus{border-color:var(--dsw-alias-brand-primary,#247bbf)}
.dsv-picker__list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.dsv-picker__row{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;cursor:pointer}
.dsv-picker__row:hover{background:var(--dsw-alias-bg-l2)}
.dsv-picker__title{font-size:12px;line-height:1.35;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsv-picker__meta{font-size:11px;line-height:1.3;color:var(--dsw-alias-fg-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsv-empty{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px;font-size:12px;color:var(--dsw-alias-fg-secondary);text-align:center}
.dsv-empty--error{color:var(--dsw-alias-fg-danger,#c0392b)}
.dsv-empty__actions{display:flex;gap:6px}
.dsv-spin{width:16px;height:16px;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-fg-secondary);border-radius:50%;animation:dsv-spin .8s linear infinite}
@keyframes dsv-spin{to{transform:rotate(360deg)}}
.dsv-linkbtn{border:0;background:transparent;color:var(--dsw-alias-brand-primary,#247bbf);font-size:12px;cursor:pointer;padding:2px 4px}
.dsv-hbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;padding:0}
.dsv-hbtn:hover{background:var(--dsw-alias-bg-l2)}
.dsv-hbtn[disabled]{opacity:.35;cursor:default}
/* The shipped formula measures the gutter between content and pane edge and
   collapses to a negative width once a pane is narrower than the content cap,
   which is exactly what happens after a split. Clamping the inset keeps the
   handle reachable: it rides the pane edge instead of vanishing. */
.dsv-width{position:absolute;top:0;bottom:0;z-index:1;width:10px;cursor:col-resize}
.dsv-width[data-side="left"]{right:max(12px, calc((100% - var(--dsh-chat-content-width, min(calc(100% - 32px), 920px))) / 2 - 34px))}
.dsv-width[data-side="right"]{left:max(12px, calc((100% - var(--dsh-chat-content-width, min(calc(100% - 32px), 920px))) / 2 - 34px))}
.dsv-width::after{content:"";position:absolute;top:0;bottom:0;width:2px;border-radius:2px;background:var(--dsw-alias-scrollbar-bg-l1,var(--dsw-alias-border-l3));opacity:0;pointer-events:none}
.dsv-width[data-side="left"]::after{right:4px}
.dsv-width[data-side="right"]::after{left:4px}
.dsv-width:hover::after,.dsv-width[data-dragging]::after{opacity:1}
.dsv-set{display:flex;flex-direction:column;gap:14px;padding:16px 0;max-width:640px}
.dsv-set__row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.dsv-set__text{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsv-set__title{font-size:13px;line-height:1.4}
.dsv-set__desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-fg-secondary)}
.dsv-set__ctl{flex:0 0 auto;display:flex;align-items:center;gap:6px}
.dsv-set select,.dsv-set button.dsv-set__btn{height:28px;padding:0 8px;font-size:12px;color:inherit;background:var(--dsw-alias-bg-l2);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;cursor:pointer}
.dsv-set kbd{font-family:inherit;font-size:11px;padding:1px 5px;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;background:var(--dsw-alias-bg-l2)}
.dsv-set__keys{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.6;color:var(--dsw-alias-fg-secondary)}
.dsv-set__keys div{display:flex;gap:8px;align-items:center}
.dsv-set__hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-fg-secondary);padding-top:4px;border-top:1px solid var(--dsw-alias-border-l3)}
`;
		let stylesInstalled = false;
		function installStyles() {
			if (stylesInstalled) return;
			stylesInstalled = true;
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="dsh-splitview/client.js"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-splitview";
			tag.dataset.pluginCss = "dsh-splitview/client.js";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
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
			for (let pass = 0; pass < 3; pass += 1) {
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

		function makeGroup(sessionId) {
			const tab = { id: uid("tab"), sessionId: sessionId == null ? null : sessionId };
			return { type: "group", id: uid("pane"), activeTabId: tab.id, tabs: [tab] };
		}

		function makeSplit(orientation, children, sizes) {
			return {
				type: "split",
				id: uid("split"),
				orientation: orientation === "col" ? "col" : "row",
				children,
				sizes: clampSizes(sizes, children.length),
			};
		}

		function defaultState() {
			const group = makeGroup(null);
			return { version: 3, root: group, activeGroupId: group.id, maxPanes: 4, enabled: true };
		}

		/** Depth-first list of every group in the tree. */
		function listGroups(node, out) {
			const acc = out || [];
			if (!node) return acc;
			if (node.type === "group") {
				acc.push(node);
				return acc;
			}
			for (const child of node.children) listGroups(child, acc);
			return acc;
		}

		function findGroup(node, groupId) {
			if (!node) return undefined;
			if (node.type === "group") return node.id === groupId ? node : undefined;
			for (const child of node.children) {
				const found = findGroup(child, groupId);
				if (found) return found;
			}
			return undefined;
		}

		function countGroups(node) {
			return listGroups(node).length;
		}

		/** Rebuild the tree with `groupId`'s subtree replaced by `fn(group)`. */
		function updateGroup(node, groupId, fn) {
			if (!node) return node;
			if (node.type === "group") {
				if (node.id !== groupId) return node;
				return fn(node);
			}
			let changed = false;
			const children = node.children.map((child) => {
				const next = updateGroup(child, groupId, fn);
				if (next !== child) changed = true;
				return next;
			});
			if (!changed) return node;
			return { ...node, children };
		}

		/** Remove a group; collapse a split that is left with a single child. */
		function removeGroup(node, groupId) {
			if (!node) return null;
			if (node.type === "group") return node.id === groupId ? null : node;
			const children = [];
			const sizes = [];
			let changed = false;
			node.children.forEach((child, index) => {
				const next = removeGroup(child, groupId);
				if (next !== child) changed = true;
				if (next) {
					children.push(next);
					sizes.push(node.sizes[index] ?? 1 / node.children.length);
				}
			});
			if (!changed) return node;
			if (children.length === 0) return null;
			if (children.length === 1) return children[0];
			return { ...node, children, sizes: clampSizes(sizes, children.length) };
		}

		/**
		 * Insert `group` next to `groupId`.
		 * A same-orientation split absorbs the new group as a sibling instead of
		 * nesting, so a row split inside a row split stays one row.
		 */
		function insertGroup(node, groupId, group, orientation, position) {
			if (!node) return node;
			if (node.type === "group") {
				// The root (or a lone group) has no split parent to absorb the new
				// pane, so the first split wraps it in one.
				if (node.id !== groupId) return node;
				const pair = position === "before" ? [group, node] : [node, group];
				return makeSplit(orientation, pair, [0.5, 0.5]);
			}
			const direct = node.children.some((child) => child.type === "group" && child.id === groupId);
			if (direct && node.orientation === orientation) {
				const index = node.children.findIndex((child) => child.type === "group" && child.id === groupId);
				const children = node.children.slice();
				const sizes = node.sizes.slice();
				const at = position === "before" ? index : index + 1;
				children.splice(at, 0, group);
				const half = (sizes[index] ?? 1 / node.children.length) / 2;
				sizes[index] = half;
				sizes.splice(at, 0, half);
				return { ...node, children, sizes: clampSizes(sizes, children.length) };
			}
			if (direct) {
				const index = node.children.findIndex((child) => child.type === "group" && child.id === groupId);
				const children = node.children.slice();
				const sizes = node.sizes.slice();
				const size = sizes[index] ?? 1 / node.children.length;
				const pair = position === "before" ? [group, node.children[index]] : [node.children[index], group];
				children.splice(index, 1, makeSplit(orientation, pair, [size / 2, size / 2]));
				sizes[index] = size;
				return { ...node, children, sizes };
			}
			let changed = false;
			const children = node.children.map((child) => {
				const next = insertGroup(child, groupId, group, orientation, position);
				if (next !== child) changed = true;
				return next;
			});
			return changed ? { ...node, children } : node;
		}

		function updateSplitSizes(node, splitId, sizes) {
			if (!node) return node;
			if (node.type === "group") return node;
			if (node.id === splitId) return { ...node, sizes: clampSizes(sizes, node.children.length) };
			let changed = false;
			const children = node.children.map((child) => {
				const next = updateSplitSizes(child, splitId, sizes);
				if (next !== child) changed = true;
				return next;
			});
			return changed ? { ...node, children } : node;
		}

		function normalizeNode(raw, seenGroups, seenTabs, budget) {
			if (!raw || typeof raw !== "object") return null;
			if (raw.type === "group") {
				if (budget.left <= 0) return null;
				if (!Array.isArray(raw.tabs)) return null;
				const tabs = [];
				for (const tb of raw.tabs) {
					if (!tb || typeof tb !== "object") continue;
					let id = typeof tb.id === "string" && tb.id ? tb.id : uid("tab");
					if (seenTabs.has(id)) id = uid("tab");
					seenTabs.add(id);
					tabs.push({ id, sessionId: typeof tb.sessionId === "string" && tb.sessionId ? tb.sessionId : null });
				}
				if (tabs.length === 0) return null;
				let id = typeof raw.id === "string" && raw.id ? raw.id : uid("pane");
				if (seenGroups.has(id)) id = uid("pane");
				seenGroups.add(id);
				budget.left -= 1;
				const activeTabId = tabs.some((t) => t.id === raw.activeTabId) ? raw.activeTabId : tabs[0].id;
				return { type: "group", id, activeTabId, tabs };
			}
			if (raw.type !== "split") return null;
			if (!Array.isArray(raw.children)) return null;
			const children = [];
			const sizes = [];
			raw.children.forEach((child, index) => {
				const next = normalizeNode(child, seenGroups, seenTabs, budget);
				if (!next) return;
				children.push(next);
				sizes.push(Array.isArray(raw.sizes) ? Number(raw.sizes[index]) : NaN);
			});
			if (children.length === 0) return null;
			if (children.length === 1) return children[0];
			const id = typeof raw.id === "string" && raw.id ? raw.id : uid("split");
			return {
				type: "split",
				id,
				orientation: raw.orientation === "col" ? "col" : "row",
				children,
				sizes: clampSizes(
					sizes.map((n) => (Number.isFinite(n) && n > 0 ? n : 1 / sizes.length)),
					children.length,
				),
			};
		}

		function normalizeState(raw) {
			const fallback = defaultState();
			if (!raw || typeof raw !== "object" || raw.version !== 3) return fallback;
			const maxPanes = Math.max(2, Math.min(8, Number(raw.maxPanes) || 4));
			const budget = { left: maxPanes };
			const root = normalizeNode(raw.root, new Set(), new Set(), budget);
			if (!root) return fallback;
			const groups = listGroups(root);
			const activeGroupId = groups.some((g) => g.id === raw.activeGroupId) ? raw.activeGroupId : groups[0].id;
			return { version: 3, root, activeGroupId, maxPanes, enabled: raw.enabled !== false };
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

			const withRoot = (root, patch) => {
				const groups = listGroups(root);
				const activeGroupId = groups.some((g) => g.id === state.activeGroupId) ? state.activeGroupId : groups[0].id;
				return { ...state, ...patch, root, activeGroupId };
			};

			const actions = {
				focusGroup(groupId) {
					if (state.activeGroupId === groupId) return;
					if (!findGroup(state.root, groupId)) return;
					set({ ...state, activeGroupId: groupId });
				},
				setActiveTab(groupId, tabId) {
					const group = findGroup(state.root, groupId);
					if (!group || group.activeTabId === tabId) return;
					if (!group.tabs.some((t) => t.id === tabId)) return;
					const root = updateGroup(state.root, groupId, (g) => ({ ...g, activeTabId: tabId }));
					set(withRoot(root, { activeGroupId: groupId }));
				},
				setSession(groupId, tabId, sessionId) {
					if (typeof sessionId !== "string" || sessionId === "") return;
					const group = findGroup(state.root, groupId);
					if (!group || !group.tabs.some((t) => t.id === tabId)) return;
					const root = updateGroup(state.root, groupId, (g) => ({
						...g,
						activeTabId: tabId,
						tabs: g.tabs.map((t) => (t.id === tabId ? { ...t, sessionId } : t)),
					}));
					set(withRoot(root, { activeGroupId: groupId }));
				},
				/** Open `sessionId` in the active group, reusing its tab when it has one. */
				adoptSession(sessionId) {
					if (typeof sessionId !== "string" || sessionId === "") return;
					const groups = listGroups(state.root);
					const home = groups.find((g) => g.tabs.some((t) => t.sessionId === sessionId));
					if (home) {
						const tab = home.tabs.find((t) => t.sessionId === sessionId);
						if (home.activeTabId === tab.id && state.activeGroupId === home.id) return;
						const root = updateGroup(state.root, home.id, (g) => ({ ...g, activeTabId: tab.id }));
						set(withRoot(root, { activeGroupId: home.id }));
						return;
					}
					const active = findGroup(state.root, state.activeGroupId) || groups[0];
					if (!active) return;
					const current = active.tabs.find((t) => t.id === active.activeTabId) || active.tabs[0];
					let root;
					if (current && current.sessionId === null) {
						root = updateGroup(state.root, active.id, (g) => ({
							...g,
							activeTabId: current.id,
							tabs: g.tabs.map((t) => (t.id === current.id ? { ...t, sessionId } : t)),
						}));
					} else {
						const tab = { id: uid("tab"), sessionId };
						root = updateGroup(state.root, active.id, (g) => ({ ...g, tabs: [...g.tabs, tab], activeTabId: tab.id }));
					}
					set(withRoot(root, { activeGroupId: active.id }));
				},
				addTab(groupId) {
					const group = findGroup(state.root, groupId);
					if (!group) return;
					const tab = { id: uid("tab"), sessionId: null };
					const root = updateGroup(state.root, groupId, (g) => ({ ...g, tabs: [...g.tabs, tab], activeTabId: tab.id }));
					set(withRoot(root, { activeGroupId: groupId }));
				},
				closeTab(groupId, tabId) {
					const group = findGroup(state.root, groupId);
					if (!group) return;
					const index = group.tabs.findIndex((t) => t.id === tabId);
					if (index < 0) return;
					const tabs = group.tabs.filter((t) => t.id !== tabId);
					if (tabs.length === 0) {
						if (countGroups(state.root) > 1) {
							const root = removeGroup(state.root, groupId);
							if (root) set(withRoot(root, {}));
							return;
						}
						const fresh = { id: uid("tab"), sessionId: null };
						const root = updateGroup(state.root, groupId, (g) => ({ ...g, tabs: [fresh], activeTabId: fresh.id }));
						set({ ...state, root });
						return;
					}
					const activeTabId = group.activeTabId === tabId ? tabs[Math.max(0, index - 1)].id : group.activeTabId;
					const root = updateGroup(state.root, groupId, (g) => ({ ...g, tabs, activeTabId }));
					set({ ...state, root });
				},
				closeOtherTabs(groupId, tabId) {
					const group = findGroup(state.root, groupId);
					if (!group) return;
					const tab = group.tabs.find((t) => t.id === tabId);
					if (!tab) return;
					const root = updateGroup(state.root, groupId, (g) => ({ ...g, tabs: [tab], activeTabId: tab.id }));
					set({ ...state, root });
				},
				closeTabsToRight(groupId, tabId) {
					const group = findGroup(state.root, groupId);
					if (!group) return;
					const index = group.tabs.findIndex((t) => t.id === tabId);
					if (index < 0) return;
					const tabs = group.tabs.slice(0, index + 1);
					const activeTabId = tabs.some((t) => t.id === group.activeTabId) ? group.activeTabId : tabId;
					const root = updateGroup(state.root, groupId, (g) => ({ ...g, tabs, activeTabId }));
					set({ ...state, root });
				},
				closeGroup(groupId) {
					if (countGroups(state.root) <= 1) return false;
					const root = removeGroup(state.root, groupId);
					if (!root) return false;
					set(withRoot(root, {}));
					return true;
				},
				/**
				 * Split `groupId`; returns the new group id, or null when the pane
				 * budget is spent. `sessionId` seeds the new pane's tab.
				 */
				splitGroup(groupId, orientation, position, sessionId) {
					if (countGroups(state.root) >= state.maxPanes) return null;
					const group = findGroup(state.root, groupId);
					if (!group) return null;
					const created = makeGroup(sessionId == null ? null : sessionId);
					const root = insertGroup(state.root, groupId, created, orientation === "col" ? "col" : "row", position === "before" ? "before" : "after");
					set(withRoot(root, { activeGroupId: created.id }));
					return created.id;
				},
				/** Move a tab into another group; an emptied source group is closed. */
				moveTab(tabId, fromGroupId, toGroupId, index) {
					const from = findGroup(state.root, fromGroupId);
					const to = findGroup(state.root, toGroupId);
					if (!from || !to) return;
					const tab = from.tabs.find((t) => t.id === tabId);
					if (!tab) return;
					if (fromGroupId === toGroupId) {
						const tabs = from.tabs.filter((t) => t.id !== tabId);
						const at = Math.max(0, Math.min(index, tabs.length));
						tabs.splice(at, 0, tab);
						const root = updateGroup(state.root, fromGroupId, (g) => ({ ...g, tabs }));
						set({ ...state, root });
						return;
					}
					const fromTabs = from.tabs.filter((t) => t.id !== tabId);
					const toTabs = to.tabs.slice();
					toTabs.splice(Math.max(0, Math.min(index, toTabs.length)), 0, tab);
					let root = updateGroup(state.root, toGroupId, (g) => ({ ...g, tabs: toTabs, activeTabId: tab.id }));
					if (fromTabs.length === 0) {
						root = removeGroup(root, fromGroupId);
						if (!root) return;
					} else {
						const activeTabId = from.activeTabId === tabId ? fromTabs[0].id : from.activeTabId;
						root = updateGroup(root, fromGroupId, (g) => ({ ...g, tabs: fromTabs, activeTabId }));
					}
					set(withRoot(root, { activeGroupId: toGroupId }));
				},
				/** Split a tab out into a new group beside its source. */
				moveTabToNewGroup(tabId, fromGroupId, orientation) {
					if (countGroups(state.root) >= state.maxPanes) return null;
					const from = findGroup(state.root, fromGroupId);
					if (!from) return null;
					const tab = from.tabs.find((t) => t.id === tabId);
					if (!tab) return null;
					const axis = orientation === "col" ? "col" : "row";
					if (from.tabs.length === 1) {
						const created = makeGroup(null);
						const root = insertGroup(state.root, fromGroupId, created, axis, "after");
						set(withRoot(root, { activeGroupId: created.id }));
						return created.id;
					}
					const created = makeGroup(tab.sessionId);
					const fromTabs = from.tabs.filter((t) => t.id !== tabId);
					let root = updateGroup(state.root, fromGroupId, (g) => ({
						...g,
						tabs: fromTabs,
						activeTabId: g.activeTabId === tabId ? fromTabs[0].id : g.activeTabId,
					}));
					root = insertGroup(root, fromGroupId, created, axis, "after");
					set(withRoot(root, { activeGroupId: created.id }));
					return created.id;
				},
				setSizes(splitId, sizes) {
					const root = updateSplitSizes(state.root, splitId, sizes);
					if (root !== state.root) set({ ...state, root });
				},
				setMaxPanes(value) {
					const maxPanes = Math.max(2, Math.min(8, Number(value) || 4));
					if (state.maxPanes === maxPanes) return;
					set({ ...state, maxPanes });
				},
				setEnabled(value) {
					const enabled = value !== false;
					if (state.enabled === enabled) return;
					set({ ...state, enabled });
				},
				reset() {
					const group = makeGroup(null);
					set({ ...state, root: group, activeGroupId: group.id });
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
		const runtime = { ctx: null, sessions: null, uiWorkspace: null, t: null };

		function useLayout() {
			return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
		}

		function currentList() {
			return runtime.sessions ? runtime.sessions.list : null;
		}

		function useSessionList() {
			const list = currentList();
			const subscribe = React.useCallback((listener) => (list && typeof list.subscribe === "function" ? list.subscribe(listener) : () => {}), [list]);
			const getSnapshot = React.useCallback(() => (list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null), [list]);
			return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}

		/**
		 * Root sessions as picker rows.
		 * The projected list rows use DISPLAY field names, not engine ones:
		 * `id` (not `sessionId`), `parentId` (not `parentSessionId`), `displayTitle`.
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
		 * Incremental on purpose: ids that stay keep their reference, because a
		 * release/re-retain cycle would drop the count to zero and retire the
		 * session, forcing it to reopen on every tab switch.
		 *
		 * `revision` exists only for retries: a restored layout is read from
		 * localStorage before the session list arrives, so the first retain can
		 * fail with "unknown session". Failed ids are retried whenever the list
		 * changes rather than staying broken until the next layout edit.
		 */
		function useHeldReferences(ids, revision) {
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
						const previous = map.get(id);
						if (previous && previous.kind === "held") continue;
						if (previous) map.delete(id);
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
			}, [key, revision]);

			React.useEffect(
				() => () => {
					for (const entry of mapRef.current.values()) releaseEntry(entry);
					mapRef.current.clear();
				},
				[],
			);

			return mapRef.current;
		}

		/** The session the rest of the app calls "current". */
		function mainViewSession() {
			const list = currentList();
			if (!list || typeof list.getSnapshot !== "function") return undefined;
			const snapshot = list.getSnapshot();
			if (!snapshot || !snapshot.byId) return undefined;
			const row = Object.values(snapshot.byId).find((candidate) => candidate && candidate.retainedBy && (candidate.retainedBy.mainView || 0) > 0);
			return row ? row.id : undefined;
		}

		/** The group that owns a session, if any. */
		function groupOfSession(sessionId) {
			if (!sessionId) return undefined;
			return listGroups(store.getSnapshot().root).find((group) => group.tabs.some((tab) => tab.sessionId === sessionId));
		}
		//#endregion

		//#region small parts
		function IconSplit() {
			return h(
				"svg",
				{ width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinejoin: "round", "aria-hidden": true },
				h("rect", { x: 1.5, y: 2.5, width: 5.6, height: 11, rx: 1.2 }),
				h("rect", { x: 9, y: 2.5, width: 5.5, height: 11, rx: 1.2 }),
			);
		}
		//#endregion

		//#region width controls
		/*
		 * The shipped width controls live inside the conversation package and are
		 * not exported, but the `conversation.content` factory exposes a
		 * `widthControls` seat for exactly this purpose. Re-implementing the
		 * behaviour keeps `--dsh-chat-content-width` alive for the pane we own;
		 * without it the content column silently falls back to its narrow default.
		 */
		function readWidthPreference() {
			try {
				const raw = localStorage.getItem(WIDTH_PREF_KEY);
				if (raw === null) return null;
				const value = Number(raw);
				return Number.isFinite(value) && value > 0 ? value : null;
			} catch (error) {
				return null;
			}
		}

		function resolveContentWidth(columnWidth, preference) {
			const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET);
			if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max);
			return Math.max(680, Math.min(columnWidth * 0.64, 920));
		}

		function WidthHandle(props) {
			const { side, onStart, onDrag, onCommit, onEnd } = props;
			const dragging = React.useRef(false);
			const origin = React.useRef(0);
			const latest = React.useRef(0);
			const startWidth = React.useRef(680);
			const frame = React.useRef(0);
			const callbacks = React.useRef({ onStart, onDrag, onCommit, onEnd });
			callbacks.current = { onStart, onDrag, onCommit, onEnd };

			// Dragging a handle inward widens the content column, and the two
			// handles are symmetric, hence the factor of two.
			const outward = () => {
				const delta = latest.current - origin.current;
				return side === "left" ? startWidth.current - delta * 2 : startWidth.current + delta * 2;
			};

			const cancelFrame = () => {
				if (frame.current !== 0) {
					cancelAnimationFrame(frame.current);
					frame.current = 0;
				}
			};

			const onPointerDown = React.useCallback((event) => {
				event.preventDefault();
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch (error) {
					/* capture unsupported */
				}
				origin.current = event.clientX;
				latest.current = event.clientX;
				startWidth.current = callbacks.current.onStart();
				dragging.current = true;
				event.currentTarget.setAttribute("data-dragging", "");
			}, []);

			const onPointerMove = React.useCallback((event) => {
				if (!dragging.current) return;
				latest.current = event.clientX;
				if (frame.current !== 0) return;
				frame.current = requestAnimationFrame(() => {
					frame.current = 0;
					callbacks.current.onDrag(outward());
				});
			}, []);

			const onPointerUp = React.useCallback((event) => {
				if (!dragging.current) return;
				dragging.current = false;
				event.currentTarget.removeAttribute("data-dragging");
				cancelFrame();
				latest.current = event.clientX;
				if (latest.current !== origin.current) callbacks.current.onCommit(outward());
				callbacks.current.onEnd();
			}, []);

			const onPointerCancel = React.useCallback(() => {
				if (!dragging.current) return;
				dragging.current = false;
				cancelFrame();
				callbacks.current.onEnd();
			}, []);

			return h("div", {
				className: "dsv-width",
				"data-side": side,
				onPointerDown,
				onPointerMove,
				onPointerUp,
				onPointerCancel,
				onLostPointerCapture: onPointerCancel,
			});
		}

		function WidthControls(props) {
			const container = props.container;
			const phase = props.phase;

			const publishWidths = React.useCallback((element) => {
				const target = element.parentElement || element;
				const column = element.offsetWidth;
				target.style.setProperty("--dsh-conversation-column-width", column + "px");
				const preference = readWidthPreference();
				if (preference === null) target.style.removeProperty("--dsh-chat-user-width");
				else target.style.setProperty("--dsh-chat-user-width", resolveContentWidth(column, preference) + "px");
			}, []);

			React.useLayoutEffect(() => {
				if (!container) return undefined;
				publishWidths(container);
				if (typeof ResizeObserver === "undefined") return undefined;
				const observer = new ResizeObserver(() => publishWidths(container));
				observer.observe(container);
				return () => observer.disconnect();
			}, [container, publishWidths]);

			const onStart = React.useCallback(() => (container ? resolveContentWidth(container.offsetWidth, readWidthPreference()) : 680), [container]);
			const onDrag = React.useCallback(
				(width) => {
					if (!container) return;
					(container.parentElement || container).style.setProperty("--dsh-chat-user-width", resolveContentWidth(container.offsetWidth, width) + "px");
				},
				[container],
			);
			const onCommit = React.useCallback(
				(width) => {
					if (!container) return;
					try {
						localStorage.setItem(WIDTH_PREF_KEY, String(resolveContentWidth(container.offsetWidth, width)));
					} catch (error) {
						/* storage unavailable */
					}
				},
				[container],
			);
			const onEnd = React.useCallback(() => {
				if (container) publishWidths(container);
			}, [container, publishWidths]);

			if (!container || phase !== "active") return null;
			return ["left", "right"].map((side) => h(WidthHandle, { key: side, side, onStart, onDrag, onCommit, onEnd }));
		}
		//#endregion

		//#region pane body
		function FixedChatView(props) {
			return h(React.Fragment, null, props.renderSlot("conversation.session", { view: "chat" }));
		}

		/**
		 * Body of one pane. Registered as the `splitview.pane` list entry so the
		 * renderer hands it the owning session's scoped hooks.
		 */
		function PaneBody(props) {
			const { renderFactorySlot, useSession, useSessions, useConversation, sessionId } = props;
			// Every one of these is a uSES selector hook built by the renderer
			// (bindSnapshotSelector): the selector is mandatory, so pass an identity
			// function when we want the whole snapshot.
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

			return renderFactorySlot("conversation.content", { variant: "embedded", phase, hero }, { slots: { views: FixedChatView, widthControls: WidthControls } });
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
			const { status, onRetry, children } = props;
			const t = runtime.t;
			const ready = useReferenceReady(status);
			if (!status || status.kind === "missing") return h("div", { className: "dsv-empty" }, t("loading"));
			if (status.kind === "failed") {
				return h(
					"div",
					{ className: "dsv-empty dsv-empty--error" },
					h("div", null, t("failedSession")),
					h("div", { className: "dsv-picker__meta" }, status.message || ""),
					h("div", { className: "dsv-empty__actions" }, h("button", { type: "button", className: "dsv-linkbtn", onClick: onRetry }, t("pickAnother"))),
				);
			}
			if (!ready) return h("div", { className: "dsv-empty" }, h("div", { className: "dsv-spin", "aria-hidden": true }));
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
			const { splitId, index, orientation, sizes, stackRef } = props;
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
				store.actions.setSizes(splitId, next);
			};

			const onPointerDown = (event) => {
				if (event.button !== undefined && event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch (error) {
					/* capture unsupported */
				}
				dragRef.current = { base: sizes.slice(), pos: orientation === "row" ? event.clientX : event.clientY };
			};

			const onPointerMove = (event) => {
				const drag = dragRef.current;
				if (!drag) return;
				const delta = (orientation === "row" ? event.clientX : event.clientY) - drag.pos;
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

		//#region geometry helpers
		/** Which edge band of a box the point is in, or "center". */
		function zoneOfPoint(x, y, box) {
			if (!(box.width > 0) || !(box.height > 0)) return "center";
			const fx = (x - box.left) / box.width;
			const fy = (y - box.top) / box.height;
			const candidates = [];
			if (fx < EDGE_BAND) candidates.push({ zone: "left", value: fx });
			if (fx > 1 - EDGE_BAND) candidates.push({ zone: "right", value: 1 - fx });
			if (fy < EDGE_BAND) candidates.push({ zone: "top", value: fy });
			if (fy > 1 - EDGE_BAND) candidates.push({ zone: "bottom", value: 1 - fy });
			if (candidates.length === 0) return "center";
			candidates.sort((a, b) => a.value - b.value);
			return candidates[0].zone;
		}

		function orientationOf(zone) {
			return zone === "top" || zone === "bottom" ? "col" : "row";
		}

		function positionOf(zone) {
			return zone === "top" || zone === "left" ? "before" : "after";
		}
		//#endregion

		//#region context menu
		function TabMenu(props) {
			const { x, y, group, tab, onClose } = props;
			const t = runtime.t;
			const ref = React.useRef(null);
			const [position, setPosition] = React.useState({ left: x, top: y });

			React.useLayoutEffect(() => {
				const node = ref.current;
				if (!node) return;
				const box = node.getBoundingClientRect();
				setPosition({
					left: Math.min(x, Math.max(4, window.innerWidth - box.width - 8)),
					top: Math.min(y, Math.max(4, window.innerHeight - box.height - 8)),
				});
			}, [x, y]);

			React.useEffect(() => {
				const onDown = (event) => {
					const node = ref.current;
					if (node && event.target instanceof Node && node.contains(event.target)) return;
					onClose();
				};
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				document.addEventListener("mousedown", onDown, true);
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("mousedown", onDown, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [onClose]);

			const index = group.tabs.findIndex((item) => item.id === tab.id);
			const item = (key, label, run, disabled) =>
				h(
					"button",
					{
						key,
						type: "button",
						className: "dsv-ctx__item",
						disabled: disabled === true,
						onClick: () => {
							onClose();
							run();
						},
					},
					label,
				);

			return h(
				"div",
				{ ref, className: "dsv-ctx", style: position, role: "menu" },
				item("close", t("closeTab"), () => store.actions.closeTab(group.id, tab.id)),
				item("closeOthers", t("closeOthers"), () => store.actions.closeOtherTabs(group.id, tab.id), group.tabs.length < 2),
				item("closeRight", t("closeRight"), () => store.actions.closeTabsToRight(group.id, tab.id), index >= group.tabs.length - 1),
				h("div", { key: "sep1", className: "dsv-ctx__sep" }),
				item("splitRight", t("splitRight"), () => store.actions.moveTabToNewGroup(tab.id, group.id, "row")),
				item("splitDown", t("splitDown"), () => store.actions.moveTabToNewGroup(tab.id, group.id, "col")),
				h("div", { key: "sep2", className: "dsv-ctx__sep" }),
				item("closePane", t("closePane"), () => store.actions.closeGroup(group.id), countGroups(store.getSnapshot().root) < 2),
			);
		}
		//#endregion

		//#region takeover
		/**
		 * Root of the takeover: owns the pane tree plus the drag session. Every
		 * pane renders the shipped conversation through `splitview.pane`, so this
		 * component only arranges boxes and tabs.
		 */
		function Takeover(props) {
			const { renderSlot, SessionProvider, sessionId: mainSessionId } = props;
			const t = runtime.t;
			const snap = useLayout();
			const list = useSessionList();
			const groups = React.useMemo(() => listGroups(snap.root), [snap.root]);
			const [menu, setMenu] = React.useState(null);
			const [drop, setDrop] = React.useState(null);
			const [insertAt, setInsertAt] = React.useState(null);
			const dragTabRef = React.useRef(null);
			const dropRef = React.useRef(null);
			const splitRefs = React.useRef(new Map());
			const bridged = React.useRef(null);

			const sessionIds = React.useMemo(() => {
				const ids = [];
				const seen = new Set();
				for (const group of groups) {
					for (const tab of group.tabs) {
						if (tab.sessionId && !seen.has(tab.sessionId)) {
							seen.add(tab.sessionId);
							ids.push(tab.sessionId);
						}
					}
				}
				return ids;
			}, [groups]);

			// Retry failed retains once the projected list changes: a restored
			// layout is read from localStorage before the session list arrives,
			// so the first retain legitimately fails with "unknown session".
			const listRevision = list && list.ids ? list.ids.length : 0;
			const held = useHeldReferences(sessionIds, listRevision);

			const activeGroup = groups.find((group) => group.id === snap.activeGroupId) || groups[0];
			const activeTab = activeGroup ? activeGroup.tabs.find((tab) => tab.id === activeGroup.activeTabId) || activeGroup.tabs[0] : undefined;
			const activeSession = activeTab && activeTab.sessionId ? activeTab.sessionId : undefined;

			// A pane tab only becomes "current" once its session is known to the
			// host. Without this guard a restored layout pushes a stale id into
			// uiWorkspace.openSession on the very first render and throws.
			const known = React.useCallback((id) => Boolean(list && list.byId && list.byId[id]), [list]);

			// mainView -> tree: a session opened from the sidebar lands in the active pane.
			React.useEffect(() => {
				if (typeof mainSessionId !== "string") return;
				if (bridged.current === mainSessionId) return;
				bridged.current = mainSessionId;
				store.actions.adoptSession(mainSessionId);
			}, [mainSessionId]);

			// tree -> mainView: focusing a pane makes its session the app's current one.
			React.useEffect(() => {
				if (!activeSession) return;
				if (bridged.current === activeSession) return;
				if (!known(activeSession)) return;
				bridged.current = activeSession;
				const workspace = runtime.uiWorkspace;
				if (workspace && typeof workspace.openSession === "function") {
					try {
						workspace.openSession(activeSession);
					} catch (error) {
						console.error("[dsh-splitview] openSession failed", error);
					}
				}
			}, [activeSession, known]);

			const brokenIds = React.useMemo(() => {
				const set = new Set();
				for (const [id, entry] of held) if (entry.kind === "failed") set.add(id);
				return set;
			}, [held]);

			const rowOf = (id) => (list && list.byId ? list.byId[id] : undefined);

			const setDropState = (next) => {
				dropRef.current = next;
				setDrop(next);
			};

			const onPaneDragOver = (event, group) => {
				const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
				if (!dragTabRef.current && types.indexOf("text/plain") < 0) return;
				event.preventDefault();
				event.stopPropagation();
				if (event.dataTransfer) event.dataTransfer.dropEffect = dragTabRef.current ? "move" : "copy";
				const zone = zoneOfPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
				const current = dropRef.current;
				if (!current || current.groupId !== group.id || current.zone !== zone) setDropState({ groupId: group.id, zone });
			};

			const onPaneDrop = (event, group) => {
				event.preventDefault();
				event.stopPropagation();
				const zone = dropRef.current && dropRef.current.groupId === group.id ? dropRef.current.zone : "center";
				setDropState(null);
				const dragTab = dragTabRef.current;
				dragTabRef.current = null;
				if (dragTab) {
					if (zone === "center") store.actions.moveTab(dragTab.tabId, dragTab.groupId, group.id, group.tabs.length);
					else store.actions.moveTabToNewGroup(dragTab.tabId, dragTab.groupId, orientationOf(zone));
					return;
				}
				let payload = "";
				try {
					payload = event.dataTransfer ? event.dataTransfer.getData("text/plain") : "";
				} catch (error) {
					payload = "";
				}
				if (!payload) return;
				if (zone === "center") {
					const tab = group.tabs.find((item) => item.id === group.activeTabId) || group.tabs[0];
					if (tab && tab.sessionId === null) store.actions.setSession(group.id, tab.id, payload);
					else store.actions.adoptSession(payload);
					return;
				}
				store.actions.splitGroup(group.id, orientationOf(zone), positionOf(zone), payload);
			};

			const renderTabStrip = (group) => {
				const barDropAt = (event) => {
					if (!dragTabRef.current) return;
					event.preventDefault();
					event.stopPropagation();
					const tabs = Array.from(event.currentTarget.querySelectorAll(".dsv-tab"));
					let index = tabs.length;
					for (let i = 0; i < tabs.length; i += 1) {
						const box = tabs[i].getBoundingClientRect();
						if (event.clientX < box.left + box.width / 2) {
							index = i;
							break;
						}
					}
					setInsertAt({ groupId: group.id, index });
					setDropState({ groupId: group.id, zone: "tabbar" });
				};
				const barDropCommit = (event) => {
					event.preventDefault();
					event.stopPropagation();
					const drag = dragTabRef.current;
					dragTabRef.current = null;
					const spot = insertAt && insertAt.groupId === group.id ? insertAt.index : group.tabs.length;
					setInsertAt(null);
					setDropState(null);
					if (!drag) return;
					store.actions.moveTab(drag.tabId, drag.groupId, group.id, spot);
				};

				const children = [];
				group.tabs.forEach((tab, tabIndex) => {
					if (insertAt && insertAt.groupId === group.id && insertAt.index === tabIndex) {
						children.push(h("span", { key: "ins-" + tab.id, className: "dsv-ins", style: { left: 0 } }));
					}
					const label = tab.sessionId ? titleOf(rowOf(tab.sessionId), tab.sessionId) : t("addTab");
					children.push(
						h(
							"div",
							{
								key: tab.id,
								role: "tab",
								tabIndex: 0,
								"aria-selected": group.activeTabId === tab.id,
								className: "dsv-tab" + (group.activeTabId === tab.id ? " dsv-tab--active" : "") + (tab.sessionId && brokenIds.has(tab.sessionId) ? " dsv-tab--broken" : ""),
								title: label,
								draggable: true,
								onClick: () => store.actions.setActiveTab(group.id, tab.id),
								onKeyDown: (event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										store.actions.setActiveTab(group.id, tab.id);
									}
								},
								onContextMenu: (event) => {
									event.preventDefault();
									event.stopPropagation();
									store.actions.setActiveTab(group.id, tab.id);
									setMenu({ x: event.clientX, y: event.clientY, groupId: group.id, tabId: tab.id });
								},
								onDragStart: (event) => {
									dragTabRef.current = { tabId: tab.id, groupId: group.id };
									try {
										event.dataTransfer.effectAllowed = "move";
										event.dataTransfer.setData("text/plain", tab.id);
										event.dataTransfer.setData(TAB_DRAG_TYPE, "1");
									} catch (error) {
										/* ignore */
									}
								},
								onDragEnd: () => {
									dragTabRef.current = null;
									setInsertAt(null);
									setDropState(null);
								},
							},
							h("span", { className: "dsv-tab__label" }, label),
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
					);
				});
				if (insertAt && insertAt.groupId === group.id && insertAt.index >= group.tabs.length) {
					children.push(h("span", { key: "ins-end", className: "dsv-ins", style: { right: 2 } }));
				}
				children.push(h("button", { key: "add", type: "button", className: "dsv-tabbar__add", title: t("addTab"), onClick: () => store.actions.addTab(group.id) }, "＋"));
				children.push(
					h(
						"button",
						{
							key: "menu",
							type: "button",
							className: "dsv-tabbar__menu",
							title: t("paneMenu"),
							onClick: (event) => {
								const tab = group.tabs.find((item) => item.id === group.activeTabId) || group.tabs[0];
								if (!tab) return;
								const box = event.currentTarget.getBoundingClientRect();
								setMenu({ x: box.left, y: box.bottom + 4, groupId: group.id, tabId: tab.id });
							},
						},
						"⋯",
					),
				);

				return h(
					"div",
					{
						className: "dsv-tabbar",
						role: "tablist",
						onDragOver: barDropAt,
						onDrop: barDropCommit,
						onDragLeave: (event) => {
							if (event.currentTarget.contains(event.relatedTarget)) return;
							setInsertAt(null);
						},
					},
					children,
				);
			};

			const renderBody = (group) => {
				const tab = group.tabs.find((item) => item.id === group.activeTabId) || group.tabs[0];
				if (!tab) return h("div", { className: "dsv-empty" }, t("emptyPickerHint"));
				if (!tab.sessionId) {
					return h(SessionPicker, {
						onPick: (picked) => {
							if (typeof picked !== "string" || picked === "") return;
							store.actions.setSession(group.id, tab.id, picked);
						},
					});
				}
				const status = held.get(tab.sessionId);
				return h(
					SessionHost,
					{
						status: status || { kind: "missing" },
						SessionProvider,
						onRetry: () => store.actions.closeTab(group.id, tab.id),
					},
					renderSlot("splitview.pane", { groupId: group.id, tabId: tab.id }, { only: "body" }),
				);
			};

			const renderGroup = (group) => {
				const isActive = group.id === snap.activeGroupId;
				const zone = drop && drop.groupId === group.id && drop.zone !== "tabbar" ? drop.zone : null;
				return h(
					"div",
					{
						key: group.id,
						className: "dsv-group" + (isActive ? " dsv-group--active" : "") + (zone && zone !== "center" ? " dsv-group--drop" : ""),
						"data-dsv-group": group.id,
						style: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
						onMouseDownCapture: () => store.actions.focusGroup(group.id),
						onFocusCapture: () => store.actions.focusGroup(group.id),
						onDragOver: (event) => onPaneDragOver(event, group),
						onDrop: (event) => onPaneDrop(event, group),
					},
					renderTabStrip(group),
					h("div", { className: "dsv-body" }, renderBody(group)),
					zone ? h("div", { className: "dsv-drop", "data-zone": zone }) : null,
				);
			};

			const renderNode = (node) => {
				if (node.type === "group") return renderGroup(node);
				let stack = splitRefs.current.get(node.id);
				if (!stack) {
					stack = React.createRef();
					splitRefs.current.set(node.id, stack);
				}
				const pieces = [];
				node.children.forEach((child, index) => {
					pieces.push(renderNode(child));
					if (index < node.children.length - 1) {
						pieces.push(
							h(Resizer, {
								key: "rz-" + node.id + "-" + index,
								splitId: node.id,
								index,
								orientation: node.orientation,
								sizes: node.sizes,
								stackRef: stack,
							}),
						);
					}
				});
				return h("div", { key: node.id, ref: stack, className: "dsv-node", "data-orientation": node.orientation }, pieces);
			};

			const menuGroup = menu ? findGroup(snap.root, menu.groupId) : undefined;
			const menuTab = menuGroup ? menuGroup.tabs.find((tab) => tab.id === menu.tabId) : undefined;

			return h(
				"div",
				{ className: "dsv-root", "data-panes": groups.length },
				h("div", { className: "dsv-node", "data-orientation": "row" }, renderNode(snap.root)),
				menuGroup && menuTab ? h(TabMenu, { x: menu.x, y: menu.y, group: menuGroup, tab: menuTab, onClose: () => setMenu(null) }) : null,
			);
		}
		//#endregion

		//#region global drop veil
		/**
		 * "Drag a session onto the conversation to split there."
		 *
		 * Installed by apply(), not by a component. The gesture matters most in the
		 * single-pane case — that is when the shipped conversation owns the screen —
		 * and hanging the listener off an overlay entry made the whole feature
		 * silently dead whenever that entry was not mounted. The drop zone is painted
		 * by stamping `data-dsv-drop` on the region element, so the hint needs no
		 * extra DOM and no extra React tree either.
		 */
		function installGlobalDrop() {
			let host = null;
			let zone = null;
			const clear = () => {
				zone = null;
				if (host === null) return;
				host.removeAttribute("data-dsv-drop");
				host = null;
			};
			const region = () => {
				const outlet = document.querySelector('[data-slot="main"]');
				if (!outlet) return null;
				// The outlet itself is `display: contents`, so it generates no box and
				// its rect is all zeroes. Walk up until something actually occupies
				// space — that element is the conversation region on screen.
				let node = outlet;
				for (let depth = 0; node && depth < 6; depth += 1) {
					const box = node.getBoundingClientRect();
					if (box.width > 0 && box.height > 0) return { box, node };
					node = node.parentElement;
				}
				return null;
			};
			const onOver = (event) => {
				// While the takeover is installed the panes own their own drop targets.
				if (installer.isInstalled()) return clear();
				const data = event.dataTransfer;
				if (!data) return clear();
				const types = Array.from(data.types || []);
				// Our own tab drags carry TAB_DRAG_TYPE; those belong to the panes.
				if (types.indexOf("text/plain") < 0 || types.indexOf(TAB_DRAG_TYPE) >= 0) return clear();
				const found = region();
				if (!found) return clear();
				const box = found.box;
				if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) return clear();
				event.preventDefault();
				if (host !== found.node) {
					clear();
					host = found.node;
				}
				zone = zoneOfPoint(event.clientX, event.clientY, box);
				host.setAttribute("data-dsv-drop", zone);
			};
			const onDrop = (event) => {
				const was = zone;
				clear();
				if (!was || installer.isInstalled()) return;
				event.preventDefault();
				event.stopPropagation();
				let payload = "";
				try {
					payload = event.dataTransfer ? event.dataTransfer.getData("text/plain") : "";
				} catch (error) {
					payload = "";
				}
				if (!payload) return;
				const snap = store.getSnapshot();
				const group = findGroup(snap.root, snap.activeGroupId) || listGroups(snap.root)[0];
				if (!group) return;
				if (was === "center") {
					const tab = group.tabs.find((item) => item.id === group.activeTabId) || group.tabs[0];
					if (tab && tab.sessionId === null) store.actions.setSession(group.id, tab.id, payload);
					else store.actions.adoptSession(payload);
					return;
				}
				store.actions.splitGroup(group.id, orientationOf(was), positionOf(was), payload);
			};
			const onLeave = (event) => {
				if (event.relatedTarget === null) clear();
			};
			document.addEventListener("dragover", onOver, true);
			document.addEventListener("drop", onDrop, true);
			document.addEventListener("dragend", clear, true);
			document.addEventListener("dragleave", onLeave, true);
			return () => {
				document.removeEventListener("dragover", onOver, true);
				document.removeEventListener("drop", onDrop, true);
				document.removeEventListener("dragend", clear, true);
				document.removeEventListener("dragleave", onLeave, true);
				clear();
			};
		}
		//#endregion

		//#region settings section
		function SettingsSection() {
			const t = runtime.t;
			const snap = useLayout();
			const groups = countGroups(snap.root);
			return h(
				"div",
				{ className: "dsv-set" },
				h(
					"div",
					{ className: "dsv-set__row" },
					h(
						"div",
						{ className: "dsv-set__text" },
						h("div", { className: "dsv-set__title" }, t("setEnable")),
						h("div", { className: "dsv-set__desc" }, t("setEnableDesc")),
					),
					h("div", { className: "dsv-set__ctl" }, h("input", { type: "checkbox", checked: snap.enabled, "aria-label": t("setEnable"), onChange: (event) => store.actions.setEnabled(event.target.checked) })),
				),
				h(
					"div",
					{ className: "dsv-set__row" },
					h("div", { className: "dsv-set__text" }, h("div", { className: "dsv-set__title" }, t("setMax")), h("div", { className: "dsv-set__desc" }, t("setMaxDesc"))),
					h(
						"div",
						{ className: "dsv-set__ctl" },
						h(
							"select",
							{ value: snap.maxPanes, "aria-label": t("setMax"), onChange: (event) => store.actions.setMaxPanes(event.target.value) },
							[2, 3, 4, 5, 6].map((n) => h("option", { key: n, value: n }, String(n))),
						),
					),
				),
				h(
					"div",
					{ className: "dsv-set__row" },
					h("div", { className: "dsv-set__text" }, h("div", { className: "dsv-set__title" }, t("setReset")), h("div", { className: "dsv-set__desc" }, t("setResetDesc"))),
					h("div", { className: "dsv-set__ctl" }, h("button", { type: "button", className: "dsv-set__btn", onClick: () => store.actions.reset() }, t("setResetAction"))),
				),
				h(
					"div",
					{ className: "dsv-set__keys" },
					h("div", null, h("kbd", null, "Ctrl/⌘ + Shift + \\"), h("span", null, t("cmdSplitRight"))),
					h("div", null, h("kbd", null, "Ctrl/⌘ + Shift + Alt + \\"), h("span", null, t("cmdSplitDown"))),
					h("div", null, h("kbd", null, "Ctrl/⌘ + Shift + W"), h("span", null, t("cmdCloseTab"))),
					h("div", null, h("kbd", null, "Ctrl/⌘ + Shift + ]"), h("span", null, t("cmdNextGroup"))),
					h("div", null, h("kbd", null, "Ctrl/⌘ + Shift + ["), h("span", null, t("cmdPrevGroup"))),
				),
				h("div", { className: "dsv-set__hint" }, t("setHint", { count: groups })),
			);
		}
		//#endregion

		//#region conversation header entry
		function SplitHereButton(props) {
			const t = runtime.t;
			const explicit = typeof props.sessionId === "string" ? props.sessionId : undefined;
			const onClick = () => {
				const snap = store.getSnapshot();
				const group = findGroup(snap.root, snap.activeGroupId) || listGroups(snap.root)[0];
				if (!group) return;
				const tab = group.tabs.find((item) => item.id === group.activeTabId) || group.tabs[0];
				const session = explicit || (tab && tab.sessionId) || mainViewSession() || null;
				store.actions.splitGroup(group.id, "row", "after", session);
			};
			return h("button", { type: "button", className: "dsv-hbtn", title: t("splitHere"), "aria-label": t("splitHere"), onClick }, h(IconSplit));
		}
		//#endregion

		//#region locale
		const MESSAGES = {
			zh: {
				panel: "分屏视图",
				closeTab: "关闭标签",
				closeOthers: "关闭其他标签",
				closeRight: "关闭右侧标签",
				splitRight: "向右拆分",
				splitDown: "向下拆分",
				closePane: "关闭这个窗格",
				paneMenu: "窗格菜单",
				addTab: "新建标签",
				pickerSearch: "搜索标题或工作目录",
				emptyPickerHint: "选一个会话放进这个窗格，或从左侧栏把会话拖进来。",
				loading: "正在打开会话…",
				failedSession: "该会话已不可用",
				pickAnother: "换一个会话",
				splitHere: "向右拆分，把这个会话放到新窗格",
				conversationUnavailable: "对话视图暂时不可用",
				setEnable: "启用分屏视图",
				setEnableDesc: "分屏会接管中央对话区。关掉后回到 DeepSeek Harness 原本的对话面板，布局保留，重新打开即可继续。",
				setMax: "最多窗格数",
				setMaxDesc: "一次最多能把对话区拆成几个窗格。",
				setReset: "重置布局",
				setResetDesc: "把所有窗格合并回一个（会话本身不受影响）。",
				setResetAction: "重置",
				setHint: "现在有 {count} 个窗格。把会话从左侧栏拖到对话区边缘即可新建窗格，拖到中间则替换当前窗格。",
				cmdSplitRight: "分屏：向右拆分当前窗格",
				cmdSplitDown: "分屏：向下拆分当前窗格",
				cmdCloseTab: "分屏：关闭当前标签",
				cmdNextGroup: "分屏：下一个窗格",
				cmdPrevGroup: "分屏：上一个窗格",
			},
			en: {
				panel: "Split View",
				closeTab: "Close tab",
				closeOthers: "Close other tabs",
				closeRight: "Close tabs to the right",
				splitRight: "Split right",
				splitDown: "Split down",
				closePane: "Close this pane",
				paneMenu: "Pane menu",
				addTab: "New tab",
				pickerSearch: "Search title or working directory",
				emptyPickerHint: "Pick a session for this pane, or drag one in from the sidebar.",
				loading: "Opening session…",
				failedSession: "This session is no longer available",
				pickAnother: "Pick another session",
				splitHere: "Split right with this session",
				conversationUnavailable: "The conversation view is unavailable",
				setEnable: "Enable split view",
				setEnableDesc: "Split view takes over the central conversation area. Turning it off restores the stock DeepSeek Harness conversation panel; your layout is kept and comes back when you re-enable it.",
				setMax: "Maximum panes",
				setMaxDesc: "How many panes the conversation area can be split into.",
				setReset: "Reset layout",
				setResetDesc: "Merge every pane back into one (sessions themselves are untouched).",
				setResetAction: "Reset",
				setHint: "{count} pane(s) right now. Drag a session from the sidebar onto an edge of the conversation area to add a pane, or onto the middle to replace the current one.",
				cmdSplitRight: "Split: split the active pane right",
				cmdSplitDown: "Split: split the active pane down",
				cmdCloseTab: "Split: close the active tab",
				cmdNextGroup: "Split: next pane",
				cmdPrevGroup: "Split: previous pane",
			},
		};
		//#endregion

		//#region shortcuts
		/**
		 * Per-profile defaults for one chord.
		 *
		 * `web:linux` is deliberately absent: the shortcut registry validates every
		 * declared default against the browser reservation table, and that profile
		 * only admits three fixed chords (Primary+Slash, Primary+Shift+Comma,
		 * Primary+Shift+Period). Declaring our chord there makes register() throw
		 * "Unsupported Web shortcut". Omitting the profile leaves the command
		 * unbound on Linux browsers only.
		 *
		 * `aliases` is NOT optional: the shortcuts overlay spreads `row.aliases`
		 * unconditionally, so an undefined value crashes the whole shell.overlay
		 * entry with "row.aliases is not iterable".
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

		function splitActive(orientation) {
			const snap = store.getSnapshot();
			const group = findGroup(snap.root, snap.activeGroupId) || listGroups(snap.root)[0];
			if (!group) return;
			const tab = group.tabs.find((item) => item.id === group.activeTabId) || group.tabs[0];
			const session = (tab && tab.sessionId) || mainViewSession() || null;
			store.actions.splitGroup(group.id, orientation, "after", session);
		}

		function cycleGroup(delta) {
			const snap = store.getSnapshot();
			const groups = listGroups(snap.root);
			if (groups.length < 2) return;
			const index = groups.findIndex((group) => group.id === snap.activeGroupId);
			store.actions.focusGroup(groups[(index + delta + groups.length) % groups.length].id);
		}

		function closeActiveTab() {
			const snap = store.getSnapshot();
			const group = findGroup(snap.root, snap.activeGroupId) || listGroups(snap.root)[0];
			if (!group) return;
			const tab = group.tabs.find((item) => item.id === group.activeTabId) || group.tabs[0];
			if (tab) store.actions.closeTab(group.id, tab.id);
		}
		//#endregion

		//#region installer
		/**
		 * Owns the `main.conversation` takeover.
		 *
		 * `priority: -1` shadows the shipped occupant — the dispatcher sorts
		 * ascending and renders the lowest — while the shipped registration stays
		 * in place underneath. Removing our registration hands the panel straight
		 * back to it, which is what makes the settings toggle and the
		 * "last pane closed" path work without a reload.
		 *
		 * Note what we deliberately do NOT declare: any child slot the shipped
		 * `main.conversation` entry already declares (`conversation.header` and
		 * friends). `register()` refuses a child that someone else has declared, and
		 * releasing it would strip the shipped entry's own declarations.
		 */
		const installer = {
			ctx: null,
			dispose: null,
			isInstalled() {
				return typeof this.dispose === "function";
			},
			install() {
				if (!this.ctx || this.isInstalled()) return;
				const ctx = this.ctx;
				this.dispose = ctx.slots.inject("main.conversation", function* () {
					yield ctx.slots.register(
						{
							name: "main.conversation",
							priority: -1,
							locale: NS,
							children: { "splitview.pane": { kind: "list", scope: "session" } },
						},
						Takeover,
					);
				});
			},
			uninstall() {
				const dispose = this.dispose;
				this.dispose = null;
				if (typeof dispose === "function") {
					try {
						dispose();
					} catch (error) {
						console.error("[dsh-splitview] uninstall failed", error);
					}
				}
			},
			/** Take over exactly while there is more than one pane to show. */
			sync() {
				const snap = store.getSnapshot();
				const groups = countGroups(snap.root);
				const wanted = snap.enabled && groups > 1;
				if (wanted && !this.isInstalled()) this.install();
				else if (!wanted && this.isInstalled()) this.uninstall();
			},
		};
		//#endregion

		//#region apply
		// `uiWorkspace` is optional in spirit but required by Cordis: reading an
		// undeclared service off `ctx` throws "cannot get property X without inject".
		// Declaring it here keeps the bridge in the takeover panel (focusing a pane
		// makes its session the app's current one) working.
		const inject = ["slots", "sessions", "locale", "shortcuts", "uiWorkspace"];

		function apply(ctx) {
			try {
				applyInner(ctx);
			} catch (error) {
				console.error("[dsh-splitview] apply crashed", error && error.stack ? error.stack : error);
			}
		}

		function applyInner(ctx) {
			installStyles();
			runtime.ctx = ctx;
			runtime.sessions = ctx.sessions || null;
			try {
				runtime.uiWorkspace = ctx.uiWorkspace || null;
			} catch (error) {
				// The workspace controller is not mandatory for the split layout to
				// render; only the "focusing a pane switches the app session" bridge
				// needs it. Degrade instead of losing the whole plugin.
				runtime.uiWorkspace = null;
			}
			installer.ctx = ctx;

			ctx.effect(() => ctx.locale.register(NS, MESSAGES), "dsh-splitview: strings");
			try {
				runtime.t = ctx.locale.bind(NS);
			} catch (error) {
				runtime.t = (key) => key;
			}

			// The pane body is its own list entry so the renderer scopes it to the
			// pane's session (that is where `renderslot("splitview.pane")` lands).
			ctx.effect(
				() => ctx.slots.inject("splitview.pane", () => ctx.slots.register({ name: "splitview.pane", id: "body", locale: NS }, PaneBody)),
				"dsh-splitview: pane body",
			);

			// Entry point where the user already is: the session header.
			ctx.effect(
				() =>
					ctx.slots.inject("conversation.session.header.utilities", () =>
						ctx.slots.register(
							{ name: "conversation.session.header.utilities", id: NS + ".split", order: 40, locale: NS, label: () => runtime.t("splitHere") },
							SplitHereButton,
						),
					),
				"dsh-splitview: header button",
			);

			ctx.effect(
				() =>
					ctx.slots.inject("settings.section", () =>
						ctx.slots.register({ name: "settings.section", id: NS, order: 90, locale: NS, label: () => runtime.t("panel") }, SettingsSection),
					),
				"dsh-splitview: settings section",
			);

			ctx.effect(
				() => installGlobalDrop(),
				"dsh-splitview: global drop",
			);

			ctx.effect(() => {
				const commands = [
					{
						id: "splitview.split.right",
						label: () => runtime.t("cmdSplitRight"),
						aliases: ["split", "split right", "split view"],
						defaults: defaultsFor("Backslash", ["primary", "shift"]),
						resolve: () => ({ status: "handled", run: () => splitActive("row") }),
					},
					{
						id: "splitview.split.down",
						label: () => runtime.t("cmdSplitDown"),
						aliases: ["split down", "split below"],
						defaults: defaultsFor("Backslash", ["primary", "shift", "alt"]),
						resolve: () => ({ status: "handled", run: () => splitActive("col") }),
					},
					{
						id: "splitview.close.tab",
						label: () => runtime.t("cmdCloseTab"),
						aliases: ["close tab", "close split tab"],
						defaults: defaultsFor("KeyW", ["primary", "shift"]),
						resolve: () => ({ status: "handled", run: () => closeActiveTab() }),
					},
					{
						id: "splitview.next.group",
						label: () => runtime.t("cmdNextGroup"),
						aliases: ["next group", "next split"],
						defaults: defaultsFor("BracketRight", ["primary", "shift"]),
						resolve: () => ({ status: "handled", run: () => cycleGroup(1) }),
					},
					{
						id: "splitview.prev.group",
						label: () => runtime.t("cmdPrevGroup"),
						aliases: ["previous group", "previous split"],
						defaults: defaultsFor("BracketLeft", ["primary", "shift"]),
						resolve: () => ({ status: "handled", run: () => cycleGroup(-1) }),
					},
				];
				const disposers = [];
				for (const command of commands) {
					try {
						disposers.push(ctx.shortcuts.register({ regions: ["page", "editable", "terminal"], modals: [], ...command }));
					} catch (error) {
						console.error("[dsh-splitview] shortcut registration failed: " + command.id, error);
					}
				}
				return () => {
					for (const dispose of disposers) {
						try {
							dispose();
						} catch (error) {
							/* already disposed */
						}
					}
				};
			}, "dsh-splitview: shortcuts");

			// Keep the takeover in step with the tree: installed exactly while more
			// than one pane is on screen.
			ctx.effect(() => {
				const off = store.subscribe(() => installer.sync());
				installer.sync();
				return () => {
					off();
					installer.uninstall();
				};
			}, "dsh-splitview: takeover");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
