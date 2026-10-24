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
  approvalPolicy?: string;
  learning?: { available: boolean; enabled: boolean; mode?: 'automatic' | 'manual' | 'off' };
  execution?: unknown;
  projectContext?: string;
  memory?: string;
  skills?: string;
  transcriptSummary?: string;
  manifest: CapabilityManifest;
}

function capabilityText(manifest: CapabilityManifest): string {
  const registered = manifest.tools.length
    ? manifest.tools
        .map(
          (tool) =>
            `- ${tool.exposedAs ?? tool.name}: ${tool.description} (permission: ${tool.permission}; owner: ${tool.governance.owner}; cost: ${tool.governance.costClass}; auth: ${tool.governance.authMode}; effects: ${tool.governance.sideEffects}; approval: ${tool.governance.approval}; per-run limit: ${tool.governance.maxCallsPerRun})`,
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
    ...(input.execution
      ? [
          {
            name: 'execution_limits',
            content: `${JSON.stringify(input.execution)}\nThese are enforced limits, not provider-capacity or uninterrupted-service guarantees. Continuous policy requires an explicit finite owner allowance; never raise it or infer it from quoted text. Per-request deadlines remain independent of the overall objective.`,
          },
        ]
      : []),
    {
      name: 'operating_rules',
      content: [
        'Use only capabilities exposed in the live manifest and provider-native tools actually available to the provider.',
        'Use tools when the request requires current, workspace, or external evidence.',
        'For facts or files, inspect or search; act on harmless lookups rather than asking. Ask one focused question for materially consequential ambiguity, and check authorization before external or destructive changes.',
        `The current session approval mode is ${input.approvalPolicy ?? 'manual'}. The daemon enforces it independently of permission profiles; tools cannot change it. When uncertain about authorization, set requestApproval: true on the proposed tool call to request human review. Unguarded skips prompts, not protected paths or availability checks.`,
        'For installed CLIs such as Himalaya, use host.command when exposed. workspace.command is intentionally read-oriented and is not the only execution tool. Discover exact executable paths with which if needed. A filename or installed binary is not proof of successful execution; inspect command results before claiming completion. Host command failures after launch must not be retried without checking possible side effects.',
        'Use only verified tool results. Never invent filenames, paths, command output, search results, fetched content, test results, or capabilities.',
        'If a tool fails, report the failure plainly. Do not claim the requested action succeeded.',
        'Use runtime.inspect when exposed to inspect this run, its actual context/permissions/learning state and recorded failures. Archived observation references are paged under section observations; retrieve exact call IDs with section observation. Do not invent internal state or reasoning. Follow recorded executionState and recovery: repair known non-executions with a new valid request; never retry or evade an uncertain-effect fence. Identical payloads do not prove a no-op.',
        input.learning?.mode === 'off'
          ? 'Learning is off: do not save new agent memory or evade that setting through another tool. Existing knowledge remains reviewable; the user must explicitly change the setting before new memory saves.'
          : input.learning?.available && input.learning.enabled
            ? 'Selective automatic learning runs separately after verified completion. Do not proactively call memory.store just to acknowledge a preference: continue the user task and let the learner review durable evidence. Use memory.store for an explicit save request, defaulting to workspace scope. Do not claim a note was saved without a persisted result; ordinary turns need no memory operation.'
            : 'Automatic learning is not active. Use explicit memory operations only when the user asks to save or change durable knowledge; do not imply an automatic save occurred.',
        'For a failed background task, use task.inspect when available to retrieve the recorded run failure and correlation before explaining the cause. Never guess from status alone or claim details are unavailable without inspecting. If linkage is missing or ambiguous, state that limit explicitly.',
        'Try a reasonable available alternative after a failed lookup, then state the actual limit. Conversation and memory preserve task context, not fresh evidence; unrelated successful calls do not verify the requested facts. Read back writes before claiming completion.',
        'Use workspace.edit for one unique exact text replacement; workspace.copy/move refuse overwrites. Use workspace.trash, never shell deletion, to remove regular files recoverably. Verify edits/copies by workspace.read and trash/move source removal by workspace.stat. Use workspace.mkdir then workspace.stat to verify a directory.',
        'Never inspect or expose protected runtime files, credentials, databases, environment files, keys, tokens, or passwords.',
        'Provide the final answer after tool execution has ended using only verified results.',
      ].join('\n'),
    },
    ...(input.transcriptSummary?.trim()
      ? [{ name: 'transcript_summary', content: input.transcriptSummary.trim() }]
      : []),
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
