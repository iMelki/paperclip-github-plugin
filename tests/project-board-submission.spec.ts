import { strict as assert } from 'node:assert';
import test from 'node:test';
import { reconcileSubmission } from '../src/project-board-submission.ts';

const id = (digit: string) => digit.repeat(64);
const submission = { operationIds: [id('a'), id('b'), id('c')], reconciled: false };

test('a complete result reconciles the submission and keeps every identifier', () => {
  const result = { complete: true, results: submission.operationIds.map(operationId => ({ operationId })) };
  assert.deepEqual(reconcileSubmission(submission, result), { ...submission, reconciled: true });
});

test('deferred items that never began an operation are dropped from later recovery', () => {
  const result = { complete: false, results: [{ operationId: id('a') }, { operationId: id('b') }] };
  const next = reconcileSubmission(submission, result);
  assert.deepEqual(next.operationIds, [id('a'), id('b')]);
  assert.equal(next.reconciled, false);
});

test('recovery of the retained operations can then complete the submission', () => {
  const held = reconcileSubmission(submission, { complete: false, results: [{ operationId: id('a') }, { operationId: id('b') }] });
  const recovered = reconcileSubmission(held, { complete: true, results: held.operationIds.map(operationId => ({ operationId })) });
  assert.equal(recovered.reconciled, true);
  assert.deepEqual(recovered.operationIds, [id('a'), id('b')]);
});

test('conflict rows without an operation do not widen or empty the retained identifiers', () => {
  const next = reconcileSubmission(submission, { complete: false, results: [{ operationId: null }, { operationId: id('c') }] });
  assert.deepEqual(next.operationIds, [id('c')]);
});

test('a result with no attempted operation keeps the original identifiers and stays unreconciled', () => {
  const next = reconcileSubmission(submission, { complete: false, results: [{ operationId: null }] });
  assert.deepEqual(next.operationIds, submission.operationIds);
  assert.equal(next.reconciled, false);
});
