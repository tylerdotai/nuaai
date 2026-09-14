export interface MatrixOperatorPolicy {
  localpart: string;
  userId: string;
  allowedUsers: string[];
}

export function matrixOperatorPolicy(
  existingAllowedUsers: unknown[],
  requestedLocalpart: string,
  serverName: string,
): MatrixOperatorPolicy;

export function hardenSynapseRegistration(config: string): string;
