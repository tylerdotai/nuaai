import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import fg from 'fast-glob';
import { z } from 'zod';

import { workspaceDirectory } from '../config/index.js';
import { createEvent } from '../core/events.js';
import type { DatabaseStore } from '../memory/db.js';
import type { SkillRegistry } from './registry.js';

const namePattern = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  license?: string;
  compatibility?: string;
  metadata: Record<string, string>;
  allowedTools: string[];
  triggers: string[];
  body: string;
  path: string;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}

function parseFrontmatter(source: string): { values: Record<string, unknown>; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter delimited by ---');
  const values: Record<string, unknown> = {};
  let currentMap: Record<string, unknown> | undefined;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const nested = line.match(/^ {2,}([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (nested && currentMap) {
      const rawValue = nested[2].trim();
      const value = scalar(rawValue);
      currentMap[nested[1]] =
        !rawValue.startsWith('"') && !rawValue.startsWith("'") && /^-?\d+(?:\.\d+)?$/.test(value)
          ? Number(value)
          : value;
      continue;
    }
    const entry = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!entry) throw new Error(`Invalid SKILL.md frontmatter line: ${line}`);
    const [, key, rawValue] = entry;
    if (!rawValue.trim()) {
      currentMap = {};
      values[key] = currentMap;
    } else {
      currentMap = undefined;
      values[key] = scalar(rawValue);
    }
  }
  return { values, body: source.slice(match[0].length).trim() };
}

export function parseSkillDocument(
  source: string,
  directoryName: string,
  path = 'SKILL.md',
): SkillManifest {
  const { values, body } = parseFrontmatter(source);
  const metadataValue = values.metadata ?? {};
  if (!metadataValue || typeof metadataValue !== 'object' || Array.isArray(metadataValue))
    throw new Error('Skill metadata must be a string-to-string map');
  const metadata = Object.fromEntries(
    Object.entries(metadataValue).map(([key, value]) => {
      if (typeof value !== 'string')
        throw new Error(`Skill metadata value must be a string: ${key}`);
      return [key, value];
    }),
  );
  const parsed = z
    .object({
      name: z.string().min(1).max(64).regex(namePattern),
      description: z.string().min(1).max(1024),
      license: z.string().min(1).optional(),
      compatibility: z.string().min(1).max(500).optional(),
      allowedTools: z.string().optional(),
    })
    .parse({
      name: values.name,
      description: values.description,
      license: values.license,
      compatibility: values.compatibility,
      allowedTools: values['allowed-tools'],
    });
  if (parsed.name !== directoryName) throw new Error('Skill name must match its parent directory');
  const triggers = (metadata.triggers ?? '')
    .split(',')
    .map((trigger) => trigger.trim())
    .filter(Boolean);
  return {
    name: parsed.name,
    description: parsed.description,
    version: metadata.version ?? '1.0.0',
    ...(parsed.license ? { license: parsed.license } : {}),
    ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
    metadata,
    allowedTools: parsed.allowedTools?.split(/\s+/).filter(Boolean) ?? [],
    triggers,
    body,
    path,
  };
}

function emitSkillFailure(store: DatabaseStore | undefined, name: string, error: unknown): void {
  store?.appendEvent(
    createEvent(
      'skill.failed',
      { name, error: error instanceof Error ? error.message : String(error) },
      { source: 'skills' },
    ),
  );
}

async function loadLegacyPrivateSkills(
  root: string,
  registry: SkillRegistry,
  store: DatabaseStore | undefined,
  manifests: SkillManifest[],
): Promise<void> {
  const directory = resolve(workspaceDirectory(root), 'skills');
  const paths = await fg('*/manifest.json', { cwd: directory, onlyFiles: true });
  for (const relativePath of paths.sort()) {
    const manifestPath = resolve(directory, relativePath);
    const name = relativePath.split('/')[0];
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        name?: string;
        description?: string;
        version?: string;
        trusted?: boolean;
      };
      if (manifest.trusted !== true) {
        emitSkillFailure(store, name, new Error('Legacy skill is not trusted'));
        continue;
      }
      const entryPath = resolve(directory, name, 'index.mjs');
      const entry = (await import(pathToFileURL(entryPath).href)) as {
        execute?: (input: unknown) => unknown | Promise<unknown>;
      };
      if (typeof entry.execute !== 'function') throw new Error('Skill entry must export execute');
      if (registry.has(name)) continue;
      registry.register({
        name,
        description: manifest.description ?? name,
        version: manifest.version ?? '1.0.0',
        source: 'legacy-private',
        input: z.unknown(),
        execute: entry.execute,
      });
      const loaded: SkillManifest = {
        name,
        description: manifest.description ?? name,
        version: manifest.version ?? '1.0.0',
        metadata: { legacy: 'true', triggers: name },
        allowedTools: [],
        triggers: [name],
        body: '',
        path: manifestPath,
      };
      manifests.push(loaded);
      store?.appendEvent(
        createEvent(
          'skill.loaded',
          { name, version: loaded.version, source: manifestPath, legacy: true },
          { source: 'skills' },
        ),
      );
    } catch (error) {
      emitSkillFailure(store, name, error);
      if (error instanceof Error && error.message === 'Skill entry must export execute')
        throw error;
    }
  }
}

export async function loadFilesystemSkills(
  root: string,
  registry: SkillRegistry,
  store?: DatabaseStore,
  builtInSkillsDirectory = resolve(root, 'skills'),
): Promise<SkillManifest[]> {
  const manifests: SkillManifest[] = [];
  const directories = [
    ...new Set([builtInSkillsDirectory, resolve(workspaceDirectory(root), 'skills')]),
  ];
  await loadLegacyPrivateSkills(root, registry, store, manifests);
  for (const directory of directories) {
    const paths = await fg('*/SKILL.md', { cwd: directory, onlyFiles: true });
    for (const relativePath of paths.sort()) {
      const path = resolve(directory, relativePath);
      const name = relativePath.split('/')[0];
      try {
        const manifest = parseSkillDocument(await readFile(path, 'utf8'), name, path);
        if (registry.has(manifest.name)) continue;
        registry.registerInstruction({
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          source: directory === builtInSkillsDirectory ? 'filesystem' : 'private',
          license: manifest.license,
          compatibility: manifest.compatibility,
          metadata: manifest.metadata,
          allowedTools: manifest.allowedTools,
          triggers: manifest.triggers,
          body: manifest.body,
          path: manifest.path,
        });
        manifests.push(manifest);
        store?.appendEvent(
          createEvent(
            'skill.loaded',
            { name: manifest.name, version: manifest.version, source: manifest.path },
            { source: 'skills' },
          ),
        );
      } catch (error) {
        emitSkillFailure(store, name, error);
      }
    }
  }
  return manifests;
}
