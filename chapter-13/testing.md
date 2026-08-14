# 第13章 测试与质量保障：Mock Parity Harness 与行为验证

## 本章概览

本章分析 claw-code 的测试体系——如何通过模拟服务、端到端 harness 和兼容性审计来保证 Rust 实现与原始参考实现的行为一致。对应 `mock-anthropic-service`、`rusty-claude-cli/tests/mock_parity_harness.rs` 和 `compat-harness` crate。

测试要解决的核心问题是：Rust 实现（claw-code）需要与原始参考实现（upstream）保持行为一致。当功能被移植到 Rust 时，任何细微的行为差异都会导致用户-facing 的不一致（如权限判断不同、消息格式不同、token 计算不同）。测试系统通过模拟 Anthropic API、端到端场景测试、以及源码级兼容性审计来捕获这些差异。

| 关键文件 | 职责 |
| --- | --- |
| `rust/crates/mock-anthropic-service/src/lib.rs` | `MockAnthropicService` 模拟 Anthropic API 端点 |
| `rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs` | 端到端 parity 测试 harness，12 个场景 |
| `rust/crates/compat-harness/src/lib.rs` | `extract_manifest` 从 upstream 源码提取命令/工具/启动计划 |
| `rust/scripts/run_mock_parity_harness.sh` | 测试运行脚本 |

## 13.1 MockAnthropicService：API 模拟

`MockAnthropicService` 是一个轻量级的 HTTP 服务器，模拟 Anthropic API 的 `/v1/messages` 和 `/v1/messages/count_tokens` 端点：

```rust
// claw-code/rust/crates/mock-anthropic-service/src/lib.rs

pub struct MockAnthropicService {
    base_url: String,
    requests: Arc<Mutex<Vec<CapturedRequest>>>,
    shutdown: Option<oneshot::Sender<()>>,
    join_handle: JoinHandle<()>,
}

pub struct CapturedRequest {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub scenario: String,
    pub stream: bool,
    pub raw_body: String,
}
```

`requests` 记录所有捕获的请求——用于测试后验证请求序列。`shutdown` 是 `oneshot` 通道发送者，用于优雅关闭。`join_handle` 是 tokio 任务句柄。

启动：

```rust
// claw-code/rust/crates/mock-anthropic-service/src/lib.rs

impl MockAnthropicService {
    pub async fn spawn() -> io::Result<Self> {
        Self::spawn_on("127.0.0.1:0").await
    }

    pub async fn spawn_on(bind_addr: &str) -> io::Result<Self> {
        let listener = TcpListener::bind(bind_addr).await?;
        let address = listener.local_addr()?;
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
        let request_state = Arc::clone(&requests);

        let join_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break; };
                        let request_state = Arc::clone(&request_state);
                        tokio::spawn(async move {
                            let _ = handle_connection(socket, request_state).await;
                        });
                    }
                }
            }
        });

        Ok(Self { base_url: format!("http://{address}"), requests, shutdown: Some(shutdown_tx), join_handle })
    }
}
```

`spawn_on("127.0.0.1:0")` 绑定到随机端口——`local_addr()` 返回实际分配的地址。`tokio::select!` 同时监听 `shutdown_rx` 和 `listener.accept()`——收到关闭信号时停止接受新连接。每个连接在独立的 tokio task 中处理。

`Drop` 实现优雅关闭：

```rust
// claw-code/rust/crates/mock-anthropic-service/src/lib.rs

impl Drop for MockAnthropicService {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.join_handle.abort();
    }
}
```

`drop` 发送关闭信号，然后 `abort` 任务。`send` 可能失败（如果接收端已关闭），但 `let _ =` 忽略错误。`abort` 是兜底——如果 `select!` 的 `shutdown` 分支因某种原因未触发，强制终止任务。

### 场景检测

Mock 服务根据请求内容检测测试场景：

```rust
// claw-code/rust/crates/mock-anthropic-service/src/lib.rs

enum Scenario {
    StreamingText,
    ReadFileRoundtrip,
    GrepChunkAssembly,
    WriteFileAllowed,
    WriteFileDenied,
    MultiToolTurnRoundtrip,
    BashStdoutRoundtrip,
    BashPermissionPromptApproved,
    BashPermissionPromptDenied,
    PluginToolRoundtrip,
    AutoCompactTriggered,
    TokenCostReporting,
}
```

场景检测从请求的系统提示中提取 `PARITY_SCENARIO:scenario_name` 标记。每个场景对应一种端到端测试用例——如 `ReadFileRoundtrip` 测试 read_file 工具的完整往返，`WriteFileDenied` 测试权限拒绝路径。12 个场景覆盖了核心功能路径：流式文本、文件读写、grep 搜索、权限控制、多工具轮次、bash 执行、插件工具、自动压缩、token 成本报告。

## 13.2 MockParityHarness：端到端测试

`mock_parity_harness.rs` 定义了端到端测试 harness。每个场景是一个完整的 CLI 执行——启动真实的 rusty-claude 二进制，连接 mock 服务，验证输出：

```rust
// claw-code/rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs

struct ScenarioCase {
    name: &'static str,
    permission_mode: &'static str,
    allowed_tools: Option<&'static str>,
    stdin: Option<&'static str>,
    prepare: fn(&HarnessWorkspace),
    assert: fn(&HarnessWorkspace, &ScenarioRun),
    extra_env: Option<(&'static str, &'static str)>,
    resume_session: Option<&'static str>,
}
```

`name` 是场景名。`permission_mode` 是权限模式（`read-only`、`workspace-write`、`danger-full-access`）。`allowed_tools` 是允许的工具列表（逗号分隔）。`stdin` 是交互输入（如权限提示时输入 `y` 或 `n`）。`prepare` 是准备函数（创建 fixture 文件）。`assert` 是验证函数。`extra_env` 是额外环境变量。`resume_session` 是恢复会话的 ID。

场景定义示例：

```rust
// claw-code/rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs

ScenarioCase {
    name: "read_file_roundtrip",
    permission_mode: "read-only",
    allowed_tools: Some("read_file"),
    stdin: None,
    prepare: prepare_read_fixture,
    assert: assert_read_file_roundtrip,
    extra_env: None,
    resume_session: None,
},

ScenarioCase {
    name: "bash_permission_prompt_approved",
    permission_mode: "workspace-write",
    allowed_tools: Some("bash"),
    stdin: Some("y\n"),
    prepare: prepare_noop,
    assert: assert_bash_permission_prompt_approved,
    extra_env: None,
    resume_session: None,
},
```

`read_file_roundtrip` 在只读模式下只允许 `read_file`，测试文件读取的完整往返。`bash_permission_prompt_approved` 在 `workspace-write` 模式下允许 `bash`，需要交互输入 `y` 来批准权限提示。

### 测试执行流程

```rust
// claw-code/rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs

fn run_case(case: ScenarioCase, workspace: &HarnessWorkspace, base_url: &str) -> ScenarioRun {
    let mut command = Command::new(env!("CARGO_BIN_EXE_claw"));
    command
        .current_dir(&workspace.root)
        .env_clear()
        .env("ANTHROPIC_API_KEY", "test-parity-key")
        .env("ANTHROPIC_BASE_URL", base_url)
        .env("CLAW_CONFIG_HOME", &workspace.config_home)
        .env("HOME", &workspace.home)
        .env("NO_COLOR", "1")
        .env("PATH", "/usr/bin:/bin")
        .args(["--model", "sonnet", "--permission-mode", case.permission_mode, "--output-format=json"]);

    if let Some(allowed_tools) = case.allowed_tools {
        command.args(["--allowedTools", allowed_tools]);
    }

    let prompt = format!("{SCENARIO_PREFIX}{}", case.name);
    command.arg(prompt);

    let output = if let Some(stdin) = case.stdin {
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("claw should launch");
        child.stdin.as_mut().expect("stdin should be piped").write_all(stdin.as_bytes()).expect("stdin should write");
        child.wait_with_output().expect("claw should finish")
    } else {
        command.output().expect("claw should launch")
    };

    assert_success(&output);
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    ScenarioRun { response: parse_json_output(&stdout), stdout }
}
```

`env_clear()` 清除所有环境变量——确保测试不受外部环境影响。`ANTHROPIC_API_KEY` 和 `ANTHROPIC_BASE_URL` 指向 mock 服务。`CLAW_CONFIG_HOME` 和 `HOME` 指向临时目录——避免污染用户配置。`prompt` 包含 `PARITY_SCENARIO:scenario_name` 前缀，mock 服务据此识别场景。

`HarnessWorkspace` 创建隔离的工作空间：

```rust
// claw-code/rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs

struct HarnessWorkspace {
    root: PathBuf,
    config_home: PathBuf,
    home: PathBuf,
}

impl HarnessWorkspace {
    fn new(root: PathBuf) -> Self {
        Self { config_home: root.join("config-home"), home: root.join("home"), root }
    }

    fn create(&self) -> std::io::Result<()> {
        fs::create_dir_all(&self.root)?;
        fs::create_dir_all(&self.config_home)?;
        fs::create_dir_all(&self.home)?;
        Ok(())
    }
}
```

每个场景使用独立的临时目录，测试结束后 `fs::remove_dir_all` 清理。这保证了测试之间的隔离。

### 场景验证

测试不仅验证输出，还验证请求序列。`captured_requests` 从 mock 服务获取所有请求：

```rust
// claw-code/rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs

    let captured = runtime.block_on(server.captured_requests());
    let messages_only: Vec<_> = captured.iter().filter(|r| r.path == "/v1/messages").collect();
    assert_eq!(messages_only.len(), 21, "twelve scenarios should produce twenty-one /v1/messages requests");
    assert!(messages_only.iter().all(|request| request.stream));

    let scenarios = messages_only.iter().map(|request| request.scenario.as_str()).collect::<Vec<_>>();
    assert_eq!(scenarios, vec![
        "streaming_text",
        "read_file_roundtrip", "read_file_roundtrip",
        "grep_chunk_assembly", "grep_chunk_assembly",
        "write_file_allowed", "write_file_allowed",
        "write_file_denied", "write_file_denied",
        "multi_tool_turn_roundtrip", "multi_tool_turn_roundtrip",
        "bash_stdout_roundtrip", "bash_stdout_roundtrip",
        "bash_permission_prompt_approved", "bash_permission_prompt_approved",
        "bash_permission_prompt_denied", "bash_permission_prompt_denied",
        "plugin_tool_roundtrip", "plugin_tool_roundtrip",
        "auto_compact_triggered",
        "token_cost_reporting",
    ]);
```

12 个场景产生 21 个 `/v1/messages` 请求——因为大多数场景需要多轮对话（用户 → 工具请求 → 工具结果 → 最终回答）。`streaming_text` 和 `token_cost_reporting` 是单轮，其他是双轮。`all(|request| request.stream)` 验证所有请求都是流式（SSE）。请求序列的顺序验证端到端流程的正确性。

### 请求计数验证

```rust
// claw-code/rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs

    let mut request_counts = BTreeMap::new();
    for request in &captured {
        *request_counts.entry(request.scenario.as_str()).or_insert(0_usize) += 1;
    }
    for report in &mut scenario_reports {
        report.request_count = *request_counts.get(report.name.as_str()).unwrap_or_else(|| panic!("missing request count for {}", report.name));
    }
```

每个场景的请求计数被记录到 `scenario_reports` 中。如果新增功能改变了请求计数（如添加 `count_tokens` 预检），测试会失败，提醒开发者更新预期。注释中提到 `be561bf` 提交增加了 `count_tokens` 预检，导致总请求数从 21 变为更多，测试被更新为只过滤 `/v1/messages` 路径。

## 13.3 CompatHarness：源码级兼容性审计

`compat-harness` crate 从原始 upstream 的 TypeScript 源码中提取命令、工具和启动计划清单，用于审计 Rust 实现是否覆盖了所有功能：

```rust
// claw-code/rust/crates/compat-harness/src/lib.rs

pub struct ExtractedManifest {
    pub commands: CommandRegistry,
    pub tools: ToolRegistry,
    pub bootstrap: BootstrapPlan,
}

pub fn extract_manifest(paths: &UpstreamPaths) -> std::io::Result<ExtractedManifest> {
    let commands_source = fs::read_to_string(paths.commands_path())?;
    let tools_source = fs::read_to_string(paths.tools_path())?;
    let cli_source = fs::read_to_string(paths.cli_path())?;

    Ok(ExtractedManifest {
        commands: extract_commands(&commands_source),
        tools: extract_tools(&tools_source),
        bootstrap: extract_bootstrap_plan(&cli_source),
    })
}
```

`extract_manifest` 读取三个 TypeScript 文件：`src/commands.ts`（命令定义）、`src/tools.ts`（工具定义）、`src/entrypoints/cli.tsx`（CLI 入口）。通过静态分析提取符号清单。

### 命令提取

```rust
// claw-code/rust/crates/compat-harness/src/lib.rs

pub fn extract_commands(source: &str) -> CommandRegistry {
    let mut entries = Vec::new();
    let mut in_internal_block = false;

    for raw_line in source.lines() {
        let line = raw_line.trim();

        if line.starts_with("export const INTERNAL_ONLY_COMMANDS = [") {
            in_internal_block = true;
            continue;
        }

        if in_internal_block {
            if line.starts_with(']') {
                in_internal_block = false;
                continue;
            }
            if let Some(name) = first_identifier(line) {
                entries.push(CommandManifestEntry { name, source: CommandSource::InternalOnly });
            }
            continue;
        }

        if line.starts_with("import ") {
            for imported in imported_symbols(line) {
                entries.push(CommandManifestEntry { name: imported, source: CommandSource::Builtin });
            }
        }

        if line.contains("feature('") && line.contains("./commands/") {
            if let Some(name) = first_assignment_identifier(line) {
                entries.push(CommandManifestEntry { name, source: CommandSource::FeatureGated });
            }
        }
    }

    dedupe_commands(entries)
}
```

`extract_commands` 通过简单的文本模式匹配提取命令符号。`INTERNAL_ONLY_COMMANDS` 块标记内部命令。`import` 语句提取导入的符号。`feature('...')` 和 `./commands/` 模式标记 feature-gated 命令。`first_identifier` 从行首提取第一个标识符（字母、数字、下划线、连字符）。`dedupe_commands` 去重。

### 工具提取

```rust
// claw-code/rust/crates/compat-harness/src/lib.rs

pub fn extract_tools(source: &str) -> ToolRegistry {
    let mut entries = Vec::new();

    for raw_line in source.lines() {
        let line = raw_line.trim();
        if line.starts_with("import ") && line.contains("./tools/") {
            for imported in imported_symbols(line) {
                if imported.ends_with("Tool") {
                    entries.push(ToolManifestEntry { name: imported, source: ToolSource::Base });
                }
            }
        }

        if line.contains("feature('") && line.contains("Tool") {
            if let Some(name) = first_assignment_identifier(line) {
                if name.ends_with("Tool") || name.ends_with("Tools") {
                    entries.push(ToolManifestEntry { name, source: ToolSource::Conditional });
                }
            }
        }
    }

    dedupe_tools(entries)
}
```

工具提取与命令类似，但过滤 `ends_with("Tool")` 或 `ends_with("Tools")` 的符号。`Base` 来源表示基础工具，`Conditional` 表示 feature-gated 条件工具。

### 启动计划提取

```rust
// claw-code/rust/crates/compat-harness/src/lib.rs

pub fn extract_bootstrap_plan(source: &str) -> BootstrapPlan {
    let mut phases = vec![BootstrapPhase::CliEntry];

    if source.contains("--version") {
        phases.push(BootstrapPhase::FastPathVersion);
    }
    if source.contains("startupProfiler") {
        phases.push(BootstrapPhase::StartupProfiler);
    }
    if source.contains("--dump-system-prompt") {
        phases.push(BootstrapPhase::SystemPromptFastPath);
    }
    if source.contains("--claude-in-chrome-mcp") {
        phases.push(BootstrapPhase::ChromeMcpFastPath);
    }
    if source.contains("--daemon-worker") {
        phases.push(BootstrapPhase::DaemonWorkerFastPath);
    }
    if source.contains("remote-control") {
        phases.push(BootstrapPhase::BridgeFastPath);
    }
    if source.contains("args[0] === 'daemon'") {
        phases.push(BootstrapPhase::DaemonFastPath);
    }
    if source.contains("args[0] === 'ps' || args.includes('--bg')") {
        phases.push(BootstrapPhase::BackgroundSessionFastPath);
    }
    if source.contains("args[0] === 'new' || args[0] === 'list' || args[0] === 'reply'") {
        phases.push(BootstrapPhase::TemplateFastPath);
    }
    if source.contains("environment-runner") {
        phases.push(BootstrapPhase::EnvironmentRunnerFastPath);
    }
    phases.push(BootstrapPhase::MainRuntime);

    BootstrapPlan::from_phases(phases)
}
```

启动计划提取通过字符串包含检查检测 CLI 源码中的快速路径分支。每个 `contains` 检查对应一个特定的 CLI 参数或功能。`BootstrapPlan::from_phases` 构建启动计划。这种方法是粗略的——它只能检测代码中存在某个字符串，不能验证实现是否正确，但足以作为覆盖率检查清单。

### 路径解析

`UpstreamPaths` 解析 upstream 仓库位置：

```rust
// claw-code/rust/crates/compat-harness/src/lib.rs

pub struct UpstreamPaths {
    repo_root: PathBuf,
}

impl UpstreamPaths {
    pub fn from_workspace_dir(workspace_dir: impl AsRef<Path>) -> Self {
        let workspace_dir = workspace_dir.as_ref().canonicalize().unwrap_or_else(|_| workspace_dir.as_ref().to_path_buf());
        let primary_repo_root = workspace_dir.parent().map_or_else(|| PathBuf::from(".."), Path::to_path_buf);
        let repo_root = resolve_upstream_repo_root(&primary_repo_root);
        Self { repo_root }
    }
}

fn resolve_upstream_repo_root(primary_repo_root: &Path) -> PathBuf {
    let candidates = upstream_repo_candidates(primary_repo_root);
    candidates.into_iter().find(|candidate| candidate.join("src/commands.ts").is_file()).unwrap_or_else(|| primary_repo_root.to_path_buf())
}

fn upstream_repo_candidates(primary_repo_root: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![primary_repo_root.to_path_buf()];

    if let Some(explicit) = std::env::var_os("CLAUDE_CODE_UPSTREAM") {
        candidates.push(PathBuf::from(explicit));
    }

    for ancestor in primary_repo_root.ancestors().take(4) {
        candidates.push(ancestor.join("claw-code"));
        candidates.push(ancestor.join("clawd-code"));
    }

    candidates.push(primary_repo_root.join("reference-source").join("claw-code"));
    candidates.push(primary_repo_root.join("vendor").join("claw-code"));

    let mut deduped = Vec::new();
    for candidate in candidates {
        if !deduped.iter().any(|seen: &PathBuf| seen == &candidate) {
            deduped.push(candidate);
        }
    }
    deduped
}
```

`upstream_repo_candidates` 生成多个候选路径：直接父目录、`CLAUDE_CODE_UPSTREAM` 环境变量、祖先目录下的 `claw-code`/`clawd-code`、`reference-source`/`vendor` 子目录。`resolve_upstream_repo_root` 找到第一个包含 `src/commands.ts` 的候选。这种设计允许 upstream 源码放在多个位置，测试自动适配。

## 13.4 测试脚本与 CI 集成

`run_mock_parity_harness.sh` 是测试入口：

```bash
# claw-code/rust/scripts/run_mock_parity_harness.sh

#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

cargo test -p rusty-claude-cli --test mock_parity_harness -- --nocapture
```

`set -euo pipefail` 是严格的 bash 模式：`-e` 命令失败时退出，`-u` 未定义变量报错，`-o pipefail` 管道中任一命令失败时整体失败。`cargo test -p rusty-claude-cli --test mock_parity_harness` 只运行 `rusty-claude-cli` 包的 `mock_parity_harness` 集成测试。`--nocapture` 允许打印输出（方便调试失败场景）。

这个脚本可以被 CI 调用——每次提交时自动运行 12 个端到端场景，验证核心功能路径的行为一致性。

## 13.5 测试设计原则

Mock Parity Harness 的设计体现了几条测试原则：

隔离性。每个场景使用独立的 `HarnessWorkspace`——临时目录、独立配置、独立环境变量。测试之间不会互相污染。`env_clear()` 确保外部配置不影响测试结果。

可重现性。Mock 服务是确定性的——给定相同的场景名称，总是返回相同的响应。没有外部网络依赖，测试在任何环境都能运行。

覆盖率。12 个场景覆盖了核心功能路径：流式文本、文件读取、grep 搜索、文件写入（允许和拒绝）、多工具轮次、bash 执行、权限提示（批准和拒绝）、插件工具、自动压缩、token 成本报告。每个场景验证一个完整的用户工作流。

请求审计。不仅验证输出，还验证请求序列——21 个 `/v1/messages` 请求的顺序和场景匹配。这捕获了行为回归——如新增 `count_tokens` 预检导致请求数变化。

源码审计。`compat-harness` 从 upstream 源码提取清单，作为功能覆盖率的检查表。Rust 实现中的工具列表、命令列表、启动阶段可以与提取的清单对比，发现遗漏。

## 小结

测试系统在 Rust 端以三层架构实现：`MockAnthropicService`（`mock-anthropic-service`）模拟 Anthropic API 端点，通过场景检测从请求系统提示中提取 `PARITY_SCENARIO` 标记，返回确定性响应；`MockParityHarness`（`rusty-claude-cli/tests`）执行 12 个端到端场景，每个场景启动真实 CLI 进程连接 mock 服务，验证输出和请求序列（21 个 `/v1/messages` 请求的顺序和场景匹配）；`CompatHarness`（`compat-harness`）从 upstream TypeScript 源码静态提取命令、工具和启动计划清单，用于审计覆盖率。

测试设计强调隔离（独立临时工作空间、环境变量清除）、可重现（确定性 mock 响应、无网络依赖）、和审计（请求序列计数、源码清单对比）。`run_mock_parity_harness.sh` 脚本集成到 CI，每次提交自动运行端到端验证。

| 关键文件 | 核心机制 | 对应章节 |
| --- | --- | --- |
| `rust/crates/mock-anthropic-service/src/lib.rs` | `MockAnthropicService`、TCP 监听、场景检测、请求捕获 | 13.1 |
| `rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs` | 12 场景端到端测试、`HarnessWorkspace`、请求序列验证 | 13.2 |
| `rust/crates/compat-harness/src/lib.rs` | `extract_manifest`、源码静态分析、路径解析 | 13.3 |
| `rust/scripts/run_mock_parity_harness.sh` | CI 集成脚本 | 13.4 |

下一章将分析 TypeScript、Python 和 Rust 三端的实现对比——相同功能在不同技术栈中的架构差异和设计权衡。
