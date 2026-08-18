# 第5章 API 通信与模型交互：SSE 流与 Provider 路由

## 本章概览

本章分析 claw-code 的 API 通信层，对应 `api` crate。这一层负责与上游 LLM 服务建立连接、发送请求、接收流式响应，并在本地缓存 prompt 以降低重复调用的成本。

API 层要解决的核心问题是：Agent 需要同时支持 Anthropic 原生协议和 OpenAI 兼容协议，需要根据模型名自动路由到正确的 Provider，需要处理 SSE 流式响应的解析，还需要在会话级别缓存 prompt 以利用服务端提供的 prompt cache 能力。

| 关键文件 | 职责 |
| --- | --- |
| `rust/crates/api/src/client.rs` | `ProviderClient` 枚举，统一入口，Provider 路由 |
| `rust/crates/api/src/types.rs` | `MessageRequest`、`MessageResponse`、`StreamEvent` 等数据类型 |
| `rust/crates/api/src/sse.rs` | `SseParser`，SSE 帧解析与事件流组装 |
| `rust/crates/api/src/providers/anthropic.rs` | Anthropic 原生客户端实现 |
| `rust/crates/api/src/providers/openai_compat.rs` | OpenAI 兼容客户端实现 |
| `rust/crates/api/src/providers/mod.rs` | Provider 注册表、模型别名解析、能力报告 |
| `rust/crates/api/src/prompt_cache.rs` | Prompt 本地缓存，指纹生成，命中统计 |
| `rust/crates/api/src/http_client.rs` | HTTP 超时与代理配置 |

## 5.1 ProviderClient：统一入口与 Provider 路由

`ProviderClient` 是一个枚举，封装了三种上游客户端：

```rust
// claw-code/rust/crates/api/src/client.rs

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum ProviderClient {
    Anthropic(AnthropicClient),
    Xai(OpenAiCompatClient),
    OpenAi(OpenAiCompatClient),
}
```

`#[allow(clippy::large_enum_variant)]` 抑制了 clippy 关于枚举变体大小差异的警告——`AnthropicClient` 可能比 `OpenAiCompatClient` 大，但这里用 `Box` 包装并不划算，因为 `ProviderClient` 在调用栈上传递的次数很少。

`ProviderClient` 的构造通过模型名自动路由：

```rust
// claw-code/rust/crates/api/src/client.rs

pub fn from_model_with_anthropic_auth(
    model: &str,
    anthropic_auth: Option<AuthSource>,
) -> Result<Self, ApiError> {
    let resolved_model = providers::resolve_model_alias(model);
    match providers::detect_provider_kind(&resolved_model) {
        ProviderKind::Anthropic => Ok(Self::Anthropic(match anthropic_auth {
            Some(auth) => AnthropicClient::from_auth(auth),
            None => AnthropicClient::from_env()?,
        })),
        ProviderKind::Xai => Ok(Self::Xai(OpenAiCompatClient::from_env(
            OpenAiCompatConfig::xai(),
        )?)),
        ProviderKind::OpenAi => {
            if std::env::var_os("OLLAMA_HOST").is_some() {
                Ok(Self::OpenAi(
                    openai_compat::OpenAiCompatClient::from_ollama_env()
                        .expect("from_ollama_env always returns Some"),
                ))
            } else {
                let config = match providers::metadata_for_model(&resolved_model) {
                    Some(meta) if meta.auth_env == "DASHSCOPE_API_KEY" => {
                        OpenAiCompatConfig::dashscope()
                    }
                    _ => OpenAiCompatConfig::openai(),
                };
                Ok(Self::OpenAi(OpenAiCompatClient::from_env(config)?))
            }
        }
    }
}
```

路由逻辑分三步。第一步 `resolve_model_alias` 把别名（如 `"opus"`、`"sonnet"`）解析为完整模型 ID。第二步 `detect_provider_kind` 根据模型名前缀判断 Provider 类型。第三步根据 Provider 类型创建对应的客户端。

`OpenAi` 变体的分支最为复杂，因为它需要处理多个 OpenAI 兼容服务端：本地 Ollama（通过 `OLLAMA_HOST` 环境变量检测）、DashScope（模型 ID 以 `qwen-` 开头）、以及标准 OpenAI。`metadata_for_model` 返回的 `ProviderMetadata` 包含 `auth_env` 字段，用于区分不同的认证环境变量。

`ProviderClient` 提供统一的发送和流式接口：

```rust
// claw-code/rust/crates/api/src/client.rs

pub async fn send_message(
    &self,
    request: &MessageRequest,
) -> Result<MessageResponse, ApiError> {
    match self {
        Self::Anthropic(client) => client.send_message(request).await,
        Self::Xai(client) | Self::OpenAi(client) => client.send_message(request).await,
    }
}

pub async fn stream_message(
    &self,
    request: &MessageRequest,
) -> Result<MessageStream, ApiError> {
    match self {
        Self::Anthropic(client) => client
            .stream_message(request)
            .await
            .map(MessageStream::Anthropic),
        Self::Xai(client) | Self::OpenAi(client) => client
            .stream_message(request)
            .await
            .map(MessageStream::OpenAiCompat),
    }
}
```

`send_message` 返回完整的 `MessageResponse`，适用于不需要流式输出的场景。`stream_message` 返回 `MessageStream` 枚举，调用方通过 `next_event` 逐个消费事件。两个方法的签名相同，区别仅在于返回类型——这让上层代码可以根据场景选择同步或流式消费。

`MessageStream` 是流式响应的封装：

```rust
// claw-code/rust/crates/api/src/client.rs

pub enum MessageStream {
    Anthropic(anthropic::MessageStream),
    OpenAiCompat(openai_compat::MessageStream),
}

impl MessageStream {
    pub async fn next_event(&mut self) -> Result<Option<StreamEvent>, ApiError> {
        match self {
            Self::Anthropic(stream) => stream.next_event().await,
            Self::OpenAiCompat(stream) => stream.next_event().await,
        }
    }
}
```

`next_event` 返回 `Option<StreamEvent>`——`Some` 表示收到一个事件，`None` 表示流结束。`StreamEvent` 是跨 Provider 的统一事件类型，无论底层是 Anthropic 原生 SSE 还是 OpenAI 兼容 SSE，上层看到的都是同一套事件枚举。

## 5.2 请求与响应类型

### MessageRequest

`MessageRequest` 是发给 LLM 的请求结构：

```rust
// claw-code/rust/crates/api/src/types.rs

pub struct MessageRequest {
    pub model: String,
    pub max_tokens: u32,
    pub messages: Vec<InputMessage>,
    pub system: Option<String>,
    pub tools: Option<Vec<ToolDefinition>>,
    pub tool_choice: Option<ToolChoice>,
    pub stream: bool,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub stop: Option<Vec<String>>,
    pub reasoning_effort: Option<String>,
    pub extra_body: BTreeMap<String, Value>,
}
```

`model` 和 `max_tokens` 是必填字段。`messages` 是对话历史列表。`system` 是系统提示词。`tools` 是工具定义列表，当这个字段为 `Some` 时，LLM 可以输出 tool call 请求。`tool_choice` 控制工具选择策略：`Auto`（模型自行决定）、`Any`（必须使用至少一个工具）、`Tool { name }`（强制使用指定工具）。

`stream` 控制是否启用 SSE 流式输出。`temperature`、`top_p` 等是常规调参。`reasoning_effort` 是 OpenAI 兼容推理模型（如 `o4-mini`）特有的参数，取值为 `"low"`、`"medium"`、`"high"`。`extra_body` 是兜底机制——用户可以通过配置注入任意额外字段到请求体中，用于 Gateway 特性（如 `web_search_options`）或本地服务器的自定义开关。

`#[serde(skip_serializing_if = "Option::is_none")]` 属性让序列化时跳过 `None` 字段——这保持请求体干净，只包含实际设置的参数。

### InputMessage 与 ContentBlock

`InputMessage` 表示一条对话消息：

```rust
// claw-code/rust/crates/api/src/types.rs

pub struct InputMessage {
    pub role: String,
    pub content: Vec<InputContentBlock>,
}
```

`role` 是 `"user"`、`"assistant"` 或 `"tool"`。`content` 是内容块列表， Anthropic Messages API 支持一条消息包含多个内容块（如文本 + 工具调用）。

`InputContentBlock` 枚举四种内容类型：

```rust
// claw-code/rust/crates/api/src/types.rs

pub enum InputContentBlock {
    Text { text: String },
    Thinking { thinking: String, signature: Option<String> },
    ToolUse { id: String, name: String, input: Value },
    ToolResult { tool_use_id: String, content: Vec<ToolResultContentBlock>, is_error: bool },
}
```

`Text` 是普通文本。`Thinking` 是扩展思考过程，`signature` 是模型提供的加密签名，用于验证思考内容的完整性。`ToolUse` 是模型发出的工具调用请求。`ToolResult` 是工具执行结果，`tool_use_id` 与 `ToolUse` 的 `id` 配对，`is_error` 标记执行是否失败。

`ToolResultContentBlock` 支持文本和 JSON 两种输出格式：

```rust
// claw-code/rust/crates/api/src/types.rs

pub enum ToolResultContentBlock {
    Text { text: String },
    Json { value: Value },
}
```

### StreamEvent

`StreamEvent` 是 SSE 流中的事件枚举：

```rust
// claw-code/rust/crates/api/src/types.rs

pub enum StreamEvent {
    MessageStart(MessageStartEvent),
    ContentBlockStart(ContentBlockStartEvent),
    ContentBlockDelta(ContentBlockDeltaEvent),
    ContentBlockStop(ContentBlockStopEvent),
    MessageDelta(MessageDeltaEvent),
    MessageStop(MessageStopEvent),
}
```

六个变体对应 SSE 流的生命周期：`MessageStart` 标记消息开始，`ContentBlockStart` 标记新内容块开始，`ContentBlockDelta` 携带内容增量（文本片段或思考片段），`ContentBlockStop` 标记内容块结束，`MessageDelta` 携带消息级元数据（如 stop_reason），`MessageStop` 标记整个消息结束。

## 5.3 SSE 流解析：SseParser

SSE（Server-Sent Events）是 LLM 流式输出的传输协议。`SseParser` 负责把原始字节流解析为 `StreamEvent` 列表：

```rust
// claw-code/rust/crates/api/src/sse.rs

pub struct SseParser {
    buffer: Vec<u8>,
    provider: Option<String>,
    model: Option<String>,
}
```

`buffer` 是未解析的字节缓冲区——SSE 帧可能跨越多个 TCP 包，`SseParser` 需要缓冲不完整的数据直到完整的帧到达。`provider` 和 `model` 用于错误上下文——当 JSON 反序列化失败时，错误消息会包含 Provider 和模型名，帮助定位问题。

`push` 方法接收新的字节块并解析出完整的事件：

```rust
// claw-code/rust/crates/api/src/sse.rs

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
```

`extend_from_slice` 把新字节追加到缓冲区。`next_frame` 尝试从缓冲区中提取一个完整的 SSE 帧——如果缓冲区中还没有完整的帧（缺少 `"\n\n"` 分隔符），返回 `None`，循环结束。`parse_frame_with_context` 把帧解析为 `StreamEvent`。

`next_frame` 查找帧分隔符：

```rust
// claw-code/rust/crates/api/src/sse.rs

fn next_frame(&mut self) -> Option<String> {
    let separator = self
        .buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|position| (position, 2))
        .or_else(|| {
            self.buffer
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|position| (position, 4))
        })?;

    let (position, separator_len) = separator;
    let frame = self
        .buffer
        .drain(..position + separator_len)
        .collect::<Vec<_>>();
    let frame_len = frame.len().saturating_sub(separator_len);
    Some(String::from_utf8_lossy(&frame[..frame_len]).into_owned())
}
```

SSE 规范允许两种帧分隔符：`"\n\n"`（Unix 风格）和 `"\r\n\r\n"`（Windows 风格）。代码先查找 `"\n\n"`，找不到再查找 `"\r\n\r\n"`。`windows(2)` 和 `windows(4)` 创建滑动窗口迭代器，`position` 返回第一个匹配的位置。找到分隔符后，`drain` 方法把帧内容从缓冲区中移除，保留剩余字节供下次 `push` 继续解析。

`parse_frame` 解析单个 SSE 帧：

```rust
// claw-code/rust/crates/api/src/sse.rs

pub fn parse_frame(frame: &str) -> Result<Option<StreamEvent>, ApiError> {
    let trimmed = frame.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let mut data_lines = Vec::new();
    let mut event_name: Option<&str> = None;

    for line in trimmed.lines() {
        if line.starts_with(':') {
            continue;
        }
        if let Some(name) = line.strip_prefix("event:") {
            event_name = Some(name.trim());
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start());
        }
    }

    if matches!(event_name, Some("ping")) {
        return Ok(None);
    }

    if data_lines.is_empty() {
        return Ok(None);
    }

    let payload = data_lines.join("\n");
    if payload == "[DONE]" {
        return Ok(None);
    }

    serde_json::from_str::<StreamEvent>(&payload)
        .map(Some)
        .map_err(|error| ApiError::json_deserialize("unknown", "unknown", &payload, error))
}
```

解析逻辑分五步。第一步 trim 空帧。第二步逐行解析：以 `:` 开头的是注释行，跳过；以 `event:` 开头的是事件名，记录；以 `data:` 开头的是数据行，收集。第三步如果事件名是 `"ping"`，返回 `None`（心跳帧，无业务数据）。第四步如果没有数据行，返回 `None`。第五步把数据行拼接为 JSON payload，反序列化为 `StreamEvent`。

OpenAI 兼容 SSE 在流结束时发送 `data: [DONE]`，这里也做了过滤。

## 5.4 Provider 注册表与模型别名

`providers/mod.rs` 维护了一个模型注册表：

```rust
// claw-code/rust/crates/api/src/providers/mod.rs

const MODEL_REGISTRY: &[(&str, ProviderMetadata)] = &[
    (
        "opus",
        ProviderMetadata {
            provider: ProviderKind::Anthropic,
            auth_env: "ANTHROPIC_API_KEY",
            base_url_env: "ANTHROPIC_BASE_URL",
            default_base_url: anthropic::DEFAULT_BASE_URL,
        },
    ),
    (
        "sonnet",
        ProviderMetadata {
            provider: ProviderKind::Anthropic,
            auth_env: "ANTHROPIC_API_KEY",
            base_url_env: "ANTHROPIC_BASE_URL",
            default_base_url: anthropic::DEFAULT_BASE_URL,
        },
    ),
    // ... 更多条目
];
```

`MODEL_REGISTRY` 是一个静态数组，每个条目包含别名和元数据。`ProviderMetadata` 记录了 Provider 类型、认证环境变量名、基础 URL 环境变量名和默认基础 URL。

`resolve_model_alias` 把别名解析为完整模型 ID：

```rust
// claw-code/rust/crates/api/src/providers/mod.rs

pub fn resolve_model_alias(model: &str) -> String {
    // 简化的核心逻辑
    match model.to_lowercase().as_str() {
        "opus" => "claude-3-opus-20240229".to_string(),
        "sonnet" => "claude-3-sonnet-20240229".to_string(),
        "haiku" => "claude-3-haiku-20240307".to_string(),
        other => other.to_string(),
    }
}
```

`detect_provider_kind` 根据模型名前缀判断 Provider：

```rust
// claw-code/rust/crates/api/src/providers/mod.rs

pub fn detect_provider_kind(model: &str) -> ProviderKind {
    let lower = model.to_lowercase();
    if lower.starts_with("claude-") {
        ProviderKind::Anthropic
    } else if lower.starts_with("grok-") {
        ProviderKind::Xai
    } else {
        ProviderKind::OpenAi
    }
}
```

`claude-` 前缀路由到 Anthropic，`grok-` 前缀路由到 Xai，其余默认路由到 OpenAI 兼容协议。这个启发式简单但有效——所有主流 OpenAI 兼容模型（GPT、Qwen、Llama 等）都不以 `claude-` 或 `grok-` 开头。

`ProviderDiagnostics` 提供Provider 能力报告：

```rust
// claw-code/rust/crates/api/src/providers/mod.rs

pub struct ProviderDiagnostics {
    pub requested_model: String,
    pub resolved_model: String,
    pub provider: ProviderKind,
    pub auth_env: &'static str,
    pub base_url_env: &'static str,
    pub default_base_url: &'static str,
    pub openai_compatible: bool,
    pub reasoning_model: bool,
    pub preserves_reasoning_content_in_history: bool,
    pub strips_tuning_params: bool,
    pub supports_stream_usage: bool,
    pub honors_proxy_env: bool,
    pub supports_extra_body_params: bool,
    pub preserves_slash_model_ids_on_custom_base_url: bool,
}
```

这个结构在启动时生成，用于诊断输出——告诉用户当前使用的模型、Provider、认证环境变量、是否支持流式 usage 等信息。

## 5.5 AnthropicClient 与认证

`AnthropicClient` 是 Anthropic 原生协议的实现：

```rust
// claw-code/rust/crates/api/src/providers/anthropic.rs

pub struct AnthropicClient {
    http: reqwest::Client,
    auth: AuthSource,
    base_url: String,
    max_retries: u32,
    initial_backoff: Duration,
    max_backoff: Duration,
    request_profile: AnthropicRequestProfile,
    session_tracer: Option<SessionTracer>,
    prompt_cache: Option<PromptCache>,
    last_prompt_cache_record: Arc<Mutex<Option<PromptCacheRecord>>>,
}
```

`http` 是 `reqwest::Client`，复用连接池。`auth` 是认证来源。`max_retries`（默认 8 次）、`initial_backoff`（默认 1 秒）、`max_backoff`（默认 128 秒）构成指数退避重试策略。`prompt_cache` 是可选的 prompt 缓存。

`AuthSource` 枚举四种认证方式：

```rust
// claw-code/rust/crates/api/src/providers/anthropic.rs

pub enum AuthSource {
    None,
    ApiKey(String),
    BearerToken(String),
    ApiKeyAndBearer { api_key: String, bearer_token: String },
}
```

`ApiKey` 用于标准 API Key 认证（`x-api-key` 请求头）。`BearerToken` 用于 OAuth 认证。`ApiKeyAndBearer` 是两者的组合——某些企业场景需要同时提供 API Key 和 Bearer Token。`from_env` 从环境变量读取：先读 `ANTHROPIC_API_KEY`，再读 `ANTHROPIC_AUTH_TOKEN`，根据两者的存在情况返回对应的变体。

`apply` 方法把认证信息附加到请求构建器上：

```rust
// claw-code/rust/crates/api/src/providers/anthropic.rs

pub fn apply(&self, mut request_builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    if let Some(api_key) = self.api_key() {
        request_builder = request_builder.header("x-api-key", api_key);
    }
    if let Some(token) = self.bearer_token() {
        request_builder = request_builder.bearer_auth(token);
    }
    request_builder
}
```

## 5.6 PromptCache：本地 Prompt 缓存

`PromptCache` 在本地磁盘缓存 prompt 的响应，避免重复调用相同的 prompt：

```rust
// claw-code/rust/crates/api/src/prompt_cache.rs

pub struct PromptCache {
    inner: Arc<Mutex<PromptCacheInner>>,
}
```

`Arc<Mutex<_>>` 让 `PromptCache` 可以安全地跨线程共享。外层 `Arc` 管理引用计数，`Mutex` 保护内部状态。

缓存配置：

```rust
// claw-code/rust/crates/api/src/prompt_cache.rs

pub struct PromptCacheConfig {
    pub session_id: String,
    pub completion_ttl: Duration,
    pub prompt_ttl: Duration,
    pub cache_break_min_drop: u32,
}
```

`completion_ttl`（默认 30 秒）是完成结果缓存的存活时间——完成结果变化快（如代码生成），缓存时间短。`prompt_ttl`（默认 5 分钟）是 prompt 本身缓存的存活时间——prompt 指纹（请求特征）相对稳定。`cache_break_min_drop`（默认 2000 token）是判定缓存异常失效的阈值——如果 cache read tokens 下降超过此值，视为异常失效。

缓存路径按会话隔离：

```rust
// claw-code/rust/crates/api/src/prompt_cache.rs

pub struct PromptCachePaths {
    pub root: PathBuf,
    pub session_dir: PathBuf,
    pub completion_dir: PathBuf,
    pub session_state_path: PathBuf,
    pub stats_path: PathBuf,
}

impl PromptCachePaths {
    pub fn for_session(session_id: &str) -> Self {
        let root = base_cache_root();
        let session_dir = root.join(sanitize_path_segment(session_id));
        let completion_dir = session_dir.join("completions");
        Self {
            root,
            session_state_path: session_dir.join("session-state.json"),
            stats_path: session_dir.join("stats.json"),
            session_dir,
            completion_dir,
        }
    }
}
```

`sanitize_path_segment` 把会话 ID 中的特殊字符替换为安全字符，防止路径遍历攻击。缓存根目录默认在系统临时目录下。

缓存统计：

```rust
// claw-code/rust/crates/api/src/prompt_cache.rs

pub struct PromptCacheStats {
    pub tracked_requests: u64,
    pub completion_cache_hits: u64,
    pub completion_cache_misses: u64,
    pub completion_cache_writes: u64,
    pub expected_invalidations: u64,
    pub unexpected_cache_breaks: u64,
    pub total_cache_creation_input_tokens: u64,
    pub total_cache_read_input_tokens: u64,
    pub last_cache_creation_input_tokens: Option<u32>,
    pub last_cache_read_input_tokens: Option<u32>,
    pub last_request_hash: Option<String>,
    pub last_completion_cache_key: Option<String>,
    pub last_break_reason: Option<String>,
    pub last_cache_source: Option<String>,
}
```

`tracked_requests` 是总请求数。`completion_cache_hits/misses/writes` 是完成缓存的命中、未命中和写入次数。`unexpected_cache_breaks` 记录异常失效次数——这是关键诊断指标，如果 cache read tokens 突然大幅下降但 prompt 没变，说明服务端缓存策略发生变化或 prompt 序列化不稳定。

## 5.7 HTTP 客户端配置

`http_client.rs` 管理 HTTP 超时和代理配置：

```rust
// claw-code/rust/crates/api/src/http_client.rs

pub struct TimeoutConfig {
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
}

impl Default for TimeoutConfig {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(30),
            request_timeout: Duration::from_secs(300),
        }
    }
}
```

`connect_timeout`（默认 30 秒）是 TCP 连接建立超时。`request_timeout`（默认 5 分钟）是整个请求的超时——对于流式响应，这仅覆盖初始握手，流本身由 SSE 解析器管理。

超时可以从环境变量覆盖：

```rust
// claw-code/rust/crates/api/src/http_client.rs

pub fn from_env() -> Self {
    let connect_timeout = std::env::var("CLAW_API_CONNECT_TIMEOUT")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(30));
    let request_timeout = std::env::var("CLAW_API_REQUEST_TIMEOUT")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(300));
    Self { connect_timeout, request_timeout }
}
```

`CLAW_API_CONNECT_TIMEOUT` 和 `CLAW_API_REQUEST_TIMEOUT` 是两个环境变量，分别控制连接超时和请求超时。

代理配置：

```rust
// claw-code/rust/crates/api/src/http_client.rs

pub struct ProxyConfig {
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub no_proxy: Option<String>,
    pub proxy_url: Option<String>,
}
```

`ProxyConfig` 捕获标准代理环境变量（`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`），同时支持统一的 `proxy_url` 字段（配置文件中设置，优先级高于环境变量）。`from_env` 同时检查大小写两种写法（`HTTP_PROXY` 和 `http_proxy`），兼容 curl 和 git 的惯例。

## 小结

API 层通过 `ProviderClient` 枚举实现了多 Provider 的统一封装。`from_model_with_anthropic_auth` 根据模型名自动路由到 Anthropic、Xai 或 OpenAi 兼容客户端，并处理 Ollama 本地部署和 DashScope 等特殊场景。`MessageRequest` 和 `StreamEvent` 定义了跨 Provider 的统一数据模型。`SseParser` 用缓冲区管理 + 帧分隔符扫描实现了可靠的 SSE 流解析，支持 `"\n\n"` 和 `"\r\n\r\n"` 两种分隔符。`PromptCache` 在本地磁盘按会话隔离缓存完成结果，通过 FNV-1a 指纹生成缓存键，统计命中率和异常失效。HTTP 客户端支持超时和代理配置，均可通过环境变量覆盖。

| 关键文件 | 核心机制 | 对应章节 |
| --- | --- | --- |
| `rust/crates/api/src/client.rs` | `ProviderClient` 枚举路由 | 5.1 |
| `rust/crates/api/src/types.rs` | `MessageRequest`、`StreamEvent` | 5.2 |
| `rust/crates/api/src/sse.rs` | `SseParser` 帧解析 | 5.3 |
| `rust/crates/api/src/providers/mod.rs` | 模型注册表、别名解析 | 5.4 |
| `rust/crates/api/src/providers/anthropic.rs` | `AuthSource`、指数退避 | 5.5 |
| `rust/crates/api/src/prompt_cache.rs` | 本地缓存、指纹、统计 | 5.6 |
| `rust/crates/api/src/http_client.rs` | 超时、代理配置 | 5.7 |

下一章将分析 Turn Loop 与对话引擎——`ConversationRuntime` 如何循环调用模型和工具，`run_turn` 如何组装请求和解析 SSE 流，以及 `build_assistant_message` 如何从流式事件构建助手消息。
