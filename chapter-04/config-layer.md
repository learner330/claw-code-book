# 第4章 配置系统：Rules、Commands、MCP 与 Skills

## 本章概览

配置层不是孤立的数据加载机制，而是运行时各子系统的集成契约。`settings.json` 中的每个字段都对应一个子系统的行为边界——`permissions` 决定安全策略，`hooks` 定义干预点，`mcpServers` 声明外部能力，`plugins` 管理扩展生命周期，`rulesImport` 控制跨框架兼容性，`skills` 提供可组合的命令能力。本章分析这些配置项如何被解析为类型化的运行时视图，以及配置层中尚未在前序章节展开的独特机制：`PolicyEngine` 工作流规则引擎、`RulesImportConfig` 跨框架规则导入、Skills 发现与集成体系、以及 Commands 的解析与分发架构。

配置加载的三层合并机制（User → Project → Local）已在第4章分析。本章聚焦合并后的配置如何成为子系统的运行时契约。

| 关键文件 | 职责 | 对应节 |
| --- | --- | --- |
| `rust/crates/runtime/src/config.rs` | `RuntimeFeatureConfig` 类型化视图、字段解析 | 4.1 |
| `rust/crates/runtime/src/policy_engine.rs` | `PolicyEngine` 条件-动作规则评估 | 4.2 |
| `rust/crates/runtime/src/prompt.rs` | `RulesImportConfig` 框架规则发现 | 4.3 |
| `rust/crates/commands/src/lib.rs` | Skills 发现、`SlashCommand` 解析分发 | 4.4-4.5 |

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

配置校验也在这个边界上发生。`config_validate.rs` 在合并后的 JSON 上运行，检测未知键、类型错误和已弃用字段。校验结果分为 `errors`（阻止启动）和 `warnings`（允许启动但提示）。这个分层保证了无效配置不会进入 `RuntimeFeatureConfig` 的解析阶段。

## 4.2 PolicyEngine：Lane 工作流规则引擎

`PolicyEngine` 是配置层中尚未在前序章节分析的独立规则系统。它与第8章的 `PermissionPolicy` 不同——`PermissionPolicy` 评估单次工具调用的授权，`PolicyEngine` 评估 Lane（工作流分支）的生命周期状态并决定自动化动作。

### 规则结构

`PolicyRule` 是条件-动作三元组：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

pub struct PolicyRule {
    pub name: String,
    pub condition: PolicyCondition,
    pub action: PolicyAction,
    pub priority: u32,
}
```

`name` 用于诊断和日志。`condition` 决定规则是否触发。`action` 是触发后执行的操作。`priority` 控制评估顺序——数值越小优先级越高，在 `PolicyEngine::new` 中按优先级排序。

### 条件系统

`PolicyCondition` 支持组合逻辑和 Lane 状态检测：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

pub enum PolicyCondition {
    And(Vec<PolicyCondition>),
    Or(Vec<PolicyCondition>),
    GreenAt { level: GreenLevel },
    StaleBranch,
    StartupBlocked,
    LaneCompleted,
    LaneReconciled,
    ReviewPassed,
    ScopedDiff,
    TimedOut { duration: Duration },
    RetryAvailable,
    RebaseRequired,
    StaleCleanupRequired,
    ApprovalTokenPresent,
    ApprovalTokenMissing,
}
```

`And` 和 `Or` 支持嵌套组合——`And(vec![GreenAt { level: 2 }, ScopedDiff, ReviewPassed])` 表示"测试通过、差异可控、且审查已批准"。`GreenAt` 检查 Lane 的 green level（测试质量等级）是否达到阈值。`StaleBranch` 检测分支是否超过 1 小时未更新。`ApprovalTokenPresent` / `ApprovalTokenMissing` 检查是否有操作审批令牌。

`PolicyCondition::matches` 对 `LaneContext` 求值：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

impl PolicyCondition {
    pub fn matches(&self, context: &LaneContext) -> bool {
        match self {
            Self::And(conditions) => conditions
                .iter()
                .all(|condition| condition.matches(context)),
            Self::Or(conditions) => conditions
                .iter()
                .any(|condition| condition.matches(context)),
            Self::GreenAt { level } => {
                context.green_contract_satisfied && context.green_level >= *level
            }
            Self::StaleBranch => context.branch_freshness >= STALE_BRANCH_THRESHOLD,
            Self::StartupBlocked => context.blocker == LaneBlocker::Startup,
            // ... 其他变体
        }
    }
}
```

`LaneContext` 是 Lane 的完整状态快照：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

pub struct LaneContext {
    pub lane_id: String,
    pub green_level: GreenLevel,
    pub green_contract_satisfied: bool,
    pub branch_freshness: Duration,
    pub blocker: LaneBlocker,
    pub review_status: ReviewStatus,
    pub diff_scope: DiffScope,
    pub completed: bool,
    pub reconciled: bool,
    pub retry_count: u32,
    pub retry_limit: u32,
    pub rebase_required: bool,
    pub stale_cleanup_required: bool,
    pub approval_token: Option<ApprovalToken>,
}
```

这个结构包含 12 个状态字段，覆盖测试质量、分支新鲜度、阻塞状态、审查状态、重试次数、是否需要 rebase、是否需要清理、审批令牌等维度。`PolicyEngine` 不修改 `LaneContext`，只读取并输出动作列表——状态更新由调用方（`TaskRegistry` 或协调器）执行。

### 动作系统

`PolicyAction` 定义 Lane 生命周期中的自动化操作：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

pub enum PolicyAction {
    MergeToDev,
    MergeForward,
    RecoverOnce,
    Retry { reason: String },
    Rebase { reason: String },
    Escalate { reason: String },
    CloseoutLane,
    CleanupSession,
    CleanupStale { reason: String },
    Reconcile { reason: ReconcileReason },
    Notify { channel: String },
    RequireApprovalToken { operation: String },
    Block { reason: String },
    Chain(Vec<PolicyAction>),
}
```

`Chain` 支持动作组合——`Chain(vec![CloseoutLane, CleanupSession])` 表示先关闭 Lane 再清理会话。`PolicyAction::flatten_into` 把嵌套链展开为扁平列表：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

fn flatten_into(&self, actions: &mut Vec<PolicyAction>) {
    match self {
        Self::Chain(chained) => {
            for action in chained {
                action.flatten_into(actions);
            }
        }
        _ => actions.push(self.clone()),
    }
}
```

### 评估流程

`PolicyEngine::evaluate_with_events` 遍历按优先级排序的规则，对每条规则求值条件，匹配时展开动作并生成决策事件：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

pub fn evaluate_with_events(engine: &PolicyEngine, context: &LaneContext) -> PolicyEvaluation {
    let mut actions = Vec::new();
    let mut events = Vec::new();
    for rule in &engine.rules {
        if rule.matches(context) {
            let before = actions.len();
            rule.action.flatten_into(&mut actions);
            for action in &actions[before..] {
                events.push(decision_event(rule, context, action));
                // decision_event 生成 PolicyDecisionEvent，包含规则名、优先级、动作类型、解释文本
            }
        }
    }
    PolicyEvaluation { actions, events }
}
```

所有匹配的规则都会触发，不是"第一个匹配即停止"。这意味着多个规则可以同时生效——比如一个规则要求重试，另一个规则要求通知，两者都会出现在输出中。`PolicyEvaluation` 同时返回动作列表和事件列表，事件用于审计和日志，动作用于执行。

`PolicyEngine` 与第11章的 `TaskRegistry` 和 `LaneBoard` 协同工作——`LaneBoard` 提供状态可视化，`TaskRegistry` 管理 Lane 生命周期，`PolicyEngine` 提供自动化决策。三者构成"状态-规则-动作"的闭环：Lane 状态变化 → PolicyEngine 评估 → 生成动作 → 执行动作 → 状态再次变化。

## 4.3 Rules Import：跨框架规则兼容性

`RulesImportConfig` 控制是否导入外部 AI 编程框架的规则文件（如 Cursor、GitHub Copilot、Windsurf 等）。这个配置项解决的是生态兼容问题——不同团队可能使用不同的 AI 工具，claw-code 需要能读取其他工具的配置规则而不强制迁移。

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub enum RulesImportConfig {
    #[default]
    Auto,
    None,
    List(Vec<String>),
}
```

`Auto` 检测并导入所有支持的框架规则。`None` 不导入任何外部规则，只使用 claw 原生的 `.claw/rules/` 目录。`List(Vec<String>)` 只导入指定框架的规则——如 `List(vec!["cursor".to_string(), "copilot".to_string()])` 只导入 Cursor 和 Copilot 的规则。

`should_import` 方法检查特定框架是否应被导入：

```rust
// claw-code/rust/crates/runtime/src/config.rs

impl RulesImportConfig {
    pub fn should_import(&self, framework: &str) -> bool {
        match self {
            Self::Auto => true,
            Self::None => false,
            Self::List(frameworks) => frameworks
                .iter()
                .any(|f| f.eq_ignore_ascii_case(framework)),
        }
    }
}
```

`prompt.rs` 中的 `discover_instruction_files` 在发现指令文件时调用 `push_framework_imports`：

```rust
// claw-code/rust/crates/runtime/src/prompt.rs

fn push_framework_imports(
    files: &mut Vec<ContextFile>,
    dir: &Path,
    rules_import: &RulesImportConfig,
) -> std::io::Result<()> {
    if rules_import.should_import("cursor") {
        push_context_file(files, dir.join(".cursorrules"))?;
        push_rules_dir(files, dir.join(".cursor").join("rules"))?;
    }
    if rules_import.should_import("copilot") {
        push_context_file(files, dir.join(".github").join("copilot-instructions.md"))?;
    }
    if rules_import.should_import("windsurf") {
        push_context_file(files, dir.join(".windsurfrules"))?;
    }
    if rules_import.should_import("plandex") {
        push_context_file(files, dir.join(".plandex").join("instructions.md"))?;
    }
    if rules_import.should_import("crush") {
        push_context_file(files, dir.join(".crush").join("CLAUDE.md"))?;
        push_rules_dir(files, dir.join(".crush").join("rules"))?;
    }
}
```

支持的框架和对应文件路径：

| 框架 | 规则文件路径 | 规则目录路径 |
| --- | --- | --- |
| Cursor | `.cursorrules` | `.cursor/rules/` |
| GitHub Copilot | `.github/copilot-instructions.md` | — |
| Windsurf | `.windsurfrules` | `.windsurfrules/` |
| Plandex | `.plandex/instructions.md` | — |
| Crush | `.crush/CLAUDE.md` | `.crush/rules/` |

这个设计让 claw-code 能无缝集成现有项目的 AI 规则配置。团队从 Cursor 迁移到 claw-code 时，`.cursorrules` 文件中的规则会自动进入系统提示，不需要复制到 `.claw/rules/`。

`RulesImportConfig` 在 `RuntimeFeatureConfig` 中的位置表明它是系统提示构建的一部分（第7章的 `ProjectContext`），而非安全策略的一部分（`permissions`）。区分这两者很重要——规则导入影响的是模型"知道什么"，权限配置影响的是模型"能做什么"。

## 4.4 Skills 系统：发现与集成

Skills 是可组合的命令能力单元。与插件（第12章）不同，skills 不通过 `plugin.json` 和生命周期钩子定义，而是通过目录结构和 Markdown  frontmatter 定义，更轻量、更易于分发。

### Skill 发现

`SkillCollection` 是已发现技能的集合：

```rust
// claw-code/rust/crates/commands/src/lib.rs

struct SkillCollection {
    skills: Vec<SkillSummary>,
    metadata_drift: Vec<SkillMetadataDrift>,
}
```

`SkillSummary` 记录技能元数据：

```rust
// claw-code/rust/crates/commands/src/lib.rs

struct SkillSummary {
    name: String,
    description: Option<String>,
    source: DefinitionSource,
    shadowed_by: Option<DefinitionSource>,
    origin: SkillOrigin,
    path: Option<PathBuf>,
    dir_name: Option<String>,
}
```

`shadowed_by` 记录同名覆盖关系——如果两个来源定义了同名的 skill，后加载的来源会 shadow 先加载的，`shadowed_by` 指向覆盖者。`origin` 区分技能来源：`SkillsDir`（标准技能目录）或 `LegacyCommandsDir`（遗留命令目录，标记为 `legacy /commands`）。`dir_name` 用于检测 frontmatter 名称与目录名不一致的情况（`SkillMetadataDrift`）。

技能从两个路径发现：

```rust
// claw-code/rust/crates/commands/src/lib.rs

enum SkillOrigin {
    SkillsDir,
    LegacyCommandsDir,
}
```

发现流程遍历技能根目录，读取每个子目录中的 Markdown 文件 frontmatter（`name`、`description` 等字段），构建 `SkillSummary` 列表。`metadata_drift` 收集 frontmatter 名称与目录名不一致的条目，帮助诊断命名问题。

### Skill 调用分发

Skills 可以通过 slash 命令调用：`/skills <name> [args]`。`SkillSlashDispatch` 决定调用方式：

```rust
// claw-code/rust/crates/commands/src/lib.rs

pub enum SkillSlashDispatch {
    Local,
    Invoke(String),
}
```

`Local` 表示 skill 在本地执行（在当前运行时上下文中运行）。`Invoke(String)` 表示通过指定路径调用外部 skill 实现。这个设计支持两种 skill 部署模式：内置 skill（随 CLI 分发）和外部 skill（用户自定义或第三方提供）。

Skill 的安装和卸载管理 `InstalledSkill` 和 `UninstalledSkill` 记录，跟踪技能在注册表中的状态。`SkillInstallSource` 区分两种安装来源：

```rust
// claw-code/rust/crates/commands/src/lib.rs

enum SkillInstallSource {
    Directory { root: PathBuf, prompt_path: PathBuf },
    MarkdownFile { path: PathBuf },
}
```

`Directory` 从技能目录安装（包含 `prompt.md` 和元数据）。`MarkdownFile` 从单个 Markdown 文件安装（frontmatter 中包含元数据）。

Skills 系统与插件系统（第12章）的关系：skills 是"轻量级命令能力"，插件是"重量级扩展包"。一个插件可以包含多个技能，但技能不依赖插件的生命周期管理。这种分层让简单的命令能力不需要完整的插件基础设施。

## 4.5 Commands 架构：解析与分发

第4章当前版本列出了 30 多个 slash 命令的元数据（`SlashCommandSpec`），但这只是静态声明。Commands 架构的核心是解析和分发——如何把用户输入的 `/command args` 转换为运行时可执行的操作。

### 解析层

`SlashCommand` 枚举是解析后的命令表示：

```rust
// claw-code/rust/crates/commands/src/lib.rs

pub enum SlashCommand {
    Help,
    Status,
    Sandbox,
    Compact,
    Model { model: Option<String> },
    Permissions { mode: Option<PermissionMode> },
    Clear { confirm: bool },
    Cost,
    Resume { session_path: Option<String> },
    Config { section: Option<ConfigSection> },
    Mcp { subcommand: Option<McpSubcommand> },
    Memory,
    Init,
    Diff,
    Version,
    Bughunter { scope: Option<String> },
    Commit,
    Pr { context: Option<String> },
    Issue { context: Option<String> },
    Ultraplan { task: Option<String> },
    Teleport { target: Option<String> },
    DebugToolCall,
    Export { path: Option<String> },
    Session { subcommand: SessionSubcommand },
    Plugin { subcommand: PluginSubcommand },
    Agents { args: Option<String> },
    Skills { args: Option<String> },
    Doctor,
    // ... 更多变体
}
```

每个变体携带已解析的参数。`Model { model: Option<String> }` 中的 `Option` 表示参数可选——`/model` 不带参数时查询当前模型，`/model sonnet` 时切换模型。这种设计在类型层面保证参数合法性，解析失败时提前返回错误，不会传递到执行阶段。

解析函数是命令名到变体的映射：

```rust
// claw-code/rust/crates/commands/src/lib.rs (示意)

fn parse_command(name: &str, args: &str) -> Result<SlashCommand, SlashCommandParseError> {
    match name {
        "model" => SlashCommand::Model {
            model: optional_single_arg(name, &args, "[model]")?,
        },
        "permissions" => SlashCommand::Permissions {
            mode: parse_permissions_mode(&args)?,
        },
        "clear" => SlashCommand::Clear {
            confirm: parse_clear_args(&args)?,
        },
        "skills" | "skill" => SlashCommand::Skills {
            args: parse_skills_args(args)?,
        },
        "session" => parse_session_command(&args)?,
        "plugin" | "plugins" | "marketplace" => parse_plugin_command(&args)?,
        // ... 其他命令
    }
}
```

`optional_single_arg` 解析零个或一个参数。`parse_permissions_mode` 把字符串映射到 `PermissionMode` 枚举（`read-only`、`workspace-write`、`danger-full-access`）。`parse_clear_args` 识别 `--confirm` flag。子命令（`session`、`plugin`）有独立的解析函数，处理更复杂的参数结构。

### 分发层

解析后的 `SlashCommand` 被分发到运行时操作。分发逻辑不在 `commands` crate 中——`commands` crate 只负责解析，`rusty-claude-cli` 或 `runtime` 负责执行。这种设计保持 `commands` crate 的纯粹性（无运行时依赖），让解析逻辑可以被测试而无需初始化完整运行时。

`SkillSlashDispatch` 的分发示例：

```rust
// claw-code/rust/crates/commands/src/lib.rs

pub enum SkillSlashDispatch {
    Local,
    Invoke(String),
}
```

当用户执行 `/skills my-skill arg1 arg2` 时，解析层提取 skill 名称和参数，运行时根据 `SkillSummary` 的来源决定用 `Local` 还是 `Invoke` 分发。`Local` 在当前对话上下文中执行 skill 的 prompt 模板，`Invoke` 启动外部进程。

### 命令与配置的交互

部分命令修改运行时状态但不修改配置文件：`/permissions workspace-write` 只修改当前会话的 `active_mode`，不写入 `settings.json`。`/model sonnet` 同理。`config` 命令（`/config inspect`）则只读配置，不修改状态。

这种"配置持久化、运行时状态临时化"的设计原则在第4章的 Bootstrap 流程中也有体现——模型和权限的来源追踪区分了 Flag、Env、Config、Default 四个层级。命令系统只操作最顶层的运行时状态。

## 小结

配置层的核心不是加载机制（第4章已覆盖），而是合并后的配置如何成为子系统的运行时契约。`RuntimeFeatureConfig` 把扁平 JSON 解析为类型化视图——`hooks`  consumed by `HookRunner`（第10章）、`permission_rules` consumed by `PermissionPolicy`（第8章）、`mcp` consumed by `McpServerManager`（第7章）、`plugins` consumed by plugin lifecycle（第7章）、`rules_import` consumed by prompt builder（第11章）。

本章展开的三个独特机制：`PolicyEngine` 的 Lane 工作流自动化（条件-动作规则评估、`LaneContext` 状态快照、优先级排序），`RulesImportConfig` 的跨框架规则兼容（Auto/None/List 三种模式、五框架支持），以及 Skills 的发现与集成体系（`SkillCollection` 目录遍历、`SkillSlashDispatch` 调用分发）。

Commands 架构的解析层用 `SlashCommand` 枚举在类型层面保证参数合法性，分发层把解析结果映射到运行时操作，保持 `commands` crate 无运行时依赖的纯粹性。

| 机制 | 核心结构 | 消费方 |
| --- | --- | --- |
| 配置契约 | `RuntimeFeatureConfig` | 各子系统 |
| Lane 工作流 | `PolicyEngine` + `LaneContext` | `TaskRegistry`（第11章） |
| 规则导入 | `RulesImportConfig` | `ProjectContext`（第7章） |
| Skills | `SkillCollection` + `SkillSlashDispatch` | Commands 分发层 |
| 命令解析 | `SlashCommand` 枚举 | CLI 运行时 |
