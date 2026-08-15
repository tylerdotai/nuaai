import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';

import { workspaceDirectory } from '../config/index.js';
import { createEvent } from '../core/events.js';
import type { DatabaseStore } from '../memory/db.js';
import type { SkillRegistry } from './registry.js';

const manifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().min(1),
  version: z.string().min(1),
  entry: z.string().default('index.mjs'),
  trusted: z.boolean().default(false),
});
export type SkillManifest = z.infer<typeof manifestSchema>;

export async function loadFilesystemSkills(
  root: string,
  registry: SkillRegistry,
  store?: DatabaseStore,
): Promise<SkillManifest[]> {
  const manifests: SkillManifest[] = [];
  for (const path of await fg('skills/*/manifest.json', {
    cwd: workspaceDirectory(root),
    onlyFiles: true,
  })) {
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(resolve(workspaceDirectory(root), path), 'utf8')),
    );
    if (!manifest.trusted) {
      store?.appendEvent(
        createEvent(
          'skill.failed',
          { name: manifest.name, error: 'Untrusted filesystem skill refused' },
          { source: 'skills' },
        ),
      );
      continue;
    }
    const modulePath = resolve(workspaceDirectory(root), 'skills', manifest.name, manifest.entry);
    const loaded = (await import(modulePath)) as {
      execute?: (input: unknown) => unknown | Promise<unknown>;
    };
    if (typeof loaded.execute !== 'function')
      throw new Error(`Skill entry must export execute: ${manifest.name}`);
    registry.register({
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      source: 'filesystem',
      input: z.unknown(),
      execute: loaded.execute,
    });
    manifests.push(manifest);
    store?.appendEvent(
      createEvent(
        'skill.loaded',
        { name: manifest.name, version: manifest.version },
        { source: 'skills' },
      ),
    );
  }
  return manifests;
}
