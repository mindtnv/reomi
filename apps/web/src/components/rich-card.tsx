'use client';

// RichCard — the single card-render component for every display sink (review,
// editor preview, note-type preview). It OWNS the full render pipeline and the
// ASYNC mermaid lifecycle (Step 6b, plan H1/CR1):
//
//   1. It calls `renderCardHtmlWithMermaid` ONCE (the single pipeline owner — no
//      second place collects mermaid sources, so the two can never drift), getting
//      back safe HTML with mermaid blocks left as inert placeholders + the list of
//      mermaid sources.
//   2. In an effect it lazy-loads `mermaid` (a large package — kept out of the
//      shared bundle), renders each source to an SVG, runs THAT SVG through the
//      dedicated `sanitizeMermaidSvg` sink, and stashes the result in state.
//   3. It renders through `<SafeHtml>` (the ONE HTML inject node in the app),
//      passing the sanitized SVG islands so they are substituted AFTER the main
//      sanitize (`<svg>` is not in the main allow-list — substituting before would
//      strip it). The single-inject-node invariant holds: RichCard introduces NO
//      second sink, it only manages the island swap around the same `SafeHtml`.
//
// Simplification for n=1 (plan H1): the mermaid render is NOT idempotent across
// re-mounts — it always renders from source (keyed by the per-render placeholder),
// no stash-restore double pass like KaTeX. The cost is a re-render on re-mount,
// acceptable for the current scale. KaTeX idempotency is unaffected (it lives
// inside `renderCardHtml`).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  renderCardHtmlWithMermaid,
  sanitizeMermaidSvg,
  SafeHtml,
  type ContentBlock,
} from '@/lib/render-card';
import { useT } from '@/lib/i18n';
import { mermaidTheme } from '@/lib/mermaid-theme';
import { useCodeCopyButtons } from './chat/code-copy';
import type { FieldValues, NoteTypeDef } from '@reomi/shared';

export interface RichCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Note-type (kind + templates) — same shape `renderCardHtml` consumes. */
  noteType: Pick<NoteTypeDef, 'kind' | 'templates'>;
  /** The note's field values (markdown source). */
  fieldValues: FieldValues;
  /** Which side of the card to render. */
  side: 'front' | 'back';
  /** Which template generates the card (defaults to 0). */
  templateOrd?: number;
  clozeNumber?: number | null;
}

// Escape a plain text string for safe insertion into the static error island
// (the only HTML RichCard itself emits — the i18n message, never user content).
function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Only escaped text is added to the one trusted render sink; never parser HTML/errors. */
function failureIsland(block: ContentBlock, heading: string, advice: string): string {
  return `<div class="nn-content-error" role="note"><strong>${escapeText(heading)}</strong><p>${escapeText(advice)}</p><pre><code>${escapeText(block.source)}</code></pre></div>`;
}

// Mermaid configuration is global: keep each initialize/render pair together.
let diagramQueue: Promise<unknown> = Promise.resolve();
function queueDiagram<T>(render: () => Promise<T>): Promise<T> {
  const result = diagramQueue.then(render, render);
  diagramQueue = result.catch(() => {});
  return result;
}

export const RichCard = ({
  noteType,
  fieldValues,
  side,
  templateOrd = 0,
  clozeNumber = 0,
  ...rest
}: RichCardProps) => {
  const t = useT();
  // ONE pipeline call (the single owner). Memoized on the render inputs so the
  // mermaid effect only re-runs when the actual content changes.
  const { html, mermaid, mathErrors = [], error } = useMemo(
    () => renderCardHtmlWithMermaid(noteType, fieldValues, side, templateOrd, clozeNumber),
    [noteType, fieldValues, side, templateOrd, clozeNumber],
  );

  // placeholder-key → sanitized SVG (or a static error island). Keys not yet in
  // the map stay as inert placeholder text (a brief "loading" state) in SafeHtml.
  const [islands, setIslands] = useState<Map<string, string>>(new Map());
  const readTheme = () => typeof document === 'undefined' ? 'default:dark' : `${document.documentElement.dataset.theme ?? 'default'}:${document.documentElement.dataset.themeMode ?? 'dark'}`;
  const [diagramTheme, setDiagramTheme] = useState(readTheme);

  useEffect(() => {
    if (!mermaid.length) return;
    const update = () => setDiagramTheme(readTheme());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-mode'] });
    return () => observer.disconnect();
  }, [mermaid.length]);

  useEffect(() => {
    if (mermaid.length === 0) {
      // No diagrams — clear any stale islands from a previous content render.
      setIslands((prev) => (prev.size > 0 ? new Map() : prev));
      return;
    }
    setIslands(new Map());
    let cancelled = false;
    const next = new Map<string, string>();
    (async () => {
      let mermaidApi: typeof import('mermaid').default;
      try {
        // Lazy import — mermaid is a large package, kept out of the shared bundle.
        mermaidApi = (await import('mermaid')).default;

      } catch {
        for (const block of mermaid) {
          next.set(block.key, failureIsland(block, t('editor.richText.diagramAt', block), t('editor.richText.diagramUnavailable')));
        }
        if (!cancelled) setIslands(next);
        return;
      }
      for (const block of mermaid) {
        const { key, source } = block;
        if (cancelled) return;
        try {
          // A unique DOM id per render call (mermaid injects a scratch node).
          const id = `nnmmd-${key}`;
          const { svg } = await queueDiagram(async () => {
            if (cancelled) return { svg: '' };
        mermaidApi.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: 'base',
          themeVariables: mermaidTheme(...diagramTheme.split(':') as [string, string]),
          // Render labels as native SVG `<text>`, NOT as HTML inside
          // `<foreignObject>` (the SVG→HTML XSS escape hatch the mermaid sink
          // forbids — see MERMAID_DOMPURIFY_CONFIG). Without this, flowchart /
          // state labels live in foreignObject and get stripped → blank nodes.
          // Root-level `htmlLabels` is the canonical v11 setting (it supersedes
          // the deprecated per-diagram `flowchart.htmlLabels`) and applies across
          // flowchart / class / state diagrams.
          htmlLabels: false,
        });
            return mermaidApi.render(id, source);
          });
          const safe = sanitizeMermaidSvg(svg);
          next.set(key, `<div class="nn-mermaid">${safe}</div>`);
        } catch {
          // Source and parser exceptions must not leak through the browser console.
          next.set(key, failureIsland(block, t('editor.richText.diagramAt', block), t('editor.richText.diagramSyntax')));
        }
      }
      if (!cancelled) setIslands(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [mermaid, t, diagramTheme]);

  const codeHost = useRef<HTMLDivElement>(null);
  const codeLabels = useMemo(() => ({ copy: t('chat.message.codeCopy'), copied: t('chat.message.codeCopied') }), [t]);
  useCodeCopyButtons(codeHost, { html: html + [...islands.values()].join(''), final: true }, codeLabels);
  if (error) return <div {...rest} role="alert">{t('editor.errors.invalidCloze')}</div>;
  const visibleIslands = new Map(mermaid.map(({ key }) => [key, islands.get(key)
    ?? `<div class="nn-mermaid" role="status">${escapeText(t('states.loading'))}</div>`]));
  for (const block of mathErrors) visibleIslands.set(block.key, failureIsland(block, t('editor.richText.mathAt', block), t('editor.richText.mathSyntax')));
  return <SafeHtml hostRef={codeHost} html={html} mermaidIslands={visibleIslands} {...rest} />;

};
