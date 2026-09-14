/**
 * @param {{ version: string; exactTags: string[]; githubRef?: string }} input
 * @returns {string}
 */
export function validateVersionTagPolicy(input) {
  const expectedTag = `v${input.version}`;
  const ciTag = input.githubRef?.startsWith('refs/tags/')
    ? input.githubRef.slice('refs/tags/'.length)
    : undefined;
  if (ciTag && ciTag !== expectedTag)
    throw new Error(`GitHub tag ${ciTag} does not match ${expectedTag}`);
  if (!ciTag && input.exactTags.length > 0 && !input.exactTags.includes(expectedTag))
    throw new Error(`Exact Git tag ${input.exactTags.join(', ')} does not match ${expectedTag}`);
  return expectedTag;
}
