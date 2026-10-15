'use client';
import type { AssistantObjectRef } from '@reomi/shared';
import { useT } from '@/lib/i18n';
import { NNBtn } from '../ui';
import { askAssistant } from './assistant-provider';

/** Attaching context is navigation into the shared assistant, not a domain write. */
export function AssistantAskButton({ object, compact = false }: { object: AssistantObjectRef; compact?: boolean }) {
  const t = useT();
  const label = t('assistant.askObject');
  return <NNBtn type="button" variant="ghost" size="sm" icon="chat" ariaLabel={label} title={label}
    onClick={() => askAssistant({ ref: object })}>{compact ? undefined : label}</NNBtn>;
}
