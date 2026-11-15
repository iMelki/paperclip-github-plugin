/**
 * An import stops at the first item whose outcome is unverified, so the items after it are deferred and never
 * begin an operation. Only operations that were actually attempted can be read back later. Retaining the
 * deferred identifiers would make recovery report them as unverified forever and keep imports locked.
 */
export interface RetainedSubmission { operationIds: string[]; reconciled: boolean }
export interface SubmissionResult { complete: boolean; results: Array<{ operationId: string | null }> }

export function reconcileSubmission<T extends RetainedSubmission>(submission: T, result: SubmissionResult): T {
  if (result.complete) return { ...submission, reconciled: true };
  const attempted = new Set(result.results.flatMap(row => row.operationId ? [row.operationId] : []));
  const operationIds = submission.operationIds.filter(id => attempted.has(id));
  return { ...submission, operationIds: operationIds.length ? operationIds : submission.operationIds, reconciled: false };
}
