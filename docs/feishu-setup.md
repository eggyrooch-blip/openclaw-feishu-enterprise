# Feishu App Setup Guide / 飞书应用配置指南

[中文](#中文) | [English](#english)

---

<a id="中文"></a>

## 你需要几个飞书应用？

**最少一个就够。** 你已有的 OpenClaw 消息 Bot 加上通讯录权限就能跑。

| 方案 | 应用数 | 配置 | 适合场景 |
|------|--------|------|---------|
| **方案 A：复用消息 Bot** | 1 个 | 给已有 Bot 加 2 个只读权限 | 快速验证、小团队 |
| **方案 B：独立通讯录 App** | 2 个 | 新建 App，配到 `accounts.directory` | 生产环境、最小权限 |

脚本的凭证读取逻辑：`channels.feishu.accounts.directory` → 如果没配 → fallback 到 `channels.feishu`（主 Bot）。

**方案 A 最简单**——给你的消息 Bot 加 `contact:user.base:readonly` + `contact:department.base:readonly` 权限就行，不需要改任何配置。

**方案 B 更安全**——消息 Bot 不碰通讯录，通讯录 App 不碰消息。生产环境推荐。

### Step 1: 确认你的消息 Bot

打开 `~/.openclaw/openclaw.json`，找到 `channels.feishu` 段：

```json
{
  "channels": {
    "feishu": {
      "appId": "cli_xxxxxxxxxx",
      "appSecret": "xxxxxxxxxx",
      ...
    }
  }
}
```

如果这段已经存在且你能在飞书里跟 Bot 对话 → 消息 Bot 不需要动。

如果还没有 → 先按 [OpenClaw 官方文档](https://docs.openclaw.com/) 配好飞书 Gateway。

### Step 2: 新建通讯录 App

1. 进入 [飞书开放平台](https://open.feishu.cn/app) → 创建企业自建应用
2. **不需要开启"机器人"能力**（这不是消息 Bot）
3. 申请权限：
   - `contact:user.base:readonly` — 读取用户基本信息
   - `contact:department.base:readonly` — 读取部门信息
4. 在"通讯录授权范围"中，选择"全部成员"
5. 发布应用（等管理员审批通过）
6. 记录 `App ID` 和 `App Secret`

### Step 3: 配置到 openclaw.json

在已有的 `channels.feishu` 段里**追加** `accounts.directory`：

```json
{
  "channels": {
    "feishu": {
      "appId": "cli_你已有的消息Bot_ID",
      "appSecret": "你已有的消息Bot_Secret",
      "verifyToken": "...",
      "encryptKey": "...",

      "accounts": {
        "directory": {
          "appId": "cli_新建的通讯录App_ID",
          "appSecret": "新建的通讯录App_Secret"
        }
      }
    }
  }
}
```

**不要动已有的 `appId`/`appSecret`** — 那是你消息 Bot 的。只加 `accounts.directory` 部分。

### Step 4: 验证

```bash
node feishu-sync.js --pull-only --verbose
```

如果看到类似输出就成功了：

```
ℹ [info] Token obtained, expires in 7200s
ℹ [info] Department tree: N departments fetched
ℹ [info] Contact v3: N user records, N unique users
```

### 常见问题

**Q: 通讯录 App 需要管理员审批吗？**
需要。飞书企业版的自建应用发布后需要管理员在后台审批权限。只有 `readonly` 权限，风险很低，一般很快通过。

**Q: 我能用消息 Bot 直接拉通讯录吗？**
可以（feishu-sync.js 在 `accounts.directory` 缺失时会 fallback 到主 Bot），但不建议。消息 Bot 有通讯录权限意味着攻击面增大。

**Q: Lark（海外版）也能用吗？**
可以。在 `openclaw.json` 里设 `"domain": "lark"`，脚本会自动切换到 `open.larksuite.com` 域名。

---

<a id="english"></a>

## How many Feishu apps do you need?

**Just one is enough.** Add contact permissions to your existing OpenClaw Message Bot and you're good to go.

| Approach | Apps | Config | When to use |
|----------|------|--------|-------------|
| **A: Reuse Message Bot** | 1 | Add 2 read-only permissions to existing Bot | Quick start, small teams |
| **B: Separate Directory App** | 2 | Create new app, configure `accounts.directory` | Production, minimum privilege |

The script reads credentials from `channels.feishu.accounts.directory` first. If not configured, it falls back to `channels.feishu` (your main Bot).

**Approach A is simplest** — just add `contact:user.base:readonly` + `contact:department.base:readonly` to your existing Bot. No config changes needed.

### Step 1: Confirm your Message Bot

Check `~/.openclaw/openclaw.json` → `channels.feishu`. If it exists and your Bot responds in Feishu → done, don't touch it.

### Step 2: Create Directory App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) → Create enterprise app
2. **Don't enable "Bot" capability** — this isn't a message bot
3. Request permissions:
   - `contact:user.base:readonly`
   - `contact:department.base:readonly`
4. Set "Directory Authorization Scope" to all members
5. Publish and wait for admin approval
6. Note the `App ID` and `App Secret`

### Step 3: Add to openclaw.json

Add `accounts.directory` inside your existing `channels.feishu`:

```json
{
  "channels": {
    "feishu": {
      "...": "your existing bot config — don't change",
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

### Step 4: Verify

```bash
node feishu-sync.js --pull-only --verbose
```

### FAQ

**Q: Can I use the Message Bot to pull directory data?**
Yes (feishu-sync.js falls back to main bot if `accounts.directory` is missing), but not recommended — increases attack surface.

**Q: Does this work with Lark (international)?**
Yes. Set `"domain": "lark"` in your config — the script auto-switches to `open.larksuite.com`.
