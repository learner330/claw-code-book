# 第15章 配置层：Rules、Commands、MCP 与 Skills

claw-code 的配置不只是 `settings.json`。第4章分析了三层配置合并机制，本章聚焦配置层承载的四类功能：Rules（知识注入）、Commands（工作流固化）、MCP（外部工具扩展）、Skills（领域封装）。这四类配置共同决定了 Agent 的行为边界和能力范围。

## 15.1 Rules：外部框架规则导入

`RuntimeFeatureConfig` 中有一个 `RulesImportConfig` 字段，控制是否导入外部 AI 编码框架的规则文件：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub struct RuntimeFeatureConfig {
    hooks: RuntimeHookConfig,
    plugins: RuntimePluginConfig,
    mcp: McpConfigCollection,
    oauth: Option<OAuthConfig>,
    model: Option<String>,
    aliases: BTreeMap<String, String>,
    permission_mode: Option<ResolvedPermissionMode>,
    rules_import: RulesImportConfig,
    provider: RuntimeProviderConfig,
    // ...
}
```

`RulesImportConfig` 是一个枚举，定义了三种导入策略：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub enum RulesImportConfig {
    /// 自动检测并导入所有支持的框架规则
    #[default]
    Auto,
    /// 不导入外部框架规则，只使用 Claw 自己的指令文件
    None,
    /// 只导入指定框架的规则
    Selected(BTreeSet<String>),
}
```

`Auto` 模式下，系统会扫描项目目录中的 `.cursorrules`、`.copilotinstructions` 等文件，自动导入到 System Prompt 中。`None` 模式完全关闭外部规则导入。`Selected` 模式允许指定框架列表。

配置在 `settings.json` 中的写法：

```json
{
  "rulesImport": "auto"
}
```

或指定框架：

```json
{
  "rulesImport": ["cursor", "copilot"]
}
```

`parse_optional_rules_import` 函数负责解析这个配置项，支持字符串和数组两种格式：

```rust
// claw-code/rust/crates/runtime/src/config.rs

fn parse_optional_rules_import(root: &JsonValue) -> Result<RulesImportConfig, ConfigError> {
    let Some(object) = root.as_object() else {
        return Ok(RulesImportConfig::default());
    };
    let Some(value) = object.get("rulesImport") else {
        return Ok(RulesImportConfig::default());
    };

    match value {
        JsonValue::String(value) if value.eq_ignore_ascii_case("auto") => Ok(RulesImportConfig::Auto),
        JsonValue::String(value) if value.eq_ignore_ascii_case("none") => Ok(RulesImportConfig::None),
        JsonValue::Array(items) => {
            let mut frameworks = BTreeSet::new();
            for item in items {
                let Some(name) = item.as_str() else {
                    return Err(ConfigError::Parse(
                        "rulesImport array entries must be strings".to_string(),
                    ));
                };
                frameworks.insert(name.to_lowercase());
            }
            Ok(RulesImportConfig::Selected(frameworks))
        }
        // ...
    }
}
```

`should_import` 方法用于运行时判断某个框架的规则是否应该被导入：

```rust
// claw-code/rust/crates/runtime/src/config.rs

impl RulesImportConfig {
    pub fn should_import(&self, framework: &str) -> bool {
        match self {
            Self::Auto => true,
            Self::None => false,
            Self::Selected(set) => set.contains(framework),
        }
    }
}
```

这套机制使得 claw-code 能兼容 Cursor、Copilot 等其他 AI 编码工具的规则文件。用户不需要为不同工具维护多份规则，一个 `.cursorrules` 文件在 claw-code 中同样生效。

## 15.2 Commands：斜杠命令系统

Python 版的命令系统在 `commands.py` 中实现，核心是 `CommandExecution` 数据类：

```python
# claw-code/src/commands.py

@dataclass(frozen=True)
class CommandExecution:
    name: str           # 命令名，如 "review"
    source_hint: str    # 来源提示，如 "built-in" 或文件路径
    prompt: str         # 命令展开后的完整 prompt
    handled: bool       # 是否被成功处理
    message: str        # 处理结果消息
```

命令定义存储在 JSON 快照文件中，启动时通过 `load_command_snapshot()` 加载：

```python
# claw-code/src/commands.py

SNAPSHOT_PATH = Path(__file__).resolve().parent / 'reference_data' / 'commands_snapshot.json'

@lru_cache(maxsize=1)
def load_command_snapshot() -> tuple[PortingModule, ...]:
    raw_entries = json.loads(SNAPSHOT_PATH.read_text())
    return tuple(
        PortingModule(
            name=entry['name'],
            responsibility=entry['responsibility'],
            source_hint=entry['source_hint'],
            status='mirrored',
        )
        for entry in raw_entries
    )
```

`lru_cache(maxsize=1)` 保证快照只加载一次，后续调用直接返回缓存结果。命令别名通过 `COMMAND_ALIASES` 字典定义：

```python
# claw-code/src/commands.py

COMMAND_ALIASES = {
    'plugins': 'plugin',
    'marketplace': 'plugin',
}
```

`get_command` 函数在查找前先做别名归一化：

```python
# claw-code/src/commands.py

def get_command(name: str) -> PortingModule | None:
    normalized = name.strip().lower()
    needle = COMMAND_ALIASES.get(normalized, normalized)
    for module in PORTED_COMMANDS:
        if module.name == needle:
            return module
    return None
```

命令的加载和查找是同步的、确定性的。与 MCP 工具不同，斜杠命令不涉及外部进程，展开后直接作为 prompt 注入到当前会话中。

在 claw-code 的项目结构中，自定义斜杠命令文件放在 `.catpaw/commands/` 目录下，每个 `.md` 文件就是一个命令。文件名即命令名，文件内容是命令展开后的 prompt 模板，`$ARGUMENTS` 占位符会被用户传入的参数替换。

## 15.3 MCP：外部工具的标准化协议

MCP（Model Context Protocol）是 claw-code 扩展外部工具能力的核心机制。Rust 版的实现在 `runtime/src/mcp_stdio.rs` 中，约 1400 行，是配置层中代码量最大的模块。

### 传输协议

`McpTransport` 枚举定义了六种传输协议：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub enum McpTransport {
    Stdio,          // 本地子进程，通过 stdin/stdout 通信
    Sse,            // Server-Sent Events
    Http,           // HTTP 请求
    Ws,             // WebSocket
    Sdk,            // 内嵌 SDK
    ManagedProxy,   // 托管代理
}
```

每种传输协议对应一个 `McpServerConfig` 变体：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub enum McpServerConfig {
    Stdio(McpStdioServerConfig),
    Sse(McpRemoteServerConfig),
    Http(McpRemoteServerConfig),
    Ws(McpWebSocketServerConfig),
    Sdk(McpSdkServerConfig),
    ManagedProxy(McpManagedProxyServerConfig),
}
```

`McpStdioServerConfig` 是最常用的配置，定义本地子进程的启动参数：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub struct McpStdioServerConfig {
    pub command: String,                        // 可执行文件路径
    pub args: Vec<String>,                      // 命令行参数
    pub env: BTreeMap<String, String>,          // 环境变量
    pub tool_call_timeout_ms: Option<u64>,      // 工具调用超时
}
```

`ScopedMcpServerConfig` 在配置外包裹了 `required` 和 `scope` 两个字段：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub struct ScopedMcpServerConfig {
    pub required: bool,              // 是否必需（失败时是否阻断启动）
    pub scope: ConfigSource,         // 配置来源（User/Project/Local）
    pub config: McpServerConfig,     // 实际配置
}
```

`required` 为 `true` 的 MCP 服务器如果启动失败，整个 Agent 启动会被阻断。`required` 为 `false` 的服务器失败时，Agent 会降级运行，只是该服务器的工具不可用。

### JSON-RPC 通信

MCP 协议基于 JSON-RPC 2.0。`mcp_stdio.rs` 定义了完整的请求/响应结构：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

pub enum JsonRpcId {
    Number(u64),
    String(String),
    Null,
}

pub struct JsonRpcRequest<T = JsonValue> {
    pub jsonrpc: String,              // 固定 "2.0"
    pub id: JsonRpcId,                // 请求 ID，用于匹配响应
    pub method: String,               // 方法名，如 "initialize"、"tools/list"
    pub params: Option<T>,            // 参数
}

pub struct JsonRpcResponse<T = JsonValue> {
    pub jsonrpc: String,
    pub id: JsonRpcId,
    pub result: Option<T>,            // 成功时的结果
    pub error: Option<JsonRpcError>,  // 失败时的错误
}
```

MCP 客户端通过以下 JSON-RPC 方法与服务器交互：

| 方法 | 作用 | 对应 Rust 函数 |
| --- | --- | --- |
| `initialize` | 握手，交换协议版本和能力 | `McpClient::initialize()` |
| `tools/list` | 列出服务器提供的所有工具 | `McpClient::list_tools()` |
| `tools/call` | 调用指定工具 | `McpClient::call_tool()` |
| `resources/list` | 列出服务器提供的资源 | `McpClient::list_resources()` |
| `resources/read` | 读取指定资源 | `McpClient::read_resource()` |
| `terminate` | 终止子进程 | `McpClient::terminate()` |

### McpServerManager：工具发现与路由

`McpServerManager` 是 MCP 子系统的核心，管理所有 MCP 服务器进程和工具索引：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

pub struct McpServerManager {
    servers: BTreeMap<String, ManagedMcpServer>,          // 服务器进程
    unsupported_servers: Vec<UnsupportedMcpServer>,        // 不支持的服务器
    tool_index: BTreeMap<String, ToolRoute>,               // 工具名 → 路由
    next_request_id: u64,                                   // JSON-RPC ID 生成器
}
```

`from_servers` 在构造时区分支持的（Stdio）和不支持的传输协议：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

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
                reason: format!(
                    "transport {:?} is not supported by McpServerManager",
                    server_config.transport()
                ),
            });
        }
    }
    // ...
}
```

`discover_tools` 遍历所有服务器，调用 `tools/list` 获取工具列表，建立工具名到服务器的路由索引：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

pub async fn discover_tools(&mut self) -> Result<Vec<ManagedMcpTool>, McpServerManagerError> {
    let server_names = self.servers.keys().cloned().collect::<Vec<_>>();
    let mut discovered_tools = Vec::new();

    for server_name in server_names {
        let server_tools = self.discover_tools_for_server(&server_name).await?;
        self.clear_routes_for_server(&server_name);

        for tool in server_tools {
            self.tool_index.insert(
                tool.qualified_name.clone(),
                ToolRoute {
                    server_name: tool.server_name.clone(),
                    raw_name: tool.raw_name.clone(),
                },
            );
            discovered_tools.push(tool);
        }
    }
    Ok(discovered_tools)
}
```

`discover_tools_best_effort` 是容错版本，单个服务器失败不会中断整体发现：

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
                // 注册工具路由...
            }
            Err(error) => {
                self.clear_routes_for_server(&server_name);
                let required = self.servers
                    .get(&server_name)
                    .is_some_and(|server| server.required);
                failed_servers.push(error.discovery_failure(&server_name, required));
            }
        }
    }
    // ...
}
```

工具调用通过 `call_tool` 方法路由到正确的服务器：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

pub async fn call_tool(
    &mut self,
    qualified_tool_name: &str,
    arguments: Option<JsonValue>,
) -> Result<JsonRpcResponse<McpToolCallResult>, McpServerManagerError> {
    let route = self.tool_index
        .get(qualified_tool_name)
        .cloned()
        .ok_or_else(|| McpServerManagerError::UnknownTool {
            qualified_name: qualified_tool_name.to_string(),
        })?;

    let timeout_ms = self.tool_call_timeout_ms(&route.server_name)?;
    self.ensure_server_ready(&route.server_name).await?;

    // 发送 tools/call JSON-RPC 请求到对应服务器
    let request_id = self.take_request_id();
    // ...
}
```

MCP 工具名采用 `服务器名__工具名` 的格式（`qualified_name`），避免不同服务器的同名工具冲突。`ManagedMcpTool` 保存了这个限定名：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

pub struct ManagedMcpTool {
    pub server_name: String,       // 所属服务器
    pub qualified_name: String,    // 限定名（server__tool）
    pub raw_name: String,          // 原始工具名
    pub tool: McpTool,             // 工具定义
}
```

超时控制通过编译时常量区分测试和生产环境：

```rust
// claw-code/rust/crates/runtime/src/mcp_stdio.rs

#[cfg(test)]
const MCP_INITIALIZE_TIMEOUT_MS: u64 = 200;
#[cfg(not(test))]
const MCP_INITIALIZE_TIMEOUT_MS: u64 = 10_000;

#[cfg(test)]
const MCP_LIST_TOOLS_TIMEOUT_MS: u64 = 300;
#[cfg(not(test))]
const MCP_LIST_TOOLS_TIMEOUT_MS: u64 = 30_000;
```

测试环境的超时是生产环境的 1/50，保证测试快速失败。

```mermaid
graph TD
    A[ConfigLoader] -->|加载 settings.json| B[RuntimeConfig]
    B -->|mcp\(\)| C[McpConfigCollection]
    C --> D[McpServerManager]
    D --> E{discover_tools}
    E -->|Server 1: stdio| F[spawn child process]
    E -->|Server 2: sse| G[unsupported]
    F -->|tools/list| H[tool_index]
    H -->|call_tool| I[tools/call → Server 1]
    I -->|result| J[ToolResult]
```

## 15.4 Skills：领域封装

Python 版的 `skills/__init__.py` 目前是归档占位模块，实际功能在 Rust 版和宿主环境（如 CatPaw）中承载。

```python
# claw-code/src/skills/__init__.py

from src._archive_helper import load_archive_metadata

_SNAPSHOT = load_archive_metadata("skills")
ARCHIVE_NAME = _SNAPSHOT["archive_name"]
MODULE_COUNT = _SNAPSHOT["module_count"]
SAMPLE_FILES = tuple(_SNAPSHOT["sample_files"])
PORTING_NOTE = f"Python placeholder package for '{ARCHIVE_NAME}' with {MODULE_COUNT} archived module references."
```

Skills 的设计理念是把"如何做某类任务"的知识和工作流封装成可分发的包。一个 Skill 包含：

frontmatter 元数据（YAML 格式），声明 Skill 的名称、描述、触发条件。宿主环境根据这些元数据决定何时激活该 Skill。

Skill 主体（Markdown 格式），包含执行步骤、代码模板、注意事项。激活后作为系统提示词的一部分注入到当前会话。

Skills 与 Commands 的区别在于触发方式：Commands 是用户显式输入 `/command` 触发，Skills 是宿主环境根据用户意图自动匹配触发。Skills 与 MCP 的区别在于：MCP 扩展的是工具能力（让 Agent 能执行新操作），Skills 扩展的是知识（让 Agent 知道如何执行某类任务）。

## 设计对比

| claw-code 配置层 | Java 生态对应 |
| --- | --- |
| `RulesImportConfig` | Spring Boot 的 `@Profile` 条件装配 |
| `CommandExecution` prompt 展开 | Spring MVC 的 `@RequestMapping` 路由到 Controller 方法 |
| `McpServerManager` 工具发现 | Spring Cloud 的服务发现（Eureka/Nacos） |
| `tool_index` 路由表 | Spring 的 `BeanFactory` 名称索引 |
| `discover_tools_best_effort` 容错 | Spring Cloud 的熔断降级（Hystrix/Resilience4j） |
| `ScopedMcpServerConfig.required` | Spring Boot 的 `@ConditionalOnBean` |
| Skills 自动触发 | Spring AOP 的切点匹配 |

MCP 的 `McpServerManager` 和 Spring Cloud 的服务发现机制在结构上相似：启动时注册服务（服务器进程），建立名称到实例的路由表（`tool_index`），调用时按名称路由到正确的实例。区别在于 Spring Cloud 的服务实例是远程的、通过网络通信，而 MCP Stdio 服务器是本地子进程，通过 stdin/stdout 通信。

`discover_tools_best_effort` 的容错策略——区分 `required` 和非 `required` 服务器，前者失败阻断启动，后者降级运行——与 Hystrix 的熔断降级理念一致。

## 小结

claw-code 的配置层包含四个支柱。Rules 通过 `RulesImportConfig` 控制外部框架规则文件的导入策略，支持 Auto/None/Selected 三种模式。Commands 通过 `commands.py` 的快照加载和别名机制提供斜杠命令，展开后作为 prompt 注入会话。MCP 通过 `mcp_stdio.rs` 的 `McpServerManager` 管理外部工具服务器，基于 JSON-RPC 2.0 协议通信，支持工具发现、路由和容错降级。Skills 在 Python 版中是归档占位，实际功能由宿主环境承载，通过 frontmatter 元数据自动触发。
