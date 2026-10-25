import { useCallback, useMemo } from 'react';
import { micros, reducers, tag, useTable } from '../../hooks/useTable';
import type { ErpPostingView } from './erp';

export interface ErpBatchView {
  id: bigint;
  requestId: string;
  batchRef: string;
  submittedAt: bigint;
  submittedBy: string;
  submittedByName: string;
  target: string;
  requested: number;
  posted: number;
  failed: number;
  skipped: number;
  postedNetCents: number;
  invoiceCents: number;
  creditCents: number;
  recoveryCents: number;
}

/** Live ERP handoff state: postings by ledger entry id, batches newest first, and the submit call. */
export function useErp() {
  const postingRows = useTable('erpPosting');
  const batchRows = useTable('erpBatch');

  const postings = useMemo(() => {
    const map = new Map<string, ErpPostingView>();
    for (const r of postingRows) {
      map.set(String(r.ledgerEntryId), {
        ledgerEntryId: r.ledgerEntryId,
        idempotencyKey: r.idempotencyKey,
        status: tag(r.status) === 'Submitted' ? 'Submitted' : 'Failed',
        batchId: r.batchId,
        externalId: r.externalId,
        erpDocumentId: r.erpDocumentId ?? null,
        attempts: r.attempts,
        error: r.error ?? null,
        updatedAt: micros(r.updatedAt),
      });
    }
    return map;
  }, [postingRows]);

  const batches = useMemo<ErpBatchView[]>(() => batchRows
    .map(r => ({
      id: r.id,
      requestId: r.requestId,
      batchRef: r.batchRef,
      submittedAt: micros(r.submittedAt),
      submittedBy: r.submittedBy.toHexString(),
      submittedByName: r.submittedByName,
      target: r.target,
      requested: r.requested,
      posted: r.posted,
      failed: r.failed,
      skipped: r.skipped,
      postedNetCents: Number(r.postedNetCents),
      invoiceCents: Number(r.invoiceCents),
      creditCents: Number(r.creditCents),
      recoveryCents: Number(r.recoveryCents),
    }))
    .sort((a, b) => Number(b.submittedAt - a.submittedAt)), [batchRows]);

  const batchById = useMemo(() => new Map(batches.map(b => [String(b.id), b])), [batches]);

  const submit = useCallback(async (requestId: string, ids: bigint[], submittedByName: string) => {
    const r = reducers();
    if (!r) throw new Error('Not connected to the database');
    await r.submitToErp({ requestId, ledgerEntryIds: ids, submittedByName });
  }, []);

  return { postings, batches, batchById, submit };
}
