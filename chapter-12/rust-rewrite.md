# 第12章 Rust 重构版深度解读

Claw Code 的 Rust 重构版（`rust/crates/`）并非简单移植，而是在保留原有协议契约的前提下，用 Rust 的类型系统和所有权模型重新划分了模块边界。本章聚焦三个核心 crate：`runtime`、`api`、`rusty-claude-cli`，说明它们各自承担的职责以及彼此之间的调用关系。

## 12.1 Workspace 组织与模块边界

Rust 版将 Python/TypeScript 的单体代码库拆分为多个 crate，每个 crate 对应一个明确的能力边界：

| Crate | 路径 | 职责 |
| --- | --- | --- |
| `runtime` | `rust/crates/runtime/` | 会话管理、Turn Loop、权限、Hook、配置、MCP、压缩 |
| `api` | `rust/crates/api/` | LLM Provider 客户端、流式解析、Prompt Cache |
| `commands` | `rust/crates/commands/` | Slash 命令解析与分发 |
| `plugins` | `rust/crates/plugins/` | 插件生命周期与执行 |
| `tools` | `rust/crates/tools/` | 内置工具注册表与执行 |
| `telemetry` | `rust/crates/telemetry/` | 会话追踪与分析事件 |
| `rusty-claude-cli` | `rust/crates/rusty-claude-cli/` | CLI 入口、终端渲染、输入处理 |

`runtime` crate 的 `lib.rs` 声明了 40 余个模块，其中公开导出的类型超过 100 个。核心模块映射如下：

```rust
// claw-code/rust/crates/runtime/src/lib.rs

mod conversation;   // Turn Loop: ConversationRuntime<C, T>
mod session;        // Session 结构体会话持久化
mod bootstrap;      // BootstrapPhase 启动阶段枚举
mod config;         // ConfigLoader / RuntimeConfig / RuntimeFeatureConfig
mod prompt;         // System Prompt 组装
mod hooks;          // HookRunner / HookEvent / HookAbortSignal
mod permissions;    // PermissionMode / PermissionPolicy
mod compact;        // 自动压缩: compact_session / should_compact
mod mcp;            // MCP 工具名归一化与签名
mod mcp_stdio;      // MCP stdio 进程通信
mod mcp_client;     // MCP 客户端传输抽象
mod mcp_server;     // MCP 服务端实现
mod policy_engine;  // 策略引擎: PolicyEngine / PolicyRule
mod file_ops;       // 文件操作工具 (read/write/edit/grep/glob)
mod bash;           // Bash 执行器
mod sandbox;        // Linux 沙箱检测与命令构建
mod worker_boot;    // Worker 状态机
mod usage;          // Token 用量追踪与定价
```

这种拆分的结果是：`runtime` crate 成为所有运行时原语的唯一拥有者，`api` crate 只负责与外部 LLM 服务通信，`rusty-claude-cli` 负责将它们组装成可执行程序。

## 12.2 ConversationRuntime：Turn Loop 的 Rust 实现

Python 侧的 `QueryEngine` 用动态类型驱动对话循环。Rust 版将这个循环抽象为一个泛型结构体 `ConversationRuntime<C, T>`，其中 `C` 和 `T` 是两个 trait 约束：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

pub struct ConversationRuntime<C, T> {
    session: Session,
    api_client: C,
    tool_executor: T,
    permission_policy: PermissionPolicy,
    system_prompt: Vec<String>,
    max_iterations: usize,
    usage_tracker: UsageTracker,
    hook_runner: HookRunner,
    auto_compaction_input_tokens_threshold: u32,
    hook_abort_signal: HookAbortSignal,
    hook_progress_reporter: Option<Box<dyn HookProgressReporter>>,
    session_tracer: Option<SessionTracer>,
}
```

`ApiClient` 和 `ToolExecutor` 作为 trait 注入，使得 `ConversationRuntime` 不依赖具体的 Provider 实现或工具执行策略。`run_turn` 方法是循环核心：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

pub fn run_turn(
    &mut self,
    user_input: impl Into<String>,
    mut prompter: Option<&mut dyn PermissionPrompter>,
) -> Result<TurnSummary, RuntimeError> {
    // 1. 压缩健康检查
    if self.session.compaction.is_some() {
        self.run_session_health_probe()?;  // compaction 后探测会话完整性
    }

    self.record_turn_started(&user_input);
    self.session.push_user_text(user_input)?;

    let mut iterations = 0;
    loop {
        iterations += 1;
        if iterations > self.max_iterations {
            return Err(RuntimeError::new("conversation loop exceeded max iterations"));
        }

        // 2. 构建请求并调用 API
        let request = ApiRequest {
            system_prompt: self.system_prompt.clone(),
            messages: self.session.messages.clone(),
        };
        let events = self.api_client.stream(request)?;
        let (assistant_message, usage, _) = build_assistant_message(events)?;

        // 3. 提取 ToolUse 块
        let pending_tool_uses: Vec<_> = assistant_message.blocks.iter()
            .filter_map(|b| match b {
                ContentBlock::ToolUse { id, name, input } => Some((id, name, input)),
                _ => None,
            })
            .collect();

        self.session.push_message(assistant_message)?;

        // 4. 自动压缩检查（包括无工具调用的终止轮）
        if let Some(compaction) = self.maybe_auto_compact() { ... }

        // 5. 无工具则退出循环
        if pending_tool_uses.is_empty() { break; }

        // 6. 逐个执行工具（含 Hook + 权限检查）
        for (tool_use_id, tool_name, input) in pending_tool_uses {
            let pre_hook = self.run_pre_tool_use_hook(&tool_name, &input);
            let permission_outcome = if pre_hook.is_cancelled() || pre_hook.is_failed() {
                PermissionOutcome::Deny { reason: ... }
            } else if pre_hook.is_denied() {
                PermissionOutcome::Deny { reason: ... }
            } else {
                self.permission_policy.authorize_with_context(...)
            };

            let result_message = match permission_outcome {
                PermissionOutcome::Allow => {
                    let output = self.tool_executor.execute(&tool_name, &effective_input)?;
                    let post_hook = self.run_post_tool_use_hook(...);
                    ConversationMessage::tool_result(tool_use_id, tool_name, output, false)
                }
                PermissionOutcome::Deny { reason } => {
                    ConversationMessage::tool_result(tool_use_id, tool_name, reason, true)
                }
            };
            self.session.push_message(result_message)?;
        }
    }

    Ok(TurnSummary { assistant_messages, tool_results, iterations, usage, ... })
}
```

与 Python 侧的 `QueryEngine.query()` 相比，Rust 版的差异在于：健康检查在每次 compaction 后自动触发（通过 `run_session_health_probe` 调用 `glob_search` 探测工具执行器是否存活），auto-compaction 的判定阈值通过环境变量 `CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS` 动态调整，默认值是 100,000 tokens。

## 12.3 Session 持久化与自动压缩

`Session` 结构体会话状态的全部内容，以 JSONL 格式持久化到磁盘：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub struct Session {
    pub version: u32,
    pub session_id: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub messages: Vec<ConversationMessage>,
    pub compaction: Option<SessionCompaction>,
    pub fork: Option<SessionFork>,
    pub workspace_root: Option<PathBuf>,
    pub prompt_history: Vec<SessionPromptEntry>,
    pub last_health_check_ms: Option<u64>,
    pub model: Option<String>,
    persistence: Option<SessionPersistence>,
}
```

每条消息是一个 `ConversationMessage`，包含 `MessageRole`（System/User/Assistant/Tool）和 `ContentBlock` 列表。`ContentBlock` 枚举覆盖了 Thinking、Text、ToolUse、ToolResult 四种变体。

持久化策略采用文件大小轮转：单个 session 文件超过 256KB 时自动轮转，最多保留 3 个历史文件。写入时先序列化为 JSONL，每条记录截断超过 16KB 的字段（标记为 `[truncated for session JSONL]`）。

自动压缩的逻辑在 `compact.rs` 中：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

pub struct CompactionConfig {
    pub preserve_recent_msgs: usize,    // 默认保留最近 4 条消息
    pub max_estimated_tokens: usize,    // 默认 10,000 tokens
}

pub fn should_compact(session: &Session, config: CompactionConfig) -> bool {
    let start = compacted_summary_prefix_len(session);
    let compactable = &session.messages[start..];
    compactable.len() > config.preserve_recent_msgs
        && compactable.iter().map(estimate_message_tokens).sum::<usize>()
            >= config.max_estimated_tokens
}
```

压缩后的摘要通过 `format_compact_summary` 格式化，剥离 `<analysis>` 标签，提取 `<summary>` 内容作为延续提示的开头。

## 12.4 API 层：多 Provider 抽象与流式解析

`api` crate 的核心抽象是 `ProviderClient` 枚举，屏蔽了 Anthropic 原生 API 与 OpenAI 兼容协议的差异：

```rust
// claw-code/rust/crates/api/src/client.rs

pub enum ProviderClient {
    Anthropic(AnthropicClient),
    Xai(OpenAiCompatClient),
    OpenAi(OpenAiCompatClient),
}

impl ProviderClient {
    pub fn from_model_with_anthropic_auth(
        model: &str,
        anthropic_auth: Option<AuthSource>,
    ) -> Result<Self, ApiError> {
        let resolved_model = providers::resolve_model_alias(model);
        match providers::detect_provider_kind(&resolved_model) {
            ProviderKind::Anthropic => Ok(Self::Anthropic(...)),
            ProviderKind::Xai => Ok(Self::Xai(OpenAiCompatClient::from_env(OpenAiCompatConfig::xai()))),
            ProviderKind::OpenAi => {
                if std::env::var_os("OLLAMA_HOST").is_some() {
                    // Ollama 本地优先
                    Ok(Self::OpenAi(OpenAiCompatClient::from_ollama_env()))
                } else {
                    // DashScope (qwen-*) 走 dashscope.aliyuncs.com
                    let config = match providers::metadata_for_model(&resolved_model) {
                        Some(meta) if meta.auth_env == "DASHSCOPE_API_KEY" => OpenAiCompatConfig::dashscope(),
                        _ => OpenAiCompatConfig::openai(),
                    };
                    Ok(Self::OpenAi(OpenAiCompatClient::from_env(config)))
                }
            }
        }
    }
}
```

`detect_provider_kind` 根据模型名前缀（`claude-`、`gpt-`、`grok-` 等）判断归属。`AuthSource` 支持四种模式：`None`、`ApiKey`、`BearerToken`、`ApiKeyAndBearer`，从环境变量 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_AUTH_TOKEN` 中读取。

流式响应通过 `SseParser` 处理：

```rust
// claw-code/rust/crates/api/src/sse.rs

pub struct SseParser {
    buffer: Vec<u8>,
    provider: Option<String>,
    model: Option<String>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<StreamEvent>, ApiError> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(frame) = self.next_frame() {
            if let Some(event) = self.parse_frame_with_context(&frame)? {
                events.push(event);
            }
        }
        Ok(events)
    }
}
```

`next_frame` 按 `\n\n` 或 `\r\n\r\n` 分隔 SSE 帧，`parse_frame_with_context` 将帧解析为 `StreamEvent` 枚举。解析失败时携带 provider 和 model 信息以便调试。

`MessageRequest` 结构体统一了 Anthropic Messages API 和 OpenAI Chat Completions API 的请求字段，通过 `#[serde(skip_serializing_if)]` 控制序列化：`extra_body` 字段（`BTreeMap<String, Value>`）允许注入 Provider 特定参数（如 `reasoning_effort`、`web_search_options`），核心协议字段受保护不能被覆盖。

## 12.5 Worker 状态机与多 Agent 控制面

`worker_boot` 模块实现了一个内存中的 Worker 启动状态机，用于管理多 Agent 场景下的子进程生命周期：

```rust
// claw-code/rust/crates/runtime/src/worker_boot.rs

pub enum WorkerStatus {
    Spawning,
    TrustRequired,
    ToolPermissionRequired,
    ReadyForPrompt,
    Running,
    Finished,
    Failed,
}

pub enum WorkerFailureKind {
    TrustGate,
    ToolPermissionGate,
    PromptDelivery,
    Protocol,
    Provider,
    StartupNoEvidence,
}
```

Worker 从 `Spawning` 出发，经过信任校验（`TrustRequired`）和工具权限确认（`ToolPermissionRequired`），到达 `ReadyForPrompt` 后才能接收用户输入。`Running` 状态表示正在执行工具或等待 LLM 响应。异常情况归类到六种 `WorkerFailureKind`，例如 `TrustGate` 表示工作区根目录未通过信任检查，`PromptDelivery` 表示提示投递失败。

`WorkerEvent` 记录了状态转移过程中的每一个中间事件（`StartupPreflightWarning`、`TrustResolved` 等），供上层追踪和诊断。`WorkerRegistry` 管理多个 Worker 实例，支持按 session 维度隔离。

## 设计对比

Rust 版的模块拆分与 Java 生态中的 Spring Boot 多模块项目有直接对应关系：

| claw-code Rust | Java/Spring 生态 | 说明 |
| --- | --- | --- |
| `runtime` crate | `spring-boot-starter-core` | 核心运行时，包含 IoC 等价物 |
| `api` crate | `spring-webflux` / `OpenFeign` | 外部服务客户端抽象 |
| `ConversationRuntime<C, T>` | `DispatcherServlet` + `HandlerAdapter` | 请求处理循环，泛型 trait 等价于策略模式 |
| `Session` 持久化 | Spring Session + Redis | 会话状态外置，支持 fork/compaction |
| `Worker` 状态机 | Spring Statemachine | 枚举驱动的状态转移，不可变状态对象 |
| `ProviderClient` 枚举 | `ServiceLoader` / 策略模式 | 编译期确定所有变体，无需反射 |
| `SseParser` | `WebFlux` `Flux<ServerSentEvent>` | 流式帧解析，背压通过 iterator 隐式实现 |

一个关键差异在于错误处理：Rust 版大量使用 `Result<T, E>` 而非异常，`SessionError` 和 `RuntimeError` 是枚举而非异常类。这使得每个函数的失败路径在类型签名中可见，调用方无法忽略错误。相比之下，Spring Boot 的 `@ExceptionHandler` 将错误处理集中到切面，虽然解耦更彻底但运行时才能发现遗漏。

## 小结

- 关键文件：`rust/crates/runtime/src/lib.rs`（模块声明与重导出）、`conversation.rs`（Turn Loop 泛型实现）、`session.rs`（JSONL 持久化）、`compact.rs`（自动压缩策略）、`worker_boot.rs`（Worker 状态机）、`config.rs`（三层配置合并）
- `api` crate 通过 `ProviderClient` 枚举统一了 Anthropic/xAI/OpenAI/Ollama/DashScope 五种 Provider，`SseParser` 处理流式帧解析，`MessageRequest` 通过 `extra_body` 支持 Provider 特定参数注入
- `ConversationRuntime<C, T>` 的泛型设计将 API 调用和工具执行解耦为两个 trait，`run_turn` 方法实现了 "API 调用 → 提取 ToolUse → Hook+权限 → 工具执行 → 下一轮" 的完整循环
- `Session` 绑定 `workspace_root` 防止多实例写入漂移，JSONL 持久化带字段截断和文件轮转
- `WorkerStatus` 枚举驱动多 Agent 子进程的启动阶段，`WorkerFailureKind` 将失败归类为六种可操作场景
