# 第二阶段覆盖范围与章节规划（修订版）

本文档是结合 claw-code 源码审查后的修订版规划。第一阶段完成后的源码审查发现，runtime/src/ 中部分被初步归类为"辅助模块"的文件实际上承载了重要的架构设计，因此第二阶段从 6 章扩展为 8 章。

---

## 一、第一阶段覆盖范围回顾

第一阶段共 15 章（含导读），覆盖核心 Agent 运行时的主线链路：

| 章节 | 主题 | 对应 crate / 模块 |
|------|------|-------------------|
| 第 0-3 章 | 导读、Agent 概念、架构全景、启动流程 | rusty-claude-cli, runtime/bootstrap |
| 第 4 章 | 配置系统 | runtime/config, runtime/policy_engine, commands |
| 第 5 章 | API 通信与模型交互 | api/client, api/sse, api/providers, api/prompt_cache |
| 第 6 章 | Turn Loop 与对话引擎 | runtime/conversation, runtime/prompt |
| 第 7 章 | 工具系统 | tools, runtime/file_ops, runtime/bash |
| 第 8 章 | MCP 协议与外部工具连接 | runtime/mcp_*, plugins |
| 第 9 章 | 权限系统 | runtime/permission_enforcer, runtime/permissions, runtime/trust_resolver |
| 第 10 章 | 会话管理 | runtime/session, runtime/compact, runtime/session_control |
| 第 11 章 | 钩子系统 | runtime/hooks, plugins/hooks |
| 第 12 章 | 任务与团队注册表 | runtime/task_registry, runtime/team_cron_registry |
| 第 13 章 | 测试与源码审计 | mock-anthropic-service, compat-harness |
| 第 14 章 | 总结与展望 | — |

**第一阶段已覆盖但未深挖的实现细节**：

| 模块 | 所属第一阶段章节 | 说明 |
|------|-----------------|------|
| runtime/src/bash_validation.rs | 第 7/9 章 | 第一阶段讲了权限模式和工具规范，但未展开 Bash 命令的安全校验流水线 |
| runtime/src/approval_tokens.rs | 第 9 章 | 第一阶段讲了 PermissionMode，但未涉及细粒度审批令牌的状态机 |
| runtime/src/usage.rs | 第 5/10 章 | 第一阶段讲了 API 请求和会话，但未覆盖 TokenUsage 和成本估算 |
| runtime/src/summary_compression.rs | 第 10 章 | 第一阶段讲了会话压缩，但未展开基于优先级的摘要压缩算法 |
| tools/src/pdf_extract.rs | 第 7 章 | 第一阶段讲了工具规范，但未覆盖具体工具的 PDF 解析实现 |

上述模块在第二阶段的对应章节中以"与核心系统的关联"方式补充引用，不单独成章。

---

## 二、第二阶段覆盖范围与章节规划（8 章）

第二阶段聚焦核心运行时之外的社区扩展模块，以及源码审查后确认具有独立架构价值的内部子系统。每章可独立阅读，编号接第一阶段。

### 第 15 章 claw-analog：精简 Agent Harness

**定位**：独立命令行工具，面向 CI/自动化场景的窄工具集 agent。

**覆盖范围**：
- 设计动机：为什么核心 CLI（claw）之外需要一个精简版本
- 工具集边界：read/list/grep/write，无 bash/MCP/插件
- 配置体系：`.claw-analog.toml`、CLI flags、profile、preset、permission 的合并优先级
- 权限与路径隔离：复用 `runtime::PermissionEnforcer`，但支持 `--no-runtime-enforcer`
- 输出格式：rich text 与 NDJSON 的事件流设计
- RAG 集成点：`retrieve_context` 工具如何通过 HTTP 调用外部服务

**关键文件**：

| 文件路径 | 职责 |
|----------|------|
| rust/crates/claw-analog/src/lib.rs | 核心 harness：配置合并、工具循环、权限校验 |
| rust/crates/claw-analog/src/main.rs | CLI 参数解析、子命令分发（doctor/config/complete/agents） |
| rust/crates/claw-analog/Cargo.toml | 依赖关系：api + runtime + clap |

**与核心系统的关系**：复用 `api` crate 的 ProviderClient 和 `runtime` 的 PermissionEnforcer，但有自己的配置合并逻辑和事件流输出。

---

### 第 16 章 claw-rag-service：RAG 检索服务

**定位**：独立 HTTP 服务，负责工作区文件的索引、嵌入和语义检索。

**覆盖范围**：
- 架构决策：为什么 RAG 不内嵌在核心运行时或 claw-analog 中
- 索引流程：文件遍历 → chunk 切分 → 嵌入向量 → SQLite 持久化
- 检索流程：查询嵌入 → 余弦相似度排序 → 返回 path/snippet/score
- HTTP API 路由：GET /health、GET /v1/stats、POST /v1/query
- 存储演进：SQLite MVP → Qdrant 可选后端的切换机制
- 跨仓库索引：多 workspace 的 ingest 与 repoId 前缀隔离

**关键文件**：

| 文件路径 | 职责 |
|----------|------|
| rust/crates/claw-rag-service/src/lib.rs | 模块入口：RagHit、QueryRequest/Response 类型定义 |
| rust/crates/claw-rag-service/src/ingest.rs | 文件遍历、chunk 生成、批量写入 |
| rust/crates/claw-rag-service/src/search.rs | 查询嵌入、相似度计算、top-k 排序 |
| rust/crates/claw-rag-service/src/main.rs | axum 路由、serve/ingest 子命令 |
| rust/crates/claw-rag-service/Cargo.toml | 特性开关：qdrant-index |

**与核心系统的关系**：被 claw-analog 通过 HTTP `POST /v1/query` 调用，与核心运行时无直接依赖。

---

### 第 17 章 telemetry：会话追踪与遥测

**定位**：共享库，为核心运行时提供结构化事件收集和持久化能力。

**覆盖范围**：
- 事件模型：HttpRequestStarted/Succeeded/Failed、AnalyticsEvent、SessionTraceRecord 的 schema 设计
- Sink 架构：`TelemetrySink` trait、MemoryTelemetrySink（测试用）、JsonlTelemetrySink（生产用）
- SessionTracer：基于原子序列号的事件排序与会话关联
- 与 api crate 的集成：ClientIdentity、AnthropicRequestProfile 如何注入版本头和 beta 字段
- 数据契约：NDJSON 持久化格式与可观测性系统的对接假设

**关键文件**：

| 文件路径 | 职责 |
|----------|------|
| rust/crates/telemetry/src/lib.rs | 全部实现：事件类型、Sink trait、SessionTracer |
| rust/crates/telemetry/Cargo.toml | 纯 serde + std 依赖，刻意保持零外部网络库 |

**与核心系统的关系**：被 `api` crate（ClientIdentity）和 `runtime` crate（会话追踪）作为库依赖使用，本身无独立进程。

---

### 第 18 章 Python 原始实现：移植层架构

**定位**：Rust 重写前的 Python 参考层，作为架构演进的对照。

**覆盖范围**：
- 整体结构：命令图（command_graph）、工具池（tool_pool）、查询引擎（query_engine）三大子系统
- 启动阶段：bootstrap_graph.py 的阶段定义与 Rust runtime/bootstrap.rs 的对应关系
- 运行时模型：runtime.py 中 PortRuntime / RuntimeSession 的字段设计，与 Rust ConversationRuntime 的差异
- 命令与工具的组织方式：Python 层如何通过 JSON 快照镜像上游 Claude Code 的接口
- 迁移线索：哪些 Python 子系统被合并到了 Rust 的哪些 crate

**关键文件**：

| 文件路径 | 职责 |
|----------|------|
| src/main.py | CLI 入口与子命令注册 |
| src/runtime.py | RuntimeSession 与核心状态机 |
| src/bootstrap_graph.py | 启动阶段定义 |
| src/command_graph.py | 命令组织与路由 |
| src/query_engine.py | 查询路由与 TurnResult |
| src/tool_pool.py | 工具组装与过滤 |
| src/reference_data/ | 子系统 JSON 快照（架构划分参考） |

**与核心系统的关系**：这是 Rust 重写的来源。讲解目的是说明概念如何从 Python 原型迁移到 Rust 实现，而非分析 Python 代码的运行细节。

---

### 第 19 章 插件系统：契约与生命周期

**定位**：插件元数据管理、安装/启用/禁用/更新流程，以及 hook 集成点。

**覆盖范围**：
- plugin.json 契约：schema 字段、版本语义、hook 声明
- 目录结构约定：`.claude-plugin/` 与 `hooks/` 的布局
- 生命周期状态机：安装 → 启用 → 禁用 → 卸载 → 更新
- hooks 脚本：pre.sh / post.sh 的触发时机与执行上下文
- bundled 示例：example-bundled 和 sample-hooks 的目录结构解析
- 与第 8 章 MCP、第 11 章 Hooks 的边界：插件管理 surface 与运行时 hook 调用的分工

**关键文件**：

| 文件路径 | 职责 |
|----------|------|
| rust/crates/plugins/src/lib.rs | 插件元数据、生命周期管理 surface |
| rust/crates/plugins/src/hooks.rs | 插件 hook 集成 |
| rust/crates/plugins/bundled/example-bundled/.claude-plugin/plugin.json | 契约示例 |
| rust/crates/plugins/bundled/example-bundled/hooks/pre.sh | 前置 hook 示例 |
| rust/crates/plugins/bundled/example-bundled/hooks/post.sh | 后置 hook 示例 |

**与核心系统的关系**：插件 crate 被 runtime 的 plugin_lifecycle.rs 消费，hook 脚本由运行时在执行工具调用前后触发。

---

### 第 20 章 沙箱与进程隔离：Linux Namespace 与容器检测

**定位**：Agent 运行时的安全边界延伸——从软件层面权限控制到操作系统层面的进程隔离。

**源码审查后的新增章节**。sandbox.rs 的实现在源码审查前被低估，实际内容远超"容器检测"：

**覆盖范围**：
- 容器环境检测：/.dockerenv、/run/.containerenv、/proc/1/cgroup、环境变量的多源联合检测
- Linux namespace 隔离：unshare 系统调用、用户命名空间（--map-root-user）、挂载/IPC/PID/UTS 隔离
- unshare 映射候选探测：针对 hardened 容器和 seccomp 限制的 fallback 策略（--map-auto）
- 网络隔离：--net 命名空间的条件启用与探测策略（避免在不支持的主机上误禁用沙箱）
- 文件系统隔离模式：Off / WorkspaceOnly / AllowList 三级隔离
- SandboxStatus 状态机：enabled → requested → supported → active 的决策链路
- 与权限系统（第 9 章）的分工：PermissionMode 管"能做什么"，Sandbox 管"在哪个环境里做"

**关键文件**：

| 文件路径 | 职责 |
|----------|------|
| rust/crates/runtime/src/sandbox.rs | 容器检测、namespace 隔离、沙箱命令构建 |
| rust/crates/runtime/src/bash_validation.rs | Bash 命令安全校验流水线（关联引用） |
| Containerfile | 官方容器镜像定义（关联引用） |

**与核心系统的关系**：sandbox.rs 是 runtime crate 的核心安全模块，被 CLI 通过 `claw sandbox` 暴露，被 bash 工具执行器调用来构建隔离的执行环境。

---

### 第 21 章 故障恢复与自愈：Recovery Recipes 与 Worker Boot

**定位**：Agent 运行时的故障处理体系——定义失败场景、自动恢复配方、升级策略。

**源码审查后的新增章节**。recovery_recipes.rs 定义了一个完整的故障恢复框架，不应被忽略。

**覆盖范围**：
- 失败场景枚举：TrustPromptUnresolved、PromptMisdelivery、StaleBranch、CompileRedCrossCrate、McpHandshakeFailure、PartialPluginStartup、ProviderFailure
- RecoveryRecipe 结构：场景 → 步骤序列 → 最大尝试次数 → 升级策略（AlertHuman / LogAndContinue / Abort）
- RecoveryContext：尝试计数、事件日志、机器可读 ledger、状态报告
- 恢复执行流程：尝试 → 部分恢复 → 升级（escalation）的三态结果
- WorkerFailureKind 到 FailureScenario 的映射桥
- 与 stale_branch.rs 的关联：分支新鲜度检查（Fresh/Stale/Diverged）和策略应用（AutoRebase/AutoMergeForward/WarnOnly/Block）
- 与 session（第 10 章）和 MCP（第 8 章）的恢复关联

**关键文件**：

| 文件路径 | 职责 |
|----------|------|
| rust/crates/runtime/src/recovery_recipes.rs | 失败场景、恢复配方、执行引擎、ledger |
| rust/crates/runtime/src/worker_boot.rs | Worker 启动失败类型定义（被 recovery 消费） |
| rust/crates/runtime/src/stale_branch.rs | 分支新鲜度检测与策略 |
| rust/crates/runtime/src/stale_base.rs | 基础分支状态检测（关联引用） |
| rust/crates/runtime/src/branch_lock.rs | 分支锁定机制（关联引用） |

**与核心系统的关系**：recovery_recipes.rs 被 runtime 在启动失败或运行时异常时调用，与 worker_boot.rs、stale_branch.rs 组成完整的故障处理链路。

---

### 第 22 章 容器化与部署：Docker/Podman 工作流

**定位**：部署层面的扩展设施。

**覆盖范围**：
- Containerfile 设计：不内嵌仓库、bind-mount 工作流的设计意图
- docker-compose.yml：RAG 服务与 Qdrant 的编排关系
- 容器内运行时的行为差异：权限策略、路径 jail、环境变量隔离
- 与第 20 章 sandbox.rs 的衔接：`claw sandbox` 命令如何暴露检测状态

**关键文件**：

| 文件路径 | 职责 |
|----------|------|
| Containerfile | 官方容器镜像定义 |
| docker-compose.yml | RAG + Qdrant 编排 |
| docs/container.md | 容器工作流文档（结构参考） |

**与核心系统的关系**：容器化设施本身与核心运行时无代码依赖，是部署层面的扩展。sandbox.rs（第 20 章）被容器内运行时调用以报告环境状态。

---

## 三、明确不覆盖的内容及原因

以下内容是 claw-code 仓库真实存在的文件或模块，但被有意识地排除在第一阶段和第二阶段之外。

### 1. 项目治理与社区文档

**内容**：PHILOSOPHY.md、SECURITY.md、CODE_OF_CONDUCT.md、CONTRIBUTING.md、SUPPORT.md、LICENSE、FUNDING.yml、ISSUE_TEMPLATE/

**原因**：这些是开源项目的社区治理和法务文件，与 Agent 运行时的架构设计和实现无关。

### 2. 开发路线图与流程验证文档

**内容**：ROADMAP.md、docs/g00x-*-verification-map.md、docs/roadmap-pr-goals.md、docs/pr-issue-resolution-gate.md

**原因**：这些是项目内部的开发进度追踪、验证清单和发布流程文档，属于项目管理范畴。它们描述的是"项目要做什么"和"如何验收"，而非"系统如何运行"。

### 3. CI/CD 配置与辅助脚本

**内容**：.github/workflows/*.yml、.github/hooks/、.github/scripts/、scripts/cc2_board.py、scripts/dogfood-build.sh、scripts/fmt.sh 等

**原因**：持续集成配置和发布辅助脚本属于工程实践工具，不承载 Agent 运行时的设计决策。

### 4. 用户手册与使用指南

**内容**：USAGE.md、how_to_run.md、docs/local-openai-compatible-providers.md、docs/personal-assistant-roadmap.md、docs/navigation-file-context.md

**原因**：手册的定位是讲解源码架构，不是使用教程。这些文档面向终端用户，说明"如何运行"和"如何配置"，而非"为什么这样设计"。其中 how_to_run.md 在第 15 章（claw-analog）的架构层面被引用，不再单独覆盖。

### 5. 静态资源与数据文件

**内容**：assets/（图片、截图）、src/reference_data/*.json（命令/工具快照）

**原因**：图片是文档装饰和营销材料；JSON 快照是 Python 移植层的数据镜像，不含可分析的实现逻辑。第 18 章会引用 reference_data/ 的目录结构来说明子系统划分，但不会分析 JSON 内容本身。

### 6. 会话存档与临时文件

**内容**：.claude/sessions/*、.claw/sessions/*、.port_sessions/*、.omc/plans/

**原因**：这些是运行时生成的会话持久化数据和计划文件，属于运行产物而非源码。

### 7. 基准测试与构建配置细节

**内容**：api/benches/request_building.rs、rust/Cargo.toml 的 workspace 元数据、各 crate 的 Cargo.toml 中的常规依赖声明

**原因**：基准测试是性能测量工具，不承载架构信息；Cargo 的 workspace 配置是 Rust 工程常规设置，除非依赖选择本身反映了架构决策（如 telemetry crate 刻意保持零外部网络依赖），否则不展开。

### 8. 嵌入式 UI 与前端代码

**内容**：claw-rag-service/static/index.html

**原因**：这是最小化的单页查询界面，属于附属 UI。第 16 章会说明它通过 axum 的 `include_str!` 内嵌服务，但不会分析 HTML/CSS/JS 实现。

### 9. 未完成的实验性模块

**内容**：runtime/src/lsp_client.rs

**原因**：LSP 客户端目前只是一个注册表结构，dispatch 方法返回的是占位符（"LSP {} dispatched to {} server"），没有真正的 LSP JSON-RPC 实现。这是一个实验性/未完成的模块，不具备讲解价值。

### 10. 周边 crate 的 CLI 子命令实现细节

**内容**：claw-analog 的 `agents.rs`、`config_cmd.rs`、`doctor.rs`；rusty-claude-cli 的 `setup_wizard.rs`、`input.rs` 等

**原因**：这些是常规的 CLI 子命令实现（clap 的参数定义、子命令分发、配置验证预览），与核心机制（如权限策略、会话状态机、工具规范）无关。第 15 章只需引用 main.rs 说明子命令注册结构即可，不深入每个子命令的内部逻辑。

### 11. 纯工具函数和简单辅助模块

**内容**：
- `runtime/src/json.rs` — 内部 JSON 工具函数
- `runtime/src/trident.rs` — 内部并发/调度工具
- `runtime/src/oauth.rs` — OAuth 认证流程的辅助实现（被 API 调用封装）
- `runtime/src/git_context.rs` — Git 仓库上下文收集（分支名、最近 5 条提交、暂存文件），简单的 `Command::new("git")` 调用组合
- `runtime/src/usage.rs` — Token 用量与成本估算（第 5/10 章的补充，属简单计算逻辑）
- `runtime/src/summary_compression.rs` — 会话摘要压缩算法（第 10 章的补充，基于优先级的行选择策略）
- `tools/src/pdf_extract.rs` — PDF 文本提取（第 7 章的补充，具体工具实现）
- `runtime/src/lane_events.rs`、`runtime/src/lane_completion.rs`、`runtime/src/task_packet.rs` — lane 流水线的事件传递和完成检测
- `runtime/src/g004_conformance.rs`、`runtime/src/green_contract.rs`、`runtime/src/report_schema.rs` — 合规性检查与审计事件契约

**原因**：这些模块要么是已覆盖主题（权限、会话、工具、MCP、lane）的实现细节延伸，要么是纯工具函数（json.rs、trident.rs），要么是特定场景的小范围扩展（OAuth、PDF 解析）。手册追求"讲解核心机制与架构边界"而非"穷尽每一行源码"。这些模块在所属主题章节中以引用和关联方式提及即可，不需要独立成章。

---

## 四、两阶段完整章节目录

### 第一阶段：核心运行时（已覆盖，15 章）

- 第 0 章 导读：本书定位与阅读指南
- 第 1 章 什么是 Agent：Agent 与传统 CLI 的本质区别
- 第 2 章 整体架构全景：11 个 Crate 的模块地图与数据流
- 第 3 章 启动流程：从 CLI 到第一条消息
- 第 4 章 配置系统：运行时契约与子系统集成
- 第 5 章 API 通信与模型交互：SSE 流与 Provider 路由
- 第 6 章 Turn Loop 与对话引擎：Conversation Runtime
- 第 7 章 工具系统：55 个工具规范
- 第 8 章 MCP 协议与外部工具连接
- 第 9 章 权限系统：Agent 的安全边界
- 第 10 章 会话管理：Session 状态机与自动压缩
- 第 11 章 钩子系统：用户自定义拦截
- 第 12 章 任务与团队注册表：TaskRegistry、TeamRegistry 与 CronRegistry
- 第 13 章 测试与源码审计：Mock Parity 与兼容性追踪
- 第 14 章 总结与展望：从 claw-code 到 clawable

### 第二阶段：社区扩展与深层子系统（规划，8 章）

- 第 15 章 claw-analog：精简 Agent Harness
- 第 16 章 claw-rag-service：RAG 检索服务
- 第 17 章 telemetry：会话追踪与遥测
- 第 18 章 Python 原始实现：移植层架构
- 第 19 章 插件系统：契约与生命周期
- 第 20 章 沙箱与进程隔离：Linux Namespace、容器检测与权限越狱防护
- 第 21 章 故障恢复与自愈：Recovery Recipes 与 Worker Boot
- 第 22 章 容器化与部署：Docker/Podman 工作流

---

## 五、修订说明

相比初版规划，本次修订基于源码审查做了以下关键调整：

1. **新增第 20 章（沙箱与进程隔离）**：初版将 sandbox.rs 放在第 22 章"容器化与部署"中作为小节。源码审查发现 sandbox.rs 独立承载了 Linux namespace 隔离、unshare 探测、文件系统/网络隔离模式等重要安全架构，内容量足以独立成章。

2. **新增第 21 章（故障恢复与自愈）**：初版将 recovery_recipes.rs 列为"不覆盖的辅助模块"。源码审查发现它定义了七种失败场景的恢复配方、升级策略和机器可读 ledger，是系统韧性设计的重要组成。

3. **重新归类 bash_validation.rs**：从"不覆盖"调整为第 20 章的关联引用。Bash 命令的安全校验流水线（readOnlyValidation、destructiveCommandWarning、modeValidation、sedValidation、pathValidation、commandSemantics）是 Agent 安全边界的关键实现，应在沙箱隔离的上下文中补充说明。

4. **重新归类 approval_tokens.rs**：从"不覆盖"调整为第 9 章的关联引用。审批令牌的状态机（Pending/Granted/Consumed/Expired/Revoked）、作用域检查和委托链追踪，是 PermissionMode 之下的细粒度授权机制，应在第二阶段的权限回顾中补充。

5. **明确 lsp_client.rs 不覆盖的原因**：补充了"未完成/实验性"的具体说明（dispatch 返回占位符，无真实 LSP JSON-RPC 实现）。
