# 当前状态

“最近一次更新”列表按日期倒序排列，当前状态正文只描述现状，不按时间排列。

## 项目

- 名称：`pi-migration`
- 定位：导出本机 Pi Agent 可迁移的非敏感配置和资源，并在新电脑恢复；凭据、登录状态和会话记录不迁移。
- 当前位置：`D:\Code\Javascript\pi-migration`

## 当前实现

- `migrate.mjs export` / `migrate.mjs import` 使用 Node.js 内置能力处理版本化快照；manifest schema 为 v1，包含文件大小和 SHA-256 校验。
- 导出支持明确识别的 Pi 配置/指令文件（不含 MCP `mcp.json`）、agent 内 Extensions、Skills、prompts、themes、`~/.agents/skills` 本地内容及 package 声明；保留可迁移的 package filters，不复制整个 home/agent 目录。
- 导入先校验快照和目标边界；默认拒绝覆盖不同的已有文件，显式 `--overwrite` 会备份本次受影响的非敏感文件。dry-run 不写文件、不安装 package、不执行迁移代码。
- 远程 npm/Git package 通过目标机 Pi CLI 安装。未锁定的来源会在报告中列出；若本地 package 的 `package.json` 含 `dependencies`，当前实现会保守地视作未解析并在写入前失败，不会声称依赖已恢复。
- MCP 配置 `mcp.json`、凭据、登录状态、会话、trust 数据、缓存、日志、数据库、`.git`、`node_modules` 等不属于迁移范围。导出不读取该文件；导入保持目标机已有 MCP 配置不变，含 `mcp.json` 的旧快照在写入前拒绝。疑似敏感内容安全拒绝；可过滤的设备/会话类字段和需在新环境处理的事项写入报告。
- 旧入口 `sync-skills.mjs` 与 `skills-manifest.json` 仍保留；它只从上游安装清单中的 Skills，不保证字节级保留本机内容。
- 针对性测试与全套测试均已覆盖临时目录和受控 installer；最近一次 `npm test` 为 42 项通过、0 失败、0 跳过。

## 待处理与未验证

- 如需 MCP 工具，新电脑由用户自行配置 MCP server；迁移工具不迁移 `mcp.json`。
- 尚未在真实新电脑运行导入、真实安装 npm/Git packages、执行 OAuth 登录或发出模型请求；新机实用结果仍须人工验收。
- ChatGPT Plus 是否能通过新环境中的 Pi 授权流程使用，尚未验证，不作兼容承诺；用户需在新环境手动 `/login` 或使用提供商支持的登录流程。

## 最近一次更新

- 2026-10-11：明确排除 MCP 配置；针对性验证 42 项通过，确保新快照不含 `mcp.json`、旧快照拒绝且目标配置不变。详见 [`session-log.md`](session-log.md) 与 [`implementation-plan.md`](implementation-plan.md)。
- 2026-10-11：完成导出/导入文档及新机流程；当时验证为 `node --test test/importer.test.mjs`（14 项通过）和 `npm test`（41 项通过）。没有执行真实本机恢复或 package 安装；见 [`session-log.md`](session-log.md) 与 [`implementation-plan.md`](implementation-plan.md)。
- 2026-10-11：确认项目目标由 Skills-only 扩展为 Pi Agent 非敏感环境迁移；核对当时的实现形态和安全边界，详见 [`implementation-plan.md`](implementation-plan.md)。

测试命令：`npm test`（Node.js 内置 `node --test`）。

详细使用流程和支持边界见 [`README.md`](../README.md)；实现依据、未确认项和验收边界见 [`implementation-plan.md`](implementation-plan.md)。
