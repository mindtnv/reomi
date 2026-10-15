// Library → notebook handoff (L2, Р7). The library reader's «Спросить» action
// hands a selected quote off to a notebook's grounded chat instead of a local
// chat surface (the chat lives only in notebooks). These are the PURE helpers
// behind that flow — notebook selection, the sessionStorage key, and the prefill
// text format — kept DOM-free so they can be unit-tested without a browser.

import { currentStorageKey } from './storage-migration';

/** A notebook an item is attached to (shape from GET /library/items/:id). */
export interface HandoffNotebook {
  id: string;
  title: string;
}

/**
 * Decide how «Спросить» should route given the notebooks a source is attached to:
 *  • exactly one  → go straight to it (`{ kind: 'single', notebookId }`)
 *  • more than one → let the user pick (`{ kind: 'pick', notebooks }`)
 *  • none          → offer to create a notebook (`{ kind: 'create' }`)
 */
export type HandoffPlan =
  | { kind: 'single'; notebookId: string }
  | { kind: 'pick'; notebooks: HandoffNotebook[] }
  | { kind: 'create' };

export function planHandoff(notebooks: HandoffNotebook[]): HandoffPlan {
  if (notebooks.length === 1) return { kind: 'single', notebookId: notebooks[0]!.id };
  if (notebooks.length > 1) return { kind: 'pick', notebooks };
  return { kind: 'create' };
}

/** The sessionStorage key a notebook workspace consumes on mount to prefill its
 *  composer. Per-notebook so two open workspaces don't clobber each other. */
export function prefillKey(notebookId: string): string {
  return currentStorageKey(`nn:nb:prefill:${notebookId}`);
}

/**
 * The composer prefill text for a quote handed off from the library reader. Quotes
 * the passage as a blockquote under a one-line «about this fragment from …» lead so
 * the model has both the citation context and the source title. `sourceTitle` is
 * optional — when absent the lead degrades to a generic phrasing.
 */
export function formatHandoffPrefill(quote: string, sourceTitle?: string | null): string {
  const trimmed = quote.trim();
  const lead = sourceTitle
    ? `Про этот фрагмент из «${sourceTitle}»:`
    : 'Про этот фрагмент:';
  return `${lead}\n\n> ${trimmed}\n\n`;
}
