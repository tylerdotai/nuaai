import { z } from 'zod';

export const pluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().min(1),
  apiVersion: z.string().min(1),
  entry: z.string().default('index.mjs'),
  capabilities: z.array(z.enum(['filesystem', 'subprocess', 'network', 'secrets'])).default([]),
  dependencies: z.record(z.string()).default({}),
  config: z.record(z.unknown()).default({}),
  trusted: z.boolean().default(false),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
