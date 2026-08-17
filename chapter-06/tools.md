# 第6章 工具系统：ToolPool 与 40 个工具规范

## 本章概览

本章分析 claw-code 的工具系统——Agent 如何定义、注册、发现和执行工具。对应第2章架构全景中的 `tools` crate 和 `runtime` crate 中的文件操作、bash 执行模块。

工具系统要解决的核心问题是：LLM 本身只能生成文本，不能读写文件、执行命令、搜索代码。工具系统给 LLM 提供了"手和脚"——一组可调用的函数，LLM 通过 tool call 协议选择工具并传入参数，工具系统负责执行并把结果返回给 LLM。

| 关键文件 | 职责 |
| --- | --- |
| `rust/crates/tools/src/lib.rs` | `ToolSpec`、`GlobalToolRegistry`、工具执行分发、`ToolSearch` |
| `rust/crates/runtime/src/file_ops.rs` | 文件读写、编辑、搜索的实现 |
| `rust/crates/runtime/src/bash.rs` | Bash 命令执行与沙箱 |

## 6.1 工具定义：ToolSpec 与 RuntimeToolDefinition

`ToolSpec` 是内置工具的静态规格定义：

```rust
// claw-code/rust/crates/tools/src/lib.rs

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub required_permission: PermissionMode,
}
```

四个字段的含义和设计意图：

`name` 用 `&'static str` 而不是 `String`。这意味着工具名在编译时就确定了，不需要堆分配。所有内置工具名（如 `"bash"`、`"read_file"`）都直接编译进二进制文件。

`description` 也是 `&'static str`，原因相同。这个字段的内容会被发送给 LLM 作为工具说明——LLM 根据 description 决定何时使用这个工具。因此 description 的质量直接影响 Agent 的行为准确性。

`input_schema` 是 `Value` 类型（`serde_json::Value`），包含 JSON Schema 格式的输入参数定义。LLM 根据 schema 生成符合格式的参数。`Value` 而非具体结构体是因为不同工具的参数结构差异巨大——`bash` 接受 `command` 字符串，`grep_search` 接受 `pattern` + `path` + `glob` + 多个 flag，用统一的 `Value` 避免为每个工具定义一个结构体。

`required_permission` 是 `PermissionMode` 枚举，定义该工具的静态权限要求。三个核心级别从低到高：`ReadOnly`（只读，如 `read_file`）、`WorkspaceWrite`（写工作区，如 `write_file`）、`DangerFullAccess`（完全访问，如 `bash`）。这个字段是静态声明——工具规格中写死的权限要求，但实际执行时可能被动态分类函数调整（6.5 节展开）。

`RuntimeToolDefinition` 是运行时动态注册的工具定义，与 `ToolSpec` 结构类似但字段类型从 `&'static str` 变为 `String`：

```rust
// claw-code/rust/crates/tools/src/lib.rs

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeToolDefinition {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
    pub required_permission: PermissionMode,
}
```

`Option<String>` 表示描述可以省略——运行时注册的工具（如 MCP 服务器提供的工具）不一定有描述。`String` 而非 `&'static str` 是因为这些工具名在运行时动态产生（如从 MCP 服务器的 JSON 响应中解析），编译时不存在。

## 6.2 GlobalToolRegistry 三层注册

`GlobalToolRegistry` 是 Rust 端工具注册表的核心，持有三层数据：

```rust
// claw-code/rust/crates/tools/src/lib.rs

#[derive(Debug, Clone)]
pub struct GlobalToolRegistry {
    plugin_tools: Vec<PluginTool>,
    runtime_tools: Vec<RuntimeToolDefinition>,
    enforcer: Option<PermissionEnforcer>,
}
```

三层工具的来源不同。内置工具不在结构体字段中——它们通过 `mvp_tool_specs()` 函数静态返回，每次调用都重新生成 `Vec<ToolSpec>`。这个设计意味着内置工具定义是编译时常量，不占用 `GlobalToolRegistry` 的存储空间。

`builtin()` 创建一个空的注册表（只有内置工具，无插件、无运行时工具、无 enforcer）：

```rust
// claw-code/rust/crates/tools/src/lib.rs

impl GlobalToolRegistry {
    #[must_use]
    pub fn builtin() -> Self {
        Self {
            plugin_tools: Vec::new(),
            runtime_tools: Vec::new(),
            enforcer: None,
        }
    }
```

`#[must_use]` 注解告诉编译器：这个方法的返回值必须被使用，不能丢弃。

插件工具通过 `with_plugin_tools()` 注册，带冲突检测：

```rust
// claw-code/rust/crates/tools/src/lib.rs

pub fn with_plugin_tools(plugin_tools: Vec<PluginTool>) -> Result<Self, String> {
    let builtin_names = mvp_tool_specs()
        .into_iter()
        .map(|spec| spec.name.to_string())
        .collect::<BTreeSet<_>>();
    let mut seen_plugin_names = BTreeSet::new();

    for tool in &plugin_tools {
        let name = tool.definition().name.clone();
        if builtin_names.contains(&name) {
            return Err(format!(
                "plugin tool `{name}` conflicts with a built-in tool name"
            ));
        }
        if !seen_plugin_names.insert(name.clone()) {
            return Err(format!("duplicate plugin tool name `{name}`"));
        }
    }

    Ok(Self {
        plugin_tools,
        runtime_tools: Vec::new(),
        enforcer: None,
    })
}
```

两次冲突检测：第一次检测插件工具名是否与内置工具名冲突，第二次检测插件工具之间是否重名。`BTreeSet::insert` 的返回值是 `bool`——`true` 表示新增成功（之前没有），`false` 表示已存在。利用这个返回值做去重检测是 Rust 的常见模式。

运行时工具通过 `with_runtime_tools()` 追加，同样带冲突检测：

```rust
// claw-code/rust/crates/tools/src/lib.rs

pub fn with_runtime_tools(
    mut self,
    runtime_tools: Vec<RuntimeToolDefinition>,
) -> Result<Self, String> {
    let mut seen_names = mvp_tool_specs()
        .into_iter()
        .map(|spec| spec.name.to_string())
        .chain(
            self.plugin_tools
                .iter()
                .map(|tool| tool.definition().name.clone()),
        )
        .collect::<BTreeSet<_>>();

    for tool in &runtime_tools {
        if !seen_names.insert(tool.name.clone()) {
            return Err(format!(
                "runtime tool `{}` conflicts with an existing tool name",
                tool.name
            ));
        }
    }

    self.runtime_tools = runtime_tools;
    Ok(self)
}
```

`chain()` 方法把内置工具名和已注册插件工具名的迭代器串联，然后检查运行时工具名是否与之冲突。

权限执行器通过 `with_enforcer()` 设置：

```rust
// claw-code/rust/crates/tools/src/lib.rs

#[must_use]
pub fn with_enforcer(mut self, enforcer: PermissionEnforcer) -> Self {
    self.set_enforcer(enforcer);
    self
}
```

`definitions()` 方法把三层工具合并为 `ToolDefinition` 列表，这是发给 LLM API 的最终格式：

```rust
// claw-code/rust/crates/tools/src/lib.rs

pub fn definitions(&self, allowed_tools: Option<&BTreeSet<String>>) -> Vec<ToolDefinition> {
    let builtin = mvp_tool_specs()
        .into_iter()
        .filter(|spec| {
            allowed_tools
                .is_none_or(|allowed| allowed.contains(&canonical_allowed_tool_name(spec.name)))
        })
        .map(|spec| ToolDefinition {
            name: spec.name.to_string(),
            description: Some(spec.description.to_string()),
            input_schema: spec.input_schema,
        });
    let runtime = self
        .runtime_tools
        .iter()
        .filter(|tool| {
            allowed_tools.is_none_or(|allowed| {
                allowed.contains(&canonical_allowed_tool_name(&tool.name))
            })
        })
        .map(|tool| ToolDefinition {
            name: tool.name.clone(),
            description: tool.description.clone(),
            input_schema: tool.input_schema.clone(),
        });
    // plugin 层同理 ...
    builtin.chain(runtime).chain(plugin).collect()
}
```

每一层都做同样的两步操作：filter + map。`filter` 检查 `allowed_tools`——如果为 `None`，`is_none_or` 返回 `true`（所有工具通过）；如果是 `Some(allowed_set)`，检查工具名（经 `canonical_allowed_tool_name` 规范化后）是否在集合中。

`canonical_allowed_tool_name` 把 CamelCase 工具名转成 snake_case。例如 `WebFetch` 变成 `web_fetch`，`TodoWrite` 变成 `todo_write`：

```rust
// claw-code/rust/crates/tools/src/lib.rs

pub fn canonical_allowed_tool_name(value: &str) -> String {
    let trimmed = value.trim().replace('-', "_");
    let mut output = String::new();
    let chars = trimmed.chars().collect::<Vec<_>>();
    for (index, ch) in chars.iter().copied().enumerate() {
        if ch == '_' || ch.is_whitespace() {
            output.push('_');
            continue;
        }
        let previous = index.checked_sub(1).and_then(|i| chars.get(i)).copied();
        let next = chars.get(index + 1).copied();
        if ch.is_ascii_uppercase()
            && index > 0
            && !output.ends_with('_')
            && (previous.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit())
                || next.is_some_and(|n| n.is_ascii_lowercase()))
        {
            output.push('_');
        }
        output.push(ch.to_ascii_lowercase());
    }
    output.trim_matches('_').to_string()
}
```

这个函数的算法是逐字符扫描，在大写字母前插入下划线。但有一个条件：前一个字符必须是小写或数字，或者下一个字符是小写。这避免了在连续大写（如 `HTTPServer`）中每个字母间都插下划线——`HTTP` 会变成 `http` 而非 `h_t_t_p`。

## 6.3 内置工具清单与延迟发现

`mvp_tool_specs()` 返回所有内置工具的静态规格。这个名字中的 "mvp" 指的是"最小可行产品"——这些工具是 Agent 运行所需的最小集合。实际上返回的工具远不止"最小"，包含了 40+ 个工具。

前六个是基础工具，始终对 LLM 可见：

```rust
// claw-code/rust/crates/tools/src/lib.rs

pub fn mvp_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "bash",
            description: "Execute a shell command in the current workspace.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeout": { "type": "integer", "minimum": 1 },
                    "description": { "type": "string" },
                    "run_in_background": { "type": "boolean" },
                    "dangerouslyDisableSandbox": { "type": "boolean" },
                    "namespaceRestrictions": { "type": "boolean" },
                    "isolateNetwork": { "type": "boolean" },
                    "filesystemMode": { "type": "string", "enum": ["off", "workspace-only", "allow-list"] },
                    "allowedMounts": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::DangerFullAccess,
        },
```

`bash` 工具的 schema 值得仔细看。`command` 是必填字段（在 `required` 数组中），其余都是可选。`dangerouslyDisableSandbox` 字段名以 `dangerously` 开头，这是一个命名约定——告诉 LLM 和开发者这个选项有安全风险。`filesystemMode` 用枚举限制为三个值：`off`（不允许文件访问）、`workspace-only`（只允许工作区内）、`allow-list`（按白名单）。`additionalProperties: false` 禁止额外字段——LLM 不能传入 schema 中未定义的参数。

`required_permission: PermissionMode::DangerFullAccess` 是静态声明，但实际执行时 `classify_bash_permission` 会根据命令内容动态降级（6.5 节展开）。

接下来是文件操作工具：

```rust
// claw-code/rust/crates/tools/src/lib.rs

        ToolSpec {
            name: "read_file",
            description: "Read a text file from the workspace.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "offset": { "type": "integer", "minimum": 0 },
                    "limit": { "type": "integer", "minimum": 1 }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        ToolSpec {
            name: "write_file",
            description: "Write a text file in the workspace.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::WorkspaceWrite,
        },
```

`read_file` 的 `path` 是必填，`offset` 和 `limit` 是可选——用于读取大文件的部分内容。`write_file` 的 `path` 和 `content` 都是必填——没有内容的写入没有意义。两者的权限级别不同：读只需要 `ReadOnly`，写需要 `WorkspaceWrite`。

`edit_file` 工具用于精确替换文件中的文本片段，`glob_search` 和 `grep_search` 提供文件发现与内容搜索能力。六个基础工具的权限级别分布为：`ReadOnly`（`read_file`、`glob_search`、`grep_search`）、`WorkspaceWrite`（`write_file`、`edit_file`）、`DangerFullAccess`（`bash`）。这个分布反映了工具的破坏潜力。

### 延迟工具与 ToolSearch

除了六个基础工具，`mvp_tool_specs()` 还返回大量延迟工具——`WebFetch`、`WebSearch`、`TodoWrite`、`Skill`、`Agent`、`ToolSearch`、`NotebookEdit`、`Sleep`、`SendUserMessage`、`Config`、`EnterPlanMode`、`ExitPlanMode`、`StructuredOutput`、`REPL`、`PowerShell`、`AskUserQuestion`、Task 系列、Worker 系列、Team 系列、Cron 系列、`LSP`、MCP 系列、Git 系列等。

延迟工具不直接暴露给 LLM，而是通过 `ToolSearch` 工具按需发现。`deferred_tool_specs()` 函数从 `mvp_tool_specs()` 中过滤掉六个基础工具：

```rust
// claw-code/rust/crates/tools/src/lib.rs

fn deferred_tool_specs() -> Vec<ToolSpec> {
    mvp_tool_specs()
        .into_iter()
        .filter(|spec| {
            !matches!(
                spec.name,
                "bash" | "read_file" | "write_file" | "edit_file" | "glob_search" | "grep_search"
            )
        })
        .collect()
}
```

`matches!` 宏做模式匹配——如果 `spec.name` 等于六个基础工具名中的任何一个，返回 `true`，`!` 取反后 `filter` 保留不匹配的（即延迟工具）。这个写法比 `if spec.name != "bash" && spec.name != "read_file" && ...` 简洁得多。

为什么要延迟加载？因为 LLM 的上下文窗口有限。如果一次性把 40+ 个工具的 schema 全部发给 LLM，会消耗大量 token（每个工具的 schema 约 100-300 token，40 个工具就是 4000-12000 token）。大部分工具在一次对话中根本用不到。通过 `ToolSearch` 按需发现，LLM 只在需要时搜索工具，大大减少了 token 消耗。

`search_tool_specs` 是 `ToolSearch` 工具的底层实现，支持两种查询语法：

```rust
// claw-code/rust/crates/tools/src/lib.rs

fn search_tool_specs(query: &str, max_results: usize, specs: &[SearchableToolSpec]) -> Vec<String> {
    let lowered = query.to_lowercase();
    if let Some(selection) = lowered.strip_prefix("select:") {
        return selection
            .split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .filter_map(|wanted| {
                let wanted = canonical_tool_token(wanted);
                specs
                    .iter()
                    .find(|spec| canonical_tool_token(&spec.name) == wanted)
                    .map(|spec| spec.name.clone())
            })
            .take(max_results)
            .collect();
    }
    // 关键词评分模式 ...
}
```

精确选择模式：`select:tool1,tool2`。`strip_prefix("select:")` 检查查询是否以 `select:` 开头，如果是，把后面的部分按逗号分割，逐个精确匹配工具名。

关键词评分模式把查询分词后，前缀 `+` 标记的词放入 `required` 列表（必须匹配），其余放入 `optional` 列表。评分规则有五个维度：词出现在工具名+描述组合文本中加 2 分；词完全等于工具名（小写）加 8 分；词是工具名的子串加 4 分；规范名完全匹配加 12 分（最高分）；规范化文本包含规范化词加 3 分。`required` 列表中的词必须全部出现，否则工具被过滤掉。

## 6.4 工具执行分发与动态权限

`GlobalToolRegistry::execute` 是工具执行的入口：

```rust
// claw-code/rust/crates/tools/src/lib.rs

pub fn execute(&self, name: &str, input: &Value) -> Result<String, String> {
    if mvp_tool_specs().iter().any(|spec| spec.name == name) {
        return execute_tool_with_enforcer(self.enforcer.as_ref(), name, input);
    }
    self.plugin_tools
        .iter()
        .find(|tool| tool.definition().name == name)
        .ok_or_else(|| format!("unsupported tool: {name}"))?
        .execute(input)
        .map_err(|error| error.to_string())
}
```

执行分两条路径。第一条：如果工具名在内置工具列表中，走 `execute_tool_with_enforcer` 分发。第二条：如果不在内置列表中，在插件工具列表中查找，找到后执行。

`execute_tool_with_enforcer` 是工具执行的核心分发器：

```rust
// claw-code/rust/crates/tools/src/lib.rs

#[allow(clippy::too_many_lines)]
#[aspect(LoggingAspect::new().log_args().log_result())]
fn execute_tool_with_enforcer(
    enforcer: Option<&PermissionEnforcer>,
    name: &str,
    input: &Value,
) -> Result<String, String> {
    match name {
        "bash" => {
            let bash_input: BashCommandInput = from_value(input)?;
            let classified_mode = classify_bash_permission(&bash_input.command);
            maybe_enforce_permission_check_with_mode(enforcer, name, input, classified_mode)?;
            run_bash(bash_input)
        }
        "read_file" => {
            let file_input: ReadFileInput = from_value(input)?;
            let required_mode = classify_read_path_permission(&file_input.path, false);
            maybe_enforce_permission_check_with_mode(enforcer, name, input, required_mode)?;
            run_read_file(file_input)
        }
        "write_file" => {
            let file_input: WriteFileInput = from_value(input)?;
            let required_mode = classify_file_path_permission(&file_input.path, true);
            maybe_enforce_permission_check_with_mode(enforcer, name, input, required_mode)?;
            run_write_file(file_input)
        }
        "edit_file" => {
            let file_input: EditFileInput = from_value(input)?;
            let required_mode = classify_file_path_permission(&file_input.path, false);
            maybe_enforce_permission_check_with_mode(enforcer, name, input, required_mode)?;
            run_edit_file(file_input)
        }
        "glob_search" => {
            let glob_input: GlobSearchInputValue = from_value(input)?;
            let required_mode = classify_glob_permission(&glob_input);
            maybe_enforce_permission_check_with_mode(enforcer, name, input, required_mode)?;
            run_glob_search(glob_input)
        }
        "grep_search" => {
            let grep_input: GrepSearchInput = from_value(input)?;
            let required_mode = classify_grep_permission(&grep_input);
            maybe_enforce_permission_check_with_mode(enforcer, name, input, required_mode)?;
            run_grep_search(grep_input)
        }
        // 逻辑工具分支 ...
        "TodoWrite" => from_value::<TodoWriteInput>(input).and_then(run_todo_write),
        "Skill" => from_value::<SkillInput>(input).and_then(run_skill),
        "Agent" => from_value::<AgentInput>(input).and_then(run_agent),
        "ToolSearch" => from_value::<ToolSearchInput>(input).and_then(run_tool_search),
        // ... 更多工具
    }
}
```

前六个基础工具（bash、read_file、write_file、edit_file、glob_search、grep_search）的执行模式一致，都是三步：反序列化输入 → 动态分类权限 → 执行。以 `bash` 为例：第一步 `from_value(input)?` 把 JSON `Value` 反序列化为 `BashCommandInput` 结构体。第二步 `classify_bash_permission(&bash_input.command)` 分析命令内容，动态确定权限级别。第三步 `maybe_enforce_permission_check_with_mode` 做权限检查，通过后 `run_bash(bash_input)` 真正执行命令。

逻辑工具不需要动态权限分类——它们的权限级别是静态的，不因输入内容变化。因此用 `and_then` 链式调用：`from_value` 反序列化成功后直接调用 `run_*` 执行。

### 动态权限分类

`classify_bash_permission` 是动态权限分类的典型例子：

```rust
// claw-code/rust/crates/tools/src/lib.rs

fn classify_bash_permission(command: &str) -> PermissionMode {
    const READ_ONLY_COMMANDS: &[&str] = &[
        "cat", "head", "tail", "less", "more", "ls", "ll", "dir", "find", "test", "[", "[[",
        "grep", "rg", "awk", "sed", "file", "stat", "readlink", "wc", "sort", "uniq", "cut", "tr",
        "pwd", "echo", "printf",
    ];

    let base_cmd = command.split_whitespace().next().unwrap_or("");
    let base_cmd = base_cmd.split('|').next().unwrap_or("").trim();
    let base_cmd = base_cmd.split(';').next().unwrap_or("").trim();
    let base_cmd = base_cmd.split('>').next().unwrap_or("").trim();
    let base_cmd = base_cmd.split('<').next().unwrap_or("").trim();

    let cmd_name = base_cmd.split('/').last().unwrap_or(base_cmd);
    let is_read_only = READ_ONLY_COMMANDS.contains(&cmd_name);

    if !is_read_only {
        return PermissionMode::DangerFullAccess;
    }

    if has_dangerous_paths(command) {
        return PermissionMode::DangerFullAccess;
    }

    PermissionMode::WorkspaceWrite
}
```

`READ_ONLY_COMMANDS` 是一个静态数组，列出了所有被视为"只读"的命令。提取基础命令名的过程用连续的 `split` 和 `trim`：先按空白分词取第一个词，再依次按 `|`、`;`、`>`、`<` 分割取第一段。这处理了管道、命令链接、重定向等情况——只取第一个命令做分类。`split('/').last()` 取路径的最后一部分，处理 `/usr/bin/ls` 这种完整路径写法。

分类逻辑分三级。如果命令不在只读列表中，直接返回 `DangerFullAccess`。如果在只读列表中，检查路径参数是否有危险路径（工作区外的绝对路径、`../` 目录逃逸、环境变量 `$`）。如果有危险路径，升级为 `DangerFullAccess`。如果都没有，降级为 `WorkspaceWrite`。

`has_dangerous_paths` 检查命令中的路径参数：去掉 token 周围的引号和括号字符，跳过 `-` 开头的选项，`$` 出现在 token 中被视为危险——环境变量展开后的路径不可预测。Unix 绝对路径和 `~/` 开头的路径通过 `canonicalize` 解析后检查是否在工作区内。`../..` 和 `../` 开头的路径被视为目录逃逸。

### 权限检查统一入口

`maybe_enforce_permission_check_with_mode` 是所有工具权限检查的统一入口：

```rust
// claw-code/rust/crates/tools/src/lib.rs

fn maybe_enforce_permission_check_with_mode(
    enforcer: Option<&PermissionEnforcer>,
    tool_name: &str,
    input: &Value,
    required_mode: PermissionMode,
) -> Result<(), String> {
    if let Some(enforcer) = enforcer {
        let input_str = serde_json::to_string(input).unwrap_or_default();
        let result = enforcer.check_with_required_mode(tool_name, &input_str, required_mode);

        match result {
            EnforcementResult::Allowed => Ok(()),
            EnforcementResult::Denied { reason, .. } => Err(reason),
        }
    } else {
        Ok(())
    }
}
```

`enforcer` 是 `Option<&PermissionEnforcer>`——可能存在也可能不存在。当 `enforcer` 为 `None` 时（如测试场景或未配置权限执行器），权限检查直接跳过，返回 `Ok(())`。当 `enforcer` 存在时，把输入 JSON 序列化为字符串，调用 `check_with_required_mode` 做权限判定。返回 `EnforcementResult` 枚举——`Allowed` 或 `Denied { reason }`。`Denied` 变体携带拒绝原因，作为错误返回给 LLM。

## 小结

工具系统通过 `ToolSpec` 结构体命令式完成工具定义——每个工具的定义是代码中的数据结构，不是注解。`GlobalToolRegistry` 采用三层架构：内置工具通过 `mvp_tool_specs()` 静态返回，插件工具通过 `with_plugin_tools` 注册并做冲突检测，运行时工具通过 `with_runtime_tools` 追加。`definitions()` 方法把三层合并为 `ToolDefinition` 列表发给 LLM，同时支持 `allowed_tools` 过滤。

内置工具包含 40+ 个规范，其中六个基础工具始终对 LLM 可见，其余延迟工具通过 `ToolSearch` 的评分搜索按需发现。`execute_tool_with_enforcer` 是执行分发器，对涉及文件和 shell 的工具调用 `classify_*` 函数动态分类权限级别，再通过 `maybe_enforce_permission_check_with_mode` 做权限检查，最后调用 `run_*` 执行工具逻辑。动态权限分类让同一个 `bash` 工具根据命令内容在 `ReadOnly`、`WorkspaceWrite` 和 `DangerFullAccess` 之间切换。

| 关键文件 | 核心机制 | 对应章节 |
| --- | --- | --- |
| `rust/crates/tools/src/lib.rs` | `ToolSpec`、`GlobalToolRegistry`、三层注册 | 6.1-6.2 |
| `rust/crates/tools/src/lib.rs` | `mvp_tool_specs`、`deferred_tool_specs`、`search_tool_specs` | 6.3 |
| `rust/crates/tools/src/lib.rs` | `execute_tool_with_enforcer`、`classify_bash_permission` | 6.4 |

下一章将分析 MCP 协议与外部工具连接——`McpToolRegistry` 如何对接外部 MCP 服务器，`McpClientTransport` 如何抽象六种传输方式，以及 `McpServerManager` 如何管理服务器生命周期与降级启动。
