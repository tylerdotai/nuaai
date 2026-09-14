/**
 * Preserve a valid configured high port. Runtime health checks, not setup reruns,
 * decide whether the process currently listening on that port is correct.
 *
 * @param {unknown} candidate
 * @param {Set<number>} used
 * @returns {number | undefined}
 */
export function reserveConfiguredPort(candidate, used) {
  if (
    !Number.isInteger(candidate) ||
    candidate < 40_000 ||
    candidate > 60_000 ||
    used.has(candidate)
  )
    return undefined;
  used.add(candidate);
  return candidate;
}
