# dsh-splitview

VSCode 风格的标签页与分屏，作为 [DeepSeek Harness](https://github.com/deepseek-ai) 的客户端插件运行。

把多个会话并排放在中央面板里：每个分组一条标签栏，标签可跨组拖动，分组之间拖拽分隔条调整宽高，布局自动保存到 localStorage，刷新后原样恢复。

## 功能

- **编辑器组模型**：最多 3 个分组，横向或纵向排列，尺寸按比例分配（最小 15%）
- **标签页**：组内点击切换、`✕` 关闭、拖到另一分组即搬家，拖到标签栏空白处落到末尾
- **会话选择器**：空分组里点选会话即挂载，每个标签绑定一个独立会话
- **布局持久化**：组数、标签绑定、宽度比例、排列方向、活动组全部存 localStorage
- **零侵入**：注册独立的 `main` occupant，不接管 `conversation` 面板，其它面板与 DocumentTitle 语义不受影响

## 快捷键

| 操作 | 键位 |
| --- | --- |
| 横向分屏 | `Ctrl/Cmd + Shift + \` |
| 纵向分屏 | `Ctrl/Cmd + Shift + Alt + \` |
| 关闭当前标签 | `Ctrl/Cmd + Shift + W` |
| 下一个分组 | `Ctrl/Cmd + Shift + ]` |
| 上一个分组 | `Ctrl/Cmd + Shift + [` |

> 浏览器（web）环境下的 `linux` profile 不声明键位：Harness 的快捷键注册器对该 profile 只放行三组固定组合，声明其它键位会抛 `Unsupported Web shortcut`。Linux 浏览器下请用侧栏入口或面板右下角的工具栏按钮。

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

安装后左侧栏会出现「分屏视图」入口（在「智能体」和「SSH」之间）。

## 实现要点

这些是复刻过程中必须踩准的地方，记在这里免得下次重走：

- **会话内嵌靠 `SessionProvider` + `renderFactorySlot`**。每个 pane 是
  `h(SessionProvider, { session: reference }, h(FactoryOutlet))`，其中 factory 调用为
  `renderFactorySlot("conversation.content", { variant: "embedded", phase, hero }, { slots: { views: FixedChatView } })`。
  `variant: "embedded"` 是官方右侧栏 subagent chat 用的紧凑变体。
- **`inputProps` 不能与 kit 提供的 prop 重名**，否则 `assertNoPropOverlap` 直接抛错。安全的名字只有 `variant / phase / hero`。
- **kit 注入的 `useXxx` 必须传 selector**。它们是 `useSyncExternalStoreWithSelector` 的包装，裸调会 `TypeError: selector is not a function`。
- **会话列表行的字段名是投影后的**：`{ id, displayTitle, parentId, status, ... }`，不是 `{ sessionId, title, parentSessionId }`。
- **会话保活用自定义 source**（`sessions.retain(id, { source: "splitview" })`），不要用 `mainView`；用 `mainView` 会让 `DocumentTitle`、settings、open-in-app 里 `retainedBy.mainView > 0` 的查找取到错误会话。
- **快捷键必须传 `aliases`**。`ShortcutReference` 会展开 `row.aliases`，不传就把 `shell.overlay` 整条 entry 打崩。
- **pane 容器要给 `height: 100%`**，否则 embedded 会话高度塌陷。
- **CSS 用自注入 `<style data-plugin="dsh-splitview">`**，`DynamicCordisStyles` 是按 `data-plugin` 属性清理的。

## 目录结构

```
dsh-splitview/
├── client.js           # 客户端半边，全部逻辑与样式（零构建，手写 createElement）
├── index.js            # Host 半边：空 apply，仅为被 Loader 看见
├── package.json        # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml    # Loader patch：insert 一条 splitview 条目
├── icon.svg            # 侧栏图标（三条分栏矩形，用 currentColor）
└── locale/
    ├── zh.json         # meta.title / meta.description（中文）
    └── en.json         # meta.title / meta.description（英文）
```

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

## 许可

MIT，见 [LICENSE](LICENSE)。
