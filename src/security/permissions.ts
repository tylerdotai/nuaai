export type PermissionLevel = 'read' | 'write' | 'execute' | 'secret';
export type PermissionProfile = 'read-only' | 'operator';

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

export function permissionContextForProfile(profile: PermissionProfile): PermissionContext {
  return profile === 'operator'
    ? {
        approved: new Set(['read', 'write', 'execute']),
        capabilities: { filesystem: true, subprocess: true, network: true },
      }
    : {
        approved: new Set(['read']),
        capabilities: { filesystem: true, network: true },
      };
}

export function assertPermission(context: PermissionContext, level: PermissionLevel): void {
  if (!context.approved.has(level)) {
    throw new Error(`Permission required: ${level}`);
  }
}
