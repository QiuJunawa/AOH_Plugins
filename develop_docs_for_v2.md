# 插件开发 2.0（index-v2.html）

适用：Agent-On-HTML **v2**（`AH.*` 架构，`body` 上有 `nav.rail` 和多个 `section.page`）。
不适用：旧版 `index.html`（`body[data-mode]` + `switchPage()`）。两套机制**不兼容**，照抄旧文档的页面代码必然出错。

本文的接口全部在真实页面里实测过（记录见第 13 节）。凡标「源码」的结论，都注明在哪个文件哪段逻辑。

---

## 0. 五分钟上手

```javascript
// 1) 注册工具（下一轮就能被 AI 调用）
AgentAPI.defineTool('demo_echo', {
  description: '回显文本',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text']
  }
}, async function (args, ctx) {
  return '收到：' + String(args.text || '');
});

// 2) 卸载时清理（不写也能跑，但热重载会留垃圾）
onUnload(function () {
  // remove 定时器 / 监听器 / 注入的 DOM
});

AgentAPI.toast('插件已加载', 'ok');
```

存成 `/plugins/<id>.js`（配 `<id>.json`），启用后立即生效。

要我（小匣）代写时：`plugin_create` 建、`plugin_update` 改、`plugin_toggle` 启停。**改之前先 `check_code` 查语法**。

完整可运行模板：`/projects/plugin-dev-v2/template.js`（带独立页面 + 2 个工具，23 条断言实测通过）。

---

## 1. 与旧文档的差异 —— 先看这个

| 能力 | 旧文档（index.html） | 实际 v2 | 后果 |
| --- | --- | --- | --- |
| 切页 | `document.body.dataset.mode = 'x'` + `body[data-mode=x]` CSS | `section.page` 的 `[hidden]` 属性 | 页面永远不显示 |
| 页面挂载点 | `document.querySelector('.app')` | `document.body` | 塞进 `.app` 会抢对话栏 |
| 导航容器 | `.nav-rail` | `nav.rail`，按钮进 `.rail-top` | 按钮插不进去 |
| 导航按钮 | `.nav-rail-btn[data-mode]` | `.rail-btn[data-page]` | 选择器全空 |
| 切页函数 | 全局 `switchPage()` | `AH.app.setPage()`，且**只认** chat/vfs/tasks/plugins | 调不到 / 调了也不管你的页 |
| 插件工具下发 | 属于 `plug:<id>` 分组，要 `tools_expand` 展开 | **永远下发**，与懒加载无关 | 白折腾；工具多了反而涨 token |
| `AgentAPI.version` | 文档说有 | **不存在** | `undefined` |

`.app` 是 `grid-template-columns: 264px minmax(0,1fr) 0`（侧栏 / 对话 / 编辑器）。
往里面 append 一个 section，它会占 `1fr` 那一列 —— 这就是「插件页占了对话页」的真实原因。

---

## 2. 插件是什么

**存放**

```
/plugins/<id>.js     ← 代码
/plugins/<id>.json   ← { name, version, enabled, description }
```

`id` 规则：`/^[a-zA-Z0-9_.-]{1,60}$/`（字母、数字、下划线、横线、点）。

**执行方式**（源码 `plugins.js · loadOne`）

```javascript
new AsyncFunction('AgentAPI', 'onUnload', code + '\n//# sourceURL=plugin://<id>.js')
```

即：顶层可以用 `await`，但**没有 `require` / `import`**，也**拿不到插件自己的文件路径**。
`sourceURL` 让报错栈显示成 `plugin://<id>.js`，调试时认这个。

**权限：与页面等同。** 能读写整个 VFS、读全部配置（**含 `apiKey` 和 `gitToken`**）、发任意网络请求、改 DOM。所以默认禁用，启用时用户会看到确认框。

---

## 3. 生命周期

```
页面启动 boot()
  └─ AH.plugins.loadAll()
       └─ 遍历 /plugins/*.json，只加载 enabled 的
            └─ loadOne(id) → 执行代码 → 注册工具
```

- **加载失败**：捕获后 `unregister(id)` 并 toast 报错，其它插件继续加载。
- **热重载**：`P.save()` = 先 `unloadOne(id)`（跑 `onUnload` + 注销工具），再 `loadOne(id)`。所以改造期间不必刷新页面。
- **禁用/删除**：`unloadOne` 同样会跑 `onUnload`。
- **`onUnload` 里的异常会被吞掉**（`console.warn`），不会中断别的清理函数。

**结论：`onUnload` 必须把自己的东西全撤干净**，否则热重载后旧监听器还在跑，会出现「点一次按钮触发两次」这类幽灵 bug。

**推荐写法：加载时先做幂等清理**

```javascript
(function cleanup() {
  const b = document.querySelector('.rail-btn[data-page="' + ID + '"]');
  if (b) b.remove();
  const p = document.getElementById(ID + 'Page');
  if (p) p.remove();
  const s = document.getElementById(ID + 'Style');
  if (s) s.remove();
})();
```

这样即使上次卸载没跑干净，这次加载也能收拾掉，不必重启页面。

---

## 4. AgentAPI 参考（实测清单）

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `VFS` | object | `AH.vfs` 本身，见第 8 节 |
| `cfg` | object | `AH.cfg`：`get / set / patch / on / data / defaults` |
| `toast(msg, type?, ms?)` | fn | `type` 取 `'ok'` / `'err'` / `'warn'`，默认约 2400ms |
| `getConversation()` | fn | 返回 `AH.chat.conv`（当前对话消息数组） |
| `executeTool(name, args, ctx?)` | async fn | 调任意工具（内置或插件）。不传 `ctx` 时 `run/signal` 为 `null` |
| `defineTool(name, spec, handler)` | fn | 注册工具 |
| `registerTool(...)` | fn | 与 `defineTool` 完全相同 |
| `pluginId` | string | 自己的 id |

**没有** `version`、`confirm`、`fetch` 包装、`storage`。要确认框直接用 `AH.ui.confirm`，要存储用 `localStorage` 或 `AgentAPI.cfg`。

**`AH` 上可用的模块**（`window.AH`，非官方但稳定）：
`app / chat / tools / plugins / ui / cfg / vfs / db / util / md / memory / todos / settings / git / zip / undo / knowledge / taskRegistry / agent`

常用的：
- `AH.util`：`esc / normPath / baseName / extName / joinPath / fmtSize / fmtTime / debounce / uid / sleep / estimateTokens / downloadBlob / copyText`
- `AH.ui`：`toast / error / confirm / openModal / closeModal / contextMenu / icon / mountIcons`
- `AH.md.toHtml(text)`：把 Markdown 转 HTML（**输出已过滤**，可直接插入）
- `AH.app.setPage(name)`、`AH.app.page`

---

## 5. 注册工具

### 5.1 命名规则

```javascript
/^[a-z][a-z0-9_]{1,40}$/
```

小写字母开头，**总长 2–41**（单字母非法）。以下会直接抛错：

- 与内置工具重名（`read_file`、`check_code`、`wait`、`render_chart`、`tools_expand`… 全部 `AH.tools.SPECS`）
- 与**其它插件**已注册的工具重名

所以推荐前缀自己的插件名：`horizonmods_search`、`demo_echo`。

### 5.2 spec 两种写法都能吃

```javascript
// A. 直接给（推荐）
AgentAPI.defineTool('x_tool', {
  description: '...',
  parameters: { type: 'object', properties: {...}, required: [...] }
}, handler);

// B. 包一层 function（OpenAI 原生格式，等价）
AgentAPI.defineTool('x_tool', {
  function: { name: 'x_tool', description: '...', parameters: {...} }
}, handler);
```

内部会统一成 `{type:'function', function:{name, description, parameters}}`。
`parameters` 必须是合法 JSON Schema 子集；缺省时自动变成 `{type:'object', properties:{}}`。

`description` 是模型判断「该不该调」的唯一依据，写清**什么时候用**和**返回什么**。

### 5.3 handler 签名

```javascript
async function (args, ctx) { return '要回灌给模型的字符串'; }
```

`ctx` 内容：

| 字段 | 说明 |
| --- | --- |
| `run` | 当前 Agent 运行对象；插件工具被 AI 调用时有值，被页面按钮调用时为 `null` |
| `signal` | `AbortSignal`，用户点停止时触发 |
| `callId` | 本轮调用的 id |
| `confirm(opts)` | 等价 `AH.ui.confirm`，返回 `Promise<boolean>` |

### 5.4 返回值三条硬规则

1. **一定转成字符串**：`PruneResult(String(r))`，返回对象会变成 `[object Object]`。要返回结构化数据就 `JSON.stringify(obj, null, 2)`。
2. **超过 30000 字符会被裁剪**：保留前 22000 + 后 6000，中间插省略提示。别一次吐大表。
3. **返回 `null`/`undefined` 会变成 `（无返回）`**。

### 5.5 调度：插件工具一律按「写操作」串行

源码 `tools.js · buildSpecs` + `agent.js`：只读集合 `EXEC_READONLY` 里**只有内置工具名**，插件工具不在其中。

后果：
- 插件工具**不会**和其它只读工具并行，一律进串行队列 → 慢工具会拖慢整轮。
- 想让长任务不卡住，就把工作拆小，或者自己起 `setTimeout` 后台跑、工具只返回「已开始」。

### 5.6 下发规则：插件工具永远在工具列表里

源码 `tools.js · buildSpecs` 末段（注释原文：*插件注册的工具由用户显式启用，始终并入工具列表*）：

```javascript
if (AH.plugins && AH.plugins.specs) {
  for (const sp of AH.plugins.specs()) {
    const nm = sp.function && sp.function.name;
    if (nm && keep(nm)) out.push(sp);
  }
}
```

- **不受 `lazyTools` 影响**，不需要 `tools_expand`。
- 不存在 `plug:<id>` 分组（`AH.tools.GROUPS` 只有 `fs/net/task/compute/media/system/git/plugin`）。
- 每个插件工具都会占用**每一轮**的提示词预算 → 一个插件注册 5 个以上工具就要想清楚是否都必要。
- 用户可在「设置 → 工具」里禁用某个工具（`cfg.disabledTools`）：禁用后既不下发，调用也直接抛「该工具已被用户在设置中禁用」。

---

## 6. 做页面

### 6.1 v2 的真实机制

页面是挂在 `body` 上的 `section.page`，靠 `hidden` 属性显隐：

```css
.page { position: fixed; inset: 0 0 0 56px; background: var(--bg);
        display: flex; flex-direction: column; z-index: 20; }
.page[hidden] { display: none; }
```

`inset` 左边留出 56px 给 `nav.rail`，`z-index: 20` 压在 `.app` 之上。

宿主原生只有 4 个页：`chat`（就是 `.app` 本身）、`vfs`、`tasks`、`plugins`。

```javascript
// app.js · setPage 的真实逻辑
function setPage(page) {
  App.page = page;
  document.querySelectorAll('.rail-btn[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  const app = document.querySelector('.app');
  app.style.display = page === 'chat' ? '' : 'none';
  $('tasksPage').hidden = page !== 'tasks';
  $('vfsPage').hidden = page !== 'vfs';
  $('pluginsPage').hidden = page !== 'plugins';
}
```

注意它对**未知页名**的处理：把 `.app` 藏起来、所有按钮取消 active，然后**不管你的页**。所以插件得自己接三步。

### 6.2 三步同步

```javascript
function showPage() {
  // ① 让宿主收起 .app 与它自己的三个页
  AH.app.setPage(ID);                      // 未知页名 → .app.style.display = 'none'
  ['pluginsPage', 'tasksPage', 'vfsPage'].forEach(function (pid) {
    const el = document.getElementById(pid);
    if (el) el.hidden = true;
  });
  // ② 点亮自己的导航按钮（setPage 会把所有按钮的 active 取消）
  document.querySelectorAll('.rail-btn[data-page]').forEach(function (b) {
    b.classList.toggle('active', b.dataset.page === ID);
  });
  // ③ 显示自己
  page.hidden = false;
}
```

离开时要反向收拾：

```javascript
// 点了别的导航按钮 → 收起自己
document.addEventListener('click', function (e) {
  const btn = e.target.closest && e.target.closest('.rail-btn[data-page]');
  if (btn && btn.dataset.page !== ID) hidePage();
}, true);

// 宿主重新显示 .app（比如用户点回对话、或从设置关掉）→ 收起自己
new MutationObserver(function () {
  if (appEl.style.display !== 'none') hidePage();
}).observe(appEl, { attributes: true, attributeFilter: ['style'] });
```

用捕获阶段（第三个参数 `true`），保证在宿主自己的 handler 之前跑。

### 6.3 页面骨架

```javascript
const ID = 'my-plugin';   // 用作 data-page，别和 chat/vfs/tasks/plugins 撞

const page = document.createElement('section');
page.id = ID + 'Page';
page.className = 'page ' + ID + '-page';
page.hidden = true;                       // 必须初始 hidden
page.innerHTML = [
  '<div class="page-head">',
  '  <div><h2>标题</h2><p>副标题</p></div>',
  '  <button class="chip-btn" type="button">动作</button>',
  '</div>',
  '<div style="flex:1;min-height:0;overflow:auto;padding:16px 26px">内容</div>'
].join('\n');
document.body.appendChild(page);          // ← body，不是 .app

const railTop = document.querySelector('nav.rail .rail-top');
const navBtn = document.createElement('button');
navBtn.type = 'button';
navBtn.className = 'rail-btn';
navBtn.dataset.page = ID;
navBtn.title = '标题';
navBtn.setAttribute('aria-label', '标题');
navBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">…</svg>';
railTop.appendChild(navBtn);
```

### 6.4 页面检查清单

- [ ] `section` 挂在 `body`，有 `page` 类，初始 `hidden`
- [ ] `data-page` 不与 `chat/vfs/tasks/plugins` 冲突
- [ ] 按钮进 `nav.rail .rail-top`（`rail-bottom` 是主题/设置，别占）
- [ ] 按钮里有 `<svg>`（`.rail-btn` 只给尺寸和颜色，没图标会是个空方块）
- [ ] 内容区 `flex: 1; min-height: 0; overflow: auto`（否则长列表把头部挤出屏幕）
- [ ] 三种离开路径都收得回：点自己的按钮、点别人的按钮、宿主重新显示 `.app`
- [ ] `onUnload` 删掉 page / button / style 并恢复到 `chat`

---

## 7. 样式与主题

**优先复用宿主 CSS 变量**，深色/浅色自动跟随（浅色是 `body.light`）：

| 变量 | 用途 |
| --- | --- |
| `--bg` / `--bg-soft` | 页面底色 / 次级底色 |
| `--panel` / `--panel-2` / `--panel-3` | 卡片 / 按钮底 / 更深的底 |
| `--line` / `--line-soft` | 边框 / 更淡的分隔线 |
| `--text` / `--text-2` / `--text-3` | 正文 / 次要 / 弱化文字 |
| `--accent` / `--accent-soft` | 主色 / 主色浅底 |
| `--danger` / `--danger-soft`、`--ok`、`--warn` | 语义色 |
| `--input`、`--mono`、`--font-ui`、`--font-body`、`--fs`、`--shadow` | 输入框底、等宽字体、字体族、字号、阴影 |

**可直接用的类**（省得自己写）：

| 类名 | 效果 |
| --- | --- |
| `.page` / `.page-head` | 页面容器 / 带标题栏的头部（含 `h2`、`p` 样式） |
| `.chip-btn` | 小按钮；加 `.primary` 主色、`.danger` 危险色 |
| `.icon-btn` | 32×32 图标按钮 |
| `.empty-tip` | 居中空态提示 |
| `.stat-pill` | 小统计胶囊（`b` 里放数值） |
| `.seg` + `.seg-btn`（`.active`） | 分段切换 |
| `.toast`（`.ok` / `.err` / `.warn`） | 提示条样式 |

自己写的样式**务必加前缀**，别污染全局：

```javascript
style.textContent = '#' + ID + 'Page .my-row { ... }';
```

---

## 8. VFS 用法

`AgentAPI.VFS` 就是 `AH.vfs`。

| 方法 | 说明 |
| --- | --- |
| `read(path)` | async，返回字符串；文件不存在/是目录会抛错 |
| `write(path, content, opts?)` | async，**自动创建父目录**；`opts.silent` 可跳过变更通知 |
| `append(path, text, atLine?)` | async，`atLine` 给了就插入到该行后（0-based） |
| `mkdir(path)` | async，已存在且是目录则直接返回 |
| `remove(path, opts?)` | async，目录递归删 |
| `move(from, to)` | async |
| `list(path)` | 同步，返回 `[{path, type, size, mtime}]`；目录不存在抛错 |
| `stat(path)` / `exists(path)` | 同步，`stat` 返回节点或 `null` |
| `on(fn)` | 监听变更，返回退订函数。`fn(pathSet, rev)` |
| `search(kw)`、`stats()`、`exportFiles()`、`importFiles()` | 搜索 / 统计 / 整库导出导入 |

**没有 `copy`**，复制用 `write(to, await read(from))`。

**⚠️ 撤销的坑**：`undo_last` 只回滚**内置工具**记下的快照（`UNDO.record` 只在内置 handler 里调用）。
**插件直接写 VFS 的改动不进撤销栈，用户按撤销撤不回来。** 要可撤销就走 `AgentAPI.executeTool('write_file', {...})`，代价是会多一层确认框与裁剪。

**路径一律绝对路径**，内部会 `normPath`，`..` 会被规范化。

---

## 9. 安全

1. **能读到密钥**：`AgentAPI.cfg.data.apiKey` / `gitToken` 明文可取。插件代码里**永远不要**把它们写进 VFS、DOM、toast 或返回值。
2. **破坏性操作要确认**：
   ```javascript
   const ok = await ctx.confirm({
     title: '删除',
     text: '将删除 ' + path + '，不可恢复。',
     danger: true,              // 默认就是 true，红色按钮
     rememberKey: 'myplugin-del' // 用户可勾「本次会话内不再询问」
   });
   if (!ok) return '用户取消了操作';
   ```
   非破坏性操作记得显式 `danger: false`，否则也是红按钮。
3. **外部数据一律转义**：`AH.util.esc()` 或 `AH.md.toHtml()`（已过滤）。别把接口返回的 HTML 直接 `innerHTML`。
4. **第三方代码**：从插件库安装的东西，描述和标签不等于安全证明。装之前看代码摘录。
5. 别在插件里 `eval` 用户输入，也别把 `innerHTML` 拼进未转义的字符串。

---

## 10. 调试

### 10.1 语法检查

`check_code(path=..., language='js')` —— 不执行，只查语法。

### 10.2 用 HTML 沙箱做真实行为测试

`check_code(language='html')` 会在沙箱 iframe 里**真实执行内联脚本**，能把「造一个假宿主 + 引入插件代码 + 跑断言」这一套跑完。这是验证插件页面逻辑最有效的办法。

套路（见 `/tmp/tpl-test.html`）：

1. 照 `index-v2` 的真实结构写 mock：`nav.rail` + `.app`（grid）+ `section.page`
2. 照 `app.js` 原样实现一个 `setPage`（只认 4 个内置页）
3. 实现 `AsyncFunction` 的等价环境：给出 `AgentAPI`（`defineTool` 存表、`executeTool` 调表、`VFS` 用内存 object）
4. `（引用失败：文件不存在：/plugins/xxx.js）` 把插件代码整段引进来
5. 断言：结构挂载位置、切页显隐、离开时收拾、工具返回、确认拒绝分支、卸载还原
6. 最后 `throw new Error('RESULT-PASS')` 或 `RESULT-FAIL | 原因`，从运行时错误里读结果

关键：**mock 必须照真实结构写**。我之前用旧文档的结构写 mock，测试全绿但真机全错 —— 假宿主会验证假结论。

### 10.3 运行时自检工具

给插件加一个 `xxx_status` 工具，返回「数据是否加载、条数、来源、最后错误、页面是否打开」。排查时一句话就能定位，比翻控制台快。

### 10.4 报错来源定位

报错栈显示 `plugin://<id>.js`。插件抛错后宿主会 `unregister(id)` 并 toast —— 所以在 `try/catch` 里自己兜住，给出可读原因。

---

## 11. 发布到官方插件库

清单：`https://qiujunawa.github.io/AOH_Plugins/index.json`

```json
{
  "plugins": [
    {
      "id": "my-plugin",
      "name": "显示名",
      "version": "1.0.0",
      "description": "一句话说明",
      "author": "作者",
      "tags": ["tag1", "tag2"],
      "file": "my-plugin.js",
      "tools": ["myplugin_search", "myplugin_download"],
      "homepage": "https://..."
    }
  ]
}
```

- 单文件，**≤ 1MB**（超了直接拒装）
- `id` 需符合 `^[a-zA-Z0-9_.-]{1,60}$`，否则条目被跳过
- 装完默认**未启用**，要用户再点一次启用
- 装之前会弹确认框，显示来源 URL + 前 900 字符代码摘录

---

## 12. 错误对照

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 页面挤在对话栏 | section 挂进了 `.app` | 改挂 `document.body` |
| 页面完全不显示 | 用了 `body[data-mode]` 那套 | 用 `hidden` 属性 |
| 导航没出现 | 选择器是 `.nav-rail` | 用 `nav.rail .rail-top`，类名 `.rail-btn` |
| 导航按钮是个空方块 | 忘了塞 `<svg>` | `innerHTML` 里加图标 |
| 点自己的按钮没反应 | 没调 `AH.app.setPage(ID)`，`.app` 盖在上面 | showPage 里先调它 |
| 切到别的页后自己还亮着 | 少了全局 click 捕获监听 | `addEventListener('click', fn, true)` |
| `defineTool` 抛「工具名…」 | 名字太短 / 大写 / 撞名 | `^[a-z][a-z0-9_]{1,40}$`，加插件前缀 |
| 工具返回 `[object Object]` | 直接 return 了对象 | `JSON.stringify` |
| 工具结果被截断 | 超过 30000 字符 | 分页/分段返回 |
| 工具点了没被调用 | 用户在设置里禁用了 | 查 `cfg.disabledTools` |
| `AgentAPI.version` 是 undefined | 该字段不存在 | 别用 |
| 热重载后事件触发两次 | 旧监听器没撤 | 加载时幂等清理 + `onUnload` |
| `VFS.read` 抛「文件不存在」 | 路径没规范化 / 文件真没有 | 先 `exists()` 判断 |

---

## 13. 验证记录

本文结论的来源分三类：

**A. 读源码**（`https://qiujunawa.github.io/Agent-On-HTML/js/`）

| 结论 | 出处 |
| --- | --- |
| 插件存 `/plugins/<id>.js` + `.json`，`AsyncFunction` 执行 | `plugins.js · loadOne / save` |
| `AgentAPI` 成员清单 | `plugins.js · apiFor()` |
| 工具名规则、撞名检查、spec 归一化 | `plugins.js · register()` |
| 插件工具**永远下发**，无 `plug:` 分组 | `tools.js · buildSpecs` 末段 |
| 只读集合不含插件工具 → 串行 | `tools.js · EXEC_READONLY` |
| 结果裁剪 30000（22000+6000） | `tools.js · pruneResult` |
| 撤销只记内置 handler | `tools.js · UNDO.record` 调用点 |
| `setPage` 只认 4 个页 | `app.js · setPage` |
| `.page` / `.app` 布局与 z-index | 运行时 `getComputedStyle` |
| 确认框选项与默认 `danger:true` | `ui.js · UI.confirm` |
| VFS 方法表、`write` 自动建父目录 | `store.js · VFS` |
| 插件库清单字段、1MB 上限 | `plugins.js · libNormalize / fetchLibCode` |

**B. 真实页面实测**（临时诊断插件读取运行时对象）

- `AgentAPI` 实际成员：`VFS / cfg / toast / getConversation / executeTool / defineTool / registerTool / pluginId` —— 确认**无 `version`**
- `AH.tools.GROUPS` 实际键：`fs net task compute media system git plugin` —— 确认**无 `plug:*`**
- `AH.util` / `AH.ui` / `AH.md` / `AH.chat` 成员表
- `/plugins/horizon-mods.js` 真机挂载：`#horizonmodsPage` 的 `parent=body`、`inApp=false`、点击后 `.app` 隐藏 / 本页 `display:flex` 全屏

**C. 沙箱行为测试**

- 模板 `/projects/plugin-dev-v2/template.js`：仿 v2 宿主跑 23 条断言全过（结构 / 切页 / 离开收拾 / 工具返回 / 确认拒绝 / 卸载还原）
- 对照实验：同一份 UI 代码配「旧文档结构」的 mock 也全绿 —— 证伪了「mock 过了就是对的」

**未验证**：多插件同时开页时的按钮 active 竞争（理论上各插件只认自己的 `data-page`，互不干扰，但没做双插件实测）；`AH.md.toHtml` 的过滤强度（只看了它是个现成入口，没做 XSS 对抗测试）。

---

## 14. 一句话总结

v2 的插件 = **`body` 上的一个 `section.page` + `nav.rail` 里一个按钮 + `hidden` 属性切页 + 自己维护 active 状态**；
工具 = **`defineTool` 注册后永远下发、按写操作串行、返回字符串且 ≤30k**。
旧文档里关于「页面」和「工具分组」的两节都过时了，别照抄。
