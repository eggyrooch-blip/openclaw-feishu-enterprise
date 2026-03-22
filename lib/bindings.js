function isFeishuDirectBinding(binding) {
  return binding?.match?.channel === 'feishu' && binding?.match?.peer?.kind === 'direct';
}

function buildDirectFeishuBinding(agentId, openId) {
  return {
    agentId,
    match: {
      channel: 'feishu',
      peer: {
        kind: 'direct',
        id: openId,
      },
    },
  };
}

export function reconcileFeishuBindings(currentBindings = [], employees = [], removedIds = new Set()) {
  const desiredBindings = new Map();
  for (const employee of employees) {
    if (!employee?.agent_id || !employee?.open_id) continue;
    desiredBindings.set(employee.agent_id, buildDirectFeishuBinding(employee.agent_id, employee.open_id));
  }

  const nextBindings = [];
  const keptDesired = new Set();
  let removed = 0;

  for (const binding of currentBindings) {
    const agentId = binding?.agentId;
    if (removedIds.has(agentId)) {
      removed += 1;
      continue;
    }

    const desired = desiredBindings.get(agentId);
    if (desired && isFeishuDirectBinding(binding)) {
      const peerId = binding?.match?.peer?.id;
      if (peerId === desired.match.peer.id && !keptDesired.has(agentId)) {
        nextBindings.push(binding);
        keptDesired.add(agentId);
      } else {
        removed += 1;
      }
      continue;
    }

    nextBindings.push(binding);
  }

  let added = 0;
  for (const employee of employees) {
    if (!employee?.agent_id || !employee?.open_id) continue;
    if (keptDesired.has(employee.agent_id)) continue;
    nextBindings.push(buildDirectFeishuBinding(employee.agent_id, employee.open_id));
    keptDesired.add(employee.agent_id);
    added += 1;
  }

  return { bindings: nextBindings, added, removed };
}
