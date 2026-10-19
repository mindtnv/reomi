export interface FolderNode { id: string; parentId: string | null; name: string }

/** Includes the selected folder. A visited set makes damaged trees finite. */
export function folderSubtree<T extends FolderNode>(folders: T[], id: string): T[] {
  const result: T[] = [];
  const pending = [id];
  const visited = new Set<string>();
  const children = new Map<string, T[]>();
  for (const folder of folders) if (folder.parentId) {
    const siblings = children.get(folder.parentId) ?? [];
    siblings.push(folder); children.set(folder.parentId, siblings);
  }
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  while (pending.length) {
    const next = pending.pop()!;
    if (visited.has(next)) continue;
    visited.add(next);
    const folder = byId.get(next);
    if (folder) result.push(folder);
    pending.push(...(children.get(next) ?? []).map(child => child.id));
  }
  return result;
}

export function folderAncestors<T extends FolderNode>(folders: T[], id: string): T[] {
  const path: T[] = [], seen = new Set<string>();
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id); path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}
