# 第2章 整体架构全景

## 本章概览

本章是全书的模块索引。目标是读完之后能在脑中画出 claw-code 的模块关系图，知道每个 crate 和模块的名字、位置、职责，以及各章分别分析哪个模块。

claw-code 的代码库由两个并行的实现组成：Python 移植工作区和 Rust 重写版。本章不展开任何模块的源码实现，只建立空间感和索引关系。

## 2.1 双实现布局

仓库根目录下并存两套实现：

Python 移植工作区（`src/`）：把原版 TypeScript 代码的模块表面镜像过来，用于盘点、路由和模拟。它不是生产 CLI，而是一个"概念地图"——每个文件对应原版的一个子系统，帮助理解模块划分。

Rust 重写版（`rust/crates/`）：真正的生产实现。Rust workspace 包含多个 crate，每个 crate 是编译后真正运行的代码。Rust workspace 强制 `unsafe_code = "forbid"`，把内存安全作为硬约束。

| 维度 | Python 移植工作区 | Rust 重写版 |
| --- | --- | --- |
| 位置 | `src/` | `rust/crates/` |
| 定位 | 移植进度盘点、概念地图 | 生产 CLI |
| 入口 | `main.py` | `rusty-claude-cli/src/main.rs` |
| 模块组织 | 单层 Python 包 | Cargo workspace + 多 crate |
| 阅读方式 | 看模块划分和注释 | 看真实执行逻辑 |

后续章节以 Rust 重写版为主要分析对象，Python 版在相关模块存在时作对比参考。

## 2.2 Rust workspace 的 crate 地图

Rust 重写版包含以下 crate，每个承担明确职责：

| crate | 路径 | 职责 | 对应章节 |
| --- | --- | --- | --- |
| `rusty-claude-cli` | `rust/crates/rusty-claude-cli/` | CLI 入口，参数解析，命令分发 | 第4章 |
| `runtime` | `rust/crates/runtime/` | 运行时核心：配置、Bootstrap、会话、权限、MCP、任务 | 第4、6、7、9、10章 |
| `tools` | `rust/crates/tools/` | 内置工具实现：文件操作、路径检查、Bash 执行 | 第5章 |
| `plugins` | `rust/crates/plugins/` | 插件系统：钩子注册、生命周期管理 | 第8章 |
| `commands` | `rust/crates/commands/` | 命令扩展：斜杠命令定义和分发 | 第11章 |
| `api` | `rust/crates/api/` | LLM 通信：消息结构、多供应商路由、SSE 流式 | 第6章 |
| `compat-harness` | `rust/crates/compat-harness/` | Python/Rust 一致性测试 | 第13章 |
| `telemetry` | `rust/crates/telemetry/` | 遥测和指标采集 | — |
| `claw-rag-service` | `rust/crates/claw-rag-service/` | RAG 索引服务 | — |
| `mock-anthropic-service` | `rust/crates/mock-anthropic-service/` | 本地 mock 服务，用于测试 | — |

其中 `runtime` 是最大的 crate，承载了配置加载、Bootstrap 引导、会话管理、权限引擎、MCP 通信和任务注册表等多个子系统。后续章节会逐个展开。

## 2.3 Python 工作区的模块清单

Python 侧的模块按顶层目录组织，每个目录对应一个子系统：

| 模块 | 路径 | 职责 | 对应章节 |
| --- | --- | --- | --- |
| `main.py` | `src/main.py` | CLI 入口，argparse 子命令 | 第4章 |
| `runtime.py` | `src/runtime.py` | 运行时容器，路由和会话组装 | 第6章 |
| `query_engine.py` | `src/query_engine.py` | Turn Loop 实现 | 第6章 |
| `tools.py` / `Tool.py` / `tool_pool.py` | `src/` | 工具定义和注册 | 第5章 |
| `permissions.py` | `src/permissions.py` | 权限检查 | 第7章 |
| `hooks/` | `src/hooks/` | 钩子注册和执行 | 第8章 |
| `state/` | `src/state/` | 状态机 | 第9章 |
| `session_store.py` / `history.py` | `src/` | 会话持久化 | 第9章 |
| `coordinator/` | `src/coordinator/` | 多 Agent 协调 | 第10章 |
| `plugins/` | `src/plugins/` | 插件系统 | 第11章 |
| `commands.py` | `src/commands.py` | 命令注册和别名 | 第11章 |
| `bootstrap/` / `bootstrap_graph.py` | `src/` | 启动阶段定义 | 第4章 |
| `system_init.py` | `src/system_init.py` | 系统初始化 | 第4章 |
| `config.rs` (Rust) | `runtime/src/config.rs` | 三层配置加载 | 第4章 |
| `models.py` | `src/models.py` | 移植进度跟踪 dataclass | — |

Python 侧的模块大部分是归档占位，实际逻辑由 Rust 版承载。阅读时以 Rust 版为准，Python 版用于理解模块划分意图。

## 2.4 一次完整交互的数据流

当用户在终端输入 `claude "帮我写一个快速排序"` 时，数据依次流经以下模块：

```mermaid
graph TD
    A[用户输入: claude "帮我写一个快速排序"] --> B[CLI 入口: rusty-claude-cli]
    B --> C[参数解析: CliAction 枚举匹配]
    C --> D[Bootstrap: 七阶段引导]
    D --> E[配置加载: ConfigLoader 三层合并]
    E --> F[工具注册: ToolPool 加载内置工具]
    F --> G[MCP 发现: McpServerManager 发现外部工具]
    G --> H[权限初始化: PolicyEngine 设置 PermissionMode]
    H --> I[会话创建: Conversation 初始化消息列表]
    I --> J[Turn Loop: QueryEngine 循环]
    J --> K[LLM 调用: api crate 发送请求]
    K --> L{LLM 要调用工具?}
    L -->|是| M[权限检查: PolicyEngine 检查路径]
    M --> N[工具执行: tools crate 执行操作]
    N --> O[结果回填: 工具结果加入消息列表]
    O --> J
    L -->|否| P[输出最终结果]
    P --> Q[会话存储: session 持久化]
```

这条数据流贯穿了全书的核心章节。每个节点对应一章的源码分析：

| 数据流节点 | 对应章节 | 对应模块 |
| --- | --- | --- |
| CLI 入口和参数解析 | 第4章 | `rusty-claude-cli` |
| Bootstrap 七阶段引导 | 第4章 | `runtime::bootstrap` |
| 配置三层合并 | 第4章 | `runtime::config` |
| 工具注册 | 第5章 | `tools` crate |
| MCP 工具发现 | 第15章 | `runtime::mcp_stdio` |
| 权限初始化 | 第7章 | `runtime::policy_engine` |
| 会话创建 | 第9章 | `runtime::session` |
| Turn Loop 循环 | 第6章 | `runtime::conversation` |
| LLM 调用 | 第6章 | `api` crate |
| 工具执行 | 第5章 | `tools` crate |
| 会话存储 | 第9章 | `runtime::session` |

## 2.5 各章与模块的对应关系

下表是全书的阅读导航图。读任何一章前，都可以回到这张表确认它在系统中的位置：

| 章节 | 标题 | 分析的模块 | 核心问题 |
| --- | --- | --- | --- |
| 第1章 | 什么是 Agent | — | Agent 和传统 CLI 有什么不同 |
| 第2章 | 整体架构全景 | — | 模块如何划分，数据如何流动 |
| 第3章 | 启动到第一条消息 | `rusty-claude-cli` + `runtime` | 一条命令经过哪些模块 |
| 第4章 | 启动流程深度解析 | `rusty-claude-cli` + `runtime::config` | Bootstrap 七阶段如何工作 |
| 第5章 | 工具系统 | `tools` crate + `src/tools.py` | Agent 如何调用工具 |
| 第6章 | Turn Loop | `runtime::conversation` + `api` crate | Agent 如何循环决策 |
| 第7章 | 权限系统 | `runtime::policy_engine` | 如何限制 Agent 的操作范围 |
| 第8章 | 钩子系统 | `plugins::hooks` + `src/hooks/` | 如何在关键节点插入处理 |
| 第9章 | 会话管理 | `runtime::session` + `src/state/` | 如何维护对话历史 |
| 第10章 | 协调器 | `runtime::task_registry` + `src/coordinator/` | 多 Agent 如何分工 |
| 第11章 | 插件与命令扩展 | `plugins` + `commands` crate | 用户如何自定义工具和命令 |
| 第12章 | Rust 重构版解读 | `runtime` 全 crate | Rust 版整体设计 |
| 第13章 | TS vs Python/Rust 对比 | `compat-harness` + `native_ts/` | 三种实现的差异 |
| 第14章 | 思维转型 | — | Java 工程师的认知转变 |
| 第15章 | 配置层 | `runtime::config` + `mcp_stdio` | Rules、Commands、MCP、Skills |
| 第16章 | 工程工作流 | — | 五种工作模式 |
| 第17章 | Multi-Agent 实战 | `task_registry` + `remote_runtime` | 端到端工作流设计 |

## 小结

claw-code 由 Python 移植工作区和 Rust 重写版两套实现组成，Rust 版是生产实现。Rust workspace 包含 10 个 crate，其中 `runtime` 最大，承载配置、Bootstrap、会话、权限、MCP 和任务六个子系统。一次完整的用户交互从 CLI 入口出发，经过 Bootstrap 引导、配置加载、工具注册、权限初始化、会话创建、Turn Loop 循环、LLM 调用、工具执行，最终输出结果并持久化会话。

下一章将追踪一次完整的命令执行路径，展示数据如何从 CLI 入口流经各模块到达第一条 LLM 响应。
