# 第10章 会话管理：Session 状态机与自动压缩

## 本章概览

本章分析 claw-code 的会话管理系统——如何持久化对话历史、按工作区分隔离存储、以及在 token 预算超限前自动压缩历史。对应 `runtime::session`、`runtime::compact` 和 `runtime::session_control` 模块。

会话管理要解决的核心问题是：长期对话会积累大量消息，每次 API 调用都发送完整历史会消耗 token 和延迟。系统需要在保持上下文连贯的前提下，把旧消息压缩为摘要，保留最近的消息，同时把对话历史持久化到磁盘以便恢复。

| 关键文件 | 职责 |
| --- | --- |
| `rust/crates/runtime/src/session.rs` | `Session` 结构、`ContentBlock` 枚举、消息持久化、序列化 |
| `rust/crates/runtime/src/compact.rs` | `compact_session` 自动压缩、摘要生成、边界保留 |
| `rust/crates/runtime/src/session_control.rs` | `SessionStore` 工作区隔离、会话列表、恢复、分叉 |

## 10.1 消息模型：ContentBlock 与 ConversationMessage

会话的核心数据结构是 `ContentBlock` 枚举，表示消息内容的四种类型：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub enum ContentBlock {
    Text { text: String },
    Thinking { thinking: String, signature: Option<String> },
    ToolUse { id: String, name: String, input: String },
    ToolResult { tool_use_id: String, tool_name: String, output: String, is_error: bool },
}
```

`Text` 是普通文本块。`Thinking` 是模型的思考过程（Anthropic 的 extended thinking 功能），包含可选的签名用于验证。`ToolUse` 是模型请求调用工具——`id` 用于匹配工具结果，`name` 是工具名，`input` 是 JSON 参数。`ToolResult` 是工具执行结果——`tool_use_id` 匹配对应的 `ToolUse`，`is_error` 标记错误。

`ConversationMessage` 包装一组 `ContentBlock`：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub struct ConversationMessage {
    pub role: MessageRole,
    pub blocks: Vec<ContentBlock>,
    pub usage: Option<TokenUsage>,
}

pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}
```

`role` 区分发言者——`System` 是系统提示和压缩摘要，`User` 是用户输入，`Assistant` 是模型输出，`Tool` 是工具结果。`blocks` 是内容块列表，一条消息可以包含多个块（如文本 + 工具调用）。`usage` 是可选的 token 使用统计。

`ConversationMessage` 提供构造函数：

```rust
// claw-code/rust/crates/runtime/src/session.rs

impl ConversationMessage {
    pub fn user_text(text: impl Into<String>) -> Self {
        Self {
            role: MessageRole::User,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            usage: None,
        }
    }

    pub fn assistant(blocks: Vec<ContentBlock>) -> Self {
        Self { role: MessageRole::Assistant, blocks, usage: None }
    }

    pub fn tool_result(
        tool_use_id: impl Into<String>,
        tool_name: impl Into<String>,
        output: impl Into<String>,
        is_error: bool,
    ) -> Self {
        Self {
            role: MessageRole::Tool,
            blocks: vec![ContentBlock::ToolResult {
                tool_use_id: tool_use_id.into(),
                tool_name: tool_name.into(),
                output: output.into(),
                is_error,
            }],
            usage: None,
        }
    }
}
```

`user_text` 创建单文本块的 `User` 消息。`assistant` 创建 `Assistant` 消息，需要传入完整的 blocks 列表。`tool_result` 创建 `Tool` 消息，包装 `ContentBlock::ToolResult`。

## 10.2 Session 结构：状态与生命周期

`Session` 是会话的完整状态容器：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub struct Session {
    pub version: u32,
    pub session_id: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub messages: Vec<ConversationMessage>,
    pub compaction: Option<SessionCompaction>,
    pub fork: Option<SessionFork>,
    pub workspace_root: Option<PathBuf>,
    pub prompt_history: Vec<SessionPromptEntry>,
    pub last_health_check_ms: Option<u64>,
    pub model: Option<String>,
    persistence: Option<SessionPersistence>,
}
```

`version` 是序列化格式版本（当前为 1），用于向后兼容。`session_id` 是全局唯一标识，格式为 `timestamp-random`（如 `1723123456789-abc123`）。`created_at_ms` 和 `updated_at_ms` 是时间戳。`messages` 是完整对话历史。`compaction` 记录压缩历史——`count` 是压缩次数，`removed_message_count` 是移除的消息数，`summary` 是压缩摘要。`fork` 记录分叉来源——`parent_session_id` 和 `branch_name`。`workspace_root` 绑定会话到工作区目录。`prompt_history` 记录用户输入历史（用于 `/clear` 后恢复上下文）。`model` 记录使用的模型名。`persistence` 是私有字段，存储磁盘路径。

`new()` 创建新会话：

```rust
// claw-code/rust/crates/runtime/src/session.rs

impl Session {
    pub fn new() -> Self {
        let now = current_time_millis();
        Self {
            version: SESSION_VERSION,
            session_id: generate_session_id(),
            created_at_ms: now,
            updated_at_ms: now,
            messages: Vec::new(),
            compaction: None,
            fork: None,
            workspace_root: None,
            prompt_history: Vec::new(),
            last_health_check_ms: None,
            model: None,
            persistence: None,
        }
    }
```

`generate_session_id()` 基于当前毫秒时间戳和原子计数器生成唯一 ID——`SESSION_ID_COUNTER` 是 `AtomicU64`，`LAST_TIMESTAMP_MS` 确保同一毫秒内的 ID 不重复。

`push_message` 添加消息并增量持久化：

```rust
// claw-code/rust/crates/runtime/src/session.rs

    pub fn push_message(&mut self, message: ConversationMessage) -> Result<(), SessionError> {
        self.touch();
        self.messages.push(message);
        let persist_result = {
            let message_ref = self.messages.last().ok_or_else(|| {
                SessionError::Format("message was just pushed but missing".to_string())
            })?;
            self.append_persisted_message(message_ref)
        };
        if let Err(error) = persist_result {
            self.messages.pop();
            return Err(error);
        }
        Ok(())
    }
```

消息先推入内存，再尝试持久化。如果持久化失败，回滚内存修改（`pop`）。这个设计保证内存和磁盘状态一致——不会出现消息在内存中但不在磁盘中的情况。

`append_persisted_message` 实现增量写入：

```rust
// claw-code/rust/crates/runtime/src/session.rs

    fn append_persisted_message(&self, message: &ConversationMessage) -> Result<(), SessionError> {
        let Some(path) = self.persistence_path() else {
            return Ok(());
        };

        let needs_bootstrap = !path.exists() || fs::metadata(path)?.len() == 0;
        if needs_bootstrap {
            self.save_to_path(path)?;
            return Ok(());
        }

        let mut file = OpenOptions::new().append(true).open(path)?;
        writeln!(file, "{}", message_record(message).render())?;
        Ok(())
    }
```

如果文件不存在或为空，写入完整快照（`save_to_path` 调用 `render_jsonl_snapshot`）。否则以追加模式写入单条消息记录。增量写入避免每次 `push_message` 都重写整个文件——长期会话可能有几 MB 历史，增量写入是 O(1) 而不是 O(n)。

## 10.3 持久化格式：JSONL 与原子写入

会话支持两种持久化格式：JSON（旧版）和 JSONL（新版）。`save_to_path` 统一使用 JSONL 格式。

JSONL 格式每行是一个 JSON 对象，带 `type` 字段区分记录类型：

```json
{"type":"session_meta","version":1,"session_id":"1723123456789-abc123","created_at_ms":1723123456789,"updated_at_ms":1723123456790}
{"type":"message","message":{"role":"user","blocks":[{"type":"text","text":"hello"}]}}
{"type":"message","message":{"role":"assistant","blocks":...}}
```

`render_jsonl_snapshot` 生成完整快照：

```rust
// claw-code/rust/crates/runtime/src/session.rs

    fn render_jsonl_snapshot(&self) -> Result<String, SessionError> {
        let mut lines = vec![self.meta_record()?.render()];
        if let Some(compaction) = &self.compaction {
            lines.push(compaction.to_jsonl_record()?.render());
        }
        lines.extend(self.prompt_history.iter().map(|entry| entry.to_jsonl_record().render()));
        lines.extend(self.messages.iter().map(|message| message_record(message).render()));
        let mut rendered = lines.join("\n");
        rendered.push('\n');
        Ok(rendered)
    }
```

快照顺序：meta → compaction → prompt_history → messages。每行一个 JSON 对象，末尾加换行。增量写入时只追加 `message` 和 `prompt_history` 记录。

`write_atomic` 实现原子写入：

```rust
// claw-code/rust/crates/runtime/src/session.rs (write_atomic 函数)

fn write_atomic(path: impl AsRef<Path>, contents: &str) -> Result<(), SessionError> {
    let path = path.as_ref();
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, contents)?;
    fs::rename(&temp_path, path)?;
    Ok(())
}
```

先写入临时文件，再 `rename` 覆盖目标文件。`rename` 在文件系统层面是原子操作——进程崩溃不会留下半写文件。临时文件与目标文件同目录，确保 `rename` 是硬链接重命名而不是跨文件系统复制。

`load_from_path` 支持两种格式自动识别：

```rust
// claw-code/rust/crates/runtime/src/session.rs

    pub fn load_from_path(path: impl AsRef<Path>) -> Result<Self, SessionError> {
        let path = path.as_ref();
        let contents = fs::read_to_string(path)?;
        let session = match JsonValue::parse(&contents) {
            Ok(value) if value.as_object().is_some_and(|object| object.contains_key("messages")) => {
                Self::from_json(&value)?
            }
            Err(_) | Ok(_) => Self::from_jsonl(&contents)?,
        };
        Ok(session.with_persistence_path(path.to_path_buf()))
    }
```

如果内容能解析为 JSON 对象且包含 `messages` 键，按旧版 JSON 格式加载。否则按 JSONL 逐行解析。`from_jsonl` 遍历每行，根据 `type` 字段分发到不同的解析逻辑。

日志轮转：

```rust
// claw-code/rust/crates/runtime/src/session.rs (常量)

const ROTATE_AFTER_BYTES: u64 = 256 * 1024;
const MAX_ROTATED_FILES: usize = 3;
```

当会话文件超过 256 KB 时触发轮转——保存快照到新文件，删除旧轮转文件，保留最多 3 个历史版本。这个机制防止单文件无限增长，同时保留最近的几个版本用于恢复。

## 10.4 工作区隔离：SessionStore

`SessionStore` 按工作区目录隔离会话存储，避免多个项目共用全局目录导致的冲突：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

pub struct SessionStore {
    sessions_root: PathBuf,
    workspace_root: PathBuf,
}
```

`sessions_root` 是实际存储目录。`workspace_root` 是会话绑定的工作区目录。

两种构造方式：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

impl SessionStore {
    pub fn from_cwd(cwd: impl AsRef<Path>) -> Result<Self, SessionControlError> {
        let cwd = cwd.as_ref();
        let canonical_cwd = fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
        let sessions_root = canonical_cwd
            .join(".claw")
            .join("sessions")
            .join(workspace_fingerprint(&canonical_cwd));
        Ok(Self { sessions_root, workspace_root: canonical_cwd })
    }
```

`from_cwd` 从当前工作目录构建——目录布局为 `<cwd>/.claw/sessions/<workspace_hash>/`。`workspace_fingerprint` 用 FNV-1a 哈希生成 16 字符十六进制字符串，作为工作区的唯一标识。

`from_data_dir` 从显式数据目录构建：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

    pub fn from_data_dir(
        data_dir: impl AsRef<Path>,
        workspace_root: impl AsRef<Path>,
    ) -> Result<Self, SessionControlError> {
        let workspace_root = workspace_root.as_ref();
        let canonical_workspace = fs::canonicalize(workspace_root)
            .unwrap_or_else(|_| workspace_root.to_path_buf());
        let sessions_root = data_dir
            .as_ref()
            .join("sessions")
            .join(workspace_fingerprint(&canonical_workspace));
        Ok(Self { sessions_root, workspace_root: canonical_workspace })
    }
```

`from_data_dir` 用于 `--data-dir` 参数指定自定义存储位置。目录布局为 `<data_dir>/sessions/<workspace_hash>/`。

`workspace_fingerprint` 使用 FNV-1a 64 位哈希：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

pub fn workspace_fingerprint(workspace_root: &Path) -> String {
    let input = workspace_root.to_string_lossy();
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}
```

FNV-1a 是快速非加密哈希，适合目录分区。`0xcbf2_9ce4_8422_2325` 是 FNV-1a 64 位的初始偏移值。`wrapping_mul` 防止溢出——FNV-1a 定义了溢出行为，所以用 `wrapping_mul` 而不是 `overflowing_mul`。

`resolve_reference` 解析会话引用：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

    pub fn resolve_reference(&self, reference: &str) -> Result<SessionHandle, SessionControlError> {
        self.resolve_reference_excluding(reference, None)
    }

    pub fn resolve_reference_excluding(
        &self, reference: &str, exclude_id: Option<&str>,
    ) -> Result<SessionHandle, SessionControlError> {
        if is_session_reference_alias(reference) {
            let latest = self.latest_session_excluding(exclude_id)?;
            return Ok(SessionHandle { id: latest.id, path: latest.path });
        }

        let direct = PathBuf::from(reference);
        let candidate = if direct.is_absolute() { direct.clone() } else {
            self.workspace_root.join(&direct)
        };
        let looks_like_path = direct.extension().is_some() || direct.components().count() > 1;
        let path = if candidate.exists() { candidate }
        else if looks_like_path { return Err(...); }
        else { self.resolve_managed_path(reference)? };

        Ok(SessionHandle { id: session_id_from_path(&path).unwrap_or_else(|| reference.to_string()), path })
    }
```

引用分三类。别名引用：`latest`、`last`、`recent` 被解析为最近会话。路径引用：如果是绝对路径或相对路径，直接解析。ID 引用：否则按 managed path 解析（查找 `<workspace_hash>/<id>.jsonl`）。`exclude_id` 用于 `/resume latest` 跳过当前空会话。

`latest_session_excluding` 实现跨工作区搜索：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

    pub fn latest_session_excluding(&self, exclude_id: Option<&str>) -> Result<ManagedSessionSummary, SessionControlError> {
        let exclude = exclude_id.unwrap_or("");
        if let Some(latest) = self.list_sessions()?.into_iter()
            .find(|s| s.id != exclude && s.message_count > 0) {
            return Ok(latest);
        }
        if let Some(latest) = self.scan_global_sessions()?.into_iter()
            .find(|s| s.id != exclude && s.message_count > 0) {
            return Ok(latest);
        }
        // ... error handling
    }
```

先搜索当前工作区，如果没有找到，回退到全局搜索（扫描 `~/.claw/sessions/` 下的所有工作区）。`message_count > 0` 过滤空会话——避免 `/resume latest` 恢复一个没有任何对话的会话。

工作区验证：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

    fn validate_loaded_session(&self, session_path: &Path, session: &Session) -> Result<(), SessionControlError> {
        let Some(actual) = session.workspace_root() else {
            if path_is_within_workspace(session_path, &self.workspace_root) { return Ok(()); }
            return Err(SessionControlError::Format(...));
        };
        if workspace_roots_match(actual, &self.workspace_root) { return Ok(()); }
        Err(SessionControlError::WorkspaceMismatch { expected: self.workspace_root.clone(), actual: actual.to_path_buf() })
    }
```

加载会话时验证工作区匹配。如果会话没有 `workspace_root`（旧会话），检查文件路径是否在工作区内。如果工作区不匹配，返回 `WorkspaceMismatch` 错误——防止在错误目录恢复会话导致文件操作指向错误位置。

别名引用的跨工作区恢复：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

    pub fn load_session_loose(&self, reference: &str) -> Result<LoadedManagedSession, SessionControlError> {
        self.load_session_excluding(reference, None)
    }

    pub fn load_session_excluding(&self, reference: &str, exclude_id: Option<&str>) -> Result<LoadedManagedSession, SessionControlError> {
        let handle = self.resolve_reference_excluding(reference, exclude_id)?;
        let session = Session::load_from_path(&handle.path)?;
        if is_session_reference_alias(reference) {
            if let Err(SessionControlError::WorkspaceMismatch { expected: _, actual }) =
                self.validate_loaded_session(&handle.path, &session) {
                eprintln!("  Note: resuming session from a different workspace (origin: {})", actual.display());
            }
        } else {
            self.validate_loaded_session(&handle.path, &session)?;
        }
        Ok(LoadedManagedSession { handle: SessionHandle { id: session.session_id.clone(), path: handle.path }, session })
    }
```

别名引用允许跨工作区恢复——只打印警告不报错。显式 ID 引用仍然强制工作区匹配。这个设计允许用户从任意目录恢复最近会话，同时保留显式引用的安全验证。

## 10.5 自动压缩：Compaction

### CompactionConfig 与触发条件

`CompactionConfig` 控制压缩行为：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

pub struct CompactionConfig {
    pub preserve_recent_messages: usize,
    pub max_estimated_tokens: usize,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            preserve_recent_messages: 4,
            max_estimated_tokens: 10_000,
        }
    }
}
```

`preserve_recent_messages` 是保留的最近消息数（默认 4）。`max_estimated_tokens` 是触发压缩的阈值（默认 10,000）。

`should_compact` 判断是否需要压缩：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

pub fn should_compact(session: &Session, config: CompactionConfig) -> bool {
    let start = compacted_summary_prefix_len(session);
    let compactable = &session.messages[start..];

    compactable.len() > config.preserve_recent_messages
        && compactable.iter().map(estimate_message_tokens).sum::<usize>() >= config.max_estimated_tokens
}
```

`compacted_summary_prefix_len` 返回已有压缩摘要的偏移（如果第一条消息是系统压缩摘要，返回 1，否则返回 0）。`compactable` 是可压缩的消息范围。两个条件：可压缩消息数大于保留数，且 token 估计超过阈值。

`estimate_message_tokens` 是粗略估计：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

fn estimate_message_tokens(message: &ConversationMessage) -> usize {
    message.blocks.iter().map(|block| match block {
        ContentBlock::Text { text } => text.len() / 4,
        ContentBlock::Thinking { thinking, .. } => thinking.len() / 4,
        ContentBlock::ToolUse { input, .. } => input.len() / 4 + 50,
        ContentBlock::ToolResult { output, .. } => output.len() / 4 + 50,
    }).sum()
}
```

按字符长度除以 4 估算 token（假设平均 4 字符/ token）。`ToolUse` 和 `ToolResult` 额外加 50 token 开销。这个估算是粗略的——实际 token 数取决于分词器，但用于触发决策不需要精确。

### compact_session：压缩实现

`compact_session` 执行压缩：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

pub fn compact_session(session: &Session, config: CompactionConfig) -> CompactionResult {
    if !should_compact(session, config) {
        return CompactionResult {
            summary: String::new(), formatted_summary: String::new(),
            compacted_session: session.clone(), removed_message_count: 0,
        };
    }

    let existing_summary = session.messages.first().and_then(extract_existing_compacted_summary);
    let compacted_prefix_len = usize::from(existing_summary.is_some());
```

如果不满足压缩条件，返回克隆的原始会话。`existing_summary` 检查是否已有压缩摘要——如果第一条消息是系统摘要，提取它。

边界计算——保留最近消息，但确保不拆分工具对：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

    let raw_keep_from = if config.preserve_recent_messages == 0 {
        session.messages.len()
    } else {
        session.messages.len().saturating_sub(config.preserve_recent_messages)
    };

    let keep_from = {
        let mut k = raw_keep_from;
        loop {
            if k == 0 || k <= compacted_prefix_len || k >= session.messages.len() { break; }
            let first_preserved = &session.messages[k];
            let starts_with_tool_result = first_preserved.blocks.first().is_some_and(
                |b| matches!(b, ContentBlock::ToolResult { .. }));
            if !starts_with_tool_result { break; }
            let preceding = &session.messages[k - 1];
            let preceding_has_tool_use = preceding.blocks.iter().any(
                |b| matches!(b, ContentBlock::ToolUse { .. }));
            if preceding_has_tool_use {
                k = k.saturating_sub(1);
                break;
            }
            k = k.saturating_sub(1);
        }
        k
    };
```

这段代码是压缩的边界安全逻辑。`raw_keep_from` 从末尾向前数 `preserve_recent_messages` 条。但如果第一条保留的消息是 `ToolResult`，需要检查前一条消息是否是 `ToolUse`——如果不是，说明工具对被拆分了，需要继续向前调整边界。如果前一条是 `ToolUse`，把 `k` 减 1 包含 assistant 的 tool_use 消息，然后 `break`。这个修复防止 OpenAI 兼容路径出现 orphaned tool message 错误（400 错误）。

生成摘要和构造新会话：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

    let removed = &session.messages[compacted_summary_prefix_len(session)..keep_from];
    let preserved = session.messages[keep_from..].to_vec();
    let summary = merge_compact_summaries(existing_summary.as_deref(), &summarize_messages(removed));
    let formatted_summary = format_compact_summary(&summary);
    let continuation = get_compact_continuation_message(&summary, true, !preserved.is_empty());

    let mut compacted_messages = vec![ConversationMessage {
        role: MessageRole::System,
        blocks: vec![ContentBlock::Text { text: continuation }],
        usage: None,
    }];
    compacted_messages.extend(preserved);

    let mut compacted_session = session.clone();
    compacted_session.messages = compacted_messages;
    compacted_session.record_compaction(summary.clone(), removed.len());
```

`removed` 是要压缩的历史消息。`summarize_messages` 生成文本摘要。`merge_compact_summaries` 合并旧摘要和新摘要——避免嵌套层次随压缩次数指数增长。`get_compact_continuation_message` 生成系统提示文本，包含摘要和 "继续对话" 的指令。新会话的第一条消息是 `System` 角色的摘要文本，后面接保留的消息。

### 摘要格式

`summarize_messages` 生成结构化的摘要文本：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

fn summarize_messages(messages: &[ConversationMessage]) -> String {
    let user_messages = messages.iter().filter(|m| m.role == MessageRole::User).count();
    let assistant_messages = messages.iter().filter(|m| m.role == MessageRole::Assistant).count();
    let tool_messages = messages.iter().filter(|m| m.role == MessageRole::Tool).count();

    let mut tool_names = messages.iter().flat_map(|m| m.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::ToolUse { name, .. } => Some(name.as_str()),
            ContentBlock::ToolResult { tool_name, .. } => Some(tool_name.as_str()),
            _ => None,
        }).collect::<Vec<_>>();
    tool_names.sort_unstable();
    tool_names.dedup();

    let mut lines = vec![
        "<summary>".to_string(),
        "Conversation summary:".to_string(),
        format!("- Scope: {} earlier messages compacted (user={}, assistant={}, tool={}).",
            messages.len(), user_messages, assistant_messages, tool_messages),
    ];
    if !tool_names.is_empty() {
        lines.push(format!("- Tools mentioned: {}.", tool_names.join(", ")));
    }
    // ... recent user requests, pending work, key files, timeline
    lines.push("</summary>".to_string());
    lines.join("\n")
}
```

摘要包含统计信息（消息数、工具使用）、最近用户请求、待完成工作、关键文件引用、时间线。`<summary>` 标签包裹内容，便于后续提取。

`merge_compact_summaries` 合并多次压缩的摘要：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

fn merge_compact_summaries(existing_summary: Option<&str>, new_summary: &str) -> String {
    let Some(existing_summary) = existing_summary else { return new_summary.to_string(); };

    let previous_highlights = extract_summary_highlights(existing_summary);
    let new_formatted_summary = format_compact_summary(new_summary);
    let new_highlights = extract_summary_highlights(&new_formatted_summary);
    let new_timeline = extract_summary_timeline(&new_formatted_summary);

    let mut lines = vec!["<summary>".to_string(), "Conversation summary:".to_string()];
    if !previous_highlights.is_empty() {
        lines.extend(previous_highlights.into_iter().map(|line| format!("- {line}")));
    }
    if !new_highlights.is_empty() {
        lines.push("- Newly compacted context:".to_string());
        lines.extend(new_highlights.into_iter().map(|line| format!("  {line}")));
    }
    if !new_timeline.is_empty() {
        lines.push("- Key timeline:".to_string());
        lines.extend(new_timeline.into_iter().map(|line| format!("  {line}")));
    }
    lines.push("</summary>".to_string());
    lines.join("\n")
}
```

关键设计：旧摘要的要点被扁平化直接列出，不重新嵌套在 "- Previously compacted context:" 下。注释说明这是为了避免嵌套层次随压缩次数指数增长。如果每次压缩都把旧摘要作为子项，第 n 次压缩的深度是 O(n)，token 开销也是 O(n²)。扁平化后每次压缩的摘要大小只与单次内容相关，与历史无关。

## 10.6 会话分叉：Fork

`fork` 方法创建会话副本：

```rust
// claw-code/rust/crates/runtime/src/session.rs

    pub fn fork(&self, branch_name: Option<String>) -> Self {
        let now = current_time_millis();
        Self {
            version: self.version,
            session_id: generate_session_id(),
            created_at_ms: now, updated_at_ms: now,
            messages: self.messages.clone(),
            compaction: self.compaction.clone(),
            fork: Some(SessionFork {
                parent_session_id: self.session_id.clone(),
                branch_name: normalize_optional_string(branch_name),
            }),
            workspace_root: self.workspace_root.clone(),
            prompt_history: self.prompt_history.clone(),
            last_health_check_ms: self.last_health_check_ms,
            model: self.model.clone(),
            persistence: None,
        }
    }
```

`fork` 生成新 session_id，复制所有消息和元数据，记录 `parent_session_id` 和 `branch_name`。`persistence` 设为 `None`——新分叉会话需要重新绑定存储路径。`SessionStore::fork_session` 处理存储路径分配和持久化：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

    pub fn fork_session(&self, session: &Session, branch_name: Option<String>) -> Result<ForkedManagedSession, SessionControlError> {
        let parent_session_id = session.session_id.clone();
        let forked = session.fork(branch_name).with_workspace_root(self.workspace_root.clone());
        let handle = self.create_handle(&forked.session_id);
        let branch_name = forked.fork.as_ref().and_then(|fork| fork.branch_name.clone());
        let forked = forked.with_persistence_path(handle.path.clone());
        forked.save_to_path(&handle.path)?;
        Ok(ForkedManagedSession { parent_session_id, handle, session: forked, branch_name })
    }
```

分叉会话绑定到当前工作区，生成新路径，保存到磁盘。分叉用于 Lane 工作流（第12章）——每个 Lane 从主会话分叉，独立演进，完成后合并回主分支。

## 小结

会话管理在 Rust 端以 `ContentBlock` 枚举（`session.rs`）表示消息内容的四种类型（Text、Thinking、ToolUse、ToolResult），`ConversationMessage` 包装角色和块列表，`Session` 聚合完整状态（版本、ID、消息、压缩历史、工作区绑定）。持久化采用 JSONL 格式（`session.rs`）——增量追加写入单条消息，完整快照用原子写入（临时文件 + `rename`），日志轮转在 256 KB 时触发。`SessionStore`（`session_control.rs`）用 FNV-1a 工作区指纹实现按目录隔离存储，支持别名引用（`latest`/`last`/`recent`）的跨工作区恢复，加载时验证工作区匹配防止文件操作指向错误目录。

自动压缩（`compact.rs`）在 `should_compact` 检测到可压缩消息超过 `max_estimated_tokens`（默认 10,000）时触发。`compact_session` 保留最近 `preserve_recent_messages`（默认 4），边界安全逻辑确保不拆分 ToolUse/ToolResult 对（防止 OpenAI 兼容路径的 400 错误）。`summarize_messages` 生成结构化摘要，统计消息数和工具使用，`merge_compact_summaries` 扁平化合并旧摘要以避免嵌套层次指数增长。`Session::fork` 创建会话副本，绑定新 ID 和分支名，用于 Lane 工作流的分支管理。

| 关键文件 | 核心机制 | 对应章节 |
| --- | --- | --- |
| `rust/crates/runtime/src/session.rs` | `Session`、`ContentBlock`、JSONL 序列化、增量持久化 | 10.1-10.3 |
| `rust/crates/runtime/src/session_control.rs` | `SessionStore`、工作区指纹、会话恢复、分叉 | 10.4, 10.6 |
| `rust/crates/runtime/src/compact.rs` | `compact_session`、`summarize_messages`、摘要合并 | 10.5 |

下一章将分析Hooks系统——`HookRunner` 如何在工具执行前后插入用户自定义逻辑，PreToolUse 和 PostToolUse 钩子如何修改输入、覆盖权限和追加反馈。
