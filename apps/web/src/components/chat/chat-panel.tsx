'use client';

// Existing route/notebook entry points share the shell-owned assistant runtime.
// Transcript rendering lives in chat-presentation; no page owns a stream.
import React from 'react';
import type { SourceCitation } from '@reomi/shared';
import { AssistantPageEntry, NotebookAssistantEntry } from './assistant-entry';

export interface ComposerPrefillHandle {
  /** Append text to the composer draft and focus it (no auto-send). */
  prefill: (text: string) => void;
}

export interface ChatPanelProps {
  /** 'global' = the /chat screen (rail + extras); 'notebook' = workspace panel. */
  mode?: 'global' | 'notebook';
  /** Notebook id this panel's threads are bound to (notebook mode only). */
  notebookId?: string;
  /** Per-turn source scope from the workspace checkboxes (notebook mode only).
   *  Undefined ⇒ the server defaults to all ready sources of the notebook. */
  sourceIds?: string[];
  /** Controlled active thread id (notebook mode — the workspace owns the switcher). */
  activeThreadId?: string | null;
  /** Notify the workspace when the open thread changes (notebook mode). */
  onThreadChange?: (id: string | null) => void;
  /** A source citation chip was clicked — workspace scrolls the reader to it. */
  onSourceCitation?: (c: SourceCitation) => void;
  /** Parent-owned ref the panel populates with an imperative `prefill(text)`
   *  (M5 reader «Спросить»). Additive — the global chat never passes it. */
  composerPrefillRef?: React.MutableRefObject<ComposerPrefillHandle | null>;
  /** «В заметки» (Р7) — save a finished assistant answer into the notebook's
   *  notes. ADDITIVE; the button renders ONLY when this prop is passed (notebook
   *  mode). The global /chat never passes it, so nothing changes there. */
  onSaveAnswer?: (payload: {
    content: string;
    citations: unknown[];
    messageId?: string;
  }) => void;
  /** Suggested-question pills for the empty state of a NEW notebook thread (N2,
   *  Р6). ADDITIVE — rendered ONLY in notebook mode (the global /chat builds its
   *  own deck/due suggestions). A click sends the question directly. */
  suggestedQuestions?: string[];
  /** Regenerate the notebook's suggested questions (A2 «Обновить подсказки»).
   *  ADDITIVE — the «Обновить подсказки» ghost button renders in the notebook
   *  empty state ONLY when this prop is passed. The workspace wires it to its
   *  overview regenerate; not passed ⇒ the button is hidden. */
  onRefreshSuggestions?: () => Promise<void> | void;
}


export const ChatPanel = (props: ChatPanelProps = {}) => props.mode === 'notebook' ? <NotebookAssistantEntry {...props}/> : <AssistantPageEntry/>;
