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
  /\b(?:do you have|what do you need|what tools?|what access|full tooling|capabilit(?:y|ies)|are you able to|can you)\b/i;

export function classifyVerificationPolicy(input: string): VerificationPolicy {
  if (explicitNoToolRequest.test(input) || capabilityQuestion.test(input)) return 'none';
  if (
    (/\b(?:memory|memories)\b/i.test(input) &&
      /\b(?:store|save|forget|delete|remove|clear|update)\b/i.test(input)) ||
    /\bremember\s+(?:that|this|my|to)\b/i.test(input)
  )
    return 'memory_mutation';
  if (
    /\b(?:send|post|publish|invite|schedule|dispatch|create|write|edit|update|delete|remove|install|download)\b/i.test(
      input,
    ) &&
    /\b(?:email|message|matrix|discord|telegram|github|pull request|issue|remote|external|public|production|schedule|task|file|workspace)\b/i.test(
      input,
    )
  )
    return 'external_side_effect';
  if (
    /\b(?:check|list|run|inspect|read|look(?:\s+up)?|verify|find|show|fetch|query|pull|test|execute|count)\b/i.test(
      input,
    ) &&
    /\b(?:github|git|repo(?:sitory)?|cli|command|workspace|file|folder|directory|host|server|process|port|model|ollama|docker|matrix|element|browser|desktop|status|health|log(?:s)?|installed|available|tool(?:s|ing)?|capabilit(?:y|ies))\b/i.test(
      input,
    )
  )
    return 'workspace_state';
  if (
    /\b(?:latest|current|today|tonight|news|breaking|recent|live|score|weather|price|online|web|internet|fight|match)\b/i.test(
      input,
    )
  )
    return 'current_information';
  return 'none';
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

export function verificationRequiresEvidence(policy: VerificationPolicy): boolean {
  return policy !== 'none';
}
