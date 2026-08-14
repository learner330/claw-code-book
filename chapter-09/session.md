# 第9章 会话管理：Agent 的状态持久化与生命周期

## 本章概览

Agent 与 LLM 的交互不是单次请求-响应，而是多轮对话的累积过程。每一次用户输入、模型回复、工具执行结果都需要被记录，并在下一次请求时完整回传给模型。当对话长度逼近模型的上下文窗口时，还需要对历史消息进行压缩。会话管理就是解决"如何存储、如何恢复、如何压缩"这三个核心问题。

claw-code 的会话管理横跨 Python 原型和 Rust 生产版。Python 端的 `StoredSession` 是一个极简的 frozen dataclass，以单个 JSON 文件存储；Rust 端的 `Session` 则是一个功能完整的状态载体，支持 JSONL 增量持久化、原子写入、日志轮转、工作空间命名空间隔离、自动压缩和心跳检测。

| 层级 | 源文件 | 核心结构 | 职责 |
| --- | --- | --- | --- |
| Python 端 | `src/session_store.py` | `StoredSession` | 简化版会话存储（JSON 文件） |
| Python 端 | `src/history.py` | `HistoryLog` | 内存事件日志 |
| Rust 核心 | `rust/crates/runtime/src/session.rs` | `Session` | 数据模型、JSONL 持久化、原子写、轮转 |
| Rust 控制 | `rust/crates/runtime/src/session_control.rs` | `SessionStore` | 命名空间隔离、别名解析、workspace 校验 |
| Rust 压缩 | `rust/crates/runtime/src/compact.rs` | `CompactionConfig` | 自动压缩、摘要生成、边界安全 |
| Rust 运行时 | `rust/crates/runtime/src/conversation.rs` | `ConversationRuntime` | Turn Loop 中的会话生命周期驱动 |

## 9.1 Python 端：极简会话存储

Python 端的会话概念非常精简，只保留最基本的序列化和反序列化能力。`StoredSession` 是一个 frozen dataclass，四个字段全部不可变：

```python
# claw-code/src/session_store.py

@dataclass(frozen=True)
class StoredSession:
    session_id: str
    messages: tuple[str, ...]
    input_tokens: int
    output_tokens: int
```

`session_id` 是会话的唯一标识，`messages` 是消息字符串的元组（用 tuple 而非 list 保证不可变性），`input_tokens` 和 `output_tokens` 分别记录输入和输出的 token 用量。这里没有 `ContentBlock`、`MessageRole` 等结构化概念——消息以原始字符串存储，角色信息被丢弃。

序列化和反序列化通过两个模块级函数完成：

```python
# claw-code/src/session_store.py

DEFAULT_SESSION_DIR = Path('.port_sessions')

def save_session(session: StoredSession, directory: Path | None = None) -> Path:
    target_dir = directory or DEFAULT_SESSION_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f'{session.session_id}.json'
    path.write_text(json.dumps(asdict(session), indent=2))
    return path

def load_session(session_id: str, directory: Path | None = None) -> StoredSession:
    target_dir = directory or DEFAULT_SESSION_DIR
    data = json.loads((target_dir / f'{session_id}.json').read_text())
    return StoredSession(
        session_id=data['session_id'],
        messages=tuple(data['messages']),
        input_tokens=data['input_tokens'],
        output_tokens=data['output_tokens'],
    )
```

`save_session` 将 `StoredSession` 序列化为 JSON 文件，`load_session` 从文件反序列化。默认目录 `.port_sessions` 是项目本地目录。`asdict(session)` 是 dataclass 的辅助函数，将 dataclass 实例转为字典。加载时 `tuple(data['messages'])` 把 JSON 数组转回 tuple，恢复不可变性。整个实现没有任何并发控制、原子写入或增量追加——这是原型级别的实现，用于验证概念，不用于生产。

Python 端还有一个内存级的事件日志，用于生成可读的会话历史 Markdown：

```python
# claw-code/src/history.py

@dataclass(frozen=True)
class HistoryEvent:
    title: str
    detail: str

@dataclass
class HistoryLog:
    events: list[HistoryEvent] = field(default_factory=list)

    def add(self, title: str, detail: str) -> None:
        self.events.append(HistoryEvent(title=title, detail=detail))

    def as_markdown(self) -> str:
        lines = ['# Session History', '']
        lines.extend(f'- {event.title}: {event.detail}' for event in self.events)
        return '\n'.join(lines)
```

`HistoryEvent` 是 frozen dataclass，记录事件的标题和详情。`HistoryLog` 不是 frozen 的——`events` 使用 `field(default_factory=list)` 创建可变默认值，允许动态追加事件。`as_markdown` 将事件列表渲染为 Markdown 无序列表。这个日志纯内存，不持久化，进程退出即丢失。

## 9.2 Rust 端：Session 数据模型

Rust 侧的 `Session` 结构是会话的核心载体，功能远比 Python 端完整。先看模块级别的常量和全局状态：

```rust
// claw-code/rust/crates/runtime/src/session.rs

const SESSION_VERSION: u32 = 1;
const ROTATE_AFTER_BYTES: u64 = 256 * 1024;
const MAX_ROTATED_FILES: usize = 3;
const MAX_JSONL_FIELD_CHARS: usize = 16 * 1024;
const JSONL_TRUNCATION_MARKER: &str = "… [truncated for session JSONL]";
const JSONL_REDACTION_MARKER: &str = "[redacted]";
static SESSION_ID_COUNTER: AtomicU64 = AtomicU64::new(0);
static LAST_TIMESTAMP_MS: AtomicU64 = AtomicU64::new(0);
```

`SESSION_VERSION` 当前固定为 1，用于未来格式迁移时的版本检测。`ROTATE_AFTER_BYTES` 设为 256KB，当会话文件超过此大小时触发日志轮转。`MAX_ROTATED_FILES` 限制轮转文件最多保留 3 个。`MAX_JSONL_FIELD_CHARS` 设为 16KB，单个 JSONL 字段超过此长度会被截断并附加 `JSONL_TRUNCATION_MARKER`。`SESSION_ID_COUNTER` 和 `LAST_TIMESTAMP_MS` 是全局原子计数器，用于生成唯一的会话 ID 和保证时间戳单调递增。

`Session` 结构本身：

```rust
// claw-code/rust/crates/runtime/src/session.rs

#[derive(Debug, Clone)]
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

逐字段分析：`version` 是格式版本号，用于未来迁移时的兼容检测。`session_id` 由时间戳和原子计数器生成，格式为 `session-{millis}-{counter}`，保证进程内唯一。`created_at_ms` 和 `updated_at_ms` 记录创建和最后修改时间。`messages` 是按顺序存储的完整对话历史。`compaction` 记录最近一次压缩的摘要信息，`Option` 表示可能尚未压缩过。`fork` 记录 fork 来源信息，`Option` 表示可能是原始会话而非 fork。`workspace_root` 将会话绑定到创建时的工作目录，防止多个并行实例写错位置——文档注释中明确提到了"phantom completions root cause"，即没有 workspace 绑定时，并行的 `opencode serve` 实例会互相覆盖导致幻象完成。`prompt_history` 记录用户输入历史（类似 shell history）。`last_health_check_ms` 记录最近一次健康检查时间戳。`model` 记录会话使用的模型名称，持久化后恢复时能报告原始模型。`persistence` 是私有字段，持有磁盘文件路径，控制是否启用增量持久化。

注意 `Session` 手动实现了 `PartialEq`，排除了 `persistence` 字段的比较：

```rust
// claw-code/rust/crates/runtime/src/session.rs

impl PartialEq for Session {
    fn eq(&self, other: &Self) -> bool {
        self.version == other.version
            && self.session_id == other.session_id
            && self.created_at_ms == other.created_at_ms
            && self.updated_at_ms == other.updated_at_ms
            && self.messages == other.messages
            && self.compaction == other.compaction
            && self.fork == other.fork
            && self.workspace_root == other.workspace_root
            && self.prompt_history == other.prompt_history
            && self.last_health_check_ms == other.last_health_check_ms
    }
}

impl Eq for Session {}
```

两个 `Session` 的相等性只看数据内容，不看持久化路径。这意味着同一个会话从不同路径加载后比较仍然相等。

`SessionPersistence` 是一个简单的内部结构：

```rust
// claw-code/rust/crates/runtime/src/session.rs

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionPersistence {
    path: PathBuf,
}
```

它只持有一个文件路径。`Session::with_persistence_path` 是 Builder 方法，设置持久化路径后返回 `Self`，支持链式调用：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub fn with_persistence_path(mut self, path: impl Into<PathBuf>) -> Self {
    self.persistence = Some(SessionPersistence { path: path.into() });
    self
}
```

`impl Into<PathBuf>` 参数类型接受 `&str`、`String`、`PathBuf` 等多种类型，因为它们都实现了 `Into<PathBuf>`。这是 Rust 的惯用模式——用 trait 约束代替方法重载，一个方法接受多种输入类型。

## 9.3 消息与内容块

对话消息由 `ConversationMessage` 表达：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub struct ConversationMessage {
    pub role: MessageRole,
    pub blocks: Vec<ContentBlock>,
    pub usage: Option<TokenUsage>,
}
```

`role` 标识消息发出者，`blocks` 是消息内容的有序列表（一条消息可以包含多个内容块，如模型回复中同时有思考过程和工具调用），`usage` 记录该消息消耗的 token 统计（仅 assistant 消息有值）。

`MessageRole` 枚举四种角色：

```rust
// claw-code/rust/crates/runtime/src/session.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}
```

`System` 是系统消息（如压缩后的摘要合成消息），`User` 是用户输入，`Assistant` 是模型回复，`Tool` 是工具执行结果。`Clone, Copy` trait 表示这个枚举可以低成本按值复制（它只是一个整数标签）。

`ContentBlock` 枚举了消息可包含的四种内容类型：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub enum ContentBlock {
    Text { text: String },
    Thinking { thinking: String, signature: Option<String> },
    ToolUse { id: String, name: String, input: String },
    ToolResult { tool_use_id: String, tool_name: String, output: String, is_error: bool },
}
```

`Text` 是普通文本内容。`Thinking` 是链式思维（Chain-of-Thought）的思考块，`signature` 字段存储模型提供思考签名，用于验证思考过程的完整性——某些模型（如 Claude 3.5）会返回加密签名的思考内容，签名用于防止篡改。`ToolUse` 是模型发出的工具调用请求，`id` 是调用标识（用于与 `ToolResult` 配对），`name` 是工具名，`input` 是工具输入参数的 JSON 字符串。`ToolResult` 是工具执行结果，`tool_use_id` 与 `ToolUse` 的 `id` 匹配，`is_error` 标记执行是否失败。

`ToolUse` 和 `ToolResult` 成对出现的约束不在类型系统中强制（Rust 的类型系统无法表达"这个 ToolResult 必须有一个对应的 ToolUse"），而是在运行时通过 Turn Loop 的逻辑保证。

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

    pub fn assistant_with_usage(blocks: Vec<ContentBlock>, usage: Option<TokenUsage>) -> Self {
        Self { role: MessageRole::Assistant, blocks, usage }
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

`user_text` 创建只含一个 `Text` 块的用户消息。`assistant` 和 `assistant_with_usage` 创建 assistant 消息，后者额外携带 token 统计。`tool_result` 创建只含一个 `ToolResult` 块的工具消息。所有方法都用 `impl Into<String>` 参数，接受 `&str` 或 `String`。

## 9.4 会话 ID 生成与时间戳

会话 ID 的生成需要保证进程内唯一且时间戳单调递增：

```rust
// claw-code/rust/crates/runtime/src/session.rs

fn generate_session_id() -> String {
    let millis = current_time_millis();
    let counter = SESSION_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("session-{millis}-{counter}")
}
```

`generate_session_id` 用 `current_time_millis()` 获取当前时间戳，用 `SESSION_ID_COUNTER.fetch_add(1, Ordering::Relaxed)` 获取递增计数器，拼成 `session-{millis}-{counter}` 格式。`fetch_add` 是原子操作，返回当前值并加 1，`Ordering::Relaxed` 表示不要求与其他内存操作有特定的顺序关系——这里只需要计数器本身的原子性，不需要与其他变量同步。

`current_time_millis` 的实现比想象中复杂，因为它需要保证时间戳单调递增：

```rust
// claw-code/rust/crates/runtime/src/session.rs

fn current_time_millis() -> u64 {
    let wall_clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default();

    let mut candidate = wall_clock;
    loop {
        let previous = LAST_TIMESTAMP_MS.load(Ordering::Relaxed);
        if candidate <= previous {
            candidate = previous.saturating_add(1);
        }
        match LAST_TIMESTAMP_MS.compare_exchange(
            previous,
            candidate,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => return candidate,
            Err(actual) => candidate = actual.saturating_add(1),
        }
    }
}
```

这段代码的核心逻辑是：获取系统时钟后，与全局记录的上一个时间戳比较。如果系统时钟没有前进（可能因为时钟回拨或精度不够），就取上一个时间戳加 1。然后通过 `compare_exchange`（CAS 操作）尝试更新全局时间戳：如果全局值仍然是 `previous`（没有被其他线程修改），就更新为 `candidate` 并返回；否则说明其他线程已经更新了全局值，取实际值加 1 重试。

`compare_exchange` 是 Rust 原子类型的 CAS（Compare-And-Swap）操作，接收四个参数：期望值、新值、成功时的内存序、失败时的内存序。`Ordering::SeqCst` 是最强的内存序，保证所有线程看到一致的操作顺序。

## 9.5 JSONL 增量持久化

Rust 侧采用 JSON Lines（JSONL）格式进行增量持久化。每条消息或元数据占一行 JSON，追加写入文件尾部，避免每次保存都重写整个会话文件。

`push_message` 是写入消息的入口方法：

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

这段代码实现了"先内存后磁盘，失败回滚"的策略。第 2 行调用 `touch()` 更新 `updated_at_ms`。第 3 行先推入内存。第 4-8 行获取刚推入消息的引用，调用 `append_persisted_message` 写入磁盘。第 9-12 行如果持久化失败，从内存中 `pop()` 回滚——保证内存和磁盘的一致性。

`push_user_text` 是 `push_message` 的快捷方法：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub fn push_user_text(&mut self, text: impl Into<String>) -> Result<(), SessionError> {
    self.push_message(ConversationMessage::user_text(text))
}
```

`append_persisted_message` 实现增量追加逻辑：

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

这段代码的持久化策略分两种情况。第 3-4 行检查是否配置了持久化路径，没有配置则直接返回 `Ok(())`——这意味着没有持久化路径的 `Session` 是纯内存的。第 6-9 行检查文件是否存在或是否为空，如果是则调用 `save_to_path` 写入完整快照（首次写入需要建立文件头）。第 11-12 行以追加模式打开文件，写入一行 JSONL。

`save_to_path` 负责完整快照写入，包含轮转检查和原子写：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub fn save_to_path(&self, path: impl AsRef<Path>) -> Result<(), SessionError> {
    let path = path.as_ref();
    let snapshot = self.render_jsonl_snapshot()?;
    match rotate_session_file_if_needed(path) {
        Ok(()) => {}
        Err(SessionError::Io(ref io_err)) if io_err.kind() == std::io::ErrorKind::NotFound => {
            return Err(SessionError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("session file was removed during save (possible concurrent modification): {io_err}"),
            )));
        }
        Err(e) => return Err(e),
    }
    write_atomic(path, &snapshot).map_err(|e| {
        match &e {
            SessionError::Io(io_err) if io_err.kind() == std::io::ErrorKind::NotFound => {
                SessionError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("session file was removed during write (possible concurrent modification): {io_err}"),
                ))
            }
            _ => e,
        }
    })?;
    cleanup_rotated_logs(path)?;
    Ok(())
}
```

这段代码的执行顺序：先生成快照字符串，然后检查是否需要轮转，然后原子写入，最后清理过多的轮转文件。特别值得注意的是对 `NotFound` 错误的特殊处理——如果在保存过程中文件被其他进程删除，会返回一个带有"possible concurrent modification"提示的错误。这是 ROADMAP #112 的修复，防止并发修改导致的静默失败。

`render_jsonl_snapshot` 按固定顺序渲染完整快照：

```rust
// claw-code/rust/crates/runtime/src/session.rs

fn render_jsonl_snapshot(&self) -> Result<String, SessionError> {
    let mut lines = vec![self.meta_record()?.render()];
    if let Some(compaction) = &self.compaction {
        lines.push(compaction.to_jsonl_record()?.render());
    }
    lines.extend(
        self.prompt_history
            .iter()
            .map(|entry| entry.to_jsonl_record().render()),
    );
    lines.extend(
        self.messages
            .iter()
            .map(|message| message_record(message).render()),
    );
    let mut rendered = lines.join("\n");
    rendered.push('\n');
    Ok(rendered)
}
```

快照的行顺序是：元数据记录（`session_meta`）→ 压缩记录（`compaction`）→ 提示历史（`prompt_history`）→ 消息列表（`message`）。每行是一个完整的 JSON 对象，行与行之间用 `\n` 分隔。`meta_record` 生成的 JSONL 首行包含 `type: "session_meta"` 标记、版本号、会话 ID、时间戳等元数据。

## 9.6 原子写入与日志轮转

`write_atomic` 实现了先写临时文件再 rename 的原子写入策略：

```rust
// claw-code/rust/crates/runtime/src/session.rs

fn write_atomic(path: &Path, contents: &str) -> Result<(), SessionError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp_path = temporary_path_for(path);
    fs::write(&temp_path, contents)?;
    fs::rename(temp_path, path)?;
    Ok(())
}
```

这段代码的原子性保证依赖于操作系统的 `rename` 系统调用：在 POSIX 系统上，`rename` 是原子的——要么目标文件被完整替换，要么保持不变。写入过程分三步：第 2-3 行确保父目录存在，第 4 行写入临时文件，第 5 行原子替换目标文件。如果进程在第 4 步和第 5 步之间崩溃，临时文件会残留但目标文件保持完整。

临时文件的命名也考虑了并发安全：

```rust
// claw-code/rust/crates/runtime/src/session.rs

fn temporary_path_for(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("session");
    path.with_file_name(format!(
        "{file_name}.tmp-{}-{}",
        current_time_millis(),
        SESSION_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
```

临时文件名格式为 `{original}.tmp-{millis}-{counter}`，用时间戳和原子计数器保证多个进程同时写入时不会互相覆盖临时文件。

日志轮转在文件超过 256KB 时触发：

```rust
// claw-code/rust/crates/runtime/src/session.rs

fn rotate_session_file_if_needed(path: &Path) -> Result<(), SessionError> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() < ROTATE_AFTER_BYTES {
        return Ok(());
    }
    let rotated_path = rotated_log_path(path);
    fs::rename(path, rotated_path)?;
    Ok(())
}

fn rotated_log_path(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("session");
    path.with_file_name(format!("{stem}.rot-{}.jsonl", current_time_millis()))
}
```

轮转操作将当前文件重命名为 `stem.rot-{timestamp}.jsonl`，然后后续写入会创建新文件。轮转后的旧日志最多保留 3 个：

```rust
// claw-code/rust/crates/runtime/src/session.rs

fn cleanup_rotated_logs(path: &Path) -> Result<(), SessionError> {
    let Some(parent) = path.parent() else { return Ok(()); };
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("session");
    let prefix = format!("{stem}.rot-");
    let mut rotated_paths = fs::read_dir(parent)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|entry_path| {
            entry_path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with(&prefix))
        })
        .collect::<Vec<_>>();
    rotated_paths.sort_unstable_by_key(|p| {
        fs::metadata(p).and_then(|m| m.modified()).ok()
    });
    while rotated_paths.len() > MAX_ROTATED_FILES {
        let excess = rotated_paths.remove(0);
        let _ = fs::remove_file(&excess);
    }
    Ok(())
}
```

这段代码扫描父目录中所有以 `stem.rot-` 开头的文件，按修改时间排序，删除最旧的文件直到数量不超过 `MAX_ROTATED_FILES`（3 个）。`sort_unstable_by_key` 按 `modified` 时间排序，最旧的在前面被优先删除。

## 9.7 双格式加载

加载会话时，`load_from_path` 支持两种格式的自动识别：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub fn load_from_path(path: impl AsRef<Path>) -> Result<Self, SessionError> {
    let path = path.as_ref();
    let contents = fs::read_to_string(path)?;
    let session = match JsonValue::parse(&contents) {
        Ok(value)
            if value.as_object()
                .is_some_and(|object| object.contains_key("messages")) =>
        {
            Self::from_json(&value)?
        }
        Err(_) | Ok(_) => Self::from_jsonl(&contents)?,
    };
    Ok(session.with_persistence_path(path.to_path_buf()))
}
```

这段代码尝试将文件内容解析为 JSON：如果成功且顶层对象包含 `messages` 键，走 `from_json` 全量解析路径（旧格式，整个会话是一个 JSON 对象）；否则走 `from_jsonl` 逐行解析路径（新格式，JSONL 增量追加）。加载完成后通过 `with_persistence_path` 设置持久化路径，后续修改会增量追加到同一文件。

`from_jsonl` 逐行解析 JSONL，通过 `type` 字段分发到四种记录类型：

```rust
// claw-code/rust/crates/runtime/src/session.rs

fn from_jsonl(contents: &str) -> Result<Self, SessionError> {
    let mut version = SESSION_VERSION;
    let mut session_id = None;
    let mut messages = Vec::new();
    let mut compaction = None;
    // ... 其他字段

    for (line_number, raw_line) in contents.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() { continue; }

        let value = JsonValue::parse(line).map_err(|error| {
            SessionError::Format(format!("invalid JSONL record at line {}: {}", line_number + 1, error))
        })?;
        let object = value.as_object().ok_or_else(|| {
            SessionError::Format(format!("JSONL record at line {} must be an object", line_number + 1))
        })?;

        match object.get("type").and_then(JsonValue::as_str).ok_or_else(|| {
            SessionError::Format(format!("JSONL record at line {} missing type", line_number + 1))
        })? {
            "session_meta" => {
                version = required_u32(object, "version")?;
                session_id = Some(required_string(object, "session_id")?);
                // ... 解析其他元数据
            }
            "message" => {
                let message_value = object.get("message").ok_or_else(|| {
                    SessionError::Format(format!("JSONL record at line {} missing message", line_number + 1))
                })?;
                messages.push(ConversationMessage::from_json(message_value)?);
            }
            "compaction" => {
                compaction = Some(SessionCompaction::from_json(&JsonValue::Object(object.clone()))?);
            }
            "prompt_history" => {
                if let Some(entry) = SessionPromptEntry::from_json_opt(&JsonValue::Object(object.clone())) {
                    prompt_history.push(entry);
                }
            }
            other => {
                return Err(SessionError::Format(format!(
                    "unsupported JSONL record type at line {}: {other}", line_number + 1
                )))
            }
        }
    }
    // ...
}
```

这段代码逐行遍历文件内容，每行解析为一个 JSON 对象，通过 `type` 字段的值分发到四种处理分支。`session_meta` 记录包含会话元数据，`message` 记录包含对话消息，`compaction` 记录包含压缩信息，`prompt_history` 记录包含用户输入历史。每行都有行号错误报告，帮助调试格式问题。

## 9.8 会话压缩机制

随着对话轮次增加，消息历史会逼近甚至超出 LLM 的上下文窗口。`compact.rs` 实现了自动压缩机制：保留最近若干条消息的原文，将更早的消息替换为一段摘要，并以 `System` 角色的合成消息插入到消息队列头部。

压缩配置：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

`preserve_recent_messages` 默认为 4，表示保留最近 4 条消息的原文不压缩。`max_estimated_tokens` 默认为 10,000，表示可压缩部分的估算 token 数达到此值时触发压缩。`Clone, Copy` trait 让这个配置可以低成本按值传递。

压缩触发条件的判断：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

pub fn should_compact(session: &Session, config: CompactionConfig) -> bool {
    let start = compacted_summary_prefix_len(session);
    let compactable = &session.messages[start..];

    compactable.len() > config.preserve_recent_messages
        && compactable
            .iter()
            .map(estimate_message_tokens)
            .sum::<usize>()
            >= config.max_estimated_tokens
}
```

这段代码的逻辑：先用 `compacted_summary_prefix_len` 检查消息列表开头是否有已压缩的摘要消息（如果有，跳过它）。然后取可压缩部分（从摘要后到末尾），判断两个条件是否同时满足：可压缩部分长度大于 `preserve_recent_messages`（确保有东西可以压缩），且可压缩部分的估算 token 总数达到阈值。

`estimate_message_tokens` 使用简单的字符数除以 4 来估算 token 数：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

fn estimate_message_tokens(message: &ConversationMessage) -> usize {
    message
        .blocks
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text.len() / 4 + 1,
            ContentBlock::ToolUse { name, input, .. } => (name.len() + input.len()) / 4 + 1,
            ContentBlock::ToolResult { tool_name, output, .. } => (tool_name.len() + output.len()) / 4 + 1,
            ContentBlock::Thinking { thinking, .. } => thinking.len() / 4 + 1,
        })
        .sum()
}
```

这个估算基于经验法则：英文文本中 1 个 token 大约等于 4 个字符。对每种 `ContentBlock` 变体，取相关字符串字段的总长度除以 4 再加 1（加 1 防止空字符串返回 0）。这是一个粗略估计——实际 token 数取决于模型分词器，但这个估算足以判断何时需要压缩。

## 9.9 压缩执行与边界安全

`compact_session` 是压缩的核心执行函数：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

pub fn compact_session(session: &Session, config: CompactionConfig) -> CompactionResult {
    if !should_compact(session, config) {
        return CompactionResult {
            summary: String::new(),
            formatted_summary: String::new(),
            compacted_session: session.clone(),
            removed_message_count: 0,
        };
    }

    let existing_summary = session
        .messages
        .first()
        .and_then(extract_existing_compacted_summary);
    let compacted_prefix_len = usize::from(existing_summary.is_some());
    let raw_keep_from = if config.preserve_recent_messages == 0 {
        session.messages.len()
    } else {
        session.messages
            .len()
            .saturating_sub(config.preserve_recent_messages)
    };
```

这段代码的前半部分处理两个边界情况。第 2-5 行如果不需要压缩，直接返回原会话的克隆。第 7-10 行检查是否已有压缩摘要（支持多次压缩——如果已经压缩过一次，新的压缩会在已有摘要基础上合并）。第 11-14 行计算保留区间的起始位置 `raw_keep_from`：`preserve_recent_messages` 为 0 时表示最大压缩（不保留任何近期消息），否则用 `saturating_sub`（饱和减法，不会下溢）从消息总数中减去保留数量。

接下来是关键的边界安全处理：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

    let keep_from = {
        let mut k = raw_keep_from;
        loop {
            if k == 0 || k <= compacted_prefix_len || k >= session.messages.len() {
                break;
            }
            let first_preserved = &session.messages[k];
            let starts_with_tool_result = first_preserved
                .blocks
                .first()
                .is_some_and(|b| matches!(b, ContentBlock::ToolResult { .. }));
            if !starts_with_tool_result {
                break;
            }
            // Check the message just before the current boundary.
            let preceding = &session.messages[k - 1];
            let preceding_has_tool_use = preceding
                .blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { .. }));
            if preceding_has_tool_use {
                // Pair is intact — walk back one more to include the assistant turn.
                k = k.saturating_sub(1);
                break;
            }
            // Preceding message has no ToolUse but we have a ToolResult —
            // this is already an orphaned pair; walk back to try to fix it.
            k = k.saturating_sub(1);
        }
        k
    };
```

这段代码解决的问题是：如果保留区间的第一条消息是 `ToolResult`（tool 角色消息），但与之配对的 `ToolUse`（assistant 消息中的工具调用块）在被压缩的区间中，会导致 OpenAI 兼容 API 路径返回 400 错误——因为 provider 要求 `tool` 角色消息前面必须有包含 `tool_calls` 的 `assistant` 消息。

循环逻辑：检查保留区间第一条消息是否以 `ToolResult` 开头。如果不是，边界安全，退出循环。如果是，检查前一条消息是否包含 `ToolUse`：如果包含，说明配对完整，向前回溯一步把 assistant 消息也保留，退出循环；如果不包含（已经是孤儿），继续向前回溯尝试修复。

压缩后的消息列表构建：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

    let removed = &session.messages[compacted_prefix_len..keep_from];
    let preserved = session.messages[keep_from..].to_vec();
    let summary =
        merge_compact_summaries(existing_summary.as_deref(), &summarize_messages(removed));
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

    CompactionResult {
        summary,
        formatted_summary,
        compacted_session,
        removed_message_count: removed.len(),
    }
}
```

这段代码的执行步骤：第 1-2 行切分消息列表为被压缩部分和保留部分。第 3 行调用 `summarize_messages` 生成摘要，如果已有摘要则通过 `merge_compact_summaries` 合并。第 4 行格式化摘要。第 5 行用 `get_compact_continuation_message` 构建合成 system 消息文本。第 7-10 行创建新消息列表：头部是合成 system 消息，尾部是保留的近期消息。第 12-14 行克隆原会话，替换消息列表，记录压缩元数据。

`get_compact_continuation_message` 生成的合成消息包含一段预设的前导文本：

```rust
// claw-code/rust/crates/runtime/src/compact.rs

const COMPACT_CONTINUATION_PREAMBLE: &str =
    "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n";
const COMPACT_RECENT_MESSAGES_NOTE: &str = "Recent messages are preserved verbatim.";
const COMPACT_DIRECT_RESUME_INSTRUCTION: &str = "Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, and do not preface with continuation text.";

pub fn get_compact_continuation_message(
    summary: &str,
    suppress_follow_up_questions: bool,
    recent_messages_preserved: bool,
) -> String {
    let mut base = format!(
        "{COMPACT_CONTINUATION_PREAMBLE}{}",
        format_compact_summary(summary)
    );

    if recent_messages_preserved {
        base.push_str("\n\n");
        base.push_str(COMPACT_RECENT_MESSAGES_NOTE);
    }

    if suppress_follow_up_questions {
        base.push('\n');
        base.push_str(COMPACT_DIRECT_RESUME_INSTRUCTION);
    }

    base
}
```

这段代码构建合成消息的完整文本。`COMPACT_CONTINUATION_PREAMBLE` 告诉模型"这是从之前对话继续的"。`COMPACT_RECENT_MESSAGES_NOTE` 告诉模型"近期消息保留了原文"。`COMPACT_DIRECT_RESUME_INSTRUCTION` 指示模型直接继续对话，不要确认摘要或回顾之前的内容——这防止模型在压缩后生成多余的过渡性回复。

## 9.10 会话存储与命名空间隔离

`SessionStore` 负责管理磁盘上的会话文件，按工作空间隔离命名空间，防止多个项目并行运行时的会话碰撞：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionStore {
    sessions_root: PathBuf,
    workspace_root: PathBuf,
}
```

`sessions_root` 是会话文件的根目录，格式为 `<data_dir>/sessions/<workspace_hash>/`。`workspace_root` 是该 store 绑定的工作空间路径。两种构造方式：`from_cwd` 从当前工作目录推导，`from_data_dir` 接受显式的 `--data-dir` 参数。

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
        Ok(Self {
            sessions_root,
            workspace_root: canonical_cwd,
        })
    }

    pub fn from_data_dir(
        data_dir: impl AsRef<Path>,
        workspace_root: impl AsRef<Path>,
    ) -> Result<Self, SessionControlError> {
        let canonical_workspace =
            fs::canonicalize(workspace_root).unwrap_or_else(|_| workspace_root.to_path_buf());
        let sessions_root = data_dir
            .as_ref()
            .join("sessions")
            .join(workspace_fingerprint(&canonical_workspace));
        Ok(Self {
            sessions_root,
            workspace_root: canonical_workspace,
        })
    }
}
```

两种构造方式都先调用 `fs::canonicalize` 规范化路径——这解决了符号链接、相对路径、macOS 的 `/tmp` vs `/private/tmp` 等路径等价问题。然后调用 `workspace_fingerprint` 生成哈希，拼成会话目录路径。`from_cwd` 使用项目本地目录 `.claw/sessions/`，`from_data_dir` 使用全局目录 `--data-dir/sessions/`。

工作空间指纹通过 FNV-1a 64 位哈希生成：

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

FNV-1a 是一个非加密哈希函数，特点是速度快、分布均匀、实现简单。算法：初始值为一个魔法常量，对每个字节先 XOR 到哈希值，再乘以另一个魔法常量。`wrapping_mul` 是环绕乘法，不会在溢出时 panic，而是截断到 u64 范围。最终格式化为 16 位十六进制字符串。

会话引用支持别名解析：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

pub const PRIMARY_SESSION_EXTENSION: &str = "jsonl";
pub const LEGACY_SESSION_EXTENSION: &str = "json";
pub const LATEST_SESSION_REFERENCE: &str = "latest";

const SESSION_REFERENCE_ALIASES: &[&str] = &[LATEST_SESSION_REFERENCE, "last", "recent"];
```

`latest`、`last`、`recent` 三个别名都会被解析为当前命名空间下消息数非零的最新会话。`PRIMARY_SESSION_EXTENSION` 是 `jsonl`（新格式），`LEGACY_SESSION_EXTENSION` 是 `json`（旧格式），加载时两种扩展名都会尝试。

别名解析的实现：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

pub fn is_session_reference_alias(reference: &str) -> bool {
    SESSION_REFERENCE_ALIASES
        .iter()
        .any(|alias| reference.eq_ignore_ascii_case(alias))
}
```

`eq_ignore_ascii_case` 做大小写不敏感比较，因此 `Latest`、`LATEST` 等写法都能匹配。

`latest_session_excluding` 的查找逻辑分两级：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

pub fn latest_session_excluding(
    &self,
    exclude_id: Option<&str>,
) -> Result<ManagedSessionSummary, SessionControlError> {
    let exclude = exclude_id.unwrap_or("");
    // First: look in the current workspace's session namespace
    if let Some(latest) = self
        .list_sessions()?
        .into_iter()
        .find(|s| s.id != exclude && s.message_count > 0)
    {
        return Ok(latest);
    }
    // Fallback: scan all workspace namespaces
    if let Some(latest) = self
        .scan_global_sessions()?
        .into_iter()
        .find(|s| s.id != exclude && s.message_count > 0)
    {
        return Ok(latest);
    }
    // Distinguish between "no sessions at all" and "sessions exist but all are empty"
    let has_any_session = self.list_sessions()?.iter().any(|s| s.id != exclude)
        || self.scan_global_sessions()?.iter().any(|s| s.id != exclude);
    if has_any_session {
        return Err(SessionControlError::Format(format_all_sessions_empty(
            &self.sessions_root,
        )));
    }
    Err(SessionControlError::Format(format_no_managed_sessions(
        &self.sessions_root,
    )))
}
```

这段代码的查找策略：先在当前工作空间命名空间查找，找不到则扫描全局所有工作空间命名空间。`exclude_id` 参数用于 `/resume latest` 命令——用户在当前会话中执行 resume latest 时，需要排除当前会话本身，否则返回的始终是当前空会话。最后区分两种错误情况：会话存在但都是空的（提示"all sessions have 0 messages"）和完全没有会话（提示"no managed sessions found"），给用户明确的反馈。

加载会话时的 workspace 校验：

```rust
// claw-code/rust/crates/runtime/src/session_control.rs

fn validate_loaded_session(
    &self,
    session_path: &Path,
    session: &Session,
) -> Result<(), SessionControlError> {
    let Some(actual) = session.workspace_root() else {
        if path_is_within_workspace(session_path, &self.workspace_root) {
            return Ok(());
        }
        return Err(SessionControlError::Format(
            format_legacy_session_missing_workspace_root(session_path, &self.workspace_root),
        ));
    };
    if workspace_roots_match(actual, &self.workspace_root) {
        return Ok(());
    }
    Err(SessionControlError::WorkspaceMismatch {
        expected: self.workspace_root.clone(),
        actual: actual.to_path_buf(),
    })
}
```

这段代码实现了三级校验策略：如果会话没有 `workspace_root`（旧版会话），检查会话文件路径是否在当前工作空间目录内；如果有 `workspace_root`，检查是否与当前工作空间匹配；都不满足则返回 `WorkspaceMismatch` 错误。这防止了误加载其他项目的会话——在多项目并行开发时尤为重要。

## 9.11 会话 Fork 与心跳

`Session::fork` 创建一个会话的分叉副本：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub fn fork(&self, branch_name: Option<String>) -> Self {
    let now = current_time_millis();
    Self {
        version: self.version,
        session_id: generate_session_id(),
        created_at_ms: now,
        updated_at_ms: now,
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

`fork` 复制父会话的全部数据（消息、压缩信息、提示历史等），但生成新的 `session_id` 和时间戳，并设置 `fork` 字段记录父会话 ID 和可选的分支名。`persistence: None` 意味着 fork 出的会话不会自动持久化——需要调用方显式设置持久化路径。

`SessionFork` 的结构：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub struct SessionFork {
    pub parent_session_id: String,
    pub branch_name: Option<String>,
}
```

`parent_session_id` 指向父会话，`branch_name` 是可选的分支标签。这使得会话可以形成树形结构，类似于 Git 的分支模型。

会话心跳机制用于健康检测：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub enum SessionLiveness {
    Healthy,
    Stalled,
    TransportDead,
    Unknown,
}

pub struct SessionHeartbeat {
    pub session_id: String,
    pub observed_at_ms: u64,
    pub transport_alive: bool,
    pub liveness: SessionLiveness,
}
```

`SessionLiveness` 的四个状态：`Healthy` 表示连接正常且健康检查在时效内，`Stalled` 表示连接仍在但健康检查超时，`TransportDead` 表示连接已断开，`Unknown` 表示尚无健康检查记录。

`heartbeat_at` 根据传输层状态和时间戳计算存活状态：

```rust
// claw-code/rust/crates/runtime/src/session.rs

pub fn heartbeat_at(
    &self,
    now_ms: u64,
    stalled_after_ms: u64,
    transport_alive: bool,
) -> SessionHeartbeat {
    let liveness = match (transport_alive, self.last_health_check_ms) {
        (false, _) => SessionLiveness::TransportDead,
        (true, Some(last)) if now_ms.saturating_sub(last) <= stalled_after_ms => {
            SessionLiveness::Healthy
        }
        (true, Some(_)) => SessionLiveness::Stalled,
        (true, None) => SessionLiveness::Unknown,
    };

    SessionHeartbeat {
        session_id: self.session_id.clone(),
        observed_at_ms: now_ms,
        transport_alive,
        liveness,
    }
}
```

这个方法用一个 `match` 表达式完成状态判断，逻辑清晰：传输层已死→`TransportDead`；传输层活着且有健康检查记录在时效内→`Healthy`；传输层活着但健康检查超时→`Stalled`；传输层活着但无健康检查记录→`Unknown`。`saturating_sub` 防止时间差下溢。`record_health_check` 方法用于更新 `last_health_check_ms` 时间戳。

`SessionStore` 的 workspace fingerprint 隔离，类似于多租户场景下按租户 ID 分库分表的做法。

## 9.13 本章小结

本章从数据模型、持久化、命名空间隔离、自动压缩和生命周期五个层面拆解了 claw-code 的会话管理机制。Python 端的 `StoredSession` 是极简原型，以单个 JSON 文件存储。Rust 端的 `Session` 是生产级实现：JSONL 增量追加避免了每次保存都重写整个文件，原子写入（临时文件 + rename）防止了进程崩溃导致文件损坏，日志轮转（256KB 阈值 + 最多 3 个历史文件）控制了文件增长。

命名空间隔离通过 FNV-1a 哈希将工作空间路径映射为 16 位十六进制指纹，作为会话目录的子目录名，防止多项目并行运行时的会话碰撞。别名解析（`latest`/`last`/`recent`）和跨工作空间 fallback 提供了灵活的会话引用方式。workspace 校验确保不会误加载其他项目的会话。

自动压缩机制在 token 估算超过阈值时触发，保留最近若干条消息原文，将更早的消息替换为摘要合成的 system 消息。压缩边界的 tool-use/tool-result 配对安全检查防止了 OpenAI 兼容 API 的 400 错误。会话 Fork 支持从已有会话分叉出新的会话分支，心跳机制提供了四种存活状态的实时检测。
