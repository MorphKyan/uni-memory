import { z } from 'zod';

export const namespaceSchema = z.string().min(1).max(160)
  .regex(/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/);
export const memoryType = z.enum(['preference', 'fact', 'decision', 'status']);
export const verificationSchema = z.enum(['confirmed', 'pending']);
export const scopeShape = {
  namespaces: z.array(namespaceSchema).min(1).max(20),
  include_descendants: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  type: memoryType.optional(),
  verification: verificationSchema.optional(),
};
export const scopeSchema = z.object(scopeShape).strict();
export type MemoryScope = z.output<typeof scopeSchema>;

export function scopeSql(scope: MemoryScope, start: number) {
  const [ns, descendants, tags, type, verification] = Array.from({ length: 5 }, (_, i) => `$${start + i}`);
  return {
    sql: `(namespace=ANY(${ns}::text[]) OR (${descendants}::boolean AND EXISTS (
      SELECT 1 FROM unnest(${ns}::text[]) AS scopes(parent)
      WHERE left(namespace,length(parent)+1)=parent||'/')))
      AND tags @> ${tags}::text[] AND (${type}::text IS NULL OR type=${type})
      AND (${verification}::text IS NULL OR verification=${verification})`,
    values: [scope.namespaces, scope.include_descendants, scope.tags, scope.type ?? null, scope.verification ?? null],
  };
}

export function namespacePaths(namespace: string) {
  return namespace.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));
}
