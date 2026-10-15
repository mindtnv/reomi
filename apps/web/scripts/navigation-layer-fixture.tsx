'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */
import React from 'react';
import { Modal } from '@/components/design-system/modal';
import { useNavigationGuard, useAppNavigation } from '@/components/navigation';
import { useDialog } from '@/components/dialog';

export function LayerProof() {
  const [open, setOpen] = React.useState(false);
  return <><button onClick={() => setOpen(true)}>Open layer</button>
    <Modal open={open} title="Layer editor" closeLabel="Close layer" onClose={() => setOpen(false)}>
      {open && <LayerEditor />}
    </Modal></>;
}
function LayerEditor() {
  const [child, setChild] = React.useState(false), [draft, setDraft] = React.useState('');
  const dialog = useDialog(), navigation = useAppNavigation();
  useNavigationGuard(async () => !draft || await dialog.confirm({ title: 'Discard layer draft?', confirmLabel: 'Discard layer', cancelLabel: 'Keep layer' }));
  return <><textarea aria-label="Layer draft" value={draft} onChange={event => setDraft(event.target.value)} />
    <button onClick={() => setChild(true)}>Open nested layer</button>
    <button onClick={() => navigation.replace('/cards', { viewOnly: true, track: false })}>Consume layer query</button>
    <button onClick={() => navigation.push('/library')}>Layer Library</button>
    <Modal open={child} title="Nested layer" closeLabel="Close nested layer" onClose={() => setChild(false)}><button>Nested action</button></Modal>
  </>;
}
