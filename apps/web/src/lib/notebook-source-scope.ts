import { isSourceTextReadable } from '@reomi/shared';
type SourceState = { id: string; status: string; errorCode?: string | null };
export function restoreNotebookSourceScope(sources: readonly SourceState[], saved: unknown): Set<string> {
  const readable = sources.filter(source => isSourceTextReadable(source.status, source.errorCode)).map(source => source.id);
  return new Set(Array.isArray(saved) && saved.every(id => typeof id === 'string')
    ? readable.filter(id => saved.includes(id)) : readable);
}
export function newlyReadableNotebookSources(previous: readonly SourceState[], updates: readonly SourceState[]): string[] {
  const old = new Map(previous.map(source => [source.id, source]));
  return updates.filter(source => {
    const before = old.get(source.id);
    return before && !isSourceTextReadable(before.status, before.errorCode) && isSourceTextReadable(source.status, source.errorCode);
  }).map(source => source.id);
}
