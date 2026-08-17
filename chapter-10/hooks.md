# 第9章 钩子系统：用户自定义拦截

## 本章概览

本章分析 claw-code 的钩子系统——如何在工具执行前后插入用户自定义的 shell 命令，实现对工具调用的拦截、修改和审计。对应 `runtime::hooks` 模块。

钩子系统解决的核心问题是：Agent 自动执行 shell 命令和文件操作，用户可能需要在特定操作执行前做额外检查（如安全扫描），或在执行后追加反馈（如通知、日志）。钩子系统提供三个生命周期事件，每个事件可以配置一组 shell 命令，系统按顺序执行并解析输出。

| 关键文件 | 职责 |
| --- | --- |
| `rust/crates/runtime/src/hooks.rs` | `HookRunner`、命令执行、输出解析、取消信号 |
| `rust/crates/runtime/src/config.rs` | `RuntimeHookConfig`、`RuntimeHookCommand`、matcher 配置 |

## 9.1 Hook 生命周期：三个事件

Rust 端定义三个钩子事件，覆盖工具执行的全生命周期：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
}
```

`PreToolUse` 在工具执行前触发。钩子可以修改工具输入（如给 bash 命令加前缀），覆盖权限决策（如强制允许或拒绝），或追加系统消息。如果 PreToolUse 钩子返回拒绝，工具不会执行。

`PostToolUse` 在工具成功执行后触发。钩子可以读取工具输出，追加反馈消息，或触发后续操作（如通知、日志记录）。

`PostToolUseFailure` 在工具执行失败后触发。钩子可以分析错误原因，提供修复建议，或决定是否重试。

这三个事件对应配置中的三个命令列表：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub struct RuntimeHookConfig {
    pre_tool_use: Vec<RuntimeHookCommand>,
    post_tool_use: Vec<RuntimeHookCommand>,
    post_tool_use_failure: Vec<RuntimeHookCommand>,
    invalid_hooks: Vec<RuntimeInvalidHookConfig>,
}
```

`pre_tool_use`、`post_tool_use`、`post_tool_use_failure` 分别存储三个阶段的命令。`invalid_hooks` 记录配置解析失败的钩子，用于错误报告而不中断启动。

## 9.2 HookRunner：命令执行流水线

`HookRunner` 是钩子系统的执行引擎：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

pub struct HookRunner {
    config: RuntimeHookConfig,
}
```

`HookRunner` 只有 `config` 一个字段——它本身不维护状态，每次执行都是无状态的。从 `RuntimeFeatureConfig` 构建：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

impl HookRunner {
    pub fn from_feature_config(feature_config: &RuntimeFeatureConfig) -> Self {
        Self::new(feature_config.hooks().clone())
    }
```

`hooks()` 返回 `&RuntimeHookConfig`，`.clone()` 复制整个配置。钩子配置在运行时不变，因此 `HookRunner` 不需要 `&mut self` 就能执行——但 `run_pre_tool_use_with_context` 等方法的 `reporter` 参数需要 `&mut dyn HookProgressReporter`，所以调用方需要提供可变引用。

执行入口分三组，对应三个事件：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

    pub fn run_pre_tool_use(&self, tool_name: &str, tool_input: &str) -> HookRunResult {
        self.run_pre_tool_use_with_context(tool_name, tool_input, None, None)
    }

    pub fn run_pre_tool_use_with_context(
        &self,
        tool_name: &str,
        tool_input: &str,
        abort_signal: Option<&HookAbortSignal>,
        reporter: Option<&mut dyn HookProgressReporter>,
    ) -> HookRunResult {
        Self::run_commands(
            HookEvent::PreToolUse,
            self.config.pre_tool_use_entries(),
            tool_name, tool_input, None, false,
            abort_signal, reporter,
        )
    }
```

`run_pre_tool_use` 是简写版本，不提供 abort_signal 和 reporter。`run_pre_tool_use_with_context` 是完整版本，传入所有参数。`run_commands` 是统一的内部执行方法，接收 `HookEvent`、命令列表、工具信息、abort_signal 和 reporter。

PostToolUse 和 PostToolUseFailure 的结构类似，只是 `tool_output` 为 `Some` 且 `is_error` 标志不同。

### run_commands：统一执行逻辑

`run_commands` 是核心执行方法：

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
            let command_text = command.command();
            if let Some(reporter) = reporter.as_deref_mut() {
                reporter.on_event(&HookProgressEvent::Started {
                    event, tool_name: tool_name.to_string(), command: command_text.to_string(),
                });
            }

            match Self::run_command(command_text, event, tool_name, tool_input, tool_output,
                is_error, &payload, abort_signal) {
                HookCommandOutcome::Allow { parsed } => {
                    if let Some(reporter) = reporter.as_deref_mut() {
                        reporter.on_event(&HookProgressEvent::Completed { ... });
                    }
                    merge_parsed_hook_output(&mut result, parsed);
                }
                HookCommandOutcome::Deny { parsed } => { ... }
                HookCommandOutcome::Failed { parsed } => { ... }
                HookCommandOutcome::Cancelled { message } => { ... }
            }
        }

        result
    }
```

执行流程分五步。第一步空检查——如果命令列表为空，直接返回 `allow`（无消息）。第二步取消检查——如果 `abort_signal` 已触发，返回 `cancelled` 状态。第三步生成 payload——`hook_payload` 构造 JSON 数据，通过 stdin 传给钩子命令。第四步遍历命令——用 `filter(|command| command.matches_tool(tool_name))` 只执行匹配当前工具的命令。第五步执行命令——`run_command` 启动子进程，解析输出，合并结果。

`merge_parsed_hook_output` 把多个命令的结果合并到一个 `HookRunResult`：消息追加到列表，权限覆盖和输入修改取最后一个非空值。

## 9.3 钩子命令执行：进程与协议

### 子进程启动

`run_command` 用 `std::process::Command` 启动子进程：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

    fn run_command(
        command: &str, event: HookEvent, tool_name: &str, tool_input: &str,
        tool_output: Option<&str>, is_error: bool, payload: &str,
        abort_signal: Option<&HookAbortSignal>,
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
```

`shell_command` 根据平台选择 shell——Windows 用 `cmd /C`，Unix 用 `sh -lc`。环境变量传递事件类型、工具名、工具输入、错误标志和输出。`HOOK_TOOL_INPUT` 是原始 JSON 字符串，`HOOK_TOOL_OUTPUT` 仅在 PostToolUse 和 PostToolUseFailure 时设置。

子进程通过 stdin 接收 JSON payload：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

        match child.output_with_stdin(payload.as_bytes(), abort_signal) {
            Ok(CommandExecution::Finished(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let parsed = parse_hook_output(event, tool_name, command, &stdout, &stderr);
```

`output_with_stdin` 是 `CommandWithStdin` 的方法，在 `child.stdin` 写入 payload 后等待子进程结束。`abort_signal` 定期检查，如果被取消则 `kill` 子进程。

### 退出码语义

钩子命令的退出码决定执行结果：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

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
                    None => HookCommandOutcome::Failed { ... },
                }
```

退出码 0 表示成功——如果解析输出发现 `deny` 标志为 true，转为 `Deny`；否则 `Allow`。退出码 2 表示拒绝——无论 stdout 内容如何，都拒绝工具执行。其他非零退出码表示失败——钩子脚本本身出错，不是拒绝工具。`None` 表示进程被信号终止。

这个设计让钩子脚本可以用简单的 `exit 2` 实现拒绝，不需要输出 JSON。

### Payload 格式

`hook_payload` 构造传给钩子的 JSON 数据：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

fn hook_payload(
    event: HookEvent, tool_name: &str, tool_input: &str, tool_output: Option<&str>, is_error: bool,
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
```

`PostToolUseFailure` 的 payload 把 `tool_output` 放在 `tool_error` 字段，且 `tool_result_is_error` 固定为 `true`。其他事件用 `tool_output` 字段和动态的 `is_error`。

`parse_tool_input` 尝试把工具输入解析为 JSON——如果成功，payload 中的 `tool_input` 是结构化对象；如果失败，是 `{"raw": "..."}`。`tool_input_json` 始终保留原始字符串。

## 9.4 输出解析：JSON 协议

钩子通过 stdout 返回结构化输出。`parse_hook_output` 解析 stdout 为 `ParsedHookOutput`：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

fn parse_hook_output(
    event: HookEvent, tool_name: &str, command: &str, stdout: &str, stderr: &str,
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
        Err(error) if looks_like_json_attempt(stdout) => { ... }
        Err(_) => {
            return ParsedHookOutput {
                messages: vec![stdout.to_string()],
                ..ParsedHookOutput::default()
            };
        }
    };
```

解析分四步。第一步空 stdout 直接返回默认结果。第二步尝试解析 JSON——如果顶层是对象，继续解析字段；如果不是对象，返回错误消息。第三步如果看起来像 JSON 但解析失败（以 `{` 或 `[` 开头），返回详细的解析错误。第四步如果不是 JSON，把 stdout 作为纯文本消息。

这个设计允许钩子输出纯文本（简单场景）或结构化 JSON（高级场景）。

解析对象字段：

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

`systemMessage` 和 `reason` 字段追加到消息列表。`continue: false` 或 `decision: "block"` 设置拒绝标志。`continue` 是旧版协议的兼容字段，`decision` 是新版标准。

`hookSpecificOutput` 子对象包含权限覆盖和输入修改：

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

`permissionDecision` 映射为 `PermissionOverride` 枚举——`allow`、`deny`、`ask` 对应权限系统的三种覆盖。`updatedInput` 是修改后的工具输入，必须是有效的 JSON 值，会被序列化为字符串后替换原始输入。

## 9.5 权限覆盖与输入修改

钩子系统与权限系统通过 `PermissionOverride` 交互。`HookRunResult` 携带权限覆盖：

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

`permission_override` 是 `Option<PermissionOverride>`——`None` 表示不覆盖，由权限系统正常评估；`Some(Allow)`、`Some(Deny)`、`Some(Ask)` 表示覆盖权限决策。

`PermissionContext`（第8章）的 `override_decision()` 方法返回这个值，在 `authorize_with_context` 的钩子覆盖阶段使用：

```rust
// claw-code/rust/crates/runtime/src/permissions.rs (来自第8章)

        match context.override_decision() {
            Some(PermissionOverride::Deny) => { ... }
            Some(PermissionOverride::Ask) => { ... }
            Some(PermissionOverride::Allow) => { ... }
            None => {}
        }
```

`updated_input` 是修改后的工具输入。PreToolUse 钩子可以用 `updatedInput` 修改工具参数——如给 bash 命令加 `echo "[HOOK]" &&` 前缀，或替换文件路径。`execute_tool_with_enforcer` 在调用工具前检查 `updated_input`：

```rust
// claw-code/rust/crates/runtime/src/tools/executor.rs (示意)

    let final_input = hook_result
        .updated_input()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| tool_input.to_string());
```

如果钩子返回 `updated_input`，用它替换原始输入；否则用原始输入。注意：修改后的输入仍然要经过权限检查——钩子不能绕过权限系统。

## 9.6 工具匹配与通配符

`RuntimeHookCommand` 支持工具匹配器——只让钩子作用于特定工具：

```rust
// claw-code/rust/crates/runtime/src/config.rs

pub struct RuntimeHookCommand {
    command: String,
    matcher: Option<String>,
}
```

`matcher` 是可选的过滤模式。`matches_tool` 方法判断命令是否匹配给定工具名：

```rust
// claw-code/rust/crates/runtime/src/config.rs

    pub fn matches_tool(&self, tool_name: &str) -> bool {
        self.matcher
            .as_deref()
            .is_none_or(|matcher| hook_matcher_matches(matcher, tool_name))
    }
```

`is_none_or` 是 `Option` 的方法——`None` 时返回 `true`（无 matcher 表示匹配所有工具），`Some` 时调用 `hook_matcher_matches`。

`hook_matcher_matches` 支持逗号或管道分隔的多模式匹配：

```rust
// claw-code/rust/crates/runtime/src/config.rs

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

`split([',', '|'])` 用字符数组作为分隔符——逗号或管道都可以分隔多个模式。`any` 短路匹配——任一模式匹配即返回 `true`。三个匹配条件：`*` 匹配所有工具名；精确匹配（不区分大小写）；通配符匹配。

`wildcard_match` 实现简单的 `*` 通配符：

```rust
// claw-code/rust/crates/runtime/src/config.rs

fn wildcard_match(pattern: &str, value: &str) -> bool {
    if !pattern.contains('*') {
        return false;
    }
    let pattern = pattern.to_ascii_lowercase();
    let value = value.to_ascii_lowercase();
    let parts = pattern.split('*').collect::<Vec<_>>();
    let mut remainder = value.as_str();
    let starts_with_wildcard = pattern.starts_with('*');
    let ends_with_wildcard = pattern.ends_with('*');

    if let Some(first) = parts.first().filter(|part| !part.is_empty()) {
        if !starts_with_wildcard && !remainder.starts_with(first) {
            return false;
        }
        if let Some(index) = remainder.find(first) {
            remainder = &remainder[index + first.len()..];
        }
    }

    for part in parts.iter().skip(1).filter(|part| !part.is_empty()) {
        let Some(index) = remainder.find(part) else { return false; };
        remainder = &remainder[index + part.len()..];
    }

    ends_with_wildcard
        || parts.last().is_none_or(|last| last.is_empty() || remainder.is_empty())
}
```

`wildcard_match` 按 `*` 分割模式为多个部分，然后逐个在值中查找。如果模式以 `*` 开头，第一个部分不要求在开头匹配；如果模式以 `*` 结尾，最后一个部分不要求在结尾匹配。中间的部分必须按顺序出现。例如 `"Bash*"` 匹配 `BashTool`、`BashRunner`；`"*File"` 匹配 `ReadFile`、`WriteFile`。

测试验证了这个匹配器：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs (tests)

    let read_result = runner.run_pre_tool_use("ReadFile", r#"{"path":"README.md"}"#);
    let bash_result = runner.run_pre_tool_use("Bash", r#"{"command":"pwd"}"#);

    assert_eq!(read_result.messages(), &["legacy", "read only"]);
    assert_eq!(bash_result.messages(), &["legacy", "bash only"]);
```

三个命令——`legacy`（无 matcher，匹配所有）、`bash only`（matcher `Bash`）、`read only`（matcher `Read*`）——`ReadFile` 匹配 `legacy` 和 `read only`，`Bash` 匹配 `legacy` 和 `bash only`。

## 9.7 取消信号与进度报告

### HookAbortSignal

`HookAbortSignal` 提供可共享的取消信号：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

pub struct HookAbortSignal {
    aborted: Arc<AtomicBool>,
}

impl HookAbortSignal {
    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }
}
```

`Arc<AtomicBool>` 允许多线程共享——`abort` 和 `is_aborted` 可以在不同线程调用。`Ordering::SeqCst` 保证全序一致性。`output_with_stdin` 在轮询子进程时定期检查 `is_aborted`：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

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
```

轮询周期 20 毫秒——既不会占用太多 CPU，又能及时响应取消。`try_wait()` 非阻塞检查子进程是否退出。`child.kill()` 发送 SIGKILL，然后 `wait_with_output()` 等待进程实际终止。

### HookProgressReporter

`HookProgressReporter` 是 trait，用于报告钩子执行进度：

```rust
// claw-code/rust/crates/runtime/src/hooks.rs

pub trait HookProgressReporter {
    fn on_event(&mut self, event: &HookProgressEvent);
}

pub enum HookProgressEvent {
    Started { event: HookEvent, tool_name: String, command: String },
    Completed { event: HookEvent, tool_name: String, command: String },
    Cancelled { event: HookEvent, tool_name: String, command: String },
}
```

CLI 前端实现这个 trait，在 `Started` 时显示钩子执行信息，在 `Completed` 时更新状态。`reporter` 是 `Option<&mut dyn HookProgressReporter>`——可选参数，如果不需要进度报告可以传 `None`。

## 小结

钩子系统在 Rust 端以 `HookRunner`（`hooks.rs`）执行用户自定义的 shell 命令，覆盖工具执行的三个生命周期：`PreToolUse`（执行前，可修改输入、覆盖权限）、`PostToolUse`（成功执行后，可追加反馈）、`PostToolUseFailure`（执行失败后，可分析错误）。`RuntimeHookCommand`（`config.rs`）支持可选的 `matcher` 字段，用 `hook_matcher_matches` 实现多模式通配符匹配（逗号/管道分隔，支持 `*` 通配符）。

钩子命令通过 stdin 接收 JSON payload（包含事件类型、工具名、输入、输出），通过 stdout 返回结构化输出。`parse_hook_output` 解析 `systemMessage`、`reason`、`decision`、`hookSpecificOutput`（`permissionDecision`、`updatedInput`）等字段。退出码 0 表示成功（可含 `deny` 覆盖）、2 表示拒绝、其他非零表示失败。`HookAbortSignal` 用 `Arc<AtomicBool>` 提供可取消的执行，`HookProgressReporter` 报告执行进度。

钩子系统与权限系统（第8章）通过 `PermissionOverride` 交互——PreToolUse 钩子可以返回 `Allow`/`Deny`/`Ask` 覆盖权限决策，也可以返回 `updatedInput` 修改工具输入。权限系统的 `authorize_with_context` 在评估流程中检查钩子覆盖，但 ask 规则的优先级高于钩子的 `Allow` 覆盖。

| 关键文件 | 核心机制 | 对应章节 |
| --- | --- | --- |
| `rust/crates/runtime/src/hooks.rs` | `HookRunner`、命令执行、输出解析、取消信号 | 9.1-9.7 |
| `rust/crates/runtime/src/config.rs` | `RuntimeHookConfig`、`RuntimeHookCommand`、matcher 配置 | 9.6 |

下一章将分析会话管理——`Session` 结构如何存储对话历史，`ContentBlock` 枚举如何表示消息内容，以及 `compact_session` 如何在 token 超限前压缩历史。
