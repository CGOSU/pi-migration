# Pi Agent 环境迁移包

将受支持的 Pi Agent 非敏感配置和本地资源导出为版本化快照，并在另一台电脑恢复。需求、安全边界及验证现状见 [`docs/implementation-plan.md`](docs/implementation-plan.md) 和 [`docs/current-state.md`](docs/current-state.md)。

## 迁移边界

快照 schema 当前为 v1，包含文件 SHA-256 完整性信息。导出仅处理实现明确支持的 Pi 配置文件、用户指令、agent 下的 Extensions/Skills/prompts/themes、本机 `~/.agents/skills` 内容及 package 声明；不递归打包整个用户目录或 agent 目录。远程 npm/Git package 的资源过滤保留，导入时通过 Pi CLI 安装；本地 package 和资源仅在受支持的 Pi/home 根目录内可表示时迁移。

以下内容不会迁移：API/OAuth 凭据、登录状态、会话、trust 数据、缓存、日志、数据库、`.env`、`.git`、`node_modules` 和依赖缓存。疑似凭据内容会导致安全拒绝；被过滤的设备/会话类字段会在报告中列出。不能安全表示的外部本地路径、损坏的清单或完整性校验失败会报错，不会被默默当作已迁移。快照仍可能含有私有指令、配置和本地代码，请使用可信存储和传输方式，不要公开发布。

新电脑上必须由用户自行认证。完成恢复后启动 Pi，并按提供商支持的方式手动运行 `/login` 或登录；迁移工具不会转移 OAuth 状态。ChatGPT Plus 是否能在当前 Pi 版本中使用，尚未在新环境验证，不作兼容承诺。

## 新电脑迁移流程

需要 Node.js。进行实际恢复前，先在新电脑安装 Pi；安装远程 npm/Git package 时，目标环境还须能调用 Pi CLI 和相应的网络/包来源。

### 1. 旧电脑预览并导出

先预览计划和安全报告（不写快照）：

```sh
node ./migrate.mjs export --dry-run --snapshot-dir "D:\pi-transfer\snapshot"
```

确认报告后执行导出：

```sh
node ./migrate.mjs export --snapshot-dir "D:\pi-transfer\snapshot"
```

也可使用默认快照位置：项目目录下的 `.pi-migration-snapshot`。该目录被 Git 忽略，需要另行复制到新电脑；建议显式指定可信的传输目录。目标快照已存在时默认拒绝覆盖；使用 `--overwrite` 才会替换，并把旧快照留在旁边带 `.backup-` 后缀的目录。

### 2. 传输快照和迁移包

将迁移包代码与导出的快照一起通过可信方式传到新电脑。不要把凭据、会话或其他被排除的数据另行塞进快照。

### 3. 新电脑预览并恢复

先检查恢复计划（不写文件、不调用 Pi CLI、不安装 package，也不执行快照中的代码）：

```sh
node ./migrate.mjs import --dry-run --snapshot-dir "D:\pi-transfer\snapshot"
```

确认计划后执行恢复：

```sh
node ./migrate.mjs import --snapshot-dir "D:\pi-transfer\snapshot"
```

默认目标是当前用户的 home，以及 `PI_CODING_AGENT_DIR` 指定的目录；未设置时 agent 目录为 `<home>/.pi/agent`。可显式指定目标，例如：

```sh
node ./migrate.mjs import --snapshot-dir "D:\pi-transfer\snapshot" --home "D:\Users\new-user" --agent-dir "D:\Users\new-user\.pi\agent"
```

导入前会验证整个清单、文件校验和、配置内容、目标冲突及符号链接边界。默认不覆盖内容不同的现存文件。仅在确认需要替换时加 `--overwrite`；将被替换的非敏感文件先备份到 `<home>/.pi-migration-backups/`。凭据/会话路径和含敏感内容的配置不会因 `--overwrite` 而允许写入。

导入输出会列出执行进度、已写文件、package 状态和所用备份目录。Pi package 安装属于外部副作用，失败时可能已部分安装，工具不会声称可完全回滚；遇到错误先检查输出的进度和目标状态，再决定是否重试。重复导入时，相同文件不会重写，package 声明按快照重建而不会累加重复项；每次真实导入仍会调用 Pi CLI 处理远程 package，其重复安装行为未在真实环境验证。

### 参数和 CLI

支持的参数：

- `export` 或 `import`：操作类型。
- `--dry-run`：仅校验并预览，不写入、不安装、不执行迁移内容。
- `--snapshot-dir <path>`：快照目录。
- `--home <path>`：用户 home 根目录。
- `--agent-dir <path>`：Pi Agent 目录。
- `--overwrite`：显式允许替换；导出时备份旧快照，导入时备份将被替换的非敏感文件。

也可使用 npm 脚本，例如 `npm run migrate -- import --dry-run --snapshot-dir <path>`。

## 支持范围与未验证项

- `migrate.mjs export/import` 及 `npm test` 已实现；测试使用临时目录与受控 package installer。已验证快照校验、安全拒绝、dry-run、冲突/备份、重复导入以及受控安装失败。
- 已声明的远程 package 通过 Pi CLI 恢复；导出报告会提示未锁定的远程来源。实际 package 下载/安装没有在本机验证。package 依赖不打入快照；本地 package 的 `package.json` 若含 `dependencies` 字段，导入目前会保守地视为依赖未解析并在写入前失败（不会尝试解析或安装它们），而不会报告恢复成功。
- 成功生成的报告会列出被过滤的设备/会话字段及目标环境处理项。若凭据或疑似敏感内容导致导出拒绝，则不会生成快照，安全错误不会回显敏感值；新环境认证和需要重配的 MCP/provider 设置必须人工补齐。
- 未执行真实本机恢复、真实 npm/Git 安装、OAuth 登录或模型请求；新电脑上的完整恢复和 ChatGPT Plus 可用性仍需人工验证。

## Skills-only 旧入口

原 `sync-skills.mjs` 和 `skills-manifest.json` 保留，用于通过 Skills CLI 从清单中的上游安装 Skills；它跟随上游当前内容，不保证保留本机逐字节内容。Pi 环境迁移请使用 `migrate.mjs export/import`，两者不是同一恢复机制。

## 测试

```sh
npm test
```

测试不会覆盖本机 Pi 目录，不会执行真实 package 安装、登录或模型请求。

当前项目目录：`D:\Code\Javascript\pi-migration`。项目目录本身不会自动同步；请先把迁移包传到新环境，再按上述流程单独传输快照。
