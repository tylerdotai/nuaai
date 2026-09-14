import type { CapabilityManifest } from './capabilities.js';

export interface PromptSection {
  name: string;
  content: string;
}

export interface PromptAssembly {
  sections: PromptSection[];
  systemPrompt: string;
  bytes: number;
}

export interface PromptAssemblyInput {
  identity?: string;
  projectContext?: string;
  memory?: string;
  skills?: string;
  manifest: CapabilityManifest;
}

function capabilityText(manifest: CapabilityManifest): string {
  const registered = manifest.tools.length
    ? manifest.tools
        .map(
          (tool) =>
            `- ${tool.exposedAs ?? tool.name}: ${tool.description} (permission: ${tool.permission})`,
        )
        .join('\n')
    : '- none';
  const dynamic = manifest.dynamicTools.length
    ? manifest.dynamicTools.map((tool) => `- ${tool}`).join('\n')
    : '- none';
  return [
    'Live capability manifest:',
    `Provider: ${manifest.provider}`,
    `Model: ${manifest.model}`,
    `Workspace: ${manifest.workspaceRoot}`,
    `Tool loop: ${manifest.ownsToolLoop ? 'provider-owned tool loop' : 'NUAAI-owned tool loop'}`,
    `Verification policy: ${manifest.verificationPolicy}`,
    `Approved permissions: ${manifest.permissions.join(', ') || 'none'}`,
    `Registered NUAAI tools:\n${registered}`,
    `Dynamic tools exposed to the provider:\n${dynamic}`,
    manifest.ownsToolLoop
      ? 'Provider-native tools are controlled by the provider policy. Do not claim a native tool ran without a lifecycle result.'
      : 'Only the registered tools listed above are available for this run.',
  ].join('\n');
}

export function assembleSystemPrompt(input: PromptAssemblyInput): PromptAssembly {
  const sections: PromptSection[] = [
    {
      name: 'identity',
      content: input.identity?.trim() || 'You are NUAAI, a persistent local-first personal agent.',
    },
    {
      name: 'runtime',
      content: [
        'You are operating inside a durable agent runtime.',
        'Act in the current turn and continue until the request is completed or honestly blocked.',
        'Do not promise future work without performing it in this turn.',
      ].join('\n'),
    },
    { name: 'capabilities', content: capabilityText(input.manifest) },
    {
      name: 'operating_rules',
      content: [
        'Use only capabilities exposed in the live manifest and provider-native tools actually available to the provider.',
        'Use tools when the request requires current, workspace, or external evidence.',
        'Use only verified tool results. Never invent filenames, paths, command output, search results, fetched content, test results, or capabilities.',
        'If a tool fails, report the failure plainly. Do not claim the requested action succeeded.',
        'Never inspect or expose protected runtime files, credentials, databases, environment files, keys, tokens, or passwords.',
        'Provide the final answer after tool execution has ended using only verified results.',
      ].join('\n'),
    },
    { name: 'skills', content: input.skills?.trim() || 'No skills are registered.' },
    {
      name: 'project_context',
      content: input.projectContext?.trim() || 'No additional project context was provided.',
    },
    {
      name: 'memory',
      content: input.memory?.trim()
        ? `Relevant persisted memory:\n${input.memory.trim()}`
        : 'No relevant persisted memory was retrieved for this turn.',
    },
  ];
  const systemPrompt = sections
    .map((section) => `## ${section.name}\n${section.content}`)
    .join('\n\n');
  return { sections, systemPrompt, bytes: Buffer.byteLength(systemPrompt, 'utf8') };
}
