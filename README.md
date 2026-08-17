# Claw Code 代码讲解

逐模块拆解 [claw-code](https://github.com/ultraworkers/claw-code)（Claude Code 的公开 Rust 实现）源码，理解 Agent 运行时的完整链路。

## 本书定位

Agent 已经成为下一代软件开发的基础设施。claw-code 用 Rust 重写了 Claude Code 的核心运行时，约 11.6 万行代码分布在 10 个 crate 中。本书的目标是让有一定系统开发经验的工程师能读懂这套代码，深入到每个模块的设计决策和源码实现。

每章聚焦一个核心模块，代码片段全部来自实际源码文件，标注完整路径，可对照阅读。

## 章节目录

| 章节 | 标题 | 核心内容 |
| --- | --- | --- |
| 导读 | 本书定位与阅读指南 | 全书结构、claw-code 项目背景、建议阅读路径 |
| 第 1 章 | 什么是 Agent | Agent 与传统 CLI 的本质区别、工具概念、权限必要性 |
| 第 2 章 | 整体架构全景 | 10 个 crate 的模块地图、数据流、依赖关系、目录结构速查 |
| 第 3 章 | 启动流程 | CLI 入口、Bootstrap 阶段编排、ConfigLoader 三层合并、来源追踪、Commands/Skills 解析 |
| 第 4 章 | 配置系统 | RuntimeFeatureConfig 类型化视图、配置校验、字段消费方速查表 |
| 第 5 章 | API 通信与模型交互 | SSE 流解析、Provider 路由、PromptCache |
| 第 6 章 | 工具系统 | ToolSpec 规范、GlobalToolRegistry 三层注册、40 个工具清单、执行分发 |
| 第 7 章 | MCP 协议与外部工具 | McpServerManager 生命周期、六种传输方式、插件系统、降级启动 |
| 第 8 章 | 权限系统 | PermissionMode 五级模型、PermissionPolicy 规则引擎、TrustResolver |
| 第 9 章 | 会话管理 | Session 状态机、JSONL 持久化、自动压缩、会话分叉 |
| 第 10 章 | Hooks系统 | HookRunner 三事件生命周期、权限覆盖、JSON 协议、取消信号 |
| 第 11 章 | Turn Loop 与对话引擎 | ConversationRuntime 泛型设计、run_turn 循环、系统提示词构建 |
| 第 12 章 | 多 Agent 任务编排 | TaskRegistry、LaneBoard、Team/Cron 编排、PolicyEngine 规则决策 |
| 第 13 章 | 测试与源码审计 | MockAnthropicService、MockParityHarness、compat-harness 兼容性审计 |
| 第 14 章 | 总结与展望 | 核心架构回顾、设计权衡、演进方向 |

## 阅读建议

读者最好能了解 Rust 的基本语法，以便重点理解设计思路和模块边界。

## 源码分析边界

本书基于 claw-code 仓库的 main 分支，分析边界以 `rust/` 目录下的 Cargo workspace 为限。`src/` 目录下的 Python 代码是参考实现和审计辅助工具，不属于本书分析范围。

## License

本书内容采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可协议。
