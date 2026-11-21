# git_write 验证文件

本文件用于验证 `git_write` 在修复「HTTP 200 非 JSON 响应」后能否正常提交。

- 二次写入时间：2026-11-21 12:50（更新测试）
- 这次走的是**更新路径**：`shaOf()` 需要先从 contents 接口拿到现有 blob 的 sha
- 当初的故障正是发生在这里：读文件用 `Accept: ...raw`、取 sha 用 `Accept: ...json`，
  同一个 URL 命中缓存后把文件原文当 JSON 解析，报「HTTP 200 非 JSON 响应」
- 修复后统一 `cache: 'no-store'`，并保留 Git Data API 兜底

更新成功说明 sha 已正确取到，否则 GitHub 会返回 422。
