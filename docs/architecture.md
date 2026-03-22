# Architecture

## Prerequisites — What You Already Have

This tool assumes you have a working OpenClaw + Feishu setup:

- **OpenClaw installed** with Gateway running
- **Feishu Bot configured** in `openclaw.json` → `channels.feishu` (your existing message-handling app)
- **A separate Feishu "Directory App"** for Contact v3 data pull (recommended: don't reuse the message bot — minimum privilege)

The Directory App needs two permissions:
- `contact:user.base:readonly`
- `contact:department.base:readonly`

Configure it in `openclaw.json`:

```json
{
  "channels": {
    "feishu": {
      "appId": "cli_YOUR_MAIN_APP_ID",
      "appSecret": "YOUR_MAIN_APP_SECRET",
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

`feishu-sync.js` reads `accounts.directory` first. If absent, it falls back to the main app credentials. **We recommend a separate app so your message bot never needs contact permissions.**

---

## System Overview

```
Feishu Enterprise
  ┌──────────────┐    Contact v3 API
  │ Directory    │ ──────────────────────────────┐
  │ N depts      │                               │
  │ N employees  │                               ▼
  │ N managers   │                    ┌─────────────────┐
  └──────────────┘                    │ feishu-sync.js  │
                                      │ (< 1500 lines)  │
  ┌──────────────┐                    └────────┬────────┘
  │ Feishu IM    │ ◄── Gateway ◄──────────────┤
  │ (user msgs)  │                             │
  └──────────────┘                             ▼
                                    ┌────────────────────┐
                                    │   OpenClaw Agents   │
                                    │                     │
                                    │  workspace-{id}/    │
                                    │  ├── SOUL.md        │
                                    │  └── IDENTITY.md    │
                                    │                     │
                                    │  agents/{id}/       │
                                    │  ├── agent/         │
                                    │  └── sessions/      │
                                    └────────────────────┘
```

**Key point**: feishu-sync.js does NOT replace your existing OpenClaw setup. It adds org-aware Agents on top of it. Your Gateway, main agent, and existing config remain untouched.

---

## Data Flow

### Full Sync (First Deployment)

```
feishu-sync.js --mode full
  │
  ├─ getTenantAccessToken()
  │    └─ POST /open-apis/auth/v3/tenant_access_token/internal
  │
  ├─ fetchDepartmentTree()
  │    └─ BFS traversal: GET /contact/v3/departments/{id}/children
  │         Paginated, 50 per page, 650ms delay between calls
  │
  ├─ fetchDepartmentUsers() × N departments
  │    └─ GET /contact/v3/users/find_by_department
  │         Paginated, 50 per page, 650ms delay
  │
  ├─ buildOrgSnapshot()
  │    ├─ Build employeeMap (dedup by user_id)
  │    ├─ Mark is_leader (appears in any dept's leader_user_id)
  │    └─ Build subordinates lists
  │
  ├─ saveSnapshot() → ~/.openclaw/snapshots/org-{date}.json
  │
  └─ Write Phase
       ├─ Per employee → createAgentDirs() + writeSoulMd() + writeIdentityMd()
       ├─ Update openclaw.json: agents.list + bindings
       └─ clearJournal()
```

### Incremental Sync (Daily Cron)

```
feishu-sync.js --mode incremental
  │
  ├─ Pull today's data (same as above)
  ├─ loadLatestSnapshot() → load yesterday's snapshot
  │
  ├─ diffSnapshots(prev, curr)
  │    ├─ added:   new user_id → onboarding
  │    ├─ removed: disappeared user_id → offboarding
  │    └─ changed: dept/leader/role changed → transfer/promotion
  │
  └─ Process diff only
       ├─ added → create agent + binding
       ├─ removed → archiveAgent() (rename, don't delete)
       └─ changed → regenerate SOUL.md
```

---

## SOUL.md Template System

### Selection Logic

```
generateSoulMd(employee)
  ├─ is_leader=true AND subordinates.length > 0
  │    └─ generateManagerSoul()  ← includes team list + management guidance
  └─ otherwise
       └─ generateEmployeeSoul() ← includes department + manager info
```

### Manager Template (key sections)

```markdown
# {agentId}

## You Are
You are **{agentId}**, manager of {deptName}.

## Your Team
Direct reports ({count}):
  - employee1
  - employee2
  ...

## Management Principles
- Assess which team member is best suited for incoming tasks
- Track task progress, consolidate results
- Support team members when they encounter difficulties
```

### Employee Template

```markdown
# {agentId}

## You Are
You are **{agentId}**, a team member in {deptName}.

## Org Context
- Your manager is **{leaderAgentId}**
- Report results to your manager when tasks complete
- Escalate issues beyond your scope
```

---

## Binding Mechanism (Routing)

Each Feishu user is bound to their Agent via `open_id`:

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

When Gateway receives a Feishu message, it looks up `peer.id` (open_id) in the bindings array to find the corresponding Agent. Each employee talks only to their own Agent.

**Important**: Bindings don't need `accountId`. Only `channel` + `peer.id` matter. Adding extra fields may cause matching failures.

---

## File System Layout

```
~/.openclaw/
├── openclaw.json            # Main config: agents.list + bindings
├── sync-journal.json        # Crash recovery log (exists during sync)
├── agents/
│   ├── zhangsan/
│   │   ├── agent/
│   │   └── sessions/
│   └── archived-lisi-2026-03-10/   # Offboarded (renamed, not deleted)
├── workspace-zhangsan/
│   ├── SOUL.md              # ← Agent identity lives HERE, not in agents/
│   └── IDENTITY.md
├── snapshots/
│   ├── org-2026-03-10.json  # Previous snapshot (for incremental diff)
│   └── org-2026-03-11.json  # Today's snapshot
└── backups/
    └── openclaw-2026-03-11T02-00-00.json
```

**Common gotcha**: SOUL.md is at `workspace-{id}/SOUL.md`, NOT `agents/{id}/SOUL.md`. These directories serve different purposes:
- `agents/{id}/` — runtime data (sessions, agent internals)
- `workspace-{id}/` — identity config (SOUL.md, IDENTITY.md)

---

## Crash Recovery

The script maintains `sync-journal.json` during the write phase, tracking each agent's status:

```json
{
  "runId": "a1b2c3d4",
  "phase": "agents",
  "processed": ["zhangsan", "lisi"],
  "pending": ["wangwu"],
  "failed": []
}
```

- **Every processed agent is flushed to disk immediately** — survives kill -9
- `--resume` skips already-processed agents, continues from where it left off
- `--cleanup` clears the journal for a fresh start

### Two-Phase Write (Atomicity)

```
Phase 1: Write agent dirs + SOUL.md (idempotent, can re-run)
Phase 2: Atomic update of openclaw.json (agents.list + bindings)
```

If the process crashes during Phase 1: some extra agent dirs may exist (harmless), but `openclaw.json` hasn't changed — Gateway routing is consistent.

If Phase 2 fails: `backupConfig()` ran before Phase 1 — restore from backup.

---

## Reserved Agents

`feishu-sync.js` will **never** create, remove, or modify these agents:
- `main` — management-only agent
- `gatekeeper` — fallback for unbound sessions

If `channels.feishu.defaultAgent` is empty or set to `main`, the script auto-corrects it to `gatekeeper`. This prevents unbound sessions from accidentally routing to the management agent.

---

## Pitfalls & Tips

| Issue | Solution |
|-------|----------|
| `loadLatestSnapshot` reads partial dept snapshot | Filter: `!f.includes('-dept-')` |
| SSH session can't find `node` (macOS) | `export PATH=/opt/homebrew/bin:$PATH` before cron |
| `openclaw agents add` is interactive TUI | Use `mkdir` directly instead |
| SOUL.md path confusion | It's `workspace-{id}/`, not `agents/{id}/` |
| Binding with extra `accountId` field | Remove it — only `channel` + `peer.id` needed |
| Long API pull (15-20 min) gets ECONNRESET | `Connection: close` header + AbortController timeout |
| Token expires mid-pull | Cache with 5-min early refresh (`expire - 300`) |
