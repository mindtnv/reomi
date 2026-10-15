'use client';

import { Button } from '@/components/design-system/primitives';

import React from 'react';
import { Modal } from '@/components/design-system/modal';
import { useNavigationGuard, useAppNavigation } from '@/components/navigation';
import { useDialog } from '@/components/dialog';

export function LayerProof() {
  const [open, setOpen] = React.useState(false);
  return <><Button variant="bare" onClick={() => setOpen(true)}>Open layer</Button>
    <Modal open={open} title="Layer editor" closeLabel="Close layer" onClose={() => setOpen(false)}>
      {open && <LayerEditor />}
    </Modal></>;
}
function LayerEditor() {
  const [child, setChild] = React.useState(false), [draft, setDraft] = React.useState('');
  const dialog = useDialog(), navigation = useAppNavigation();
  useNavigationGuard(async () => !draft || await dialog.confirm({ title: 'Discard layer draft?', confirmLabel: 'Discard layer', cancelLabel: 'Keep layer' }));
  return <><textarea aria-label="Layer draft" value={draft} onChange={event => setDraft(event.target.value)} />
    <Button variant="bare" onClick={() => setChild(true)}>Open nested layer</Button>
    <Button variant="bare" onClick={() => navigation.replace('/cards', { viewOnly: true, track: false })}>Consume layer query</Button>
    <Button variant="bare" onClick={() => navigation.push('/library')}>Layer Library</Button>
    <Modal open={child} title="Nested layer" closeLabel="Close nested layer" onClose={() => setChild(false)}><Button variant="bare">Nested action</Button></Modal>
  </>;
}
