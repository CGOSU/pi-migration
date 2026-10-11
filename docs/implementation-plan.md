# Pi Agent 环境迁移实现依据

## 状态

导出、导入和针对性测试已实现；本文保留需求分析基线和约束，并在“已实现范围和验证状态”中记录当前可验证能力。没有实测的新机授权、真实 package 安装和 Plus 使用仍属于未验证事项。

## 已实现范围和验证状态

- `migrate.mjs export` 与 `migrate.mjs import` 使用 schema v1 manifest；快照文件记录大小和 SHA-256，导入在任何写入或 package 安装前完整校验快照、配置内容、路径及符号链接边界。
- 显式支持的 Pi 配置文件为 `settings.json`、`keybindings.json`、`mcp.json`、`models.json`；还收集用户指令文件、agent 下的 Extensions/Skills/prompts/themes、home 下 `~/.agents/skills` 内容和可表示的 package 资源。实现不复制整个 home/agent 目录。
- 设备/会话定位类字段过滤后报告；凭据或疑似敏感内容安全拒绝。外部绝对路径和不支持的资源不会静默变成成功。
- 远程 npm/Git package 声明及资源过滤保留，导入使用目标机 Pi CLI 安装；未锁定的来源由导出报告标出。本地 package 的文件可随快照恢复，但 package 依赖不打包；本地 `package.json` 若含 `dependencies` 字段，当前实现会保守地将其视为未解析，并在写入前拒绝导入，不会尝试解析或安装依赖。
- 默认拒绝覆盖不同的目标文件；显式 `--overwrite` 先备份将被替换的非敏感文件。导入失败会给出已写文件、备份及 package 安装进度；不承诺第三方安装副作用可回滚。重复导入时，相同文件不重复写入，settings 中的 package 声明按快照重建。
- export/import 的 `--dry-run` 只进行校验和预览；不写文件、不安装 package、不执行迁移资源代码。
- `node --test test/importer.test.mjs`：14 项通过；`npm test`：41 项通过，0 失败、0 跳过。测试使用临时目录和受控 installer。
- 未在真实新电脑执行恢复、真实 npm/Git 安装、OAuth 登录或模型请求；ChatGPT Plus 是否能通过 Pi 登录使用仍待新环境人工验证。

## 目标与使用流程

用户在新电脑先安装 Pi，再将本迁移包复制过去并运行恢复命令，恢复本机日常使用所需的 Skills、Pi settings、Extensions 和其他已确认的非敏感配置。迁移包应提供本机导出和新机恢复流程，方便以后重新生成/同步环境快照。

不迁移凭据、登录状态、会话记录。新机由用户自行登录或授权；迁移工具不得尝试转移订阅或 OAuth 状态。ChatGPT Plus 能否通过当前 Pi 版本的授权流程使用，需在新环境登录后人工验证，当前证据不足以承诺支持。

## 需求分析阶段的基线事实

- 仓库只有 `sync-skills.mjs`、`skills-manifest.json` 和文档，没有 package scripts 或测试文件；目录当前不是 Git 仓库。
- `sync-skills.mjs` 读取 `skills-manifest.json`，对清单中的 Skill 调用 `npx skills add --global --agent pi`。唯一代码数据调用关系是该脚本读取清单；README 描述执行命令，没有发现其他脚本调用方。
- 当前迁移清单有 3 个 Skill。安装时从上游拉取内容，不能保证与本机已安装内容逐字节相同。
- 本机全局配置采用 Pi 默认目录；`PI_CODING_AGENT_DIR` 未设置。Pi 默认全局目录为 `~/.pi/agent`，环境变量可覆盖。Pi 文档列出的用户资源包括 settings、keybindings、MCP、models、用户指令、Extensions、Skills、prompts 和 themes。
- 对本机配置仅进行脱敏结构核对，没有读取凭据或会话内容：`settings.json` 有 5 个字符串形式的 package 来源声明（4 个 Git、1 个 npm）；默认 `extensions/` 目录存在但没有自定义 Extension 文件；Pi settings 下的 `skills` 列表为空。当前使用的 3 个 Skills 位于 `~/.agents/skills`。
- 本机 `models.json` 是空 providers 配置；`mcp.json` 有 2 个 stdio server 配置，具体命令、参数和 server 名称未记录，也未读取其值。参数可能包含敏感内容，不能未经检查直接复制。
- 本机 settings 还含设备标识和运行状态类字段；不能整份无筛选复制。Pi 的包声明可以引用远程或本地资源，settings filters 会影响包加载；新机需要重建依赖，外部/本机绝对路径资源不一定可移植。

## Pi 配置事实与安全边界

- Pi 默认 agent 目录是 `~/.pi/agent`，`PI_CODING_AGENT_DIR` 可指定其他位置。导出和恢复都必须解析运行时路径，不可把本机绝对路径写入新机快照。
- Pi 配置目录包含 `auth.json`（API keys 和 OAuth credentials）；MCP OAuth 凭据也有单独存储位置。认证材料属于明确排除项。
- 会话、trust 决策、运行日志、数据库、缓存、包安装缓存、临时进程记录和设备 ID 均不是本次迁移内容；不允许通过复制整个 agent 目录来实现。
- Pi Extensions 是可执行代码，Pi packages 可包含 Extensions、Skills、prompts 和 themes。远程包重装前需记录可核实来源/版本；不应静默把未经审查的本地或外部代码作为可信资源执行。
- settings、models、MCP、包参数等配置文件本身也可能包含内联凭据。导出必须采用明确允许的内容边界；发现疑似秘密时失败关闭或安全排除，并只报告文件/字段，不输出值。无法迁移的资源要在报告中列明，不能宣称完整恢复。
- 快照路径须校验相对路径、schema 版本、文件完整性及符号链接边界，阻止路径穿越和向认证/会话位置写入。dry-run 不写文件、不安装包、不执行资源代码。

## 实现验收范围

1. 快照带 schema 版本及文件完整性信息，可由 Node.js CLI 执行 export、import 和 `--dry-run`；可显式传入 agent-dir、home、快照目录以便跨平台和临时目录测试。
2. 快照包含已支持的非敏感设置、用户 Skills/资源、本地 Extension 和可核实的 Pi package 来源及 filters；精确保留本地 Skill 内容，避免依赖上游当前版本。版本未锁定、缺失依赖、不可移植绝对路径均须报告。
3. 导入前完成全量校验；默认不覆盖内容不同的现存文件，显式覆盖须先备份本次影响的非敏感文件。不得改变目标机现有凭据、会话或未选入迁移清单的文件；重复导入同一快照应安全。
4. 导出与恢复使用结构化错误结果，区分缺失、格式、类型、版本、疑似秘密、路径和完整性错误；失败非零退出并说明已完成/未完成动作，不泄露秘密。
5. 用 Node 内置测试和临时目录验证：安全排除、错误输入、路径穿越/符号链接、dry-run 零写入零安装、冲突/备份、幂等性、跨平台目标路径及受控 package 安装失败。开发验证不得真实覆盖本机配置、安装真实包、登录 OAuth 或发起模型请求。
6. 新机使用说明明确展示导出、迁移包同步、恢复、dry-run 及用户手动登录步骤，并区分自动恢复和登录后人工验证。

## 未确认或必须报告的边界

- ChatGPT Plus 的具体 Pi 登录/订阅授权兼容性未从本机项目代码或已读 Pi 文档中得到确认；迁移工具不实现或承诺该授权。
- 本机 MCP server 的命令与参数未检查，也未读取具体配置值，因此不声称源机 MCP 配置已核实无秘密。实现会扫描支持的 MCP 配置；发现凭据/疑似秘密时整次导出安全失败（不生成快照，也不回显秘密），需用户在确认配置安全后重试或在新机手动重配。
- 本机远程 package 来源的具体名称/ref 未写入本文；导出时应仅在用户明确授权的迁移包内记录必要的来源信息，并报告无法锁定的版本。任何私人来源不应出现在公开文档或日志中。
- 外部绝对路径资源、自制 package、包运行时依赖和运行时网络条件必须在导出/恢复报告中逐项说明是否支持；没有验证的能力不得宣称已恢复。

## 证据来源

- 需求分析阶段的基线实现：`sync-skills.mjs`、`skills-manifest.json`；直接引用关系与文件清单通过 `find`/`grep` 核对；当时未发现测试文件及 package scripts。
- Pi 官方本机文档：`configuration.md`、`settings.md`、`extensions.md`、`skills.md`、`packages.md`、`models.md`、`providers.md`、`mcp.md`、`environment-variables.md`、`cli.md`、`security.md`、`windows.md`、`prompt-templates.md`、`themes.md`、`keybindings.md`。
- 本机配置形态仅通过脱敏 Node.js 结构检查核对；未读取 auth/OAuth 凭据、MCP 参数内容或会话文件，本文不记录秘密、个人 server 名称和来源 URL。

## 后续人工验收

- 在新电脑按 [`README.md`](../README.md) 的预览、恢复及手动登录步骤执行；核对实际保留的配置与本次导出报告中未锁定 package、过滤字段和需重配事项。
- 手动确认 Pi CLI 能安装需要的远程 packages，并在认证后确认所需 provider 的可用性；特别是 ChatGPT Plus 兼容性目前没有结论。
- 不用真实机器的凭据/会话、模型调用或真实 package 安装替代临时目录和受控 installer 测试。
