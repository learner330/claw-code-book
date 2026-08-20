# 间章 从重构到扩展：第二阶段新增模块总览

## 本章概览

本章是第一阶段与第二阶段之间的过渡。在深入各个扩展模块之前，先说明第二阶段八章内容的由来——每章对应一个独立的真实使用场景，围绕"好用、安全、可扩展"三个目标逐步生长出来。

## 重构起点

claw-code 是 Claude Code 的社区 Rust 重写项目，目标是构建一个可审计、可修改、可自托管的 Agent 系统。重构过程中经历了两次关键转变：从 TypeScript 到 Rust 的语言迁移，消除了对外部服务的硬编码依赖；从单体到模块化的架构重组，把系统拆分为入口层、运行时层、通信层、工具层、扩展层五层结构。

重构后形成了第一阶段的核心运行时：Bootstrap 引导、三层配置合并、Turn Loop 驱动 LLM 调用与工具执行、MCP 连接外部工具、PermissionMode 控制操作边界、Hooks 允许自定义拦截。这套链路解决了"让 Agent 在终端中可靠运行"的问题。

但可靠运行不等于好用、不等于安全、不等于可扩展。第二阶段的模块围绕这三个差距展开。

## 第二阶段要解决什么

在核心运行时稳定后，社区和源码审查过程中发现了七类需要独立解决的问题：

| 问题 | 新增模块 | 对应章节 |
|------|----------|----------|
| 核心 CLI 太重量级，CI/自动化场景不需要全部功能 | claw-analog | 第 15 章 |
| Agent 缺乏项目上下文理解，重复读取相同文件 | claw-rag-service | 第 16 章 |
| 运行成本不可见，无法追踪 Token 消耗 | telemetry | 第 17 章 |
| 架构演进缺乏对照，Rust 重写与 Python 原型的映射关系不清 | Python 移植层 | 第 18 章 |
| 工具扩展需要标准契约，插件安装/升级/卸载流程缺失 | plugins | 第 19 章 |
| 权限控制停留在软件层面，缺乏操作系统级隔离 | sandbox | 第 20 章 |
| Agent 遇到故障只能终止，没有自动恢复机制 | recovery_recipes | 第 21 章 |
| 部署依赖手工操作，没有标准化容器工作流 | Containerfile/docker-compose | 第 22 章 |

这八章按"与核心运行时的耦合程度"从低到高排列。claw-analog 和 claw-rag-service 是独立进程，与核心运行时无代码依赖；telemetry 是被核心运行时引用的共享库；plugins、sandbox、recovery 是 runtime crate 的内部子系统；Python 移植层是架构对照参考；容器化是部署层面的扩展。

## 各模块要解决的核心问题

**claw-analog：精简 Agent Harness**。核心 CLI（claw）包含 TUI、会话管理、MCP 连接、插件系统等重型功能，启动时间和资源占用不适合 CI/自动化场景。claw-analog 只保留 read/list/grep/write 四个文件操作工具，无 Bash、无 MCP、无插件，输出支持 NDJSON 事件流，可以被脚本消费。

**claw-rag-service：项目上下文理解**。Agent 在 Turn Loop 中反复读取相同文件（如读取 `Cargo.toml` 确认依赖版本），浪费 Token 且效率低下。RAG 服务预先索引工作区文件，把文件内容切分为语义块并生成嵌入向量。Agent 通过 `retrieve_context` 工具查询"与当前任务相关的文件片段"，避免重复全文读取。

**telemetry：成本可观测性**。核心运行时的 Token 消耗对终端用户是黑箱。telemetry 提供结构化事件收集（HttpRequestStarted/Succeeded/Failed、AnalyticsEvent、SessionTraceRecord），以 NDJSON 格式持久化，对接外部可观测性系统。

**Python 移植层：架构演进对照**。Rust 重写以 Python 参考实现为起点进行概念映射。Python 层的命令图、工具池、查询引擎三大子系统与 Rust 的 crate 划分存在对应关系，但也有合并和拆分。理解这些映射关系，有助于追溯 Rust 架构中设计决策的来源——继承自原型还是重构时引入的改进。

**plugins：工具扩展的标准契约**。MCP 协议解决了"外部工具如何连接"的问题，但没有解决"外部工具如何分发和安装"的问题。plugins crate 定义了 `plugin.json` 契约和生命周期状态机（安装→启用→禁用→卸载→更新），让第三方可以通过标准流程扩展 Agent 能力。

**sandbox：操作系统级隔离**。PermissionMode（第 9 章）控制 Agent"能做什么"，但它运行在普通用户进程内，无法阻止 Agent 通过系统调用绕过软件层面的权限检查。sandbox.rs 引入 Linux namespace 隔离（unshare、用户命名空间、挂载隔离、网络隔离），把 Agent 的工具执行限制在独立的进程环境中。

**recovery_recipes：故障自愈**。当前 Agent 遇到启动失败或运行时异常时只能终止进程，由用户手动排查。recovery_recipes.rs 定义了七种失败场景（TrustPromptUnresolved、PromptMisdelivery、StaleBranch、CompileRedCrossCrate、McpHandshakeFailure、PartialPluginStartup、ProviderFailure）的恢复配方——每个配方包含步骤序列、最大尝试次数和升级策略（AlertHuman/LogAndContinue/Abort）。

**容器化：标准化部署**。claw-code 的构建依赖 Rust toolchain 和系统库，部署到不同环境时需要处理依赖差异。Containerfile 定义了官方容器镜像，docker-compose.yml 编排 RAG 服务和 Qdrant 向量数据库，提供一键启动的完整工作流。

## 阅读建议

第二阶段八章可以按需阅读，不必按顺序：

如果你关注 Agent 的轻量化部署和 CI 集成，从第 15 章（claw-analog）开始。

如果你关注 Agent 的上下文理解和效率优化，从第 16 章（RAG 服务）开始。

如果你关注 Agent 的安全边界，从第 20 章（沙箱隔离）开始。

如果你关注 Agent 的可靠性和故障处理，从第 21 章（故障恢复）开始。

如果你想理解 Rust 重写的架构决策背景，从第 18 章（Python 移植层）开始。

八章内容之间没有强依赖关系，每章聚焦一个独立子系统。理解它们要解决的核心问题，比记住任何实现细节都更重要。

## 小结

claw-code 从社区重构出发，经历了语言迁移和架构重组两个阶段。第一阶段建立了 Agent 在终端中可靠运行的核心链路，第二阶段围绕"好用、安全、可扩展"三个维度补充了独立子系统。

claw-analog 解决轻量化问题，RAG 服务解决上下文理解问题，telemetry 解决成本可观测问题，plugins 解决扩展标准化问题，sandbox 解决系统级隔离问题，recovery 解决故障自愈问题，容器化解决部署标准化问题。Python 移植层提供架构演进的对照参考。

下一章开始，深入 claw-analog 的精简 Agent Harness 设计。
