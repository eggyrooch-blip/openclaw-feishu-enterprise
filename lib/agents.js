import { join } from 'node:path';

const DEFAULT_RESERVED_AGENT_IDS = new Set(['main', 'gatekeeper']);

function buildEmployeeByUserId(employees = []) {
  const map = new Map();
  for (const employee of employees) {
    if (!employee?.user_id || !employee?.agent_id) continue;
    map.set(employee.user_id, employee);
  }
  return map;
}

function buildAgentToAgentAllowList(employee, employeeByUserId) {
  const allow = [];
  const seen = new Set();

  const add = (agentId) => {
    if (!agentId || agentId === employee?.agent_id || seen.has(agentId)) return;
    seen.add(agentId);
    allow.push(agentId);
  };

  if (employee?.leader_user_id) {
    add(employeeByUserId.get(employee.leader_user_id)?.agent_id);
  }

  for (const subordinateId of employee?.subordinates || []) {
    add(subordinateId);
  }

  return allow;
}

function buildManagedEmployeeAgentEntry(employee, existingEntry, openclawDir, employeeByUserId) {
  const allow = buildAgentToAgentAllowList(employee, employeeByUserId);
  const nextTools = { ...(existingEntry?.tools || {}) };
  nextTools.agentToAgent = {
    enabled: allow.length > 0,
    allow,
  };

  return {
    ...(existingEntry || {}),
    id: employee.agent_id,
    workspace: join(openclawDir, `workspace-${employee.agent_id}`),
    tools: nextTools,
  };
}

export function reconcileManagedEmployeeAgentEntries(currentAgents = [], employees = [], options = {}) {
  const {
    openclawDir = '/Users/admin/.openclaw',
    removedIds = new Set(),
    reservedAgentIds = DEFAULT_RESERVED_AGENT_IDS,
  } = options;

  const employeeByAgentId = new Map();
  for (const employee of employees) {
    if (employee?.agent_id) employeeByAgentId.set(employee.agent_id, employee);
  }
  const employeeByUserId = buildEmployeeByUserId(employees);

  const nextAgents = [];
  const seenEmployeeIds = new Set();

  for (const agent of currentAgents) {
    if (!agent?.id || removedIds.has(agent.id)) continue;
    if (reservedAgentIds.has(agent.id)) {
      nextAgents.push(agent);
      continue;
    }

    const employee = employeeByAgentId.get(agent.id);
    if (!employee) {
      nextAgents.push(agent);
      continue;
    }

    nextAgents.push(buildManagedEmployeeAgentEntry(employee, agent, openclawDir, employeeByUserId));
    seenEmployeeIds.add(employee.agent_id);
  }

  for (const employee of employees) {
    if (!employee?.agent_id || seenEmployeeIds.has(employee.agent_id) || reservedAgentIds.has(employee.agent_id)) continue;
    nextAgents.push(buildManagedEmployeeAgentEntry(employee, null, openclawDir, employeeByUserId));
  }

  return nextAgents;
}
