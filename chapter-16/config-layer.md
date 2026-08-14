# 第16章 配置层：Rules、Commands、MCP 与 Skills

## 本章概览

本章分析 claw-code 的配置系统——如何加载、合并、校验多来源的配置文件，以及命令系统如何解析和分发用户输入。对应 `runtime::config`、`runtime::config_validate` 和 `commands` crate。

配置系统解决的核心问题是：Agent 的行为由用户配置决定（权限模式、工具白名单、MCP 服务器、钩子命令），但配置来源多样（用户级、项目级、本地级、环境变量、CLI 参数）。系统需要按优先级合并配置，检测冲突和错误，并提供清晰的诊断信息。

| 关键文件 | 职责 |
| --- | --- |
| `rust/crates/runtime/src/config.rs` | `ConfigLoader`、多源合并、`RuntimeConfig` |
| `rust/crates/runtime/src/config_validate.rs` | 字段校验、诊断信息、类型匹配 |
| `rust/crates/commands/src/lib.rs` | `SlashCommandSpec`、命令注册表、命令分发 |

## 16.1 配置来源与优先级

Rust 端定义三种配置来源，按优先级从低到高：

```rust
// claw-code/rust/crates/runtime/src/config.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ConfigSource {
    User,
    Project,
    Local,
}
```

`#[derive(PartialOrd, Ord)]` 使枚举变体可比较——`User < Project < Local`。这意味着本地配置优先级最高，项目级次之，用户级最低。这个偏序关系用于配置合并：高优先级来源覆盖低优先级来源的同名键。

`ConfigEntry` 记录每个加载的配置文件及其来源：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub struct ConfigEntry {
    pub source: ConfigSource,
    pub path: PathBuf,
}
```

`RuntimeConfig` 是合并后的运行时配置：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub struct RuntimeConfig {
    merged: BTreeMap<String, JsonValue>,
    loaded_entries: Vec<ConfigEntry>,
    feature_config: RuntimeFeatureConfig,
}
```

`merged` 是合并后的 JSON 对象映射。`loaded_entries` 记录加载的文件列表（用于诊断和报告）。`feature_config` 是解析后的功能配置视图（hooks、plugins、MCP 等）。`BTreeMap` 按键排序，便于遍历和合并。

## 16.2 配置加载与合并

`ConfigLoader` 实现配置的加载和合并逻辑。加载顺序是 `User` → `Project` → `Local`，每个来源可能对应多个文件。合并策略是浅层键覆盖——高优先级文件的同名键替换低优先级文件的值，不进行深层递归合并。

配置路径搜索：

```rust
// claw-code/rust/crates/runtime/src/config.rs (示意)

impl ConfigLoader {
    pub fn from_cwd(cwd: impl AsRef<Path>) -> Result<Self, ConfigError> {
        // 搜索 ~/.claw/settings.json (User)
        // 搜索 <cwd>/.claw/settings.json (Project)
        // 搜索 <cwd>/.claw/local/settings.json (Local)
        // 按优先级合并
    }
}
```

`from_cwd` 从当前工作目录出发，搜索三级配置目录。`User` 级配置在用户的 home 目录（`~/.claw/`），`Project` 级在项目的 `.claw/` 目录，`Local` 级在 `.claw/local/` 目录。这个分层设计允许用户有全局默认设置，项目有团队共享设置，本地有开发者个人覆盖。

`ConfigFileStatus` 跟踪每个配置文件的加载状态：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub enum ConfigFileStatus {
    Loaded,
    NotFound,
    Skipped,
    LoadError,
}
```

`Loaded` 成功加载。`NotFound` 文件不存在（这是正常情况，不是所有来源都必须有配置）。`Skipped` 被跳过（如格式不支持）。`LoadError` 加载失败（如 JSON 解析错误）。`ConfigFileReport` 包含状态和可选原因，用于 `config` 命令的 `inspect` 功能。

## 16.3 配置校验：config_validate

`config_validate.rs` 实现配置字段的校验和诊断。核心结构是 `ConfigDiagnostic`：

```rust
// claw-code/rust/crates/runtime/src/config_validate.rs

pub struct ConfigDiagnostic {
    pub path: String,
    pub field: String,
    pub line: Option<usize>,
    pub kind: DiagnosticKind,
}

pub enum DiagnosticKind {
    UnknownKey { suggestion: Option<String> },
    WrongType { expected: &'static str, got: &'static str },
    Deprecated { replacement: &'static str },
}
```

`UnknownKey` 检测未知字段——如果用户拼写错误（如 `permissinMode` 而不是 `permissionMode`），`suggestion` 提供最接近的已知键建议。`WrongType` 检测类型不匹配——如 `permissionMode` 应该是字符串但用户写了布尔值。`Deprecated` 检测已弃用字段——如 `permissionMode` 已被 `permissions.defaultMode` 取代，提示用户使用新字段。

`Display` 实现生成人类可读的错误消息：

```rust
// claw-code/rust/crates/runtime/src/config_validate.rs

impl Display for ConfigDiagnostic {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        let location = self.line.map_or_else(String::new, |line| format!(" (line {line})"));
        match &self.kind {
            DiagnosticKind::UnknownKey { suggestion: None } => {
                write!(f, "{}: unknown key \"{}\"{location}", self.path, self.field)
            }
            DiagnosticKind::UnknownKey { suggestion: Some(hint) } => {
                write!(f, "{}: unknown key \"{}\"{location}. Did you mean \"{}\"?", self.path, self.field, hint)
            }
            DiagnosticKind::WrongType { expected, got } => {
                write!(f, "{}: field \"{}\" must be {expected}, got {got}{location}", self.path, self.field)
            }
            DiagnosticKind::Deprecated { replacement } => {
                write!(f, "{}: field \"{}\" is deprecated{location}. Use \"{}\" instead", self.path, self.field, replacement)
            }
        }
    }
}
```

`line` 是可选的行号信息。`UnknownKey` 有 `Did you mean` 提示——通过字符串相似度计算最接近的已知键。`Deprecated` 直接给出替代字段名。这些诊断信息通过 `eprintln` 输出到 stderr，同时被 `emit_config_warning_once` 去重——进程生命周期内同一警告只输出一次。

`ValidationResult` 汇总所有诊断：

```rust
// claw-code/rust/crates/runtime/src/config_validate.rs

pub struct ValidationResult {
    pub errors: Vec<ConfigDiagnostic>,
    pub warnings: Vec<ConfigDiagnostic>,
}

impl ValidationResult {
    pub fn is_ok(&self) -> bool {
        self.errors.is_empty()
    }

    fn merge(&mut self, other: Self) {
        self.errors.extend(other.errors);
        self.warnings.extend(other.warnings);
    }
}
```

`errors` 阻止启动（如 `WrongType` 导致配置无法解析）。`warnings` 允许启动但提示用户（如 `Deprecated` 或 `UnknownKey`）。`merge` 合并多个文件的校验结果——用户级配置可能有警告，项目级配置有错误，合并后统一报告。

### 字段类型校验

`FieldType` 定义支持的配置字段类型：

```rust
// claw-code/rust/crates/runtime/src/config_validate.rs

enum FieldType {
    String, Bool, Object, StringArray, HookArray, RulesImport, Number,
}

impl FieldType {
    fn label(self) -> &'static str {
        match self {
            Self::String => "a string",
            Self::Bool => "a boolean",
            Self::Object => "an object",
            Self::StringArray => "an array of strings",
            Self::RulesImport => "a string or an array of strings",
            Self::HookArray => "an array of strings or hook objects",
            Self::Number => "a number",
        }
    }

    fn matches(self, value: &JsonValue) -> bool {
        match self {
            Self::String => value.as_str().is_some(),
            Self::Bool => value.as_bool().is_some(),
            Self::Object => value.as_object().is_some(),
            Self::StringArray => value.as_array().is_some_and(|arr| arr.iter().all(|v| v.as_str().is_some())),
            Self::HookArray => true, // hook 数组接受多种格式，不过于严格
            Self::RulesImport => value.as_str().is_some() || value.as_array().is_some_and(|arr| arr.iter().all(|v| v.as_str().is_some())),
            Self::Number => value.as_i64().is_some(),
        }
    }
}
```

`HookArray` 的 `matches` 始终返回 `true`——因为钩子数组支持多种格式（纯字符串数组、对象数组），校验器不对其内容做严格检查，避免过度限制用户。`RulesImport` 接受字符串或字符串数组，因为 `rulesImport` 字段可以导入单个文件或文件列表。

已知的顶层字段列表：

```rust
// claw-code/rust/crates/runtime/src/config_validate.rs

const TOP_LEVEL_FIELDS: &[FieldSpec] = &[
    FieldSpec { name: "$schema", expected: FieldType::String },
    FieldSpec { name: "model", expected: FieldType::String },
    FieldSpec { name: "hooks", expected: FieldType::Object },
    FieldSpec { name: "permissions", expected: FieldType::Object },
    FieldSpec { name: "permissionMode", expected: FieldType::String },
    FieldSpec { name: "mcpServers", expected: FieldType::Object },
    FieldSpec { name: "oauth", expected: FieldType::Object },
    FieldSpec { name: "enabledPlugins", expected: FieldType::Object },
    FieldSpec { name: "plugins", expected: FieldType::Object },
    FieldSpec { name: "sandbox", expected: FieldType::Object },
    FieldSpec { name: "env", expected: FieldType::Object },
    FieldSpec { name: "aliases", expected: FieldType::Object },
    FieldSpec { name: "providerFallbacks", expected: FieldType::Object },
    FieldSpec { name: "trustedRoots", expected: FieldType::StringArray },
    FieldSpec { name: "provider", expected: FieldType::Object },
    FieldSpec { name: "rulesImport", expected: FieldType::RulesImport },
    FieldSpec { name: "subagentModel", expected: FieldType::String },
];
```

`$schema` 字段支持 JSON Schema 验证。`rulesImport` 支持字符串或字符串数组。`trustedRoots` 是字符串数组（信任的目录列表）。`permissionMode` 是已弃用的顶层字段，现代配置应使用 `permissions.defaultMode`。

## 16.4 命令系统：Slash Commands

`commands` crate 定义了 slash 命令的规范和注册表。`SlashCommandSpec` 是命令的元数据：

```rust
// claw-code/rust/crates/commands/src/lib.rs

pub struct SlashCommandSpec {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub summary: &'static str,
    pub argument_hint: Option<&'static str>,
    pub resume_supported: bool,
}
```

`name` 是命令名（如 `help`、`status`、`compact`）。`aliases` 是别名（如 `plugin` 的别名 `plugins` 和 `marketplace`）。`summary` 是帮助文本。`argument_hint` 是参数提示（如 `permissions` 的参数是 `[read-only|workspace-write|danger-full-access]`）。`resume_supported` 标记命令是否支持在恢复的会话中执行——`model` 切换命令不支持恢复（因为模型切换是即时操作），`help` 支持恢复。

命令列表定义在 `SLASH_COMMAND_SPECS` 常量数组中：

```rust
// claw-code/rust/crates/commands/src/lib.rs

const SLASH_COMMAND_SPECS: &[SlashCommandSpec] = &[
    SlashCommandSpec { name: "help", aliases: &[], summary: "Show available slash commands", argument_hint: None, resume_supported: true },
    SlashCommandSpec { name: "status", aliases: &[], summary: "Show current session status", argument_hint: None, resume_supported: true },
    SlashCommandSpec { name: "sandbox", aliases: &[], summary: "Show sandbox isolation status", argument_hint: None, resume_supported: true },
    SlashCommandSpec { name: "compact", aliases: &[], summary: "Compact local session history", argument_hint: None, resume_supported: true },
    SlashCommandSpec { name: "model", aliases: &[], summary: "Show or switch the active model", argument_hint: Some("[model]"), resume_supported: false },
    SlashCommandSpec { name: "permissions", aliases: &[], summary: "Show or switch the active permission mode", argument_hint: Some("[read-only|workspace-write|danger-full-access]"), resume_supported: false },
    SlashCommandSpec { name: "clear", aliases: &[], summary: "Start a fresh local session", argument_hint: Some("[--confirm]"), resume_supported: true },
    SlashCommandSpec { name: "cost", aliases: &[], summary: "Show cumulative token usage for this session", argument_hint: None, resume_supported: true },
    SlashCommandSpec { name: "resume", aliases: &[], summary: "Load a saved session into the REPL", argument_hint: Some("<session-path>"), resume_supported: false },
    SlashCommandSpec { name: "config", aliases: &[], summary: "Inspect Claude config files or merged sections", argument_hint: Some("[env|hooks|model|plugins]"), resume_supported: true },
    SlashCommandSpec { name: "mcp", aliases: &[], summary: "Inspect configured MCP servers", argument_hint: Some("[list|show <server>|help]"), resume_supported: true },
    SlashCommandSpec { name: "memory", aliases: &[], summary: "Inspect loaded Claude instruction memory files", argument_hint: None, resume_supported: true },
    SlashCommandSpec { name: "init", aliases: &[], summary: "Create a starter CLAUDE.md for this repo", argument_hint: None, resume_supported: true },
    SlashCommandSpec { name: "diff", aliases: &[], summary: "Show git diff for current workspace changes", argument_hint: None, resume_supported: true },
    SlashCommandSpec { name: "version", aliases: &[], summary: "Show CLI version and build information", argument_hint: None, resume_supported: true },
    SlashCommandSpec { name: "bughunter", aliases: &[], summary: "Inspect the codebase for likely bugs", argument_hint: Some("[scope]"), resume_supported: false },
    SlashCommandSpec { name: "commit", aliases: &[], summary: "Generate a commit message and create a git commit", argument_hint: None, resume_supported: false },
    SlashCommandSpec { name: "pr", aliases: &[], summary: "Draft or create a pull request from the conversation", argument_hint: Some("[context]"), resume_supported: false },
    SlashCommandSpec { name: "issue", aliases: &[], summary: "Draft or create a GitHub issue from the conversation", argument_hint: Some("[context]"), resume_supported: false },
    SlashCommandSpec { name: "ultraplan", aliases: &[], summary: "Run a deep planning prompt with multi-step reasoning", argument_hint: Some("[task]"), resume_supported: false },
    SlashCommandSpec { name: "teleport", aliases: &[], summary: "Jump to a file or symbol by searching the workspace", argument_hint: Some("<symbol-or-path>"), resume_supported: false },
    SlashCommandSpec { name: "debug-tool-call", aliases: &[], summary: "Replay the last tool call with debug details", argument_hint: None, resume_supported: false },
    SlashCommandSpec { name: "export", aliases: &[], summary: "Export the current conversation to a file", argument_hint: Some("[file]"), resume_supported: true },
    SlashCommandSpec { name: "session", aliases: &[], summary: "List, check, switch, fork, or delete managed local sessions", argument_hint: Some("[list|exists <session-id>|switch <session-id>|fork [branch-name]|delete <session-id> [--force]]"), resume_supported: true },
    SlashCommandSpec { name: "plugin", aliases: &["plugins", "marketplace"], summary: "Manage Claw Code plugins", argument_hint: Some("[list|install <path>|enable <name>|disable <name>|uninstall <id>|update <id>]"), resume_supported: false },
    SlashCommandSpec { name: "agents", aliases: &[], summary: "List, show, or create configured agents", argument_hint: Some("[list|show <name>|create <name>|help]"), resume_supported: true },
    SlashCommandSpec { name: "skills", aliases: &["skill"], summary: "List, install, uninstall, or invoke available skills", argument_hint: Some("[list|show <name>|install <path>|uninstall <name>|help|<skill> [args]]"), resume_supported: true },
    SlashCommandSpec { name: "doctor", aliases: &[], summary: "Diagnose setup issues and environment health", argument_hint: None, resume_supported: true },
    SlashCommandSpec { name: "plan", aliases: &[], summary: "Toggle or inspect planning mode", argument_hint: Some("[on|off]"), resume_supported: true },
    SlashCommandSpec { name: "review", aliases: &[], summary: "Run a code review on current changes", argument_hint: Some("[scope]"), resume_supported: false },
    SlashCommandSpec { name: "tasks", aliases: &[], summary: "List and manage background tasks", argument_hint: Some("[list|get <id>|stop <id>]"), resume_supported: true },
    SlashCommandSpec { name: "theme", aliases: &[], summary: "Switch the terminal color theme", argument_hint: Some("[theme-name]"), resume_supported: true },
    SlashCommandSpec { name: "vim", aliases: &[], summary: "Toggle vim keybinding mode", argument_hint: None, resume_supported: true },
    SlashCommandSpec { name: "voice", aliases: &[], summary: "Toggle voice input mode", argument_hint: None, resume_supported: true },
];
```

30 多个命令覆盖会话管理（`session`、`compact`、`clear`）、配置查询（`config`、`permissions`、`model`）、开发辅助（`diff`、`commit`、`pr`、`issue`）、扩展管理（`plugin`、`mcp`、`skills`）、诊断调试（`doctor`、`debug-tool-call`）等场景。`aliases` 支持用户用习惯的方式调用命令——`plugins` 和 `marketplace` 都映射到 `plugin`。

`CommandRegistry` 和 `CommandManifestEntry` 与 `ToolRegistry` 结构对称（第6章）：

```rust
// claw-code/rust/crates/commands/src/lib.rs

pub struct CommandManifestEntry {
    pub name: String,
    pub source: CommandSource,
}

pub enum CommandSource {
    Builtin,
    InternalOnly,
    FeatureGated,
}
```

`Builtin` 是内置命令。`InternalOnly` 是内部命令（不暴露给用户）。`FeatureGated` 是 feature-gated 命令（通过配置开关启用）。`compat-harness` 从 upstream 源码提取的命令清单也区分这三种来源（第14章）。

`SkillSlashDispatch` 支持技能的命令分发：

```rust
// claw-code/rust/crates/commands/src/lib.rs

pub enum SkillSlashDispatch {
    Local,
    Invoke(String),
}
```

`Local` 表示技能在本地执行。`Invoke(String)` 表示技能通过指定路径调用。这个机制支持技能系统的外部扩展——用户安装的技能可以作为 slash 命令执行。

## 16.5 配置与命令的交互

`config` slash 命令（`inspect` 子命令）可以查看合并后的配置：

```
/config inspect
```

输出合并后的 `settings.json`，展示每个字段的来源（User/Project/Local）和最终值。这帮助用户理解配置优先级和覆盖关系。

`permissions` 命令切换权限模式：

```
/permissions workspace-write
```

这个命令修改当前会话的 `active_mode`，但不修改配置文件。配置文件的 `permissions.defaultMode` 是新会话的默认值，运行时切换不影响持久化配置。这种设计区分了"配置"和"运行时状态"——配置是持久的，运行时状态是临时的。

`model` 命令切换模型：

```
/model sonnet
```

同样只影响当前会话的 `model` 字段，不修改配置文件。`model` 的 `resume_supported` 为 `false`——因为恢复会话时模型由会话记录决定，不应被切换命令覆盖。

## 小结

配置层在 Rust 端以 `ConfigLoader`（`config.rs`）实现多源配置加载和合并，`ConfigSource` 的 `#[derive(PartialOrd, Ord)]` 定义优先级（User < Project < Local），`RuntimeConfig` 用 `BTreeMap` 存储合并后的键值。`config_validate.rs` 提供字段校验——`UnknownKey` 检测未知字段（含 `Did you mean` 建议）、`WrongType` 检测类型不匹配、`Deprecated` 提示替代字段。`FieldType` 定义七种类型（String、Bool、Object、StringArray、HookArray、RulesImport、Number），`TOP_LEVEL_FIELDS` 和子对象字段（`HOOKS_FIELDS`、`PERMISSIONS_FIELDS`、`PLUGINS_FIELDS`、`SANDBOX_FIELDS`）定义已知的配置 schema。

命令系统（`commands/src/lib.rs`）定义 `SlashCommandSpec` 规范——名称、别名、帮助文本、参数提示、恢复支持。`SLASH_COMMAND_SPECS` 包含 30 多个命令，覆盖会话管理、配置查询、开发辅助、扩展管理、诊断调试等场景。`CommandRegistry` 和 `CommandManifestEntry` 与 `ToolRegistry` 结构对称，支持 `Builtin`、`InternalOnly`、`FeatureGated` 三种来源。`SkillSlashDispatch` 支持技能的本地执行和外部调用。

配置与命令的交互遵循"配置持久化、运行时状态临时化"的原则——`permissions` 和 `model` 命令只修改运行时状态，不修改配置文件。`config` 命令提供配置审计功能，帮助用户理解多源合并的结果。

| 关键文件 | 核心机制 | 对应章节 |
| --- | --- | --- |
| `rust/crates/runtime/src/config.rs` | `ConfigLoader`、多源合并、`ConfigSource` 优先级 | 16.1-16.2 |
| `rust/crates/runtime/src/config_validate.rs` | `ConfigDiagnostic`、字段校验、类型匹配 | 16.3 |
| `rust/crates/commands/src/lib.rs` | `SlashCommandSpec`、`CommandRegistry`、技能分发 | 16.4-16.5 |

下一章将分析 AI-Native 工程工作流——claw-code 作为基础设施如何融入日常开发流程，从需求分析到代码交付的 Agent 协作模式。
