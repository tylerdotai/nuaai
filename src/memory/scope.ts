import { resolve } from 'node:path';

export function memoryVisibleInWorkspace(
  metadata: Record<string, unknown>,
  workspaceRoot?: string,
): boolean {
  if (metadata.knowledge === undefined) return true; // Existing explicitly saved memories retain their original profile scope.
  if (!metadata.knowledge || typeof metadata.knowledge !== 'object') return false;
  const knowledge = metadata.knowledge as Record<string, unknown>;
  if (
    knowledge.state === 'active' &&
    knowledge.scope === 'profile' &&
    knowledge.origin === 'explicit'
  )
    return true;
  return (
    knowledge.state === 'active' &&
    knowledge.scope === 'workspace' &&
    typeof knowledge.workspaceRoot === 'string' &&
    Boolean(workspaceRoot) &&
    resolve(knowledge.workspaceRoot) === resolve(workspaceRoot ?? '.')
  );
}
