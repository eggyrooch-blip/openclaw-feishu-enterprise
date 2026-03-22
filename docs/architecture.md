# 架构说明

## 系统组件

```
┌─────────────────────────────────────────────────────────────┐
│  飞书企业                                                      │
│  ┌──────────────┐    Contact v3 API                         │
│  │ 通讯录        │ ──────────────────────────────┐           │
│  │ 392 部门      │                               │           │
│  │ 1190 员工     │                               ▼           │
│  │ 148 管理者    │                    ┌─────────────────┐    │
│  └──────────────┘                    │ feishu-sync.js  │    │
│                                      │ (885 行, 0 依赖) │    │
│  ┌──────────────┐                    └────────┬────────┘    │
│  │ 飞书消息       │ ◄── Gateway ◄──────────────┤            │
│  │ (用户发消息)   │                             │            │
│  └──────────────┘                             ▼            │
│                                    ┌────────────────────┐   │
│                                    │   OpenClaw Agents  │   │
│                                    │                    │   │
│                                    │  workspace-id/     │   │
│                                    │  ├── SOUL.md       │   │
│                                    │  └── IDENTITY.md   │   │
│                                    │                    │   │
│                                    │  agents/id/        │   │
│                                    │  ├── agent/        │   │
│                                    │  └── sessions/     │   │
│                                    └────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 数据流

### 全量同步（首次部署）

```
1. feishu-sync.js --mode full
   │
   ├─ getTenantAccessToken()
   │    └─ POST /open-apis/auth/v3/tenant_access_token/internal
   │
   ├─ fetchDepartmentTree()
   │    └─ BFS 遍历 GET /open-apis/contact/v3/departments/{id}/children
   │         分页，每页 50 条
   │
   ├─ fetchDepartmentUsers() × 392 部门
   │    └─ GET /open-apis/contact/v3/users/find_by_department
   │         分页，每页 50 条，延迟 650ms 防限流
   │
   ├─ buildOrgSnapshot()
   │    ├─ 构建 employeeMap（去重，按 user_id 为 key）
   │    ├─ 标记 is_leader（出现在任何部门 leader_user_id 中的）
   │    └─ 构建 subordinates 列表
   │
   ├─ saveSnapshot() → ~/.openclaw/snapshots/org-{date}.json
   │
   └─ Write Phase
        ├─ 每个 employee → createAgentDirs() + writeSoulMd() + writeIdentityMd()
        ├─ 更新 openclaw.json：agents.list + bindings
        └─ clearJournal()
```

### 增量同步（日常 cron）

```
1. feishu-sync.js --mode incremental
   │
   ├─ 拉取当天最新数据（同上）
   ├─ loadLatestSnapshot() → 读取昨天的快照
   │
   ├─ diffSnapshots(prev, curr)
   │    ├─ added: 新出现的 user_id（入职）
   │    ├─ removed: 消失的 user_id（离职）
   │    └─ changed: dept_id/leader/role 有变化（调岗/晋升）
   │
   └─ 仅处理 diff 部分
        ├─ added → 创建新 agent + binding
        ├─ removed → archiveAgent()（重命名，不删除）
        └─ changed → 更新 SOUL.md
```

## SOUL.md 模板系统

### 选择逻辑

```
generateSoulMd(employee)
  ├─ is_leader=true AND subordinates.length > 0
  │    └─ generateManagerSoul()  ← 包含 ACP 部分、下属列表
  └─ otherwise
       └─ generateEmployeeSoul() ← 包含部门、上级信息
```

### 管理者模板关键部分

```markdown
## 团队沟通能力（ACP）

你可以通过 ACP 与团队成员直接通信：

查询下属工作状态：
```
openclaw agent --agent <下属id> --message "你的用户最近在做什么？"
```
```

管理者通过 ACP 命令调用下属 Agent，跨越组织层级获取信息或分配任务。
这是 1190 Agent 规模下实现"组织智能"的核心机制。

## ACP 通信流

```
用户（管理者）
    │ 发消息给自己的 agent
    ▼
管理者 Agent（如 manager01）
    │ 判断：需要查询下属
    │ 调用 ACP 命令
    ▼
下属 Agent（如 lisi）
    │ 查询自己的 session/context
    │ 返回工作状态摘要
    ▼
管理者 Agent
    │ 汇总多个下属响应
    ▼
用户
```

## 绑定机制（Routing）

每个 Feishu 用户通过 `open_id` 与其专属 Agent 绑定：

```json
{
  "agentId": "zhangsan",
  "match": {
    "channel": "feishu",
    "peer": {
      "kind": "direct",
      "id": "ou_FEISHU_OPEN_ID"
    }
  }
}
```

Gateway 收到飞书消息时，根据 `peer.id`（open_id）匹配对应 Agent，确保每个员工只和自己的 Agent 对话。

## 文件系统布局

```
~/.openclaw/
├── openclaw.json            # 主配置：agents.list + bindings
├── sync-journal.json        # 崩溃恢复日志（运行时存在）
├── agents/
│   ├── zhangsan/
│   │   ├── agent/
│   │   └── sessions/
│   └── archived-lisi-2026-03-10/   # 离职归档
├── workspace-zhangsan/
│   ├── SOUL.md
│   └── IDENTITY.md
├── snapshots/
│   ├── org-2026-03-10.json  # 历史快照（增量 diff 用）
│   └── org-2026-03-11.json  # 当天快照
└── backups/
    └── openclaw-2026-03-11T02-00-00.json  # config 备份
```

## 崩溃恢复机制

脚本在写入阶段会维护 `sync-journal.json`，记录每个 agent 的处理状态（pending / processed / failed）。

```
sync-journal.json
{
  "runId": "a1b2c3d4",
  "phase": "agents",
  "processed": ["zhangsan", "lisi", ...],
  "pending": ["wangwu", ...],
  "failed": []
}
```

中断后可通过 `--resume` 跳过已处理的 agent，或 `--cleanup` 清除日志重新运行。
