# 第0章 导读：本书定位与阅读指南

本书逐模块拆解 claw-code 源码，覆盖 Agent 启动流程、API 通信、工具系统、Turn Loop 引擎、权限模型、会话管理等核心机制。本章说明全书结构以及claw-code 项目背景。

## 0.1 本书结构

全书共 15 章（含导读），按内容深度分为两个阶段：

| 阶段 | 章节 | 目标 |
| --- | --- | --- |
| 核心架构 | 第 1-13 章 | 理解 claw-code 是什么、整体架构、逐模块深入 Rust 源码 |
| 总结与展望 | 第 14 章 | 核心架构回顾与演进方向 |

第一阶段是全书核心，逐模块深入源码。第 1 章建立 Agent 概念框架，第 2 章给出整体架构全景，第 3-4 章分析启动流程与配置系统，第 5-12 章逐个拆解核心模块，第 13 章覆盖测试与源码审计。

第二阶段回顾全书核心架构，并展望 claw-code 生态演进。

```mermaid
graph LR
    A[核心架构<br/>第1-13章] --> B[总结与展望<br/>第14章]
```

## 0.2 claw-code 项目概览

claw-code 是 Claude Code 的公开 Rust 实现，由 ultraworkers 组织维护。仓库的 canonical runtime 位于 `rust/` 目录下，是一个 Cargo workspace，包含 11 个 crate、约 11.6 万行 Rust 代码。

README 明确说明："The canonical implementation lives in `rust/`"，而 `src/` 目录下的 Python 代码是 "companion Python/reference workspace and audit helpers; not the primary runtime surface"。因此本书以 Rust 实现为唯一源码依据，不涉及 Python 端的代码分析。

Rust workspace 的核心 crate 包括：

| Crate | 职责 |
| --- | --- |
| `rusty-claude-cli` | CLI 入口，参数解析，TUI 渲染 |
| `runtime` | 核心运行时：bootstrap、config、conversation、session、permissions、hooks、file ops、bash、mcp、task registry |
| `api` | HTTP 客户端、SSE 流解析、多 provider 路由 |
| `tools` | `ToolSpec` 规范定义、55 个工具、执行分发 |
| `plugins` | 插件生命周期、bundled hooks |
| `commands` | `/` 斜杠命令解析与分发 |
| `telemetry` | Token 计数、成本追踪 |
| `mock-anthropic-service` | 确定性 mock 服务，用于测试 |
| `compat-harness` | 兼容性测试设施 |
| `claw-rag-service` | RAG 检索服务（扩展层） |
| `claw-analog` | 轻量级代理外壳（CI/脚本场景） |

本书基于 claw-code 仓库的 main 分支，分析边界以 9-lane checkpoint（2026-04-03）为界。如果后续源码有变动，以实际代码为准。

本书聚焦核心运行路径（启动、配置、API、工具、MCP、权限、会话、钩子、Turn Loop、任务注册表、测试），不逐文件展开 `runtime` crate 的全部模块。`git_context`、`lsp_client`、`sandbox`、`worker_boot`、`oauth`/`remote`、MCP server 侧生命周期、恢复与分支等外围子系统，以及 `claw-analog`、`claw-rag-service`、`telemetry` 三个 crate（第2章表格中标注为「—」）不在本书详细分析。这些模块属于扩展层或外围能力，读者可参照本书的方法自行深入。

本书只讲解 claw-code 仓库原本的代码和结构，暂不涉及社区拓展内容。例如第 12 章分析的任务与团队注册表仅负责状态登记，而完整的任务调度、多 Agent 编排与结果合并等能力属于社区在 claw-code 之上的扩展，不在上游仓库源码内，本书不展开。感兴趣的读者可结合第 14 章了解生态演进方向。

## 0.3 阅读建议

读者最好能了解 Rust 的基本语法，以便重点理解设计思路和模块边界。

每章的代码片段均来自 `claw-code/rust/` 目录下的实际文件，标注了文件路径。建议在本地打开源码对照阅读。对于 Rust 代码，不需要深入掌握 Rust 语法，重点是理解设计思路和模块边界。


下一章将建立 Agent 的概念框架，理解 Agent 与传统 CLI 的本质区别。
