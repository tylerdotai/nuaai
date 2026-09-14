#!/usr/bin/env node

import { access, readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const skillDirectory = resolve(process.argv[2] ?? '.');
const skillName = skillDirectory.split('/').at(-1);
const skillPath = resolve(skillDirectory, 'SKILL.md');

function fail(message) {
  throw new Error(message);
}

const content = await readFile(skillPath, 'utf8');
if (!content.startsWith('---\n')) fail('SKILL.md must start with YAML frontmatter');
const closing = content.indexOf('\n---\n', 4);
if (closing === -1) fail('SKILL.md frontmatter must close with ---');
const frontmatter = content.slice(4, closing).split('\n');
const fields = new Map();
for (const line of frontmatter) {
  const match = /^(name|description):\s*(.+)$/.exec(line);
  if (match) fields.set(match[1], match[2].replace(/^['"]|['"]$/g, ''));
}
const name = fields.get('name');
const description = fields.get('description');
if (!name || !description) fail('frontmatter requires name and description');
if (name !== skillName) fail(`name ${name} does not match directory ${skillName}`);
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
  fail('name must be lowercase kebab-case and at most 64 characters');
if (description.length < 1 || description.length > 1024)
  fail('description must contain 1-1024 characters');
if (!content.slice(closing + 5).trim()) fail('SKILL.md body must not be empty');

for (const directory of ['references', 'scripts', 'assets']) {
  const child = resolve(skillDirectory, directory);
  try {
    const entries = await readdir(child, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = resolve(child, entry.name);
      await access(path);
      if (directory === 'scripts') {
        const mode = (await stat(path)).mode;
        if ((mode & 0o111) === 0) fail(`script is not executable: ${path}`);
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

console.log(`Valid skill: ${name}`);
console.log(`Supporting files checked under: ${skillDirectory}`);
