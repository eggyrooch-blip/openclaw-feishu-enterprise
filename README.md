# openclaw-feishu-enterprise

[中文](#中文) | [English](#english)

---

<a id="中文"></a>

## 飞书通讯录 → OpenClaw 千人 Agent 同步方案

> 一个脚本，把飞书通讯录变成千人规模的 AI Agent 集群。每个员工一个专属 Agent，自动感知组织关系，入离职全自动。

### 这是什么

`feishu-sync.js` 是一个组织架构同步工具，**为已有 OpenClaw + 飞书部署的企业**增加"每人一个 Agent"的能力。它复用你现有的飞书 Bot 和 Gateway 配置，不需要额外的飞书应用审批（通讯录权限只需新建一个轻量 App）。

部署完成后：
- 每个员工在飞书里给企业机器人发消息 → Gateway 自动路由到该员工的专属 Agent
- 每个 Agent 通过 SOUL.md 知道自己是谁、属于什么部门、上级是谁
- 入职/离职/调岗/晋升 → 每日 cron 自动处理，零人工

### 它和你现有的 OpenClaw 是什么关系？

**不替换，是叠加。** 你的 Gateway、main agent、现有 `openclaw.json` 配置全部保留。feishu-sync 只做两件事：
1. 在 `agents/` 和 `workspace-{id}/` 下创建新的 Agent 目录
2. 在 `openclaw.json` 的 `agents.list` 和 `bindings` 里追加条目

你已有的飞书 Bot（`channels.feishu` 配置）就是消息入口，不需要改。**新建的唯一东西是一个"通讯录 App"**——它只有 Contact v3 只读权限，和消息 Bot 完全分离。

### 架构

```
你已有的 OpenClaw 飞书配置
  │
  │  channels.feishu（消息 Bot，已配好）
  │  ↓
  │  Gateway（已在跑）
  │
  ├── main agent        ← 不动
  ├── gatekeeper        ← 不动（未绑定会话的兜底）
  │
  └── feishu-sync.js 新增 ↓
      │
      │  读通讯录 App（新建，只读权限）
      │  ↓
      ├── Agent-zhangsan/  workspace-zhangsan/SOUL.md
      ├── Agent-lisi/      workspace-lisi/SOUL.md
      ├── Agent-wangwu/    workspace-wangwu/SOUL.md
      └── ... × N（每个员工一个）
          │
          └── Binding: open_id → agentId（追加到 openclaw.json）
```

### 核心能力

- **复用现有飞书 Bot**：不需要新建消息应用，复用 `channels.feishu` 配置
- **飞书通讯录 → Agent 全量同步**：BFS 遍历部门树，分页拉取员工，去重后批量创建
- **管理者/员工双模板 SOUL.md**：管理者含下属列表 + 团队指引，员工含部门 + 上级
- **五种变更自动处理**：入职（创建）、离职（归档不删除）、调岗、上级变更、晋升/免职
- **崩溃恢复**：Journal 文件记录进度，kill -9 也不丢，`--resume` 续跑
- **零外部依赖**：纯 Node.js ESM

### 7 层设计

| 层 | 职责 | 为什么需要 |
|----|------|-----------|
| 1. Config | 读 `openclaw.json`，复用已有飞书配置 | 不引入新配置文件 |
| 2. Auth | tenant_access_token 缓存 + 提前 5min 刷新 | 15-20min 批量拉取不中断 |
| 3. Pull | 部门树 BFS + 员工分页（Contact v3, 650ms 限流） | 从通讯录获取组织数据 |
| 4. Diff | 今日快照 vs 昨日快照 → 五种变更 | 增量处理，不全量重建 |
| 5. Write | 创建/归档 Agent + SOUL.md + Binding | **唯一依赖 OpenClaw 目录结构的层** |
| 6. Journal | 断点续跑 + 配置备份 + 回滚 | 千人规模写入的崩溃恢复 |
| 7. Observe | metrics JSONL + Webhook 通知 + 锁文件防并发 | 运维可见性 |

**平台可移植**：换 Agent 平台只需改 Layer 5（Write），其他 6 层直接复用。

### 前置条件

- **Node.js >= 20**（原生 `fetch`、ESM）
- **OpenClaw 已安装**，Gateway 已在运行，飞书 Bot 已配置（`channels.feishu`）
- **新建一个飞书"通讯录 App"**（不是你的消息 Bot！）：
  - 权限：`contact:user.base:readonly` + `contact:department.base:readonly`
  - 在"通讯录授权范围"中授权全部成员
  - 把 `appId` 和 `appSecret` 配到 `openclaw.json` → `channels.feishu.accounts.directory`

### 快速开始

**1. 配置通讯录 App**

在你已有的 `openclaw.json` 里加一段：

```json
{
  "channels": {
    "feishu": {
      "...": "你已有的飞书 Bot 配置不用动",
      "accounts": {
        "directory": {
          "appId": "cli_YOUR_DIRECTORY_APP_ID",
          "appSecret": "YOUR_DIRECTORY_APP_SECRET"
        }
      }
    }
  }
}
```

**2. 验证连通性**（只拉数据不写入）

```bash
node feishu-sync.js --pull-only
```

**3. 预览变更**

```bash
node feishu-sync.js --mode full --dry-run
```

**4. 全量同步**

```bash
node feishu-sync.js --mode full
```

**5. 验证路由**

```bash
# 找一个已同步的员工，在飞书里给 Bot 发消息
# 检查 Gateway 日志，确认路由到了对应 Agent
openclaw gateway logs --tail 20
```

**6. 配置每日增量**

```bash
# crontab -e
0 2 * * * export PATH=/opt/homebrew/bin:$PATH && node ~/.openclaw/scripts/feishu-sync.js --mode incremental >> ~/.openclaw/logs/sync.log 2>&1
```

### CLI 参数

| 参数 | 说明 |
|------|------|
| `--pull-only` | 只拉数据，不写 OpenClaw |
| `--dry-run` | 预览变更，不执行写入 |
| `--mode full\|incremental` | 全量 / 增量（默认 full） |
| `--dept <id>` | 只同步指定部门（试点用） |
| `--resume` | 从上次中断处继续 |
| `--cleanup` | 清除中断的 journal |
| `--use-snapshot <path>` | 跳过拉取，用本地快照 |
| `--verbose` | 详细日志 |
| `--notify-summary` | 完成后 Webhook 推送摘要 |

### SOUL.md 模板

**员工**：部门 + 上级 + 行为边界

**管理者**：部门 + 上级 + 下属列表（≤30 人）+ 团队管理指引

选择逻辑：`is_leader && subordinates.length > 0` → 管理者模板，否则员工模板。

Agent 命名直接用飞书 `user_id`，不加角色前缀——晋升时 agent_id 不变，角色信息只在 SOUL.md 维护。

### 安全说明

- 通讯录 App 与消息 App 分离，最小权限
- 飞书 `app_secret` 不存脚本，从 `openclaw.json` 或环境变量读取
- 离职 Agent 归档不删除，满足审计需求
- 快照文件不含敏感数据（只有 `open_id`、`user_id`、部门名）

### 项目结构

```
openclaw-feishu-enterprise/
├── feishu-sync.js              # 主脚本
├── lib/
│   ├── bindings.js             # Binding 对账与去重
│   ├── agents.js               # Agent 目录操作
│   ├── orphans.js              # 孤儿目录扫描
│   └── orphan-notify.js        # 孤儿扫描 Webhook 通知
├── examples/
│   └── openclaw.json.example   # 配置示例
├── docs/
│   └── architecture.md         # 架构详解
├── README.md                   # 本文件
├── README_EN.md                # English version
└── .gitignore
```

### License

MIT

### 相关文章

- [我们不需要第 33 个 Claw：千人 Agent 部署背后的治理逻辑](https://mp.weixin.qq.com/)
- [千人 Agent 的顶层设计：安全、隔离、感知、管控](https://mp.weixin.qq.com/)

---

<a id="english"></a>

## Feishu Directory → OpenClaw Enterprise Agent Sync

> One script to sync your Feishu (Lark) corporate directory into a fleet of AI Agents — one per employee, org-aware, with automated onboarding/offboarding.

### What is this

`feishu-sync.js` adds "one Agent per employee" capability **on top of your existing OpenClaw + Feishu setup**. It reuses your existing Feishu Bot and Gateway config — the only new thing you create is a lightweight "Directory App" for Contact v3 read access.

After deployment:
- Each employee messages your existing Feishu Bot → Gateway routes to their personal Agent
- Each Agent knows who they are, their department, and their manager (via SOUL.md)
- Onboarding/offboarding/transfers handled automatically by daily cron

### How it relates to your existing OpenClaw

**It doesn't replace — it extends.** Your Gateway, main agent, and `openclaw.json` stay untouched. feishu-sync only:
1. Creates new agent dirs (`agents/{id}/` + `workspace-{id}/`)
2. Appends entries to `agents.list` and `bindings` in your existing config

### Key Features

- **Reuses your existing Feishu Bot** — no new message app needed
- **Full org sync**: BFS department tree, paginated user fetch, dedup by user_id
- **Dual SOUL.md templates**: Manager (with subordinate list) vs Employee (with dept + manager)
- **5 change types**: onboard, offboard, transfer, leader change, promotion/demotion
- **Crash recovery**: Journal-based resume — tracks per-agent progress, survives kill -9
- **Zero dependencies**: Pure Node.js ESM

### 7-Layer Architecture

| Layer | Responsibility | Why |
|-------|---------------|-----|
| 1. Config | Read openclaw.json, multi-channel support | Environment adaptation |
| 2. Auth | tenant_access_token cache + auto-refresh | Uninterrupted batch requests |
| 3. Pull | Department tree BFS + user pagination (Contact v3) | Fetch org data from directory |
| 4. Diff | Today's snapshot vs yesterday's → 5 change types | Incremental, not full rebuild |
| 5. Write | Create/archive Agent + SOUL.md + Binding | **Only layer dependent on OpenClaw** |
| 6. Journal | Resumable execution + backup + rollback | Crash recovery at scale |
| 7. Observe | Metrics JSONL + Webhook + lock files | Operational visibility |

**Platform portability**: Only Layer 5 depends on OpenClaw. Layers 1-4 and 6-7 can be reused with any Agent platform.

### Prerequisites

- **Node.js >= 20** (native `fetch`, ESM)
- **OpenClaw** (installed, Gateway configured)
- **Feishu/Lark Enterprise** with two custom apps:
  - **Main App**: Message handling, Gateway webhook
  - **Directory App**: Data pull only, permissions: `contact:user.base:readonly` + `contact:department.base:readonly`

### Quick Start

```bash
# 1. Verify API connectivity
node feishu-sync.js --pull-only

# 2. Preview changes
node feishu-sync.js --mode full --dry-run

# 3. Full sync
node feishu-sync.js --mode full

# 4. Set up daily incremental (crontab)
0 2 * * * node ~/.openclaw/scripts/feishu-sync.js --mode incremental >> ~/.openclaw/logs/sync.log 2>&1
```

### CLI Flags

| Flag | Description |
|------|-------------|
| `--pull-only` | Fetch data only, don't write to OpenClaw |
| `--dry-run` | Preview changes without writing |
| `--mode full\|incremental` | Full sync or incremental diff (default: full) |
| `--dept <id>` | Sync specific department only (for piloting) |
| `--resume` | Resume from interrupted journal |
| `--cleanup` | Clear interrupted journal |
| `--use-snapshot <path>` | Skip API pull, use local snapshot file |
| `--verbose` | Detailed logging |
| `--notify-summary` | Send completion summary via Webhook |

### Design Decisions

- **Agent naming**: Uses Feishu `user_id` directly — no `emp-`/`mgr-` prefix. Promotion doesn't change agent_id; role info lives only in SOUL.md.
- **Snapshot + Diff**: Avoids full rebuild each run. Diff identifies 5 change types: added (onboard), removed (offboard), dept change (transfer), leader change, role change (promotion/demotion).
- **Two-phase write**: Agent dirs + SOUL.md first (idempotent), then atomic config update. Crash mid-write leaves Gateway routing intact.
- **Archive, don't delete**: Offboarded agents renamed to `archived-{id}-{date}`, retained 90 days for audit.

### Security

- Directory App and Main App are separate — minimum privilege
- `app_secret` never stored in script — read from `openclaw.json` or env vars
- Snapshots contain only `open_id`, `user_id`, department name — no sensitive data

### License

MIT
