# 第11章 插件系统与命令扩展

## 本章概览

claw-code 的可扩展性来自两层：插件系统（通过 `plugin.json` 声明钩子、工具和命令）和 60 余个内置 slash 命令（`/commit`、`/pr`、`/plugins` 等）。Python 重写版将这两层做成镜像注册表占位，记录原版模块的元数据但不实现逻辑；Rust 重写版则真正落地了插件管理器（`PluginManager`）与命令分发（`SlashCommand` 枚举 + 解析器）。

本章按三层展开：Python 端的镜像占位和移植审计、Rust 端的插件管理器与清单契约、Rust 端的命令分发与插件命令集成。

| 层级 | 源文件 | 核心结构 | 职责 |
| --- | --- | --- | --- |
| Python 占位 | `src/plugins/__init__.py` | `_SNAPSHOT` | 加载插件存档元数据 |
| Python 镜像 | `src/commands.py` | `PortingModule` | 207 条命令镜像注册 |
| Python 分类 | `src/command_graph.py` | `CommandGraph` | 按来源分类命令 |
| Rust 插件 | `rust/crates/plugins/src/lib.rs` | `PluginManifest`、`PluginManager` | 清单解析、生命周期管理 |
| Rust 插件 | `rust/crates/plugins/src/hooks.rs` | `HookRunner` | 插件钩子执行（第 8 章已详解） |
| Rust 命令 | `rust/crates/commands/src/lib.rs` | `SlashCommand` | 60+ 变体命令枚举与解析 |

## 11.1 Python 占位层：镜像而非实现

Python 端的 `src/plugins/__init__.py` 与第 10 章的 `src/coordinator/__init__.py` 是同一套模式——不是实现插件系统，而是从存档元数据里读取数字，证明这个子系统在原版里存在过：

```python
# claw-code/src/plugins/__init__.py

from src._archive_helper import load_archive_metadata

_SNAPSHOT = load_archive_metadata("plugins")

ARCHIVE_NAME = _SNAPSHOT["archive_name"]
MODULE_COUNT = _SNAPSHOT["module_count"]
SAMPLE_FILES = tuple(_SNAPSHOT["sample_files"])
PORTING_NOTE = f"Python placeholder package for '{ARCHIVE_NAME}' with {MODULE_COUNT} archived module references."

__all__ = ["ARCHIVE_NAME", "MODULE_COUNT", "PORTING_NOTE", "SAMPLE_FILES"]
```

这段代码与第 8 章和第 10 章的归档占位符结构完全一致。`load_archive_metadata` 从 `reference_data/subsystems/plugins.json` 读取快照，Python 模块把值导出为常量。`__all__` 限制 `from plugins import *` 的导入范围。`MODULE_COUNT` 是 Python 侧对原版插件的全部认知——没有清单解析、没有加载逻辑。

对应的存档元数据：

```json
// claw-code/src/reference_data/subsystems/plugins.json

{
  "archive_name": "plugins",
  "package_name": "plugins",
  "module_count": 2,
  "sample_files": [
    "plugins/builtinPlugins.ts",
    "plugins/bundled/index.ts"
  ]
}
```

`module_count` 为 2，说明原版 TypeScript 项目的插件子系统只有两个模块。`builtinPlugins.ts` 负责内置插件注册，`bundled/index.ts` 是随发行包捆绑的插件入口。这两个模块是原版插件系统的全部代码——大部分插件逻辑分散在各自的 `plugin.json` 清单和钩子脚本中，核心框架代码反而很少。

命令侧的镜像注册表更完整。`src/commands.py` 从 `commands_snapshot.json` 加载 207 条命令条目：

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

PORTED_COMMANDS = load_command_snapshot()
```

这段代码用 `lru_cache(maxsize=1)` 缓存加载结果——整个进程只读一次 JSON 文件，后续调用直接返回缓存的 tuple。`PortingModule` 是 frozen dataclass，四个字段：`name`（命令名）、`responsibility`（职责描述）、`source_hint`（原版源文件路径）、`status='mirrored'`（标记为镜像而非实现）。`tuple()` 保证返回不可变序列。

`execute_command` 揭示了镜像的本质——找到命令但不执行：

```python
# claw-code/src/commands.py

def execute_command(name: str, prompt: str = '') -> CommandExecution:
    module = get_command(name)
    if module is None:
        return CommandExecution(name=name, source_hint='', prompt=prompt,
            handled=False, message=f'Unknown mirrored command: {name}')
    action = f"Mirrored command '{module.name}' from {module.source_hint} would handle prompt {prompt!r}."
    return CommandExecution(name=module.name, source_hint=module.source_hint,
        prompt=prompt, handled=True, message=action)
```

`execute_command` 查找到镜像条目后返回 `handled=True`，但 `message` 只是描述性文字——"该命令本应处理这个 prompt"，实际没有执行任何逻辑。`handled=True` 表示命令被识别，`message` 说明来源和意图。`{prompt!r}` 用 `repr()` 格式化，保留字符串的引号和转义，便于调试。

别名映射表是唯一的"活"逻辑：

```python
# claw-code/src/commands.py

COMMAND_ALIASES = {
    'plugins': 'plugin',
    'marketplace': 'plugin',
}

def get_command(name: str) -> PortingModule | None:
    normalized = name.strip().lower()
    needle = COMMAND_ALIASES.get(normalized, normalized)
    for module in PORTED_COMMANDS:
        if module.name.lower() == needle:
            return module
    return None
```

`COMMAND_ALIASES` 把 `plugins` 和 `marketplace` 都归一化到 `plugin`，说明命令命名历史上发生过变更。`get_command` 先 strip + lower 规范化输入，再查别名表，最后线性查找。`.get(normalized, normalized)` 的第二个参数是默认值——如果别名表中没有匹配，返回原始规范化值。

`src/command_graph.py` 在镜像之上做了一层分类：

```python
# claw-code/src/command_graph.py

def build_command_graph() -> CommandGraph:
    commands = get_commands()
    builtins = tuple(module for module in commands
        if 'plugin' not in module.source_hint.lower()
        and 'skills' not in module.source_hint.lower())
    plugin_like = tuple(module for module in commands
        if 'plugin' in module.source_hint.lower())
    skill_like = tuple(module for module in commands
        if 'skills' in module.source_hint.lower())
    return CommandGraph(builtins=builtins, plugin_like=plugin_like, skill_like=skill_like)
```

这段代码通过检查 `source_hint` 字符串中是否包含 `plugin` 或 `skills` 关键字，把 207 条命令分成三类：内置命令、插件命令、技能命令。这种基于字符串匹配的分类是粗略的——一个源文件路径为 `commands/plugins/plugin.ts` 的命令会被分到 `plugin_like`，即使它可能是一个内置命令。但作为移植审计的分类依据，它足够用了。

## 11.2 Rust 插件系统：PluginKind 与清单契约

Rust 插件系统的入口在 `rust/crates/plugins/src/lib.rs`。与 Python 侧只读元数据不同，这里定义了完整的插件类型体系。插件按来源分为三类：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Builtin,
    Bundled,
    External,
}
```

三个变体对应三个来源：`Builtin` 是编译期内置的插件，代码直接链接进二进制；`Bundled` 是随发行包分发的插件，位于固定的 bundled 目录；`External` 是用户通过 `/plugins install` 安装的第三方插件。`#[serde(rename_all = "lowercase")]` 让序列化输出使用小写（`builtin`、`bundled`、`external`）。

每个 `PluginKind` 对应一个 marketplace 常量：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

const EXTERNAL_MARKETPLACE: &str = "external";
const BUILTIN_MARKETPLACE: &str = "builtin";
const BUNDLED_MARKETPLACE: &str = "bundled";

impl PluginKind {
    fn marketplace(self) -> &'static str {
        match self {
            Self::Builtin => BUILTIN_MARKETPLACE,
            Self::Bundled => BUNDLED_MARKETPLACE,
            Self::External => EXTERNAL_MARKETPLACE,
        }
    }
}
```

`marketplace()` 方法返回对应的常量字符串。插件 ID 由 `name@marketplace` 拼接而成，因此同一个名字可以同时存在于三个来源而不冲突——例如 `my-tool@builtin` 和 `my-tool@external` 是两个不同的插件。

插件的契约文件是 `plugin.json`，位于插件根目录的 `.claude-plugin/plugin.json`。`PluginManifest` 是解析后的强类型结构：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub description: String,
    pub permissions: Vec<PluginPermission>,
    #[serde(rename = "defaultEnabled", default)]
    pub default_enabled: bool,
    #[serde(default)]
    pub hooks: PluginHooks,
    #[serde(default)]
    pub lifecycle: PluginLifecycle,
    #[serde(default)]
    pub tools: Vec<PluginToolManifest>,
    #[serde(default)]
    pub commands: Vec<PluginCommandManifest>,
}
```

逐字段分析：`name`、`version`、`description` 是基础元数据。`permissions` 是插件级别的权限声明（read/write/execute）。`default_enabled` 控制插件安装后是否默认启用，`#[serde(rename = "defaultEnabled", default)]` 让 JSON 中的 PascalCase 键映射到 Rust 的 snake_case 字段，缺失时默认为 `false`。`hooks` 是第 8 章详解的 `PluginHooks` 结构。`lifecycle` 包含 Init 和 Shutdown 命令。`tools` 是插件声明的工具列表。`commands` 是插件声明的 slash 命令列表。

插件权限和工具权限是两套独立的枚举：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginPermission {
    Read,
    Write,
    Execute,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginToolPermission {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}
```

`PluginPermission` 是插件级别的粗粒度权限（read/write/execute），用 `lowercase` 序列化。`PluginToolPermission` 是工具级别的细粒度权限，复用了第 7 章权限系统的三档模型（read-only/workspace-write/danger-full-access），用 `kebab-case` 序列化。两套权限枚举独立存在——一个插件可以有 `read` 权限但它的某个工具可能需要 `danger-full-access`。`PartialOrd, Ord` trait 让权限级别可以比较大小，用于权限继承检查。

`PluginToolManifest` 定义了插件工具的声明：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginToolManifest {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub required_permission: PluginToolPermission,
}
```

每个工具声明包含：`name`（工具名）、`description`（描述）、`input_schema`（JSON Schema 格式的输入定义）、`command`（执行的 shell 命令）、`args`（命令参数）、`required_permission`（所需权限）。`input_schema` 用 `serde_json::Value` 类型而非强类型结构——因为 JSON Schema 本身是动态的，不同的工具有不同的字段结构。

`PluginLifecycle` 管理插件的初始化和清理：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginLifecycle {
    #[serde(rename = "Init", default)]
    pub init: Vec<String>,
    #[serde(rename = "Shutdown", default)]
    pub shutdown: Vec<String>,
}
```

`init` 和 `shutdown` 都是 shell 命令字符串数组。Init 命令在插件加载时执行（如启动后台服务、初始化数据库），Shutdown 命令在插件卸载时执行（如清理临时文件、关闭连接）。

`PluginCommandManifest` 定义了插件声明的 slash 命令：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginCommandManifest {
    pub name: String,
    pub description: String,
    pub command: String,
}
```

`name` 是命令名（用户输入 `/name` 触发），`description` 是描述，`command` 是执行的 shell 命令。插件命令比内置命令简单——没有参数解析、没有枚举变体，只是简单的命令名到 shell 命令的映射。

## 11.3 Rust 插件系统：工具执行与子进程模型

工具执行是插件系统最核心的机制。`PluginTool::execute` 不是调用进程内函数，而是启动一个子进程，通过环境变量和标准输入传递上下文：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

pub fn execute(&self, input: &Value) -> Result<String, PluginError> {
    let input_json = input.to_string();
    let mut process = Command::new(&self.command);
    process
        .args(&self.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("CLAWD_PLUGIN_ID", &self.plugin_id)
        .env("CLAWD_PLUGIN_NAME", &self.plugin_name)
        .env("CLAWD_TOOL_NAME", &self.definition.name)
        .env("CLAWD_TOOL_INPUT", &input_json);
    if let Some(root) = &self.root {
        process
            .current_dir(root)
            .env("CLAWD_PLUGIN_ROOT", root.display().to_string());
    }

    let mut child = process.spawn()?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(input_json.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(PluginError::CommandFailed(...))
    }
}
```

这段代码展示了插件工具的子进程执行模型。`Command::new(&self.command)` 创建进程构建器，`args` 设置命令行参数，三个 `Stdio::piped()` 将 stdin/stdout/stderr 配置为管道。四个 `CLAWD_*` 环境变量传递插件身份和工具输入。如果有插件根目录，设置工作目录和 `CLAWD_PLUGIN_ROOT` 环境变量。

输入通过两种渠道传递：环境变量 `CLAWD_TOOL_INPUT`（适合简单脚本用 `$CLAWD_TOOL_INPUT` 读取）和 stdin（适合 Python/Node 脚本用 `json.load(sys.stdin)` 读取）。`spawn()` 启动子进程，`write_all` 写入 stdin，`wait_with_output()` 等待完成并收集输出。成功时返回 stdout（trim 后），失败时把 stderr 拼进错误信息。

## 11.4 Rust 插件系统：PluginManager 生命周期

`PluginManager` 是插件的生命周期中枢。`install` 方法展示了从来源到注册的完整路径：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

pub fn install(&mut self, source: &str) -> Result<InstallOutcome, PluginError> {
    let install_source = parse_install_source(source)?;
    let temp_root = self.install_root().join(".tmp");
    let staged_source = materialize_source(&install_source, &temp_root)?;
    let cleanup_source = matches!(install_source, PluginInstallSource::GitUrl { .. });
    let manifest = load_plugin_from_directory(&staged_source)?;

    let plugin_id = plugin_id(&manifest.name, EXTERNAL_MARKETPLACE);
    let install_path = self.install_root().join(sanitize_plugin_id(&plugin_id));
    if install_path.exists() {
        fs::remove_dir_all(&install_path)?;
    }
    copy_dir_all(&staged_source, &install_path)?;
    if cleanup_source {
        let _ = fs::remove_dir_all(&staged_source);
    }

    let mut registry = self.load_registry()?;
    registry.plugins.insert(plugin_id.clone(), record);
    self.store_registry(&registry)?;
    self.write_enabled_state(&plugin_id, Some(true))?;
    self.config.enabled_plugins.insert(plugin_id.clone(), true);

    Ok(InstallOutcome { plugin_id, version: manifest.version, install_path })
}
```

这段代码的执行步骤：`parse_install_source` 判断来源类型（Git URL 或本地路径），`materialize_source` 对 Git URL 执行 `git clone --depth 1` 到临时目录，对本地路径直接返回原路径。`load_plugin_from_directory` 解析 `plugin.json` 清单。`plugin_id` 拼接为 `name@external`，`sanitize_plugin_id` 清洗路径分隔符。如果安装目录已存在则先删除（覆盖安装），然后复制文件。Git 克隆的临时目录被清理，本地路径来源保留原目录。最后写入 `installed.json` 注册表和 `settings.json` 启用状态。

插件 ID 的拼接与清洗：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

fn plugin_id(name: &str, marketplace: &str) -> String {
    format!("{name}@{marketplace}")
}

fn sanitize_plugin_id(plugin_id: &str) -> String {
    plugin_id.chars().map(|ch| match ch {
        '/' | '\\' | '@' | ':' => '-',
        other => other,
    }).collect()
}
```

`plugin_id` 用 `@` 分隔名称和 marketplace。`sanitize_plugin_id` 把路径分隔符（`/`、`\`）、`@`、`:` 替换为 `-`，防止 ID 被用来构造文件路径时越界（如 `../../etc/passwd@external` 会被清洗为 `....-etc-passwd-external`）。这是一个安全措施——插件名来自外部输入（Git URL 或用户输入），必须经过清洗后才能用作文件系统路径。

清单加载不是直接反序列化，中间插入了兼容性检测：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

fn load_manifest_from_path(root: &Path, manifest_path: &Path) -> Result<PluginManifest, PluginError> {
    let contents = fs::read_to_string(manifest_path).map_err(...)?;
    let raw_json: Value = serde_json::from_str(&contents)?;
    let compatibility_errors = detect_claude_code_manifest_contract_gaps(&raw_json);
    if !compatibility_errors.is_empty() {
        return Err(PluginError::ManifestValidation(compatibility_errors));
    }
    let raw_manifest: RawPluginManifest = serde_json::from_value(raw_json)?;
    build_plugin_manifest(root, raw_manifest)
}
```

这段代码分两步解析：先用 `serde_json::from_str` 解析为通用的 `Value`（JSON AST），调用 `detect_claude_code_manifest_contract_gaps` 检查原版 Claude Code 插件契约中不被 claw 支持的特性。如果检测到不兼容字段，返回 `ManifestValidation` 错误。通过检测后再用 `from_value` 反序列化为 `RawPluginManifest`，最后用 `build_plugin_manifest` 构建强类型的 `PluginManifest`。但 claw 需要更精细的控制：不是拒绝所有未知字段，而是只拒绝特定的三个字段。

被拒绝的三个字段是 `skills`、`mcpServers`、`agents`。原版 Claude Code 允许插件清单直接携带这三类资源，claw 的契约有意收窄：插件只负责 hooks、lifecycle、tools、commands 四类扩展，技能从本地目录发现，MCP 服务器从配置加载，Agent 目录也不由插件管理。这是一个刻意的设计取舍，避免插件成为绕过其他子系统边界的隐式入口。

`uninstall` 对捆绑插件做了保护：

```rust
// claw-code/rust/crates/plugins/src/lib.rs (概念展示)
// PluginKind::Bundled 的记录不允许卸载，只能禁用
```

`PluginKind::Bundled` 的插件随发行包分发，不允许卸载——如果用户执行 `/plugins uninstall bundled-plugin`，会收到错误提示。但捆绑插件可以被禁用（`disable`），只是不能从磁盘删除。这把"随发行包分发的插件"与"用户自己安装的插件"区分开——前者由发行方管理生命周期，后者由用户管理。

## 11.5 Rust 插件系统：聚合与去重

多个插件的聚合在 `PluginRegistry` 层完成。`aggregated_hooks` 在第 8 章已详解，这里看 `aggregated_tools` 的去重逻辑：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

pub fn aggregated_tools(&self) -> Result<Vec<PluginTool>, PluginError> {
    let mut tools = Vec::new();
    let mut seen_names = BTreeMap::new();
    for plugin in self.plugins.iter().filter(|plugin| plugin.is_enabled()) {
        plugin.validate()?;
        for tool in plugin.tools() {
            if let Some(existing_plugin) =
                seen_names.insert(tool.definition().name.clone(), tool.plugin_id().to_string())
            {
                return Err(PluginError::InvalidManifest(format!(
                    "plugin tool `{}` is defined by both `{existing_plugin}` and `{}`",
                    tool.definition().name, tool.plugin_id()
                )));
            }
            tools.push(tool.clone());
        }
    }
    Ok(tools)
}
```

这段代码遍历所有已启用的插件，收集它们的工具并检测名称冲突。`seen_names` 是 `BTreeMap<String, String>`，键是工具名，值是定义该工具的插件 ID。`insert` 方法在键已存在时返回旧值 `Some(existing_plugin)`——检测到冲突时立即返回错误，错误消息明确指出两个冲突的插件 ID。

`PluginHooks::merged_with` 在第 8 章已展示，这里补充 `PluginLifecycle` 的聚合语义——Init 和 Shutdown 命令也按插件注册顺序拼接，与 hooks 的合并方式相同。

## 11.6 Rust 命令分发：SlashCommand 枚举

命令分发在 `rust/crates/commands/src/lib.rs`。核心是一个 60 多个变体的大枚举 `SlashCommand`：

```rust
// claw-code/rust/crates/commands/src/lib.rs

pub enum SlashCommand {
    Help,
    Status,
    Sandbox,
    Compact,
    Bughunter { scope: Option<String> },
    Commit,
    Pr { context: Option<String> },
    Model { model: Option<String> },
    Permissions { mode: Option<String> },
    Clear { confirm: bool },
    Cost,
    Resume { session_path: Option<String> },
    Config { section: Option<String> },
    Mcp { action: Option<String>, target: Option<String> },
    Plugins { action: Option<String>, target: Option<String> },
    Agents { args: Option<String> },
    Skills { args: Option<String> },
    // ... 其余 40 余个变体省略
    Unknown(String),
}
```

每个变体对应一个 `/` 开头的内置命令。无参命令是单元变体（`Help`、`Status`、`Commit`），带一个可选参数的用 `Option<String>`（`Model { model }`），带两个参数的用 `action` 加 `target` 成对字段（`Plugins`、`Mcp`），`Clear` 用 `bool` 参数表示是否确认。`Unknown(String)` 是兜底变体——无法识别的命令保留原始输入字符串。

解析入口 `validate_slash_command_input`：

```rust
// claw-code/rust/crates/commands/src/lib.rs

pub fn validate_slash_command_input(input: &str) -> Result<Option<SlashCommand>, SlashCommandParseError> {
    let trimmed = input.trim();
    if !trimmed.starts_with('/') {
        return Ok(None);
    }

    let mut parts = trimmed.trim_start_matches('/').split_whitespace();
    let command = parts.next().unwrap_or_default();
    if command.is_empty() {
        return Err(SlashCommandParseError::new(
            "Slash command name is missing. Use /help to list available slash commands.",
        ));
    }

    let args = parts.collect::<Vec<_>>();
    let remainder = remainder_after_command(trimmed, command);

    Ok(Some(match command {
        "help" => { validate_no_args(command, &args)?; SlashCommand::Help }
        "model" => SlashCommand::Model { model: optional_single_arg(command, &args, "[model]")? },
        "permissions" => SlashCommand::Permissions { mode: parse_permissions_mode(&args)? },
        // ...
    }))
}
```

这段代码的解析逻辑：第 3-4 行检查输入是否以 `/` 开头，不是则返回 `Ok(None)` 表示这不是命令。第 6-7 行去掉 `/` 后按空白分词，取第一个词作为命令名。第 8-11 行检查命令名是否为空（用户只输入了 `/`）。第 13-14 行收集剩余参数和命令名之后的完整文本。第 16-21 行的 `match` 根据命令名分发到对应的枚举变体，每个分支调用对应的参数校验函数。

三个辅助函数统一收口参数校验：`validate_no_args` 拒绝多余参数（如 `/help extra` 报错），`optional_single_arg` 读至多一个参数（如 `/model gpt-4` 或 `/model`），`require_remainder` 强制要求命令名之后的剩余文本（如 `/commit` 后面必须有提交信息）。这套函数把 60 多个命令的参数校验收敛到同一种模式，避免每个命令各自写一遍参数处理。

## 11.7 Rust 命令分发：元数据表与插件命令集成

命令元数据表 `SLASH_COMMAND_SPECS` 独立于枚举存在：

```rust
// claw-code/rust/crates/commands/src/lib.rs

const SLASH_COMMAND_SPECS: &[SlashCommandSpec] = &[
    SlashCommandSpec { name: "help", aliases: &[], summary: "Show available slash commands",
        argument_hint: None, resume_supported: true },
    SlashCommandSpec { name: "model", aliases: &[], summary: "Show or switch the active model",
        argument_hint: Some("[model]"), resume_supported: false },
    SlashCommandSpec { name: "permissions", aliases: &[], summary: "Show or switch the active permission mode",
        argument_hint: Some("[read-only|workspace-write|danger-full-access]"), resume_supported: false },
    // ...
];
```

每个 `SlashCommandSpec` 记录：`name`（规范名）、`aliases`（别名数组）、`summary`（一句话描述）、`argument_hint`（参数提示，用于 help 输出）、`resume_supported`（是否支持在 resume 模式下使用）。这张表与 `SlashCommand` 枚举分离——枚举用于解析和执行，元数据表用于展示和模糊匹配。

`/plugins` 命令把命令层和插件层连接起来：

```rust
// claw-code/rust/crates/commands/src/lib.rs

pub fn handle_plugins_slash_command(
    action: Option<&str>,
    target: Option<&str>,
    manager: &mut PluginManager,
) -> Result<PluginsCommandResult, PluginError> {
    match action {
        None | Some("list") => {
            let report = manager.installed_plugin_registry_report()?;
            let plugins: Vec<_> = if let Some(filter) = target {
                let needle = filter.to_lowercase();
                report.summaries().into_iter()
                    .filter(|p| p.metadata.id.to_lowercase().contains(&needle))
                    .collect()
            } else {
                report.summaries().into_iter().collect()
            };
            Ok(PluginsCommandResult { message: render_plugins_report_with_failures(&plugins, failures), reload_runtime: false })
        }
        Some("install") => {
            let Some(target) = target else {
                return Ok(PluginsCommandResult { message: "Usage: /plugins install <path>".to_string(), reload_runtime: false });
            };
            let install = manager.install(target)?;
            Ok(PluginsCommandResult { message: ..., reload_runtime: true })
        }
        Some("enable") => { /* manager.enable(...) */ }
        Some("disable") => { /* manager.disable(...) */ }
        // ...
    }
}
```

这段代码的 `match` 按 action 分发：`list`（或无 action）只读查看，支持按 target 过滤；`install` 安装新插件；`enable`/`disable` 修改启用状态。关键差异在 `reload_runtime` 字段——`list` 返回 `false`（只读操作，不需要重载运行时），`install`/`enable`/`disable` 返回 `true`（修改了插件集合，需要重载运行时让新配置生效）。调用方根据这个标志决定是否触发运行时重建。

技能命令的分发使用 `SkillSlashDispatch` 枚举：

```rust
// claw-code/rust/crates/commands/src/lib.rs

pub enum SkillSlashDispatch {
    Local,
    Invoke(String),
}
```

`Local` 表示技能在本地目录中找到，直接执行；`Invoke(String)` 表示技能未找到，把原始输入包装成对模型的请求，让模型自行解释。这条路径在命令层和技能层之间划出边界——命令层只负责识别技能是否存在，语义属于技能文件本身。

命令注册表 `CommandRegistry` 用 `CommandSource` 枚举区分三种来源：

```rust
// claw-code/rust/crates/commands/src/lib.rs

pub struct CommandManifestEntry {
    pub name: String,
    pub source: CommandSource,
}

pub enum CommandSource { Builtin, InternalOnly, FeatureGated }
```

`Builtin` 是默认可见的内置命令，`InternalOnly` 是不对外暴露的内部命令（如调试命令），`FeatureGated` 是受特性开关控制的命令。这个三级分类比 Python 侧靠字符串关键字猜测的分类更精确——它把"命令从哪来、谁可见"变成编译期类型信息。

二者都不共享内存，失败隔离靠进程边界——一个插件工具崩溃不会影响主进程。

`detect_claude_code_manifest_contract_gaps` 的设计值得注意。它在反序列化之前拦截清单字段，主动拒绝 `skills`、`mcpServers`、`agents` 三类扩展。这类似一个严格的 schema 校验器，但拒绝的动机不是格式错误，而是能力边界——插件不应该成为加载其他资源的隐式入口。

## 11.9 本章小结

本章覆盖了 claw-code 可扩展性的两层实现。Python 侧的 `plugins/__init__.py`、`commands.py`、`command_graph.py` 是镜像占位，从 `reference_data/subsystems/plugins.json` 和 `commands_snapshot.json` 读取原版存档元数据，把 207 条命令和 2 个插件模块标记为 `mirrored` 待移植。别名映射（`COMMAND_ALIASES`）和命令分类（`CommandGraph`）是 Python 侧仅有的"活"逻辑。

Rust 侧的 `plugins` crate 实现了完整的插件管理器：`PluginManifest` 清单契约定义了插件的六类扩展（hooks、lifecycle、tools、commands、permissions、metadata），`PluginKind` 三类来源（Builtin/Bundled/External）通过 marketplace 常量实现命名空间隔离，`PluginTool::execute` 的子进程模型通过环境变量和 stdin 双渠道传递上下文，`PluginManager::install` 的两步解析（先检测兼容性再反序列化）主动拒绝原版的 `skills`/`mcpServers`/`agents` 字段以守住能力边界，`aggregated_tools` 的 BTreeMap 去重防止多个插件声明同名工具。`commands` crate 实现了 60 余个变体的 `SlashCommand` 枚举和统一的参数校验三函数（`validate_no_args`/`optional_single_arg`/`require_remainder`），`handle_plugins_slash_command` 通过 `reload_runtime` 标志把命令层和运行时层连接起来——修改插件集合后自动触发运行时重建。
