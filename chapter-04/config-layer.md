# 第4章 配置系统：运行时契约与子系统集成

## 本章概览

配置层是运行时各子系统的集成契约，不是孤立的数据加载机制。`settings.json` 中的每个字段都对应一个子系统的行为边界——`permissions` 决定安全策略，`hooks` 定义干预点，`mcpServers` 声明外部能力，`plugins` 管理扩展生命周期。配置加载的三层合并机制（User → Project → Local）已在第3章分析。本章聚焦合并后的配置如何被解析为类型化的运行时视图，以及各子系统如何通过契约接口消费这些配置。

| 关键文件 | 职责 | 对应节 |
| --- | --- | --- |
| `rust/crates/runtime/src/config.rs` | `RuntimeFeatureConfig` 类型化视图、字段解析、访问器 | 4.1 |
| `rust/crates/runtime/src/config_validate.rs` | 配置校验：未知键检测、类型检查、弃用提示 | 4.2 |

## 4.1 配置契约：RuntimeFeatureConfig

`ConfigLoader` 把多来源的 JSON 合并为统一的 `BTreeMap<String, JsonValue>` 后，`RuntimeConfig` 通过 `RuntimeFeatureConfig` 把这个扁平映射解析为子系统专用的类型化配置视图：

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
    permission_rules: RuntimePermissionRuleConfig,
    sandbox: SandboxConfig,
    provider_fallbacks: ProviderFallbackConfig,
    trusted_roots: Vec<String>,
    api_timeout: ApiTimeoutConfig,
    rules_import: RulesImportConfig,
    provider: RuntimeProviderConfig,
}
```

每个字段对应一个子系统的配置消费点。`RuntimeConfig` 提供只读访问器，把内部结构暴露给子系统：

```rust
// claw-code/rust/crates/runtime/src/config.rs

impl RuntimeConfig {
    pub fn hooks(&self) -> &RuntimeHookConfig {
        &self.feature_config.hooks
    }
    pub fn plugins(&self) -> &RuntimePluginConfig {
        &self.feature_config.plugins
    }
    pub fn mcp(&self) -> &McpConfigCollection {
        &self.feature_config.mcp
    }
    pub fn permission_rules(&self) -> &RuntimePermissionRuleConfig {
        &self.feature_config.permission_rules
    }
    pub fn rules_import(&self) -> &RulesImportConfig {
        &self.feature_config.rules_import
    }
    pub fn provider(&self) -> &RuntimeProviderConfig {
        &self.feature_config.provider
    }
}
```

这种设计把"合并原始数据"和"子系统消费视图"解耦。`ConfigLoader` 只负责合并 JSON，`RuntimeFeatureConfig` 负责类型化解析，子系统只看到自己需要的配置结构。如果某个子系统的配置格式变化，只需要修改对应的解析函数和配置结构，不影响合并逻辑。

## 4.2 配置校验：config_validate.rs

配置校验在"合并原始数据"和"类型化解析"之间发生。`config_validate.rs` 在合并后的 JSON 上运行，检测三类问题：

- **未知键**：`settings.json` 中出现了不被任何子系统识别的字段，通常是拼写错误（如 `permision_mode`）。
- **类型错误**：字段值的类型与预期不符（如 `max_retries` 应该是数字但提供了字符串）。
- **已弃用字段**：曾经有效但当前版本不再支持的字段，提示用户迁移到新配置名。

校验结果分为 `errors`（阻止启动）和 `warnings`（允许启动但提示）。`errors` 表示配置已损坏到无法正确解析的程度，如必需的顶级字段缺失。`warnings` 表示配置可能不按用户预期工作，但不会导致系统崩溃。这个分层保证了无效配置不会进入 `RuntimeFeatureConfig` 的解析阶段，同时不会因为一个拼写错误就阻止整个工作流。

## 4.3 配置字段消费方速查

`RuntimeFeatureConfig` 的每个字段都有明确的消费方。下表列出所有字段、其配置来源、消费子系统、以及详细分析所在的章节：

| 字段 | 配置来源（`settings.json` 键） | 消费子系统 | 详细分析章节 |
| --- | --- | --- | --- |
| `hooks` | `hooks` | `HookRunner` | 第11章 |
| `plugins` | `plugins` | 插件生命周期管理器 | 第8章 |
| `mcp` | `mcpServers` | `McpServerManager` | 第8章 |
| `oauth` | `oauth` | `McpClientAuth` | 第8章 |
| `model` | `model` | `ProviderClient` 路由 | 第3章（溯源）、第5章（API） |
| `aliases` | `modelAliases` | 模型别名解析 | 第5章 |
| `permission_mode` | `permissionMode` | `PermissionEnforcer` | 第3章（溯源）、第9章（权限） |
| `permission_rules` | `permissions` | `PermissionPolicy` | 第9章 |
| `sandbox` | `sandbox` | 文件系统隔离（扩展内容） | — |
| `provider_fallbacks` | `providerFallbacks` | 多 provider 降级路由 | 第5章 |
| `trusted_roots` | `trustedRoots` | `TrustResolver` | 第9章 |
| `api_timeout` | `apiTimeout` | HTTP 客户端 | 第5章 |
| `rules_import` | `rulesImport` | `ProjectContext` / 系统提示词构建 | 第6章 |
| `provider` | `provider` | `ProviderClient` | 第5章 |

这个表格的价值在于定位——当读者想知道"某个配置项影响系统的哪个部分"时，不需要在源码中搜索，可以直接查表找到对应的章节。

`rules_import` 的 `RulesImportConfig` 控制是否导入外部 AI 编程框架的规则文件（Cursor、GitHub Copilot、Windsurf 等），有三种模式：`Auto` 自动检测导入、`None` 不导入、`List(Vec<String>)` 只导入指定框架。这是系统提示词构建的一部分（影响模型"知道什么"），详细实现分析在第6章的 `ProjectContext` 部分。

`PolicyEngine` 的规则配置（`policy_rules`）也来自 `settings.json`，但 `PolicyEngine` 本身是 Lane 工作流的自动化决策引擎，与权限系统的 `PermissionPolicy` 不同——前者评估 Lane 生命周期状态并决定自动化动作，后者评估单次工具调用的授权。`PolicyEngine` 的详细实现分析在第12章。

`Skills` 和 `SlashCommandSpec` 的配置（`skills` 目录、`commands` 解析规则）来自文件系统和 `settings.json`，但 Skills 的发现、调用分发和 Commands 的解析架构属于 CLI 交互层，详细实现分析在第3章。

## 小结

配置层的核心是"契约"——`RuntimeFeatureConfig` 把扁平 JSON 解析为类型化视图，每个字段都有唯一的消费方，子系统通过只读访问器获取自己需要的配置。`config_validate.rs` 在合并和解析之间插入校验层，阻止无效配置进入运行时。

本章只分析配置的"接口契约"——即哪些字段存在、它们被谁消费、在哪一章详细分析。各子系统的具体消费逻辑（`HookRunner` 如何执行钩子命令、`PermissionPolicy` 如何评估规则、`McpServerManager` 如何管理服务器）分别在各自章节展开。

| 关键文件 | 核心机制 | 对应章节 |
| --- | --- | --- |
| `runtime/src/config.rs` | `RuntimeFeatureConfig`、子系统访问器、类型化解析 | 本章 |
| `runtime/src/config_validate.rs` | 未知键检测、类型检查、弃用提示 | 本章 |

下一章将分析 API 通信与模型交互——claw-code 如何与 LLM 建立 SSE 流式连接，以及如何实现多 provider 路由。
