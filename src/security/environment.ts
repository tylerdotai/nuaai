const inheritedEnvironmentNames = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'TMPDIR',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
] as const;

export function sanitizedSubprocessEnvironment(
  explicit: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of inheritedEnvironmentNames) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...explicit };
}

export function selectInheritedEnvironment(
  names: string[],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    names.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]])),
  );
}
