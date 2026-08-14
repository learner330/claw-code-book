# 第8章 钩子系统：AOP 思想在 Agent 中的应用

## 本章概览

钩子（Hook）是 claw-code 扩展机制的核心。它允许用户在不修改 Agent 核心循环代码的前提下，在工具调用的生命周期节点上插入自定义脚本，实现拦截、审批、改写输入、追加反馈等能力。从 Java 工程师的视角看，钩子本质上就是 AOP（面向切面编程）——`PreToolUse` 相当于 `@Before`，`PostToolUse` 相当于 `@AfterReturning`，`PostToolUseFailure` 相当于 `@AfterThrowing`。

claw-code 的钩子系统分三层：Python 端的归档层只保留元数据快照，不做任何运行时工作；插件层（`rust/crates/plugins`）聚合多个插件声明的钩子命令并执行；运行时层（`rust/crates/runtime`）在 Turn Loop 中按配置触发钩子，解析结构化 JSON 输出，支持工具匹配器、中止信号、权限覆盖和输入改写。本章按照"归档层 → 插件层 → 运行时层 → Turn Loop 集成"的顺序逐层展开。

| 层级 | 源文件 | 核心结构 | 职责 |
| --- | --- | --- | --- |
| Python 归档 | `src/hooks/__init__.py` | `_SNAPSHOT` | 读取元数据，标记为已归档 |
| 插件层 | `rust/crates/plugins/src/hooks.rs` | `HookRunner` | 聚合多插件钩子，执行命令，退出码协议 |
| 插件层 | `rust/crates/plugins/src/lib.rs` | `PluginHooks` | 钩子声明结构，路径解析，合并 |
| 运行时层 | `rust/crates/runtime/src/hooks.rs` | `HookRunner` | 匹配器过滤，中止信号，JSON 解析，权限覆盖 |
| 运行时层 | `rust/crates/runtime/src/config.rs` | `RuntimeHookConfig` | 运行时钩子配置结构 |
| 运行时层 | `rust/crates/runtime/src/permissions.rs` | `PermissionOverride` | 钩子权限覆盖枚举 |

## 8.1 Python 端：归档的 TypeScript hooks 子系统

Python 包的 `src/hooks/` 目录里只有一个占位文件，它不包含任何逻辑，而是从元数据快照里读取归档信息。这种模式在 claw-code 的 Python 端反复出现——对于原版 TypeScript 前端模块，Python 端选择归档而非移植，因为它们与 Agent 核心循环无关。

下面这段代码展示了归档占位模块的标准写法。`load_archive_metadata` 从 JSON 快照文件读取元数据，然后模块级别把这些值导出为常量。对于 Java 工程师来说，这相当于一个只读的 DTO 类，字段全部由外部 JSON 配置注入，`frozen=True` 的 dataclass 或 `final` 修饰的不可变类是更接近的类比：

```python
# claw-code/src/hooks/__init__.py

"""Python package placeholder for the archived `hooks` subsystem."""

from src._archive_helper import load_archive_metadata

_SNAPSHOT = load_archive_metadata("hooks")

ARCHIVE_NAME = _SNAPSHOT["archive_name"]
MODULE_COUNT = _SNAPSHOT["module_count"]
SAMPLE_FILES = tuple(_SNAPSHOT["sample_files"])
PORTING_NOTE = f"Python package placeholder for '{ARCHIVE_NAME}' with {MODULE_COUNT} archived module references."
```

逐行分析：第 3 行从 `_archive_helper` 导入 `load_archive_metadata`，这个辅助函数接收子系统名称，返回一个字典。第 5 行调用它加载 `hooks` 子系统的快照，赋值给模块级变量 `_SNAPSHOT`。第 7-10 行从快照中提取四个字段并导出为公开常量：`ARCHIVE_NAME` 是子系统名称字符串，`MODULE_COUNT` 是归档模块总数，`SAMPLE_FILES` 转成 tuple 保证不可变性，`PORTING_NOTE` 用 f-string 拼接出一条移植说明。`_SNAPSHOT` 前面带下划线表示模块私有，外部不应直接访问。

快照文件本身存储了归档模块的样本信息：

```json
// claw-code/src/reference_data/subsystems/hooks.json

{
  "archive_name": "hooks",
  "package_name": "hooks",
  "module_count": 104,
  "sample_files": [
    "hooks/notifs/useRateLimitWarningNotification.tsx",
    "hooks/notifs/useModelMigrationNotifications.tsx",
    "hooks/toolPermission/PermissionContext.ts",
    "hooks/toolPermission/handlers/coordinatorHandler.ts",
    "hooks/toolPermission/handlers/interactiveHandler.ts",
    "hooks/unifiedSuggestions.ts",
    "hooks/useAfterFirstRender.ts"
  ]
}
```

这个 JSON 文件的结构与上面的 Python 代码一一对应。`module_count` 为 104，说明原版 TypeScript 项目中有 104 个与 hooks 相关的模块。`sample_files` 列出了 7 个代表性文件，从文件名可以看出它们几乎都是 `useXxx` 命名的 React 自定义钩子（`useRateLimitWarningNotification`、`useModelMigrationNotifications`、`useAfterFirstRender`）和工具权限处理组件（`PermissionContext`、`coordinatorHandler`、`interactiveHandler`）。这些模块属于原版 Claw Code 的 IDE 前端界面层，负责渲染"限流警告""模型迁移提示""权限确认弹窗"等 UI 状态，与 Agent 的核心推理循环无关，因此被归档而非移植。

## 8.2 插件层：PluginHooks 的声明与聚合

真正参与运行时的是 Rust 侧的两套钩子实现。插件层位于 `rust/crates/plugins`，负责把多个插件声明的钩子命令聚合起来执行；运行时层位于 `rust/crates/runtime`，负责在 Turn Loop 中按配置触发并解析结构化结果。

插件的钩子声明通过 `plugin.json` 清单文件完成。Rust 侧对应的数据结构是 `PluginHooks`，它把钩子按触发时机分成三组：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginHooks {
    #[serde(rename = "PreToolUse", default)]
    pub pre_tool_use: Vec<String>,
    #[serde(rename = "PostToolUse", default)]
    pub post_tool_use: Vec<String>,
    #[serde(rename = "PostToolUseFailure", default)]
    pub post_tool_use_failure: Vec<String>,
}
```

这段代码定义了插件钩子的数据结构。三个字段 `pre_tool_use`、`post_tool_use`、`post_tool_use_failure` 都是 `Vec<String>`，对应三个触发时机：工具执行前、工具执行后（成功）、工具执行后（失败）。每个元素是一个 shell 命令字符串或相对脚本路径。

关键设计在 `#[serde(rename = "PreToolUse", default)]` 这个属性：Rust 的命名惯例是 snake_case（`pre_tool_use`），但 `plugin.json` 里的键是 PascalCase（`PreToolUse`），serde 的 `rename` 属性让反序列化时自动匹配 PascalCase 键名。`default` 属性意味着如果 JSON 中缺少某个键，该字段使用 `Default::default()`（即空 `Vec`）而不是报错。这等价于 Java 中 Jackson 的 `@JsonProperty("PreToolUse")` + `@JsonSetter(nulls = Nulls.SKIP)` 组合。

仓库里的示例插件演示了完整的清单格式：

```json
// claw-code/rust/crates/plugins/bundled/sample-hooks/.claude-plugin/plugin.json

{
  "name": "sample-hooks",
  "version": "0.1.0",
  "description": "Bundled sample plugin scaffold for hook integration tests.",
  "defaultEnabled": false,
  "hooks": {
    "PreToolUse": ["./hooks/pre.sh"],
    "PostToolUse": ["./hooks/post.sh"]
  }
}
```

这个 JSON 清单声明了一个名为 `sample-hooks` 的示例插件。`defaultEnabled: false` 表示默认不启用。`hooks` 对象里只声明了 `PreToolUse` 和 `PostToolUse` 两组（没有 `PostToolUseFailure`），反序列化时第三个字段会走 `default` 路径得到空 `Vec`。`./hooks/pre.sh` 是相对路径，加载时会被解析为插件根目录下的绝对路径。

路径解析的逻辑区分字面命令和文件路径：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

fn resolve_hook_entry(root: &Path, entry: &str) -> String {
    if is_literal_command(entry) {
        entry.to_string()
    } else {
        root.join(entry).display().to_string()
    }
}

fn is_literal_command(entry: &str) -> bool {
    !entry.starts_with("./") && !entry.starts_with("../") && !Path::new(entry).is_absolute()
}
```

`resolve_hook_entry` 接收插件根路径 `root` 和钩子条目 `entry`，返回最终要执行的命令字符串。判断逻辑在 `is_literal_command` 中：如果条目不以 `./` 或 `../` 开头，且不是绝对路径（不以 `/` 开头），则视为字面 shell 命令原样保留；否则视为文件路径，拼接到插件根目录下。例如 `./hooks/pre.sh` 会被解析成 `/full/path/to/plugin/hooks/pre.sh`，而 `printf 'hello'` 则原样保留。

多个插件各自声明钩子，运行时需要合并成一份。`PluginRegistry::aggregated_hooks` 完成这个聚合：

```rust
// claw-code/rust/crates/plugins/src/lib.rs

pub fn aggregated_hooks(&self) -> Result<PluginHooks, PluginError> {
    self.plugins
        .iter()
        .filter(|plugin| plugin.is_enabled())
        .try_fold(PluginHooks::default(), |acc, plugin| {
            plugin.validate()?;
            Ok(acc.merged_with(plugin.hooks()))
        })
}
```

这段代码遍历所有已启用的插件，将它们的钩子合并到一个 `PluginHooks` 中。`try_fold` 是 Rust 迭代器的带错误传播的折叠操作，等价于 Java 的 `stream().reduce()` 但支持 `Result` 类型的短路。初始值是 `PluginHooks::default()`（三个空数组），每次迭代先调用 `plugin.validate()` 校验插件（包括钩子脚本路径是否存在），然后调用 `merged_with` 合并。`merged_with` 按触发时机分别拼接三个 `Vec`，因此同一个 PreToolUse 时机下，插件 A 和插件 B 的钩子会按插件注册顺序依次执行，类似于责任链模式。

## 8.3 插件层 HookRunner：命令执行与退出码协议

聚合出的 `PluginHooks` 交给插件层的 `HookRunner` 执行。它维护三个触发时机的入口方法，最终都收敛到 `run_commands`。

首先看触发事件的定义：

```rust
// claw-code/rust/crates/plugins/src/hooks.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
}
```

`HookEvent` 是一个 C 风格枚举，三个变体分别对应工具执行前、执行后（成功）、执行后（失败）。`Clone, Copy` trait 表示这个枚举可以低成本复制（它就是一个整数标签），类似于 Java 的 `enum`——Java 枚举天然是单例且可比较的。`as_str()` 方法返回每个变体对应的字符串表示（`"PreToolUse"` 等），用于环境变量传递和日志输出。

钩子执行结果用 `HookRunResult` 表达：

```rust
// claw-code/rust/crates/plugins/src/hooks.rs

pub struct HookRunResult {
    denied: bool,
    failed: bool,
    messages: Vec<String>,
}
```

插件层的 `HookRunResult` 只有三个字段：`denied` 表示钩子是否拒绝了这个工具调用，`failed` 表示钩子自身是否出错，`messages` 是钩子返回的反馈消息列表。字段都是私有的，通过 `is_denied()`、`is_failed()`、`messages()` 方法访问。相比运行时层的同名结构，这里没有 `cancelled`、`permission_override`、`permission_reason`、`updated_input` 等高级字段——插件层是精简版，只做基础的拦截和消息收集。

`HookRunner` 的结构非常简单：

```rust
// claw-code/rust/crates/plugins/src/hooks.rs

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HookRunner {
    hooks: PluginHooks,
}

impl HookRunner {
    pub fn new(hooks: PluginHooks) -> Self {
        Self { hooks }
    }

    pub fn from_registry(plugin_registry: &PluginRegistry) -> Result<Self, PluginError> {
        Ok(Self::new(plugin_registry.aggregated_hooks()?))
    }
}
```

`HookRunner` 只持有一个 `PluginHooks` 字段。`from_registry` 是工厂方法，从 `PluginRegistry` 聚合钩子后创建实例。`Default` trait 的实现让没有钩子时也能创建一个空运行的 runner。这对应 Java 中的 Builder 模式或工厂方法模式——`from_registry` 是工厂方法，`new` 是直接构造。

三个入口方法分别对应三个触发时机：

```rust
// claw-code/rust/crates/plugins/src/hooks.rs

pub fn run_pre_tool_use(&self, tool_name: &str, tool_input: &str) -> HookRunResult {
    Self::run_commands(
        HookEvent::PreToolUse,
        &self.hooks.pre_tool_use,
        tool_name,
        tool_input,
        None,
        false,
    )
}

pub fn run_post_tool_use(
    &self, tool_name: &str, tool_input: &str,
    tool_output: &str, is_error: bool,
) -> HookRunResult {
    Self::run_commands(
        HookEvent::PostToolUse,
        &self.hooks.post_tool_use,
        tool_name, tool_input,
        Some(tool_output), is_error,
    )
}

pub fn run_post_tool_use_failure(
    &self, tool_name: &str, tool_input: &str, tool_error: &str,
) -> HookRunResult {
    Self::run_commands(
        HookEvent::PostToolUseFailure,
        &self.hooks.post_tool_use_failure,
        tool_name, tool_input,
        Some(tool_error), true,
    )
}
```

这三个方法的签名差异反映了每个时机的语义差异。`run_pre_tool_use` 没有 `tool_output` 参数（工具还没执行，没有输出），`is_error` 固定为 `false`。`run_post_tool_use` 接收 `tool_output` 和 `is_error`——后者允许在成功调用后标记非错误结果。`run_post_tool_use_failure` 接收 `tool_error` 而非 `tool_output`，`is_error` 固定为 `true`。在 Java 中，这通常会用方法重载实现，但 Rust 没有方法重载，所以用不同方法名区分。

`run_commands` 是核心执行循环：

```rust
// claw-code/rust/crates/plugins/src/hooks.rs

fn run_commands(
    event: HookEvent,
    commands: &[String],
    tool_name: &str,
    tool_input: &str,
    tool_output: Option<&str>,
    is_error: bool,
) -> HookRunResult {
    if commands.is_empty() {
        return HookRunResult::allow(Vec::new());
    }

    let payload = hook_payload(event, tool_name, tool_input, tool_output, is_error).to_string();
    let mut messages = Vec::new();

    for command in commands {
        match Self::run_command(command, event, tool_name, tool_input,
                                tool_output, is_error, &payload) {
            HookCommandOutcome::Allow { message } => {
                if let Some(message) = message { messages.push(message); }
            }
            HookCommandOutcome::Deny { message } => {
                messages.push(message.unwrap_or_else(|| {
                    format!("{} hook denied tool `{tool_name}`", event.as_str())
                }));
                return HookRunResult { denied: true, failed: false, messages };
            }
            HookCommandOutcome::Failed { message } => {
                messages.push(message);
                return HookRunResult { denied: false, failed: true, messages };
            }
        }
    }
    HookRunResult::allow(messages)
}
```

这段代码是插件层钩子执行的核心循环。第 2 行先检查命令列表是否为空，空则直接返回 `allow`。第 5 行生成 JSON payload，这个 payload 会通过 stdin 传给钩子脚本。第 8-18 行遍历每条命令执行，`match` 分支处理三种结果：`Allow` 时收集消息继续下一条，`Deny` 时收集消息后立即短路返回（设置 `denied: true`），`Failed` 时同样短路返回（设置 `failed: true`）。短路语义意味着第一个 Deny 或 Failed 的钩子会阻止后续钩子执行，类似于 Java 中 `&&` 运算符的短路行为。

`run_command` 是单条命令的执行器。执行前通过环境变量向钩子脚本传递上下文：

```rust
// claw-code/rust/crates/plugins/src/hooks.rs

fn run_command(command: &str, event: HookEvent, tool_name: &str,
               tool_input: &str, tool_output: Option<&str>,
               is_error: bool, payload: &str) -> HookCommandOutcome {
    let mut child = shell_command(command);
    child.stdin(std::process::Stdio::piped());
    child.stdout(std::process::Stdio::piped());
    child.stderr(std::process::Stdio::piped());
    child.env("HOOK_EVENT", event.as_str());
    child.env("HOOK_TOOL_NAME", tool_name);
    child.env("HOOK_TOOL_INPUT", tool_input);
    child.env("HOOK_TOOL_IS_ERROR", if is_error { "1" } else { "0" });
    if let Some(tool_output) = tool_output {
        child.env("HOOK_TOOL_OUTPUT", tool_output);
    }
    // ...
}
```

钩子脚本有两种获取上下文的渠道：环境变量和 stdin JSON。环境变量是简单键值对，适合 shell 脚本直接 `$HOOK_TOOL_NAME` 读取；stdin JSON 是结构化数据，适合 Python/Node 脚本解析。两种渠道传递的信息内容相同，但格式不同——环境变量是扁平字符串，stdin 是嵌套 JSON。

同时把一份 JSON payload 通过 stdin 写入子进程。`hook_payload` 生成这份 JSON：

```rust
// claw-code/rust/crates/plugins/src/hooks.rs

fn hook_payload(event: HookEvent, tool_name: &str, tool_input: &str,
                tool_output: Option<&str>, is_error: bool) -> serde_json::Value {
    match event {
        HookEvent::PostToolUseFailure => json!({
            "hook_event_name": event.as_str(),
            "tool_name": tool_name,
            "tool_input": parse_tool_input(tool_input),
            "tool_input_json": tool_input,
            "tool_error": tool_output,
            "tool_result_is_error": true,
        }),
        _ => json!({
            "hook_event_name": event.as_str(),
            "tool_name": tool_name,
            "tool_input": parse_tool_input(tool_input),
            "tool_input_json": tool_input,
            "tool_output": tool_output,
            "tool_result_is_error": is_error,
        }),
    }
}

fn parse_tool_input(tool_input: &str) -> serde_json::Value {
    serde_json::from_str(tool_input).unwrap_or_else(|_| json!({ "raw": tool_input }))
}
```

`hook_payload` 根据 `HookEvent` 分两种格式：`PostToolUseFailure` 使用 `tool_error` 字段名（语义上更准确），其他事件使用 `tool_output`。`parse_tool_input` 尝试把 `tool_input` 字符串解析成 JSON 对象，失败时退化为 `{"raw": tool_input}`。同时保留 `tool_input_json` 原始字符串，让钩子脚本可以根据自身能力选择解析后的结构或原始字符串。这种"双格式"设计在 Java 中不常见，因为 Java 通常用强类型 DTO 统一表示，但 shell 脚本和轻量脚本的灵活性要求使得同时提供两种格式更实用。

退出码是钩子与主程序之间的核心协议。`run_command` 按固定规则解释退出码：

```rust
// claw-code/rust/crates/plugins/src/hooks.rs

match output.status.code() {
    Some(0) => HookCommandOutcome::Allow { message },
    Some(2) => HookCommandOutcome::Deny { message },
    Some(code) => HookCommandOutcome::Failed {
        message: format_hook_warning(command, code, message.as_deref(), stderr.as_str()),
    },
    None => HookCommandOutcome::Failed {
        message: format!(
            "{} hook `{command}` terminated by signal while handling `{tool_name}`",
            event.as_str()
        ),
    },
}
```

退出码协议的含义：`0` 表示允许，stdout 作为反馈消息；`2` 表示拒绝，主程序将停止该工具的执行；其他退出码表示钩子自身出错；`None` 表示进程被信号杀死（如 SIGKILL），同样视为 Failed。选择退出码 2 而非 1 作为"拒绝"的信号，是因为 1 在 shell 脚本中太容易意外触发（任何未捕获的错误都可能返回 1），而 2 是一个更刻意的选择，类似于 HTTP 状态码中 4xx 和 5xx 的区分。

| 退出码 | 含义 | 后续动作 |
| --- | --- | --- |
| 0 | 允许，stdout 作为反馈消息 | 继续执行下一条钩子 |
| 2 | 拒绝 | 立即返回 `denied`，停止执行剩余钩子 |
| 其他 | 钩子自身失败 | 立即返回 `failed`，停止执行剩余钩子 |
| 被信号终止 | 钩子异常 | 返回 `failed` |

命令的启动方式由 `shell_command` 决定，跨平台做了分支处理：

```rust
// claw-code/rust/crates/plugins/src/hooks.rs

fn shell_command(command: &str) -> CommandWithStdin {
    #[cfg(windows)]
    let command_builder = {
        let mut command_builder = Command::new("cmd");
        command_builder.arg("/C").arg(command);
        CommandWithStdin::new(command_builder)
    };

    #[cfg(not(windows))]
    let command_builder = {
        let mut command_builder = Command::new("sh");
        command_builder.arg("-lc").arg(command);
        CommandWithStdin::new(command_builder)
    };

    command_builder
}
```

`#[cfg(windows)]` 和 `#[cfg(not(windows))]` 是 Rust 的条件编译属性，编译时只保留匹配目标平台的分支。Windows 用 `cmd /C` 执行命令，Unix 用 `sh -lc`。`-l` 表示登录 shell（会加载用户的 profile），`-c` 表示从参数读取命令。`CommandWithStdin` 是一个封装了 `std::process::Command` 的辅助结构体，提供链式 API 配置 stdin/stdout/stderr 管道。与运行时层不同，插件层的 `shell_command` 不做"文件路径检测"——所有命令统一用 `sh -lc` 走 shell 解析，因为插件层的钩子条目已经在加载阶段被 `resolve_hook_entry` 解析成了完整路径或字面命令。

## 8.4 运行时层：配置结构与工具匹配器

运行时层的 `HookRunner` 位于 `rust/crates/runtime/src/hooks.rs`，它读取的是运行时配置而非插件清单，能力比插件层更完整。差异首先体现在配置结构上。

运行时钩子配置定义在 `config.rs` 中：

```rust
// claw-code/rust/crates/runtime/src/config.rs

/// Hook command lists grouped by lifecycle stage.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RuntimeHookConfig {
    pre_tool_use: Vec<RuntimeHookCommand>,
    post_tool_use: Vec<RuntimeHookCommand>,
    post_tool_use_failure: Vec<RuntimeHookCommand>,
    invalid_hooks: Vec<RuntimeInvalidHookConfig>,
}
```

与插件层的 `PluginHooks` 对比，`RuntimeHookConfig` 有两个显著差异：第一，命令类型从 `Vec<String>` 升级为 `Vec<RuntimeHookCommand>`，每条命令可以携带工具匹配器；第二，多了 `invalid_hooks` 字段，用于记录配置解析阶段发现的无效钩子条目，而非直接报错丢弃——这让用户能看到配置错误的同时不影响有效钩子的运行。

`RuntimeHookCommand` 的结构：

```rust
// claw-code/rust/crates/runtime/src/config.rs

/// A hook command plus optional tool matcher from object-style hook config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeHookCommand {
    command: String,
    matcher: Option<String>,
}
```

`command` 是 shell 命令字符串，`matcher` 是可选的工具名匹配器。当配置使用字符串风格（`"echo hello"`）时，`matcher` 为 `None`，对所有工具生效；当配置使用对象风格（`{"command": "echo hello", "matcher": "Bash"}`）时，`matcher` 为 `Some("Bash")`，只对匹配的工具生效。

匹配逻辑实现为 `matches_tool` 方法：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub fn matches_tool(&self, tool_name: &str) -> bool {
    self.matcher
        .as_deref()
        .is_none_or(|matcher| hook_matcher_matches(matcher, tool_name))
}

fn hook_matcher_matches(matcher: &str, tool_name: &str) -> bool {
    matcher
        .split([',', '|'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .any(|part| {
            part == "*" || part.eq_ignore_ascii_case(tool_name) || wildcard_match(part, tool_name)
        })
}
```

`matches_tool` 中 `is_none_or` 是 Rust 1.82 引入的方法：如果 `matcher` 是 `None`，返回 `true`（没有匹配器意味着对所有工具生效）；如果有匹配器，调用 `hook_matcher_matches`。后者支持丰富的匹配语法：用逗号或竖线分隔多个模式（`"Bash,Write"` 匹配 Bash 或 Write），`*` 匹配所有工具，精确匹配忽略大小写（`eq_ignore_ascii_case`），还支持 `wildcard_match` 做通配符匹配（如 `Bash*` 匹配 `BashOutput`）。

`RuntimeInvalidHookConfig` 记录配置解析过程中的问题：

```rust
// claw-code/rust/crates/runtime/src/config.rs

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeInvalidHookConfig {
    pub event: String,
    pub index: Option<usize>,
    pub hook_index: Option<usize>,
    pub kind: String,
    pub error_field: String,
    // ...
}
```

每个字段的作用：`event` 是触发时机名称（如 `"PreToolUse"`），`index` 和 `hook_index` 是配置项在数组中的位置（用于错误定位），`kind` 是错误类型分类，`error_field` 标明具体哪个字段有问题。这些信息最终会以友好的方式呈现给用户，帮助他们修正配置。在 Java 中，这相当于一个校验错误 DTO，配合 `Validator` 模式使用。

## 8.5 运行时层：HookRunner 的数据结构

运行时层的 `HookRunner` 比插件层的同名结构复杂得多。先看触发事件和进度报告：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookProgressEvent {
    Started { event: HookEvent, tool_name: String, command: String },
    Completed { event: HookEvent, tool_name: String, command: String },
    Cancelled { event: HookEvent, tool_name: String, command: String },
}
```

`HookProgressEvent` 是新增的结构，插件层没有。它的三个变体分别表示钩子命令的开始、完成和取消。这是一个观察者模式的实现——`HookProgressReporter` trait 定义了接收这些事件的接口：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

pub trait HookProgressReporter: Send {
    fn on_event(&mut self, event: &HookProgressEvent);
}
```

`Send` trait 约束要求实现者可以安全地在线程间转移所有权。在 Java 中，这相当于一个回调接口（`interface HookProgressReporter { void onEvent(HookProgressEvent event); }`），`Send` 约束类似于声明该实现是线程安全的。运行时层在前端需要展示钩子执行进度时，传入一个实现了此 trait 的 reporter，每条钩子命令的 Started/Completed/Cancelled 事件都会被上报。

中止信号是运行时层的另一个关键能力：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

pub struct HookAbortSignal {
    aborted: Arc<AtomicBool>,
}

impl HookAbortSignal {
    pub fn new() -> Self {
        Self { aborted: Arc::new(AtomicBool::new(false)) }
    }

    pub fn abort(&self) {
        self.aborted.store(true, Ordering::Release);
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::Acquire)
    }
}
```

`HookAbortSignal` 包装了一个 `Arc<AtomicBool>`。`Arc`（Atomic Reference Counted）是 Rust 的线程安全引用计数指针，允许多个所有者共享同一个布尔值。`abort()` 用 `Ordering::Release` 写入 `true`，`is_aborted()` 用 `Ordering::Acquire` 读取。`Release/Acquire` 内存序保证了写入对其他线程立即可见——这对跨线程的中止信号至关重要。在 Java 中，这等价于 `volatile boolean aborted` 或 `AtomicBoolean`，但 Rust 的 `Arc` 还保证了引用计数的线程安全。

钩子执行结果 `HookRunResult` 也比插件层更丰富：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

pub struct HookRunResult {
    denied: bool,
    failed: bool,
    cancelled: bool,
    messages: Vec<String>,
    permission_override: Option<PermissionOverride>,
    permission_reason: Option<String>,
    updated_input: Option<String>,
}
```

新增了三个字段：`cancelled` 标记钩子被中止信号取消；`permission_override` 携带钩子返回的权限覆盖指令（Allow/Deny/Ask），可以短路权限系统的正常评估流程；`updated_input` 携带钩子改写后的工具输入，让钩子能在工具执行前修改参数。`allow()` 是一个工厂方法，创建一个所有字段都是默认值的结果：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

impl HookRunResult {
    pub fn allow(messages: Vec<String>) -> Self {
        Self {
            denied: false,
            failed: false,
            cancelled: false,
            messages,
            permission_override: None,
            permission_reason: None,
            updated_input: None,
        }
    }
}
```

`PermissionOverride` 枚举定义在 `permissions.rs` 中，用于钩子对权限系统的干预：

```rust
// claw-code/rust/crates/runtime/src/permissions.rs

/// Hook-provided override applied before standard permission evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionOverride {
    Allow,
    Deny,
    Ask,
}
```

三个变体分别表示：`Allow` 允许工具执行（但仍受 `ask` 规则约束），`Deny` 无条件拒绝，`Ask` 强制进入交互确认流程。这个枚举会被 `PermissionContext` 携带，在 `PermissionPolicy::authorize_with_context` 的评估流程中插入到 `deny` 规则和 `ask` 规则之间，形成"Hook override → ask 规则 → allow 规则/模式检查"的评估顺序。

`HookRunner` 的构造方法：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

pub struct HookRunner {
    config: RuntimeHookConfig,
}

impl HookRunner {
    pub fn new(config: RuntimeHookConfig) -> Self {
        Self { config }
    }

    pub fn from_feature_config(feature_config: &RuntimeFeatureConfig) -> Self {
        Self::new(feature_config.hooks().clone())
    }
}
```

`from_feature_config` 从运行时特性配置中提取钩子配置。`RuntimeFeatureConfig` 是整个运行时的配置聚合体，`hooks()` 方法返回 `&RuntimeHookConfig` 的引用，`clone()` 复制一份后传给 `new()`。在 Java 中这相当于 `new HookRunner(config.getHooks())`。

## 8.6 运行时层：run_commands 执行循环

运行时层的 `run_commands` 是整个钩子系统的核心方法，它接收比插件层更多的参数：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

fn run_commands(
    event: HookEvent,
    commands: &[RuntimeHookCommand],
    tool_name: &str,
    tool_input: &str,
    tool_output: Option<&str>,
    is_error: bool,
    abort_signal: Option<&HookAbortSignal>,
    mut reporter: Option<&mut dyn HookProgressReporter>,
) -> HookRunResult {
    if commands.is_empty() {
        return HookRunResult::allow(Vec::new());
    }

    if abort_signal.is_some_and(HookAbortSignal::is_aborted) {
        return HookRunResult {
            denied: false, failed: false, cancelled: true,
            messages: vec![format!("{} hook cancelled before execution", event.as_str())],
            permission_override: None, permission_reason: None, updated_input: None,
        };
    }

    let payload = hook_payload(event, tool_name, tool_input, tool_output, is_error).to_string();
    let mut result = HookRunResult::allow(Vec::new());

    for command in commands
        .iter()
        .filter(|command| command.matches_tool(tool_name))
    {
        // ...
    }
    result
}
```

与插件层的 `run_commands` 相比，这段代码多了两个前置检查和工具匹配器过滤。第 6-7 行检查命令列表是否为空。第 9-15 行检查中止信号——如果信号已经被触发，直接返回 `cancelled` 状态，不执行任何钩子。第 17 行生成 JSON payload。第 21-22 行的 `filter(|command| command.matches_tool(tool_name))` 是运行时层独有的：它根据每条命令的 matcher 过滤，只执行匹配当前工具的钩子。

循环体内部处理每条命令的执行结果：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

for command in commands.iter().filter(|c| c.matches_tool(tool_name)) {
    let command_text = command.command();
    if let Some(reporter) = reporter.as_deref_mut() {
        reporter.on_event(&HookProgressEvent::Started {
            event, tool_name: tool_name.to_string(),
            command: command_text.to_string(),
        });
    }

    match Self::run_command(command_text, event, tool_name, tool_input,
                           tool_output, is_error, &payload, abort_signal) {
        HookCommandOutcome::Allow { parsed } => {
            if let Some(reporter) = reporter.as_deref_mut() {
                reporter.on_event(&HookProgressEvent::Completed { /* ... */ });
            }
            merge_parsed_hook_output(&mut result, parsed);
        }
        HookCommandOutcome::Deny { parsed } => {
            if let Some(reporter) = reporter.as_deref_mut() {
                reporter.on_event(&HookProgressEvent::Completed { /* ... */ });
            }
            merge_parsed_hook_output(&mut result, parsed);
            result.denied = true;
            return result;
        }
        HookCommandOutcome::Failed { parsed } => {
            // 同上，reporter.on_event Completed
            merge_parsed_hook_output(&mut result, parsed);
            result.failed = true;
            return result;
        }
        HookCommandOutcome::Cancelled { message } => {
            if let Some(reporter) = reporter.as_deref_mut() {
                reporter.on_event(&HookProgressEvent::Cancelled { /* ... */ });
            }
            result.cancelled = true;
            result.messages.push(message);
            return result;
        }
    }
}
```

这段循环的逻辑与插件层类似但更丰富。每条命令执行前上报 `Started` 事件，执行后根据结果上报 `Completed` 或 `Cancelled` 事件。四种结果中，`Allow` 继续执行下一条，其余三种短路返回。关键差异在于 `merge_parsed_hook_output`——它不像插件层那样只收集消息，而是把 `ParsedHookOutput` 中的 `permission_override`、`permission_reason`、`updated_input` 也合并到累积结果中。

`merge_parsed_hook_output` 的实现：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

fn merge_parsed_hook_output(target: &mut HookRunResult, parsed: ParsedHookOutput) {
    target.messages.extend(parsed.messages);
    if parsed.permission_override.is_some() {
        target.permission_override = parsed.permission_override;
    }
    if parsed.permission_reason.is_some() {
        target.permission_reason = parsed.permission_reason;
    }
    if parsed.updated_input.is_some() {
        target.updated_input = parsed.updated_input;
    }
}
```

消息列表是追加的（`extend`），但 `permission_override`、`permission_reason`、`updated_input` 是覆盖的——后执行的钩子可以覆盖先执行钩子的覆盖指令。这意味着如果插件 A 的 PreToolUse 钩子返回 `Allow`，插件 B 的 PreToolUse 钩子返回 `Deny`，最终结果是 `Deny`。这个设计符合"最后说话的钩子优先"的语义，类似于责任链中后置处理器的优先级更高。

## 8.7 运行时层：run_command 与退出码增强

运行时层的 `run_command` 在插件层基础上增加了中止信号轮询和结构化输出解析。先看环境变量设置部分（与插件层一致）：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

fn run_command(
    command: &str, event: HookEvent, tool_name: &str,
    tool_input: &str, tool_output: Option<&str>, is_error: bool,
    payload: &str, abort_signal: Option<&HookAbortSignal>,
) -> HookCommandOutcome {
    let mut child = shell_command(command);
    child.stdin(Stdio::piped());
    child.stdout(Stdio::piped());
    child.stderr(Stdio::piped());
    child.env("HOOK_EVENT", event.as_str());
    child.env("HOOK_TOOL_NAME", tool_name);
    child.env("HOOK_TOOL_INPUT", tool_input);
    child.env("HOOK_TOOL_IS_ERROR", if is_error { "1" } else { "0" });
    if let Some(tool_output) = tool_output {
        child.env("HOOK_TOOL_OUTPUT", tool_output);
    }

    match child.output_with_stdin(payload.as_bytes(), abort_signal) {
        // ...
    }
}
```

环境变量设置与插件层完全相同。差异在于 `output_with_stdin` 接收一个额外的 `abort_signal` 参数，这个参数会在子进程执行期间被轮询检查。

退出码处理部分也比插件层更复杂：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

match child.output_with_stdin(payload.as_bytes(), abort_signal) {
    Ok(CommandExecution::Finished(output)) => {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let parsed = parse_hook_output(event, tool_name, command, &stdout, &stderr);
        let primary_message = parsed.primary_message().map(ToOwned::to_owned);
        match output.status.code() {
            Some(0) => {
                if parsed.deny {
                    HookCommandOutcome::Deny { parsed }
                } else {
                    HookCommandOutcome::Allow { parsed }
                }
            }
            Some(2) => HookCommandOutcome::Deny {
                parsed: parsed.with_fallback_message(format!(
                    "{} hook denied tool `{tool_name}`", event.as_str()
                )),
            },
            Some(code) => HookCommandOutcome::Failed {
                parsed: parsed.with_fallback_message(format_hook_failure(
                    command, code, primary_message.as_deref(), stderr.as_str(),
                )),
            },
            None => HookCommandOutcome::Failed {
                parsed: ParsedHookOutput {
                    messages: vec![format!(
                        "{} hook `{command}` terminated by signal while handling `{tool_name}`",
                        event.as_str()
                    )],
                    ..ParsedHookOutput::default()
                },
            },
        }
    }
    Ok(CommandExecution::Cancelled) => HookCommandOutcome::Cancelled {
        message: format!(
            "{} hook `{command}` cancelled while handling `{tool_name}`",
            event.as_str()
        ),
    },
    Err(error) => HookCommandOutcome::Failed {
        parsed: ParsedHookOutput {
            messages: vec![format!(
                "{} hook `{command}` failed to start for `{tool_name}`: {error}",
                event.as_str()
            )],
            ..ParsedHookOutput::default()
        },
    },
}
```

与插件层对比，退出码 0 的处理有一个关键增强：即使退出码是 0，如果 `parse_hook_output` 从 stdout JSON 中解析出了 `deny` 字段（`parsed.deny == true`），也会返回 `Deny` 而非 `Allow`。这意味着钩子脚本可以通过 JSON 输出表达"拒绝"意图，而不仅依赖退出码 2。这种双通道拒绝机制让钩子脚本更灵活——退出码 0 可以附带结构化 JSON 输出表达更丰富的语义。

`HookCommandOutcome` 也比插件层多了一个 `Cancelled` 变体：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

enum HookCommandOutcome {
    Allow { parsed: ParsedHookOutput },
    Deny { parsed: ParsedHookOutput },
    Failed { parsed: ParsedHookOutput },
    Cancelled { message: String },
}
```

前三个变体都携带 `ParsedHookOutput`，而 `Cancelled` 只携带一个消息字符串——因为取消时子进程的输出可能不完整，无法可靠解析。

## 8.8 运行时层：中止信号轮询机制

`CommandWithStdin::output_with_stdin` 是运行时层独有的方法，它用轮询代替阻塞等待，实现了钩子的可取消执行：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

struct CommandWithStdin {
    command: Command,
}

impl CommandWithStdin {
    fn output_with_stdin(
        &mut self,
        stdin: &[u8],
        abort_signal: Option<&HookAbortSignal>,
    ) -> std::io::Result<CommandExecution> {
        let mut child = self.command.spawn()?;
        if let Some(mut child_stdin) = child.stdin.take() {
            child_stdin.write_all(stdin)?;
        }

        loop {
            if abort_signal.is_some_and(HookAbortSignal::is_aborted) {
                let _ = child.kill();
                let _ = child.wait_with_output();
                return Ok(CommandExecution::Cancelled);
            }

            match child.try_wait()? {
                Some(_) => return child.wait_with_output().map(CommandExecution::Finished),
                None => thread::sleep(Duration::from_millis(20)),
            }
        }
    }
}

enum CommandExecution {
    Finished(std::process::Output),
    Cancelled,
}
```

这段代码是整个中止机制的核心。第 5 行调用 `spawn()` 启动子进程。第 6-8 行通过 stdin 写入 JSON payload。第 10-20 行是一个轮询循环：每 20 毫秒检查一次中止信号，如果被触发就 `kill()` 子进程并返回 `Cancelled`；否则用 `try_wait()` 非阻塞地检查子进程是否结束，结束了就收集输出返回 `Finished`，没结束就 sleep 20ms 继续轮询。

`try_wait()` 是 Rust 标准库提供的非阻塞等待方法，它不会挂起当前线程，而是立即返回 `Option<ExitStatus>`：`Some` 表示子进程已退出，`None` 表示仍在运行。这与 Java 的 `Process.waitFor(timeout, unit)` 类似，但 Rust 的实现是手动轮询而非基于事件通知。

20 毫秒的轮询间隔是一个权衡：太短会浪费 CPU 周期，太长会增加中止延迟。在实际使用中，钩子脚本通常很快（几百毫秒内完成），20ms 的延迟对用户体验几乎无感知。

`CommandWithStdin` 还封装了 stdin/stdout/stderr 的管道配置和环境变量设置方法，这些都是对 `std::process::Command` 的链式调用封装：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

impl CommandWithStdin {
    fn new(command: Command) -> Self { Self { command } }
    fn stdin(&mut self, cfg: Stdio) -> &mut Self { self.command.stdin(cfg); self }
    fn stdout(&mut self, cfg: Stdio) -> &mut Self { self.command.stdout(cfg); self }
    fn stderr(&mut self, cfg: Stdio) -> &mut Self { self.command.stderr(cfg); self }
    fn env<K, V>(&mut self, key: K, value: V) -> &mut Self
    where K: AsRef<OsStr>, V: AsRef<OsStr> {
        self.command.env(key, value); self
    }
}
```

每个方法都返回 `&mut Self`，实现了流式 API。这与 Java Builder 模式的效果相同——`builder.stdin(piped).stdout(piped).stderr(piped).env("KEY", "value")`。Rust 的 `&mut Self` 返回类型比 Java 的 Builder 更轻量，因为不需要创建新对象，而是在原对象上修改后返回可变引用。

运行时层的 `shell_command` 与插件层有一个细微差异：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

fn shell_command(command: &str) -> CommandWithStdin {
    #[cfg(windows)]
    let command_builder = {
        let mut command_builder = Command::new("cmd");
        command_builder.arg("/C").arg(command);
        CommandWithStdin::new(command_builder)
    };

    #[cfg(not(windows))]
    let command_builder = {
        let mut command_builder = Command::new("sh");
        command_builder.arg("-lc").arg(command);
        CommandWithStdin::new(command_builder)
    };

    command_builder
}
```

与插件层的对比：插件层在 Unix 下会先检测命令是否是已存在的文件路径，如果是则用 `sh command`（不加 `-c`），否则用 `sh -lc command`。运行时层统一用 `sh -lc`，不做文件路径检测——因为运行时层的钩子命令来源是用户配置文件，已经在配置解析阶段完成了路径验证。这种差异体现了"同一问题的不同上下文需要不同处理"的工程原则。

## 8.9 运行时层：结构化 JSON 输出解析

`parse_hook_output` 是运行时层最复杂的函数之一。插件层把 stdout 原样当作消息字符串，而运行时版本尝试把 stdout 解析成 JSON 结构，从中提取拒绝信号、权限覆盖、输入改写等高级指令。

先看 `ParsedHookOutput` 结构：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct ParsedHookOutput {
    messages: Vec<String>,
    deny: bool,
    permission_override: Option<PermissionOverride>,
    permission_reason: Option<String>,
    updated_input: Option<String>,
}
```

五个字段：`messages` 是反馈消息列表，`deny` 是从 JSON 中解析出的拒绝标志，`permission_override` 是权限覆盖指令，`permission_reason` 是覆盖原因说明，`updated_input` 是改写后的工具输入。`Default` trait 的派生让所有字段初始化为空值（`false`、`None`、`Vec::new()`）。

辅助方法：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

impl ParsedHookOutput {
    fn with_fallback_message(mut self, fallback: String) -> Self {
        if self.messages.is_empty() {
            self.messages.push(fallback);
        }
        self
    }

    fn primary_message(&self) -> Option<&str> {
        self.messages.first().map(String::as_str)
    }
}
```

`with_fallback_message` 在消息列表为空时填充一条默认消息——这用于退出码非 0 但钩子没有输出有用信息的情况。`primary_message` 返回第一条消息，用于错误报告中的主要信息展示。

现在看 `parse_hook_output` 的完整实现：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

fn parse_hook_output(
    event: HookEvent, tool_name: &str, command: &str,
    stdout: &str, stderr: &str,
) -> ParsedHookOutput {
    if stdout.is_empty() {
        return ParsedHookOutput::default();
    }

    let root = match serde_json::from_str::<Value>(stdout) {
        Ok(Value::Object(root)) => root,
        Ok(value) => {
            return ParsedHookOutput {
                messages: vec![format_invalid_hook_output(
                    event, tool_name, command,
                    &format!("expected top-level JSON object, got {}", json_type_name(&value)),
                    stdout, stderr,
                )],
                ..ParsedHookOutput::default()
            };
        }
        Err(error) if looks_like_json_attempt(stdout) => {
            return ParsedHookOutput {
                messages: vec![format_invalid_hook_output(
                    event, tool_name, command,
                    &error.to_string(), stdout, stderr,
                )],
                ..ParsedHookOutput::default()
            };
        }
        Err(_) => {
            return ParsedHookOutput {
                messages: vec![stdout.to_string()],
                ..ParsedHookOutput::default()
            };
        }
    };
    // ...
}
```

这段代码处理 stdout 的三种情况。第 3-4 行：stdout 为空时返回默认值。第 6-26 行的 `match` 分三种路径：第一种（第 7 行）成功解析为 JSON 对象，继续后续字段提取；第二种（第 8-14 行）成功解析为 JSON 但不是对象类型（如数组、字符串、数字），返回一条格式错误提示；第三种（第 15-21 行）解析失败但 stdout 看起来像 JSON（以 `{` 或 `[` 开头），说明用户尝试输出 JSON 但格式有误，返回解析错误详情；第四种（第 22-27 行）解析失败且不像 JSON，把 stdout 原样作为消息——这保持了向后兼容，让不输出 JSON 的简单钩子脚本也能工作。

`looks_like_json_attempt` 的实现很简单：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

fn looks_like_json_attempt(value: &str) -> bool {
    matches!(value.trim_start().chars().next(), Some('{' | '['))
}
```

只检查第一个非空白字符是否是 `{` 或 `[`。如果是，说明用户尝试输出 JSON 但格式有误，应该给出错误提示帮助调试；如果不是，说明用户输出的就是纯文本，原样保留即可。

成功解析为 JSON 对象后的字段提取：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

let mut parsed = ParsedHookOutput::default();

if let Some(message) = root.get("systemMessage").and_then(Value::as_str) {
    parsed.messages.push(message.to_string());
}
if let Some(message) = root.get("reason").and_then(Value::as_str) {
    parsed.messages.push(message.to_string());
}
if root.get("continue").and_then(Value::as_bool) == Some(false)
    || root.get("decision").and_then(Value::as_str) == Some("block")
{
    parsed.deny = true;
}
```

这段代码从 JSON 根对象中提取三个顶层字段。`systemMessage` 和 `reason` 都是消息字符串，会被追加到 `parsed.messages`。拒绝信号有两种表达方式：`"continue": false` 或 `"decision": "block"`——前者是布尔标志，后者是字符串枚举。支持两种格式是为了兼容不同的钩子脚本风格。`and_then(Value::as_str)` 是 Rust `Option` 的链式调用，等价于 Java 的 `Optional.map(...).filter(...)`。

更高级的字段从 `hookSpecificOutput` 子对象中提取：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

if let Some(Value::Object(specific)) = root.get("hookSpecificOutput") {
    if let Some(Value::String(additional_context)) = specific.get("additionalContext") {
        parsed.messages.push(additional_context.clone());
    }
    if let Some(decision) = specific.get("permissionDecision").and_then(Value::as_str) {
        parsed.permission_override = match decision {
            "allow" => Some(PermissionOverride::Allow),
            "deny" => Some(PermissionOverride::Deny),
            "ask" => Some(PermissionOverride::Ask),
            _ => None,
        };
    }
    if let Some(reason) = specific.get("permissionDecisionReason").and_then(Value::as_str) {
        parsed.permission_reason = Some(reason.to_string());
    }
    if let Some(updated_input) = specific.get("updatedInput") {
        parsed.updated_input = serde_json::to_string(updated_input).ok();
    }
}
```

`hookSpecificOutput` 是一个嵌套对象，包含钩子特有的结构化指令。`additionalContext` 是额外上下文消息，会被追加到消息列表——这允许钩子在不拒绝工具的情况下追加上下文信息（如"此操作已被审计日志记录"）。`permissionDecision` 映射到 `PermissionOverride` 枚举的三个变体。`permissionDecisionReason` 是权限覆盖的原因说明。`updatedInput` 是改写后的工具输入，钩子可以修改工具的执行参数——这是一个非常强大的能力，类似于 Java AOP 中 `@Around` 通知的 `ProceedingJoinPoint.proceed(modifiedArgs)`。

如果消息列表最终为空，用原始 stdout 填充：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

if parsed.messages.is_empty() {
    parsed.messages.push(stdout.to_string());
}

parsed
```

这保证 `ParsedHookOutput` 总有至少一条消息——即使 JSON 对象中没有 `systemMessage`、`reason` 或 `additionalContext` 字段，用户也能看到钩子的原始输出。

## 8.10 payload 生成与错误格式化

`hook_payload` 生成通过 stdin 传给钩子脚本的 JSON 数据。运行时层和插件层的实现几乎相同：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

fn hook_payload(
    event: HookEvent, tool_name: &str, tool_input: &str,
    tool_output: Option<&str>, is_error: bool,
) -> Value {
    match event {
        HookEvent::PostToolUseFailure => json!({
            "hook_event_name": event.as_str(),
            "tool_name": tool_name,
            "tool_input": parse_tool_input(tool_input),
            "tool_input_json": tool_input,
            "tool_error": tool_output,
            "tool_result_is_error": true,
        }),
        _ => json!({
            "hook_event_name": event.as_str(),
            "tool_name": tool_name,
            "tool_input": parse_tool_input(tool_input),
            "tool_input_json": tool_input,
            "tool_output": tool_output,
            "tool_result_is_error": is_error,
        }),
    }
}

fn parse_tool_input(tool_input: &str) -> Value {
    serde_json::from_str(tool_input).unwrap_or_else(|_| json!({ "raw": tool_input }))
}
```

`PostToolUseFailure` 事件的 payload 使用 `tool_error` 字段名（语义上更准确），其他事件使用 `tool_output`。`parse_tool_input` 尝试把 `tool_input` 字符串解析成 JSON 对象，失败时退化为 `{"raw": tool_input}`。同时保留 `tool_input_json` 原始字符串——这样钩子脚本可以根据自身能力选择解析后的结构化对象或原始字符串，灵活性更高。

当钩子输出无效 JSON 时，`format_invalid_hook_output` 生成一条结构化错误消息：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

fn format_invalid_hook_output(
    event: HookEvent, tool_name: &str, command: &str,
    detail: &str, stdout: &str, stderr: &str,
) -> String {
    let stdout_preview = bounded_hook_preview(stdout).unwrap_or_else(|| "<empty>".to_string());
    let stderr_preview = bounded_hook_preview(stderr).unwrap_or_else(|| "<empty>".to_string());
    let command_preview = bounded_hook_preview(command).unwrap_or_else(|| "<empty>".to_string());

    format!(
        "hook_invalid_json: phase={} tool={} command={} detail={} stdout_preview={} stderr_preview={}",
        event.as_str(), tool_name, command_preview, detail, stdout_preview, stderr_preview
    )
}
```

这条错误消息包含六个字段：`phase`（触发时机）、`tool`（工具名）、`command`（命令预览）、`detail`（错误详情）、`stdout_preview`（stdout 预览）、`stderr_preview`（stderr 预览）。所有预览都经过 `bounded_hook_preview` 处理，限制在 160 字符以内，并对换行、回车、制表符等控制字符做转义。

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

const HOOK_PREVIEW_CHAR_LIMIT: usize = 160;

fn bounded_hook_preview(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() { return None; }

    let mut preview = String::new();
    for (count, ch) in trimmed.chars().enumerate() {
        if count == HOOK_PREVIEW_CHAR_LIMIT {
            preview.push('…');
            break;
        }
        match ch {
            '\n' => preview.push_str("\\n"),
            '\r' => preview.push_str("\\r"),
            '\t' => preview.push_str("\\t"),
            control if control.is_control() => {
                let _ = write!(&mut preview, "\\u{{{:x}}}", control as u32);
            }
            _ => preview.push(ch),
        }
    }
    Some(preview)
}
```

`bounded_hook_preview` 逐字符遍历输入，到 160 字符时截断并添加省略号 `…`。控制字符（换行、回车、制表符等）被转义为字面量表示（`\n`、`\r`、`\t`），其他控制字符用 Unicode 转义（`\u{xx}`）。这保证了错误消息是单行文本，不会被多行 stdout 破坏格式。在 Java 中，类似的功能通常用 `String.substring(0, Math.min(s.length(), 160))` + `StringEscapeUtils.escapeJava()` 实现。

## 8.11 插件层与运行时层的设计对比

| 维度 | 插件层 HookRunner | 运行时层 HookRunner |
| --- | --- | --- |
| 配置来源 | `PluginHooks`（插件清单聚合） | `RuntimeHookConfig`（配置文件） |
| 命令类型 | `Vec<String>`（纯命令字符串） | `Vec<RuntimeHookCommand>`（命令 + matcher） |
| 工具过滤 | 无（所有钩子对所有工具生效） | 有（`matches_tool` 按匹配器过滤） |
| 中止信号 | 无 | `HookAbortSignal`（`Arc<AtomicBool>` 轮询） |
| 进度报告 | 无 | `HookProgressReporter` trait |
| stdout 解析 | 原样作为消息 | JSON 结构化解析 |
| 权限覆盖 | 不支持 | `PermissionOverride`（Allow/Deny/Ask） |
| 输入改写 | 不支持 | `updated_input` |
| 取消状态 | 不支持 | `cancelled` 字段 |
| 退出码 0 拒绝 | 不支持（0 一定是 Allow） | 支持（检查 `parsed.deny`） |
| shell 启动 | 文件路径检测 + `sh -lc` | 统一 `sh -lc` |

这张对比表揭示了两个层次的设计分工。插件层是轻量级的钩子执行器，关注"执行插件声明的命令并收集退出码"。运行时层是全功能的钩子引擎，额外支持工具匹配器过滤、可取消执行、进度上报、结构化 JSON 输出解析、权限覆盖和输入改写。两者共享相同的退出码协议（0/2/其他/信号终止）和相同的 payload 格式，确保钩子脚本可以在两个层次间无缝复用。

从 Java 架构视角看，这种分层类似于 Spring AOP 的两级设计：`Advisor`（切面声明，对应插件层的 `PluginHooks`）定义"在什么时机执行什么"，而 `MethodInterceptor`（拦截器实现，对应运行时层的 `HookRunner`）负责实际的执行控制，包括异常处理、超时控制和返回值修改。

## 8.12 本章小结

钩子系统是 claw-code 扩展机制的基石。本章从三个层次剖析了它的完整实现：Python 归档层标记了原版 TypeScript 前端钩子为已归档；插件层通过 `PluginHooks` 结构声明钩子、`PluginRegistry::aggregated_hooks` 聚合多插件钩子、`HookRunner` 按退出码协议执行；运行时层在插件层基础上增加了工具匹配器过滤、中止信号轮询、进度事件上报、结构化 JSON 输出解析（支持权限覆盖和输入改写）等高级能力。

退出码协议是整个钩子系统的通信基础：0 表示允许，2 表示拒绝，其他表示失败。运行时层在此基础上增加了 JSON 双通道拒绝机制——即使退出码为 0，JSON 输出中的 `"continue": false` 或 `"decision": "block"` 也能表达拒绝。`hookSpecificOutput` 对象则提供了更丰富的控制能力：`permissionDecision` 可以覆盖权限系统的决策，`updatedInput` 可以改写工具的执行参数，`additionalContext` 可以在不拦截的情况下追加上下文信息。

中止信号的实现采用了 20 毫秒轮询 + `try_wait` 非阻塞检查的策略，在 CPU 开销和响应延迟之间取得了平衡。`Arc<AtomicBool>` 配合 `Release/Acquire` 内存序保证了跨线程的中止信号可见性。这些设计选择体现了 Rust 系统编程的典型范式：用类型系统表达所有权关系，用原子操作替代锁，用条件编译处理平台差异。
