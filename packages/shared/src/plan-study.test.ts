import { expect, test } from 'bun:test';
import { studyModule } from './plan-study';

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

test('an error with a null code is unavailable', () => {
  expect(studyModule([
    { sourceId: 'closed', title: 'Closed page', status: 'error', errorCode: null },
  ])).toEqual({
    status: 'unavailable',
    sources: [{ sourceId: 'closed', title: 'Closed page', openable: false }],
  });
});
