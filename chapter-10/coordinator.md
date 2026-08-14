# 第10章 协调器：多 Agent 编排与 Lane 生命周期

## 本章概览

当单个 Agent 面对大规模重构或跨模块分析任务时，上下文窗口容易耗尽，且无法并行探索不同代码路径。claw-code 的解决方案是协调器模式（Coordinator Mode）：一个主 Agent 拆解任务，多个 Worker Agent 并行执行，最后汇总结果。Python 重写版保留了原版协调器的存档元数据和移植审计基础设施，Rust 生产版则实现了完整的 Lane（工作流分支）生命周期管理：`TaskRegistry` 管理子 Agent 任务的状态机，`PolicyEngine` 根据 Lane 上下文评估规则并输出决策动作，`LaneEvent` 系统记录 Lane 生命周期中的 20 余种事件，`WorkerBoot` 状态机管理 Worker 启动阶段的多级信任门控。

本章从 Python 端的存档审计开始，逐步过渡到 Rust 端的 Lane 编排系统。对于 Java 工程师来说，`TaskRegistry` 相当于 `ThreadPoolExecutor` + `FutureTask` 的组合，`PolicyEngine` 相当于 Drools 规则引擎，`LaneEvent` 相当于领域事件的 EventBus，而 `WorkerBoot` 的多级状态机则类似于 Spring Security 的过滤器链。

| 层级 | 源文件 | 核心结构 | 职责 |
| --- | --- | --- | --- |
| Python 归档 | `src/coordinator/__init__.py` | `_SNAPSHOT` | 占位符，加载存档元数据 |
| Python 审计 | `src/parity_audit.py` | `ParityAuditResult` | 移植覆盖率审计 |
| Python 镜像 | `src/execution_registry.py` | `ExecutionRegistry` | 命令/工具镜像查找 |
| Rust 任务 | `rust/crates/runtime/src/task_registry.rs` | `TaskRegistry` | 子 Agent 任务状态机 |
| Rust 策略 | `rust/crates/runtime/src/policy_engine.rs` | `PolicyEngine` | 规则评估与决策 |
| Rust 事件 | `rust/crates/runtime/src/lane_events.rs` | `LaneEventName` | Lane 生命周期事件 |
| Rust 启动 | `rust/crates/runtime/src/worker_boot.rs` | `WorkerStatus` | Worker 启动信任门控 |

## 10.1 Python 端：归档的协调器子系统

Python 端的 `src/coordinator/` 目录只有一个占位文件，通过 `_archive_helper` 加载存档元数据：

```python
# claw-code/src/coordinator/__init__.py

from src._archive_helper import load_archive_metadata

_SNAPSHOT = load_archive_metadata("coordinator")

ARCHIVE_NAME = _SNAPSHOT["archive_name"]
MODULE_COUNT = _SNAPSHOT["module_count"]
SAMPLE_FILES = tuple(_SNAPSHOT["sample_files"])
PORTING_NOTE = f"Python placeholder package for '{ARCHIVE_NAME}' with {MODULE_COUNT} archived module references."

__all__ = ["ARCHIVE_NAME", "MODULE_COUNT", "PORTING_NOTE", "SAMPLE_FILES"]
```

这段代码与第 8 章的 hooks 归档占位符结构完全一致。`load_archive_metadata` 从 `reference_data/subsystems/coordinator.json` 读取快照，Python 模块把这些值导出为常量。`__all__` 列表显式声明了模块的公开 API，限制 `from coordinator import *` 的导入范围。在 Java 中，这相当于一个只包含 `final static` 常量的工具类。

存档元数据记录了原版协调器的规模：

```json
// claw-code/src/reference_data/subsystems/coordinator.json

{
  "archive_name": "coordinator",
  "package_name": "coordinator",
  "module_count": 1,
  "sample_files": [
    "coordinator/coordinatorMode.ts"
  ]
}
```

`module_count` 为 1，说明原版 TypeScript 项目中协调器核心只有 1 个模块——`coordinatorMode.ts`。这个文件负责在检测到环境变量 `CLAUDE_CODE_COORDINATOR_MODE=1` 时，将普通系统提示词替换为协调器专用提示词。协调器 Agent 获得的指令明确告知它如何拆解任务、派发 Worker、汇总结果。这不是编译期分支，而是运行时的行为切换——同一个 Agent 进程，根据环境变量决定扮演"执行者"还是"协调者"。

工具层的快照数据进一步揭示了原版的多 Agent 基础设施规模：

```json
// claw-code/src/reference_data/tools_snapshot.json（节选）

[
  { "name": "AgentTool", "source_hint": "tools/AgentTool/AgentTool.tsx" },
  { "name": "forkSubagent", "source_hint": "tools/AgentTool/forkSubagent.ts" },
  { "name": "resumeAgent", "source_hint": "tools/AgentTool/resumeAgent.ts" },
  { "name": "runAgent", "source_hint": "tools/AgentTool/runAgent.ts" },
  { "name": "SendMessageTool", "source_hint": "tools/SendMessageTool/SendMessageTool.ts" },
  { "name": "TaskStopTool", "source_hint": "tools/TaskStopTool/TaskStopTool.ts" },
  { "name": "TaskCreateTool", "source_hint": "tools/TaskCreateTool/TaskCreateTool.ts" },
  { "name": "TaskGetTool", "source_hint": "tools/TaskGetTool/TaskGetTool.ts" },
  { "name": "TaskListTool", "source_hint": "tools/TaskListTool/TaskListTool.ts" },
  { "name": "TaskOutputTool", "source_hint": "tools/TaskOutputTool/TaskOutputTool.tsx" },
  { "name": "TaskUpdateTool", "source_hint": "tools/TaskUpdateTool/TaskUpdateTool.ts" },
  { "name": "spawnMultiAgent", "source_hint": "tools/shared/spawnMultiAgent.ts" }
]
```

这些工具模块构成了原版的多 Agent 工具链。`AgentTool` 是核心——协调器通过它创建子 Agent，每个子 Agent 拥有独立的上下文窗口、工具权限集合和 `AbortController`。`forkSubagent` 和 `resumeAgent` 支持子 Agent 的分叉和恢复。`SendMessageTool` 实现 Worker 之间的单向邮箱通信。`TaskCreateTool`、`TaskGetTool`、`TaskListTool`、`TaskUpdateTool`、`TaskOutputTool`、`TaskStopTool` 构成任务 CRUD 套件。`spawnMultiAgent` 批量创建多个子 Agent。

## 10.2 移植审计与镜像注册表

Python 重写版建立了一套完整的移植审计基础设施。`parity_audit.py` 追踪原版模块的覆盖率：

```python
# claw-code/src/parity_audit.py

ARCHIVE_ROOT_FILES = {
    'QueryEngine.ts': 'QueryEngine.py',
    'Task.ts': 'task.py',
    'Tool.ts': 'Tool.py',
    'commands.ts': 'commands.py',
    # ... 共 19 个根文件映射
}

ARCHIVE_DIR_MAPPINGS = {
    'assistant': 'assistant',
    'bootstrap': 'bootstrap',
    'coordinator': 'coordinator',
    # ... 共 34 个目录映射
}

@dataclass(frozen=True)
class ParityAuditResult:
    archive_present: bool
    root_file_coverage: tuple[int, int]
    directory_coverage: tuple[int, int]
    total_file_ratio: tuple[int, int]
    command_entry_ratio: tuple[int, int]
    tool_entry_ratio: tuple[int, int]
    missing_root_targets: tuple[str, ...]
    missing_directory_targets: tuple[str, ...]
```

`ARCHIVE_ROOT_FILES` 是原版根文件到 Python 文件的映射字典，`ARCHIVE_DIR_MAPPINGS` 是原版目录到 Python 目录的映射。`ParityAuditResult` 是 frozen dataclass，所有字段用 tuple 而非 list 保证不可变性。每个覆盖率指标都是 `tuple[int, int]` 格式，如 `(5, 19)` 表示 19 个根文件中已覆盖 5 个。`run_parity_audit()` 将当前 Python 文件与存档快照对比，输出这些指标。对于协调器，`directory_coverage` 会显示 `coordinator` 目录存在（因为有 `__init__.py`），但 `total_file_ratio` 暴露该目录下只有 1 个文件。

`execution_registry.py` 为镜像的命令和工具提供统一查找入口：

```python
# claw-code/src/execution_registry.py

@dataclass(frozen=True)
class ExecutionRegistry:
    commands: tuple[MirroredCommand, ...]
    tools: tuple[MirroredTool, ...]

    def command(self, name: str) -> MirroredCommand | None:
        lowered = name.lower()
        for command in self.commands:
            if command.name.lower() == lowered:
                return command
        return None

    def tool(self, name: str) -> MirroredTool | None:
        lowered = name.lower()
        for tool in self.tools:
            if tool.name.lower() == lowered:
                return tool
        return None
```

`ExecutionRegistry` 是 frozen dataclass，持有命令和工具的镜像元组。`command()` 和 `tool()` 方法做大小写不敏感的线性查找。`MirroredCommand` 和 `MirroredTool` 是镜像条目，记录原版模块的名称、职责描述和源文件路径，但不包含实际执行逻辑。在 Java 中，这相当于一个 `ServiceLocator` 模式的实现——按名称查找服务描述，但不执行服务。

`execute_command` 的实现揭示了这个镜像系统的本质：

```python
# claw-code/src/execution_registry.py

def execute_command(name: str, prompt: str = '') -> CommandExecution:
    module = get_command(name)
    if module is None:
        return CommandExecution(name=name, source_hint='', prompt=prompt,
            handled=False, message=f'Unknown mirrored command: {name}')
    action = f"Mirrored command '{module.name}' from {module.source_hint} would handle prompt {prompt!r}."
    return CommandExecution(name=module.name, source_hint=module.source_hint,
        prompt=prompt, handled=True, message=action)
```

`execute_command` 查找到镜像条目后，不执行任何业务逻辑，只是返回一条描述性消息："Mirrored command 'X' from Y would handle prompt Z"。`handled=True` 表示命令被识别但没有实际执行。这为尚未实现的子系统保留了接口契约——未来补完实现时，只需在镜像条目后面填入真实逻辑。

## 10.3 Rust 端：TaskRegistry 子 Agent 任务状态机

Rust 生产版实现了完整的多 Agent 编排基础设施。`TaskRegistry` 是子 Agent 任务的核心状态机管理器，位于 `rust/crates/runtime/src/task_registry.rs`。

任务状态定义了六种状态：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Created,
    Running,
    Blocked,
    Completed,
    Failed,
    Stopped,
}
```

`Created` 是初始状态，任务已创建但尚未开始执行。`Running` 表示子 Agent 正在工作。`Blocked` 表示任务被阻塞（如等待信任门控通过）。`Completed`、`Failed`、`Stopped` 是三种终态：正常完成、执行失败、被外部停止。`#[serde(rename_all = "snake_case")]` 让序列化输出使用 snake_case（`created`、`running`），与 JSON API 的命名惯例一致。在 Java 中，这对应 `enum TaskStatus { Created, Running, Blocked, Completed, Failed, Stopped }`，状态转换逻辑类似于 `FutureTask.State`。

`Task` 结构携带任务的完整上下文：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub task_id: String,
    pub prompt: String,
    pub description: Option<String>,
    pub task_packet: Option<TaskPacket>,
    pub status: TaskStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub messages: Vec<TaskMessage>,
    pub output: String,
    pub team_id: Option<String>,
    pub heartbeat: Option<LaneHeartbeat>,
}
```

逐字段分析：`task_id` 是唯一标识，格式为 `task_{timestamp_hex}_{counter}`。`prompt` 是发送给子 Agent 的指令文本。`description` 是可选的人类可读描述。`task_packet` 是结构化的任务包，包含目标、范围、路径等字段。`status` 是当前状态。`created_at` 和 `updated_at` 记录时间戳（秒级）。`messages` 是子 Agent 的消息历史。`output` 是任务最终输出。`team_id` 用于将相关任务分组。`heartbeat` 是可选的心跳信息，用于检测子 Agent 是否存活。

`TaskRegistry` 本身使用 `Arc<Mutex>` 实现线程安全的内部可变性：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

#[derive(Debug, Clone, Default)]
pub struct TaskRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

#[derive(Debug, Default)]
struct RegistryInner {
    tasks: HashMap<String, Task>,
    counter: u64,
}
```

`Arc<Mutex<RegistryInner>>` 是 Rust 中实现线程安全共享状态的标准模式：`Arc` 提供多所有者的引用计数，`Mutex` 提供互斥访问。`RegistryInner` 是私有内部结构，包含任务哈希表和递增计数器。`Clone` trait 的自动派生让 `TaskRegistry` 可以被廉价克隆——克隆的只是 `Arc` 的引用计数，内部数据共享。在 Java 中，这相当于一个线程安全的 `ConcurrentHashMap`，但 Rust 的 `Mutex` 是全量锁定而非分段锁定。

任务创建方法：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

impl TaskRegistry {
    pub fn create(&self, prompt: &str, description: Option<&str>) -> Task {
        self.create_task(prompt.to_owned(), description.map(str::to_owned), None)
    }

    pub fn create_from_packet(
        &self,
        packet: TaskPacket,
    ) -> Result<Task, TaskPacketValidationError> {
        let packet = validate_packet(packet)?.into_inner();
        let description = packet
            .scope_path
            .clone()
            .or_else(|| Some(packet.scope.to_string()));
        Ok(self.create_task(packet.objective.clone(), description, Some(packet)))
    }

    fn create_task(
        &self,
        prompt: String,
        description: Option<String>,
        task_packet: Option<TaskPacket>,
    ) -> Task {
        let mut inner = self.inner.lock().expect("registry lock poisoned");
        inner.counter += 1;
        let ts = now_secs();
        let task_id = format!("task_{:08x}_{}", ts, inner.counter);
        let task = Task {
            task_id: task_id.clone(),
            prompt,
            description,
            task_packet,
            status: TaskStatus::Created,
            created_at: ts,
            updated_at: ts,
            messages: Vec::new(),
            output: String::new(),
            team_id: None,
            heartbeat: None,
        };
        inner.tasks.insert(task_id, task.clone());
        task
    }
}
```

这段代码提供了两种创建方式：`create` 接收纯文本 prompt，`create_from_packet` 接收结构化的 `TaskPacket`（包含目标、范围、路径等）。`create_from_packet` 先调用 `validate_packet` 校验任务包，然后用 `scope_path` 或 `scope` 作为描述。`create_task` 是内部实现：锁定 mutex，递增计数器，生成 ID（`task_{timestamp_hex}_{counter}`），创建 `Task` 实例，插入哈希表，返回克隆。`.expect("registry lock poisoned")` 处理 mutex 中毒——当持有锁的线程 panic 时，mutex 会进入中毒状态，后续 lock 调用返回 `PoisonError`。`.expect` 选择 panic 而非静默恢复，因为中毒意味着内部状态可能已损坏。

`stop` 方法实现了终态保护：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

pub fn stop(&self, task_id: &str) -> Result<Task, String> {
    let mut inner = self.inner.lock().expect("registry lock poisoned");
    let task = inner
        .tasks
        .get_mut(task_id)
        .ok_or_else(|| format!("task not found: {task_id}"))?;

    match task.status {
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Stopped => {
            return Err(format!(
                "task {task_id} is already in terminal state: {}",
                task.status
            ));
        }
        _ => {}
    }

    task.status = TaskStatus::Stopped;
    task.updated_at = now_secs();
    Ok(task.clone())
}
```

这段代码的核心逻辑是终态保护：如果任务已经处于 `Completed`、`Failed` 或 `Stopped` 三种终态之一，拒绝重复停止并返回错误。只有非终态的任务才能被停止。`get_mut` 返回 `Option<&mut Task>`，`ok_or_else` 将 `None` 转为 `Err`。在 Java 中，这相当于在 `stop()` 方法中先检查状态再执行，类似于 `Future.cancel(true)` 对已完成任务的拒绝行为。

## 10.4 Lane Board：任务看板

`TaskRegistry` 提供了 `lane_board` 方法，将所有任务按状态分类成看板视图：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneBoardEntry {
    pub task_id: String,
    pub prompt: String,
    pub status: TaskStatus,
    pub team_id: Option<String>,
    pub heartbeat: Option<LaneHeartbeat>,
    pub freshness: LaneFreshness,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneBoard {
    pub generated_at: u64,
    pub active: Vec<LaneBoardEntry>,
    pub blocked: Vec<LaneBoardEntry>,
    pub finished: Vec<LaneBoardEntry>,
}
```

`LaneBoard` 将任务分成三列：`active`（Created + Running）、`blocked`（Blocked）、`finished`（Completed + Failed + Stopped）。每条 `LaneBoardEntry` 携带任务的摘要信息和实时新鲜度。`generated_at` 记录看板生成时间。在 Java 中，这相当于 Kanban 风格的任务看板，三列对应"进行中""阻塞""已完成"。

看板生成逻辑：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

pub fn lane_board_at(&self, now: u64, stalled_after_secs: u64) -> LaneBoard {
    let inner = self.inner.lock().expect("registry lock poisoned");
    let mut board = LaneBoard {
        generated_at: now,
        active: Vec::new(),
        blocked: Vec::new(),
        finished: Vec::new(),
    };

    for task in inner.tasks.values() {
        let freshness = task
            .heartbeat
            .as_ref()
            .map_or(LaneFreshness::Unknown, |heartbeat| {
                heartbeat.freshness_at(now, stalled_after_secs)
            });
        let entry = LaneBoardEntry {
            task_id: task.task_id.clone(),
            prompt: task.prompt.clone(),
            status: task.status,
            team_id: task.team_id.clone(),
            heartbeat: task.heartbeat.clone(),
            freshness,
        };

        match task.status {
            TaskStatus::Running | TaskStatus::Created => board.active.push(entry),
            TaskStatus::Blocked => board.blocked.push(entry),
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Stopped => {
                board.finished.push(entry);
            }
        }
    }

    board
}
```

这段代码遍历所有任务，根据心跳计算新鲜度（`Healthy`/`Stalled`/`TransportDead`/`Unknown`），然后按状态分入三列。`map_or(LaneFreshness::Unknown, |heartbeat| ...)` 是 `Option` 的链式操作：如果心跳为 `None` 返回 `Unknown`，否则调用 `freshness_at` 计算。新鲜度的计算逻辑在 `LaneHeartbeat::freshness_at` 中：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

impl LaneHeartbeat {
    pub fn freshness_at(&self, now: u64, stalled_after_secs: u64) -> LaneFreshness {
        if !self.transport_alive {
            return LaneFreshness::TransportDead;
        }
        if now.saturating_sub(self.observed_at) > stalled_after_secs {
            return LaneFreshness::Stalled;
        }
        LaneFreshness::Healthy
    }
}
```

三级判断：传输层已死→`TransportDead`；传输层活着但心跳超时→`Stalled`；传输层活着且心跳在时效内→`Healthy`。`saturating_sub` 防止时间差下溢。这与第 9 章 `Session::heartbeat_at` 的设计完全一致——会话级心跳和任务级心跳使用相同的状态判断逻辑。

## 10.5 PolicyEngine：规则引擎与决策评估

`PolicyEngine` 位于 `rust/crates/runtime/src/policy_engine.rs`，它根据 Lane 的整体状态决定下一步动作。这是多 Agent 编排场景中的核心决策组件。

规则定义：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyRule {
    pub name: String,
    pub condition: PolicyCondition,
    pub action: PolicyAction,
    pub priority: u32,
}

impl PolicyRule {
    pub fn matches(&self, context: &LaneContext) -> bool {
        self.condition.matches(context)
    }
}
```

`PolicyRule` 由四部分组成：`name` 是规则名称（用于日志和审计），`condition` 是触发条件，`action` 是匹配后执行的动作，`priority` 是优先级（数值越小优先级越高）。`matches` 方法将条件判断委托给 `PolicyCondition`。

`PolicyCondition` 支持组合逻辑和多种状态探测：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

#[derive(Debug, Clone, PartialEq, Eq)]
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

`And` 和 `Or` 支持条件组合，形成布尔表达式树。其余变体是原子条件：`GreenAt` 检查 CI 绿灯级别是否达标，`StaleBranch` 检查分支是否过期（超过 1 小时阈值），`StartupBlocked` 检查启动阶段是否被阻塞，`LaneCompleted` 检查 Lane 是否已完成，`ReviewPassed` 检查代码审查是否通过，`ScopedDiff` 检查 diff 是否在范围内，`TimedOut` 检查是否超时，`RetryAvailable` 检查重试次数是否用尽，`RebaseRequired` 检查是否需要 rebase，`ApprovalTokenPresent`/`ApprovalTokenMissing` 检查审批令牌。在 Java 中，这相当于 Drools 规则引擎的 `when` 条件部分。

条件匹配的实现：

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
            Self::LaneCompleted => context.completed,
            Self::LaneReconciled => context.reconciled,
            Self::ReviewPassed => context.review_status == ReviewStatus::Approved,
            Self::ScopedDiff => context.diff_scope == DiffScope::Scoped,
            Self::TimedOut { duration } => context.branch_freshness >= *duration,
            Self::RetryAvailable => context.retry_count < context.retry_limit,
            Self::RebaseRequired => context.rebase_required,
            Self::StaleCleanupRequired => context.stale_cleanup_required,
            Self::ApprovalTokenPresent => context.approval_token.is_some(),
            Self::ApprovalTokenMissing => context.approval_token.is_none(),
        }
    }
}
```

`And` 用 `all()` 要求所有子条件都满足，`Or` 用 `any()` 要求至少一个子条件满足——这与 SQL 的 `AND`/`OR` 语义相同。每个原子条件从 `LaneContext` 中提取相应字段进行比较。`GreenAt` 是复合条件——既要求 `green_contract_satisfied` 为 true，又要求 `green_level` 达标。

`PolicyAction` 定义了系统可执行的响应动作：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

#[derive(Debug, Clone, PartialEq, Eq)]
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

这些动作覆盖了 Lane 生命周期的所有阶段：`MergeToDev`/`MergeForward` 合并代码，`Retry`/`Rebase`/`RecoverOnce` 处理失败恢复，`Escalate` 上报问题，`CloseoutLane` 关闭 Lane，`CleanupSession`/`CleanupStale` 清理资源，`Reconcile` 调和无须操作的情况，`Notify` 发送通知，`RequireApprovalToken` 要求审批，`Block` 阻塞操作。`Chain` 支持动作的链式组合——一条规则匹配后可以触发多个动作。在 Java 中，这相当于工作流引擎的 `then` 动作部分，`Chain` 类似于 `CompositeAction`。

`Chain` 的扁平化：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

impl PolicyAction {
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
}
```

`flatten_into` 递归展开嵌套的 `Chain`，把所有非 `Chain` 动作平铺到一个 `Vec` 中。例如 `Chain([Retry, Chain([Notify, Block])])` 会被展开为 `[Retry, Notify, Block]`。这是组合模式的经典实现——将树形结构展开为线性列表。

`PolicyEngine` 的评估逻辑：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

pub struct PolicyEngine {
    rules: Vec<PolicyRule>,
}

impl PolicyEngine {
    pub fn new(mut rules: Vec<PolicyRule>) -> Self {
        rules.sort_by_key(|rule| rule.priority);
        Self { rules }
    }

    pub fn evaluate_with_events(&self, context: &LaneContext) -> PolicyEvaluation {
        let mut actions = Vec::new();
        let mut events = Vec::new();
        for rule in &engine.rules {
            if rule.matches(context) {
                let before = actions.len();
                rule.action.flatten_into(&mut actions);
                for action in &actions[before..] {
                    events.push(decision_event(rule, context, action));
                }
            }
        }
        PolicyEvaluation { actions, events }
    }
}
```

构造函数 `new` 按 `priority` 排序规则——数值越小优先级越高，先被评估。`evaluate_with_events` 遍历所有规则，对匹配的规则调用 `flatten_into` 展开动作并收集决策事件。与短路评估不同，这里遍历所有匹配的规则——多条规则可以同时匹配并产生多个动作。`before` 变量记录展开前的动作数量，用于精确地为每个新增动作生成决策事件。`PolicyEvaluation` 返回扁平化的动作列表和对应的决策事件列表。

## 10.6 LaneContext：工作流分支状态

`LaneContext` 是 `PolicyEngine` 评估的输入，携带 Lane 的完整状态快照：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

#[derive(Debug, Clone, PartialEq, Eq)]
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

逐字段分析：`lane_id` 是 Lane 唯一标识。`green_level` 是 CI 绿灯级别（0-255 的 u8），`green_contract_satisfied` 表示是否满足绿灯契约。`branch_freshness` 记录分支新鲜度（距离上次更新的时间间隔）。`blocker` 标识阻塞类型（None/Startup/External）。`review_status` 是代码审查状态（Pending/Approved/Rejected）。`diff_scope` 是 diff 范围（Full/Scoped）。`completed` 和 `reconciled` 分别标记 Lane 是否完成和是否已调合。`retry_count` 和 `retry_limit` 记录重试状态。`rebase_required` 和 `stale_cleanup_required` 是两个布尔标志。`approval_token` 是可选的审批令牌。`#[allow(clippy::struct_excessive_bools)]` 抑制了 Clippy 关于布尔字段过多的警告——在领域模型中，多个布尔标志是合理的。

`LaneContext` 使用 Builder 模式构建：

```rust
// claw-code/rust/crates/runtime/src/policy_engine.rs

impl LaneContext {
    pub fn new(
        lane_id: impl Into<String>,
        green_level: GreenLevel,
        branch_freshness: Duration,
        blocker: LaneBlocker,
        review_status: ReviewStatus,
        diff_scope: DiffScope,
        completed: bool,
    ) -> Self {
        Self {
            lane_id: lane_id.into(),
            green_level,
            green_contract_satisfied: false,
            branch_freshness,
            blocker,
            review_status,
            diff_scope,
            completed,
            reconciled: false,
            retry_count: 0,
            retry_limit: 1,
            rebase_required: false,
            stale_cleanup_required: false,
            approval_token: None,
        }
    }

    pub fn with_green_contract_satisfied(mut self, satisfied: bool) -> Self {
        self.green_contract_satisfied = satisfied;
        self
    }

    pub fn with_retry_state(mut self, retry_count: u32, retry_limit: u32) -> Self {
        self.retry_count = retry_count;
        self.retry_limit = retry_limit;
        self
    }

    pub fn with_approval_token(mut self, token: ApprovalToken) -> Self {
        self.approval_token = Some(token);
        self
    }
}
```

`new` 构造函数接收必填字段，可选字段通过 `with_*` 方法链式设置。每个 `with_*` 方法接收 `mut self`，修改后返回 `self`，支持 `context.with_retry_state(1, 3).with_rebase_required(true)` 这样的链式调用。这是 Rust Builder 模式的标准写法——用消费 self 的方法代替 Java 的返回新对象的 Builder。

## 10.7 Lane 事件系统

`lane_events.rs` 定义了 Lane 生命周期中的 20 余种事件：

```rust
// claw-code/rust/crates/runtime/src/lane_events.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LaneEventName {
    #[serde(rename = "lane.started")]
    Started,
    #[serde(rename = "lane.ready")]
    Ready,
    #[serde(rename = "lane.prompt_misdelivery")]
    PromptMisdelivery,
    #[serde(rename = "lane.blocked")]
    Blocked,
    #[serde(rename = "lane.red")]
    Red,
    #[serde(rename = "lane.green")]
    Green,
    #[serde(rename = "lane.commit.created")]
    CommitCreated,
    #[serde(rename = "lane.pr.opened")]
    PrOpened,
    #[serde(rename = "lane.merge.ready")]
    MergeReady,
    #[serde(rename = "lane.finished")]
    Finished,
    #[serde(rename = "lane.failed")]
    Failed,
    #[serde(rename = "lane.reconciled")]
    Reconciled,
    #[serde(rename = "lane.merged")]
    Merged,
    #[serde(rename = "lane.superseded")]
    Superseded,
    #[serde(rename = "lane.closed")]
    Closed,
    #[serde(rename = "branch.stale_against_main")]
    BranchStaleAgainstMain,
    #[serde(rename = "branch.workspace_mismatch")]
    BranchWorkspaceMismatch,
    #[serde(rename = "ship.prepared")]
    ShipPrepared,
    #[serde(rename = "ship.commits_selected")]
    ShipCommitsSelected,
    #[serde(rename = "ship.merged")]
    ShipMerged,
    #[serde(rename = "ship.pushed_main")]
    ShipPushedMain,
}
```

这些事件覆盖了 Lane 的完整生命周期：`Started`（启动）→ `Ready`（就绪）→ `Green`/`Red`（CI 通过/失败）→ `CommitCreated`（提交创建）→ `PrOpened`（PR 打开）→ `MergeReady`（合并就绪）→ `Merged`/`Reconciled`/`Superseded`/`Closed`（四种结束方式）。`PromptMisdelivery` 和 `Blocked` 是异常事件。`ShipPrepared`/`ShipCommitsSelected`/`ShipMerged`/`ShipPushedMain` 是发布流程事件。`#[serde(rename = "lane.started")]` 让序列化输出使用点分命名（`lane.started` 而非 `Started`），这是事件驱动架构中事件名的常见命名风格。

`LaneFailureClass` 枚举了失败分类：

```rust
// claw-code/rust/crates/runtime/src/lane_events.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaneFailureClass {
    PromptDelivery,
    TrustGate,
    BranchDivergence,
    Compile,
    Test,
    PluginStartup,
    McpStartup,
    McpHandshake,
    GatewayRouting,
    ToolRuntime,
}
```

十种失败分类覆盖了 Lane 可能遇到的所有失败场景：`PromptDelivery`（指令投递失败）、`TrustGate`（信任门控未通过）、`BranchDivergence`（分支偏离）、`Compile`（编译失败）、`Test`（测试失败）、`PluginStartup`/`McpStartup`/`McpHandshake`（插件/MCP 启动或握手失败）、`GatewayRouting`（网关路由失败）、`ToolRuntime`（工具运行时错误）。这种细粒度的失败分类让 `PolicyEngine` 可以根据失败类型选择不同的恢复策略——例如编译失败触发 `Retry`，信任门控失败触发 `Escalate`。

## 10.8 WorkerBoot：启动信任门控状态机

`worker_boot.rs` 实现了 Worker Agent 启动阶段的多级信任门控状态机：

```rust
// claw-code/rust/crates/runtime/src/worker_boot.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    Spawning,
    TrustRequired,
    ToolPermissionRequired,
    ReadyForPrompt,
    Running,
    Finished,
    Failed,
}
```

七个状态描述了 Worker 从创建到完成的完整生命周期。`Spawning` 是初始状态——Worker 进程正在创建。`TrustRequired` 表示 Worker 需要用户信任确认（类似于 SSH 的 host key 验证）。`ToolPermissionRequired` 表示需要工具权限审批。`ReadyForPrompt` 表示 Worker 通过了所有门控，准备接收指令。`Running` 表示正在执行任务。`Finished` 和 `Failed` 是两种终态。

这个状态机的设计理念是"启动即验证"——Worker 在接收任何指令之前，必须依次通过信任门控和权限门控。这防止了未经验证的 Worker 执行危险操作。在 Java 中，这类似于 Spring Security 的过滤器链——每个请求必须通过所有安全过滤器才能到达业务逻辑。

`WorkerFailureKind` 定义了启动失败的具体类型：

```rust
// claw-code/rust/crates/runtime/src/worker_boot.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerFailureKind {
    TrustGate,
    ToolPermissionGate,
    PromptDelivery,
    Protocol,
    Provider,
    StartupNoEvidence,
}
```

六种失败类型：`TrustGate`（信任门控失败）、`ToolPermissionGate`（工具权限门控失败）、`PromptDelivery`（指令投递失败）、`Protocol`（协议错误）、`Provider`（LLM 提供商错误）、`StartupNoEvidence`（启动后无证据——Worker 声称启动但无法证明）。`StartupNoEvidence` 是一个特殊的失败类型——Worker 进程启动了但没有产生任何可验证的输出（如就绪信号），这种"静默启动"被视为失败。

`WorkerEventKind` 记录了启动过程中的事件类型：

```rust
// claw-code/rust/crates/runtime/src/worker_boot.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerEventKind {
    Spawning,
    StartupPreflightWarning,
    TrustRequired,
    ToolPermissionRequired,
    TrustResolved,
    // ...
}
```

`StartupPreflightWarning` 是一个值得注意的事件——它不是错误，而是启动前检查中的警告。这允许系统在不阻塞启动的情况下记录潜在问题（如配置不一致、依赖版本不匹配），类似于飞机起飞前的预检清单。

## 10.9 设计对比

| claw-code 概念 | Java 生态对应 |
| --- | --- |
| `TaskRegistry` | `ThreadPoolExecutor` + `FutureTask` |
| `Task` | `FutureTask<TaskOutput>` |
| `TaskStatus` | `FutureTask.State`（NEW → RUNNING → COMPLETED/CANCELLED） |
| `LaneBoard` | Kanban 看板（Active/Blocked/Finished 三列） |
| `PolicyEngine` | Drools 规则引擎 |
| `PolicyRule` | Drools 的 `rule "name" when condition then action` |
| `PolicyCondition::And/Or` | Drools 的 `and`/`or` 条件组合 |
| `PolicyAction::Chain` | Composite Action 模式 |
| `LaneContext` | `ProcessContext` / `ExecutionContext` |
| `LaneEventName` | 领域事件（Domain Event） |
| `WorkerBoot` 状态机 | Spring Security 过滤器链 |
| `WorkerFailureKind` | 异常分类体系 |
| Python `ExecutionRegistry` | `ServiceLocator` 模式（接口契约骨架） |

核心差异在于调度决策的制定者。Java 的 Saga 或工作流引擎（如 Camunda）将拆分策略、并发度和失败重试逻辑写在代码或 BPMN 流程图中。claw-code 的 `PolicyEngine` 则将条件判断和动作选择都编码在规则中——规则本身是声明式的，但规则的评估和执行是确定性的。这与原版 Claude Code 的"LLM 作为调度引擎"有本质区别：原版让 LLM 自己决定拆成几个子任务，Rust 版则用规则引擎做确定性决策。

Python 重写版目前的位置，相当于一个只实现了 `ServiceLocator` 接口骨架、但预留了完整元数据的 Java 项目。`ExecutionRegistry` 和快照系统扮演了接口契约的角色，让未来的多 Agent 实现有明确的接入点。Rust 版则更进一步，已经实现了 `TaskRegistry`（任务状态机）、`PolicyEngine`（规则评估）和 `WorkerBoot`（启动门控），构成了一个可运行的多 Agent 控制平面。

## 10.10 本章小结

本章从 Python 端的存档审计和镜像注册表开始，逐步过渡到 Rust 端的 Lane 编排系统。Python 端的 `coordinator/__init__.py` 是占位符，`parity_audit.py` 和 `execution_registry.py` 构成移植审计基础设施，通过快照文件记录原版的 207 个命令和 184 个工具（包括 `AgentTool`、`SendMessageTool`、`TaskStopTool` 等协调器核心组件）。

Rust 端实现了完整的多 Agent 控制平面。`TaskRegistry` 用 `Arc<Mutex<HashMap>>` 管理子 Agent 任务的六状态状态机（Created → Running → Blocked → Completed/Failed/Stopped），`LaneBoard` 将任务按状态分类成三列看板（Active/Blocked/Finished），`LaneHeartbeat` 提供三级新鲜度检测（Healthy/Stalled/TransportDead）。`PolicyEngine` 按 priority 排序规则，遍历所有匹配规则并扁平化 `Chain` 动作，输出 `PolicyEvaluation` 包含动作列表和决策事件。`LaneContext` 携带 Lane 的完整状态快照，`PolicyCondition` 支持 `And`/`Or` 组合和 14 种原子条件。`LaneEventName` 定义了 21 种生命周期事件，`LaneFailureClass` 定义了 10 种失败分类。`WorkerBoot` 状态机实现了"启动即验证"的设计理念——Worker 必须依次通过信任门控和权限门控才能接收指令。
