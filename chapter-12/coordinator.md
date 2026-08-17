# 第11章 协调器：TaskRegistry 与 Team/Cron 编排

## 本章概览

本章分析 claw-code 的协调器系统——如何管理子 Agent 任务、团队和定时任务。对应 `runtime::task_registry` 和 `runtime::team_cron_registry` 模块。

协调器系统解决的核心问题是：单个 Agent 实例一次只能处理一个任务，但复杂项目需要并行执行多个子任务（如同时修改多个文件、并行测试）。协调器通过任务注册表跟踪每个子任务的状态，通过团队注册表把任务分组，通过定时注册表管理周期性任务。

| 关键文件 | 职责 |
| --- | --- |
| `rust/crates/runtime/src/task_registry.rs` | `TaskRegistry` 任务生命周期、`LaneBoard` 状态看板 |
| `rust/crates/runtime/src/team_cron_registry.rs` | `TeamRegistry` 团队管理、`CronRegistry` 定时任务 |

## 11.1 任务注册表：TaskRegistry

### 任务状态模型

`TaskRegistry` 管理子 Agent 任务的完整生命周期：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

pub enum TaskStatus {
    Created,
    Running,
    Blocked,
    Completed,
    Failed,
    Stopped,
}
```

`Created` 表示任务已创建但尚未启动。`Running` 表示子 Agent 正在执行。`Blocked` 表示任务被阻塞（如等待依赖、等待权限）。`Completed` 表示成功完成。`Failed` 表示执行失败。`Stopped` 表示被手动停止。

`Task` 结构记录任务的完整状态：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

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

`task_id` 是唯一标识。`prompt` 是任务的原始提示。`description` 是可选描述。`task_packet` 是结构化任务包（包含目标、范围、参数等）。`messages` 是任务对话历史（子 Agent 的输入输出）。`output` 是累积输出。`team_id` 是所属团队。`heartbeat` 是心跳状态（用于检测僵死任务）。

### 线程安全的内部结构

`TaskRegistry` 使用 `Arc<Mutex<Inner>>` 模式实现线程安全共享：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

pub struct TaskRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

struct RegistryInner {
    tasks: HashMap<String, Task>,
    counter: u64,
}
```

`Arc` 允许多线程共享所有权，`Mutex` 提供互斥访问。`RegistryInner` 包含 `HashMap` 存储任务和 `counter` 生成唯一 ID。`TaskRegistry` 的 `Clone` 实现由 `Arc` 自动处理——克隆只增加引用计数，不复制数据。

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

impl TaskRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(&self, prompt: &str, description: Option<&str>) -> Task {
        self.create_task(prompt.to_owned(), description.map(str::to_owned), None)
    }

    pub fn create_from_packet(
        &self, packet: TaskPacket,
    ) -> Result<Task, TaskPacketValidationError> {
        let packet = validate_packet(packet)?.into_inner();
        let description = packet.scope_path.clone().or_else(|| Some(packet.scope.to_string()));
        Ok(self.create_task(packet.objective.clone(), description, Some(packet)))
    }
```

`create` 从提示文本创建任务。`create_from_packet` 从 `TaskPacket` 创建——先验证数据包有效性，然后提取目标作为提示，范围路径或范围作为描述。

`create_task` 生成 ID 并存储：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

    fn create_task(
        &self, prompt: String, description: Option<String>, task_packet: Option<TaskPacket>,
    ) -> Task {
        let mut inner = self.inner.lock().expect("registry lock poisoned");
        inner.counter += 1;
        let ts = now_secs();
        let task_id = format!("task_{:08x}_{}", ts, inner.counter);
        let task = Task {
            task_id: task_id.clone(), prompt, description, task_packet,
            status: TaskStatus::Created, created_at: ts, updated_at: ts,
            messages: Vec::new(), output: String::new(), team_id: None, heartbeat: None,
        };
        inner.tasks.insert(task_id, task.clone());
        task
    }
```

`lock()` 获取互斥锁。`expect("registry lock poisoned")` 处理锁中毒——如果其他线程在持有锁时 panic，锁被标记为 "poisoned"，这里选择 panic 而不是静默失败。`format!("task_{:08x}_{}", ts, counter)` 生成 ID——时间戳 + 计数器保证唯一性。

### 心跳与 Lane Board

`LaneHeartbeat` 记录子 Agent 的存活状态：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

pub struct LaneHeartbeat {
    pub observed_at: u64,
    pub transport_alive: bool,
    pub status: String,
}

pub enum LaneFreshness {
    Healthy,
    Stalled,
    TransportDead,
    Unknown,
}
```

`observed_at` 是心跳时间戳（Unix 秒）。`transport_alive` 表示传输层是否活跃。`status` 是字符串状态（如 `"thinking"`、`"executing"`）。`freshness_at` 方法根据当前时间和 `stalled_after_secs` 判断 freshness：

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

`LaneBoard` 是任务状态看板，按状态分组：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

pub struct LaneBoard {
    pub generated_at: u64,
    pub active: Vec<LaneBoardEntry>,
    pub blocked: Vec<LaneBoardEntry>,
    pub finished: Vec<LaneBoardEntry>,
}

pub struct LaneBoardEntry {
    pub task_id: String,
    pub prompt: String,
    pub status: TaskStatus,
    pub team_id: Option<String>,
    pub heartbeat: Option<LaneHeartbeat>,
    pub freshness: LaneFreshness,
}
```

`lane_board` 方法生成看板：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

    pub fn lane_board(&self, stalled_after_secs: u64) -> LaneBoard {
        let now = now_secs();
        self.lane_board_at(now, stalled_after_secs)
    }

    pub fn lane_board_at(&self, now: u64, stalled_after_secs: u64) -> LaneBoard {
        let inner = self.inner.lock().expect("registry lock poisoned");
        let mut board = LaneBoard { generated_at: now, active: Vec::new(), blocked: Vec::new(), finished: Vec::new() };

        for task in inner.tasks.values() {
            let freshness = task.heartbeat.as_ref().map_or(LaneFreshness::Unknown, |heartbeat| {
                heartbeat.freshness_at(now, stalled_after_secs)
            });
            let entry = LaneBoardEntry { ... };

            match task.status {
                TaskStatus::Running | TaskStatus::Created => board.active.push(entry),
                TaskStatus::Blocked => board.blocked.push(entry),
                TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Stopped => board.finished.push(entry),
            }
        }
        board
    }
```

`active` 包含 `Running` 和 `Created` 状态的任务。`blocked` 包含被阻塞的任务。`finished` 包含已完成、失败和已停止的任务。`freshness` 由心跳计算——无心跳的任务标记为 `Unknown`。

### 状态操作

`TaskRegistry` 提供原子状态操作：

```rust
// claw-code/rust/crates/runtime/src/task_registry.rs

    pub fn update_heartbeat(&self, task_id: &str, heartbeat: LaneHeartbeat) -> Result<(), String> {
        let mut inner = self.inner.lock().expect("registry lock poisoned");
        let task = inner.tasks.get_mut(task_id).ok_or_else(|| format!("task not found: {task_id}"))?;
        task.heartbeat = Some(heartbeat);
        task.updated_at = now_secs();
        Ok(())
    }

    pub fn stop(&self, task_id: &str) -> Result<Task, String> {
        let mut inner = self.inner.lock().expect("registry lock poisoned");
        let task = inner.tasks.get_mut(task_id).ok_or_else(|| format!("task not found: {task_id}"))?;
        match task.status {
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Stopped => {
                return Err(format!("task {task_id} is already in terminal state: {}", task.status));
            }
            _ => {}
        }
        task.status = TaskStatus::Stopped;
        task.updated_at = now_secs();
        Ok(task.clone())
    }

    pub fn set_status(&self, task_id: &str, status: TaskStatus) -> Result<(), String> {
        let mut inner = self.inner.lock().expect("registry lock poisoned");
        let task = inner.tasks.get_mut(task_id).ok_or_else(|| format!("task not found: {task_id}"))?;
        task.status = status;
        task.updated_at = now_secs();
        Ok(())
    }

    pub fn assign_team(&self, task_id: &str, team_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().expect("registry lock poisoned");
        let task = inner.tasks.get_mut(task_id).ok_or_else(|| format!("task not found: {task_id}"))?;
        task.team_id = Some(team_id.to_owned());
        task.updated_at = now_secs();
        Ok(())
    }
```

`stop` 检查终端状态——已完成或失败的任务不能被停止。`set_status` 直接设置状态（不检查转换合法性）。`assign_team` 把任务关联到团队。所有操作都更新 `updated_at` 时间戳。

## 11.2 团队注册表：TeamRegistry

`TeamRegistry` 管理任务分组：

```rust
// claw-code/rust/crates/runtime/src/team_cron_registry.rs

pub struct Team {
    pub team_id: String,
    pub name: String,
    pub task_ids: Vec<String>,
    pub status: TeamStatus,
    pub created_at: u64,
    pub updated_at: u64,
}

pub enum TeamStatus {
    Created,
    Running,
    Completed,
    Deleted,
}
```

`Team` 结构包含 `task_ids` 列表——一个团队关联多个任务。`TeamStatus` 与 `TaskStatus` 类似但少了 `Blocked` 和 `Stopped`。

`TeamRegistry` 使用同样的 `Arc<Mutex<Inner>>` 模式：

```rust
// claw-code/rust/crates/runtime/src/team_cron_registry.rs

pub struct TeamRegistry {
    inner: Arc<Mutex<TeamInner>>,
}

struct TeamInner {
    teams: HashMap<String, Team>,
    counter: u64,
}
```

CRUD 操作：

```rust
// claw-code/rust/crates/runtime/src/team_cron_registry.rs

impl TeamRegistry {
    pub fn create(&self, name: &str, task_ids: Vec<String>) -> Team {
        let mut inner = self.inner.lock().expect("team registry lock poisoned");
        inner.counter += 1;
        let ts = now_secs();
        let team_id = format!("team_{:08x}_{}", ts, inner.counter);
        let team = Team {
            team_id: team_id.clone(), name: name.to_owned(), task_ids,
            status: TeamStatus::Created, created_at: ts, updated_at: ts,
        };
        inner.teams.insert(team_id, team.clone());
        team
    }

    pub fn get(&self, team_id: &str) -> Option<Team> {
        let inner = self.inner.lock().expect("team registry lock poisoned");
        inner.teams.get(team_id).cloned()
    }

    pub fn list(&self) -> Vec<Team> {
        let inner = self.inner.lock().expect("team registry lock poisoned");
        inner.teams.values().cloned().collect()
    }

    pub fn delete(&self, team_id: &str) -> Result<Team, String> {
        let mut inner = self.inner.lock().expect("team registry lock poisoned");
        let team = inner.teams.get_mut(team_id).ok_or_else(|| format!("team not found: {team_id}"))?;
        team.status = TeamStatus::Deleted;
        team.updated_at = now_secs();
        Ok(team.clone())
    }

    pub fn remove(&self, team_id: &str) -> Option<Team> {
        let mut inner = self.inner.lock().expect("team registry lock poisoned");
        inner.teams.remove(team_id)
    }
```

`delete` 是软删除——标记状态为 `Deleted` 但不从 `HashMap` 移除。`remove` 是硬删除——从 `HashMap` 移除。软删除保留历史记录，硬删除释放内存。`get` 和 `list` 返回 `cloned()` 副本——调用方获得独立的数据拷贝，不会持有锁。

## 11.3 定时注册表：CronRegistry

`CronRegistry` 管理周期性任务：

```rust
// claw-code/rust/crates/runtime/src/team_cron_registry.rs

pub struct CronEntry {
    pub cron_id: String,
    pub schedule: String,
    pub prompt: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_run_at: Option<u64>,
    pub run_count: u64,
}
```

`schedule` 是 cron 表达式（如 `"0 * * * *"` 每小时执行）。`enabled` 控制是否启用。`last_run_at` 记录上次执行时间。`run_count` 记录执行次数。

`CronRegistry` 的 CRUD 操作：

```rust
// claw-code/rust/crates/runtime/src/team_cron_registry.rs

impl CronRegistry {
    pub fn create(&self, schedule: &str, prompt: &str, description: Option<&str>) -> CronEntry {
        let mut inner = self.inner.lock().expect("cron registry lock poisoned");
        inner.counter += 1;
        let ts = now_secs();
        let cron_id = format!("cron_{:08x}_{}", ts, inner.counter);
        let entry = CronEntry {
            cron_id: cron_id.clone(), schedule: schedule.to_owned(), prompt: prompt.to_owned(),
            description: description.map(str::to_owned), enabled: true, created_at: ts,
            updated_at: ts, last_run_at: None, run_count: 0,
        };
        inner.entries.insert(cron_id, entry.clone());
        entry
    }

    pub fn list(&self, enabled_only: bool) -> Vec<CronEntry> {
        let inner = self.inner.lock().expect("cron registry lock poisoned");
        inner.entries.values().filter(|e| !enabled_only || e.enabled).cloned().collect()
    }

    pub fn disable(&self, cron_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().expect("cron registry lock poisoned");
        let entry = inner.entries.get_mut(cron_id).ok_or_else(|| format!("cron not found: {cron_id}"))?;
        entry.enabled = false;
        entry.updated_at = now_secs();
        Ok(())
    }

    pub fn record_run(&self, cron_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().expect("cron registry lock poisoned");
        let entry = inner.entries.get_mut(cron_id).ok_or_else(|| format!("cron not found: {cron_id}"))?;
        entry.last_run_at = Some(now_secs());
        entry.run_count += 1;
        entry.updated_at = now_secs();
        Ok(())
    }
```

`create` 新条目默认启用。`disable` 禁用条目但不删除。`record_run` 更新执行时间和计数。`delete` 硬删除条目（从 `HashMap` 移除）。

### 定时调度

`CronRegistry` 本身不实现调度器——它只存储条目和记录执行。实际调度由外部系统（如操作系统 cron 或内部调度器）触发。`record_run` 在每次执行后调用，更新 `last_run_at` 和 `run_count`。这种设计把调度逻辑与状态存储分离——调度器可以独立实现，注册表只提供状态查询和更新接口。

## 11.4 全局注册表与工具集成

三个注册表在 `tools` crate 中通过 `OnceLock` 提供全局访问：

```rust
// claw-code/rust/crates/tools/src/lib.rs

fn global_team_registry() -> &'static TeamRegistry {
    use std::sync::OnceLock;
    static REGISTRY: OnceLock<TeamRegistry> = OnceLock::new();
    REGISTRY.get_or_init(TeamRegistry::new)
}

fn global_cron_registry() -> &'static CronRegistry {
    use std::sync::OnceLock;
    static REGISTRY: OnceLock<CronRegistry> = OnceLock::new();
    REGISTRY.get_or_init(CronRegistry::new)
}
```

`OnceLock` 是线程安全的懒初始化——首次调用时初始化，后续调用返回已初始化值。`get_or_init` 在内部使用 `Once` 保证只初始化一次。

工具函数直接调用全局注册表：

```rust
// claw-code/rust/crates/tools/src/lib.rs (execute_tool_with_enforcer 中的片段)

    "TeamCreate" => {
        let team = global_team_registry().create(name, task_ids);
        serde_json::to_string(&team).map_err(|e| e.to_string())
    }
    "TeamDelete" => {
        let team = global_team_registry().delete(team_id)?;
        serde_json::to_string(&team).map_err(|e| e.to_string())
    }
    "CronCreate" => {
        let entry = global_cron_registry().create(schedule, prompt, description);
        serde_json::to_string(&entry).map_err(|e| e.to_string())
    }
    "CronList" => {
        let entries = global_cron_registry().list(enabled_only);
        serde_json::to_string(&entries).map_err(|e| e.to_string())
    }
```

工具调用直接修改全局注册表，返回序列化的结果。这种设计简化了工具实现——不需要传递注册表引用，但代价是全局状态难以测试和模拟。

## 小结

协调器系统在 Rust 端以三个线程安全的注册表实现：`TaskRegistry`（`task_registry.rs`）管理子 Agent 任务生命周期（Created → Running → Blocked → Completed/Failed/Stopped），`Arc<Mutex<RegistryInner>>` 模式提供共享状态，`lane_board` 按状态分组生成看板，`LaneHeartbeat` 检测僵死任务（Healthy/Stalled/TransportDead）。`TeamRegistry`（`team_cron_registry.rs`）管理团队分组，支持软删除（标记 Deleted）和硬删除（remove）。`CronRegistry` 管理周期性任务，记录 schedule、enabled、last_run_at、run_count，但不实现调度器——调度由外部触发。

三个注册表在 `tools` crate 中通过 `OnceLock` 提供全局单例，工具函数直接调用全局注册表进行 CRUD 操作。ID 生成格式为 `<type>_<timestamp>_<counter>`，counter 在 `Mutex` 保护下自增保证唯一性。

| 关键文件 | 核心机制 | 对应章节 |
| --- | --- | --- |
| `rust/crates/runtime/src/task_registry.rs` | `TaskRegistry`、`TaskStatus`、`LaneBoard`、`LaneHeartbeat` | 11.1 |
| `rust/crates/runtime/src/team_cron_registry.rs` | `TeamRegistry`、`CronRegistry`、软删除/硬删除 | 11.2-11.3 |
| `rust/crates/tools/src/lib.rs` | 全局 `OnceLock` 注册表、工具集成 | 11.4 |

下一章将分析 MCP 协议与插件扩展——`McpToolRegistry` 如何对接外部 MCP 服务器，`McpToolBridge` 如何转换工具规范，以及插件生命周期管理。
