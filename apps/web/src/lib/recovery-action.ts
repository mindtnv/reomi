export interface RecoveryAction { path: string; method: 'POST' | 'PATCH'; args: Record<string, unknown>; draft?: object }
export function isRecoveryAction(value: unknown): value is RecoveryAction {
  const v = value as RecoveryAction | null;
  return Boolean(v && typeof v.path === 'string' && v.path.length <= 200 && /^\/(?:(?:card-notes|note-types)(?:\/[A-Za-z0-9-]+)?(?:\/kind)?|notes\/operations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(v.path)
    && ['POST', 'PATCH'].includes(v.method) && v.args && typeof v.args === 'object' && !Array.isArray(v.args)
    && (v.draft === undefined || v.draft && typeof v.draft === 'object' && !Array.isArray(v.draft)));
}
