# 第2章 整体架构全景：10 个 Crate 的模块地图与数据流

## 本章概览

本章是全书的模块索引。目标是读完之后能在脑中画出 claw-code 的模块关系图，知道每个 crate 的名字、位置、职责，以及各章分别分析哪个模块。

claw-code 的 canonical runtime 是一个 Cargo workspace，位于 `rust/` 目录下，包含 10 个 crate、约 11.6 万行 Rust 代码。本章不展开任何模块的源码实现，只建立空间感和索引关系。

## 2.1 Rust Workspace 概述

仓库的 `rust/` 目录是一个 Cargo workspace，所有 crate 通过 `Cargo.toml` 的 `[workspace]` 段统一管理。workspace 强制 `unsafe_code = "forbid"`，把内存安全作为硬约束。

```toml
// claw-code/rust/Cargo.toml

[workspace]
members = ["crates/*"]
resolver = "2"

[workspace.lints.rust]
unsafe_code = "forbid"
```

`members = ["crates/*"]` 表示 workspace 自动包含 `crates/` 下的所有子目录。目前包含 10 个 crate，按代码规模排序如下：

| crate | 路径 | 职责 | 代码规模 | 对应章节 |
| --- | --- | --- | --- | --- |
| `runtime` | `rust/crates/runtime/` | 核心运行时：配置加载、Bootstrap、会话管理、权限引擎、MCP 通信、任务注册表、文件操作、Bash 执行 | ~41,700 LOC | 第3、4、7、8、9、10、11、12章 |
| `rusty-claude-cli` | `rust/crates/rusty-claude-cli/` | CLI 入口、参数解析、TUI 渲染、模型/权限溯源 | ~30,800 LOC | 第3章 |
| `api` | `rust/crates/api/` | HTTP 客户端、SSE 流式解析、多 provider 路由、prompt cache | ~11,900 LOC | 第5章 |
| `tools` | `rust/crates/tools/` | 内置工具实现：文件操作、Bash 执行、代码搜索、任务调度等 40 个工具规范 | ~11,800 LOC | 第6章 |
| `commands` | `rust/crates/commands/` | `/` 斜杠命令定义和分发 | ~7,200 LOC | 第3章（解析）、第4章（配置契约） |
| `plugins` | `rust/crates/plugins/` | 插件系统：安装、启用、禁用、生命周期管理、bundled hooks | ~4,500 LOC | 第7、10章 |
| `claw-analog` | `rust/crates/claw-analog/` | 轻量级代理外壳，适合 CI 和脚本场景 | ~4,800 LOC | — |
| `claw-rag-service` | `rust/crates/claw-rag-service/` | RAG 索引服务，基于 SQLite 的语义搜索 | ~1,100 LOC | — |
| `mock-anthropic-service` | `rust/crates/mock-anthropic-service/` | 确定性 mock 服务，用于测试 harness | ~1,200 LOC | 第13章 |
| `telemetry` | `rust/crates/telemetry/` | Token 计数、成本追踪、遥测指标 | ~500 LOC | — |
| `compat-harness` | `rust/crates/compat-harness/` | Python/Rust 一致性测试设施 | ~360 LOC | 第13章 |

其中 `runtime` 是最大的 crate，承载了配置加载、Bootstrap 引导、会话管理、权限引擎、MCP 通信和任务注册表等多个子系统。`rusty-claude-cli` 虽然代码量也很大，但大部分是 TUI 渲染和输入处理逻辑。后续章节会逐个展开。

## 2.2 一次完整交互的数据流

当用户在终端输入 `claw "帮我写一个快速排序"` 时，数据依次流经以下模块：

```mermaid
graph TD
    A[用户输入: claw "帮我写一个快速排序"] --> B[CLI 入口: rusty-claude-cli]
    B --> C[参数解析: CliAction 枚举匹配]
    C --> D[Bootstrap: 多阶段引导]
    D --> E[配置加载: ConfigLoader 三层合并]
    E --> F[工具注册: ToolPool 加载 40 个工具规范]
    F --> G[MCP 发现: McpServerManager 发现外部工具]
    G --> H[权限初始化: PermissionEnforcer 设置 PermissionMode]
    H --> I[会话创建: Conversation 初始化消息列表]
    I --> S[系统提示词构建: prompt.rs 组装 ProjectContext]
    S --> J[Turn Loop: ConversationRuntime 循环]
    J --> K[LLM 调用: api crate 发送请求]
    K --> L{LLM 要调用工具?}
    L -->|是| M[权限检查: PermissionEnforcer 检查路径]
    M --> N[工具执行: tools crate 执行操作]
    N --> O[结果回填: 工具结果加入消息列表]
    O --> J
    L -->|否| P[输出最终结果]
    P --> Q[会话存储: Session 持久化]
```

图中新增的"系统提示词构建"节点在会话创建和 Turn Loop 之间。`prompt.rs` 负责组装发给 LLM 的 `system` 字段，内容包括内置指令（如"你是一个编程助手"）、项目上下文（`.claw/rules/` 目录下的规则文件、`CLAUDE.md`）、工具列表描述（让 LLM 知道有哪些工具可用）、以及 `RulesImportConfig` 导入的外部框架规则（如 `.cursorrules`）。这个步骤决定了 LLM"知道自己能做什么、不能做什么"，是连接配置层与对话引擎的关键桥梁，详细实现在第11章。

这条数据流贯穿了全书的核心章节。每个节点对应一章的源码分析：

| 数据流节点 | 对应章节 | 对应模块 |
| --- | --- | --- |
| CLI 入口和参数解析 | 第3章 | `rusty-claude-cli` |
| Bootstrap 多阶段引导 | 第3章 | `runtime::bootstrap` |
| 配置三层合并 | 第3章 | `runtime::config` |
| 配置运行时契约 | 第4章 | `runtime::config` |
| API 通信与 SSE 流 | 第5章 | `api` crate |
| 工具注册与执行 | 第6章 | `tools` crate |
| MCP 工具发现 | 第7章 | `runtime::mcp_stdio` |
| 权限初始化与检查 | 第8章 | `runtime::permission_enforcer` |
| 会话创建与持久化 | 第9章 | `runtime::session` |
| 钩子拦截 | 第10章 | `runtime::hooks` |
| 系统提示词构建 | 第11章 | `runtime::prompt` |
| Turn Loop 循环 | 第11章 | `runtime::conversation` |
| 多 Agent 协调 | 第12章 | `runtime::task_registry` |

## 2.3 各章与模块的对应关系

下表是全书的阅读导航图。读任何一章前，都可以回到这张表确认它在系统中的位置。"关键数据结构"列列出每章分析的核心类型名，方便在源码中定位：

| 章节 | 标题 | 分析的模块 | 关键数据结构 | 核心问题 |
| --- | --- | --- | --- | --- |
| 第1章 | 什么是 Agent | — | — | Agent 和传统 CLI 有什么不同 |
| 第2章 | 整体架构全景 | — | — | 模块如何划分，数据如何流动 |
| 第3章 | 启动流程 | `rusty-claude-cli` + `runtime::bootstrap` + `runtime::config` + `commands` | `CliAction`、`BootstrapPhase`、`BootstrapPlan`、`ConfigLoader`、`SlashCommand`、`SkillCollection` | Bootstrap 如何工作，配置如何合并，命令如何解析 |
| 第4章 | 配置系统 | `runtime::config` | `RuntimeFeatureConfig`、`ConfigLoader`、`ConfigFileReport` | 配置契约、字段消费方速查、校验机制 |
| 第5章 | API 通信与模型交互 | `api` crate | `ProviderClient`、`SseParser`、`MessageRequest`、`MessageResponse`、`PromptCache` | 如何与 LLM 建立 SSE 流式连接 |
| 第6章 | 工具系统 | `tools` crate | `ToolSpec`、`GlobalToolRegistry`、`ToolExecutor`、`classify_bash_permission` | Agent 如何定义和执行 40 个工具 |
| 第7章 | MCP 协议与外部工具 | `runtime::mcp_*` + `plugins` | `McpServerManager`、`McpToolRegistry`、`McpClientTransport`、`PluginMetadata` | 如何连接外部工具和扩展 |
| 第8章 | 权限系统 | `runtime::permission_enforcer` + `runtime::permissions` | `PermissionMode`、`PermissionPolicy`、`PermissionEnforcer`、`TrustResolver` | 如何限制 Agent 的操作范围 |
| 第9章 | 会话管理 | `runtime::session` + `runtime::compact` | `Session`、`ContentBlock`、`ConversationMessage`、`SessionStore`、`compact_session` | 如何维护对话历史 |
| 第10章 | Hooks系统 | `runtime::hooks` + `plugins::hooks` | `HookRunner`、`RuntimeHookCommand`、`HookProgressEvent` | 如何在关键节点插入处理 |
| 第11章 | Turn Loop 与对话引擎 | `runtime::conversation` + `runtime::prompt` | `ConversationRuntime`、`run_turn`、`build_assistant_message`、`ApiRequest`、`ProjectContext` | Agent 如何循环决策，系统提示词如何构建 |
| 第12章 | 多 Agent 任务编排 | `runtime::task_registry` + `runtime::team_cron_registry` | `TaskRegistry`、`LaneBoard`、`TeamRegistry`、`CronRegistry`、`PolicyEngine` | 多 Agent 如何分工 |
| 第13章 | 测试与源码审计 | `mock-anthropic-service` + `compat-harness` | `MockAnthropicService`、`MockParityHarness`、`extract_manifest` | 如何保证行为正确性和覆盖率 |
| 第14章 | 总结与展望 | — | — | 核心架构回顾与演进方向 |

## 2.4 Crate 间依赖关系

了解 crate 之间的编译依赖有助于理解"为什么某个模块不能引用另一个模块"。核心依赖链如下：

```
rusty-claude-cli (入口)
    ├── runtime (核心运行时)
    │   ├── api (HTTP 通信)
    │   ├── tools (工具执行)
    │   └── plugins (插件生命周期)
    └── commands (命令解析)

tools (工具定义)
    └── runtime::task_registry (通过全局注册表)
```

`rusty-claude-cli` 是顶层入口，依赖 `runtime` 和 `commands`。`runtime` 是最核心的 crate，依赖 `api`（HTTP 客户端）、`tools`（工具执行）和 `plugins`（插件管理）。`commands` 保持无运行时依赖的纯粹性——它只负责解析命令文本为结构化枚举，不参与任何 I/O 操作。

`tools` crate 表面上被 `runtime` 依赖（工具执行需要运行时上下文），但实际上 `tools` 中也通过 `OnceLock` 全局单例反向访问 `runtime::task_registry` 中的 `TeamRegistry` 和 `CronRegistry`。这种循环依赖通过全局单例在运行时解析，绕开了编译期的直接引用，避免了 Cargo 的循环依赖错误。

`api` crate 独立程度最高——它只负责 HTTP 通信和 SSE 解析，不依赖 `runtime` 或 `tools`。这种设计允许 `api` 被单独测试，也可以在未来被其他项目复用。

## 2.5 源码目录结构速查

初次接触 claw-code 源码时，以下目录结构帮助快速定位文件：

```
claw-code/
├── rust/
│   ├── Cargo.toml              # Workspace 定义
│   ├── crates/
│   │   ├── rusty-claude-cli/   # CLI 入口 (第3章)
│   │   │   └── src/main.rs
│   │   ├── runtime/            # 核心运行时 (第3-12章)
│   │   │   └── src/
│   │   │       ├── bootstrap.rs
│   │   │       ├── config.rs
│   │   │       ├── conversation.rs
│   │   │       ├── prompt.rs
│   │   │       ├── session.rs
│   │   │       ├── permission_enforcer.rs
│   │   │       ├── hooks.rs
│   │   │       ├── task_registry.rs
│   │   │       └── mcp_*.rs
│   │   ├── api/                # HTTP 通信 (第5章)
│   │   │   └── src/
│   │   │       ├── client.rs
│   │   │       ├── sse.rs
│   │   │       └── providers/
│   │   ├── tools/              # 工具规范 (第6章)
│   │   │   └── src/lib.rs
│   │   ├── commands/           # 命令解析 (第3章)
│   │   │   └── src/lib.rs
│   │   ├── plugins/            # 插件系统 (第7、10章)
│   │   │   └── src/lib.rs
│   │   ├── mock-anthropic-service/  # 测试模拟 (第13章)
│   │   ├── compat-harness/     # 兼容性审计 (第13章)
│   │   ├── telemetry/          # 成本追踪
│   │   ├── claw-analog/        # 轻量代理
│   │   └── claw-rag-service/   # RAG 检索
│   └── scripts/
│       └── run_mock_parity_harness.sh
└── src/                        # Python 参考实现（本书不分析）
```

带括号标注的是本书分析的章节。`runtime/src/` 下的文件最多——这是理解 claw-code 的核心目录，建议读者在阅读过程中保持该目录在编辑器中打开。

## 小结

claw-code 的 canonical runtime 是 `rust/` 下的 Cargo workspace，包含 10 个 crate，总计约 11.6 万行 Rust 代码。其中 `runtime` crate 最大（~41,700 LOC），承载配置、Bootstrap、会话、权限、MCP 和任务六个子系统。`rusty-claude-cli` 是顶层入口，依赖 `runtime` 和 `commands`；`api` 独立程度最高，只负责 HTTP 通信。

一次完整的用户交互从 CLI 入口出发，经过 Bootstrap 引导、配置加载、工具注册、MCP 发现、权限初始化、会话创建、系统提示词构建、Turn Loop 循环、LLM 调用、权限检查、工具执行、结果回填，最终输出结果并持久化会话。系统提示词构建（`prompt.rs`）是连接配置层与对话引擎的关键桥梁，决定了 LLM"知道自己能做什么"。

各章模块对应关系表（2.3）和关键数据结构列是全书的核心索引——读任何一章前都可以回到这里确认位置和核心类型名。

下一章将追踪一次完整的命令执行路径，展示数据如何从 CLI 入口流经各模块到达第一条 LLM 响应。
