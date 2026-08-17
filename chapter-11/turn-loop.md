# 第11章 Turn Loop 与对话引擎：Conversation Runtime

## 本章概览

本章分析 claw-code 的核心运行机制——Turn Loop。对应第2章架构全景中的 `runtime` crate 的 `conversation.rs` 模块。

Turn Loop 要解决的核心问题是：Agent 如何把"用户输入一句话"转化为"执行若干工具后给出最终回答"。这个过程是一个循环，不是一次性的请求-响应。模型可能在一轮中请求多个工具，工具结果被送回模型，模型基于新信息继续推理，可能再请求工具，如此往复直到模型不再请求工具，给出最终文本回答。

| 关键文件 | 职责 |
| --- | --- |
| `rust/crates/runtime/src/conversation.rs` | `ConversationRuntime`、`run_turn`、事件组装、遥测 |
| `rust/crates/runtime/src/compact.rs` | 会话压缩，摘要+保留 |

## 11.1 数据类型与 Trait 设计

### ApiRequest 与 AssistantEvent

`ApiRequest` 是发给模型的最小请求结构：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

pub struct ApiRequest {
    pub system_prompt: Vec<String>,
    pub messages: Vec<ConversationMessage>,
}
```

只有两个字段：`system_prompt` 是系统提示词列表（每个元素是一段系统指令），`messages` 是对话消息列表。没有模型名、温度、max_tokens 等参数，这些由 `ApiClient` 的实现自行管理（如从配置中读取）。`ApiRequest` 只携带对话上下文，是接口的最小契约。

`AssistantEvent` 是流式事件枚举，覆盖模型返回的所有内容类型：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

pub enum AssistantEvent {
    Thinking {
        thinking: String,
        signature: Option<String>,
    },
    TextDelta(String),
    ToolUse {
        id: String,
        name: String,
        input: String,
    },
    Usage(TokenUsage),
    PromptCache(PromptCacheEvent),
    MessageStop,
}
```

六个变体对应六种事件。`Thinking` 携带思考过程文本和可选签名——签名用于验证思考内容的完整性（extended thinking 特性）。`TextDelta` 是文本增量，即模型输出的文本片段，需要累积拼接。`ToolUse` 是工具调用请求——`id` 用于关联工具结果，`name` 是工具名，`input` 是 JSON 格式的参数。`Usage` 携带 token 用量。`PromptCache` 携带 prompt cache 遥测事件。`MessageStop` 是消息结束标记——没有数据，只是一个信号。

`PromptCacheEvent` 记录 prompt cache 的命中异常：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

pub struct PromptCacheEvent {
    pub unexpected: bool,
    pub reason: String,
    pub previous_cache_read_input_tokens: u32,
    pub current_cache_read_input_tokens: u32,
    pub token_drop: u32,
}
```

当 cache read tokens 突然下降但 prompt fingerprint 未变时，`unexpected` 设为 `true`，`token_drop` 记录下降量。这个事件用于诊断缓存失效问题——如果 prompt 没变但缓存突然不命中，可能是 API 端的缓存策略变化或 prompt 序列化不稳定。

### ApiClient 与 ToolExecutor trait

`ConversationRuntime` 通过两个 trait 注入依赖：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

pub trait ApiClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError>;
}

pub trait ToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError>;
}
```

`ApiClient` 只有一个 `stream` 方法，接收 `ApiRequest`，返回 `Vec<AssistantEvent>`（事件列表）。`ToolExecutor` 只有一个 `execute` 方法，接收工具名和输入字符串，返回执行结果字符串。

这两个 trait 非常简洁——各只有一个方法。泛型设计允许在生产环境注入真实的 HTTP 客户端和工具分发器，在测试环境注入模拟实现。因为 Rust 的泛型是编译期单态化的，每个具体的 `C` 和 `T` 组合会生成一份专门的代码，没有虚函数调用开销。

### ConversationRuntime 结构体

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

泛型参数 `C` 和 `T` 在 `impl` 块中通过 `where` 子句约束为 `ApiClient` 和 `ToolExecutor`：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

impl<C, T> ConversationRuntime<C, T>
where
    C: ApiClient,
    T: ToolExecutor,
{
```

`hook_progress_reporter` 和 `session_tracer` 用 `Option<Box<dyn ...>>`——动态分发。这是因为这两个组件是可选的（`Option`），且类型较复杂（`HookProgressReporter` 有多个方法），用 trait object 比泛型更灵活。`Box` 把 trait object 放在堆上，`dyn` 表示动态分发。

`max_iterations` 限制循环最大迭代次数——防止模型无限请求工具导致死循环。默认值通常设为 20-50 次。`auto_compaction_input_tokens_threshold` 是自动压缩的 token 阈值——累计 input tokens 超过此值时触发压缩。

## 11.2 run_turn 核心循环

### 阶段一：会话健康检查

`run_turn` 是 `ConversationRuntime` 的核心方法。首先检查会话是否曾被压缩过：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

pub fn run_turn(
    &mut self,
    user_input: impl Into<String>,
    mut prompter: Option<&mut dyn PermissionPrompter>,
) -> Result<TurnSummary, RuntimeError> {
    let user_input = user_input.into();

    if self.session.compaction.is_some() {
        if let Err(error) = self.run_session_health_probe() {
            return Err(RuntimeError::new(format!(
                "Session health probe failed after compaction: {error}. \
                 The session may be in an inconsistent state. \
                 Consider starting a fresh session with /session new."
            )));
        }
    }
```

`user_input: impl Into<String>` 是 Rust 的惯用写法，接受任何可以转换为 `String` 的类型（如 `&str`、`String`）。`impl Into<String>` 让调用方可以传 `&str` 或 `String`，不需要显式转换。

`self.session.compaction.is_some()` 检查 session 是否有压缩记录。如果有，说明 session 之前被压缩过（可能因为上下文过长），需要先做健康检查，验证 tool executor 是否正常工作。如果压缩后的 session 状态不一致（如 tool executor 不可用），后续的工具调用会全部失败，不如提前检测。

健康探针的实现：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

fn run_session_health_probe(&mut self) -> Result<(), String> {
    if self.session.messages.is_empty() && self.session.compaction.is_some() {
        return Ok(());
    }
    let probe_input = r#"{"pattern": "*.health-check-probe-"}"#;
    match self.tool_executor.execute("glob_search", probe_input) {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Tool executor probe failed: {e}")),
    }
}
```

探针调用 `glob_search` 工具，搜索模式 `"*.health-check-probe-"`——这个模式不会匹配任何文件（文件名不可能以 `-` 结尾且有 `.health-check-probe-` 前缀），是非破坏性操作。如果 tool executor 返回 `Ok`（即使搜索结果为空），说明 executor 正常工作。如果返回 `Err`，说明 executor 不可用，整个 turn 被中止。

### 阶段二：用户消息入队与循环开始

用户消息加入 session 后，进入主循环：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

    self.record_turn_started(&user_input);
    self.session
        .push_user_text(user_input)
        .map_err(|error| RuntimeError::new(error.to_string()))?;

    let mut assistant_messages = Vec::new();
    let mut tool_results = Vec::new();
    let mut prompt_cache_events = Vec::new();
    let mut iterations = 0;
    let mut auto_compaction = None;

    loop {
        iterations += 1;
        if iterations > self.max_iterations {
            let error = RuntimeError::new(
                "conversation loop exceeded the maximum number of iterations",
            );
            self.record_turn_failed(iterations, &error);
            return Err(error);
        }
```

`record_turn_started` 记录遥测事件（如果 tracer 存在）。`push_user_text` 把用户消息加入 session 的消息列表，返回 `Result`，`map_err` 把 session 错误转为 `RuntimeError`，`?` 在错误时提前返回。

循环开始前初始化四个累加器：`assistant_messages`（助手消息列表）、`tool_results`（工具结果列表）、`prompt_cache_events`（缓存事件列表）、`auto_compaction`（压缩事件）。这些累加器在循环中不断追加，最终组装为 `TurnSummary`。

### 阶段三：API 调用与消息组装

每次迭代首先构造请求并调用 API：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

        let request = ApiRequest {
            system_prompt: self.system_prompt.clone(),
            messages: self.session.messages.clone(),
        };
        let events = match self.api_client.stream(request) {
            Ok(events) => events,
            Err(error) => {
                self.record_turn_failed(iterations, &error);
                return Err(error);
            }
        };
```

`ApiRequest` 每次迭代都重新构造——`clone()` 复制 system_prompt 和 messages。因为每次迭代后 session 的消息列表可能增长（加入了新的助手消息和工具结果），下次 API 调用需要包含最新消息。

流式事件组装为结构化消息：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

        let (assistant_message, usage, turn_prompt_cache_events) =
            match build_assistant_message(events) {
                Ok(result) => result,
                Err(error) => {
                    self.record_turn_failed(iterations, &error);
                    return Err(error);
                }
            };
        if let Some(usage) = usage {
            self.usage_tracker.record(usage);
        }
        prompt_cache_events.extend(turn_prompt_cache_events);
```

`build_assistant_message` 把 `Vec<AssistantEvent>` 转换为三元组：`(ConversationMessage, Option<TokenUsage>, Vec<PromptCacheEvent>)`。如果返回 `Usage`，记录到 `usage_tracker`。`prompt_cache_events.extend()` 把本轮的缓存事件追加到累加器。

从助手消息中提取待执行的工具调用：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

        let pending_tool_uses = assistant_message
            .blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolUse { id, name, input } => {
                    Some((id.clone(), name.clone(), input.clone()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
```

`filter_map` 是 `filter` + `map` 的组合，对每个 block 做模式匹配，`ToolUse` 变体提取三元组 `(id, name, input)`，其他变体返回 `None` 被过滤掉。这比先 `filter` 再 `map` 更高效——一次遍历完成两个操作。

### 阶段四：工具执行循环

如果没有工具调用，循环结束：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

        if pending_tool_uses.is_empty() {
            break;
        }
```

`break` 退出 `loop` 循环，模型不再请求工具，本轮 turn 完成。如果有工具调用，逐个执行：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

        for (tool_use_id, tool_name, input) in pending_tool_uses {
            let pre_hook_result = self.run_pre_tool_use_hook(&tool_name, &input);
            let effective_input = pre_hook_result
                .updated_input()
                .map_or_else(|| input.clone(), ToOwned::to_owned);
            let permission_context = PermissionContext::new(
                pre_hook_result.permission_override(),
                pre_hook_result.permission_reason().map(ToOwned::to_owned),
            );
```

每个工具调用经过四个步骤。第一步前置钩子——`run_pre_tool_use_hook` 可以修改工具输入（`updated_input`）、覆盖权限决策（`permission_override`）、或直接取消工具调用。`effective_input` 是钩子可能修改后的输入，`map_or_else` 在 `updated_input` 返回 `None` 时用原始 `input.clone()`，返回 `Some` 时用钩子修改的值。

第二步权限检查，有四条分支：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

            let permission_outcome = if pre_hook_result.is_cancelled() {
                PermissionOutcome::Deny {
                    reason: format_hook_message(
                        &pre_hook_result,
                        &format!("PreToolUse hook cancelled tool `{tool_name}`"),
                    ),
                }
            } else if pre_hook_result.is_failed() {
                PermissionOutcome::Deny {
                    reason: format_hook_message(
                        &pre_hook_result,
                        &format!("PreToolUse hook failed for tool `{tool_name}`"),
                    ),
                }
            } else if pre_hook_result.is_denied() {
                PermissionOutcome::Deny {
                    reason: format_hook_message(
                        &pre_hook_result,
                        &format!("PreToolUse hook denied tool `{tool_name}`"),
                    ),
                }
            } else if let Some(prompt) = prompter.as_mut() {
                self.permission_policy.authorize_with_context(
                    &tool_name,
                    &effective_input,
                    &permission_context,
                    Some(*prompt),
                )
            } else {
                self.permission_policy.authorize_with_context(
                    &tool_name,
                    &effective_input,
                    &permission_context,
                    None,
                )
            };
```

四条分支按优先级排列。前三条检查前置钩子的状态——如果钩子取消了、失败了、或拒绝了，直接生成 `Deny` 结果，不再调用权限策略。这确保钩子有最高优先级。第四和第五条分支是正常路径——委托给 `PermissionPolicy::authorize_with_context`。差异在于是否有 `prompter`：有 `prompter` 时传 `Some(*prompt)`，权限策略可以在需要用户确认时通过 prompter 弹出交互提示；没有时传 `None`，权限策略自动决策。

第三步工具执行：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

            let result_message = match permission_outcome {
                PermissionOutcome::Allow => {
                    self.record_tool_started(iterations, &tool_name);
                    let (mut output, mut is_error) =
                        match self.tool_executor.execute(&tool_name, &effective_input) {
                            Ok(output) => (output, false),
                            Err(error) => (error.to_string(), true),
                        };
                    output = merge_hook_feedback(pre_hook_result.messages(), output, false);

                    let post_hook_result = if is_error {
                        self.run_post_tool_use_failure_hook(
                            &tool_name,
                            &effective_input,
                            &output,
                        )
                    } else {
                        self.run_post_tool_use_hook(
                            &tool_name,
                            &effective_input,
                            &output,
                            false,
                        )
                    };
```

权限允许时执行工具。`self.tool_executor.execute(&tool_name, &effective_input)` 返回 `Result<String, ToolError>`——`Ok` 时 output 是工具输出，`is_error = false`；`Err` 时 output 是错误消息，`is_error = true`。

`merge_hook_feedback` 把前置钩子的消息拼接到工具输出中。后置钩子根据执行结果选择不同通道——成功走 `post_tool_use`，失败走 `post_tool_use_failure`。如果后置钩子也拒绝了，`is_error` 设为 `true`——后置钩子可以把一个成功的工具结果标记为错误。

第四步构造结果消息并入队：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

                    if post_hook_result.is_denied()
                        || post_hook_result.is_failed()
                        || post_hook_result.is_cancelled()
                    {
                        is_error = true;
                    }
                    output = merge_hook_feedback(
                        post_hook_result.messages(),
                        output,
                        post_hook_result.is_denied()
                            || post_hook_result.is_failed()
                            || post_hook_result.is_cancelled(),
                    );

                    ConversationMessage::tool_result(tool_use_id, tool_name, output, is_error)
                }
                PermissionOutcome::Deny { reason } => ConversationMessage::tool_result(
                    tool_use_id,
                    tool_name,
                    merge_hook_feedback(pre_hook_result.messages(), reason, true),
                    true,
                ),
            };
            self.session
                .push_message(result_message.clone())
                .map_err(|error| RuntimeError::new(error.to_string()))?;
            self.record_tool_finished(iterations, &result_message);
            tool_results.push(result_message);
        }
```

权限拒绝时构造 `tool_result` 消息——`output` 是拒绝原因（拼接钩子反馈），`is_error = true`。这告诉 LLM 工具调用被拒绝了，需要在后续推理中考虑这个信息。

工具结果消息通过 `push_message` 加入 session，同时记录到 `tool_results` 累加器。工具结果加入 session 后，下一轮 API 调用时模型能看到工具执行结果，基于新信息继续推理。

整个工具执行循环用 `for` 遍历 `pending_tool_uses`——一个模型消息中可能包含多个工具调用（并行工具调用），它们被顺序执行。claw-code 选择顺序执行是因为工具之间可能有依赖（如先 `read_file` 再 `edit_file`），并行执行可能导致竞态条件。

### 循环退出与结果汇总

当 `pending_tool_uses` 为空时，模型不再请求工具，循环退出：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

    let summary = TurnSummary {
        assistant_messages,
        tool_results,
        prompt_cache_events,
        iterations,
        usage: self.usage_tracker.cumulative_usage(),
        auto_compaction,
    };
    self.record_turn_completed(&summary);
    Ok(summary)
```

`TurnSummary` 包含本轮所有助手消息、工具结果、缓存事件、迭代次数和累计 token 用量。`record_turn_completed` 记录遥测事件。`Ok(summary)` 返回成功结果。

## 11.3 build_assistant_message：流式事件组装

`build_assistant_message` 把 `Vec<AssistantEvent>` 转换为结构化的 `ConversationMessage`：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

fn build_assistant_message(
    events: Vec<AssistantEvent>,
) -> Result<
    (
        ConversationMessage,
        Option<TokenUsage>,
        Vec<PromptCacheEvent>,
    ),
    RuntimeError,
> {
    let mut text = String::new();
    let mut blocks = Vec::new();
    let mut prompt_cache_events = Vec::new();
    let mut finished = false;
    let mut usage = None;

    for event in events {
        match event {
            AssistantEvent::Thinking { thinking, signature } => {
                flush_text_block(&mut text, &mut blocks);
                blocks.push(ContentBlock::Thinking { thinking, signature });
            }
            AssistantEvent::TextDelta(delta) => text.push_str(&delta),
            AssistantEvent::ToolUse { id, name, input } => {
                flush_text_block(&mut text, &mut blocks);
                blocks.push(ContentBlock::ToolUse { id, name, input });
            }
            AssistantEvent::Usage(value) => usage = Some(value),
            AssistantEvent::PromptCache(event) => prompt_cache_events.push(event),
            AssistantEvent::MessageStop => {
                finished = true;
            }
        }
    }
```

函数维护两个缓冲区：`text` 累积文本增量，`blocks` 存储已完成的 content block。`finished` 标记是否收到 `MessageStop` 事件。如果没有收到，视为流截断，返回错误。

`match event` 对六种事件做不同 `TextDelta` 把文本增量追加到 `text` 缓冲区。`Thinking` 和 `ToolUse` 在加入 blocks 前先调用 `flush_text_block`——把累积的文本刷入 blocks，确保文本块在思考块或工具块之前。

`flush_text_block` 是辅助函数：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

fn flush_text_block(text: &mut String, blocks: &mut Vec<ContentBlock>) {
    if !text.is_empty() {
        blocks.push(ContentBlock::Text {
            text: std::mem::take(text),
        });
    }
}
```

`std::mem::take(text)` 取走 `text` 的内容（替换为空 `String`），避免了 `text.clone()` 的内存拷贝。这是 Rust 的零拷贝优化——`mem::take` 把字符串的所有权转移到 `ContentBlock::Text` 中，原 `text` 变为空字符串继续使用。

组装完成后做两个校验：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

    flush_text_block(&mut text, &mut blocks);

    if !finished {
        return Err(RuntimeError::new(
            "assistant stream ended without a message stop event",
        ));
    }
    if blocks.is_empty() {
        return Err(RuntimeError::new("assistant stream produced no content"));
    }

    Ok((
        ConversationMessage::assistant_with_usage(blocks, usage),
        usage,
        prompt_cache_events,
    ))
}
```

第一个校验：`!finished` 表示没有收到 `MessageStop`——流可能因为网络中断或服务器错误被截断。第二个校验：`blocks.is_empty()` 表示流没有产生任何内容——即使有 `MessageStop` 但没有实际内容也是错误。这两个校验确保进入 session 的消息都是完整的。

## 11.4 自动压缩与上下文管理

长对话会累积大量消息，最终超过模型的上下文窗口。`ConversationRuntime` 在每次 API 调用返回后检查是否需要自动压缩：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

fn maybe_auto_compact(&mut self) -> Option<AutoCompactionEvent> {
    if self.usage_tracker.cumulative_usage().input_tokens
        < self.auto_compaction_input_tokens_threshold
    {
        return None;
    }

    let result = compact_session(
        &self.session,
        CompactionConfig {
            max_estimated_tokens: 0,
            ..CompactionConfig::default()
        },
    );

    if result.removed_message_count == 0 {
        return None;
    }

    self.session = result.compacted_session;
    Some(AutoCompactionEvent {
        removed_message_count: result.removed_message_count,
    })
}
```

第一步检查 token 阈值——`usage_tracker.cumulative_usage().input_tokens` 是累计 input tokens，与 `auto_compaction_input_tokens_threshold` 比较。未达阈值返回 `None`（不压缩）。

第二步调用 `compact_session`——`CompactionConfig { max_estimated_tokens: 0, ..CompactionConfig::default() }` 用结构体更新语法（`..` 表示其余字段用默认值）。`max_estimated_tokens: 0` 意味着强制压缩——任何大于 0 token 的可压缩消息都会被压缩。`preserve_recent_messages` 用默认值 4，保留最近 4 条消息不压缩。

第三步检查压缩结果——如果 `removed_message_count == 0`，说明没有可压缩的内容，返回 `None`。否则用压缩后的 session 替换当前 session，返回压缩事件。

默认阈值是 100,000 input tokens：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

const DEFAULT_AUTO_COMPACTION_INPUT_TOKENS_THRESHOLD: u32 = 100_000;
const AUTO_COMPACTION_THRESHOLD_ENV_VAR: &str = "CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS";
```

阈值可通过环境变量覆盖。`auto_compaction_threshold_from_env` 读取环境变量并解析：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

pub fn auto_compaction_threshold_from_env() -> u32 {
    parse_auto_compaction_threshold(
        std::env::var(AUTO_COMPACTION_THRESHOLD_ENV_VAR).ok().as_deref(),
    )
}

fn parse_auto_compaction_threshold(value: Option<&str>) -> u32 {
    value
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .filter(|threshold| *threshold > 0)
        .unwrap_or(DEFAULT_AUTO_COMPACTION_INPUT_TOKENS_THRESHOLD)
}
```

`std::env::var(env_var).ok()` 把 `Result<String, VarError>` 转为 `Option<String>`——环境变量存在时 `Some(value)`，不存在时 `None`。`.as_deref()` 把 `Option<String>` 转为 `Option<&str>`——避免克隆字符串。

`parse_auto_compaction_threshold` 用链式操作解析值。`and_then(|raw| raw.trim().parse::<u32>().ok())` 尝试把字符串解析为 `u32`——解析失败返回 `None`。`filter(|threshold| *threshold > 0)` 过滤掉 0 和负值（`u32` 没有负值，但 0 没有意义）。`unwrap_or(default)` 在所有步骤都失败时回退到默认值。

自动压缩的触发时机在每次迭代末尾、检查 `pending_tool_uses` 之前：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

        if let Some(compaction) = self.maybe_auto_compact() {
            auto_compaction = Some(compaction);
        }

        if pending_tool_uses.is_empty() {
            break;
        }
```

注释说明这是一个 bug fix，确保即使最后一轮迭代（没有工具调用的终轮）也会检查压缩。如果没有这个检查，最后一轮的消息不会被压缩，session 会无限增长。

## 11.5 会话追踪与遥测

`ConversationRuntime` 通过 `SessionTracer` 记录 turn 的完整生命周期事件。tracer 是可选的，只在显式配置时生效：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

pub fn with_session_tracer(mut self, session_tracer: SessionTracer) -> Self {
    self.session_tracer = Some(session_tracer);
    self
}
```

每个 record 方法都遵循相同的模式——先检查 tracer 是否存在，不存在则直接返回：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

fn record_turn_started(&self, user_input: &str) {
    let Some(session_tracer) = &self.session_tracer else {
        return;
    };

    let mut attributes = Map::new();
    attributes.insert(
        "user_input".to_string(),
        Value::String(user_input.to_string()),
    );
    session_tracer.record("turn_started", attributes);
}
```

`let Some(session_tracer) = &self.session_tracer else { return; }` 是 `let-else` 语法——如果模式匹配成功，绑定变量；如果失败（`None`），执行 `else` 块（这里是 `return`）。这是 Rust 1.65+ 引入的语法，简化了"提取 Option 值或提前返回"的模式。

turn 生命周期包含六个关键事件点：

| 事件名 | 触发时机 | 关键属性 |
| --- | --- | --- |
| `turn_started` | 用户消息入队后 | `user_input` |
| `assistant_iteration_completed` | 每次 API 返回后 | `iteration`、`assistant_blocks`、`pending_tool_use_count` |
| `tool_execution_started` | 工具开始执行前 | `iteration`、`tool_name` |
| `tool_execution_finished` | 工具结果入队后 | `iteration`、`tool_name`、`is_error` |
| `turn_completed` | TurnSummary 组装后 | `iterations`、`assistant_messages`、`tool_results`、`prompt_cache_events` |
| `turn_failed` | 任何阶段出错时 | `iteration`、`error` |

## 11.6 测试设施

`StaticToolExecutor` 是 `ToolExecutor` trait 的内存实现，用于测试和轻量集成：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs

type ToolHandler = Box<dyn FnMut(&str) -> Result<String, ToolError>>;

#[derive(Default)]
pub struct StaticToolExecutor {
    handlers: BTreeMap<String, ToolHandler>,
}

impl StaticToolExecutor {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn register(
        mut self,
        tool_name: impl Into<String>,
        handler: impl FnMut(&str) -> Result<String, ToolError> + 'static,
    ) -> Self {
        self.handlers.insert(tool_name.into(), Box::new(handler));
        self
    }
}

impl ToolExecutor for StaticToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        self.handlers
            .get_mut(tool_name)
            .ok_or_else(|| ToolError::new(format!("unknown tool: {tool_name}")))?
            (input)
    }
}
```

`type ToolHandler = Box<dyn FnMut(&str) -> Result<String, ToolError>>` 是类型别名——`Box<dyn FnMut(...)>` 是一个堆分配的、可变的闭包。`FnMut` 表示闭包可以修改捕获的变量。`'static` 生命周期约束表示闭包不借用任何非静态引用。

`handlers: BTreeMap<String, ToolHandler>` 用 `BTreeMap` 而不是 `HashMap`，因为 `BTreeMap` 按键排序，测试输出确定性强。`register` 方法接收闭包，用 `Box::new(handler)` 把闭包装箱为 trait object。返回 `self` 支持链式注册：

```rust
let executor = StaticToolExecutor::new()
    .register("read_file", |input| Ok("file content".to_string()))
    .register("bash", |input| Ok("command output".to_string()));
```

`ScriptedApiClient` 是 `ApiClient` trait 的测试实现，按调用次数返回预设的事件序列：

```rust
// claw-code/rust/crates/runtime/src/conversation.rs (test module)

struct ScriptedApiClient {
    call_count: usize,
}

impl ApiClient for ScriptedApiClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        self.call_count += 1;
        match self.call_count {
            // 第一次调用返回工具调用，第二次返回文本回答
            ...
        }
    }
}
```

`call_count` 在每次调用时递增，`match` 根据调用次数返回不同的事件序列。这模拟了多轮对话——第一轮模型请求工具，第二轮模型基于工具结果给出最终回答。

泛型设计是核心差异。`ConversationRuntime` 通过 trait 约束注入 `ApiClient` 和 `ToolExecutor`，编译期单态化——每个具体的 `(C, T)` 组合生成一份专门代码，`self.api_client.stream(request)` 直接编译为具体类型的 `stream` 方法调用，零开销。只有 `hook_progress_reporter` 和 `session_tracer` 用了 `Box<dyn>` 动态分发，因为它们是可选的且类型复杂。

## 小结

Turn Loop 在 Rust 端以 `ConversationRuntime`（`conversation.rs`）为生产实现，泛型参数 `C` 和 `T` 通过 trait 约束注入 `ApiClient` 和 `ToolExecutor`，编译期单态化零开销。`run_turn` 方法分四个阶段：会话健康检查（压缩后探针）→ API 调用与事件组装（`build_assistant_message` 把 `AssistantEvent` 流转为结构化消息）→ 工具执行循环（前置钩子 → 权限检查 → 执行 → 后置钩子）→ 循环退出与 `TurnSummary` 汇总。

`build_assistant_message` 用 `text` 缓冲区累积文本增量，用 `flush_text_block` 在 `Thinking` 和 `ToolUse` 事件前刷入文本块，`std::mem::take` 实现零拷贝。组装后检查 `MessageStop` 和内容非空，确保进入 session 的消息完整。

`maybe_auto_compact` 在每次迭代后检查 100K token 阈值，触发 `compact_session` 把旧消息压缩为摘要+保留最近 4 条。阈值可通过 `CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS` 环境变量覆盖。`SessionTracer` 可选地记录从 `turn_started` 到 `turn_completed` 的六个生命周期事件。`StaticToolExecutor` 和 `ScriptedApiClient` 提供测试设施。

| 关键文件 | 核心机制 | 对应章节 |
| --- | --- | --- |
| `rust/crates/runtime/src/conversation.rs` | `ConversationRuntime`、`run_turn`、trait 注入 | 11.1-11.2 |
| `rust/crates/runtime/src/conversation.rs` | `build_assistant_message`、事件组装 | 11.3 |
| `rust/crates/runtime/src/conversation.rs` | `maybe_auto_compact`、`SessionTracer` | 11.4-11.5 |
| `rust/crates/runtime/src/compact.rs` | `compact_session`、`CompactionConfig` | 11.4 |

下一章将分析协调器与任务编排——`TaskRegistry` 如何管理多 Agent 任务状态，`TeamRegistry` 如何维护团队关系，以及 `LaneBoard` 如何按状态分组展示任务进度。
