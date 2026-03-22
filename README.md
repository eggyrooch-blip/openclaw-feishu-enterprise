# openclaw-feishu-enterprise

[中文](#中文) | [English](#english)

---

<a id="中文"></a>

## 飞书通讯录 → OpenClaw 千人 Agent 同步方案

> 一个脚本，把飞书通讯录变成千人规模的 AI Agent 集群。每个员工一个专属 Agent，自动感知组织关系，入离职全自动。

### 这是什么

`feishu-sync.js` 从飞书通讯录读取组织架构，在 OpenClaw 中批量创建对应的 AI Agent，并为每个 Agent 注入带有组织关系的 SOUL.md。部署完成后，每位员工在飞书里发消息给企业机器人，就会路由到自己专属的 AI。

这个方案诞生于一个实际需求：用一个飞书 Bot（而不是 N 个）支撑全公司 AI 部署，同时让每个 Agent 知道自己是谁、属于哪个部门、上级是谁。

### 核心能力

- **飞书通讯录 → Agent 全量同步**：BFS 遍历部门树，分页拉取所有员工，去重后批量写入
- **管理者/员工双模板 SOUL.md**：管理者包含下属列表和团队管理指引，员工包含部门和上级信息
- **入职/离职/调岗自动处理**：每日增量 Diff，新增创建、离职归档（不删除）、调岗更新 SOUL.md
- **崩溃恢复**：Journal 文件记录进度，中断后 `--resume` 续跑
- **零外部依赖**：纯 Node.js ESM，只用 `node:fs`、`node:path`、`node:os`、`node:util`、`node:crypto`

### 架构

```
飞书通讯录 (Contact v3 API)
  │
  │  BFS 遍历部门树 + 分页拉取员工
  ▼
feishu-sync.js (7 层架构)
  │
  ├─ buildOrgSnapshot()   构建组织快照，标记管理者，计算下属列表
  ├─ diffSnapshots()      和昨天的快照对比，识别五种变更
  ├─ generateSoulMd()     按角色生成 SOUL.md（管理者/员工双模板）
  ├─ createAgentDirs()    写 workspace + agents 目录
  └─ updateConfig()       更新 openclaw.json（agents.list + bindings）
  │
  ▼
OpenClaw Gateway → 按 open_id 路由到对应 Agent → 飞书回复
```

### 7 层设计

| 层 | 职责 | 为什么需要 |
|----|------|-----------|
| 1. Config | 读 openclaw.json，支持多 channel | 多环境适配 |
| 2. Auth | tenant_access_token 缓存 + 自动刷新 | 批量请求不中断 |
| 3. Pull | 部门树 BFS + 员工分页（Contact v3） | 从通讯录获取组织数据 |
| 4. Diff | 今日快照 vs 昨日快照 → 五种变更 | 增量处理，不全量重建 |
| 5. Write | 创建/归档 Agent + SOUL.md + Binding | 唯一依赖 OpenClaw 的层 |
| 6. Journal | 断点续跑 + 备份 + 回滚 | 千人写入的崩溃恢复 |
| 7. Observe | metrics JSONL + Webhook + 锁文件 | 运维可见性 |

**平台无关性**：只有 Layer 5 依赖 OpenClaw。Layer 1-4 和 6-7 可以直接复用到其他 Agent 平台。

### 前置条件

- **Node.js >= 20**（使用原生 `fetch`、ESM）
- **OpenClaw**（已安装并完成 Gateway 初始配置）
- **飞书企业版**，两个自建应用：
  - **主 App**：消息收发，配置 Gateway webhook
  - **通讯录 App**：数据拉取，权限 `contact:user.base:readonly` + `contact:department.base:readonly`

### 快速开始

**1. 配置飞书应用**

参考 `examples/openclaw.json.example`，在 `openclaw.json` 中配置 `channels.feishu.accounts.directory`。

**2. 验证连通性**

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

**5. 配置每日增量**

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

`feishu-sync.js` reads your organization structure from Feishu Contact v3 API, batch-creates corresponding AI Agents in OpenClaw, and injects each Agent with a personalized SOUL.md containing their department, manager, and direct reports. After deployment, every employee messages one Feishu bot, and the Gateway routes each message to their personal Agent.

### Key Features

- **Full org sync**: BFS department tree traversal, paginated user fetch, dedup by user_id
- **Dual SOUL.md templates**: Manager template (with subordinate list + team guidance) vs Employee template (with department + manager info)
- **Automated lifecycle**: Daily incremental diff handles onboarding, offboarding, transfers, and promotions — zero manual work
- **Crash recovery**: Journal-based resume — tracks per-agent progress, survives kill -9
- **Zero dependencies**: Pure Node.js ESM — only uses `node:fs`, `node:path`, `node:os`, `node:util`, `node:crypto`

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
