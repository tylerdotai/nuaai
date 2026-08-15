import type { z } from 'zod';

export interface Skill {
  name: string;
  description: string;
  version?: string;
  source?: string;
  input: z.ZodType<unknown>;
  execute(input: unknown): unknown | Promise<unknown>;
}

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  register(skill: Skill): void {
    if (!skill.name.trim()) throw new Error('Skill name is required');
    if (this.skills.has(skill.name)) throw new Error(`Skill already registered: ${skill.name}`);
    this.skills.set(skill.name, skill);
  }
  replace(skill: Skill): void {
    if (!skill.name.trim()) throw new Error('Skill name is required');
    this.skills.set(skill.name, skill);
  }
  list(): Array<Pick<Skill, 'name' | 'description' | 'version' | 'source'>> {
    return [...this.skills.values()]
      .map(({ name, description, version, source }) => ({
        name,
        description,
        ...(version ? { version } : {}),
        ...(source ? { source } : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  has(name: string): boolean {
    return this.skills.has(name);
  }
  async dispatch(name: string, input: unknown): Promise<unknown> {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return skill.execute(skill.input.parse(input));
  }
}
