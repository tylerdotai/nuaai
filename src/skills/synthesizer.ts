import { transform } from 'esbuild';
import { Project } from 'ts-morph';

export function generateSkillSource(name: string, description: string, body: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error('Skill name must use lowercase letters, numbers, and hyphens');
  }
  if (!body.trim()) {
    throw new Error('Skill body is required');
  }

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('skill.ts');
  sourceFile.addStatements(
    `export const name = ${JSON.stringify(name)};\n` +
      `export const description = ${JSON.stringify(description)};\n` +
      `export async function execute(input: unknown): Promise<unknown> {\n${body}\n}\n`,
  );
  return sourceFile.getFullText();
}

export async function compileSkill(source: string): Promise<string> {
  if (!source.trim()) {
    throw new Error('Skill source is required');
  }

  const result = await transform(source, {
    format: 'esm',
    loader: 'ts',
    sourcemap: false,
    target: 'es2022',
  });
  return result.code;
}
