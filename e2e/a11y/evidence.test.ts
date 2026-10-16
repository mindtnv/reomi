import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import {
  bindLedgerToAudit,
  disposition,
  emptySheet,
  focusLabel,
  renderChecklist,
  sheetWithEveryRow,
  type ItemDisposition,
} from './evidence';

const checklistPath = join(import.meta.dir, '../../docs/a11y/r2-115-118.md');
const auditPath = join(import.meta.dir, '../../docs/spaced-repetition-audit-round-2.md');

type MachineObservation = { observed: string; expected: string };
type RejectsMachine = MachineObservation extends Parameters<typeof disposition>[0] ? never : true;
const rejectsMachine: RejectsMachine = true;

test('focusLabel reads the glued rating text the button exposes', () => {
  expect(focusLabel('1AgainForgot≈ 1 min')).toEqual({ kind: 'label', label: '1 Again' });
  expect(focusLabel('2HardRecalled with effort≈')).toEqual({ kind: 'label', label: '2 Hard' });
  expect(focusLabel('3GoodRecalled≈')).toEqual({ kind: 'label', label: '3 Good' });
  expect(focusLabel('4EasyEffortless≈')).toEqual({ kind: 'label', label: '4 Easy' });
  expect(focusLabel('1 Again Forgot ≈ 10m')).toEqual({ kind: 'raw', text: '1 Again Forgot ≈ 10m' });
  expect(focusLabel('Show answer · Space')).toEqual({ kind: 'raw', text: 'Show answer · Space' });
});

test('disposition rejects a machine observation', () => {
  expect(rejectsMachine).toBe(true);
  expect(() => disposition({ observed: '1 Again', expected: '1 Again' } as never)).toThrow(
    'disposition accepts only a human sheet',
  );
});

test('renderChecklist is the committed human sheet', () => {
  const checklist = renderChecklist();
  expect(checklist.startsWith('These VoiceOver, mobile Safari, and installed PWA runs were not executed by the agent.')).toBe(true);
  expect(checklist).toContain('https://github.com/mindtnv/reomi/issues/39');
  expect(checklist).not.toContain('[x]');
  expect(readFileSync(checklistPath, 'utf8')).toBe(checklist);
});

test('an empty human sheet leaves every audit item open', () => {
  const items = disposition(emptySheet());
  expect(items.map((item) => item.id)).toEqual(['R2-115', 'R2-116', 'R2-117', 'R2-118']);
  for (const item of items) expectOpen(item, 'awaiting-human');
});

test('a sheet where every human row passed still leaves the audit open', () => {
  for (const item of disposition(sheetWithEveryRow('pass'))) expectOpen(item, 'human-passed');
});

test('bindLedgerToAudit reads the audit and does not write it', () => {
  const before = readFileSync(auditPath);
  const bound = bindLedgerToAudit(before.toString());
  expect(bound).toEqual({ writesAuditFile: false, writesTasks: false });
  expect(readFileSync(auditPath).equals(before)).toBe(true);
  const missing = before.toString().replace('VoiceOver читает математический смысл', 'VoiceOver пропускает математический смысл');
  expect(() => bindLedgerToAudit(missing)).toThrow('missing pass sentence for R2-115');
});

function expectOpen(item: ItemDisposition, status: ItemDisposition['status']) {
  expect(item.status).toBe(status);
  expect(item.auditCheckbox).toBe('leave-unchecked');
  expect(item.taskChecked).toBe(false);
}
