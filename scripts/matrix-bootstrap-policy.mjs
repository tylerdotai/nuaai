/**
 * @param {unknown[]} existingAllowedUsers
 * @param {string} requestedLocalpart
 * @param {string} serverName
 */
export function matrixOperatorPolicy(existingAllowedUsers, requestedLocalpart, serverName) {
  const localpart = requestedLocalpart.trim();
  if (!/^[a-z0-9._=-]+$/.test(localpart))
    throw new Error(`Invalid Matrix operator localpart: ${requestedLocalpart}`);
  if (!serverName.trim()) throw new Error('Matrix server name is required');
  const userId = `@${localpart}:${serverName}`;
  const existing = [
    ...new Set(
      existingAllowedUsers
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  return {
    localpart,
    userId,
    allowedUsers: [...new Set([...existing, userId])],
  };
}

/** @param {string} config */
export function hardenSynapseRegistration(config) {
  let next = config.replace(/^enable_registration:\s*.*$/m, 'enable_registration: false');
  if (!/^enable_registration:/m.test(next)) next += 'enable_registration: false\n';
  next = next.replace(
    /^enable_registration_without_verification:\s*.*$/m,
    'enable_registration_without_verification: false',
  );
  if (!/^enable_registration_without_verification:/m.test(next))
    next += 'enable_registration_without_verification: false\n';
  return next;
}
