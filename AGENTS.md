# pi-migration AI 协作指南

本文件定义本项目长期有效的 AI Coding 协作规则。通用任务执行流程、证据门控、工具调用和角色交接规则由随 package 发布的 `pi-init-role-routing` Skill 统一维护；执行相关任务时按需读取该 Skill 及对应的 `roles/*.md`，不要在本文件复制其内容。

1. 先确认与任务直接相关的项目规则（包括需要时的 `docs/clean-code.md`）、项目记忆或代码；项目记忆优先按关键词定位相关段落，而非全量读取；
2. 项目 `.pi/role-models.json` 仅通过 `roleModels` 映射启用角色和配置模型，不生成或维护项目级 Skill；
3. 仅当任务需要沉淀可复用的跨项目知识时，更新知识库 `https://github.com/CGOSU/knowledge.git`；更新前先在其本地检出中执行 `git pull`，完成后可自动创建中文 commit；push 仍须用户明确授权；
4. 本仓库 Git 身份使用 `git config user.name CGOSU` 和 `git config user.email dev@cgosu.com`；
5. 本仓库任务完成并通过适用检查后，默认自动创建中文 commit，仅包含明确归属于本任务的改动；若已有/暂存改动无法安全区分，先暂停提交并说明。push 必须得到用户明确授权。

## 项目定位

用于将本机 Pi Agent 中可迁移的非敏感配置和资源导出为快照，并在新电脑恢复；凭据、登录状态和会话记录不迁移。当前实现状态及经核对的边界见 `docs/current-state.md`，详细需求与证据见 `docs/implementation-plan.md`。

## 公共协作规则

通用的任务执行流程、证据门控、`read`/`edit` 工具调用、角色边界和真实验证要求由随 package 发布的 `pi-init-role-routing` Skill 统一维护。执行代码、测试、文档或工作流任务时，按需读取该 Skill 及对应角色说明；本文件只保留项目定位、环境、命令、知识库和 Git 等项目特有规则。

目标明确的低风险任务由 AI 自主选择实现方案并直接推进；不因 helper、内部拆分、测试组织、排查顺序或恢复既定行为的 bug 请求用户选择。只有业务/契约冲突、权限或凭据缺失、不可逆或外部状态操作、已有改动无法安全合并或真实验证阻塞时才询问；新增行为、契约、权限或数据结构仍先记录到确认的需求/决策载体。

## 工作流执行

pi-init 工作流仅在当前主会话内按顺序执行（local）；缺省配置及旧 `workflowExecutor: "local"` 配置可用。旧顶层 `runtime` 配置或 `workflowExecutor: "runtime"` 会返回明确退役错误，不会静默回退。含 Runtime executor/authority 的旧 session entry 不会自动恢复、改写或删除；请先检查并由用户自行决定如何处理旧配置与记录。

## 运行环境与命令约定

- 初始化时检测到的宿主系统：Windows (`win32`)，CPU 架构：`x64`。
- 这是运行 Pi 的宿主环境快照，不一定是项目部署目标；如果实际执行发生在 WSL、容器、远程主机或其他环境中，应重新检测并以当前环境为准。
- Pi 的内置 `bash` 工具在 Windows 上通常通过 Bash 执行；扩展使用 `pi.exec` 时是直接启动进程，不会经过 Bash。
- 查找命令优先使用 `where.exe` 或当前 shell 支持的 `command -v`；不要把 Linux-only 的 `which` 作为唯一检查。
- npm 全局 CLI 可能通过 Windows `.cmd` shim 暴露；直接启动时要选择当前平台可用的执行入口。
- 如果工具提示 CLI 不存在，先用 `where.exe <command>`（以及对应的 `.cmd` shim）核实，再决定是否安装。

## 常用命令

- 测试：`npm test`（执行 Node.js 内置 `node --test`）
- 预览导出：`node ./migrate.mjs export --dry-run`
- 预览导入：`node ./migrate.mjs import --dry-run --snapshot-dir <path>`

## 验证要求

- 满足 Fast Path 条件时，按 Fast Path 规则，不默认运行测试；否则按本节验证要求执行。
- 新增或修复行为时补充针对性测试；先根据本次改动选择最小相关测试集，测试运行器支持时使用文件或变更范围过滤，不要默认运行全量测试。
- 同一工作区内，如果自最近一次验证后，相关实现、测试、依赖和测试配置均未变化，可复用已通过的验证结果，不要重复执行；相关内容发生变化后，重新运行受影响的检查。
- 仅在用户明确要求、改动跨多个模块或影响测试基础设施/依赖配置、无法界定相关测试范围，或准备交付/发布时运行全量测试。
- 只记录实际执行的验证及真实结果；复用结果时说明依据，不把未执行检查描述为通过。

<!-- pi-init:managed:start fast-path-wrap-up -->
## Fast Path 收尾优先级

满足全局 `AGENTS.md` 定义的全部 Fast Path 条件，或用户通过 `/fast` 显式手动选择本次 Fast Path 时，本节优先于下方通用会话收尾规则。`/fast` 覆盖自动适用时的任务类型、规模和修改范围判断；安全、权限、需求确认、职责边界、上下文恢复门与必要验证仍优先。

- 只修改明确目标及保持仓库一致性所必需的直接关联内容；
- 不仅因任务不符合自动 Fast Path 适用条件而创建 `task_workflow` 或额外书面计划；任务本身独立要求架构规划或工作流时仍须遵循；
- 不为判断是否需要留痕而预读或更新 `docs/current-state.md`、`docs/decisions.md`、`docs/session-log.md` 和 `docs/pitfalls.md`；
- 不默认运行 test、typecheck、lint、formatter、build 或 dev server，只进行必要的静态核对；
- 不因规划或例行留痕额外切换角色，但职责路由、上下文恢复门和 architect 禁止执行的边界仍然有效。

若目标文件本身就是文档或项目记录，可以定向读取和修改该目标，不因此退出 Fast Path。

未通过 `/fast` 显式手动选择时，出现以下任一情况代表任务不符合自动 Fast Path 条件；手动选择不覆盖相应的安全、职责、验证或记录要求：

- 除必要的字段名称修改或字段映射变更外，不涉及 API、数据结构、依赖、架构、业务规则、权限、路由、交互或无障碍语义变更；
- 产生后续开发需要依赖的新事实、重要决策、遗留问题、关键验证结果或可复发陷阱；
- 修改范围不再局部、低风险或可逆。

用户明确要求测试、构建、更新其他文档或执行 Git 收尾时，只增加对应动作，并继续遵循相应职责规则。
<!-- pi-init:managed:end fast-path-wrap-up -->

## 会话收尾

完成任务后：

1. 更新 `docs/current-state.md`，只保留当前事实和未完成事项；其“最近一次更新”列表按日期倒序；
2. 将影响后续实现的重要选择记录到 `docs/decisions.md`，按日期倒序插入，最新条目在前；
3. 在 `docs/session-log.md` 新增完成内容、验证命令和遗留问题，按日期倒序插入，最新条目在前；
4. 将新发现的隐蔽且可复发问题沉淀到 `docs/pitfalls.md`，按日期倒序插入，最新条目在前。

仅在产生新事实时更新对应文件，不为留痕进行无意义修改。一个事实只在一个文件中维护；其他文件需要引用时，使用摘要和相对路径指向唯一来源。
