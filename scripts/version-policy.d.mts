export interface VersionTagPolicyInput {
  version: string;
  exactTags: string[];
  githubRef?: string;
}

export function validateVersionTagPolicy(input: VersionTagPolicyInput): string;
