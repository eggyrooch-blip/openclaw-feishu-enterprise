import { join } from 'node:path';

function normalizeWorkspace(openclawDir, agent) {
  if (agent?.workspace) return agent.workspace;
  if (agent?.id) return join(openclawDir, `workspace-${agent.id}`);
  return null;
}

export function findOpenClawOrphans({
  openclawDir,
  config,
  agentDirs = [],
  rootDirs = [],
}) {
  const knownAgents = (config?.agents?.list || [])
    .map(agent => agent?.id)
    .filter(Boolean);
  const knownAgentIds = [...new Set(knownAgents)].sort();

  const knownWorkspacePaths = new Set(
    (config?.agents?.list || [])
      .map(agent => normalizeWorkspace(openclawDir, agent))
      .filter(Boolean),
  );

  const orphanAgentDirs = [...new Set(agentDirs)]
    .filter(name => !knownAgentIds.includes(name))
    .sort()
    .map(name => join(openclawDir, 'agents', name));

  const orphanWorkspaces = [...new Set(rootDirs)]
    .filter(name => name.startsWith('workspace-'))
    .map(name => join(openclawDir, name))
    .filter(path => !knownWorkspacePaths.has(path))
    .sort();

  return {
    knownAgentIds,
    orphanAgentDirs,
    orphanWorkspaces,
    orphanPaths: [...orphanAgentDirs, ...orphanWorkspaces],
  };
}
