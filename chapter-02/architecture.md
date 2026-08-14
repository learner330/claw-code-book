# 第2章 整体架构全景：10 个 Crate 的模块地图与数据流

## 本章概览

本章是全书的模块索引。目标是读完之后能在脑中画出 claw-code 的模块关系图，知道每个 crate 的名字、位置、职责，以及各章分别分析哪个模块。

claw-code 的 canonical runtime 是一个 Cargo workspace，位于 `rust/` 目录下，包含 10 个 crate、约 9.6 万行 Rust 代码。本章不展开任何模块的源码实现，只建立空间感和索引关系。

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
| `runtime` | `rust/crates/runtime/` | 核心运行时：配置加载、Bootstrap、会话管理、权限引擎、MCP 通信、任务注册表、文件操作、Bash 执行 | ~41,700 LOC | 第4、7、8、9、10、11、12章 |
| `rusty-claude-cli` | `rust/crates/rusty-claude-cli/` | CLI 入口、参数解析、TUI 渲染、模型/权限溯源 | ~30,800 LOC | 第3、4章 |
| `api` | `rust/crates/api/` | HTTP 客户端、SSE 流式解析、多 provider 路由、prompt cache | ~11,900 LOC | 第5章 |
| `tools` | `rust/crates/tools/` | 内置工具实现：文件操作、Bash 执行、代码搜索、任务调度等 40 个工具规范 | ~11,800 LOC | 第6章 |
| `commands` | `rust/crates/commands/` | `/` 斜杠命令定义和分发 | ~7,200 LOC | 第16章 |
| `plugins` | `rust/crates/plugins/` | 插件系统：安装、启用、禁用、生命周期管理、bundled hooks | ~4,500 LOC | 第9、12章 |
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
    I --> J[Turn Loop: ConversationRuntime 循环]
    J --> K[LLM 调用: api crate 发送请求]
    K --> L{LLM 要调用工具?}
    L -->|是| M[权限检查: PermissionEnforcer 检查路径]
    M --> N[工具执行: tools crate 执行操作]
    N --> O[结果回填: 工具结果加入消息列表]
    O --> J
    L -->|否| P[输出最终结果]
    P --> Q[会话存储: Session 持久化]
```

这条数据流贯穿了全书的核心章节。每个节点对应一章的源码分析：

| 数据流节点 | 对应章节 | 对应模块 |
| --- | --- | --- |
| CLI 入口和参数解析 | 第4章 | `rusty-claude-cli` |
| Bootstrap 多阶段引导 | 第4章 | `runtime::bootstrap` |
| 配置三层合并 | 第4章 | `runtime::config` |
| API 通信与 SSE 流 | 第5章 | `api` crate |
| 工具注册与执行 | 第6章 | `tools` crate |
| MCP 工具发现 | 第12章 | `runtime::mcp_stdio` |
| 权限初始化与检查 | 第8章 | `runtime::permission_enforcer` |
| 会话创建与持久化 | 第10章 | `runtime::session` |
| Turn Loop 循环 | 第7章 | `runtime::conversation` |

## 2.3 各章与模块的对应关系

下表是全书的阅读导航图。读任何一章前，都可以回到这张表确认它在系统中的位置：

| 章节 | 标题 | 分析的模块 | 核心问题 |
| --- | --- | --- | --- |
| 第1章 | 什么是 Agent | — | Agent 和传统 CLI 有什么不同 |
| 第2章 | 整体架构全景 | — | 模块如何划分，数据如何流动 |
| 第3章 | 启动到第一条消息 | `rusty-claude-cli` + `runtime` | 一条命令经过哪些模块 |
| 第4章 | 启动流程深度解析 | `rusty-claude-cli` + `runtime::bootstrap` + `runtime::config` | Bootstrap 如何工作，配置如何合并 |
| 第5章 | API 通信与模型交互 | `api` crate | 如何与 LLM 建立 SSE 流式连接 |
| 第6章 | 工具系统 | `tools` crate | Agent 如何定义和执行 40 个工具 |
| 第7章 | Turn Loop 与对话引擎 | `runtime::conversation` | Agent 如何循环决策 |
| 第8章 | 权限系统 | `runtime::permission_enforcer` | 如何限制 Agent 的操作范围 |
| 第9章 | 钩子系统 | `runtime::hooks` + `plugins::hooks` | 如何在关键节点插入处理 |
| 第10章 | 会话管理 | `runtime::session` + `runtime::compact` | 如何维护对话历史 |
| 第11章 | 协调器 | `runtime::task_registry` + `runtime::team_cron_registry` | 多 Agent 如何分工 |
| 第12章 | MCP 协议与插件扩展 | `runtime::mcp_*` + `plugins` | 如何连接外部工具和扩展 |
| 第13章 | 测试与质量保障 | `mock-anthropic-service` + `compat-harness` | 如何保证行为正确性 |
| 第14章 | 三端对比 | `compat-harness` + `native_ts/` | 三种实现的差异 |
| 第15章 | 思维转型 | — | Java 工程师的认知转变 |
| 第16章 | 配置层 | `runtime::config` + `commands` | Rules、Commands、MCP、Skills |
| 第17章 | 工程工作流 | — | AI-Native 工作模式 |
| 第18章 | 总结与展望 | — | 从 claw-code 到 clawable |

## 小结

claw-code 的 canonical runtime 是 `rust/` 下的 Cargo workspace，包含 10 个 crate，总计约 9.6 万行 Rust 代码。其中 `runtime` crate 最大（~41,700 LOC），承载配置、Bootstrap、会话、权限、MCP 和任务六个子系统。一次完整的用户交互从 CLI 入口出发，经过 Bootstrap 引导、配置加载、工具注册、权限初始化、会话创建、Turn Loop 循环、LLM 调用、工具执行，最终输出结果并持久化会话。

下一章将追踪一次完整的命令执行路径，展示数据如何从 CLI 入口流经各模块到达第一条 LLM 响应。
