/**
 * dsh-splitview — VSCode-style editor groups for the DSH Web UI.
 *
 * The browser half is a single plain-JS bundle: no JSX, no build step.
 *
 * How it plugs into the host
 * --------------------------
 * The split view is not a separate panel. It takes over the shipped
 * `main.conversation` slot at `priority: -1`, reserving an empty seat there.
 * The real pane tree lives in the root-scoped `shell.overlay`, positioned on
 * that seat, so changing the host's current Session cannot remount the panes
 * or interrupt a drag's pointer capture. Unregistering restores the shipped
 * conversation shell without a reload.
 *
 * The workspace keeps one horizontal tab strip in both single and split
 * layouts. Each pane bridges the native session header and view controls.
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
		const PaneContext = React.createContext(null);

		//#region constants
		const NS = "dsh-splitview";
		const STORAGE_KEY = "dsh-splitview:layout:v3";
		const READING_KEY = "dsh-splitview:reading:v1";
		const OPEN_TIMEOUT_MS = 30000;
		const nativeSlotName = (name) => name === "conversation.header" ? "splitview.hostHeader" : name === "conversation.session" ? "splitview.hostSession" : NS + ".native." + name;
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
		// Native attachment listeners run on document in the bubbling phase.
		// Never claim a file drop, including OS drags that also carry text/plain.
		const hasFilePayload = (data) => !!data && (
			Array.from(data.types || []).includes("Files") ||
			Array.from(data.items || []).some((item) => item.kind === "file") ||
			!!(data.files && data.files.length)
		);
		const fileDropTarget = { current: null };
		//#endregion

		//#region styles
		const CSS = `
.dsv-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;background:var(--dsw-alias-bg-base)}
.dsv-workspace-bar{display:flex;align-items:stretch;flex:0 0 36px;min-width:0;border-bottom:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-family:inherit}
.dsv-tabs-viewport{position:relative;display:flex;flex:1;min-width:0}
.dsv-workspace-tabs{display:flex;flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;overscroll-behavior-x:contain}
.dsv-workspace-tabs::-webkit-scrollbar{display:none}
.dsv-tabbar{position:relative;display:flex;align-items:center;gap:2px;flex:none;height:36px;box-sizing:border-box;padding:0 4px;border-right:1px solid var(--dsw-alias-border-l3)}
.dsv-tabbar:last-child{border-right:0;flex-grow:1;padding-right:24px}
.dsv-group-number{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;margin:0 3px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,4px);color:var(--dsw-alias-label-tertiary);font-size:10px;font-variant-numeric:tabular-nums;user-select:none}
.dsv-tabbar[data-active=true] .dsv-group-number{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent)}
.dsv-tab{position:relative;display:inline-flex;align-items:center;gap:8px;flex:none;min-width:112px;max-width:240px;height:36px;box-sizing:border-box;padding:0 9px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);cursor:pointer;white-space:nowrap;user-select:none}
.dsv-tab[data-visible=true]{color:var(--dsw-alias-label-secondary)}
.dsv-tab:hover,.dsv-tab--active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsv-tab--active{box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary)}
.dsv-tab[data-insert]::before{content:"";position:absolute;top:5px;bottom:5px;width:2px;background:var(--dsw-alias-state-business-primary);z-index:1;pointer-events:none}
.dsv-tab[data-insert=before]::before{left:-1px}
.dsv-tab[data-insert=after]::before{right:-1px}
.dsv-tab--broken .dsv-tab__label{text-decoration:line-through;opacity:.55}
.dsv-tab__label{overflow:hidden;text-overflow:ellipsis}
.dsv-tab__close{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:inherit;opacity:0;cursor:pointer}
.dsv-tab:hover .dsv-tab__close,.dsv-tab[data-visible=true] .dsv-tab__close,.dsv-tab:focus-within .dsv-tab__close{opacity:.7}
.dsv-tab__close:hover{opacity:1!important;background:var(--dsw-alias-interactive-bg-hover)}
.dsv-workspace-actions{display:flex;align-items:center;gap:2px;padding:0 5px;flex:none;border-left:1px solid var(--dsw-alias-border-l3)}
.dsv-workspace-actions button,.dsv-tabscroll{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;margin:auto 0;padding:0;border:0;border-radius:var(--dsw-radius-sm,4px);color:var(--dsw-alias-label-tertiary);background:transparent;cursor:pointer;font:inherit}
.dsv-workspace-actions button:hover,.dsv-tabscroll:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsv-tabscroll:disabled{opacity:.3;cursor:default;background:transparent}
.dsv-tab:focus-visible,.dsv-workspace-actions button:focus-visible,.dsv-tabscroll:focus-visible,.dsv-tab__close:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-3px}
.dsv-conversation-shell{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1}
.dsv-conversation-shell>.dsv-native-header{flex:none;min-width:0}
.dsv-conversation-shell>[data-conversation-content]{flex:1;min-height:0}
.dsv-root [data-conversation-scroll] nav[class*="_frame"]{display:block!important;right:4px;width:24px}
.dsv-seat{flex:1 1 0;width:100%;height:100%;min-width:0;min-height:0}
.dsv-surface{position:fixed;z-index:10;pointer-events:auto}
.dsv-node{flex:1 1 auto;min-width:0;min-height:0;display:flex}
.dsv-node[data-orientation="row"]{flex-direction:row}
.dsv-node[data-orientation="col"]{flex-direction:column}
.dsv-layout{position:relative;display:flex;flex:1;min-width:0;min-height:0}
.dsv-pane-seat{flex:1 1 0;min-width:0;min-height:0}
.dsv-pane-layer{position:absolute;inset:0;pointer-events:none}
.dsv-pane-layer>.dsv-group{pointer-events:auto}
.dsv-group{position:relative;display:flex;flex-direction:column;flex-grow:1;flex-shrink:1;flex-basis:0;min-width:0;min-height:0;outline:1px solid transparent;outline-offset:-1px;}
.dsv-group--active{outline-color:var(--dsw-alias-border-l3)}
.dsv-group--drop{outline-color:var(--dsw-alias-state-business-primary,#247bbf);outline-width:2px}
.dsv-body{flex:1 1 auto;min-width:0;min-height:0;display:flex;overflow:hidden}
.dsv-body>*{flex:1 1 0;min-width:0;min-height:0}
.dsv-tabbody{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.dsv-tabbody[hidden]{display:none}
.dsv-tabbody>*{flex:1 1 0;min-width:0;min-height:0}
.dsv-resizer{flex:0 0 6px;position:relative;background:transparent;touch-action:none}
.dsv-resizer::after{content:"";position:absolute;background:var(--dsw-alias-border-l3);opacity:.55}
.dsv-node[data-orientation="row"]>.dsv-resizer{cursor:col-resize}
.dsv-node[data-orientation="row"]>.dsv-resizer::after{top:0;bottom:0;left:50%;width:1px}
.dsv-node[data-orientation="col"]>.dsv-resizer{cursor:row-resize}
.dsv-node[data-orientation="col"]>.dsv-resizer::after{left:0;right:0;top:50%;height:1px}
.dsv-resizer:hover::after,.dsv-resizer:active::after{opacity:1;background:var(--dsw-alias-state-business-primary)}
.dsv-resize-preview{position:fixed;z-index:900;pointer-events:none;will-change:transform;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#247bbf) 18%,transparent)}
.dsv-resize-preview::after{content:"";position:absolute;background:var(--dsw-alias-state-business-primary,#247bbf);box-shadow:0 0 6px color-mix(in srgb,var(--dsw-alias-state-business-primary,#247bbf) 40%,transparent)}
.dsv-resize-preview[data-axis="row"]::after{top:0;bottom:0;left:2px;width:2px}
.dsv-resize-preview[data-axis="col"]::after{left:0;right:0;top:2px;height:2px}
.dsv-node[data-dsv-resizing="row"],.dsv-node[data-dsv-resizing="row"] *{cursor:col-resize!important;user-select:none!important}
.dsv-node[data-dsv-resizing="col"],.dsv-node[data-dsv-resizing="col"] *{cursor:row-resize!important;user-select:none!important}
.dsv-drop{position:absolute;z-index:2;pointer-events:none;background:var(--dsw-alias-state-business-primary,#247bbf);opacity:.16;border-radius:6px}
.dsv-drop[data-zone="left"]{left:0;top:0;bottom:0;width:50%}
.dsv-drop[data-zone="right"]{right:0;top:0;bottom:0;width:50%}
.dsv-drop[data-zone="top"]{left:0;right:0;top:0;height:50%}
.dsv-drop[data-zone="bottom"]{left:0;right:0;bottom:0;height:50%}
.dsv-drop[data-zone="center"]{left:0;right:0;top:0;bottom:0;opacity:.08}
/* Painted on the conversation region itself while a session is dragged over
   it: no overlay component has to be mounted for the hint to appear. */
[data-dsv-drop]{position:relative;outline:2px dashed var(--dsw-alias-state-business-primary,#247bbf);outline-offset:-2px}
[data-dsv-drop]::after{content:"";position:absolute;z-index:3;pointer-events:none;background:var(--dsw-alias-state-business-primary,#247bbf);opacity:.14;border-radius:6px}
[data-dsv-drop="left"]::after{left:0;top:0;bottom:0;width:50%}
[data-dsv-drop="right"]::after{right:0;top:0;bottom:0;width:50%}
[data-dsv-drop="top"]::after{left:0;right:0;top:0;height:50%}
[data-dsv-drop="bottom"]::after{left:0;right:0;bottom:0;height:50%}
[data-dsv-drop="center"]::after{left:0;right:0;top:0;bottom:0;opacity:.07}
.dsv-ctx{position:fixed;z-index:1200;min-width:190px;padding:4px;border-radius:8px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));backdrop-filter:var(--dsw-menu-backdrop-filter);border:1px solid var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-prominent)}
.dsv-ctx__item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 9px;border:0;border-radius:5px;background:transparent;color:inherit;font-size:12px;line-height:1.4;text-align:left;cursor:pointer}
.dsv-ctx__item:hover{background:var(--dsw-alias-bg-layer-1)}
.dsv-ctx__item[disabled]{opacity:.4;cursor:default}
.dsv-ctx__sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l3)}
.dsv-picker{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px;padding:12px}
.dsv-picker__search{flex:0 0 auto;height:30px;padding:0 9px;font-size:12px;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;outline:0}
.dsv-picker__search:focus{border-color:var(--dsw-alias-state-business-primary,#247bbf)}
.dsv-picker__list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.dsv-picker__row{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;cursor:pointer}
.dsv-picker__row:hover{background:var(--dsw-alias-bg-layer-1)}
.dsv-picker__title{font-size:12px;line-height:1.35;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsv-picker__meta{font-size:11px;line-height:1.3;color:var(--dsw-alias-label-caption);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsv-empty{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px;font-size:12px;color:var(--dsw-alias-label-caption);text-align:center}
.dsv-empty--error{color:var(--dsw-alias-fg-danger,#c0392b)}
.dsv-empty__actions{display:flex;gap:6px}
.dsv-spin{width:16px;height:16px;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-label-caption);border-radius:50%;animation:dsv-spin .8s linear infinite}
@keyframes dsv-spin{to{transform:rotate(360deg)}}
.dsv-linkbtn{border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#247bbf);font-size:12px;cursor:pointer;padding:2px 4px}
.dsv-hbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;padding:0}
.dsv-hbtn:hover{background:var(--dsw-alias-bg-layer-1)}
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
.dsv-set__desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-caption)}
.dsv-set__ctl{flex:0 0 auto;display:flex;align-items:center;gap:6px}
.dsv-set select,.dsv-set button.dsv-set__btn{height:28px;padding:0 8px;font-size:12px;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;cursor:pointer}
.dsv-set kbd{font-family:inherit;font-size:11px;padding:1px 5px;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;background:var(--dsw-alias-bg-layer-1)}
.dsv-set__keys{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-caption)}
.dsv-set__keys div{display:flex;gap:8px;align-items:center}
.dsv-set__hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-caption);padding-top:4px;border-top:1px solid var(--dsw-alias-border-l3)}
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
			const flush = () => {
				clearTimeout(timer);
				timer = null;
				try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (error) { /* unavailable: memory-only */ }
			};
			const persist = () => { if (timer === null) timer = setTimeout(flush, 250); };
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
				const requested = patch.activeGroupId || state.activeGroupId;
				const activeGroupId = groups.some((g) => g.id === requested) ? requested : groups[0].id;
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
					if (sessionId !== null && (typeof sessionId !== "string" || sessionId === "")) return;
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
						const sourceIndex = from.tabs.findIndex((t) => t.id === tabId);
						const gap = index > sourceIndex ? index - 1 : index;
						const at = Math.max(0, Math.min(gap, tabs.length));
						tabs.splice(at, 0, tab);
						const root = updateGroup(state.root, fromGroupId, (g) => ({ ...g, tabs, activeTabId: tab.id }));
						set(withRoot(root, { activeGroupId: fromGroupId }));
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
				/** Detach at the target edge; preserve the tab's reading-memory key. */
				moveTabToNewGroup(tabId, fromGroupId, orientation, position = "after", targetGroupId = fromGroupId) {
					const from = findGroup(state.root, fromGroupId);
					if (!from || !findGroup(state.root, targetGroupId)) return null;
					const tab = from.tabs.find((t) => t.id === tabId);
					if (!tab) return null;
					const replacesSource = from.tabs.length === 1 && targetGroupId !== fromGroupId;
					if (!replacesSource && countGroups(state.root) >= state.maxPanes) return null;
					const axis = orientation === "col" ? "col" : "row";
					const side = position === "before" ? "before" : "after";
					const created = makeGroup(tab.sessionId);
					let root = state.root;
					// Splitting the sole tab beside itself mirrors the explicit split
					// button. Otherwise move the existing tab, keeping its identity.
					if (from.tabs.length > 1 || replacesSource) {
						created.tabs = [tab]; created.activeTabId = tab.id;
						const fromTabs = from.tabs.filter((t) => t.id !== tabId);
						if (fromTabs.length === 0) root = removeGroup(root, fromGroupId);
						else root = updateGroup(root, fromGroupId, (g) => ({
							...g, tabs: fromTabs,
							activeTabId: g.activeTabId === tabId ? fromTabs[0].id : g.activeTabId,
						}));
					}
					root = insertGroup(root, targetGroupId, created, axis, side);
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
				actions, flush,
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
			const retry = React.useCallback((id) => {
				const map = mapRef.current;
				const previous = map.get(id);
				try {
					// Acquire first so retry cannot retire the live session scope.
					const reference = runtime.sessions.retain(id, { source: SOURCE });
					map.set(id, { kind: "held", reference });
				} catch (error) {
					map.set(id, { kind: "failed", message: describeError(error) });
				}
				releaseEntry(previous);
				force();
			}, []);

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

			return { entries: mapRef.current, retry };
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

		//#region per-tab reading memory
		function createReadingMemory(storage) {
			const entries = new Map();
			let timer = 0;
			try {
				const saved = JSON.parse(storage.getItem(READING_KEY) || "[]");
				if (Array.isArray(saved)) for (const item of saved.slice(-100)) {
					if (!Array.isArray(item) || typeof item[0] !== "string") continue;
					const value = item[1];
					if (value && Number.isFinite(value.top) && value.top >= 0 && typeof value.bottom === "boolean") entries.set(item[0], {
						top: value.top, bottom: value.bottom,
						historySeq: Number.isInteger(value.historySeq) && value.historySeq >= 0 ? value.historySeq : null,
						anchorKey: typeof value.anchorKey === "string" ? value.anchorKey : null,
						anchorTop: Number.isFinite(value.anchorTop) ? value.anchorTop : 0,
						disclosures: Array.isArray(value.disclosures) ? value.disclosures.filter((item) => item && typeof item.key === "string" && Number.isInteger(item.index) && item.index >= 0 && typeof item.open === "boolean").slice(0, 64) : [],
					});
				}
			} catch (error) { /* unavailable or invalid storage */ }
			const flush = () => {
				clearTimeout(timer);
				timer = 0;
				try { storage.setItem(READING_KEY, JSON.stringify([...entries])); } catch (error) { /* memory-only fallback */ }
			};
			return {
				get: (key) => entries.get(key),
				put(key, value) {
					entries.delete(key);
					entries.set(key, value);
					while (entries.size > 100) entries.delete(entries.keys().next().value);
					clearTimeout(timer);
					timer = setTimeout(flush, 200);
				},
				flush,
			};
		}
		const readingMemory = createReadingMemory({
			getItem: (key) => localStorage.getItem(key),
			setItem: (key, value) => localStorage.setItem(key, value),
		});

		const readingCaptures = new Set();
		function persistWorkspace() {
			for (const capture of readingCaptures) { try { capture(); } catch (error) { /* a removed DOM must not block the other tabs */ } }
			store.flush();
			readingMemory.flush();
		}
		/** Let the native reader initialize from this tab, rather than its session-
		 * global scroll cache. The DOM capture remains the persisted authority. */
		function createNativeReadingStore(key) {
			const saved = readingMemory.get(key);
			let position = saved && !saved.bottom ? { anchorKey: saved.anchorKey || "", anchorTop: saved.anchorTop || 0, scrollTop: saved.top } : null;
			return { read: () => position, save: (next) => { position = next; } };
		}
		function NativePaneViews(props) {
			const pane = React.useContext(PaneContext);
			return pane ? pane.renderSlot("splitview.hostSession", {}) : props.renderSlot("conversation.session", {});
		}

		function loadedHistorySeq(sessionId) {
			const binding = runtime.sessions && runtime.sessions.binding && runtime.sessions.binding(sessionId);
			const entries = binding && binding.eventSource.getSnapshot().entries;
			const first = entries && entries.find((entry) => entry.event && Number.isInteger(entry.event.seq));
			return first ? first.event.seq : null;
		}
		function loadReadingHistory(sessionId, saved) {
			if (!saved || saved.bottom || !Number.isInteger(saved.historySeq) || saved.historySeq < 0) return null;
			const current = loadedHistorySeq(sessionId);
			const binding = runtime.sessions && runtime.sessions.binding && runtime.sessions.binding(sessionId);
			return binding && current !== null && current > saved.historySeq ? binding.session.loadThrough(saved.historySeq) : null;
		}

		function captureReading(scroller) {
			if (!scroller || scroller.clientHeight <= 0) return null;
			const top = scroller.scrollTop;
			const edge = scroller.getBoundingClientRect().top;
			const anchor = [...scroller.querySelectorAll("[data-chat-anchor-key]")].find((node) => {
				const box = node.getBoundingClientRect();
				return node.getAttribute("data-chat-flow-kind") !== "turn-process" && box.height > 0 && box.bottom > edge && box.top < edge + scroller.clientHeight;
			});
			return {
				top, bottom: scroller.scrollHeight - scroller.clientHeight - top <= 32,
				anchorKey: anchor ? anchor.getAttribute("data-chat-anchor-key") : null,
				anchorTop: anchor ? anchor.getBoundingClientRect().top - edge : 0,
				disclosures: [...scroller.querySelectorAll("button[aria-expanded]:not([aria-haspopup]),details")].flatMap((control) => {
					const row = control.closest("[data-chat-anchor-key]");
					if (!row) return [];
					const controls = [...row.querySelectorAll("button[aria-expanded]:not([aria-haspopup]),details")].filter((item) => item.closest("[data-chat-anchor-key]") === row);
					return [{ key: row.getAttribute("data-chat-anchor-key"), index: controls.indexOf(control), open: control.tagName === "DETAILS" ? control.open : control.getAttribute("aria-expanded") === "true" }];
				}).slice(0, 64),
			};
		}

		function restoreReading(scroller, saved, requireAnchor = false) {
			if (!scroller || scroller.clientHeight <= 0) return false;
			const anchors = new Map([...scroller.querySelectorAll("[data-chat-anchor-key]")].map((node) => [node.getAttribute("data-chat-anchor-key"), node]));
			if (requireAnchor && !saved.bottom && saved.anchorKey && !anchors.has(saved.anchorKey)) return false;
			for (const state of saved.disclosures || []) {
				const row = anchors.get(state.key);
				if (!row) continue;
				const control = [...row.querySelectorAll("button[aria-expanded]:not([aria-haspopup]),details")].filter((item) => item.closest("[data-chat-anchor-key]") === row)[state.index];
				if (!control) continue;
				if (control.tagName === "DETAILS") control.open = state.open;
				else if ((control.getAttribute("aria-expanded") === "true") !== state.open) control.click();
			}
			if (saved.bottom) scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
			else {
				const candidate = anchors.get(saved.anchorKey);
				const anchor = candidate && candidate.getBoundingClientRect().height > 0 ? candidate : null;
				scroller.scrollTop = anchor
					? scroller.scrollTop + anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.anchorTop
					: saved.top;
			}
			return true;
		}

		function ReadingTab(props) {
			const { tab, active, children } = props;
			const root = React.useRef(null);
			const key = tab.id + ":" + (tab.sessionId || "picker");
			React.useLayoutEffect(() => {
				const node = root.current;
				if (!node || !active || !tab.sessionId) return undefined;
				const saved = readingMemory.get(key);
				let restoring = Boolean(saved), frame = 0, settled = 0, historyPending = false, historyAttempted = false;
				let observer = null, resize = null, watchTarget = null;
				const scroller = () => node.querySelector("[data-conversation-scroll]");
				const capture = () => {
					if (restoring) return;
					const value = captureReading(scroller());
					if (value) readingMemory.put(key, { ...value, historySeq: loadedHistorySeq(tab.sessionId) });
				};
				const stop = () => {
					restoring = false; cancelAnimationFrame(frame); clearTimeout(settled);
					if (observer) observer.disconnect(); if (resize) resize.disconnect();
				};
				const restore = () => {
					if (!restoring || frame || historyPending) return;
					const body = scroller();
					if (!body || !body.querySelector("[data-chat-anchor-key]")) return;
					if (!historyAttempted) {
						historyAttempted = true;
						let pending;
						try { pending = loadReadingHistory(tab.sessionId, saved); } catch (error) { stop(); return; }
						if (pending && typeof pending.then === "function") {
							historyPending = true;
							Promise.resolve(pending).then(() => { historyPending = false; restore(); }, stop);
							return;
						}
					}
					// Observe the content's height as well as new nodes: asynchronous
					// cards/fonts can reflow after the initial scroll has settled.
					let content = body.querySelector("[data-chat-anchor-key]");
					while (content && content.parentElement !== body) content = content.parentElement;
					if (resize && content && watchTarget !== content) { resize.disconnect(); resize.observe(content); watchTarget = content; }
					frame = requestAnimationFrame(() => {
						frame = requestAnimationFrame(() => {
							frame = 0;
							if (restoring && restoreReading(body, saved, Number.isInteger(saved.historySeq))) {
								clearTimeout(settled);
								settled = setTimeout(() => { stop(); capture(); }, 1000);
							}
						});
					});
				};
				const onScroll = (event) => {
					if (event.target !== scroller()) return;
					if (restoring) restore(); else capture();
				};
				const onDisclosure = () => { requestAnimationFrame(capture); };
				node.addEventListener("scroll", onScroll, true);
				node.addEventListener("click", onDisclosure);
				node.addEventListener("toggle", onDisclosure, true);
				for (const name of ["wheel", "pointerdown", "keydown"]) node.addEventListener(name, stop, true);
				observer = new MutationObserver(restore);
				observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "aria-expanded"] });
				resize = new ResizeObserver(restore);
				const deadline = setTimeout(stop, OPEN_TIMEOUT_MS);
				readingCaptures.add(capture);
				restore();
				return () => {
					capture(); readingCaptures.delete(capture);
					stop(); clearTimeout(deadline);
					node.removeEventListener("scroll", onScroll, true);
					node.removeEventListener("click", onDisclosure);
					node.removeEventListener("toggle", onDisclosure, true);
					for (const name of ["wheel", "pointerdown", "keydown"]) node.removeEventListener(name, stop, true);
				};
			}, [key, active]);
			return h("div", { ref: root, className: "dsv-tabbody", id: "dsv-panel-" + tab.id, role: "tabpanel", "aria-labelledby": "dsv-tab-" + tab.id, hidden: !active, "data-dsv-tab-body": tab.id }, children);
		}
		//#endregion

		//#region pane body
		/** Keep native attachment rendering, but a document-level file drop belongs
		 * to one pane. File-picker callbacks run outside this short-lived routing
		 * context and continue to use their own composer normally. */
		function PaneAttachments({ renderSlot, attachments, canAcceptDrop, onAddFiles, onRemoveAttachment, uploads, onRetryFile, dropLimits }) {
			const pane = React.useContext(PaneContext);
			const tabId = pane && pane.tabId;
			const addFiles = React.useCallback((...args) => {
				if (!fileDropTarget.current || fileDropTarget.current.tabId === tabId) return onAddFiles(...args);
			}, [onAddFiles, tabId]);
			return renderSlot(nativeSlotName("conversation.input.attachments"), {
				attachments, canAcceptDrop, onAddFiles: addFiles, onRemoveAttachment, uploads, onRetryFile, dropLimits,
			});
		}

		/** Mirror native header and attachment registrations into our namespace. Keep the
		 * host's components, scoped stores, injections and extension entries; only
		 * child slot names change, so ownership stays with the original plugin. */
		function installNativeHeader(ctx) {
			const mirrors = new Map();
			const subscriptions = new Map();
			let stopped = false, syncing = false;
			const sync = () => {
				if (stopped || syncing) return;
				syncing = true;
				try {
					const wanted = new Map(), visited = new Set();
					const visit = (name) => {
						if (visited.has(name)) return;
						visited.add(name);
						if (!subscriptions.has(name)) subscriptions.set(name, ctx.slots.subscribe(name, sync));
						for (const entry of ctx.slots.entries(name)) {
							if (entry.options.id === NS + ".attachments") continue;
							wanted.set(entry, name);
							for (const key of Object.keys(entry.children || {})) visit(key);
						}
					};
					visit("conversation.header");
					visit("conversation.session");
					visit("conversation.input.attachments");
					// Release obsolete declarations before installing their replacements.
					for (const [entry, dispose] of [...mirrors].reverse()) if (!wanted.has(entry)) { dispose(); mirrors.delete(entry); }
					for (const [entry, name] of wanted) {
						if (!mirrors.has(entry)) {
							const children = entry.children && Object.fromEntries(Object.entries(entry.children).map(([key, spec]) => [nativeSlotName(key), spec]));
							const Native = entry.component;
							const Forward = (props) => {
								const pane = React.useContext(PaneContext);
								const chatScroll = React.useMemo(() => pane && name === "conversation.view" && entry.options.id === "chat" ? createNativeReadingStore(pane.readingKey) : null, [pane && pane.readingKey]);
								return h(Native, {
									...props,
									...(chatScroll ? { chatScroll } : {}),
									...(props.renderSlot ? { renderSlot: (key, owner, options) => props.renderSlot(nativeSlotName(key), owner, options) } : {}),
									...(props.renderSlotChain ? { renderSlotChain: (key, owner, options) => props.renderSlotChain(nativeSlotName(key), owner, options) } : {}),
								});
							};
							mirrors.set(entry, ctx.slots.inject(nativeSlotName(name), () => ctx.slots.register({
								...entry.options, name: nativeSlotName(name),
								...(entry.inject ? { inject: entry.inject } : {}),
								...(entry.store ? { store: entry.store } : {}),
								...(entry.locale ? { locale: entry.locale } : {}),
								...(entry.select ? { select: entry.select } : {}),
								...(children ? { children } : {}),
							}, Forward)));
						}
					}
				} finally { syncing = false; }
			};
			sync();
			return () => {
				stopped = true;
				for (const off of subscriptions.values()) off();
				for (const dispose of [...mirrors.values()].reverse()) dispose();
			};
		}

		/**
		 * Body of one pane. Registered as the `splitview.pane` list entry so the
		 * renderer hands it the owning session's scoped hooks.
		 */
		function PaneBody(props) {
			const { renderFactorySlot, renderSlot, useSession, useSessions, useConversation, sessionId, tabId } = props;
			const pane = React.useMemo(() => ({ renderSlot, tabId, readingKey: tabId + ":" + sessionId }), [renderSlot, tabId, sessionId]);
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

			return h(PaneContext.Provider, { value: pane }, h("div", { className: "dsv-conversation-shell" },
				h("div", { className: "dsv-native-header" }, renderSlot("splitview.hostHeader", {})),
				renderFactorySlot("conversation.content", { variant: "embedded", phase, hero }, { slots: { views: NativePaneViews, widthControls: WidthControls } })));
		}

		function useReferenceReady(status) {
			const [result, setResult] = React.useState({ status: null, kind: "loading" });
			React.useEffect(() => {
				setResult({ status, kind: "loading" });
				if (!status || status.kind !== "held") return undefined;
				const reference = status.reference;
				let cancelled = false;
				const timer = setTimeout(() => {
					if (!cancelled) setResult({ status, kind: "failed", message: runtime.t("loadTimeout") });
				}, OPEN_TIMEOUT_MS);
				const promise = reference && reference.ready;
				if (promise && typeof promise.then === "function") {
					promise.then(
						() => {
							clearTimeout(timer);
							if (!cancelled) setResult({ status, kind: "ready" });
						},
						(error) => {
							clearTimeout(timer);
							if (!cancelled) setResult({ status, kind: "failed", message: describeError(error) });
						},
					);
				} else {
					clearTimeout(timer);
					setResult({ status, kind: "ready" });
				}
				return () => {
					cancelled = true;
					clearTimeout(timer);
				};
			}, [status]);
			return result.status === status ? result : { kind: "loading" };
		}

		function SessionHost(props) {
			const { status, onRetry, onChoose, children } = props;
			const t = runtime.t;
			const readiness = useReferenceReady(status);
			if (!status || status.kind === "missing") return h("div", { className: "dsv-empty" }, t("loading"));
			if (status.kind === "failed" || readiness.kind === "failed") {
				return h(
					"div",
					{ className: "dsv-empty dsv-empty--error", role: "alert" },
					h("div", null, t("failedSession")),
					h("div", { className: "dsv-picker__meta" }, status.message || readiness.message || ""),
					h("div", { className: "dsv-empty__actions" },
						h("button", { type: "button", className: "dsv-linkbtn", onClick: onRetry }, t("retrySession")),
						h("button", { type: "button", className: "dsv-linkbtn", onClick: onChoose }, t("pickAnother"))),
				);
			}
			if (readiness.kind !== "ready") return h("div", { className: "dsv-empty", role: "status", "aria-label": t("loading") }, h("div", { className: "dsv-spin", "aria-hidden": true }));
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
				const fraction = pixels / drag.extent;
				const a0 = drag.base[index];
				const b0 = drag.base[index + 1];
				const pair = a0 + b0;
				const min = Math.min(MIN_FRACTION, pair / 2);
				const a = Math.min(Math.max(a0 + fraction, min), pair - min);
				const next = drag.base.slice();
				next[index] = a;
				next[index + 1] = pair - a;
				drag.next = next;
				// Resizing the actual text columns triggers expensive host layout,
				// even without React updates. Only a compositor-backed guide moves
				// during the gesture; one layout commit follows on pointer-up.
				const offset = (a - a0) * drag.extent;
				drag.preview.style.transform = orientation === "row" ? `translate3d(${offset}px,0,0)` : `translate3d(0,${offset}px,0)`;
			};

			const onPointerDown = (event) => {
				if (event.button !== undefined && event.button !== 0) return;
				if (dragRef.current) return;
				const stack = stackRef.current;
				if (!stack) return;
				const children = Array.from(stack.children);
				const panes = children.filter((node) => !node.classList.contains("dsv-resizer"));
				if (!panes[index] || !panes[index + 1]) return;
				const axis = orientation === "row" ? "width" : "height";
				const extent = stack.getBoundingClientRect()[axis] - children.filter((node) => node.classList.contains("dsv-resizer")).reduce((sum, node) => sum + node.getBoundingClientRect()[axis], 0);
				if (!(extent > 0)) return;
				const rect = event.currentTarget.getBoundingClientRect();
				const preview = document.createElement("div");
				preview.className = "dsv-resize-preview";
				preview.setAttribute("aria-hidden", "true");
				preview.setAttribute("data-axis", orientation);
				Object.assign(preview.style, { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
				document.body.appendChild(preview);
				event.preventDefault();
				event.stopPropagation();
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch (error) {
					/* capture unsupported */
				}
				dragRef.current = { base: sizes.slice(), next: sizes.slice(), pos: orientation === "row" ? event.clientX : event.clientY, delta: 0, extent, preview, stack };
				stack.setAttribute("data-dsv-resizing", orientation);
			};

			const onPointerMove = (event) => {
				const drag = dragRef.current;
				if (!drag) return;
				drag.delta = (orientation === "row" ? event.clientX : event.clientY) - drag.pos;
				if (frameRef.current !== 0) return;
				frameRef.current = requestAnimationFrame(() => {
					frameRef.current = 0;
					if (dragRef.current) applyDelta(dragRef.current.delta);
				});
			};

			const finish = (event, commit) => {
				const drag = dragRef.current;
				if (drag) {
					if (commit) {
						if (event) drag.delta = (orientation === "row" ? event.clientX : event.clientY) - drag.pos;
						applyDelta(drag.delta);
					}
					drag.preview.remove();
					drag.stack.removeAttribute("data-dsv-resizing");
				}
				dragRef.current = null;
				if (frameRef.current !== 0) {
					cancelAnimationFrame(frameRef.current);
					frameRef.current = 0;
				}
				if (drag && commit && drag.next.some((size, i) => size !== drag.base[i])) store.actions.setSizes(splitId, drag.next);
			};

			React.useEffect(() => () => finish(null, false), []);

			return h("div", {
				className: "dsv-resizer",
				role: "separator",
				"aria-orientation": orientation === "row" ? "vertical" : "horizontal",
				onPointerDown,
				onPointerMove,
				onPointerUp: (event) => finish(event, true),
				onPointerCancel: () => finish(null, false),
				onLostPointerCapture: () => finish(null, false),
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
		function TakeoverSeat() {
			return h("div", { className: "dsv-seat", "data-dsv-seat": "" });
		}

		/** Keep conversation trees in a root-scoped slot. The host's main slot
		 * remounts on each session change; it owns only the measured empty seat.
		 * A fixed surface also keeps pointer capture alive during a pane drag. */
		function StableTakeover(props) {
			const selection = runtime.uiWorkspace && runtime.uiWorkspace.selection;
			const subscribe = React.useCallback((fn) => selection ? selection.subscribe(fn) : currentList().subscribe(fn), [selection]);
			const getSession = React.useCallback(() => selection ? selection.getSnapshot().sessionId : mainViewSession(), [selection]);
			const mainSessionId = React.useSyncExternalStore(subscribe, getSession, getSession);
			const [bounds, setBounds] = React.useState(null);
			React.useLayoutEffect(() => {
				let seat = null, frame = 0;
				const resize = new ResizeObserver(() => queue());
				const measure = () => {
					frame = 0;
					const nextSeat = document.querySelector("[data-dsv-seat]");
					if (nextSeat !== seat) {
						resize.disconnect(); seat = nextSeat;
						if (seat) resize.observe(seat);
					}
					const rect = seat && seat.getBoundingClientRect();
					const next = rect && rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
					setBounds((previous) => previous && next && Object.keys(next).every((key) => previous[key] === next[key]) ? previous : next);
				};
				const queue = () => { if (!frame) frame = requestAnimationFrame(measure); };
				const observer = new MutationObserver(queue);
				observer.observe(document.body, { childList: true, subtree: true });
				window.addEventListener("resize", queue);
				measure();
				return () => { observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("resize", queue); };
			}, []);
			return h("div", {
				className: "dsv-surface",
				style: bounds ? { ...bounds, visibility: "visible" } : { visibility: "hidden", left: 0, top: 0, width: 0, height: 0 },
			}, h(Takeover, { ...props, sessionId: mainSessionId }));
		}

		/** Keep horizontal navigation local to the strip; never scroll the page. */
		function WorkspaceTabs({ children, activeKey }) {
			const viewport = React.useRef(null);
			const [edges, setEdges] = React.useState({ left: false, right: false });
			const measure = React.useCallback((reveal) => {
				const node = viewport.current;
				if (!node) return;
				const selected = reveal && node.querySelector('[aria-selected="true"]');
				if (selected) {
					const outer = node.getBoundingClientRect(), inner = selected.getBoundingClientRect();
					if (inner.left < outer.left) node.scrollLeft += inner.left - outer.left;
					else if (inner.right > outer.right) node.scrollLeft += inner.right - outer.right;
				}
				const next = { left: node.scrollLeft > 1, right: node.scrollLeft + node.clientWidth < node.scrollWidth - 1 };
				setEdges((previous) => previous.left === next.left && previous.right === next.right ? previous : next);
			}, []);
			React.useEffect(() => {
				const node = viewport.current;
				if (!node) return;
				const frame = requestAnimationFrame(() => measure(true));
				const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => measure(true)) : null;
				if (observer) observer.observe(node);
				return () => { cancelAnimationFrame(frame); if (observer) observer.disconnect(); };
			}, [activeKey, measure]);
			const scrollButton = (direction) => h("button", {
				type: "button", className: "dsv-tabscroll", disabled: !edges[direction],
				title: runtime.t(direction === "left" ? "scrollTabsLeft" : "scrollTabsRight"),
				"aria-label": runtime.t(direction === "left" ? "scrollTabsLeft" : "scrollTabsRight"),
				onClick: () => viewport.current.scrollBy({ left: (direction === "left" ? -1 : 1) * Math.max(160, viewport.current.clientWidth * .7) }),
			}, h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				h("path", { d: direction === "left" ? "M10 4 6 8l4 4" : "m6 4 4 4-4 4", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })));
			return h("div", { className: "dsv-tabs-viewport" },
				edges.left || edges.right ? scrollButton("left") : null,
				h("div", { ref: viewport, className: "dsv-workspace-tabs", onScroll: () => measure(false),
					onDragOverCapture: (event) => {
						if (hasFilePayload(event.dataTransfer)) return;
						if (!Array.from(event.dataTransfer ? event.dataTransfer.types : []).includes(TAB_DRAG_TYPE)) return;
						const node = viewport.current, rect = node.getBoundingClientRect();
						if (event.clientX < rect.left + 24) node.scrollLeft -= 18;
						else if (event.clientX > rect.right - 24) node.scrollLeft += 18;
					},
				}, children),
				edges.left || edges.right ? scrollButton("right") : null);
		}

		function Takeover(props) {
			const { renderSlot, SessionProvider, sessionId: mainSessionId } = props;
			const t = runtime.t;
			const snap = useLayout();
			const list = useSessionList();
			const groups = React.useMemo(() => listGroups(snap.root), [snap.root]);
			// The host owns one input editor per session. Do not let a hidden
			// duplicate attach that editor away from a visible conversation.
			const mountedTabs = new Set(groups.map((group) => group.activeTabId));
			const mountedSessions = new Set(groups.flatMap((group) => group.tabs.filter((tab) => tab.id === group.activeTabId).map((tab) => tab.sessionId)));
			for (const group of groups) for (const tab of group.tabs) {
				if (!tab.sessionId || mountedSessions.has(tab.sessionId)) continue;
				mountedTabs.add(tab.id);
				mountedSessions.add(tab.sessionId);
			}
			const [menu, setMenu] = React.useState(null);
			const [drop, setDrop] = React.useState(null);
			const [insertAt, setInsertAt] = React.useState(null);
			const layoutRef = React.useRef(null);
			const [paneBounds, setPaneBounds] = React.useState({});
			const dragTabRef = React.useRef(null);
			const dropRef = React.useRef(null);
			const splitRefs = React.useRef(new Map());
			const observedHost = React.useRef(mainSessionId);
			const requestedSession = React.useRef(null);
			const initialSelection = React.useRef(true);
			const keyboardFocus = React.useRef(false);

			// Flex seats arrange the split tree. Conversation groups remain keyed
			// siblings in one layer, so changing tree ancestry cannot remount them.
			React.useLayoutEffect(() => {
				const layout = layoutRef.current;
				if (!layout) return;
				const measure = () => {
					const outer = layout.getBoundingClientRect(), next = {};
					for (const seat of layout.querySelectorAll("[data-dsv-group-seat]")) {
						const rect = seat.getBoundingClientRect();
						next[seat.dataset.dsvGroupSeat] = { left: rect.left - outer.left, top: rect.top - outer.top, width: rect.width, height: rect.height };
					}
					setPaneBounds((previous) => Object.keys(previous).length === Object.keys(next).length && Object.keys(next).every((id) => previous[id] && Object.keys(next[id]).every((key) => previous[id][key] === next[id][key])) ? previous : next);
				};
				measure();
				const observer = new ResizeObserver(measure);
				observer.observe(layout);
				for (const seat of layout.querySelectorAll("[data-dsv-group-seat]")) observer.observe(seat);
				return () => observer.disconnect();
			}, [snap.root]);

			// Embedded composers autofocus when their session mounts. Focus by
			// itself is not user intent: mirroring it into mainView remounts the
			// other composer, which focuses back and starts an endless ping-pong.
			// Pointer input selects a pane directly; only Tab navigation may use
			// a subsequent focus event to select one.
			React.useEffect(() => {
				const onKey = (event) => { keyboardFocus.current = event.key === "Tab"; };
				const onPointer = () => { keyboardFocus.current = false; };
				const onDragEnd = () => {
					dragTabRef.current = null;
					dropRef.current = null;
					setDrop(null);
					setInsertAt(null);
				};
				document.addEventListener("keydown", onKey, true);
				document.addEventListener("keyup", onPointer, true);
				document.addEventListener("pointerdown", onPointer, true);
				document.addEventListener("dragend", onDragEnd, true);
				return () => {
					document.removeEventListener("keydown", onKey, true);
					document.removeEventListener("keyup", onPointer, true);
					document.removeEventListener("pointerdown", onPointer, true);
					document.removeEventListener("dragend", onDragEnd, true);
				};
			}, []);

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
			const listRevision = sessionIds.filter((id) => list && list.byId && list.byId[id]).sort().join("|");
			const { entries: held, retry: retrySession } = useHeldReferences(sessionIds, listRevision);

			const activeGroup = groups.find((group) => group.id === snap.activeGroupId) || groups[0];
			const activeTab = activeGroup ? activeGroup.tabs.find((tab) => tab.id === activeGroup.activeTabId) || activeGroup.tabs[0] : undefined;
			const activeSession = activeTab && activeTab.sessionId ? activeTab.sessionId : undefined;

			const activeKnown = Boolean(list && list.byId && list.byId[activeSession]);

			// Resolve both directions in one commit. After a sidebar change, do
			// not push this render's stale activeSession back into the workspace.
			// A request is pending only until acknowledged, never a permanent
			// "already seen" latch (A -> B -> A must still open A).
			React.useEffect(() => {
				if (initialSelection.current) {
					const hostChanged = observedHost.current !== mainSessionId;
					observedHost.current = mainSessionId;
					if (activeSession) {
						if (!activeKnown) return;
						if (activeSession !== mainSessionId) {
							if (requestedSession.current !== activeSession || hostChanged) {
								try { requestedSession.current = activeSession; runtime.uiWorkspace?.openSession(activeSession); }
								catch (error) { requestedSession.current = null; }
							}
							return;
						}
					} else if (typeof mainSessionId === "string") store.actions.adoptSession(mainSessionId);
					initialSelection.current = false;
					requestedSession.current = null;
					return;
				}
				if (observedHost.current !== mainSessionId) {
					observedHost.current = mainSessionId;
					const echo = requestedSession.current === mainSessionId;
					requestedSession.current = null;
					if (!echo && typeof mainSessionId === "string") {
						store.actions.adoptSession(mainSessionId);
						return;
					}
				}
				if (activeSession === mainSessionId) {
					requestedSession.current = null;
					return;
				}
				if (!activeSession || !activeKnown || requestedSession.current === activeSession) return;
				const workspace = runtime.uiWorkspace;
				if (workspace && typeof workspace.openSession === "function") {
					try {
						requestedSession.current = activeSession;
						workspace.openSession(activeSession);
					} catch (error) {
						requestedSession.current = null;
						console.error("[dsh-splitview] openSession failed", error);
					}
				}
			}, [mainSessionId, activeSession, activeKnown]);

			const brokenIds = new Set();
			for (const [id, entry] of held) if (entry.kind === "failed") brokenIds.add(id);

			const rowOf = (id) => (list && list.byId ? list.byId[id] : undefined);

			const setDropState = (next) => {
				dropRef.current = next;
				setDrop(next);
			};

			const onPaneDragOver = (event, group) => {
				if (hasFilePayload(event.dataTransfer)) { setDropState(null); return; }
				const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
				if (!dragTabRef.current && types.indexOf("text/plain") < 0) return;
				event.preventDefault();
				event.stopPropagation();
				// The native sidebar only allows move. Asking for copy cancels the
				// browser's real drop, even though synthetic drop events still work.
				if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
				const zone = zoneOfPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
				const current = dropRef.current;
				if (!current || current.groupId !== group.id || current.zone !== zone) setDropState({ groupId: group.id, zone });
			};

			const onPaneDrop = (event, group) => {
				if (hasFilePayload(event.dataTransfer)) {
					setDropState(null);
					dragTabRef.current = null;
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				const zone = zoneOfPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
				setDropState(null);
				const dragTab = dragTabRef.current;
				dragTabRef.current = null;
				if (dragTab) {
					if (zone === "center") store.actions.moveTab(dragTab.tabId, dragTab.groupId, group.id, group.tabs.length);
					else store.actions.moveTabToNewGroup(dragTab.tabId, dragTab.groupId, orientationOf(zone), positionOf(zone), group.id);
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
				const gapAt = (event) => {
					const tabs = Array.from(event.currentTarget.querySelectorAll(".dsv-tab"));
					let index = tabs.length;
					for (let i = 0; i < tabs.length; i += 1) {
						const box = tabs[i].getBoundingClientRect();
						if (event.clientX < box.left + box.width / 2) {
							index = i;
							break;
						}
					}
					return index;
				};
				const barDropAt = (event) => {
					if (!dragTabRef.current || hasFilePayload(event.dataTransfer)) return;
					event.preventDefault();
					event.stopPropagation();
					if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
					const index = gapAt(event);
					setInsertAt({ groupId: group.id, index });
					setDropState({ groupId: group.id, zone: "tabbar" });
				};
				const barDropCommit = (event) => {
					if (!dragTabRef.current || hasFilePayload(event.dataTransfer)) {
						setInsertAt(null);
						setDropState(null);
						dragTabRef.current = null;
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					const drag = dragTabRef.current;
					dragTabRef.current = null;
					const spot = gapAt(event);
					setInsertAt(null);
					setDropState(null);
					if (!drag) return;
					store.actions.moveTab(drag.tabId, drag.groupId, group.id, spot);
				};

				const number = groups.indexOf(group) + 1;
				const children = groups.length > 1 ? [h("span", { key: "number", className: "dsv-group-number", "aria-hidden": true, title: t("paneTabs", { number }) }, number)] : [];
				group.tabs.forEach((tab, tabIndex) => {
					const label = tab.sessionId ? titleOf(rowOf(tab.sessionId), tab.sessionId) : t("addTab");
					children.push(
						h(
							"div",
							{
								key: tab.id,
								id: "dsv-tab-" + tab.id, "aria-controls": "dsv-panel-" + tab.id,
								role: "tab",
								tabIndex: group.activeTabId === tab.id && snap.activeGroupId === group.id ? 0 : -1,
								"aria-selected": group.activeTabId === tab.id && snap.activeGroupId === group.id,
								"data-visible": group.activeTabId === tab.id,
								"data-dsv-tab": tab.id,
								"data-insert": insertAt && insertAt.groupId === group.id ? (insertAt.index === tabIndex ? "before" : insertAt.index === group.tabs.length && tabIndex === group.tabs.length - 1 ? "after" : undefined) : undefined,
								className: "dsv-tab" + (group.activeTabId === tab.id && snap.activeGroupId === group.id ? " dsv-tab--active" : "") + (tab.sessionId && brokenIds.has(tab.sessionId) ? " dsv-tab--broken" : ""),
								title: label,
								draggable: true,
								onClick: () => { store.actions.focusGroup(group.id); store.actions.setActiveTab(group.id, tab.id); },
								onKeyDown: (event) => {
									if (event.target !== event.currentTarget) return;
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										store.actions.focusGroup(group.id); store.actions.setActiveTab(group.id, tab.id);
									} else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
										event.preventDefault();
										const tabs = Array.from(event.currentTarget.closest(".dsv-workspace-tabs").querySelectorAll(".dsv-tab"));
										const index = tabs.indexOf(event.currentTarget);
										const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
										tabs[next].focus(); tabs[next].click();
									} else if (event.key === "Delete") {
										event.preventDefault(); store.actions.closeTab(group.id, tab.id);
										requestAnimationFrame(() => document.querySelector('.dsv-workspace-tabs [aria-selected="true"]')?.focus());
									}
								},
								onAuxClick: (event) => { if (event.button === 1) { event.preventDefault(); store.actions.closeTab(group.id, tab.id); } },
								onContextMenu: (event) => {
									event.preventDefault();
									event.stopPropagation();
									store.actions.focusGroup(group.id);
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
									title: t("closeTab"), "aria-label": t("closeNamedTab", { name: label }), tabIndex: -1, draggable: false,
									onDragStart: (event) => { event.preventDefault(); event.stopPropagation(); },
									onClick: (event) => {
										event.stopPropagation();
										store.actions.closeTab(group.id, tab.id);
									},
								},
								h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true }, h("path", { d: "m4 4 8 8m0-8-8 8", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" })),
							),
						),
					);
				});

				return h(
					"div",
					{
						className: "dsv-tabbar", "data-active": snap.activeGroupId === group.id, "data-dsv-tab-group": group.id,
						key: group.id,
						role: "tablist",
						"aria-label": t("paneTabs", { number: groups.indexOf(group) + 1 }),
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

			const renderBody = (group, tab) => {
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
						key: tab.sessionId,
						status: status || { kind: "missing" },
						SessionProvider,
						onRetry: () => retrySession(tab.sessionId),
						onChoose: () => store.actions.setSession(group.id, tab.id, null),
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
						style: { position: "absolute", ...(paneBounds[group.id] || {}), visibility: paneBounds[group.id] ? "visible" : "hidden" },
						onPointerDownCapture: () => store.actions.focusGroup(group.id),
						onFocusCapture: () => {
							if (!keyboardFocus.current) return;
							keyboardFocus.current = false;
							store.actions.focusGroup(group.id);
						},
						onDragOver: (event) => onPaneDragOver(event, group),
						onDrop: (event) => onPaneDrop(event, group),
					},
					h("div", { className: "dsv-body" }, group.tabs.map((tab) => h(ReadingTab, {
						key: tab.id, tab, active: tab.id === group.activeTabId,
						hidden: tab.id !== group.activeTabId, "data-dsv-tab-body": tab.id,
					}, mountedTabs.has(tab.id) ? renderBody(group, tab) : null))),
					zone ? h("div", { className: "dsv-drop", "data-zone": zone }) : null,
				);
			};

			const renderNode = (node) => {
				if (node.type === "group") return h("div", { key: node.id, className: "dsv-pane-seat", "data-dsv-group-seat": node.id, style: { flexGrow: 1, flexShrink: 1, flexBasis: 0 } });
				let stack = splitRefs.current.get(node.id);
				if (!stack) {
					stack = React.createRef();
					splitRefs.current.set(node.id, stack);
				}
				const pieces = [];
				node.children.forEach((child, index) => {
					const rendered = renderNode(child);
					pieces.push(React.cloneElement(rendered, {
						style: { ...rendered.props.style, flexGrow: node.sizes[index], flexShrink: 1, flexBasis: 0 },
					}));
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
				h("div", { className: "dsv-workspace-bar" },
					h(WorkspaceTabs, { activeKey: snap.activeGroupId + ":" + groups.map((group) => group.activeTabId + ":" + group.tabs.map((tab) => tab.id).join(",")).join("|") }, groups.map(renderTabStrip)),
					h("div", { className: "dsv-workspace-actions" },
						h("button", { type: "button", title: t("addTab"), "aria-label": t("addTab"), onClick: () => store.actions.addTab(snap.activeGroupId) }, "＋"),
						h("button", { type: "button", title: t("splitRight"), "aria-label": t("splitRight"), onClick: () => splitActive("row") }, h(IconSplit)),
						h("button", { type: "button", title: t("paneMenu"), "aria-label": t("paneMenu"), onClick: (event) => {
							if (!activeGroup || !activeTab) return;
							const box = event.currentTarget.getBoundingClientRect();
							setMenu({ x: box.left, y: box.bottom + 4, groupId: activeGroup.id, tabId: activeTab.id });
						} }, "⋯"))),
				h("div", { ref: layoutRef, className: "dsv-layout" },
					h("div", { className: "dsv-node", "data-orientation": "row" }, renderNode(snap.root)),
					h("div", { className: "dsv-pane-layer" }, groups.map(renderGroup))),
				menuGroup && menuTab ? h(TabMenu, { x: menu.x, y: menu.y, group: menuGroup, tab: menuTab, onClose: () => setMenu(null) }) : null,
			);
		}
		//#endregion

		//#region global drop veil
		/**
		 * "Drag a session onto the conversation to split there."
		 *
		 * Installed by apply(), so the gesture also works while the workspace overlay
		 * is mounting or handing control back to the host. The drop zone is painted
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
				if (!data || hasFilePayload(data)) return clear();
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
				if (hasFilePayload(event.dataTransfer)) {
					if (installer.isInstalled()) {
						const target = event.target;
						const body = target && typeof target.closest === "function" ? target.closest("[data-dsv-tab-body]") : null;
						const bar = target && typeof target.closest === "function" ? target.closest("[data-dsv-tab-group]") : null;
						const snap = store.getSnapshot();
						const group = findGroup(snap.root, bar ? bar.getAttribute("data-dsv-tab-group") : snap.activeGroupId);
						const route = { tabId: body ? body.getAttribute("data-dsv-tab-body") : group && group.activeTabId };
						fileDropTarget.current = route;
						setTimeout(() => { if (fileDropTarget.current === route) fileDropTarget.current = null; }, 0);
					}
					return;
				}
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
				fileDropTarget.current = null;
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
				paneTabs: "窗格 {number} 的会话标签",
				scrollTabsLeft: "向左滚动标签", scrollTabsRight: "向右滚动标签", closeNamedTab: "关闭标签：{name}",
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
				failedSession: "会话加载失败",
				retrySession: "重试加载",
				loadTimeout: "加载超过 30 秒，可以重试或更换会话。",
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
				paneTabs: "Session tabs for pane {number}",
				scrollTabsLeft: "Scroll tabs left", scrollTabsRight: "Scroll tabs right", closeNamedTab: "Close tab: {name}",
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
				failedSession: "Could not load this session",
				retrySession: "Retry loading",
				loadTimeout: "Loading took more than 30 seconds. Retry or choose another session.",
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
			syncing: false,
			wanted: null,
			isInstalled() {
				return typeof this.dispose === "function";
			},
			install() {
				if (!this.ctx || this.isInstalled()) return;
				const ctx = this.ctx;
				const disposers = [];
				try {
					disposers.push(ctx.slots.inject("shell.overlay", () => ctx.slots.register({
						name: "shell.overlay", id: NS, locale: NS,
						children: { "splitview.pane": { kind: "list", scope: "session" } },
					}, StableTakeover)));
					disposers.push(ctx.slots.inject("main.conversation", () => ctx.slots.register({
						name: "main.conversation", priority: -1,
					}, TakeoverSeat)));
					this.dispose = () => { for (const dispose of disposers.reverse()) dispose(); };
				} catch (error) {
					for (const dispose of disposers.reverse()) dispose();
					throw error;
				}
			},
			uninstall() {
				const dispose = this.dispose;
				this.dispose = null;
				// `wanted` records the state we last applied, so an uninstall from
				// anywhere (settings toggle, last pane closed, effect cleanup) must
				// clear it or the next sync would think the takeover is still up.
				this.wanted = false;
				if (typeof dispose === "function") {
					try {
						dispose();
					} catch (error) {
						console.error("[dsh-splitview] uninstall failed", error);
					}
				}
				// A drop in flight leaves its hint attribute on the pane under the
				// cursor; that veil must not outlive the takeover it belonged to.
				try {
					for (const node of document.querySelectorAll("[data-dsv-drop]")) node.removeAttribute("data-dsv-drop");
				} catch (error) {
					/* no document: nothing to clean */
				}
			},
			/** Keep the same tab workspace in both single and split layouts. */
			sync() {
				if (!this.ctx || this.syncing) return;
				const snap = store.getSnapshot();
				const wanted = snap.enabled;
				if (this.wanted === wanted) return;
				this.wanted = wanted;
				this.syncing = true;
				try {
					if (wanted) this.install();
					else this.uninstall();
				} catch (error) {
					// A failed install must not pin `wanted`: leaving it set makes
					// every later notify short-circuit and the takeover could then
					// never be retried or handed back without a reload.
					this.wanted = null;
					console.error("[dsh-splitview] takeover sync failed", error);
				} finally {
					this.syncing = false;
				}
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
			ctx.effect(() => {
				const onHidden = () => { if (document.visibilityState === "hidden") persistWorkspace(); };
				window.addEventListener("pagehide", persistWorkspace);
				document.addEventListener("visibilitychange", onHidden);
				return () => { window.removeEventListener("pagehide", persistWorkspace); document.removeEventListener("visibilitychange", onHidden); persistWorkspace(); };
			}, "dsh-splitview: workspace persistence");
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
				() => ctx.slots.inject("splitview.pane", () => ctx.slots.register({ name: "splitview.pane", id: "body", locale: NS,
					children: { "splitview.hostHeader": { kind: "single", scope: "session" }, "splitview.hostSession": { kind: "single", scope: "session" } },
				}, PaneBody)),
				"dsh-splitview: pane body",
			);
			ctx.effect(() => ctx.slots.inject("conversation.input.attachments", () => ctx.slots.register({
				name: "conversation.input.attachments", id: NS + ".attachments", priority: -1,
				children: { [nativeSlotName("conversation.input.attachments")]: { kind: "single", scope: "session-maybe" } },
			}, PaneAttachments)), "dsh-splitview: native attachment routing");
			ctx.effect(() => installNativeHeader(ctx), "dsh-splitview: native header bridge");

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

			// Keep the same workspace installed for single and split layouts.
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
