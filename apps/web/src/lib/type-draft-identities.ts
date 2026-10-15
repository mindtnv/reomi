import { newUuidV7 } from '@reomi/shared';

type Item = { id?: string; ord: number; draftKey?: string };
export const withDraftKeys = <T extends Item>(items: T[]): (T & { draftKey: string })[] =>
  items.map(item => ({ ...item, draftKey: item.draftKey ?? item.id ?? newUuidV7() }));
export function withoutDraftKey<T extends Item>(item: T): Omit<T, 'draftKey'> {
  const { draftKey: _key, ...wire } = item; return wire;
}
/** Bridge server-assigned identities by immutable local keys, never by the
 * newer buffer's order/name. A lost create reply may precede further editing. */
export function adoptTypeIdentities<T extends { fields: Item[]; templates: Item[] }>(live: T, submitted: T, saved: { fields: Item[]; templates: Item[] }): T {
  const adopt = <I extends Item>(current: I[], before: Item[], after: Item[]) => {
    const ids = new Map(before.map(item => [item.draftKey ?? item.id ?? `ord:${item.ord}`, after.find(row => row.ord === item.ord)?.id]));
    return current.map(item => { const id = ids.get(item.draftKey ?? item.id ?? `ord:${item.ord}`); return id ? { ...item, id } : item; });
  };
  return { ...live, fields: adopt(live.fields, submitted.fields, saved.fields), templates: adopt(live.templates, submitted.templates, saved.templates) };
}
