export type PermissionLevel = 'read' | 'write' | 'execute' | 'secret';

export interface CapabilitySet {
  filesystem?: boolean;
  subprocess?: boolean;
  network?: boolean;
  secrets?: boolean;
}

export interface PermissionContext {
  approved: Set<PermissionLevel>;
  capabilities: CapabilitySet;
}

export function assertPermission(context: PermissionContext, level: PermissionLevel): void {
  if (!context.approved.has(level)) {
    throw new Error(`Permission required: ${level}`);
  }
}
