/** @param {string[]} args */
export function localIntegrationSelection(args) {
  const allowed = new Set(['--matrix', '--search', '--browser']);
  const unknown = args.find((argument) => !allowed.has(argument));
  if (unknown) throw new Error(`Unknown integration flag: ${unknown}`);
  const explicit = args.length > 0;
  const matrix = !explicit || args.includes('--matrix');
  const search = !explicit || args.includes('--search');
  const browser = !explicit || args.includes('--browser');
  return {
    matrix,
    search,
    browser,
    services: [
      ...(matrix ? ['synapse'] : []),
      ...(search ? ['searxng', 'crawl4ai'] : []),
      ...(browser ? ['flaresolverr'] : []),
    ],
  };
}
