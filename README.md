# dsh-splitview

VSCode 风格的标签页与分屏，作为 [DeepSeek Harness](https://github.com/deepseek-ai) 的客户端插件运行。

它不是另一个页面，而是**当前对话区的一种状态**：当你把对话区拆成两个以上窗格时，插件接管中央面板，把每个窗格渲染成一个完整的、可交互的会话（历史、工具卡片、输入框、审批按钮都在）；拆回单窗格时自动交还，宿主原样显示。

## 怎么用

入口刻意不做成侧栏里的独立页面 —— 分屏是你正在看的这段对话的延伸，不是另一个去处。

1. **拖**：从左侧栏把一个会话拖到对话区的左/右/上/下边缘，松手即在该侧新开一个窗格；拖到中间则替换当前窗格。
2. **按钮**：会话标题栏右侧的「分屏」按钮，一键把当前会话复制到并排的新窗格。
3. **快捷键**：`Ctrl/Cmd + Shift + \` 向右分屏，`+ Alt` 向下分屏。
4. **设置**：`settings.section` 里的「分屏视图」段可以整体开关、调整最大窗格数（2–8，默认 4）、重置布局。

分屏之后的日常操作：

- 每个窗格一条标签栏，点标签切换，`✕` 关闭（关掉最后一个标签则连同窗格一起收起）
- 标签可以拖到另一个窗格的标签栏，跨窗格搬家
- 标签右键：关闭标签 / 关闭其他 / 关闭右侧 / 向右拆分 / 向下拆分 / 关闭窗格
- 窗格之间拖拽分隔条调整比例（最小 12%），窗格内容过窄时内容宽度自动收窄
- 布局（树结构、方向、比例、每个标签绑定的会话、活动窗格）存进 localStorage，刷新原样恢复

## 快捷键

| 操作 | 键位 |
| --- | --- |
| 横向分屏 | `Ctrl/Cmd + Shift + \` |
| 纵向分屏 | `Ctrl/Cmd + Shift + Alt + \` |
| 关闭当前标签 | `Ctrl/Cmd + Shift + W` |
| 下一个窗格 | `Ctrl/Cmd + Shift + ]` |
| 上一个窗格 | `Ctrl/Cmd + Shift + [` |

> 浏览器（web）环境下的 `linux` profile 不声明键位：Harness 的快捷键注册器对该 profile 只放行三组固定组合，声明其它键位会让 `register()` 抛 `Unsupported Web shortcut`。Linux 浏览器下请用标题栏按钮或拖拽。

## 安装

插件通过 Harness 自带的 `plugin_manager` 安装，指向本地绝对路径即可：

```bash
# 在 profile 目录下
cd ~/.dsh/profiles/<profile>
pnpm add "/absolute/path/to/dsh-splitview"
```

或者用 DSH 的 `plugin_manager` 工具：

```
plugin_manager({ action: "install_bundle", target: "/absolute/path/to/dsh-splitview" })
```

安装后**不会**出现侧栏入口。它是通过接管中央面板生效的：把对话区拆开就会看到。

## 实现要点

这些是复刻过程中必须踩准的地方，记在这里免得下次重走：

- **接管靠 `priority: -1`**。`main.conversation` 是 `single` slot，渲染时按注册顺序升序取第一条；用 `priority: -1` 注册自己的 occupant，官方那条仍留在表里，卸载即自动回退。只在窗格数 > 1 且插件启用时接管，单窗格时完全不碰宿主。
- **`register()` 不能抢别人的子 slot**。官方 entry 已声明 `conversation.header`，自己再声明同名 child 会抛 `SlotOwnershipError`；所以接管态不渲染官方 header，只渲染自己的标签栏。
- **会话内嵌靠 `SessionProvider` + `renderFactorySlot`**。每个窗格是
  `h(SessionProvider, { session: reference }, renderSlot("splitview.pane", ...))`，窗格体内调用
  `renderFactorySlot("conversation.content", { variant: "embedded", phase, hero }, { slots: { views: FixedChatView, widthControls: PaneWidthControls } })`。
  `variant: "embedded"` 是官方右侧栏 subagent chat 用的紧凑变体。
- **`inputProps` 不能与 kit 提供的 prop 重名**，否则 `assertNoPropOverlap` 抛错。安全的名字只有 `variant / phase / hero`。
- **kit 注入的 `useXxx` 必须传 selector**。它们是 `useSyncExternalStoreWithSelector` 的包装，裸调会 `TypeError: selector is not a function`。
- **会话列表行的字段名是投影后的**：`{ id, displayTitle, parentId, retainedBy, ... }`，不是 `{ sessionId, title, parentSessionId }`。
- **会话保活用自定义 source**（`sessions.retain(id, { source: "splitview" })`），不要用 `mainView`；用 `mainView` 会让 `DocumentTitle`、settings、open-in-app 里 `retainedBy.mainView > 0` 的查找取到错误会话。retain 要增量维护：全量 release 再 re-retain 会让引用归零的会话被 `retireScope`，每切一次标签就重挂一次会话。
- **刷新时布局可能比会话列表先就绪**。`uiWorkspace.openSession(id)` 对着一个还不在 `list.byId` 里的 id 会抛 `sessions.retain: unknown session`，所以桥接 effect 必须先用 `known(id)` 守卫。
- **快捷键必须传 `aliases`**。`ShortcutReference` 会展开 `row.aliases`，不传就把 `shell.overlay` 整条 entry 打崩。
- **全局拖放不要挂在 `shell.overlay` 的组件里**。单窗格（未接管）正是这个手势唯一有用的场景，而那时浮层组件不一定被挂载；挂在 `apply()` 的 `ctx.effect` 里用 document 级监听才可靠，提示靠给区域元素打 `data-dsv-drop` 属性 + CSS 伪元素，不额外插 DOM。
- **官方的宽度手柄公式在窄窗格会算出负宽度**。`(100% - contentWidth) / 2 - 48` 在窗格窄于内容上限时变负，手柄宽度被 clamp 成 0 而消失；用 `max(12px, ...)` 兜底。
- **CSS 用自注入 `<style data-plugin="dsh-splitview">`**，`DynamicCordisStyles` 是按 `data-plugin` 属性清理的。

## 目录结构

```
dsh-splitview/
├── client.js           # 客户端半边，全部逻辑与样式（零构建，手写 createElement）
├── index.js            # Host 半边：空 apply，仅为被 Loader 看见
├── package.json        # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml    # Loader patch：insert 一条 splitview 条目
├── icon.svg            # 插件图标（三条分栏矩形，用 currentColor）
└── locale/
    ├── zh.json         # meta.title / meta.description（中文）
    └── en.json         # meta.title / meta.description（英文）
```

`client.js` 内部分区：`constants` / `styles` / `state model`（布局树 + store + localStorage）/ `runtime wiring` / `width controls` / `pane body` / `session picker` / `resizer` / `geometry helpers` / `context menu` / `takeover` / `global drop` / `settings section` / `header entry` / `locale` / `shortcuts` / `installer` / `apply`。

## 开发

没有构建步骤。`client.js` 直接是浏览器加载的产物：

```js
window.__ModuleLoader__.load({
  id: "dsh-splitview",
  factory: (require) => {
    const React = require("react");
    // ...
    return module.exports;
  },
});
```

改动 `client.js` 后刷新页面即生效（安装是指向本目录的 junction/symlink 时），无需重装。JSX 不可用，一律 `React.createElement`。

注意一个坑：Harness 的客户端 watcher 按「入口包名 + 绝对路径」缓存产物。如果本插件曾经用另一个绝对路径装过，改完文件刷新可能加载不到新代码 —— 把旧路径恢复成指向本目录的 junction，或 `plugin_manager` 里 disable 再 enable 一次。

## 许可

MIT，见 [LICENSE](LICENSE)。
