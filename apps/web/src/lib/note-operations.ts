import type { UiActionResult } from '@reomi/shared';
import { apiBaseURL, ApiError, apiErrorFromResponse } from './api';
import { useNN } from './store';

const owned = (owner: string) => Boolean(owner) && useNN.getState().profile?.userId === owner;

function noteAction(
  operationId: string,
  result: { note: { id: string; updatedAt?: string }; cards: unknown[] },
  replayed: boolean,
  outcome: UiActionResult['outcome'] = 'applied',
): UiActionResult {
  const version = typeof result.note.updatedAt === 'string' ? result.note.updatedAt : new Date().toISOString();
  return {
    outcome,
    replayed,
    result,
    serverTime: version,
    receipt: {
      id: operationId,
      requestId: operationId,
      kind: 'card-note-save',
      label: 'Card',
      createdAt: version,
      undoUntil: null,
      consumedAt: null,
      target: { kind: 'card-note', id: result.note.id, revision: version },
    },
  };
}

async function request(owner: string, operationId: string, method: 'GET' | 'POST', body?: unknown) {
  if (!owned(owner)) throw new ApiError('owner_changed', { status: 409 });
  return fetch(`${apiBaseURL}/notes/operations/${operationId}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function readNoteOperation(owner: string, operationId: string): Promise<UiActionResult> {
  const response = await request(owner, operationId, 'GET');
  if (response.status === 404) throw new ApiError('receipt_not_found', { status: 404 });
  if (!response.ok) throw await apiErrorFromResponse(response);
  const body = await response.json() as { status?: string; result?: { note: { id: string; updatedAt?: string }; cards: unknown[] } };
  if (body.status === 'reverted' || !body.result?.note?.id) throw new ApiError('operation_reverted', { status: 409 });
  return noteAction(operationId, body.result, true);
}

export async function saveNoteOperation(owner: string, operationId: string, input: object): Promise<UiActionResult> {
  const response = await request(owner, operationId, 'POST', input);
  if (response.status === 409) {
    const payload = await response.clone().json().catch(() => null) as { error?: string } | null;
    if (payload?.error === 'operation_conflict') {
      const current = await readNoteOperation(owner, operationId);
      return { ...current, outcome: 'changed' };
    }
    throw await apiErrorFromResponse(response);
  }
  if (!response.ok) throw await apiErrorFromResponse(response);
  const body = await response.json() as { note: { id: string; updatedAt?: string }; cards: unknown[]; replayed?: boolean };
  if (owned(owner) && typeof window !== 'undefined') window.dispatchEvent(new Event('nn:knowledge-changed'));
  return noteAction(operationId, body, Boolean(body.replayed));
}
