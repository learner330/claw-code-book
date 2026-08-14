# 第14章 TypeScript vs Rust 两端对比

## 本章概览

本章对比 claw-code 的原始参考实现（TypeScript upstream）与 Rust 重写实现，分析同一功能在不同技术栈中的架构差异和设计权衡。对应 `compat-harness` 模块提取的 upstream 源码清单，以及 `rust/` workspace 的 Rust 实现。

对比的核心维度是：类型系统对架构的约束、并发模型对运行时行为的影响、以及工程组织方式对可维护性的作用。Rust 重写不是简单的语言翻译，而是利用 Rust 的类型系统和所有权模型重新设计了数据流和错误处理路径。

| 对比维度 | TypeScript upstream | Rust claw-code |
| --- | --- | --- |
| 类型系统 | 运行时类型 + 编译时检查 | 编译时严格类型 + 所有权 |
| 并发模型 | 单线程 event loop + async/await | 多线程 + async/await (tokio) |
| 错误处理 | `try/catch` + 隐式异常传播 | `Result` + 显式错误传播 |
| 配置格式 | `settings.json` + 环境变量 | `settings.json` + 环境变量 + CLI 参数 |
| 工具调用 | 动态 dispatch | 静态 match + 动态 trait object |
| 会话存储 | JSON/JSONL | JSONL (增量追加) |
| 模块化 | 文件级 import/export | Crate 级 workspace + 私有模块 |

## 14.1 类型系统与架构约束

TypeScript 的类型系统在编译时提供检查，但运行时所有类型擦除。upstream 的 `tools.ts` 用动态 import 加载工具模块，工具列表在运行时组装：

```typescript
// upstream 示意（来自 compat-harness 提取的 import 模式）
import { ReadFileTool, BashTool, GrepSearchTool } from './tools';
// ... 运行时注册
```

Rust 端用静态枚举和 match 分发工具调用。`execute_tool_with_enforcer`（第6章）在编译时穷举所有工具名，编译器确保没有遗漏：`match tool_name { "ReadFile" => ..., "Bash" => ..., _ => ... }`。

`compat-harness` 从 upstream 源码提取的符号清单是动态加载的，但 Rust 端的工具列表是 `mvp_tool_specs()` 中的静态数组。`compat-harness` 的 `extract_tools` 通过 `import` 语句和 `feature('...')` 调用提取工具名，而 Rust 端直接定义 `ToolSpec` 结构体数组。两种方式的差异在于：TypeScript 的工具可以在不重新编译的情况下热加载（如果文件系统变化），Rust 的工具列表在编译时固定，运行时只能添加 plugin 和 MCP 工具。

`CommandRegistry` 和 `ToolRegistry`（第6章）的对比：Rust 端用 `BTreeSet` 检查名称冲突，编译时静态数组 + 运行时动态注册。TypeScript 端用运行时数组操作和动态 import，没有编译时冲突检查。

## 14.2 并发模型与运行时行为

TypeScript upstream 基于 Node.js 的单线程 event loop。所有操作（文件读写、网络请求、子进程）都是异步的，通过 `async/await` 和 event loop 调度。这种模型简化了共享状态——没有数据竞争，但需要小心避免阻塞 event loop 的同步操作。

Rust 端使用 tokio 的异步运行时，但底层是多线程工作池。`TaskRegistry`、`TeamRegistry`、`CronRegistry`（第11章）使用 `Arc<Mutex<T>>` 实现跨线程共享状态。`McpToolRegistry` 的 `spawn_tool_call`（第12章）在新线程中创建 tokio 运行时执行 MCP 调用。这种设计允许真正的并行——多个子 Agent 可以同时运行在不同的线程上，而 TypeScript 的 async 操作虽然并发，但同一时间只有一个在 CPU 上执行。

Rust 的所有权模型对并发的影响：共享状态必须显式使用 `Arc<Mutex<T>>` 或 `Arc<RwLock<T>>`，编译器禁止裸的共享可变引用。这消除了数据竞争类 bug，但增加了编码复杂度。TypeScript 没有这种约束——共享状态通过闭包捕获，运行时可能出现 race condition，但 event loop 的单线程特性减少了实际发生的概率。

## 14.3 错误处理与韧性

TypeScript upstream 使用 `try/catch` 和异常传播。错误可以在调用栈的任意层级抛出，上层可以选择捕获或继续传播。这种模型灵活但隐式——调用方可能不知道某个函数会抛出什么异常。

Rust 端使用 `Result<T, E>` 枚举。每个可能失败的操作返回 `Result`，调用方必须显式处理 `Ok` 或 `Err`。`McpServerManagerError`（第12章）是结构化的错误枚举，包含 `Io`、`Transport`、`JsonRpc`、`InvalidResponse`、`Timeout`、`UnknownTool`、`UnknownServer` 等变体，每个变体携带上下文信息（服务器名、方法名、超时时间等）。

`must_use` 属性在 Rust 端强制调用方处理返回值。例如 `PermissionPolicy::authorize` 返回 `PermissionOutcome`，如果调用方忽略返回值，编译器会警告。这防止了隐式忽略错误的情况——在 TypeScript 中，如果 async 函数的 Promise 没有被 await，错误会静默丢失（unhandled promise rejection）。

降级启动机制（第12章）在 Rust 端通过 `McpDegradedReport` 显式建模。`discover_tools_best_effort` 收集成功和失败的服务器，生成降级报告。TypeScript 端的类似机制可能通过异常捕获和日志实现，但没有结构化的降级报告类型。

## 14.4 配置加载与合并

TypeScript upstream 和 Rust 端都使用 `settings.json` 作为配置格式，但加载和合并机制不同。Rust 端的 `ConfigLoader`（`config.rs`）实现了多源配置合并：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub enum ConfigSource {
    User,
    Project,
    Local,
}

pub struct ConfigEntry {
    pub source: ConfigSource,
    pub path: PathBuf,
}
```

`ConfigSource` 定义配置的来源优先级：`User`（用户级，`~/.claw/settings.json`）< `Project`（项目级，`.claw/settings.json`）< `Local`（本地级，`.claw/local/settings.json`）。后加载的配置覆盖先加载的。

`config_validate.rs`（第16章展开）对配置字段进行校验——`UnknownKey` 检测未知键，`WrongType` 检测类型错误，`Deprecated` 检测已弃用字段。TypeScript 端的配置加载可能通过运行时对象合并实现，没有编译时的字段校验。

## 14.5 启动流程对比

TypeScript upstream 的启动流程从 `src/entrypoints/cli.tsx` 开始。`compat-harness` 的 `extract_bootstrap_plan` 通过源码字符串匹配检测快速路径分支：`--version`、`--dump-system-prompt`、`--daemon-worker`、`remote-control`、`args[0] === 'daemon'` 等。这些快速路径在 CLI 参数解析阶段分流，避免加载完整的运行时。

Rust 端的启动流程（第4章）在 `bootstrap.rs` 中实现七阶段：CLI 参数解析 → 版本快速路径 → 配置加载与合并 → 插件初始化 → 会话恢复 → 运行时组装 → REPL 启动。Rust 的启动流程是显式的——每个阶段有明确的 `BootstrapPhase` 枚举，而 TypeScript 端的分支通过源码中的 `if` 语句实现，没有统一的阶段抽象。

`BootstrapPlan` 的 `from_phases` 方法构建启动计划，Rust 编译器确保所有 `BootstrapPhase` 变体被处理。TypeScript 端的启动逻辑是线性的——代码按顺序执行，没有明确的阶段结构。

## 14.6 测试策略对比

TypeScript upstream 的测试策略未知（源码未完整分析），但 Rust 端有三层测试体系（第13章）：

单元测试分布在各 crate 中——`task_registry.rs`、`team_cron_registry.rs`、`hooks.rs` 等文件底部都有 `#[cfg(test)]` 模块。这些测试验证单个模块的行为。

集成测试 `mock_parity_harness.rs` 测试端到端场景——12 个场景覆盖核心用户工作流。`MockAnthropicService` 模拟 API 端点，验证请求序列和响应。

兼容性测试 `compat-harness` 从 upstream 源码提取清单，对比功能覆盖率。这不是行为测试，而是覆盖率审计——检查 Rust 实现是否遗漏了 upstream 的命令或工具。

TypeScript 端可能有类似的测试，但 Rust 的 `cargo test` 和 `#[cfg(test)]` 机制把测试与源码紧密集成，编译时确保测试代码与生产代码同步。

## 小结

TypeScript upstream 与 Rust 重写的主要差异在于类型系统的严格性、并发模型的显式性和错误处理的结构化程度。Rust 的编译时类型检查在 `PermissionMode` 的 `#[derive(PartialOrd, Ord)]`（第8章）、`BootstrapPhase` 的枚举穷举（第4章）、以及 `McpClientTransport` 的 match 分发（第12章）中体现为编译器保证的完整性。Rust 的多线程模型通过 `Arc<Mutex<T>>` 实现显式共享状态，而 TypeScript 的单线程 event loop 隐式避免数据竞争但限制并行能力。`Result` 和 `must_use` 使错误处理显式化，防止静默失败。

`compat-harness` 作为两种实现的桥梁，从 upstream TypeScript 源码提取命令、工具和启动计划清单，用于审计 Rust 实现的功能覆盖率。这种设计允许 Rust 重写渐进推进——每次新增功能后运行兼容性审计，确认未遗漏 upstream 的核心能力。

| 关键文件 | 对比内容 | 对应章节 |
| --- | --- | --- |
| `rust/crates/compat-harness/src/lib.rs` | 从 upstream 提取清单、路径解析、符号提取 | 14.1-14.5 |
| `rust/crates/runtime/src/config.rs` | `ConfigLoader` 多源合并 | 14.4 |
| `rust/crates/runtime/src/bootstrap.rs` | `BootstrapPlan` 显式阶段 | 14.5 |

下一章将讨论从传统工程师到 Agent 工程师的思维转型——工程实践中需要调整的心智模型和工作习惯。
