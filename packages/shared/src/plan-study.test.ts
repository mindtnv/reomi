import { expect, test } from 'bun:test';
import { parseNotebookPlan, studyModule } from './plan-study';

test('no facts are an empty module', () => {
  expect(studyModule([])).toEqual({ status: 'empty', sources: [] });
});

test('a pending page beside a ready page stays ingesting', () => {
  expect(studyModule([
    { sourceId: 'pending', title: 'Draft page', status: 'pending', errorCode: null },
    { sourceId: 'ready', title: 'Ready page', status: 'ready', errorCode: null },
  ])).toEqual({
    status: 'ingesting',
    sources: [
      { sourceId: 'pending', title: 'Draft page', openable: false },
      { sourceId: 'ready', title: 'Ready page', openable: true },
    ],
  });
});

test('indexing is readable', () => {
  expect(studyModule([
    { sourceId: 'indexing', title: 'Indexing page', status: 'indexing', errorCode: null },
  ])).toEqual({
    status: 'readable',
    sources: [{ sourceId: 'indexing', title: 'Indexing page', openable: true }],
  });
});

test('an index failure is readable', () => {
  expect(studyModule([
    { sourceId: 'failed', title: 'Index failed page', status: 'error', errorCode: 'index_failed' },
  ])).toEqual({
    status: 'readable',
    sources: [{ sourceId: 'failed', title: 'Index failed page', openable: true }],
  });
});

test('a parse failure is unavailable', () => {
  expect(studyModule([
    { sourceId: 'bad', title: 'Broken page', status: 'error', errorCode: 'parse_failed' },
  ])).toEqual({
    status: 'unavailable',
    sources: [{ sourceId: 'bad', title: 'Broken page', openable: false }],
  });
});

test('every planned page is planned, not unavailable', () => {
  expect(studyModule([
    { sourceId: 'later', title: 'Gamma page', status: 'planned', errorCode: null },
    { sourceId: 'after', title: 'Delta page', status: 'planned', errorCode: null },
  ])).toEqual({
    status: 'planned',
    sources: [
      { sourceId: 'later', title: 'Gamma page', openable: false },
      { sourceId: 'after', title: 'Delta page', openable: false },
    ],
  });
});

test('a planned page beside a ready page is readable', () => {
  expect(studyModule([
    { sourceId: 'later', title: 'Gamma page', status: 'planned', errorCode: null },
    { sourceId: 'ready', title: 'Ready page', status: 'ready', errorCode: null },
  ]).status).toBe('readable');
});

test('a planned page beside a parse failure is unavailable', () => {
  expect(studyModule([
    { sourceId: 'later', title: 'Gamma page', status: 'planned', errorCode: null },
    { sourceId: 'bad', title: 'Broken page', status: 'error', errorCode: 'parse_failed' },
  ]).status).toBe('unavailable');
});

test('a stored plan accepts a planned module', () => {
  const plan = parseNotebookPlan({
    notebook: { id: 'notebook', title: 'Learn' },
    plan: {
      id: 'plan',
      userId: 'user',
      goal: 'Learn',
      level: null,
      modules: [{
        id: 'module',
        position: 2,
        title: 'Gamma',
        outcome: 'Read the gamma page',
        prerequisiteIds: [],
        status: 'planned',
        sources: [{ sourceId: 'source', title: 'gamma', openable: false }],
      }],
    },
  });
  expect(plan.plan.modules[0]?.status).toBe('planned');
});

test('an error with a null code is unavailable', () => {
  expect(studyModule([
    { sourceId: 'closed', title: 'Closed page', status: 'error', errorCode: null },
  ])).toEqual({
    status: 'unavailable',
    sources: [{ sourceId: 'closed', title: 'Closed page', openable: false }],
  });
});
