import type { z } from 'zod';

export interface Skill {
  name: string;
  description: string;
  version?: string;
  source?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  triggers?: string[];
  body?: string;
  path?: string;
  enabled?: boolean;
  input: z.ZodType<unknown>;
  execute(input: unknown): unknown | Promise<unknown>;
}

export interface SkillSummary {
  name: string;
  description: string;
  version?: string;
  source?: string;
  license?: string;
  compatibility?: string;
  triggers: string[];
  path?: string;
  enabled?: boolean;
}

export interface LoadedSkill {
  name: string;
  description: string;
  version?: string;
  instructions: string;
  allowedTools: string[];
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function containsTrigger(input: string, trigger: string): boolean {
  const normalizedInput = normalize(input);
  const normalizedTrigger = normalize(trigger);
  return Boolean(normalizedTrigger) && ` ${normalizedInput} `.includes(` ${normalizedTrigger} `);
}

function skillTriggers(skill: Skill): string[] {
  return [...new Set((skill.triggers ?? []).map((trigger) => trigger.trim()).filter(Boolean))];
}

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register(skill: Skill): void {
    if (!skill.name.trim()) throw new Error('Skill name is required');
    if (this.skills.has(skill.name)) throw new Error(`Skill already registered: ${skill.name}`);
    this.skills.set(skill.name, skill);
  }

  registerInstruction(skill: Omit<Skill, 'input' | 'execute'>): void {
    this.register({
      ...skill,
      input: { parse: (value: unknown) => value } as z.ZodType<unknown>,
      execute: async () => ({ name: skill.name, instructions: skill.body ?? '' }),
    });
  }

  replace(skill: Skill): void {
    if (!skill.name.trim()) throw new Error('Skill name is required');
    this.skills.set(skill.name, skill);
  }

  list(): SkillSummary[] {
    return [...this.skills.values()]
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        ...(skill.version ? { version: skill.version } : {}),
        ...(skill.source ? { source: skill.source } : {}),
        ...(skill.license ? { license: skill.license } : {}),
        ...(skill.compatibility ? { compatibility: skill.compatibility } : {}),
        triggers: skillTriggers(skill),
        ...(skill.path ? { path: skill.path } : {}),
        enabled: skill.enabled,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  enable(name: string): void {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    this.skills.set(name, { ...skill, enabled: true });
  }

  disable(name: string): void {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    this.skills.set(name, { ...skill, enabled: false });
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  match(input: string, limit = 4): Skill[] {
    return [...this.skills.values()]
      .filter((skill) => skill.enabled !== false)
      .map((skill) => {
        const triggers = skillTriggers(skill);
        const score =
          triggers.reduce(
            (total, trigger) => total + (containsTrigger(input, trigger) ? 10 : 0),
            0,
          ) + (containsTrigger(input, skill.name) ? 5 : 0);
        return { skill, score };
      })
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.skill.name.localeCompare(right.skill.name),
      )
      .slice(0, limit)
      .map(({ skill }) => skill);
  }

  search(query: string, limit = 8): SkillSummary[] {
    const summaries = new Map(this.list().map((skill) => [skill.name, skill]));
    return this.match(query, limit)
      .map((skill) => summaries.get(skill.name))
      .filter((skill): skill is SkillSummary => Boolean(skill));
  }

  load(name: string, availableTools?: ReadonlySet<string>): LoadedSkill {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    const requiredTools = skill.allowedTools ?? [];
    const unavailable = availableTools
      ? requiredTools.filter((tool) => !availableTools.has(tool))
      : [];
    if (unavailable.length)
      throw new Error(`Skill ${name} requires unavailable tools: ${unavailable.join(', ')}`);
    return {
      name: skill.name,
      description: skill.description,
      ...(skill.version ? { version: skill.version } : {}),
      instructions: skill.body ?? '',
      allowedTools: requiredTools,
    };
  }

  promptContext(input: string, maxBytes = 30_000, availableTools?: ReadonlySet<string>): string {
    const catalog = this.list()
      .map(
        (skill) =>
          `- ${skill.name}: ${skill.description}${skill.triggers.length ? ` (trigger words: ${skill.triggers.join(', ')})` : ''}`,
      )
      .join('\n');
    const matched = this.match(input);
    const activated: string[] = [];
    const skipped: string[] = [];
    let bytes = 0;
    for (const skill of matched) {
      let loaded: LoadedSkill;
      try {
        loaded = this.load(skill.name, availableTools);
      } catch (error) {
        skipped.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      const body = loaded.instructions.trim();
      if (!body) continue;
      const section = `## ${skill.name}\n${body}`;
      const nextBytes = Buffer.byteLength(section, 'utf8');
      if (bytes + nextBytes > maxBytes) break;
      activated.push(section);
      bytes += nextBytes;
    }
    return [
      'Available skills (metadata loaded; full instructions activate on trigger-word match):',
      catalog || '- None registered.',
      activated.length ? `Activated skills for this input:\n\n${activated.join('\n\n')}` : '',
      skipped.length ? `Skills not activated:\n- ${skipped.join('\n- ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async dispatch(name: string, input: unknown): Promise<unknown> {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return skill.execute(skill.input.parse(input));
  }
}
