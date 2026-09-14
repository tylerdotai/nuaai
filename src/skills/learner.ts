import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { workspaceDirectory } from '../config/index.js';
import { parseSkillDocument } from './loader.js';
import type { SkillRegistry } from './registry.js';

export interface LearnedSkill {
  name: string;
  path: string;
  triggers: string[];
}

function slugify(value: string): string {
  const slug = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!slug) throw new Error('Learned skill name is empty');
  return slug.slice(0, 64).replace(/-+$/, '');
}

function parseRequest(input: string): { name: string; body: string } | undefined {
  const explicit = input.match(/^\s*learn\s+skill\s+([a-z0-9][a-z0-9 -]{0,62})\s*:\s*([\s\S]+)$/i);
  if (explicit) return { name: slugify(explicit[1]), body: explicit[2].trim() };
  const natural = input.match(
    /^\s*(?:save|remember)\s+(?:this|the workflow)\s+as\s+(?:a\s+)?skill(?:\s+(?:called|named)\s+([a-z0-9][a-z0-9 -]{0,62}))?\s*:?\s*\n([\s\S]+)$/i,
  );
  if (natural) {
    return {
      name: slugify(natural[1] ?? natural[2].split(/\s+/).slice(0, 5).join(' ')),
      body: natural[2].trim(),
    };
  }
  return undefined;
}

function triggerWords(name: string, body: string): string[] {
  const stopWords = new Set([
    'about',
    'after',
    'before',
    'from',
    'into',
    'that',
    'this',
    'with',
    'when',
    'where',
    'which',
    'workflow',
  ]);
  const words =
    `${name.replace(/-/g, ' ')} ${body}`.toLocaleLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(words.filter((word) => !stopWords.has(word)))].slice(0, 10);
}

async function nextDirectory(
  base: string,
  name: string,
): Promise<{ name: string; directory: string }> {
  let index = 0;
  while (true) {
    const candidate = index ? `${name}-${index + 1}` : name;
    const directory = resolve(base, candidate);
    try {
      await access(directory);
      index += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { name: candidate, directory };
      throw error;
    }
  }
}

export class SkillLearner {
  constructor(
    private readonly root: string,
    private readonly registry: SkillRegistry,
  ) {}

  async learnFromRun(input: string): Promise<LearnedSkill | undefined> {
    const request = parseRequest(input);
    if (!request?.body) return undefined;
    const base = resolve(workspaceDirectory(this.root), 'skills');
    const selected = await nextDirectory(base, request.name);
    const path = resolve(selected.directory, 'SKILL.md');
    const triggers = triggerWords(selected.name, request.body);
    const description = `Applies the learned ${selected.name.replace(/-/g, ' ')} workflow. Use when the user asks for ${triggers.slice(0, 5).join(', ') || selected.name}.`;
    const document = [
      '---',
      `name: ${selected.name}`,
      `description: ${description.slice(0, 1024)}`,
      'license: Proprietary. See the repository LICENSE.',
      'compatibility: Designed for the NUAAI local workspace.',
      'metadata:',
      '  author: nuaai-auto-learning',
      '  version: "1.0"',
      `  triggers: "${triggers.join(', ')}"`,
      '---',
      '',
      '# Learned workflow',
      '',
      request.body,
      '',
    ].join('\n');
    await mkdir(selected.directory, { recursive: true, mode: 0o700 });
    await writeFile(path, document, { encoding: 'utf8', mode: 0o600 });
    const manifest = parseSkillDocument(document, selected.name, path);
    this.registry.registerInstruction({
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      source: 'learned',
      license: manifest.license,
      compatibility: manifest.compatibility,
      metadata: manifest.metadata,
      allowedTools: manifest.allowedTools,
      triggers: manifest.triggers,
      body: manifest.body,
      path: manifest.path,
    });
    return { name: manifest.name, path, triggers: manifest.triggers };
  }
}
