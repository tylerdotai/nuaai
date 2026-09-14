import { describe, expect, it } from 'vitest';

import {
  hardenSynapseRegistration,
  matrixOperatorPolicy,
} from '../scripts/matrix-bootstrap-policy.mjs';

describe('Matrix bootstrap operator policy', () => {
  it('defaults to a provisioned operator account when no allowlist exists', () => {
    expect(matrixOperatorPolicy([], 'operator', 'host.example')).toEqual({
      localpart: 'operator',
      userId: '@operator:host.example',
      allowedUsers: ['@operator:host.example'],
    });
  });

  it('preserves an existing allowlist and includes the provisioned operator', () => {
    expect(
      matrixOperatorPolicy(['@owner:host.example'], 'operator', 'host.example').allowedUsers,
    ).toEqual(['@owner:host.example', '@operator:host.example']);
  });

  it('rejects malformed localparts', () => {
    expect(() => matrixOperatorPolicy([], '../owner', 'host.example')).toThrow(
      'Invalid Matrix operator localpart',
    );
  });

  it('disables public registration while preserving shared-secret account provisioning', () => {
    expect(
      hardenSynapseRegistration(
        'registration_shared_secret: "keep-me"\nenable_registration: true\nenable_registration_without_verification: true\n',
      ),
    ).toBe(
      'registration_shared_secret: "keep-me"\nenable_registration: false\nenable_registration_without_verification: false\n',
    );
    expect(hardenSynapseRegistration('registration_shared_secret: "keep-me"\n')).toContain(
      'enable_registration: false\n',
    );
  });
});
