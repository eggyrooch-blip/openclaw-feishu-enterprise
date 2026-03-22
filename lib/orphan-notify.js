export function buildOrphanSummary(summary) {
  const orphanAgentCount = summary.orphanAgentDirs?.length || 0;
  const orphanWorkspaceCount = summary.orphanWorkspaces?.length || 0;
  const busyCount = summary.busyPaths?.length || 0;
  const severity = orphanAgentCount > 0 || orphanWorkspaceCount > 0 || busyCount > 0 ? 'warn' : 'info';
  const title = summary.apply ? 'OpenClaw 孤儿目录清理' : 'OpenClaw 孤儿目录周巡检';
  const lines = [
    `模式：${summary.apply ? 'apply' : 'dry-run'}`,
    `OpenClaw：${summary.openclawDir}`,
    `孤儿 agent 目录：${orphanAgentCount}`,
    `孤儿 workspace：${orphanWorkspaceCount}`,
    `busy 路径：${busyCount}`,
  ];

  if (summary.backupPath) {
    lines.push(`备份：${summary.backupPath}`);
  }
  if (orphanAgentCount > 0) {
    lines.push(`agent 示例：${summary.orphanAgentDirs.slice(0, 3).join(', ')}`);
  }
  if (orphanWorkspaceCount > 0) {
    lines.push(`workspace 示例：${summary.orphanWorkspaces.slice(0, 3).join(', ')}`);
  }
  if (busyCount > 0) {
    lines.push(`busy 示例：${summary.busyPaths.slice(0, 3).map(item => item.path).join(', ')}`);
  }

  return {
    severity,
    title,
    lines,
    text: lines.join('\n'),
  };
}
