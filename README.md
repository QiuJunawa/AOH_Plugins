# AOH_Plugins

Agent-On-HTML（单文件 AI Agent）的第三方插件库。

## 这是什么

这里存放可供 Agent-On-HTML 加载的 JS 插件。插件运行在主页面同源作用域内，通过 `AgentAPI.defineTool` 注册工具给模型调用。

## 怎么用

1. 打开你的 Agent-On-HTML 页面。
2. 进入「插件」页，在插件库地址填入本仓库的 raw 地址：
   `https://raw.githubusercontent.com/QiuJunawa/AOH_Plugins/main/index.json`
3. 点「刷新插件库」，即可看到下面的插件卡片，点安装即可。

## 插件列表

| id | 名称 | 说明 |
|---|---|---|
| `hello` | Hello 示例 | 最小骨架，演示 defineTool / onUnload |
| `demo-overlay` | 页面叠加层 | 右下角浮层，演示多工具与 DOM 清理 |

## 投稿规范

- 插件是单个 `.js` 文件，放在仓库根目录。
- 在 `index.json` 的 `plugins` 数组里追加一条记录（字段说明见下）。
- 工具名必须匹配 `/^[a-z][a-z0-9_]{1,40}$/`，且建议加插件前缀避免冲突。
- 注册了定时器 / DOM / 全局监听器的，必须用 `onUnload` 清理。
- **本库插件承诺不向作者服务器发送任何用户数据，不读取 API Key 以外的敏感字段。**

## index.json 字段

顶层结构：

```json
{
  "plugins": [
    {
      "id": "hello",
      "name": "Hello 示例",
      "version": "0.1.0",
      "description": "...",
      "author": "qiujunawa",
      "tags": ["demo"],
      "file": "hello.js",
      "tools": ["hello_greet"],
      "homepage": "https://..."
    }
  ]
}
```

- `id` 必填，匹配 `/^[a-zA-Z0-9_\-.]+$/`。一旦发布不要改。
- `file` 相对仓库根；以 `http(s)://` 开头则原样使用。
- `tools` 仅作文档展示，真实可用与否取决于 `.js` 里是否真的 `defineTool`。

## 注意

- 仓库根目录必须保留 `.nojekyll`，否则 GitHub Pages 的 Jekyll 会忽略 `_` 开头的文件。
