# 第7章 MCP 协议与插件扩展：McpToolRegistry 与 Lifecycle

## 本章概览

本章分析 claw-code 的 MCP（Model Context Protocol）支持与插件扩展系统。对应 `runtime::mcp_tool_bridge`、`runtime::mcp_stdio`、`runtime::mcp_client` 和 `plugins` crate。

MCP 协议解决的核心问题是：Agent 需要与外部工具和数据源交互（如数据库、文件系统、API），但每个外部系统有不同的接口。MCP 是 Anthropic 推出的标准协议，通过 JSON-RPC 2.0 通信，统一了工具发现、资源读取和调用接口。claw-code 实现了 MCP 客户端，支持 stdio 和远程传输，以及插件系统用于扩展 Agent 能力。

| 关键文件 | 职责 |
| --- | --- |
| `rust/crates/runtime/src/mcp_tool_bridge.rs` | `McpToolRegistry` 桥接工具系统与 MCP 服务器 |
| `rust/crates/runtime/src/mcp_stdio.rs` | `McpServerManager` 生命周期管理、JSON-RPC 通信 |
| `rust/crates/runtime/src/mcp_client.rs` | 传输层抽象（stdio、SSE、HTTP、WebSocket） |
| `rust/crates/plugins/src/lib.rs` | 插件元数据、插件钩子、加载机制 |

## 7.1 MCP 协议基础：JSON-RPC 2.0

MCP 基于 JSON-RPC 2.0 协议。`mcp_stdio.rs` 定义了基本的消息结构：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

pub struct JsonRpcRequest<T = JsonValue> {
    pub jsonrpc: String,
    pub id: JsonRpcId,
    pub method: String,
    pub params: Option<T>,
}

pub enum JsonRpcId {
    Number(u64),
    String(String),
    Null,
}

pub struct JsonRpcResponse<T = JsonValue> {
    pub jsonrpc: String,
    pub id: JsonRpcId,
    pub result: Option<T>,
    pub error: Option<JsonRpcError>,
}

pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<JsonValue>,
}
```

`jsonrpc` 固定为 `"2.0"`。`id` 用于匹配请求和响应——可以是数字、字符串或 `Null`（通知）。`method` 是 RPC 方法名。`params` 是参数（可选）。`result` 和 `error` 互斥——成功时有 `result`，失败时有 `error`。

MCP 初始化握手：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

pub struct McpInitializeParams {
    pub protocol_version: String,
    pub capabilities: JsonValue,
    pub client_info: McpInitializeClientInfo,
}

pub struct McpInitializeClientInfo {
    pub name: String,
    pub version: String,
}

pub struct McpInitializeResult {
    pub protocol_version: String,
    pub capabilities: JsonValue,
    pub server_info: McpInitializeServerInfo,
}
```

客户端发送 `initialize` 方法，携带协议版本、能力集和客户端信息。服务器返回 `initialize` 结果，包含服务器信息。握手完成后客户端发送 `initialized` 通知。

工具发现：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

pub struct McpListToolsResult {
    pub tools: Vec<McpTool>,
    pub next_cursor: Option<String>,
}

pub struct McpTool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<JsonValue>,
    pub annotations: Option<JsonValue>,
    pub meta: Option<JsonValue>,
}
```

`tools/list` 方法返回服务器暴露的工具列表。`next_cursor` 支持分页——如果工具太多，可以分多次请求。

工具调用：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

pub struct McpToolCallParams {
    pub name: String,
    pub arguments: Option<JsonValue>,
    pub meta: Option<JsonValue>,
}

pub struct McpToolCallResult {
    pub content: Vec<McpToolCallContent>,
    pub structured_content: Option<JsonValue>,
    pub is_error: Option<bool>,
    pub meta: Option<JsonValue>,
}

pub struct McpToolCallContent {
    pub kind: String,
    pub data: BTreeMap<String, JsonValue>,
}
```

`tools/call` 方法调用指定工具，`arguments` 是 JSON 参数对象。`content` 是结果内容列表，每个内容块有 `type`（如 `"text"`、`"image"`）和 `data`（扁平化的字段）。

资源读写：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

pub struct McpListResourcesResult {
    pub resources: Vec<McpResource>,
    pub next_cursor: Option<String>,
}

pub struct McpResource {
    pub uri: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub mime_type: Option<String>,
    pub annotations: Option<JsonValue>,
    pub meta: Option<JsonValue>,
}

pub struct McpReadResourceResult {
    pub contents: Vec<McpResourceContents>,
}

pub struct McpResourceContents {
    pub uri: String,
    pub mime_type: Option<String>,
    pub text: Option<String>,
    pub blob: Option<String>,
    pub meta: Option<JsonValue>,
}
```

`resources/list` 返回资源列表，`resources/read` 读取资源内容。资源用 URI 标识，支持文本（`text`）和二进制（`blob`）两种格式。

## 7.2 McpClientTransport：传输层抽象

`mcp_client.rs` 抽象了多种传输方式：

```rust
// claw-code/rust/crates/runtime/src/mcp_client.rs

pub enum McpClientTransport {
    Stdio(McpStdioTransport),
    Sse(McpRemoteTransport),
    Http(McpRemoteTransport),
    WebSocket(McpRemoteTransport),
    Sdk(McpSdkTransport),
    ManagedProxy(McpManagedProxyTransport),
}

pub struct McpStdioTransport {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub tool_call_timeout_ms: Option<u64>,
}

pub struct McpRemoteTransport {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub headers_helper: Option<String>,
    pub auth: McpClientAuth,
}

pub struct McpSdkTransport {
    pub name: String,
}

pub struct McpManagedProxyTransport {
    pub url: String,
    pub id: String,
}

pub enum McpClientAuth {
    None,
    OAuth(McpOAuthConfig),
}
```

`Stdio` 通过子进程 stdio 通信——启动命令行工具，通过 stdin/stdout 交换 JSON-RPC 消息。`Sse` 和 `Http` 通过 HTTP 远程通信。`WebSocket` 通过 WebSocket 通信。`Sdk` 通过内置 SDK 直接调用。`ManagedProxy` 通过托管代理通信。

`McpClientBootstrap` 从配置构建：

```rust
// claw-code/rust/crates/runtime/src/mcp_client.rs

pub struct McpClientBootstrap {
    pub server_name: String,
    pub normalized_name: String,
    pub tool_prefix: String,
    pub signature: Option<String>,
    pub transport: McpClientTransport,
}

impl McpClientBootstrap {
    pub fn from_scoped_config(server_name: &str, config: &ScopedMcpServerConfig) -> Self {
        Self {
            server_name: server_name.to_string(),
            normalized_name: normalize_name_for_mcp(server_name),
            tool_prefix: mcp_tool_prefix(server_name),
            signature: mcp_server_signature(&config.config),
            transport: McpClientTransport::from_config(&config.config),
        }
    }
}
```

`from_scoped_config` 从配置构建 bootstrap 信息。`normalized_name` 是规范化后的服务器名（用于工具名前缀）。`tool_prefix` 是工具名的前缀（如 `mcp_server_name__`）。`signature` 是服务器签名（用于验证）。

`McpClientTransport::from_config` 根据配置类型选择传输方式：

```rust
// claw-code/rust/crates/runtime/src/mcp_client.rs

impl McpClientTransport {
    pub fn from_config(config: &McpServerConfig) -> Self {
        match config {
            McpServerConfig::Stdio(config) => Self::Stdio(McpStdioTransport {
                command: config.command.clone(),
                args: config.args.clone(),
                env: config.env.clone(),
                tool_call_timeout_ms: config.tool_call_timeout_ms,
            }),
            McpServerConfig::Sse(config) => Self::Sse(McpRemoteTransport {
                url: config.url.clone(),
                headers: config.headers.clone(),
                headers_helper: config.headers_helper.clone(),
                auth: McpClientAuth::from_oauth(config.oauth.clone()),
            }),
            McpServerConfig::Http(config) => Self::Http(...),
            McpServerConfig::Ws(config) => Self::WebSocket(...),
            McpServerConfig::Sdk(config) => Self::Sdk(...),
            McpServerConfig::ManagedProxy(config) => Self::ManagedProxy(...),
        }
    }
}
```

`match` 穷举所有配置类型——编译器保证每个 `McpServerConfig` 变体都有处理分支。`clone()` 深拷贝数据——配置值在构建后不再需要，但传输层需要独立持有。

## 7.3 McpServerManager：生命周期管理

`McpServerManager` 管理 MCP 服务器的完整生命周期：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

pub struct McpServerManager {
    servers: BTreeMap<String, ManagedMcpServer>,
    unsupported_servers: Vec<UnsupportedMcpServer>,
    tool_index: BTreeMap<String, ToolRoute>,
    next_request_id: u64,
}

struct ManagedMcpServer {
    bootstrap: McpClientBootstrap,
    process: Option<McpStdioProcess>,
    initialized: bool,
    required: bool,
}

struct ToolRoute {
    server_name: String,
    raw_name: String,
}
```

`servers` 是管理的 MCP 服务器映射。`unsupported_servers` 记录不支持的传输类型。`tool_index` 是工具名到服务器路由的映射——`qualified_name`（`mcp_server_name__tool_name`）映射到 `ToolRoute`（服务器名 + 原始工具名）。`next_request_id` 生成递增的请求 ID。

初始化从运行时配置构建：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

impl McpServerManager {
    pub fn from_runtime_config(config: &RuntimeConfig) -> Self {
        Self::from_servers(config.mcp().servers())
    }

    pub fn from_servers(servers: &BTreeMap<String, ScopedMcpServerConfig>) -> Self {
        let mut managed_servers = BTreeMap::new();
        let mut unsupported_servers = Vec::new();

        for (server_name, server_config) in servers {
            if server_config.transport() == McpTransport::Stdio {
                let bootstrap = McpClientBootstrap::from_scoped_config(server_name, server_config);
                managed_servers.insert(
                    server_name.clone(),
                    ManagedMcpServer::new(bootstrap, server_config.required),
                );
            } else {
                unsupported_servers.push(UnsupportedMcpServer {
                    server_name: server_name.clone(),
                    transport: server_config.transport(),
                    required: server_config.required,
                    reason: format!("transport {:?} is not supported by McpServerManager", server_config.transport()),
                });
            }
        }

        Self { servers: managed_servers, unsupported_servers, tool_index: BTreeMap::new(), next_request_id: 1 }
    }
```

当前 `McpServerManager` 只支持 `Stdio` 传输——其他传输类型被标记为 `unsupported_servers`。`required` 标志控制服务器是否为必需——必需服务器启动失败会阻止 Agent 启动，非必需服务器失败只记录错误。

工具发现（最佳努力）：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

    pub async fn discover_tools_best_effort(&mut self) -> McpToolDiscoveryReport {
        let server_names = self.server_names();
        let mut discovered_tools = Vec::new();
        let mut working_servers = Vec::new();
        let mut failed_servers = Vec::new();

        for server_name in server_names {
            match self.discover_tools_for_server(&server_name).await {
                Ok(server_tools) => {
                    working_servers.push(server_name.clone());
                    self.clear_routes_for_server(&server_name);
                    for tool in server_tools {
                        self.tool_index.insert(
                            tool.qualified_name.clone(),
                            ToolRoute { server_name: tool.server_name.clone(), raw_name: tool.raw_name.clone() },
                        );
                        discovered_tools.push(tool);
                    }
                }
                Err(error) => {
                    self.clear_routes_for_server(&server_name);
                    let required = self.servers.get(&server_name).is_some_and(|server| server.required);
                    failed_servers.push(error.discovery_failure(&server_name, required));
                }
            }
        }
        // ... degraded startup report
    }
```

`discover_tools_best_effort` 遍历所有服务器，尝试发现工具。成功时把工具路由加入 `tool_index`，失败时记录错误。`clear_routes_for_server` 清除旧路由——防止重新发现时路由冲突。`required` 标志决定失败是否阻止启动。返回 `McpToolDiscoveryReport` 包含成功工具、失败服务器和降级启动报告。

工具调用：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

    pub async fn call_tool(
        &mut self, qualified_tool_name: &str, arguments: Option<JsonValue>,
    ) -> Result<JsonRpcResponse<McpToolCallResult>, McpServerManagerError> {
        let route = self.tool_index.get(qualified_tool_name).cloned()
            .ok_or_else(|| McpServerManagerError::UnknownTool { qualified_name: qualified_tool_name.to_string() })?;

        let timeout_ms = self.tool_call_timeout_ms(&route.server_name)?;
        self.ensure_server_ready(&route.server_name).await?;
        let request_id = self.take_request_id();
        let response = {
            let server = self.server_mut(&route.server_name)?;
            let process = server.process.as_mut().ok_or_else(|| ...)?;
            Self::run_process_request(
                &route.server_name, "tools/call", timeout_ms,
                process.call_tool(request_id, McpToolCallParams { name: route.raw_name, arguments, meta: None }),
            ).await
        };

        if let Err(error) = &response {
            if Self::should_reset_server(error) {
                self.reset_server(&route.server_name).await?;
            }
        }
        response
    }
```

调用流程：查找路由 → 确保服务器就绪 → 生成请求 ID → 通过进程调用工具 → 错误时重置服务器。`ensure_server_ready` 检查服务器是否已初始化，如果没有则启动并握手。`run_process_request` 发送 JSON-RPC 请求并等待响应。`should_reset_server` 判断错误是否需要重置服务器（如连接断开、超时）。

重试机制：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

    pub async fn list_resources(&mut self, server_name: &str) -> Result<McpListResourcesResult, McpServerManagerError> {
        let mut attempts = 0;
        loop {
            match self.list_resources_once(server_name).await {
                Ok(resources) => return Ok(resources),
                Err(error) if attempts == 0 && Self::is_retryable_error(&error) => {
                    self.reset_server(server_name).await?;
                    attempts += 1;
                }
                Err(error) => {
                    if Self::should_reset_server(&error) {
                        self.reset_server(server_name).await?;
                    }
                    return Err(error);
                }
            }
        }
    }
```

`list_resources` 和 `read_resource` 实现了单次重试——第一次失败如果是可重试错误（如连接超时），重置服务器后重试一次。第二次失败直接返回错误。这个设计平衡了可靠性（大多数临时错误可以恢复）和响应时间（避免无限重试）。

错误分类：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

impl McpServerManagerError {
    fn lifecycle_phase(&self) -> McpLifecyclePhase {
        match self {
            Self::Io(_) => McpLifecyclePhase::SpawnConnect,
            Self::Transport { method, .. } | Self::JsonRpc { method, .. }
                | Self::InvalidResponse { method, .. } | Self::Timeout { method, .. } => {
                lifecycle_phase_for_method(method)
            }
            Self::UnknownTool { .. } => McpLifecyclePhase::ToolDiscovery,
            Self::UnknownServer { .. } => McpLifecyclePhase::ServerRegistration,
        }
    }

    fn recoverable(&self) -> bool {
        !matches!(self.lifecycle_phase(), McpLifecyclePhase::InitializeHandshake)
            && matches!(self, Self::Transport { .. } | Self::Timeout { .. })
    }
}

fn lifecycle_phase_for_method(method: &str) -> McpLifecyclePhase {
    match method {
        "initialize" => McpLifecyclePhase::InitializeHandshake,
        "tools/list" => McpLifecyclePhase::ToolDiscovery,
        "resources/list" => McpLifecyclePhase::ResourceDiscovery,
        "resources/read" | "tools/call" => McpLifecyclePhase::Invocation,
        _ => McpLifecyclePhase::ErrorSurfacing,
    }
}
```

错误按生命周期阶段分类：`SpawnConnect`、`InitializeHandshake`、`ToolDiscovery`、`ResourceDiscovery`、`Invocation`、`ErrorSurfacing`。`recoverable` 判断错误是否可恢复——初始化握手失败不可恢复（服务器根本不支持 MCP），传输错误和超时在初始化后可恢复（可能网络抖动）。

## 7.4 McpToolRegistry：桥接工具系统

`McpToolRegistry` 是 MCP 服务器状态的外部接口，供工具系统查询：

```rust
// claw-code/rust/crates/runtime/src/mcp_tool_bridge.rs

pub struct McpToolRegistry {
    inner: Arc<Mutex<HashMap<String, McpServerState>>>,
    manager: Arc<OnceLock<Arc<Mutex<McpServerManager>>>>,
}

pub struct McpServerState {
    pub server_name: String,
    pub status: McpConnectionStatus,
    pub tools: Vec<McpToolInfo>,
    pub resources: Vec<McpResourceInfo>,
    pub server_info: Option<String>,
    pub error_message: Option<String>,
}

pub enum McpConnectionStatus {
    Disconnected, Connecting, Connected, AuthRequired, Error,
}
```

`inner` 存储服务器状态——`HashMap` 从服务器名到状态。`manager` 是 `OnceLock` 包装的 `McpServerManager`——懒初始化，只设置一次。`McpServerState` 是只读快照，供工具查询。

`set_manager` 设置内部管理器：

```rust
// claw-code/rust/crates/runtime/src/mcp_tool_bridge.rs

    pub fn set_manager(&self, manager: Arc<Mutex<McpServerManager>>) -> Result<(), Arc<Mutex<McpServerManager>>> {
        self.manager.set(manager)
    }
```

`OnceLock::set` 只成功一次——第二次调用返回 `Err` 携带旧值。这个设计防止 `McpToolRegistry` 被重复配置。

`register_server` 注册服务器状态：

```rust
// claw-code/rust/crates/runtime/src/mcp_tool_bridge.rs

    pub fn register_server(
        &self, server_name: &str, status: McpConnectionStatus,
        tools: Vec<McpToolInfo>, resources: Vec<McpResourceInfo>, server_info: Option<String>,
    ) {
        let mut inner = self.inner.lock().expect("mcp registry lock poisoned");
        inner.insert(server_name.to_owned(), McpServerState {
            server_name: server_name.to_owned(), status, tools, resources, server_info, error_message: None,
        });
    }
```

`register_server` 在发现工具后调用，把服务器状态存入注册表。`McpServerManager` 在 `discover_tools` 后调用此方法更新状态。

`call_tool` 代理到管理器：

```rust
// claw-code/rust/crates/runtime/src/mcp_tool_bridge.rs

    pub fn call_tool(&self, server_name: &str, tool_name: &str, arguments: &serde_json::Value) -> Result<serde_json::Value, String> {
        let inner = self.inner.lock().expect("mcp registry lock poisoned");
        let state = inner.get(server_name).ok_or_else(|| format!("server '{}' not found", server_name))?;
        if state.status != McpConnectionStatus::Connected {
            return Err(format!("server '{}' is not connected (status: {})", server_name, state.status));
        }
        if !state.tools.iter().any(|t| t.name == tool_name) {
            return Err(format!("tool '{}' not found on server '{}'", tool_name, server_name));
        }
        drop(inner);

        let manager = self.manager.get().cloned()
            .ok_or_else(|| "MCP server manager is not configured".to_string())?;
        Self::spawn_tool_call(manager, mcp_tool_name(server_name, tool_name), (!arguments.is_null()).then(|| arguments.clone()))
    }
```

先检查状态（连接状态、工具存在），然后 `drop(inner)` 释放锁，避免持有锁时调用管理器（可能阻塞）。`spawn_tool_call` 在新线程中创建 tokio 运行时并执行异步调用：

```rust
// claw-code/rust/crates/runtime/src/mcp_tool_bridge.rs

    fn spawn_tool_call(
        manager: Arc<Mutex<McpServerManager>>, qualified_tool_name: String, arguments: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let join_handle = std::thread::Builder::new()
            .name(format!("mcp-tool-call-{qualified_tool_name}"))
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all().build()
                    .map_err(|error| format!("failed to create MCP tool runtime: {error}"))?;
                runtime.block_on(async move {
                    let mut manager = manager.lock().map_err(|_| "mcp server manager lock poisoned".to_string())?;
                    manager.discover_tools().await.map_err(|error| error.to_string())?;
                    let response = manager.call_tool(&qualified_tool_name, arguments).await.map_err(|error| error.to_string())?;
                    let shutdown = manager.shutdown().await.map_err(|error| error.to_string())?;
                    match (response, shutdown) {
                        (Ok(response), Ok(())) => Ok(response),
                        (Err(error), Ok(())) | (Err(error), Err(_)) => Err(error),
                        (Ok(_), Err(error)) => Err(error),
                    }
                })
            })
            .map_err(|error| format!("failed to spawn MCP tool call thread: {error}"))?;

        join_handle.join().map_err(|panic_payload| {
            if let Some(message) = panic_payload.downcast_ref::<&str>() {
                format!("MCP tool call thread panicked: {message}")
            } else if let Some(message) = panic_payload.downcast_ref::<String>() {
                format!("MCP tool call thread panicked: {message}")
            } else {
                "MCP tool call thread panicked".to_string()
            }
        })?
    }
```

`spawn_tool_call` 在新线程中运行 tokio 异步运行时——因为 `McpServerManager` 的方法是 `async`，而工具调用来自同步的工具执行上下文。`new_current_thread()` 创建单线程运行时，适合 IO 密集型 MCP 调用。`block_on` 阻塞直到异步完成。`join_handle.join()` 等待线程结束，处理 panic payload（`downcast_ref` 尝试转换为 `&str` 或 `String`）。

## 7.5 插件系统：PluginMetadata 与 PluginHooks

`plugins` crate 定义了插件的元数据和钩子：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

pub enum PluginKind {
    Builtin,
    Bundled,
    External,
}

pub struct PluginMetadata {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub kind: PluginKind,
    pub source: String,
    pub default_enabled: bool,
    pub root: Option<PathBuf>,
}

pub struct PluginHooks {
    pub pre_tool_use: Vec<String>,
    pub post_tool_use: Vec<String>,
    pub post_tool_use_failure: Vec<String>,
}
```

`PluginKind` 区分三种来源：`Builtin` 内置插件（编译进二进制）、`Bundled` 捆绑插件（随安装包分发）、`External` 外部插件（从市场安装）。`PluginMetadata` 包含插件的基本信息。`PluginHooks` 定义插件提供的钩子命令——与第10章的Hooks系统对应，`PluginHooks` 的数据被合并到 `RuntimeHookConfig` 中。

`PluginHooks` 的合并：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

impl PluginHooks {
    pub fn merged_with(&self, other: &Self) -> Self {
        let mut merged = self.clone();
        merged.pre_tool_use.extend(other.pre_tool_use.iter().cloned());
        merged.post_tool_use.extend(other.post_tool_use.iter().cloned());
        merged.post_tool_use_failure.extend(other.post_tool_use_failure.iter().cloned());
        merged
    }
}
```

`merged_with` 合并两个插件的钩子列表，简单追加。多个插件因此可以注册同一阶段的钩子，按顺序执行。与第10章的 `HookRunner` 对应——`HookRunner` 按 `commands` 列表顺序执行，插件钩子被追加到列表末尾。

## 7.6 降级启动与韧性

MCP 系统实现了降级启动——部分服务器失败时 Agent 仍然可用：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

pub struct McpDegradedReport {
    pub working_servers: Vec<String>,
    pub failed_servers: Vec<McpFailedServer>,
    pub available_tools: Vec<String>,
    pub unavailable_tools: Vec<String>,
}

pub struct McpDiscoveryFailure {
    pub server_name: String,
    pub phase: McpLifecyclePhase,
    pub required: bool,
    pub error: String,
    pub recoverable: bool,
    pub context: BTreeMap<String, String>,
}
```

`McpDegradedReport` 在 `discover_tools_best_effort` 中生成。`working_servers` 是成功连接的服务器。`failed_servers` 是失败的服务器（包含错误阶段和是否可恢复）。`available_tools` 是可用的工具列表。`unavailable_tools` 是不可用的工具列表。

降级启动的条件：至少有一个服务器成功且至少有一个失败：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

        let degraded_startup = (!working_servers.is_empty() && !degraded_failed_servers.is_empty())
            .then(|| {
                McpDegradedReport::new(working_servers, degraded_failed_servers, available_tools, Vec::new())
            });
```

如果所有服务器都失败，则完全失败，不是降级启动。如果所有服务器都成功，是正常启动。`McpDegradedReport` 可以被上层（如 CLI 或任务编排层）消费，决定是否继续执行或通知用户。

## 小结

MCP 系统在 Rust 端以 `McpServerManager`（`mcp_stdio.rs`）管理 MCP 服务器的完整生命周期——`from_runtime_config` 从配置构建，`discover_tools_best_effort` 遍历服务器发现工具，`call_tool` 通过 `tool_index` 路由调用，`list_resources`/`read_resource` 支持单次重试。`McpClientTransport`（`mcp_client.rs`）抽象六种传输方式（stdio、SSE、HTTP、WebSocket、Sdk、ManagedProxy），`McpClientBootstrap` 从配置构建传输层。`McpToolRegistry`（`mcp_tool_bridge.rs`）是 MCP 状态的外部接口，`register_server` 注册状态，`call_tool` 在新线程创建 tokio 运行时执行异步 MCP 调用。

插件系统（`plugins/src/lib.rs`）定义 `PluginMetadata`（三种来源：Builtin、Bundled、External）和 `PluginHooks`（三阶段钩子列表），`merged_with` 追加合并多个插件的钩子。降级启动机制在部分 MCP 服务器失败时仍然允许 Agent 运行，生成 `McpDegradedReport` 记录成功和失败的服务器。

| 关键文件 | 核心机制 | 对应章节 |
| --- | --- | --- |
| `rust/crates/runtime/src/mcp_stdio.rs` | `McpServerManager`、JSON-RPC 2.0、生命周期、降级启动 | 7.1, 7.3, 7.6 |
| `rust/crates/runtime/src/mcp_client.rs` | `McpClientTransport` 六种传输方式、`McpClientBootstrap` | 7.2 |
| `rust/crates/runtime/src/mcp_tool_bridge.rs` | `McpToolRegistry` 状态注册、`spawn_tool_call` 线程隔离 | 7.4 |
| `rust/crates/plugins/src/lib.rs` | `PluginMetadata`、`PluginHooks`、合并策略 | 7.5 |

下一章将分析权限系统与操作边界——`PermissionMode` 如何分级控制文件访问、`PermissionEnforcer` 如何做读写判定、以及用户如何通过 `claw permission` 命令调整权限边界。
