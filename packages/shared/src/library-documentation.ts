export interface DocumentationPage { url: string; title: string; section: string }
export interface DocumentationManifest { rootUrl: string; locale: 'en' | 'ru'; pages: DocumentationPage[] }
export interface DocumentationSection { prefix: string; parent: string | null; title: string; pageCount: number; reference: boolean }
export type DocumentationState = 'draft' | 'queued' | 'running' | 'completed' | 'attention' | 'cancelled';
export type DocumentationSchedule = 'off' | 'daily' | 'weekly';
export interface DocumentationResult {
  added: number; updated: number; unchanged: number; failed: number; missing: number; completedAt: string;
}
export function documentationPeriod(schedule: DocumentationSchedule): number | null {
  return schedule === 'daily' ? 86_400_000 : schedule === 'weekly' ? 7 * 86_400_000 : null;
}

/** Most-specific include/exclude wins; exclusions use a leading !. */
export function documentationRuleSelected(section: string, rules: readonly string[]): boolean {
  let length = -1, selected = false;
  for (const rule of rules) {
    const excluded = rule.startsWith('!'), prefix = excluded ? rule.slice(1) : rule;
    if (section.startsWith(prefix) && prefix.length >= length) { length = prefix.length; selected = !excluded; }
  }
  return selected;
}
