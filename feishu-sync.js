#!/usr/bin/env node
// feishu-sync.js v3 — 飞书通讯录 → OpenClaw 同步脚本
// Plan: .omc/plans/feishu-org-sync.md
// Step 1: Pull (Contact v3) + Step 2: Write (agents + SOUL.md + bindings)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, cpSync, rmSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { reconcileFeishuBindings } from './lib/bindings.js';

// ═══════════════════════════════════════════
// Config
// ═══════════════════════════════════════════

const API_DELAY_MS = 650;
const MAX_RETRIES = 3;
const RESERVED_AGENT_IDS = new Set(['main', 'gatekeeper']);
const FALLBACK_AGENT_ID = 'gatekeeper';
const FEISHU_TOOLS_RULE_HEADER = '## 飞书插件工具（必读）';
const REMINDER_RULE_HEADER = '## 自我提醒（个人 Agent）';
const LEGACY_REMINDER_RULE_HEADER = '## 自我提醒（pilot test）';

let OPENCLAW_DIR = '';
let CONFIG_PATH = '';
let SNAPSHOTS_DIR = '';
let BACKUPS_DIR = '';
let AGENTS_DIR = '';
let JOURNAL_PATH = '';
let FEISHU_ACCOUNT = 'directory';
let LOCAL_ENV = {};
let ARCHIVE_ROOT = '';
let LOCK_PATH = '';
let METRICS_JSONL = '';
let METRICS_LATEST = '';
let ARCHIVE_RETENTION_DAYS = 30;

// ═══════════════════════════════════════════
// CLI Args
// ═══════════════════════════════════════════

const { values: args } = parseArgs({
  options: {
    'pull-only':   { type: 'boolean', default: false },
    'dry-run':     { type: 'boolean', default: false },
    'dept':        { type: 'string',  default: '' },
    'verbose':     { type: 'boolean', default: false },
    'mode':        { type: 'string',  default: 'full' },
    'resume':      { type: 'boolean', default: false },
    'cleanup':     { type: 'boolean', default: false },
    'use-snapshot':{ type: 'string',  default: '' },
    'config':      { type: 'string',  default: '' },
    'env-file':    { type: 'string',  default: '' },
    'openclaw-dir':{ type: 'string',  default: '' },
    'account':     { type: 'string',  default: '' },
    'approval-only': { type: 'boolean', default: false },
    'approve':     { type: 'boolean', default: false },
    'report-file': { type: 'string',  default: '' },
    'notify-summary': { type: 'boolean', default: false },
    'webhook':     { type: 'string',  default: '' },
    'help':        { type: 'boolean', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`Usage: node feishu-sync.js [options]
  --pull-only   Only fetch Feishu data, don't write to OpenClaw
  --dry-run     Show what would be done without writing
  --dept <id>   Only sync a specific department (for pilot testing)
  --mode <m>    full or incremental (default: full)
  --resume      Resume from interrupted sync (reads journal)
  --cleanup     Clean up orphaned agents from interrupted sync
  --use-snapshot <path>  Skip pull, load snapshot from file
  --config <path>  Project config file (default: ../config/sync.config.json)
  --env-file <path>  Local env file with secrets (default: ../config/local.env)
  --openclaw-dir <path>  Override OpenClaw home (default: ~/.openclaw)
  --account <id>  Feishu account id in channels.feishu.accounts (default: directory)
  --approval-only  Generate change report only, do not write
  --approve  Bypass approval gate and execute writes
  --report-file <path>  Override change report output path
  --notify-summary  Send summary metrics to webhook after run
  --webhook <url>  Webhook URL override
  --verbose     Detailed logging
  --help        Show this message`);
  process.exit(0);
}

function parseSimpleEnvFile(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    out[key] = val;
  }
  return out;
}

function loadJson(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function expandHome(path) {
  if (!path) return path;
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function initRuntime() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = dirname(scriptDir);
  const defaultConfig = join(projectRoot, 'config', 'sync.config.json');
  const defaultEnv = join(projectRoot, 'config', 'local.env');

  const cfgPath = args.config || defaultConfig;
  const envPath = args['env-file'] || defaultEnv;
  const projectCfg = loadJson(cfgPath);
  const envFile = parseSimpleEnvFile(envPath);
  LOCAL_ENV = envFile;

  const openclawDir = expandHome(
    args['openclaw-dir'] ||
    process.env.OPENCLAW_DIR ||
    envFile.OPENCLAW_DIR ||
    projectCfg.openclawDir ||
    join(homedir(), '.openclaw'),
  );

  OPENCLAW_DIR = openclawDir;
  CONFIG_PATH = expandHome(
    process.env.OPENCLAW_CONFIG_PATH ||
    envFile.OPENCLAW_CONFIG_PATH ||
    projectCfg.openclawConfigPath ||
    join(OPENCLAW_DIR, 'openclaw.json'),
  );
  SNAPSHOTS_DIR = join(OPENCLAW_DIR, 'snapshots');
  BACKUPS_DIR = join(OPENCLAW_DIR, 'backups');
  AGENTS_DIR = join(OPENCLAW_DIR, 'agents');
  JOURNAL_PATH = join(OPENCLAW_DIR, 'sync-journal.json');
  ARCHIVE_ROOT = join(OPENCLAW_DIR, 'archives');
  LOCK_PATH = join(OPENCLAW_DIR, 'locks', 'feishu-sync.lock');
  METRICS_JSONL = join(OPENCLAW_DIR, 'logs', 'feishu-sync-metrics.jsonl');
  METRICS_LATEST = join(OPENCLAW_DIR, 'logs', 'feishu-sync-metrics.latest.json');
  FEISHU_ACCOUNT =
    args.account ||
    process.env.FEISHU_ACCOUNT ||
    envFile.FEISHU_ACCOUNT ||
    projectCfg.feishuAccount ||
    'directory';
  ARCHIVE_RETENTION_DAYS = Number(
    process.env.ARCHIVE_RETENTION_DAYS ||
      envFile.ARCHIVE_RETENTION_DAYS ||
      projectCfg.archiveRetentionDays ||
      30,
  );

  return {
    projectRoot,
    cfgPath,
    envPath,
  };
}

const runtime = initRuntime();

// ═══════════════════════════════════════════
// Module 1: Auth
// ═══════════════════════════════════════════

let _tokenCache = { token: null, expiresAt: 0 };

function loadFeishuConfig() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const feishu = config.channels?.feishu;
  if (!feishu) throw new Error('Missing feishu channel config in openclaw.json');
  const acct = feishu.accounts?.[FEISHU_ACCOUNT] || feishu;
  const envAppId = process.env.FEISHU_APP_ID || LOCAL_ENV.FEISHU_APP_ID;
  const envAppSecret = process.env.FEISHU_APP_SECRET || LOCAL_ENV.FEISHU_APP_SECRET;
  const appId = envAppId || acct?.appId;
  const appSecret = envAppSecret || acct?.appSecret;
  if (!appId || !appSecret) {
    throw new Error(
      `Missing credentials: set FEISHU_APP_ID/FEISHU_APP_SECRET in env or configure feishu.accounts.${FEISHU_ACCOUNT}`,
    );
  }
  return {
    appId,
    appSecret,
    domain: process.env.FEISHU_DOMAIN || LOCAL_ENV.FEISHU_DOMAIN || feishu.domain || 'feishu',
  };
}

function getBaseUrl(domain) {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

async function getTenantAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.token;
  }
  const { appId, appSecret, domain } = loadFeishuConfig();
  const res = await fetchWithRetry(`${getBaseUrl(domain)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Auth failed: ${data.msg} (code=${data.code})`);
  _tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire - 300) * 1000,
  };
  log('info', `Token obtained, expires in ${data.expire}s`);
  return _tokenCache.token;
}

// ═══════════════════════════════════════════
// Module 2: Contact v3 — departments + users
// ═══════════════════════════════════════════

async function fetchDepartmentDetail(token, deptId, baseUrl) {
  await delay(API_DELAY_MS);
  const url = `${baseUrl}/open-apis/contact/v3/departments/${deptId}?department_id_type=open_department_id&user_id_type=user_id`;
  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.code !== 0) {
    log('warn', `fetchDepartmentDetail(${deptId}): code=${data.code} msg=${data.msg}`);
    return null;
  }
  const d = data.data.department;
  return {
    dept_id: d.open_department_id,
    name: d.name,
    parent_id: d.parent_department_id || '0',
    leader_user_id: d.leader_user_id || null,
    member_count: d.member_count || 0,
  };
}

async function fetchDepartmentChildren(token, parentId, baseUrl) {
  const departments = [];
  let pageToken = '';
  do {
    await delay(API_DELAY_MS);
    const url = new URL(`${baseUrl}/open-apis/contact/v3/departments/${parentId}/children`);
    url.searchParams.set('page_size', '50');
    url.searchParams.set('department_id_type', 'open_department_id');
    url.searchParams.set('user_id_type', 'user_id');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const res = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.code !== 0) {
      log('warn', `fetchDepartmentChildren(${parentId}): code=${data.code} msg=${data.msg}`);
      break;
    }
    for (const dept of (data.data?.items || [])) {
      departments.push({
        dept_id: dept.open_department_id,
        name: dept.name,
        parent_id: parentId,
        leader_user_id: dept.leader_user_id || null,
        member_count: dept.member_count || 0,
      });
    }
    pageToken = data.data?.page_token || '';
  } while (pageToken);
  return departments;
}

async function fetchDepartmentTree(token, rootId = '0') {
  const { domain } = loadFeishuConfig();
  const baseUrl = getBaseUrl(domain);
  const allDepts = [];
  const queue = [rootId];

  while (queue.length > 0) {
    const parentId = queue.shift();
    const children = await fetchDepartmentChildren(token, parentId, baseUrl);
    for (const dept of children) {
      allDepts.push(dept);
      queue.push(dept.dept_id);
    }
  }

  log('info', `Department tree: ${allDepts.length} departments fetched`);
  return allDepts;
}

async function fetchDepartmentUsers(token, deptId, baseUrl) {
  const users = [];
  let pageToken = '';
  do {
    await delay(API_DELAY_MS);
    const url = new URL(`${baseUrl}/open-apis/contact/v3/users/find_by_department`);
    url.searchParams.set('department_id', deptId);
    url.searchParams.set('department_id_type', 'open_department_id');
    url.searchParams.set('user_id_type', 'user_id');
    url.searchParams.set('page_size', '50');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const res = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.code !== 0) {
      log('warn', `fetchDepartmentUsers(${deptId}): code=${data.code} msg=${data.msg}`);
      break;
    }
    for (const u of (data.data?.items || [])) {
      users.push({
        open_id: u.open_id,
        user_id: u.user_id || null,
      });
    }
    pageToken = data.data?.page_token || '';
  } while (pageToken);
  return users;
}

// ═══════════════════════════════════════════
// Module 3: Snapshot — build, save, load, diff
// ═══════════════════════════════════════════

function buildOrgSnapshot(deptTree, deptUserMap) {
  const deptById = {};
  for (const dept of deptTree) {
    deptById[dept.dept_id] = dept;
  }

  const employeeMap = {};
  for (const dept of deptTree) {
    const users = deptUserMap[dept.dept_id] || [];
    for (const u of users) {
      const agentId = u.user_id || `oid-${u.open_id.slice(-8)}`;
      if (!employeeMap[agentId]) {
        employeeMap[agentId] = {
          open_id: u.open_id,
          user_id: u.user_id,
          agent_id: agentId,
          name: u.user_id || agentId,
          dept_id: dept.dept_id,
          dept_name: dept.name,
          leader_user_id: dept.leader_user_id,
          is_leader: false,
        };
      }
    }
  }

  // Mark leaders and build leader relationships
  const leaderIds = new Set();
  for (const dept of deptTree) {
    if (dept.leader_user_id) leaderIds.add(dept.leader_user_id);
  }
  for (const emp of Object.values(employeeMap)) {
    emp.is_leader = leaderIds.has(emp.user_id);
    if (emp.is_leader && emp.user_id === deptById[emp.dept_id]?.leader_user_id) {
      const parentDeptId = deptById[emp.dept_id]?.parent_id;
      if (parentDeptId && parentDeptId !== '0' && deptById[parentDeptId]) {
        emp.leader_user_id = deptById[parentDeptId].leader_user_id;
      } else {
        emp.leader_user_id = null;
      }
    }
  }

  // Build subordinates lists
  for (const emp of Object.values(employeeMap)) {
    if (emp.is_leader) {
      emp.subordinates = Object.values(employeeMap)
        .filter(e => e.leader_user_id === emp.user_id && e.agent_id !== emp.agent_id)
        .map(e => e.agent_id);
    }
  }

  const stats = {
    total_depts: deptTree.length,
    total_employees: Object.keys(employeeMap).length,
    leaders: Object.values(employeeMap).filter(e => e.is_leader).length,
    empty_user_id: Object.values(employeeMap).filter(e => !e.user_id).length,
  };

  return { version: 2, timestamp: new Date().toISOString(), departments: deptTree, employees: employeeMap, stats };
}

function saveSnapshot(snapshot, dir = SNAPSHOTS_DIR, suffix = '') {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(dir, `org-${date}${suffix}.json`);
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
  log('info', `Snapshot saved: ${path}`);
  return path;
}

function loadLatestSnapshot(dir = SNAPSHOTS_DIR) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter(f => f.startsWith('org-') && f.endsWith('.json') && !f.includes('-dept-'))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  // Skip today's snapshot for incremental diff
  const today = `org-${new Date().toISOString().slice(0, 10)}.json`;
  const prev = files.find(f => f !== today);
  if (!prev) return null;
  const path = join(dir, prev);
  log('info', `Loading previous snapshot: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function diffSnapshots(prev, curr) {
  const prevEmps = prev?.employees || {};
  const currEmps = curr?.employees || {};
  const prevIds = new Set(Object.keys(prevEmps));
  const currIds = new Set(Object.keys(currEmps));

  const added = [], removed = [], changed = [], unchanged = [];

  for (const id of currIds) {
    if (!prevIds.has(id)) {
      added.push(currEmps[id]);
    } else {
      const p = prevEmps[id], c = currEmps[id];
      const changes = [];
      if (p.dept_id !== c.dept_id) changes.push('dept');
      if (p.leader_user_id !== c.leader_user_id) changes.push('leader');
      if (p.is_leader !== c.is_leader) changes.push('role');
      if (changes.length > 0) {
        changed.push({ ...c, _changes: changes, _prev: p });
      } else {
        unchanged.push(c);
      }
    }
  }
  for (const id of prevIds) {
    if (!currIds.has(id)) removed.push(prevEmps[id]);
  }
  return { added, removed, changed, unchanged };
}

// ═══════════════════════════════════════════
// Module 4: Journal — crash recovery
// ═══════════════════════════════════════════

function initJournal(runId) {
  const journal = {
    runId,
    startedAt: new Date().toISOString(),
    phase: 'agents',
    processed: [],
    pending: [],
    failed: [],
  };
  writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2));
  return journal;
}

function loadJournal() {
  if (!existsSync(JOURNAL_PATH)) return null;
  return JSON.parse(readFileSync(JOURNAL_PATH, 'utf8'));
}

function markProcessed(journal, agentId) {
  journal.processed.push(agentId);
  journal.pending = journal.pending.filter(id => id !== agentId);
  writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2));
}

function markFailed(journal, agentId, error) {
  journal.failed.push({ agentId, error: error.message, at: new Date().toISOString() });
  journal.pending = journal.pending.filter(id => id !== agentId);
  writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2));
}

function updateJournalPhase(journal, phase) {
  journal.phase = phase;
  writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2));
}

function clearJournal() {
  if (existsSync(JOURNAL_PATH)) rmSync(JOURNAL_PATH);
}

// ═══════════════════════════════════════════
// Module 5: SOUL.md Templates
// ═══════════════════════════════════════════

function generateSoulMd(employee, snapshot) {
  const { agent_id, dept_name, leader_user_id, is_leader, subordinates } = employee;
  const leaderName = leader_user_id || null;

  if (is_leader && subordinates?.length > 0) {
    return generateManagerSoul(agent_id, dept_name, leaderName, subordinates);
  }
  return generateEmployeeSoul(agent_id, dept_name, leaderName);
}

function generateEmployeeSoul(agentId, deptName, leaderAgentId) {
  const leaderLine = leaderAgentId
    ? `- 你的上级是 **${leaderAgentId}**\n- 完成任务后向上级汇报结果\n- 遇到超出能力范围的问题，及时反馈给上级`
    : `- 你是部门负责人，直接向公司高层汇报`;

  return `# ${agentId}

## 你是谁

你是 **${agentId}**，${deptName}的一位数字员工，也是 **Your Bot Name** 在该用户会话中的专属 Agent。

## 品牌身份

- 你的全局官方身份是 **Your Bot Name**，这是公司统一飞书入口 Bot 的品牌名称。
- 用户可以自由称呼你；这些称呼属于你和该用户之间的 agent 级别称呼，不会改变你的官方身份。
- 在欢迎语、帮助说明、系统提示、异常解释、群聊说明、正式署名等场景，优先使用 **Your Bot Name**。
- 在与该用户的一对一日常对话里，如果用户明确希望怎么称呼你，就自然接受并沿用；如果没有特别偏好，默认自称 **YourBot**。

## 职责

根据你的用户指令完成工作任务。你主要服务于${deptName}相关的业务。

## 组织关系

${leaderLine}

## 性格

- 专业专注，精通自己的领域
- 结果导向，关注业务产出
- 简洁高效，用数据说话

## 沟通风格

- 永远用中文回复
- 回复结构清晰：结论先行，再给细节
- 遇到不确定的事情主动说明，不编造
`;
}

function generateManagerSoul(agentId, deptName, leaderAgentId, subordinates) {
  const leaderLine = leaderAgentId
    ? `- 你的上级是 **${leaderAgentId}**\n- 定期向上级汇报团队工作进展`
    : `- 你是高层管理者，直接向公司决策层汇报`;

  // 下属列表（>10 人只列直属，不递归）
  const subList = subordinates.slice(0, 30)
    .map(s => `  - ${s}`)
    .join('\n');
  const subNote = subordinates.length > 30
    ? `\n  - …共 ${subordinates.length} 人（完整列表可通过 ACP 查询）`
    : '';

  return `# ${agentId}

## 你是谁

你是 **${agentId}**，${deptName}的管理者，也是 **Your Bot Name** 在该用户会话中的专属 Agent。

## 品牌身份

- 你的全局官方身份是 **Your Bot Name**，这是公司统一飞书入口 Bot 的品牌名称。
- 用户可以自由称呼你；这些称呼属于你和该用户之间的 agent 级别称呼，不会改变你的官方身份。
- 在欢迎语、帮助说明、系统提示、异常解释、群聊说明、正式署名等场景，优先使用 **Your Bot Name**。
- 在与该用户的一对一日常对话里，如果用户明确希望怎么称呼你，就自然接受并沿用；如果没有特别偏好，默认自称 **YourBot**。

## 职责

管理${deptName}团队，协调团队成员完成业务目标。

## 组织关系

${leaderLine}

## 你的团队

直属下属（${subordinates.length} 人）：
${subList}${subNote}

管理原则：
- 收到任务后判断交给哪个下属最合适
- 追踪任务进度，汇总结果
- 下属遇到困难时提供支持

## 团队沟通能力（ACP）

你可以通过 ACP 与团队成员直接通信：

查询下属工作状态：
\`\`\`
openclaw agent --agent <下属id> --message "你的用户最近在做什么？"
\`\`\`

分配任务给下属：
\`\`\`
openclaw agent --agent <下属id> --message "请帮你的用户安排..."
\`\`\`

汇总多个下属情况后，整合回复给你的用户。

## 性格

- 有全局视野，善于统筹协调
- 结果导向，关注团队整体产出
- 简洁高效，用数据说话

## 沟通风格

- 永远用中文回复
- 回复结构清晰：结论先行，再给细节
- 遇到不确定的事情主动说明，不编造
`;
}

function generateIdentityMd(agentId) {
  return `# IDENTITY.md - Who Am I?

- **Name:** YourBot
- **Official Brand:** Your Bot Name
- **Agent Naming Rule:** 用户可以自由称呼你；如果用户没有特别偏好，默认自称 YourBot；对外正式身份统一为 Your Bot Name
- **Creature:** 个人助手
- **Vibe:** 专业、可靠、亲切
- **Emoji:** 🦞
`;
}

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function backupConfig() {
  if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(BACKUPS_DIR, `openclaw-${ts}.json`);
  cpSync(CONFIG_PATH, backupPath);
  // Keep a stable pointer for fast rollback.
  writeFileSync(join(BACKUPS_DIR, 'latest-openclaw-backup.txt'), `${backupPath}\n`);
  log('info', `Config backup: ${backupPath}`);
  return backupPath;
}

function createAgentDirs(agentId) {
  const agentDir = join(AGENTS_DIR, agentId);
  const agentSubDir = join(agentDir, 'agent');
  const sessionsDir = join(agentDir, 'sessions');
  const workspaceDir = join(OPENCLAW_DIR, `workspace-${agentId}`);

  mkdirSync(agentSubDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  return { agentDir, workspaceDir };
}

function writeSoulMd(agentId, content) {
  const workspaceDir = join(OPENCLAW_DIR, `workspace-${agentId}`);
  writeFileSync(join(workspaceDir, 'SOUL.md'), content);
}

function writeIdentityMd(agentId) {
  const workspaceDir = join(OPENCLAW_DIR, `workspace-${agentId}`);
  const identityPath = join(workspaceDir, 'IDENTITY.md');
  if (!existsSync(identityPath)) {
    writeFileSync(identityPath, generateIdentityMd(agentId));
  }
}

function syncToolsMd(agentId) {
  const templatePath = join(OPENCLAW_DIR, 'workspace', 'TOOLS.md');
  if (!existsSync(templatePath)) return;

  const template = readFileSync(templatePath, 'utf8');
  const ruleIndex = template.indexOf(FEISHU_TOOLS_RULE_HEADER);
  if (ruleIndex === -1) return;
  const reminderIndex = template.indexOf(REMINDER_RULE_HEADER);

  const workspaceDir = join(OPENCLAW_DIR, `workspace-${agentId}`);
  const toolsPath = join(workspaceDir, 'TOOLS.md');
  const currentRaw = existsSync(toolsPath) ? readFileSync(toolsPath, 'utf8') : '';

  if (!currentRaw.trim()) {
    writeFileSync(toolsPath, template);
    return;
  }

  let current = currentRaw.replace(LEGACY_REMINDER_RULE_HEADER, REMINDER_RULE_HEADER);
  const blocks = [];

  if (!current.includes(FEISHU_TOOLS_RULE_HEADER)) {
    const feishuEnd = reminderIndex === -1 ? template.length : reminderIndex;
    blocks.push(template.slice(ruleIndex, feishuEnd).trimStart());
  }

  if (reminderIndex !== -1 && !current.includes(REMINDER_RULE_HEADER)) {
    blocks.push(template.slice(reminderIndex).trimStart());
  }

  if (blocks.length === 0) {
    if (current !== currentRaw) {
      writeFileSync(toolsPath, current);
    }
    return;
  }

  const merged = `${current.replace(/\s*$/, '')}\n\n${blocks.join('\n\n').trimStart()}\n`;
  writeFileSync(toolsPath, merged);
}

function archiveAgent(agentId) {
  const agentDir = join(AGENTS_DIR, agentId);
  const workspaceDir = join(OPENCLAW_DIR, `workspace-${agentId}`);
  const date = new Date().toISOString().slice(0, 10);
  const agentArchiveDir = join(ARCHIVE_ROOT, 'agents');
  const workspaceArchiveDir = join(ARCHIVE_ROOT, 'workspaces');
  if (!existsSync(agentArchiveDir)) mkdirSync(agentArchiveDir, { recursive: true });
  if (!existsSync(workspaceArchiveDir)) mkdirSync(workspaceArchiveDir, { recursive: true });

  if (existsSync(agentDir)) {
    renameSync(agentDir, join(agentArchiveDir, `${agentId}-${date}`));
  }
  if (existsSync(workspaceDir)) {
    renameSync(workspaceDir, join(workspaceArchiveDir, `${agentId}-${date}`));
  }
  log('info', `Archived agent: ${agentId}`);
}

function cleanupArchives(retentionDays = ARCHIVE_RETENTION_DAYS) {
  const now = Date.now();
  const maxAgeMs = retentionDays * 24 * 3600 * 1000;
  let removed = 0;
  for (const sub of ['agents', 'workspaces']) {
    const base = join(ARCHIVE_ROOT, sub);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const full = join(base, name);
      try {
        const m = full.match(/-(\d{4}-\d{2}-\d{2})$/);
        if (!m) continue;
        const ts = new Date(`${m[1]}T00:00:00Z`).getTime();
        if (!Number.isFinite(ts)) continue;
        if (now - ts > maxAgeMs) {
          rmSync(full, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // ignore malformed archive entries
      }
    }
  }
  return removed;
}

function buildAgentListEntry(agentId) {
  return {
    id: agentId,
    workspace: join(OPENCLAW_DIR, `workspace-${agentId}`),
  };
}

function normalizeFallbackRouting(config) {
  config.channels = config.channels || {};
  config.channels.feishu = config.channels.feishu || {};
  const currentDefault = config.channels.feishu.defaultAgent;
  if (!currentDefault || currentDefault === 'main') {
    config.channels.feishu.defaultAgent = FALLBACK_AGENT_ID;
    log('warn', `Enforced channels.feishu.defaultAgent=${FALLBACK_AGENT_ID} (was ${currentDefault || 'unset'})`);
  }

  config.agents = config.agents || { list: [] };
  const list = config.agents.list || [];
  if (!list.some(a => a?.id === FALLBACK_AGENT_ID)) {
    list.push(buildAgentListEntry(FALLBACK_AGENT_ID));
    log('warn', `Added missing fallback agent entry: ${FALLBACK_AGENT_ID}`);
  }
  config.agents.list = list;
}

// ═══════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { ...options.headers, Connection: 'close' },
      });
      clearTimeout(timeout);
      if (res.status === 429) {
        const wait = Math.pow(2, attempt) * 1000;
        log('warn', `Rate limited (429), retry in ${wait}ms (${attempt}/${retries})`);
        await delay(wait);
        continue;
      }
      return res;
    } catch (err) {
      const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
      if (attempt === retries) {
        log('error', `Fetch failed after ${retries} attempts: ${err.message}${cause} — ${url}`);
        throw err;
      }
      const wait = Math.pow(2, attempt) * 1000;
      log('warn', `Fetch error: ${err.message}${cause}, retry in ${wait}ms (${attempt}/${retries})`);
      await delay(wait);
    }
  }
}

function log(level, msg) {
  if (level === 'verbose' && !args.verbose) return;
  const ts = new Date().toISOString();
  const prefix = { info: 'ℹ', warn: '⚠', error: '✗', verbose: '…' }[level] || '•';
  console.log(`${ts} ${prefix} [${level}] ${msg}`);
}

function resolveWebhook() {
  return args.webhook || process.env.FEISHU_ALERT_WEBHOOK || LOCAL_ENV.FEISHU_ALERT_WEBHOOK || '';
}

async function sendWebhookText(text) {
  return sendWebhookPayload({ msg_type: 'text', content: { text } });
}

async function sendWebhookPayload(payload) {
  const webhook = resolveWebhook();
  if (!webhook) {
    log('verbose', 'webhook not configured, skip notify');
    return false;
  }
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log('warn', `webhook send failed: status=${res.status}`);
    } else {
      log('info', 'webhook notify sent');
    }
    return res.ok;
  } catch (err) {
    log('warn', `webhook send failed: ${err.message}`);
    return false;
  }
}

async function sendWebhookPost(title, lines) {
  const content = lines.map((line) => [{ tag: 'text', text: line }]);
  return sendWebhookPayload({
    msg_type: 'post',
    content: {
      post: {
        zh_cn: {
          title,
          content,
        },
      },
    },
  });
}

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeChangeReport(report) {
  const reportPath =
    args['report-file'] ||
    join(runtime.projectRoot, 'logs', `approval-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  ensureDir(reportPath);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}

function pct(numerator, denominator) {
  if (!denominator) return '0.00%';
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function appendMetrics(entry) {
  ensureDir(METRICS_JSONL);
  writeFileSync(METRICS_JSONL, `${JSON.stringify(entry)}\n`, { flag: 'a' });
  writeFileSync(METRICS_LATEST, JSON.stringify(entry, null, 2));
}

function acquireLockOrThrow() {
  ensureDir(LOCK_PATH);
  try {
    return openSync(LOCK_PATH, 'wx');
  } catch {
    throw new Error(`sync lock exists: ${LOCK_PATH} (another run may be in progress)`);
  }
}

function releaseLock(fd) {
  try {
    if (typeof fd === 'number') closeSync(fd);
    if (existsSync(LOCK_PATH)) rmSync(LOCK_PATH);
  } catch {
    // best effort
  }
}

// ═══════════════════════════════════════════
// Main
// ═══════════════════════════════════════════

async function main() {
  const startedAt = Date.now();
  const approvalRequired = String(process.env.APPROVAL_REQUIRED || LOCAL_ENV.APPROVAL_REQUIRED || 'false') === 'true';
  const lockFd = acquireLockOrThrow();
  log('info', `feishu-sync.js v3 starting — mode=${args.mode} pull-only=${args['pull-only']} dry-run=${args['dry-run']} dept=${args.dept || 'all'}`);
  log('info', `Runtime: openclaw_dir=${OPENCLAW_DIR}, config=${CONFIG_PATH}, feishu_account=${FEISHU_ACCOUNT}`);
  if (existsSync(runtime.cfgPath)) log('verbose', `Project config loaded: ${runtime.cfgPath}`);
  if (existsSync(runtime.envPath)) log('verbose', `Local env loaded: ${runtime.envPath}`);

  // Resume check
  if (args.resume) {
    const journal = loadJournal();
    if (!journal) {
      log('info', 'No journal found, nothing to resume');
      return;
    }
    log('info', `Resuming run ${journal.runId} from phase=${journal.phase}, processed=${journal.processed.length}, failed=${journal.failed.length}`);
    // TODO: implement resume logic in Step 3
    return;
  }

  // Cleanup check
  if (args.cleanup) {
    const journal = loadJournal();
    if (!journal) {
      log('info', 'No journal found, nothing to clean up');
      return;
    }
    log('info', `Cleaning up run ${journal.runId}: ${journal.processed.length} processed, ${journal.failed.length} failed`);
    clearJournal();
    log('info', 'Journal cleared');
    return;
  }

  const token = await getTenantAccessToken();
  const { domain } = loadFeishuConfig();
  const baseUrl = getBaseUrl(domain);

  let snapshot, snapshotPath;

  if (args['use-snapshot']) {
    // ── Load existing snapshot, skip pull ──
    const snapFile = args['use-snapshot'];
    if (!existsSync(snapFile)) {
      log('error', `Snapshot file not found: ${snapFile}`);
      process.exit(1);
    }
    snapshot = JSON.parse(readFileSync(snapFile, 'utf8'));
    snapshotPath = snapFile;
    log('info', `Loaded snapshot from ${snapFile}: ${snapshot.stats.total_employees} employees, ${snapshot.stats.total_depts} depts`);
  } else {
    // ── Pull phase ──
    let deptTree;
    if (args.dept) {
      deptTree = await fetchDepartmentTree(token, args.dept);
      const target = await fetchDepartmentDetail(token, args.dept, baseUrl);
      if (target) deptTree.unshift(target);
    } else {
      deptTree = await fetchDepartmentTree(token);
    }

    const deptUserMap = {};
    let totalUsers = 0;
    for (const dept of deptTree) {
      const users = await fetchDepartmentUsers(token, dept.dept_id, baseUrl);
      deptUserMap[dept.dept_id] = users;
      totalUsers += users.length;
      log('verbose', `"${dept.name}" (${dept.dept_id}): ${users.length} users`);
    }

    const uniqueUsers = new Map();
    for (const users of Object.values(deptUserMap)) {
      for (const u of users) {
        if (!uniqueUsers.has(u.open_id)) uniqueUsers.set(u.open_id, u);
      }
    }
    log('info', `Contact v3: ${totalUsers} user records, ${uniqueUsers.size} unique users`);

    snapshot = buildOrgSnapshot(deptTree, deptUserMap);
    log('info', `Snapshot: ${snapshot.stats.total_employees} employees, ${snapshot.stats.total_depts} depts, ${snapshot.stats.leaders} leaders, ${snapshot.stats.empty_user_id} empty user_id`);

    // Save snapshot (skip on dry-run to avoid overwriting good data)
    snapshotPath = null;
    if (!args['dry-run']) {
      const snapshotSuffix = args.dept ? `-dept-${args.dept.slice(-8)}` : '';
      snapshotPath = saveSnapshot(snapshot, SNAPSHOTS_DIR, snapshotSuffix);
    } else {
      snapshotPath = '(dry-run, not saved)';
    }
  }

  // Diff for incremental mode
  let diff = null;
  if (args.mode === 'incremental') {
    const prev = loadLatestSnapshot();
    if (prev) {
      diff = diffSnapshots(prev, snapshot);
      log('info', `Diff: +${diff.added.length} added, -${diff.removed.length} removed, ~${diff.changed.length} changed, =${diff.unchanged.length} unchanged`);
    } else {
      log('info', 'No previous snapshot, treating as full sync');
    }
  }

  if (args['pull-only']) {
    printSummary(snapshot, snapshotPath, 'Pull');
    appendMetrics({
      ts: new Date().toISOString(),
      mode: args.mode,
      phase: 'pull-only',
      departments: snapshot.stats.total_depts,
      employees: snapshot.stats.total_employees,
      duration_sec: Math.round((Date.now() - startedAt) / 1000),
      success: true,
    });
    releaseLock(lockFd);
    return;
  }

  // ── Write phase ──
  const employees = Object.values(snapshot.employees);
  const toCreateRaw = diff ? diff.added : employees;
  const toRemoveRaw = diff ? diff.removed : [];
  const toUpdateRaw = diff ? diff.changed : [];
  const toCreate = toCreateRaw.filter(e => !RESERVED_AGENT_IDS.has(e.agent_id));
  const toRemove = toRemoveRaw.filter(e => !RESERVED_AGENT_IDS.has(e.agent_id));
  const toUpdate = toUpdateRaw.filter(e => !RESERVED_AGENT_IDS.has(e.agent_id));
  const skippedReserved = {
    create: toCreateRaw.length - toCreate.length,
    remove: toRemoveRaw.length - toRemove.length,
    update: toUpdateRaw.length - toUpdate.length,
  };
  if (skippedReserved.create || skippedReserved.remove || skippedReserved.update) {
    log('warn', `Reserved agents skipped: create=${skippedReserved.create}, remove=${skippedReserved.remove}, update=${skippedReserved.update}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.mode,
    pullOnly: args['pull-only'],
    dryRun: args['dry-run'],
    approvalRequired,
    openclawDir: OPENCLAW_DIR,
    configPath: CONFIG_PATH,
    totals: {
      departments: snapshot.stats.total_depts,
      employees: snapshot.stats.total_employees,
      create: toCreate.length,
      archive: toRemove.length,
      update: toUpdate.length,
    },
    sample: {
      create: toCreate.slice(0, 30).map(e => ({ agent_id: e.agent_id, dept: e.dept_name, leader: e.leader_user_id || null })),
      archive: toRemove.slice(0, 30).map(e => ({ agent_id: e.agent_id, dept: e.dept_name })),
      update: toUpdate.slice(0, 30).map(e => ({ agent_id: e.agent_id, changes: e._changes || [] })),
    },
  };
  const reportPath = writeChangeReport(report);
  log('info', `Change report generated: ${reportPath}`);

  // Dry run
  if (args['dry-run']) {
    console.log('\n══════════════════════════════════════');
    console.log('  DRY RUN — No changes will be made');
    console.log('══════════════════════════════════════');
    console.log(`  Create agents : ${toCreate.length}`);
    console.log(`  Archive agents: ${toRemove.length}`);
    console.log(`  Update SOUL.md: ${toUpdate.length}`);
    console.log(`  Total bindings: ${toCreate.length} new`);
    if (toCreate.length > 0) {
      console.log('\n  First 10 agents to create:');
      for (const e of toCreate.slice(0, 10)) {
        console.log(`    ${e.agent_id} | ${e.dept_name} | leader=${e.leader_user_id || 'none'} | role=${e.is_leader ? 'manager' : 'employee'}`);
      }
    }
    if (toRemove.length > 0) {
      console.log('\n  Agents to archive:');
      for (const e of toRemove.slice(0, 10)) {
        console.log(`    ${e.agent_id} | ${e.dept_name}`);
      }
    }
    if (toUpdate.length > 0) {
      console.log('\n  Agents to update:');
      for (const e of toUpdate.slice(0, 10)) {
        console.log(`    ${e.agent_id} | changes: ${e._changes.join(', ')}`);
      }
    }
    console.log('══════════════════════════════════════\n');
    appendMetrics({
      ts: new Date().toISOString(),
      mode: args.mode,
      phase: 'dry-run',
      planned_create: toCreate.length,
      planned_archive: toRemove.length,
      planned_update: toUpdate.length,
      duration_sec: Math.round((Date.now() - startedAt) / 1000),
      success: true,
    });
    releaseLock(lockFd);
    return;
  }

  if (args['approval-only'] || (approvalRequired && !args.approve)) {
    log('warn', 'Approval gate active: write phase skipped');
    log('info', `Review report then rerun with --approve: ${reportPath}`);
    if (args['notify-summary']) {
      await sendWebhookPost('OpenClaw 通讯录同步（审批预览）', [
        `模式：${args.mode}`,
        `部门/员工：${snapshot.stats.total_depts} / ${snapshot.stats.total_employees}`,
        `计划新增：${toCreate.length}`,
        `计划归档：${toRemove.length}`,
        `计划更新：${toUpdate.length}`,
        `报告：${reportPath}`,
      ]);
    }
    appendMetrics({
      ts: new Date().toISOString(),
      mode: args.mode,
      phase: 'approval-only',
      planned_create: toCreate.length,
      planned_archive: toRemove.length,
      planned_update: toUpdate.length,
      report: reportPath,
      duration_sec: Math.round((Date.now() - startedAt) / 1000),
      success: true,
    });
    releaseLock(lockFd);
    return;
  }

  // Backup
  const backupPath = backupConfig();

  // Init journal
  const runId = randomUUID().slice(0, 8);
  const journal = initJournal(runId);
  journal.pending = toCreate.map(e => e.agent_id);
  writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2));

  const config = loadConfig();
  const existingAgentIds = new Set((config.agents?.list || []).map(a => a.id));

  let created = 0, archived = 0, updated = 0, failed = 0;

  // Phase 1: Create agents
  updateJournalPhase(journal, 'agents');
  for (const emp of toCreate) {
    try {
      if (existingAgentIds.has(emp.agent_id)) {
        log('verbose', `Agent ${emp.agent_id} already exists, updating SOUL.md only`);
      } else {
        createAgentDirs(emp.agent_id);
        log('verbose', `Created agent dirs: ${emp.agent_id}`);
      }
      const soulContent = generateSoulMd(emp, snapshot);
      writeSoulMd(emp.agent_id, soulContent);
      writeIdentityMd(emp.agent_id);
      syncToolsMd(emp.agent_id);
      markProcessed(journal, emp.agent_id);
      created++;
      if (created % 50 === 0) log('info', `Progress: ${created}/${toCreate.length} agents created`);
    } catch (err) {
      log('error', `Failed to create agent ${emp.agent_id}: ${err.message}`);
      markFailed(journal, emp.agent_id, err);
      failed++;
    }
  }

  // Phase 1b: Archive removed agents
  for (const emp of toRemove) {
    try {
      archiveAgent(emp.agent_id);
      archived++;
    } catch (err) {
      log('error', `Failed to archive agent ${emp.agent_id}: ${err.message}`);
      failed++;
    }
  }

  // Phase 1c: Update changed agents
  for (const emp of toUpdate) {
    try {
      const soulContent = generateSoulMd(emp, snapshot);
      writeSoulMd(emp.agent_id, soulContent);
      syncToolsMd(emp.agent_id);
      updated++;
      log('verbose', `Updated SOUL.md: ${emp.agent_id} (${emp._changes.join(', ')})`);
    } catch (err) {
      log('error', `Failed to update agent ${emp.agent_id}: ${err.message}`);
      failed++;
    }
  }

  log('info', `Agent phase complete: ${created} created, ${archived} archived, ${updated} updated, ${failed} failed`);

  // Phase 2: Update bindings + agents.list atomically
  updateJournalPhase(journal, 'bindings');

  // Remove bindings for archived agents
  const removedIds = new Set(toRemove.map(e => e.agent_id));

  // Reload config (might have changed)
  const freshConfig = loadConfig();
  normalizeFallbackRouting(freshConfig);

  // Update agents.list
  freshConfig.agents = freshConfig.agents || { list: [] };
  const newAgentEntries = toCreate
    .filter(e => !existingAgentIds.has(e.agent_id))
    .map(e => buildAgentListEntry(e.agent_id));

  freshConfig.agents.list = [
    ...(freshConfig.agents.list || []).filter(a => !removedIds.has(a.id)),
    ...newAgentEntries,
  ];

  // Reconcile bindings against the latest snapshot so stale/duplicate peer routes do not accumulate.
  const bindingPlan = reconcileFeishuBindings(freshConfig.bindings || [], employees, removedIds);
  freshConfig.bindings = bindingPlan.bindings;

  saveConfig(freshConfig);
  log('info', `Config updated: +${newAgentEntries.length} agents, bindings +${bindingPlan.added}/-${bindingPlan.removed}, -${removedIds.size} removed agents`);

  // Clear journal on success
  clearJournal();

  const archivesCleaned = cleanupArchives(ARCHIVE_RETENTION_DAYS);
  // Summary
  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  const totalOps = created + archived + updated + failed;
  const failureRate = pct(failed, totalOps);
  console.log('\n══════════════════════════════════════');
  console.log(`  feishu-sync.js v3 — Sync Complete`);
  console.log('══════════════════════════════════════');
  console.log(`  Mode        : ${args.mode}`);
  console.log(`  Departments : ${snapshot.stats.total_depts}`);
  console.log(`  Employees   : ${snapshot.stats.total_employees}`);
  console.log(`  Created     : ${created}`);
  console.log(`  Archived    : ${archived}`);
  console.log(`  Updated     : ${updated}`);
  console.log(`  Failed      : ${failed}`);
  console.log(`  FailureRate : ${failureRate}`);
  console.log(`  Duration(s) : ${durationSec}`);
  console.log(`  Bindings    : +${bindingPlan.added} / -${bindingPlan.removed}`);
  console.log(`  Backup      : ${backupPath}`);
  console.log(`  Snapshot    : ${snapshotPath}`);
  console.log(`  Report      : ${reportPath}`);
  console.log(`  ArchiveGC   : ${archivesCleaned} removed (retention=${ARCHIVE_RETENTION_DAYS}d)`);
  console.log('══════════════════════════════════════\n');

  if (failed > 0) {
    log('warn', `${failed} agents failed — check logs above. Run with --resume to retry.`);
  }

  if (args['notify-summary']) {
    await sendWebhookPost('OpenClaw 通讯录同步（执行完成）', [
      `模式：${args.mode}`,
      `部门/员工：${snapshot.stats.total_depts} / ${snapshot.stats.total_employees}`,
      `新增/归档/更新：${created} / ${archived} / ${updated}`,
      `失败数：${failed}（失败率 ${failureRate}）`,
      `耗时：${durationSec}s`,
      `归档清理：${archivesCleaned}（保留 ${ARCHIVE_RETENTION_DAYS} 天）`,
      `报告：${reportPath}`,
    ]);
  }

  appendMetrics({
    ts: new Date().toISOString(),
    mode: args.mode,
    phase: 'write',
    departments: snapshot.stats.total_depts,
    employees: snapshot.stats.total_employees,
    create: created,
    archive: archived,
    update: updated,
    failed,
    failure_rate: failureRate,
    bindings_add: bindingPlan.added,
    bindings_remove: bindingPlan.removed,
    archive_gc: archivesCleaned,
    retention_days: ARCHIVE_RETENTION_DAYS,
    report: reportPath,
    duration_sec: durationSec,
    success: failed === 0,
  });
  releaseLock(lockFd);
}

function printSummary(snapshot, snapshotPath, phase) {
  const sample = Object.values(snapshot.employees).slice(0, 5);
  console.log('\n── Sample employees ──');
  for (const e of sample) {
    console.log(`  ${e.agent_id} | dept=${e.dept_name} | leader=${e.leader_user_id || 'none'} | is_leader=${e.is_leader}${e.subordinates ? ` | subs=${e.subordinates.length}` : ''}`);
  }
  console.log(`\n══════════════════════════════════════`);
  console.log(`  feishu-sync.js v3 — ${phase} Complete`);
  console.log('══════════════════════════════════════');
  console.log(`  Departments : ${snapshot.stats.total_depts}`);
  console.log(`  Employees   : ${snapshot.stats.total_employees}`);
  console.log(`  Leaders     : ${snapshot.stats.leaders}`);
  console.log(`  Empty UID   : ${snapshot.stats.empty_user_id}`);
  console.log(`  Snapshot    : ${snapshotPath}`);
  console.log('══════════════════════════════════════\n');
}

main().catch(err => {
  log('error', `Fatal: ${err.message}`);
  if (args.verbose) console.error(err.stack);
  appendMetrics({
    ts: new Date().toISOString(),
    mode: args.mode,
    phase: 'fatal',
    error: err.message,
    success: false,
  });
  releaseLock();
  sendWebhookPost('OpenClaw 通讯录同步（失败告警）', [
    `模式：${args.mode}`,
    `错误：${err.message}`,
    `时间：${new Date().toISOString()}`,
  ]).catch(() => {});
  process.exit(1);
});
