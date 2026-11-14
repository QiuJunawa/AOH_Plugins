# 插件开发文档

> 一句话：插件是放在 `/plugins/<id>.js` 里的一段 JS，在页面主作用域里执行，能通过 `AgentAPI.defineTool` 给 AI 注册新工具。
> 对应应用版本：`2026.11.14.14`（与本文档阅读时的 index.html 一致；版本变了请以代码为准）。
>
> 目录：1–7 基础（文件结构 / 执行机制 / defineTool / AgentAPI / VFS / onUnload）· 8–10 运维与分发 · 11–12 调试排错 · **13 新建一个页面（图标库）** · **14 往已有页面加东西（Claw 模式）** · 15–17 安全 / 模板 / 速查。

---

## 1. 插件是什么

一个插件 = 两个文件：

```
/plugins/<id>.js    ← 代码，真正执行的东西
/plugins/<id>.json  ← 元信息，决定显示名、版本、是否启用
```

`<id>` 规则：`/^[a-zA-Z0-9_\-.]+$/`，即只允许字母、数字、下划线、横线、点。**不要**用中文、空格、斜杠。

元信息只有三个字段，都是必需的：

```json
{
  "name": "显示名，可以写中文",
  "version": "1.0.0",
  "enabled": false
}
```

- `enabled: true` 的插件会在页面启动时自动加载；`false` 只是躺在目录里，什么都不做。
- 通过插件页或 `plugin_create` / `plugin_update` 保存时，**只会写回这三个字段**。你手写的其他字段会被覆盖掉，别往里塞数据。

插件页只扫 `/plugins/*.json` 来列表。只有 `.js` 没有 `.json`，界面上看不见；只有 `.json` 没有 `.js`，会显示出来但加载时报"插件代码为空"。

---

## 2. 代码是怎么被执行的

加载时应用做的是这件事（等价写法）：

```js
const fn = new AsyncFunction('AgentAPI', 'onUnload', 你的代码);
await fn(这份插件专属的 api, 注册清理函数);
```

由此得到几条硬事实：

| 事实 | 含义 |
| --- | --- |
| 代码跑在**函数作用域**里 | 顶层的 `var/let/const/function` 不会污染 `window`，同一个插件内的函数能互相访问（闭包），但**两个插件之间互相看不到** |
| 参数里就有 `AgentAPI` | 直接用，不要写 `window.AgentAPI`，更不要给它赋值 |
| 内部可以直接 `await` | 顶层就可以，不需要包 async IIFE |
| **加载期抛出异常 = 加载失败** | 会 toast 报错，本次已注册的工具全部撤销，插件不进已加载列表 |
| 代码为空 / 只有空白 | 提示"插件代码为空"，直接跳过 |

每个插件拿到的是**自己专属的 api 对象**（原型指向全局 `AgentAPI`），差别只有一处：`AgentAPI.pluginId` 被钉死成你的 id。所以不管在加载期还是在工具 handler 里读 `pluginId`，拿到的都对。

---

## 3. 最小插件

```js
AgentAPI.toast('Hello from plugin');
```

保存为 `/plugins/hello.js`，配一个 `enabled: true` 的 `hello.json`，刷新页面就能看到右下角提示。

---

## 4. 注册工具：defineTool 完全手册

```js
AgentAPI.defineTool('demo_word_count', {
  description: '统计一段文字的字符数与行数。用户要求数一下字数时用。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要统计的文字' }
    },
    required: ['text']
  }
}, async (args, ctx) => {
  const text = String((args && args.text) || '');
  return {
    chars: text.length,
    lines: text ? text.split('\n').length : 0
  };
});
```

签名：`defineTool(name, spec, handler)` → 返回工具名。别名 `registerTool`，完全等价。

### 4.1 工具名的约束（违反会抛错，导致整插件加载失败）

| 约束 | 细节 |
| --- | --- |
| 格式 | 正则 `/^[a-z][a-z0-9_]{1,40}$/` —— **小写字母开头**，总长 **2–41**，只能小写字母 / 数字 / 下划线 |
| 横线 | **不允许**。`my-tool` 是错的，写 `my_tool` |
| 大写 | 不允许 |
| 与内置重名 | 不允许。内置工具的完整清单见 `/knowledge/20-tools.md`，常见的坑是 `read_file` `search_files` `run_js` |
| 与 `tools_expand` 冲突 | 不允许（它是懒加载元工具） |
| 跨插件重名 | 不允许，哪怕另一个插件没启用。**强烈建议加插件前缀**：`wordcount_search` 而不是 `search` |
| 同一插件内重复 | 不允许 |

### 4.2 什么时候能调 defineTool

**必须在加载期调用**（也就是插件代码最外层那一段）。

加载期结束后 `_loadingPluginId` 会被清空，此时再调 `defineTool`，注册出来的工具归属是空的 —— 工具能用，但**卸载插件时不会被注销**，会变成孤儿工具，`plugin_list` 会专门报一行"未归属已加载插件的工具"。

所以：别在 handler 里、`setTimeout` 里、`onclick` 里调 `defineTool`。

### 4.3 spec 怎么写

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `description` | 强烈建议 | **模型就是靠它决定调不调用**。写清"什么时候用"，不要写"这是个工具" |
| `parameters` | 可选 | 标准 JSON Schema。不传等价于 `{ type: 'object', properties: {} }`，也就是无参数工具 |
| 其他字段 | — | 会被忽略（`type`、`function` 这两层是应用自己拼的） |

`parameters` 里常用的就是 `type: 'object'`、`properties`、`required`；每个属性的 `description` 也请写，模型看得见。

### 4.4 handler 与返回值

签名：`handler(args, ctx)`，可以返回 Promise（写成 async 即可）。

`args` 是模型传来的参数对象，**不要假设字段一定存在**，一律 `String(args.x || '')` 这样兜。

`ctx` 里有：`VFS`、`cfg`、`toast`、`getConversation()`、`executeTool(name, args, onChunk, refCtx)`。和全局 `AgentAPI` 上那几个是同一份东西，只是省得写前缀。

返回值会被这样处理：

| 你返回 | 模型看到 |
| --- | --- |
| 字符串 | 原样 |
| 对象 / 数组 / 数字 | `JSON.stringify(r, null, 2)` |
| `undefined` / `null` | `工具 <名> 执行完成（无返回值）` |
| 抛出异常 | `插件工具 <名> 执行失败：<message>`，对话不中断 |

**输出长度**：工具结果整段进模型上下文，会让 Token 暴涨。超过几千字符请自己截断，并明确写"共 N 字符，已截断"。大结果建议落盘到 `/tmp/` 再只回一段摘要 + 路径。

### 4.5 重要：插件工具默认不在工具列表里（懒加载）

为了省 Token，模型每轮只拿到核心 4 个文件工具 + `tools_expand`。插件注册的工具收在分组 **`plug:<你的插件id>`** 里，**不会自动出现**。

- AI 要把它展开才能看见、才能调：`tools_expand({ groups: ["plug:hello"] })`（把 hello 换成你的 id）
- 展开状态在本对话内保持，不需要反复展开。
- 如果用户在设置里关掉了懒加载（`cfg.lazyTools === false`），所有插件工具直接常驻。

写插件的说明文档时，请把这一条写进去，否则用户会以为插件没生效。

---

## 5. AgentAPI 参考

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `AgentAPI.VFS` | 对象（**活引用**） | 虚拟文件系统实例，见第 6 节。改它就是改用户的真实文件 |
| `AgentAPI.cfg` | 对象（**活引用**） | 应用配置，**含 apiKey、baseUrl 等敏感字段**。只读使用，不要外发、不要写进文件 |
| `AgentAPI.toast(msg, type)` | 函数 | 右下角气泡。`type` 传 `'err'` → 红色、停留 5 秒；其他值或不传 → 普通、2.4 秒 |
| `AgentAPI.getConversation()` | 函数 | 当前对话消息数组（活引用，别改它） |
| `AgentAPI.executeTool(name, args, onChunk, refCtx)` | async 函数 | 调用任意内置或插件工具，返回其文本结果。**会走完整执行管线**，包括危险操作确认弹窗 |
| `AgentAPI.version` | 字符串 | 应用版本，如 `2026.11.14.14`。做兼容判断时用 |
| `AgentAPI.defineTool(name, spec, handler)` | 函数 | 注册工具，见第 4 节。别名 `registerTool` |
| `AgentAPI.pluginId` | 字符串 | 当前插件 id，加载期和 handler 里都正确 |

红线：

- `AgentAPI` 是页面全局对象。**不要给 `window.AgentAPI` 赋新值**，不要 `delete` 它的成员 —— 会波及所有插件和应用本体。
- `VFS` / `cfg` / 对话数组都是**活引用**，不是副本。你 push 一下对话数组，用户就真的看到多了一条消息。

---

## 6. VFS 参考

| 方法 | 返回 | 坑 |
| --- | --- | --- |
| `VFS.norm(path)` | 归一化路径 | 相对路径自动补 `/`，`..` 会被消解 |
| `VFS.stat(path)` | `{ path, type, size, mtime }` 或 `null` | `type` 是 `'file'` / `'dir'` |
| `VFS.exists(path)` | bool | 只看元数据，不读正文 |
| `VFS.listDir(path)` | `{ dirs: [], files: [] }` 或 `null` | **dirs 每项带尾斜杠**（`'sub/'`），files 不带；路径不存在或不是目录**返回 null**（不是抛错） |
| `await VFS.getContent(path)` | 字符串 / `null` / `undefined` | 三态！`null` = 文件不存在；`undefined` = 文件存在但正文拿不到（云端拉取失败 / 被同步清空）。**别把 undefined 当空字符串**，那会覆盖用户数据 |
| `await VFS.writeFile(path, content)` | bool | `true` = 新建，`false` = 覆盖。父目录自动创建，会进撤销栈 |
| `await VFS.appendFile(path, content)` | bool | 内部读-改-写，不是原子操作 |
| `await VFS.createDir(path)` | bool | 已存在返回 false |
| `await VFS.deletePath(path)` | bool | **递归删除，没有回收站**。删之前先给用户确认 |
| `VFS.allFiles()` | 路径数组 | 只含文件，不含目录 |
| `VFS.totalSize()` | number | 所有文件 size 之和 |

两个容易踩的点：

1. `size` 是 **UTF-8 字节数**（写的时候用 `TextEncoder` 算的），但界面文件树显示的是字符数，两个数字对不上，别惊讶。
2. 批量读大文件要克制：`getContent` 会走 IndexedDB / 云端拉取，几十次串行读会很慢。

---

## 7. onUnload：清理资源

```js
const timer = setInterval(tick, 1000);
const onKey = (e) => { /* ... */ };
document.addEventListener('keydown', onKey);

onUnload(() => clearInterval(timer));
onUnload(() => document.removeEventListener('keydown', onKey));
```

- 触发时机：禁用插件、删除插件、改代码后重载、插件库更新覆盖、点「重新加载」。
- 应用会逐个调用你注册的函数；单个抛异常只打 warn，不影响其余。
- 同时被强制注销的还有你这个插件注册的**全部工具**。
- **不写清理 = 定时器、监听器、DOM 节点会一直留在页面里**，禁用后还在跑，反复启停会叠加多份。

---

## 8. 让 AI 直接写插件（plugin_* 工具）

| 工具 | 作用 | 注意 |
| --- | --- | --- |
| `plugin_list` | 列出现有插件的 id / 名称 / 版本 / 启用状态，以及各自注册了哪些工具 | 只读；还会报"未归属已加载插件的工具"（孤儿检测） |
| `plugin_create` | 新建插件，写 `.js` + `.json` | 执行前弹窗（含代码前 12 行摘要）；`enabled` 默认 **false** |
| `plugin_update` | 改代码或元信息，保存后自动卸载旧实例再重载 | 改代码会弹窗；改启用状态走 toggle 的警告流程 |
| `plugin_toggle` | 启用 / 禁用 | 启用会弹一次"插件能完全控制这个页面"的确认 |
| `plugin_delete` | 连 `.js` `.json` 一起删，并注销其工具 | 弹窗 + 不可撤销 |

推荐的开发闭环：

1. 定工具名（避开内置工具，加插件前缀）。
2. `plugin_create`，先 `enabled: false`，让用户看清代码摘录再决定。
3. 用户同意后 `plugin_toggle` 启用。
4. `tools_expand({ groups: ["plug:<id>"] })` 展开，然后自己调一次自测。
5. 有问题 `plugin_update` 改，改完自动重载，回到第 4 步。

---

## 9. 插件页操作（用户视角）

| 操作 | 行为 |
| --- | --- |
| 「+ 新建插件」 | 填 id / 版本 / 是否启用，下面写代码，点保存 |
| 启用 / 禁用 | 启用前弹权限警告；禁用时连带注销工具、执行 onUnload |
| 编辑 | **跳到 VFS 页打开 `/plugins/<id>.js`**，改完保存。此时磁盘代码 ≠ 内存里跑的代码 |
| 重新加载 | 只做「卸载 → 按磁盘代码加载」，不动 `enabled`，所以**不会再弹一次权限确认**。仅在检测到代码不一致时出现 |
| 删除 | 两个文件一起删，不可撤销 |

代码被改过后，插件页该行状态会变成琥珀色的**「代码已改动」**，旁边多出一个「重新加载」按钮。这就是"我改了代码为什么不生效"的标准答案。

---

## 10. 插件库（分发你的插件）

插件库是远端一份清单 + 一堆独立 `.js`。仓库根放 `index.json`：

```json
{
  "plugins": [
    {
      "id": "word-count",
      "name": "字数统计",
      "version": "1.0.0",
      "description": "统计一段文字的字数与行数",
      "author": "someone",
      "tags": ["text", "utility"],
      "file": "word-count.js",
      "tools": ["wordcount_run"],
      "homepage": "https://example.com"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 必填，非法 id 的条目会被整条丢弃 |
| `file` | 相对仓库根解析；也可以写绝对 URL（方便挂 CDN） |
| `tools` | 只是给用户看的提示，实际能力以代码里的 `defineTool` 为准 |
| `tags` | 最多取前 8 个，用于搜索 |

机制细节：

- 默认库地址是 `https://qiujunawa.github.io/AOH_Plugins/`；GitHub Pages 自带 `Access-Control-Allow-Origin: *`，能直接 fetch，不用代理。
- 清单缓存 5 分钟；单个插件代码上限 1MB。
- 安装 / 更新都会**弹窗展示来源 URL 和代码摘录**；安装完默认未启用。
- 插件库是**第三方代码**，页面这一侧不假设它可信。用户凭描述判断安全性是不靠谱的。

---

## 11. 调试

- 插件文件带 `//# sourceURL=plugin://<id>.js`，DevTools 报错会显示这个虚拟文件名，断点也能下。
- 加载 / 卸载有日志：`[plugin] loaded: <id> 工具: a, b`、`[plugin] unloaded: <id> 注销工具 N 个`。
- 最快的自测：先 `AgentAPI.toast(...)` 看有没有加载成功，再让 AI 直接调你的工具，返回值原样进对话。
- 工具的调用记录会出现在「任务 / 工具流」页，标注来源插件 id。

---

## 12. 排错对照表

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| toast「插件代码为空：x」 | `.js` 不存在或全是空白 | 检查 `/plugins/x.js` |
| toast「插件加载失败 x：工具名只能用小写字母开头…」 | 工具名不合法 | 2–41 字符、小写字母开头、只含小写字母数字下划线 |
| 「与内置工具重名」 | 撞了内置工具 | 换名，加插件前缀 |
| 「已被其他插件注册」 | 跨插件撞名 | 加插件前缀，如 `myplug_search` |
| 「工具名与懒加载元工具冲突」 | 用了 `tools_expand` | 换名 |
| AI 说"没有这个工具" | 插件工具走懒加载 | 先 `tools_expand({ groups: ["plug:<id>"] })` |
| 禁用后定时器还在跑 | 没写 `onUnload` | 见第 7 节 |
| `plugin_list` 出现"未归属已加载插件的工具" | 在 handler / 异步回调里调了 `defineTool` | 把注册挪到加载期 |
| 启用后刷新页面就没了 | json 里 `enabled` 不是 true | 插件页重新启用 |
| 改了代码行为没变 | 内存里跑的还是旧代码 | 点「重新加载」或禁用再启用 |
| 读文件拿到 `undefined`，写回去变成空文件 | 把"内容不可用"当成了空字符串 | 见第 6 节三态说明 |
| 自定义页面切过去一片空白 | 没把 `<section>` 挂到 `.app`，或 `page.className` 与 CSS 选择器字面不一致 | 见 13.2 / 13.4 |
| 自定义页面和侧栏、对话区并排挤着 | 漏了「把别人的面板藏掉」那几条 CSS | 见 13.2 的坑 |
| 导航按钮点了没反应 | 按钮没写 `data-mode`（委托靠它路由），或插件加载得比宿主还早 | 补 `data-mode`，见 13.3 第 4 步 |
| 禁用插件后整页空白 | `onUnload` 里没「若停在自建页则切回 chat」 | 见 13.6 |
| 设置页新标签点了没反应 | ≤ 2026.11.14.14 的旧宿主是逐个绑 click，抓不到后插入的按钮；新版已改委托 | 新版查 `data-tab` 是否写了；旧版自己绑，见 14.2 |
| 设置页标签切了但面板不显示 | `data-tab` 与 `data-pane` 名字不一致 | 两边写成同一个字符串 |
| 插件设置保存后刷新就丢 | 直接写了 `localStorage` 没走 `saveCfg()` | 见 14.4 |
| 插进文件树 / 对话区的东西自己消失 | 那些容器由应用 `innerHTML` 重绘 | 见 14.6 |

---

## 13. 场景 A：给插件做一个新页面（以「图标库」为例）

### 13.1 页面是怎么切出来的

应用只有 7 个内置 mode：`chat` / `tools` / `vfs` / `settings` / `plugins` / `autotask` / `codespace`。切换全靠两件事：

1. `document.body.dataset.mode = mode`（即 `<body data-mode="...">`）
2. 一段 CSS：「`data-mode` 命中时显示这一页，其余页面和对话区全部隐藏」

插件加页面就是把这两件事自己复制一遍，用一个没人占用的 mode 名。

`switchPage(mode)`（全局函数）只做三件事：写 `body.dataset.mode`、按 `data-mode` 刷新左侧按钮的 `.active`、对**内置** mode 触发各自的渲染函数。它不认识你的 mode —— 不会报错，也**不会帮你渲染**，你的页面渲染得自己触发。

### 13.2 四个必备动作

| # | 动作 | 不做会怎样 |
| --- | --- | --- |
| 1 | 幂等清理三个痕迹 | 禁用再启用后出现两份页面 / 两个导航按钮 |
| 2 | 注入 `<style>`：默认藏 + 命中时显示 + **把别人的面板藏掉** | 见下方坑 |
| 3 | 注入 `<section>` 到 `.app` | 没挂载点，切过去一片空白 |
| 4 | 注入导航按钮到 `.nav-rail`，**必须带 `data-mode`** | 委托找不到 `data-mode` → 点了没反应，只能用 AI 工具打开 |

**最容易踩的坑**：`index.html` 里的「隐藏其他面板」只覆盖内置 mode（`body[data-mode="tools"] .sidebar, ... .editor { display:none !important }` 那一段）。你不写这条，切到自己的页面会看到页面和侧栏、对话区并排挤着。

### 13.3 骨架代码（可直接改造）

> 下面这份是**精简教学版**，为了短把图标解析、尺寸切换、别名搜索都省了。
> 完整实现见仓库里的 `/plugins/svg-gallery.js`（真实插件 id 是 `svg-gallery`，mode 名 `svggallery`），想看真实排版细节直接读它。

```js
/* icongallery 插件 · 往左侧导航加一个「图标库」页 */

// 自定义 mode。别用 chat / tools / vfs / settings / plugins / autotask / codespace
const PAGE_ID = 'icongallery';
const PAGE_TITLE = '图标库';
const PAGE_ICON = '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true">' +
  '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>' +
  '<rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';

/* ---------- 1. 幂等清理：禁用后再启用，不会留下两份 ---------- */
function cleanup() {
  const b = document.querySelector('.nav-rail-btn[data-mode="' + PAGE_ID + '"]'); if (b) b.remove();
  const p = document.getElementById('icongalleryPage'); if (p) p.remove();
  const s = document.getElementById('icongalleryStyle'); if (s) s.remove();
}
cleanup();

/* ---------- 2. 样式：默认藏；data-mode 命中时铺满；并把别人的三栏藏掉 ---------- */
const style = document.createElement('style');
style.id = 'icongalleryStyle';
style.textContent = [
  '.icongallery-page { display: none; }',
  'body[data-mode="' + PAGE_ID + '"] .icongallery-page { display: flex; flex: 1; min-width: 0; flex-direction: column; background: var(--bg-main); }',
  'body[data-mode="' + PAGE_ID + '"] .sidebar,',
  'body[data-mode="' + PAGE_ID + '"] .chat,',
  'body[data-mode="' + PAGE_ID + '"] .editor,',
  'body[data-mode="' + PAGE_ID + '"] .tools-page,',
  'body[data-mode="' + PAGE_ID + '"] .plugins-page,',
  'body[data-mode="' + PAGE_ID + '"] .cs-page,',
  'body[data-mode="' + PAGE_ID + '"] .autotask-page { display: none !important; }',
  '.icongallery-page .page-body { padding: 16px; overflow: auto; display: flex; flex-wrap: wrap; gap: 10px; }',
  '.ig-cell { width: 88px; padding: 10px 0; display: flex; flex-direction: column; align-items: center; gap: 6px;' +
    ' border: 1px solid var(--border); border-radius: 10px; background: var(--bg-panel);' +
    ' cursor: pointer; font-size: 10.5px; color: var(--text-muted); }',
  '.ig-cell:hover { border-color: var(--accent); color: var(--text-primary); }',
  '.ig-cell .ico-svg { width: 26px; height: 26px; }'
].join('\n');
document.head.appendChild(style);

/* ---------- 3. 页面本体，挂到 .app 里 ---------- */
const page = document.createElement('section');
page.id = 'icongalleryPage';
page.className = PAGE_ID + '-page';        // 必须和上面 CSS 里的 .icongallery-page 对上
page.innerHTML =
  '<div class="page-header">' +
    '<span class="ph-title">' + PAGE_ICON + PAGE_TITLE + '</span>' +
    '<span style="font-size:12px;color:var(--text-muted)">读 VFS 的 /index.html 现解析 ICON_PATHS</span>' +
    '<div style="flex:1"></div>' +
    '<button class="ghost-btn" id="igReload" type="button">重新读取</button>' +
  '</div>' +
  '<div class="page-body" id="igGrid">正在读取…</div>';
document.querySelector('.app').appendChild(page);

/* ---------- 4. 导航按钮 ---------- */
const nav = document.querySelector('.nav-rail');
const navBtn = document.createElement('button');
navBtn.type = 'button';
navBtn.className = 'nav-rail-btn';
navBtn.dataset.mode = PAGE_ID;
navBtn.title = PAGE_TITLE;
navBtn.setAttribute('aria-label', PAGE_TITLE);
navBtn.innerHTML = PAGE_ICON;
if (nav) nav.appendChild(navBtn);

function openPage() {
  if (typeof window.switchPage === 'function') window.switchPage(PAGE_ID);
  else document.body.dataset.mode = PAGE_ID;   // 兜底：switchPage 还没定义时直接改 data-mode
}
// 宿主已对 .nav-rail 做事件委托，读到 data-mode 就调 switchPage，所以这行在 2026.11.14.15+ 是可省的。
// 保留它是为了兼容旧版宿主（那时是逐个 addEventListener，抓不到后来插入的按钮）；重复调用无副作用。
navBtn.addEventListener('click', openPage);

/* ---------- 5. 渲染：从磁盘上的 /index.html 现读图标表 ---------- */
let ICONS = {};   // name -> 内联 SVG 片段

// 从源码里截一个对象字面量（图标 path 里不含花括号，简单配平就够用）
function pickLiteral(src, re) {
  const hit = src.search(re);
  if (hit < 0) return null;
  const start = src.indexOf('{', hit);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  return null;
}

async function loadIcons() {
  const grid = document.getElementById('igGrid');
  const src = await AgentAPI.VFS.getContent('/index.html');
  if (src === null) { ICONS = {}; if (grid) grid.textContent = '/index.html 不存在'; return; }
  if (src === undefined) { ICONS = {}; if (grid) grid.textContent = '/index.html 内容读不到（云端拉取失败）'; return; }
  const lit = pickLiteral(src, /const ICON_PATHS\s*=\s*\{/);
  if (!lit) { ICONS = {}; if (grid) grid.textContent = '没找到 ICON_PATHS，写法可能变了'; return; }
  ICONS = new Function('return ' + lit)();
  render();
}

function render() {
  const grid = document.getElementById('igGrid');
  if (!grid) return;
  const names = Object.keys(ICONS);
  if (!names.length) { grid.textContent = '没有图标'; return; }
  grid.innerHTML = names.map(n =>
    '<div class="ig-cell" data-name="' + n + '" title="icon(\'' + n + '\')">' +
      '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[n] + '</svg>' +
      '<span>' + n + '</span></div>'
  ).join('');
}

// 事件委托：上百个格子不逐个绑
page.addEventListener('click', (e) => {
  const cell = e.target.closest ? e.target.closest('.ig-cell') : null;
  if (cell) AgentAPI.toast("用法：icon('" + cell.dataset.name + "')");
});

const reloadBtn = document.getElementById('igReload');
if (reloadBtn) reloadBtn.addEventListener('click', () => { loadIcons(); AgentAPI.toast('已重新读取'); });

loadIcons();

/* ---------- 6. 给 AI 一个开关入口 ---------- */
AgentAPI.defineTool('icongallery_open', {
  description: '打开「图标库」页，浏览 index.html 内置的全部 SVG 图标（ICON_PATHS）。用户想挑图标时用。',
  parameters: { type: 'object', properties: {} }
}, async () => {
  openPage();
  if (!Object.keys(ICONS).length) await loadIcons();
  return '已打开「图标库」页，当前读到 ' + Object.keys(ICONS).length + ' 个图标';
});

/* ---------- 7. 卸载：还原三样 + 若正停在本页先撤回对话页 ---------- */
onUnload(() => {
  if (document.body.dataset.mode === PAGE_ID) {
    if (typeof window.switchPage === 'function') window.switchPage('chat');
    else document.body.dataset.mode = 'chat';
  }
  cleanup();
});
```

### 13.4 细节与约束

| 要点 | 说明 |
| --- | --- |
| id 要带插件前缀 | `.app` 里所有 `<section>` 是**兄弟关系**，id 撞了会互相覆盖；`getElementById` 只认第一个 |
| `page.className` 与 CSS 必须字面一致 | `PAGE_ID + '-page'` = `icongallery-page`，少个横线就是永久 `display:none` |
| 挂载点 | 页面 → `document.querySelector('.app')`；导航 → `document.querySelector('.nav-rail')` |
| `switchPage` 的可用性 | 它是全局 `function` 声明，`window.switchPage` 能拿到；但插件可能加载得比它早，所以一律先 `typeof` 判断再回落改 `data-mode` |
| 别手动 `style.display = 'flex'` | 显隐全交给 CSS + `data-mode`，否则会和 `switchPage` 抢状态，切走切回就对不上 |
| 直接复用宿主样式类 | `.page-header` / `.ph-title` / `.page-body` / `.ghost-btn` / `.icon-btn` / `var(--bg-main)` 等变量，视觉自动跟随主题与用户自定义字体 |
| 切到别的页不用管 | 你的页面只在 `data-mode` 命中时显示，用户点别的导航自动隐藏 |

### 13.5 数据从哪来

三种来源，按推荐度排：

1. **`AgentAPI.VFS.getContent()` 现读**（图标库就是这么做的）。读磁盘上的 `/index.html` 再解析 `ICON_PATHS`，好处是「看到的永远等于磁盘上此刻的」—— 用户改完源码点「重新读取」就生效，不受页面加载时那份内存旧副本影响。
2. **插件自己算 / 内联常量**。最稳，但每次改数据都要改插件。
3. **宿主脚本的顶层变量**。`const ICON_PATHS`、`const APP_VERSION` 这类顶层 `const/let/function/class` 声明和插件在同一个全局词法环境里，插件里用裸名字确实读得到。但这是**内部实现细节**，主文件升级随时改名或挪位置 —— 想长期可用就老老实实走第 1 条。

### 13.6 卸载必须还原

按钮、`<section>`、`<style>` 三样，外加一句「如果当前正停在我的页，先 `switchPage('chat')`」。少了最后这句，禁用插件后整页空白 —— 因为 `data-mode` 还指着那个已经被删掉的页面。

---

## 14. 场景 B：往已有页面里加东西、删东西（以「Claw 模式」为例）

### 14.1 设置页的结构

```
#settingsModal
└── .settings-body
    ├── .settings-nav                     ← 左侧标签列，按钮带 data-tab="ai|cloud|cs|git|ui|mem|tools|adv"
    └── div(display:flex;flex-direction:column)   ← pane 容器
        ├── .settings-pane[data-pane="ai"]
        ├── .settings-pane[data-pane="cloud"]
        └── ...
```

`switchSettingsTab(name)`（全局函数）把所有 `.settings-nav-btn` 与 `.settings-pane` 的 `.active` 按 `data-tab` / `data-pane` 对齐。**tab 名和 pane 名必须写成同一个字符串**。

### 14.2 点击是谁在管（2026.11.14.15 起改为事件委托）

**旧版（≤ 2026.11.14.14）有坑**：应用在启动时用 `document.querySelectorAll('.settings-nav-btn').forEach(t => t.addEventListener(...))` 逐个绑过一次点击。插件之后插进来的按钮抓不到 → 按钮能点、点了没反应，必须自己绑 `switchSettingsTab`。

**现在**：`.settings-nav`（以及 `.nav-rail`）都改成了**事件委托** —— 监听器挂在容器上，靠 `closest('.settings-nav-btn')` 找按钮、读 `data-tab`：

```js
// index.html 里现在的写法（你不需要抄，知道就行）
setNavEl.addEventListener('click', (e) => {
  const btn = e.target.closest ? e.target.closest('.settings-nav-btn') : null;
  if (!btn || !setNavEl.contains(btn)) return;
  if (btn.dataset.tab) switchSettingsTab(btn.dataset.tab);
});
```

对你意味着三件事：

| 结论 | 说明 |
| --- | --- |
| **不用自己绑 click 了** | 只要你的按钮是 `.settings-nav-btn` + `data-tab="xxx"`，插进去就能点 |
| **`data-tab` / `data-mode` 成了硬要求** | 里层留空（`data-tab=""` 或没写）则委托故意跳过，留给插件自己处理，此时才需要自己绑 |
| **自己再绑一次也不会坏** | 委托和你的监听器各跑一次，`switchSettingsTab` 是幂等的（重复设同一个 `.active` 无副作用）。想少一层依赖就别绑 |

> 兼容写法：插件可能装载在旧版宿主上。**自己绑一次最稳**，下面骨架里保留了这个监听 —— 新版重复调用无害，旧版靠它救命。

### 14.3 注入骨架

> 完整实现见 `/plugins/claw-mode.js`（就是「Claw 模式」那个插件），它把这段骨架用到了自己身上：设置页加 `data-tab="claw"` 分组、配置写进 `cfg.claw*`、右下角挂 `#clawPanel` 浮层。

```js
/* 往「设置」页加一个自己的分组，并把配置存进应用 cfg（Claw 用的就是这套） */

const TAB = 'myplug';           // 同时是 data-tab 和 data-pane 的值
let injectTimer = null;
let injectTries = 0;

function ensureInjected() {
  try {
    const nav = document.querySelector('.settings-nav');
    const anchor = document.querySelector('.settings-pane[data-pane="adv"]');
    if (!nav || !anchor) return false;      // 设置页 DOM 还没就绪，交给重试

    /* --- 左侧标签按钮：必须自己绑 click --- */
    if (!nav.querySelector('[data-tab="' + TAB + '"]')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-nav-btn';
      btn.dataset.tab = TAB;
      btn.textContent = '我的插件';
      btn.addEventListener('click', () => {
        if (typeof switchSettingsTab === 'function') switchSettingsTab(TAB);
      });
      nav.appendChild(btn);
    }

    /* --- 右侧面板：插到 pane 容器里，和别的 pane 平级 --- */
    if (!document.querySelector('.settings-pane[data-pane="' + TAB + '"]')) {
      const pane = document.createElement('div');
      pane.className = 'settings-pane';
      pane.dataset.pane = TAB;
      pane.innerHTML =
        '<div class="field">' +
          '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">' +
            '<input type="checkbox" id="myplugOn" style="width:auto;accent-color:var(--accent)"> 开启我的插件功能' +
          '</label>' +
          '<div style="font-size:11.5px;color:var(--text-muted);line-height:1.7;margin-top:6px">' +
            '这里写这个开关是干什么的。说明文字用 --text-muted、行高 1.7，和原生分组保持一致。</div>' +
        '</div>' +
        '<div class="row2">' +
          '<div class="field"><label>数量</label><input type="number" id="myplugNum" min="1" max="8"></div>' +
        '</div>' +
        '<div class="field"><button class="ghost-btn" id="myplugSave" type="button">保存</button></div>';
      anchor.parentElement.appendChild(pane);     // 关键：插到 pane 容器，不是插进 adv 里

      pane.querySelector('#myplugSave').addEventListener('click', async () => {
        const c = AgentAPI.cfg;                    // 活引用，改完调 saveCfg() 落盘
        const g = (id) => document.getElementById(id);
        c.myplugOn = !!g('myplugOn').checked;
        c.myplugNum = Math.max(1, Math.min(8, Number(g('myplugNum').value) || 3));
        try {
          if (typeof saveCfg === 'function') await saveCfg();
          AgentAPI.toast('已保存');
        } catch (e) {
          AgentAPI.toast('保存失败：' + (e && e.message || e), 'err');
        }
      });
    }

    /* --- 每次进来都回填（设置页会被反复打开，DOM 也可能是被重建过的） --- */
    const c = AgentAPI.cfg;
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!val; else el.value = val;
    };
    set('myplugOn', c.myplugOn);
    set('myplugNum', Number(c.myplugNum) || 3);
    return true;
  } catch (e) {
    console.warn('[myplug] 设置页注入失败', e);
    return false;
  }
}

/* DOM 可能还没就绪：有限次重试，别无限轮询白烧 CPU */
function scheduleInject() {
  if (ensureInjected()) return;
  if (injectTries++ >= 20) return;
  injectTimer = setTimeout(scheduleInject, 500);
}
scheduleInject();

/* 卸载：定时器 + 按钮 + 面板，一个都不能留 */
onUnload(() => {
  if (injectTimer) { clearTimeout(injectTimer); injectTimer = null; }
  const btn = document.querySelector('.settings-nav [data-tab="' + TAB + '"]');
  if (btn) btn.remove();
  const pane = document.querySelector('.settings-pane[data-pane="' + TAB + '"]');
  if (pane) pane.remove();
});
```

### 14.4 只改了三行的事：配置存哪

- `AgentAPI.cfg` 是**活引用**，直接改字段（`cfg.myplugOn = true`）。
- 改完必须调全局 `saveCfg()`。它负责敏感字段加密、写 localStorage、云同步。
- **不要自己 `localStorage.setItem`** —— 会和内存里的 `cfg` 脱节，页面一刷新就分叉。
- 你的字段名要带前缀（`myplugXxx`、`clawXxx`），别用 `enabled` 这种泛名，将来撞了没人能救。

### 14.5 可注入的位置清单

「任意地方加东西」的通用手法只有三步：**找到容器选择器 → `appendChild` → `onUnload` 里 remove**。常用容器：

| 想加在哪 | 容器选择器 | 插什么 | 注意 |
| --- | --- | --- | --- |
| 左侧导航栏 | `.nav-rail` | `.nav-rail-btn`（带 `data-mode`） | 要配一套自己的页面 CSS，见第 13 节 |
| 设置页左侧 | `.settings-nav` | `.settings-nav-btn`（带 `data-tab`） | 必须自己绑 `switchSettingsTab` |
| 设置页右侧 | `.settings-pane[data-pane="adv"]` 的 `.parentElement` | `.settings-pane`（带同名 `data-pane`） | 别插进某个 pane 内部，会跟着那个 pane 一起隐藏 |
| 对话页输入框上方工具条 | `.composer-bar`（内部分 `.cb-left` / `.cb-right`） | `.icon-btn` | 窄屏空间紧，别加宽按钮 |
| 侧栏头部 | `.side-head` | `.icon-btn` | 尺寸跟既有按钮一致 |
| 各页页头 | `.page-header` | `.ghost-btn` | 页头里有个 `<div style="flex:1">` 占位，插在它之后才靠右 |
| 全局浮层 | `document.body` | `position:fixed` 的 div | 见 14.7 |

### 14.6 会被重绘冲掉的容器（重点）

`.tree`、`.messages`、`#pluginList`、`#toolsPageBody`、`#libGrid` 这些由应用反复 `innerHTML = ...` 重建。插件插进去的东西，下一次重绘就没了，而且**不会报错**。

对策：
1. 别插（首选）；
2. 做成 `position:fixed` 浮层，绕开重绘；
3. 真要插就挂 `MutationObserver` 补插 —— 但很容易和应用自己的重绘打架，做成无限循环，慎用。

### 14.7 浮层：接管任意角落

Claw 的运行进度面板就是典型做法：`document.body.appendChild` 一个 `position:fixed; right:16px; bottom:16px` 的 div，不挂进任何容器，所以**应用怎么重绘都不会碰它**。

```js
const el = document.createElement('div');
el.id = 'myplugPanel';
el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9998;width:300px;' +
  'background:var(--bg-panel);border:1px solid var(--border);border-radius:10px;' +
  'box-shadow:0 8px 28px rgba(0,0,0,.42);font-size:12px;overflow:hidden';
el.innerHTML = '<div style="padding:8px 10px">内容</div>';
document.body.appendChild(el);
onUnload(() => { const x = document.getElementById('myplugPanel'); if (x) x.remove(); });
```

- 不想挡鼠标就加 `pointer-events:none`（demo-overlay 插件就这么做的）。
- z-index 参考：toast 是 200，普通弹窗 `.modal` 在 100 以上，插件浮层一般用 9998 就够，别乱冲 2147483647。

### 14.8 一个可选的小细节：动态插入的 `<select>`

设置页里的原生 `<select>` 在**应用启动时**被 `initCustomSelects()` 统一替换成了自定义下拉（CustomSelect）。你之后动态插入的 `<select>` 不会被自动接管，外观会和旁边的控件不一致。

要么避开 `select`（Claw 就全用 `checkbox` + `number`），要么插完手动 `new CustomSelect(sel)` —— `CustomSelect` 是顶层 class 声明，插件里能用裸名字 new，但 `window.CustomSelect` 是 undefined。

### 14.9 为什么是这两处改委托，别处没改

宿主里逐元素绑 click 的地方不少，但只有**「名字 → 行为」映射写在宿主里、且插件可能往里加同类按钮**的容器才适合委托。判断标准是：

> 委托的前提是「宿主认识这个新元素的语义」。宿主只靠 `data-mode` / `data-tab` 就能路由，所以插件只要写对属性就能接上。反之，宿主不认识的行为（你自己的工具栏、你自己的列表项）套委托没有意义，只会让宿主越界。

按这个标准分三类：

| 容器 | 现状 | 为什么 |
| --- | --- | --- |
| `.nav-rail` | **已改委托** | 插件官方支持加页面按钮，语义就是 `data-mode` |
| `.settings-nav` | **已改委托** | 插件官方支持加设置分组，语义就是 `data-tab` |
| `#pluginList` / `#libGrid` / `#toolsPageBody` | 仍是每次渲染后逐个绑 | 这些容器由应用 `innerHTML` 整体重建，插件塞进去的东西下次重绘就没了（见 14.6），委托也救不了；逐个绑反而是配合「重绘后重新挂」这套逻辑的 |
| `.task-line` / `.welcome-suggestion` / `.tool-switch-item` | 仍是启动时一次性绑 | 静态节点或应用独占渲染，插件没有往里塞东西的正当理由 |

要自己给这些容器加东西时，**自己绑**，别指望宿主。反过来说：如果你的插件按钮带 `data-mode` / `data-tab` 却被宿主抢先处理了，那是你自己的按钮语义和内置的撞了 —— 换个不带这两个属性的按钮，或者用 `e.stopPropagation()` 拦住。

---

### 14.10 想删掉宿主已有的东西

插件和宿主平权，`document.querySelector('.xxx').remove()` 一行就删了。但先想清楚三件事再动手，否则问题不会当场暴露。

**反作用力一：宿主脚本会因为缺元素直接抛异常**

宿主里的 null 检查是**混着写的**，同一个函数里两种风格都有。`openSettings()` 就是例子：

```js
$('cfgBaseUrl').value = cfg.baseUrl || '';              // 无保护：删掉这个 input 就 throw
const proxy = $('cfgCorsProxy'); if (proxy) proxy.value = cfg.corsProxy || '';   // 有保护
```

前一行 throw 后整个函数进 catch → toast「打开设置失败」，**设置页彻底打不开**，用户还不知道是自己装的插件干的。

所以删任何带 id 的元素前，先 `read_file(path="/index.html", query="cfgBaseUrl")` 看宿主怎么用它。

**反作用力二：重绘容器删了白删**

见 14.6。`.tree`、`.messages`、`#pluginList`、`#toolsPageBody`、`#libGrid`、`#taskStats` 都是 `innerHTML` 重建的，删掉下一秒又长回来。

更隐蔽的是 `#messages` 这类：宿主用顶层变量 `messagesEl` 持有引用，你删了节点，变量还指着它，往后的消息全 append 进一个游离节点 —— **消息照发、界面上什么都没有**，查起来极难。

**反作用力三：按钮删了，功能还在**

删掉 `.nav-rail-btn[data-mode="tools"]` 只是抹掉入口。`switchPage('tools')` 照样能把 `data-mode` 切成 tools，插件或后续代码一旦调用，就会出现一个「从导航栏进不去、但确实存在」的页面。

同理，只删 `.settings-nav-btn[data-tab="cs"]` 不删对应 `.settings-pane`，那个面板就永远显示不出来；反过来只删 pane，点按钮会切到一片空白。

### 推荐做法：隐藏，别删除

```js
const HIDE_ID = 'myplug-hide';

function applyHide() {
  let st = document.getElementById(HIDE_ID);
  if (!st) {
    st = document.createElement('style');
    st.id = HIDE_ID;
    document.head.appendChild(st);
  }
  st.textContent = [
    /* 内置「Codespace」设置分组：左栏按钮 + 右栏面板必须成对处理 */
    '.settings-nav-btn[data-tab="cs"], .settings-pane[data-pane="cs"] { display: none !important; }',
    /* 顶栏的预览按钮 */
    '#btnTogglePreview { display: none !important; }'
  ].join('\n');
}
applyHide();
onUnload(() => { const st = document.getElementById(HIDE_ID); if (st) st.remove(); });
```

为什么比 `remove()` 好：

| | CSS 隐藏 | DOM 删除 |
| --- | --- | --- |
| 宿主脚本会不会报错 | 不会，元素仍在，`$()` 拿得到 | **可能**，取决于那把 null 检查 |
| 重绘容器 | 照样生效（选择器一直有效） | 白删，下次重绘复活 |
| 还原 | 删一个 `<style>`，一行 | 得记原位置再插回去 |
| 幂等性 | 按 id 复用同一个 `<style>`，重复执行不叠 | 删两次会静默失败，容易误以为成功 |

`!important` 是必需的：`.settings-pane.active { display:block }` 的特异性与你的选择器同级，不加压不住。

### 确实要删：快照-恢复

只在**静态节点**（不参与重绘）上这么做：

```js
const _stash = [];

function stashEl(el) {
  if (!el || !el.parentNode) return;
  _stash.push({ el, parent: el.parentNode, next: el.nextSibling });   // 记住原位置
  el.parentNode.removeChild(el);
}

function restoreEls() {
  while (_stash.length) {
    const r = _stash.pop();
    try { r.parent.insertBefore(r.el, r.next); } catch (e) { /* 父节点已经没了，放弃 */ }
  }
}

stashEl(document.querySelector('#btnEditTitle'));
onUnload(restoreEls);
```

注意：如果那个元素在你删除之后被宿主重建过一次，`_stash` 里存的是**旧节点**，插回去也是死节点。所以只对静态 HTML 里的元素用这招。

### 第三种：改行为，不改 DOM

有时候你要的不是「删掉一个按钮」，而是「别让某个页面/功能被打开」。monkey-patch 比删 DOM 精准得多：

```js
const _origSwitchPage = window.switchPage;
window.switchPage = function (mode) {
  if (mode === 'autotask') return;          // 封掉「定时任务」页，导航栏按钮留着但点了没反应
  return _origSwitchPage.apply(this, arguments);
};
onUnload(() => { window.switchPage = _origSwitchPage; });
```

- `switchPage` 是全局 `function` 声明，赋值成 `window.switchPage` 会覆盖同一个绑定，宿主内部 `switchPage(...)` 的调用也会走你的版本。
- **多个插件 patch 同一个函数会打架**，还原顺序取决于卸载顺序。要么约定好谁也不碰，要么套一层 `try/finally` 只做减法。

### 可逆性：刷新就复原

`index.html` 是静态文件，DOM 是浏览器从这份文件解析出来的。插件删掉/藏掉的东西，**刷新页面就回来了**（除非插件还启用着，又跑一遍）。

所以后果不是灭顶之灾，但在当前会话里，用户看到的是一个残破的界面，而且不会知道原因。**卸载时必须还原**，这条没有例外。

### 动手前的三条规矩

1. **先问用户**。删宿主的内置功能属于改造，不是插件自带能力（见第 15 节）。
2. **`onUnload` 里一律还原**：`<style>` 删掉、节点插回去、patch 的全局函数换回原版。
3. **如果此刻正停在被你处理的页面上，先 `switchPage('chat')`** —— 和 13.6 同理，不然会停在空白或残缺的界面。

---

## 15. 安全与边界

插件**不是沙箱**，它和应用本体平权：

- 能读 `AgentAPI.cfg`，里面有 API Key 和 Base URL；
- 能 `fetch` 任意地址（受同源策略 / CORS 限制，但不受应用的"弹窗确认"约束）；
- 能改 DOM、改对话、读写整个 VFS、通过 `executeTool` 调用任何内置工具；
- 能注册工具，等于间接改写 AI 的行为。

所以：

1. 只装/只启用你读过的代码。插件库的描述不构成安全保证。
2. 插件代码里**不要写死 Key / Token / 密码**。`/plugins/` 会随备份、云同步一起被带走。
3. 处理用户数据（对话、文件内容）时，不要往外部服务器发，除非用户明确同意。
4. 插件自己 `fetch` 不会弹确认框 —— 需要联网时自己先 `toast` 或让 AI 用带确认的内置工具。
5. 工具返回值会进模型上下文，别把整份密钥、整本书塞进去。

---

## 16. 完整模板

```js
/* demo-log.js · 往 /notes/demo-log.md 追加一行
 * 注册工具：demolog_append
 */

const LOG_PATH = '/notes/demo-log.md';

// —— 加载期：注册工具（必须在这一层调用）
AgentAPI.defineTool('demolog_append', {
  description: '把一行文字追加到 /notes/demo-log.md。用户说「记一下」「记到日志里」时用。',
  parameters: {
    type: 'object',
    properties: {
      line: { type: 'string', description: '要追加的一行文字' }
    },
    required: ['line']
  }
}, async (args, ctx) => {
  const VFS = ctx.VFS;
  const line = String((args && args.line) || '').trim();
  if (!line) return '错误：line 不能为空';

  const old = await VFS.getContent(LOG_PATH);
  if (old === undefined) {
    // 文件存在但正文拿不到：绝不能当空文件写回去，会覆盖用户数据
    return '错误：' + LOG_PATH + ' 内容暂时读不到，已放弃这次写入，避免覆盖。';
  }
  const base = old || '';
  const next = base + (base && !/\n$/.test(base) ? '\n' : '') + line + '\n';
  await VFS.writeFile(LOG_PATH, next);
  return '已追加到 ' + LOG_PATH + '，当前共 ' + next.split('\n').length + ' 行左右。';
});

// —— 一个带定时器的副作用，配好清理
const timer = setInterval(() => {}, 60000);
onUnload(() => clearInterval(timer));

AgentAPI.toast('demo-log 插件已加载（' + AgentAPI.pluginId + '）');
```

---

## 17. 速查卡

```js
// 注册工具（加载期）
AgentAPI.defineTool('my_tool', { description: '…', parameters: { type: 'object', properties: {} } },
  async (args, ctx) => '结果字符串');

// 路径与文件
const p = ctx.VFS.norm('/notes/a.md');
const c = await ctx.VFS.getContent(p);        // null=不存在 / undefined=读不到
const ok = await ctx.VFS.writeFile(p, 'x');   // true=新建 false=覆盖
const tree = ctx.VFS.listDir('/notes');       // { dirs:['sub/'], files:['a.md'] } | null

// 提示与元信息
ctx.toast('提示', 'err');                     // err 红色 5 秒
const id = AgentAPI.pluginId;
const ver = AgentAPI.version;

// 清理
onUnload(() => { /* clearInterval / removeEventListener / removeChild */ });

// 懒加载：AI 侧需要先
tools_expand({ groups: ['plug:<你的id>'] });

// 新建一个页面（详见 13 节）
const ID = 'mypage';
cleanup();                                       // 自写的幂等清理：按 data-mode / id 找到上次的痕迹并 remove
document.head.appendChild(styleEl);              // .mypage-page{display:none} + body[data-mode="mypage"] 显示 + 藏别人的面板
document.querySelector('.app').appendChild(sectionEl);
const navBtn = document.createElement('button'); navBtn.className = 'nav-rail-btn'; navBtn.dataset.mode = ID;
navBtn.addEventListener('click', () => (typeof window.switchPage === 'function') ? window.switchPage(ID) : (document.body.dataset.mode = ID));
document.querySelector('.nav-rail').appendChild(navBtn);

// 往设置页加一组（详见 14 节）
const TAB = 'myplug';
btn.className = 'settings-nav-btn'; btn.dataset.tab = TAB;
btn.addEventListener('click', () => switchSettingsTab(TAB));    // 必须自己绑
document.querySelector('.settings-nav').appendChild(btn);
const pane = document.createElement('div'); pane.className = 'settings-pane'; pane.dataset.pane = TAB;
document.querySelector('.settings-pane[data-pane="adv"]').parentElement.appendChild(pane);
// 存配置：改 AgentAPI.cfg 字段 → await saveCfg()（别直接写 localStorage）

// 卸载：按钮 / 页面 / 样式 / 定时器 / 浮层，全都要 remove
onUnload(() => { /* ... */ if (document.body.dataset.mode === ID) switchPage('chat'); });
```
