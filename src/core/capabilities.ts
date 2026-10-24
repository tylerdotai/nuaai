import { createHash } from 'node:crypto';

import type { ProviderAdapter, ProviderDynamicTool } from '../providers/types.js';
import type { PermissionContext } from '../security/permissions.js';
import type { ToolGovernance, ToolRegistry } from '../tools/registry.js';

export type VerificationPolicy =
  | 'none'
  | 'current_information'
  | 'workspace_state'
  | 'external_side_effect'
  | 'memory_mutation';

export interface CapabilityTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permission: 'read' | 'write' | 'execute';
  governance: ToolGovernance;
  source: 'nuaai';
  exposedAs?: string;
}

export interface CapabilityManifest {
  provider: string;
  model: string;
  workspaceRoot: string;
  ownsToolLoop: boolean;
  permissions: string[];
  tools: CapabilityTool[];
  dynamicTools: string[];
  verificationPolicy: VerificationPolicy;
}

export interface CapabilityManifestInput {
  provider: ProviderAdapter;
  model: string;
  root: string;
  permissions: PermissionContext;
  tools: ToolRegistry;
  dynamicTools?: ProviderDynamicTool[];
  verificationPolicy?: VerificationPolicy;
}

const explicitNoToolRequest =
  /\b(?:do not|don't|without|no)\s+(?:use|call|run|execute)\s+(?:any\s+)?tools?\b/i;
const capabilityQuestion =
  /^(?:do you have\b|what (?:tools?|access|capabilit(?:y|ies))\b|what do you need\b)|\b(?:can you|are you able to)\s+.*\b(?:in general|at all)\s*\??$/i;

function structuredHostCommand(
  input: string,
): { intent: string; arguments: Record<string, unknown> } | undefined {
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  const prefix = input.slice(0, start);
  if (
    start < 0 ||
    end < start ||
    !/\b(?:use|call|invoke|execute|run)\s+host\.command\b[^{}]*$/i.test(prefix)
  )
    return undefined;
  let args: unknown;
  try {
    args = JSON.parse(input.slice(start, end + 1));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    typeof (args as Record<string, unknown>).command !== 'string'
  )
    return undefined;
  // Program/stdin bytes are data, not additional user actions or file targets.
  return {
    intent: `${prefix.replace(/(\b(?:use|call|invoke|execute|run)\s+)host\.command\b/i, '$1host command')} [literal CLI arguments] ${input.slice(end + 1)}`,
    arguments: args as Record<string, unknown>,
  };
}

export function beforeDraftMaterial(input: string): string {
  const start = input.search(/\bhere(?:\s+is|['’]s)\b[^:\n]{0,80}\b(?:draft|brief)\b/iu);
  return start >= 0 ? input.slice(0, start) : input;
}

function requestedIntent(input: string): string {
  // A dotted tool/file name is not a sentence boundary inside a prohibition.
  const intent = input.replace(
    /\b(?:do not|don['’]t|never)\s+(?:use|call|run|execute|send|post|publish|invite|schedule|dispatch|create|write|edit|patch|replace|copy|move|rename|trash|update|delete|remove|install|download|modify|change|take|perform|read|inspect|check|search|find|list|fetch|query|test|verify)\b(?:(?!\b(?:but|however|instead|then)\b)(?:\.(?=\w)|[^.!?;\n]))*/gi,
    '',
  );
  const head = beforeDraftMaterial(intent);
  // An explicitly introduced rough brief is writing material, not an execution request.
  // Keep the complete head so separately requested verification/save/send still needs proof.
  return head !== intent &&
    /\b(?:draft|compose|write|give\s+me|create)\b[\s\S]{0,140}\b(?:message|prompt|brief|coding\s+agent|developer)\b/iu.test(
      head,
    )
    ? head
    : intent;
}

export function isCapabilityRefusal(value: string): boolean {
  return (
    /\b(?:i\s+(?:can't|cannot|do not|don't)\s+(?:access|create|send|read|run|have)|what\s+i\s+cannot|not able to|without direct access)\b/i.test(
      value,
    ) || /\b(?:there (?:is|are)|i have)\s+no\b.{0,80}\b(?:tool|access|shell|browser)\b/i.test(value)
  );
}

export function requestDisablesTools(input: string): boolean {
  return explicitNoToolRequest.test(structuredHostCommand(input)?.intent ?? input);
}

export function classifyVerificationPolicy(rawInput: string): VerificationPolicy {
  const invocation = structuredHostCommand(rawInput);
  const input = invocation?.intent ?? rawInput;
  if (
    explicitNoToolRequest.test(input) ||
    capabilityQuestion.test(input) ||
    /^(?:can you|are you able to)\s+(?:read|write|edit)\s+(?:a file|files)\s*\?$/i.test(
      input.trim(),
    )
  )
    return 'none';
  const intent = requestedIntent(input);
  const namesFile = /(?:^|\s|[`"'])(?:[\w./-]+\.[a-z\d]{1,12})(?=$|[\s`"',;!?.])/i.test(intent);
  if (
    namesFile &&
    /\b(?:write|edit|patch|replace|copy|move|rename|trash|create|update|delete|remove)\b/i.test(
      intent,
    )
  )
    return 'external_side_effect';
  if (namesFile && /\b(?:read|inspect|check|find|search|show|verify)\b/i.test(intent))
    return 'workspace_state';
  if (
    (/\b(?:memory|memories)\b/i.test(intent) &&
      /\b(?:store|save|forget|delete|remove|clear|update)\b/i.test(intent)) ||
    /\bremember\s+(?:that|this|my|to)\b/i.test(intent)
  )
    return 'memory_mutation';
  if (
    /\b(?:send|post|publish|invite|schedule|dispatch|create|write|edit|patch|replace|copy|move|rename|trash|update|delete|remove|install|download)\b/i.test(
      intent,
    ) &&
    /\b(?:email|message|matrix|discord|telegram|github|pull request|issue|remote|external|public|production|schedule|task|file|workspace)\b/i.test(
      intent,
    )
  )
    return 'external_side_effect';
  if (
    /\b(?:check|list|run|inspect|read|search|look(?:\s+up)?|verify|find|show|fetch|query|pull|test|execute|count)\b/i.test(
      intent,
    ) &&
    /\b(?:github|git|repo(?:sitory)?|cli|command|workspace|file|folder|directory|host|server|process|port|runtime|model|ollama|docker|matrix|element|browser|desktop|status|health|log(?:s)?|installed|available|tool(?:s|ing)?|capabilit(?:y|ies))\b/i.test(
      intent,
    )
  )
    return 'workspace_state';
  if (
    /\b(?:latest|current|today|tonight|news|breaking|recent|live|score|weather|price|online|web|internet|fight|match)\b/i.test(
      intent,
    )
  )
    return 'current_information';
  return invocation ? 'workspace_state' : 'none';
}

export function buildCapabilityManifest(input: CapabilityManifestInput): CapabilityManifest {
  const registeredTools =
    typeof (input.tools as ToolRegistry & { list?: unknown }).list === 'function'
      ? input.tools.list()
      : input.tools.schemas(input.permissions).map((tool) => ({
          ...tool,
          permission: 'read' as const,
          governance: {
            owner: tool.name.split('.')[0] || 'runtime',
            costClass: 'low' as const,
            authMode: 'none' as const,
            sideEffects: 'unknown' as const,
            approval: 'none' as const,
            maxCallsPerRun: 1,
          },
        }));
  const tools = registeredTools
    .filter((tool) => input.permissions.approved.has(tool.permission))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      permission: tool.permission,
      governance: tool.governance,
      source: 'nuaai' as const,
      ...(input.provider.ownsToolLoop
        ? { exposedAs: `nuaai.${tool.name.replaceAll('.', '_')}` }
        : {}),
    }));
  return {
    provider: input.provider.name,
    model: input.model,
    workspaceRoot: input.root,
    ownsToolLoop: input.provider.ownsToolLoop === true,
    permissions: [...input.permissions.approved].sort(),
    tools,
    dynamicTools: (input.dynamicTools ?? []).map((tool) => `${tool.namespace}.${tool.name}`),
    verificationPolicy: input.verificationPolicy ?? 'none',
  };
}

export interface VerificationObservation {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

/** A conservative provenance gate, not a verifier of arbitrary answer prose. */
export function hasRelevantVerificationEvidence(
  rawInput: string,
  policy: VerificationPolicy,
  observations: VerificationObservation[],
): boolean {
  const invocation = structuredHostCommand(rawInput);
  if (invocation) {
    const keys = ['command', 'args', 'stdin', 'timeoutMs'];
    if (
      !observations.some(
        (row) =>
          row.name === 'host.command' &&
          (row.result as { exitCode?: number } | null)?.exitCode === 0 &&
          keys.every(
            (key) =>
              JSON.stringify(row.arguments[key] ?? (key === 'args' ? [] : undefined)) ===
              JSON.stringify(invocation.arguments[key] ?? (key === 'args' ? [] : undefined)),
          ),
      )
    )
      return false;
  }
  const input = requestedIntent(invocation?.intent ?? rawInput);
  if (policy === 'none') return true;
  const paths = [...input.matchAll(/(?:^|\s|[`"'])([\w./-]+\.[a-z\d]{1,12})(?=$|[\s`"',;!?.])/gi)]
    .filter((match) => {
      // "Use workspace.write" names an invoked tool, not a file to write.
      // Keep actual file targets, including files deliberately named after tools.
      const prefix = input.slice(0, match.index).trimEnd();
      return !(
        observations.some((row) => row.name === match[1]) &&
        /\b(?:use|using|call|via|invoke|execute|run|then)$/i.test(prefix)
      );
    })
    .map((match) => match[1].replace(/^\.\//, ''));
  const coversTargets = (rows: VerificationObservation[]): boolean =>
    paths.length
      ? paths.every((path) =>
          rows.some((row) =>
            [row.arguments.path, row.arguments.destination].some(
              (target) => String(target ?? '').replace(/^\.\//, '') === path,
            ),
          ),
        )
      : rows.length > 0;
  if (policy === 'memory_mutation')
    return observations.some((row) => /^memory\.(?:store|forget)$/.test(row.name));
  if (policy === 'current_information') {
    const subjects =
      input
        .toLowerCase()
        .match(/[a-z\d]{3,}/g)
        ?.filter(
          (word) =>
            !/^(?:what|where|how|the|for|and|current|latest|today|please|tell|give|get|with|from|about|look|search|find|online|internet|can|you|could|would)$/.test(
              word,
            ),
        ) ?? [];
    return observations.some(
      (row) =>
        /^(?:web\.(?:search|fetch)|browser\.open)$/.test(row.name) &&
        subjects.length > 0 &&
        subjects.every((subject) => JSON.stringify(row.arguments).toLowerCase().includes(subject)),
    );
  }
  if (policy === 'external_side_effect') {
    if (paths.length || /\b(?:file|workspace)\b/i.test(input)) {
      return coversTargets(
        observations.filter((write, index) => {
          const subsequent = observations.slice(index + 1);
          const metadata = write.result as { sha256?: string } | null;
          if (write.name === 'workspace.trash')
            return subsequent.some(
              (read) =>
                read.name === 'workspace.stat' &&
                read.arguments.path === write.arguments.path &&
                (read.result as { exists?: boolean })?.exists === false,
            );
          if (write.name === 'workspace.mkdir')
            return subsequent.some(
              (read) =>
                read.name === 'workspace.stat' &&
                read.arguments.path === write.arguments.path &&
                (read.result as { exists?: boolean; type?: string })?.exists === true &&
                (read.result as { type?: string })?.type === 'directory',
            );
          if (
            /\b(?:delete|remove|trash)\b/i.test(input) &&
            !/\b(?:write|edit|copy|move|create)\b/i.test(input)
          )
            return false;
          if (['workspace.edit', 'workspace.copy', 'workspace.move'].includes(write.name)) {
            const target = write.arguments.destination ?? write.arguments.path;
            const verified = subsequent.some(
              (read) =>
                read.name === 'workspace.read' &&
                read.arguments.path === target &&
                typeof read.result === 'string' &&
                createHash('sha256').update(read.result).digest('hex') === metadata?.sha256,
            );
            return (
              verified &&
              (write.name !== 'workspace.move' ||
                subsequent.some(
                  (read) =>
                    read.name === 'workspace.stat' &&
                    read.arguments.path === write.arguments.path &&
                    (read.result as { exists?: boolean })?.exists === false,
                ))
            );
          }
          return (
            write.name === 'workspace.write' &&
            subsequent.some(
              (read) =>
                read.name === 'workspace.read' &&
                read.arguments.path === write.arguments.path &&
                read.result === write.arguments.content,
            )
          );
        }),
      );
    }
    return observations.some(
      (row) =>
        /\.(?:send|post|publish|create|update|delete|remove|cancel|dispatch|invite|store|forget)$/.test(
          row.name,
        ) &&
        row.name
          .split('.')
          .slice(0, -1)
          .some((part) => part.length > 2 && input.toLowerCase().includes(part)),
    );
  }
  if (paths.length || /\b(?:file|contents?)\b/i.test(input)) {
    return coversTargets(
      observations.filter((row) =>
        /^(?:workspace\.(?:read|inspect|stat|search)|media\.inspect)$/.test(row.name),
      ),
    );
  }
  return observations.some((row) => {
    if (row.name === 'workspace.list')
      return /\b(?:list|directory|folder|files|workspace)\b/i.test(input);
    if (row.name === 'workspace.command' || row.name === 'host.command')
      return /\b(?:run|command|host|server|process|port|test|execute|installed)\b/i.test(input);
    return row.name
      .split('.')
      .some(
        (part) =>
          part.length > 2 &&
          !/^(?:list|search|read|status)$/.test(part) &&
          input.toLowerCase().includes(part),
      );
  });
}

export function verificationRequiresEvidence(policy: VerificationPolicy): boolean {
  return policy !== 'none';
}
