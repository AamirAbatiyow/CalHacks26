import { Send } from 'lucide-react';
import { useTechMode } from '../../hooks/useTechMode';
import { compactUsd } from '../../ui/CountUp';
import { ERP_MAPPING, erpPayload, erpTime, type EntryKind, type ErpEntry, type ErpPostingView, type ErpState, type StateTotals } from './erp';
import type { ErpBatchView } from './useErp';

interface ErpPanelProps {
  totals: Record<ErpState, StateTotals>;
  perType: Record<EntryKind, number>;
  batches: ErpBatchView[];
  focus: ErpEntry | null;
  focusPosting: ErpPostingView | undefined;
  focusBatchRef: string | null;
}

const STATE_LABEL: Record<ErpState, { label: string; hint: string; tone: string }> = {
  Pending: { label: 'Pending', hint: 'On the ledger, not yet sent to the ERP', tone: '' },
  Submitted: { label: 'Submitted', hint: 'Accepted by the ERP; carries an ERP document number', tone: 'good' },
  Failed: { label: 'Failed', hint: 'Rejected by ERP validation; the reason is on the row. Select it and submit again to retry', tone: 'bad' },
};

const FAQ: { q: string; a: string }[] = [
  {
    q: 'What gets exported?',
    a: 'One ERP document per ledger entry: invoices as customer invoices, SLA credits as credit memos, recoveries as statistical journals. The ledger reference is the external document number and the station is the location.',
  },
  {
    q: 'What if someone clicks submit twice?',
    a: 'Nothing posts twice. Each entry is sent with the idempotency key gt-ledger-<id>, entries already submitted are skipped, and the ERP refuses a document number already used by another entry. Each click also carries a request id; replaying it does nothing.',
  },
  {
    q: 'What if the ERP rejects an entry?',
    a: 'That entry is marked Failed with the reason and the rest of the batch still posts. Select it and submit again to retry; attempts are counted.',
  },
  {
    q: 'Does submitting change the books?',
    a: 'No. The ledger stays append-only. Handoff state lives in a separate erp_posting row per ledger entry, written in the same transaction as the batch.',
  },
  {
    q: 'Who submitted it, and when?',
    a: 'Every batch records the authenticated database identity of the caller, the name entered here, the server timestamp, and the counts and dollars posted, failed and skipped.',
  },
  {
    q: 'Is this a live ERP?',
    a: 'It is an ERP sandbox inside the database: the module validates, maps and numbers each document in one transaction. A production connector would read the same rows and send them with the same idempotency key.',
  },
];

export function ErpPanel({ totals, perType, batches, focus, focusPosting, focusBatchRef }: ErpPanelProps) {
  const tech = useTechMode();
  const last = batches[0];
  const payload = focus ? erpPayload(focus, focusPosting, focusBatchRef) : null;

  return (
    <section className="erp-panel" aria-label="ERP handoff">
      <div className="erp-head">
        <span className="ui-section-title"><Send size={12} aria-hidden /> ERP handoff · ERP sandbox</span>
        <span className="ui-muted">Select ledger entries and submit them as ERP documents. The ledger itself is never edited.</span>
      </div>

      <div className="erp-stats">
        {(['Pending', 'Submitted', 'Failed'] as const).map(s => (
          <div key={s} className="erp-stat" title={STATE_LABEL[s].hint}>
            <span className={`erp-dot ${s.toLowerCase()}`} aria-hidden />
            <span className="ui-stat-label">{STATE_LABEL[s].label}</span>
            <span className={`erp-stat-value ${STATE_LABEL[s].tone}`}>{compactUsd(totals[s].cents)}</span>
            <span className="ui-stat-sub">{totals[s].count.toLocaleString('en-US')} {totals[s].count === 1 ? 'entry' : 'entries'}</span>
          </div>
        ))}
        <div className="erp-stat" title={last ? `Request ${last.requestId}` : undefined}>
          <span className="ui-stat-label">Last batch</span>
          {last ? (
            <>
              <span className="erp-stat-value fin-mono-lg">{last.batchRef}</span>
              <span className="ui-stat-sub">{erpTime(last.submittedAt)} · {last.submittedByName}</span>
            </>
          ) : (
            <>
              <span className="erp-stat-value muted">None yet</span>
              <span className="ui-stat-sub">Nothing has been submitted</span>
            </>
          )}
        </div>
      </div>

      <div className="erp-grid">
        <div className="erp-col">
          <div className="ui-section-title">What gets exported</div>
          <div className="erp-map" role="table" aria-label="Ledger to ERP mapping">
            <div className="erp-map-row erp-map-head" role="row">
              <span role="columnheader">Ledger</span>
              <span role="columnheader">ERP document</span>
              <span role="columnheader">Debit</span>
              <span role="columnheader">Credit</span>
              <span role="columnheader" className="right">Entries</span>
            </div>
            {(Object.keys(ERP_MAPPING) as EntryKind[]).map(k => {
              const m = ERP_MAPPING[k];
              return (
                <div key={k} className="erp-map-row" role="row">
                  <span role="cell">{k}</span>
                  <span role="cell">{m.documentType} <span className="ui-table-muted fin-mono">{m.prefix}-</span></span>
                  <span role="cell" className="ui-table-muted">{m.debitAccount}</span>
                  <span role="cell" className="ui-table-muted">{m.creditAccount}</span>
                  <span role="cell" className="right">{perType[k].toLocaleString('en-US')}</span>
                </div>
              );
            })}
          </div>
          <p className="erp-note">
            Recoveries are revenue already invoiced, so they post as statistical journals with no GL impact.
            Demo chart of accounts.
          </p>

          <div className="ui-section-title erp-gap">How the handoff works</div>
          <dl className="erp-faq">
            {FAQ.map(f => (
              <div key={f.q}>
                <dt>{f.q}</dt>
                <dd>{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="erp-col">
          <div className="ui-section-title">
            Payload preview{focus && <span className="erp-focus fin-mono">{focus.referenceId ?? `#${focus.id}`}</span>}
          </div>
          {payload ? (
            <pre className="erp-json fin-mono" aria-label="ERP payload">{JSON.stringify(payload, null, 2)}</pre>
          ) : (
            <p className="erp-note">Click a ledger row to preview what the ERP receives.</p>
          )}

          <div className="ui-section-title erp-gap">Batches · audit trail</div>
          {batches.length === 0 ? (
            <p className="erp-note">No batches yet. Each submit writes one batch row: who, when, what and the outcome.</p>
          ) : (
            <div className="erp-batches">
              {batches.slice(0, 6).map(b => (
                <div key={String(b.id)} className="erp-batch" title={`Request ${b.requestId}\nIdentity ${b.submittedBy}`}>
                  <span className="fin-mono erp-batch-ref">{b.batchRef}</span>
                  <span className="ui-table-muted">{erpTime(b.submittedAt)} · {b.submittedByName}{tech && ` · ${b.submittedBy.slice(0, 10)}…`}</span>
                  <span className="erp-batch-counts">
                    <span className={b.posted > 0 ? 'good' : 'ui-table-muted'}>{b.posted.toLocaleString('en-US')} posted</span>
                    {b.failed > 0 && <span className="bad">{b.failed} failed</span>}
                    {b.skipped > 0 && <span className="ui-table-muted">{b.skipped.toLocaleString('en-US')} already sent</span>}
                  </span>
                  <span className="right erp-batch-net" title="Signed sum posted, as on the ledger">
                    {b.postedNetCents < 0 ? '−' : ''}{compactUsd(b.postedNetCents)} net
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
