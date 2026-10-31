# dsh-splitview

VSCode 风格的标签页与分屏，作为 [DeepSeek Harness](https://github.com/deepseek-ai) 的客户端插件运行。

插件在中央对话区提供一条横向会话标签栏，单窗格和分屏使用同一个工作台。每个窗格保留 DSH 原生的会话标题、工具按钮、视图切换、历史跳转、工具卡片、输入框和审批按钮；关闭插件后交还原生面板。

## 怎么用

入口刻意不做成侧栏里的独立页面 —— 分屏是你正在看的这段对话的延伸，不是另一个去处。

1. **拖**：从左侧栏把一个会话拖到对话区的左/右/上/下边缘，松手即在该侧新开一个窗格；拖到中间则替换当前窗格。
2. **按钮**：会话标题栏右侧的「分屏」按钮，一键把当前会话复制到并排的新窗格。
3. **快捷键**：`Ctrl/Cmd + Shift + \` 向右分屏，`+ Alt` 向下分屏。
4. **设置**：`settings.section` 里的「分屏视图」段可以整体开关、调整最大窗格数（2–8，默认 4）、重置布局。

分屏之后的日常操作：

- 顶部横向标签栏汇集各窗格的会话，按窗格分组；点标签同时激活对应窗格，`✕` 关闭（关掉最后一个标签则连同窗格一起收起）
- 标签可以拖到顶部另一窗格的标签分组，跨窗格搬家；右侧 `＋`、分屏和菜单按钮作用于当前窗格
- 分组编号与激活提示使用 DSH 的主题色；后台标签、正在其他窗格显示的标签与当前标签分别呈现。标签过多时可用两侧按钮滚动，激活标签自动露出，拖到标签栏边缘也会滚动。
- 拖动插入线对应实际顺序；拖到某个窗格的左／右／上／下边缘，会在目标边缘拆出标签。跨窗格移动保留标签 ID 和阅读记忆；单标签向自身边缘拆分时，在新窗格打开相同会话。
- 鼠标中键或聚焦标签后按 `Delete` 可关闭；左右方向键切换标签，`Home`／`End` 跳到首尾。关闭后台标签不会切走当前会话。
- 每个窗格保留原生的「对话／轨迹／上下文／编队」及扩展视图入口；聊天右侧的轮次导航在窄窗格中也显示，可直接跳转历史
- 标签右键：关闭标签 / 关闭其他 / 关闭右侧 / 向右拆分 / 向下拆分 / 关闭窗格
- 窗格之间拖拽分隔条调整比例（最小 12%）：拖动时显示分隔线位置预览，松手后一次性更新窗格宽度，避免长会话在每一帧反复重排；窗格内容过窄时内容宽度自动收窄
- 布局（树结构、方向、比例、每个标签绑定的会话、活动窗格）存进 localStorage，刷新原样恢复
- 每个标签分别记住阅读位置、底部跟随状态和已渲染卡片的展开状态；切换标签、跨窗格移动及重新打开 DSH 后恢复。恢复优先使用消息锚点，以适应窗格宽度变化；锚点不在当前已加载历史中时使用滚动位置回退。
- 会话加载失败会显示原因，可直接「重试加载」或「换一个会话」，标签和窗格保留；等待超过 30 秒也会提供恢复入口。

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

安装后，中央对话区顶部会出现横向会话标签栏，侧栏会话选择与标签保持同步。

## 实现要点

这些是复刻过程中必须踩准的地方，记在这里免得下次重走：

- **接管靠 `priority: -1`，内容生命周期放在根级**。`main.conversation` 是 `single` slot，插件用低优先级值放入一个占位区域，官方条目保留，卸载即自动回退。实际工作台树位于根级 `shell.overlay`，跟随占位区域的位置和尺寸显示；切换宿主会话只替换占位区域，不重新加载各窗格，也不中断手柄的鼠标捕获。启用时单窗格也保留标签栏。
- **布局树与会话树分离**。Flex 占位节点负责分割比例，`ResizeObserver` 将位置尺寸映射到统一窗格层。会话窗格始终是同一父节点下的带 key 兄弟节点；新增、移动或合并布局分支不会重新挂载未参与操作的会话。
- **原生标题栏和视图通过独立 slot 命名空间桥接**。`register()` 不能再次声明宿主已有的 child slot；插件递归镜像 `conversation.header`、`conversation.session` 及其子条目，并转发子 slot 名称，保留原组件、会话作用域 store、依赖注入和扩展按钮。聊天条目的原生阅读器从对应标签的记忆初始化，避免会话级旧缓存覆盖标签位置。监听原生 slot 的动态变化，卸载时释放镜像。
- **会话内嵌靠 `SessionProvider` + `renderFactorySlot`**。每个窗格是
  `h(SessionProvider, { session: reference }, renderSlot("splitview.pane", ...))`，窗格体内调用
  `renderFactorySlot("conversation.content", { variant: "embedded", phase, hero }, { slots: { views: NativePaneViews, widthControls: WidthControls } })`。`NativePaneViews` 转发原生 `conversation.session`，视图选择仍使用原生 store，不强制为 chat。
  `variant: "embedded"` 是官方右侧栏 subagent chat 用的紧凑变体。
- **`inputProps` 不能与 kit 提供的 prop 重名**，否则 `assertNoPropOverlap` 抛错。安全的名字只有 `variant / phase / hero`。
- **kit 注入的 `useXxx` 必须传 selector**。它们是 `useSyncExternalStoreWithSelector` 的包装，裸调会 `TypeError: selector is not a function`。
- **会话列表行的字段名是投影后的**：`{ id, displayTitle, parentId, retainedBy, ... }`，不是 `{ sessionId, title, parentSessionId }`。
- **会话保活用自定义 source**（`sessions.retain(id, { source: "splitview" })`），不要用 `mainView`；用 `mainView` 会让 `DocumentTitle`、settings、open-in-app 里 `retainedBy.mainView > 0` 的查找取到错误会话。retain 要增量维护：全量 release 再 re-retain 会让引用归零的会话被 `retireScope`，每切一次标签就重挂一次会话。
- **刷新时布局可能比会话列表先就绪**。`uiWorkspace.openSession(id)` 对着一个还不在 `list.byId` 里的 id 会抛 `sessions.retain: unknown session`，所以桥接 effect 必须先用 `known(id)` 守卫。
- **快捷键必须传 `aliases`**。`ShortcutReference` 会展开 `row.aliases`，不传就把 `shell.overlay` 整条 entry 打崩。
- **全局拖放挂在 `apply()` 的 `ctx.effect` 里**。document 级监听在工作台挂载和回退期间也有效，提示靠给区域元素打 `data-dsv-drop` 属性 + CSS 伪元素，不额外插 DOM。
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

运行回归测试：`npm test`（仅使用 Node.js 内置测试运行器，无需安装依赖）。测试执行实际客户端 bundle 的状态模型、窗格事件处理和同步 effect，覆盖自动聚焦、Tab/指针激活、会话往返切换、列表更新、尺寸调整以及退出接管。

侧栏原生拖动使用 `effectAllowed: "move"`，窗格目标也必须请求 `dropEffect: "move"`。请求 `copy` 会被浏览器拒绝，表现为有分屏预览却无法松手放置；直接派发合成 `drop` 事件无法检出这个问题。回归用例同时检查允许的操作类型、单窗格和已有分屏中的放置结果，以及取消拖动后的预览清理。

连接已启用远程调试的 DSH 后，可运行 `npm run test:dsh`。默认端口为 `9227`，用 `DSH_DEBUG_PORT` 更改。测试从单窗格开始，使用 Chromium 原生拖放、鼠标和键盘输入，覆盖同组排序、跨窗格往返、四边分屏、阅读锚点恢复、分隔条、各种关闭方式与标签溢出导航；结束时清理临时标签并恢复原有选择和阅读位置。已有多个窗格时会直接退出，不改动用户的分割比例。

界面测试需通过 `DSH_TEST_SESSION_A`、`DSH_TEST_SESSION_B` 指定两个现有测试会话的标题；阅读恢复用例需要第二个会话具有可滚动的历史。测试不发送消息。设置 `DSH_UI_SCREENSHOT` 为绝对文件路径可保存顶部标签栏截图。

```powershell
$env:DSH_TEST_SESSION_A = '测试会话 A'
$env:DSH_TEST_SESSION_B = '测试会话 B'
npm run test:dsh
```

阅读记忆使用 `dsh-splitview:reading:v1`，按标签 ID 与会话 ID 分开存储，最多保留最近 100 个记录。记录只包含滚动位置、消息锚点及展开状态，不额外保存消息正文或输入草稿。独立会话的后台标签保持挂载；同会话的隐藏副本延迟挂载，避免占用宿主的会话输入编辑器。跨窗格移动、刷新或重启后，从阅读记忆恢复；日常激活窗格时保持原会话组件与 DOM。

阅读记录还保留已加载历史的首个事件序号 `historySeq`。恢复旧消息位置前，通过原生 `loadThrough` 补齐历史，再恢复卡片与消息锚点；底部跟随无需补载旧历史。恢复期间观察异步卡片、字体等引起的内容尺寸变化，用户滚动或输入则立即接管。旧版不含 `historySeq` 的记录仍可读取。

页面离开、窗口隐藏及插件卸载时，先采集各活动标签的最新阅读位置，再同步写出阅读记录与布局，避免最后一次操作落在延迟写入窗口内而丢失。启动时优先恢复保存的活动窗格，完成宿主会话确认后再接收正常的侧栏切换。

重试会先取得新的会话引用，再释放旧引用，避免引用计数归零导致会话作用域被销毁；旧请求晚到的成功或失败结果不会覆盖重试后的状态。

分隔条在按下时缓存几何尺寸，移动时只通过 `requestAnimationFrame` 更新独立预览线的 `transform`，不发布布局状态，也不改动聊天内容宽度；松手后只提交一次比例。取消拖动或丢失鼠标捕获会移除预览，保持原布局。

窗格激活只响应指针操作或 Tab 导航。内嵌输入框挂载时产生的自动聚焦不能切换宿主会话，否则两个输入框会不断触发对方重新挂载，造成来回闪回。宿主会话与活动窗格由同一个 effect 协调；收到侧栏切换时先更新布局，避免把该次渲染中的旧会话写回宿主。

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
