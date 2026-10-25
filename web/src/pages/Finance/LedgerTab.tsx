import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Check, Clock, RotateCcw, Send, ShieldAlert, X, type LucideIcon } from 'lucide-react';
import type { LedgerEntry } from '../../types';
import { formatDollars } from '../../utils/money';
import { C, LineSeries } from '../../ui/charts';
import { Chip } from '../../ui/Chip';
import { CountUp, compactUsd } from '../../ui/CountUp';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState } from '../../ui/EmptyState';
import { dailyBuckets } from '../../ui/series';
import { erpTime, postedRefs, precheck, sodViolations, stateOf, summarize, type EntryKind, type ErpState } from './erp';
import { ErpPanel } from './ErpPanel';
import { useErp } from './useErp';
import { useIdentity } from '../../hooks/useTable';

interface LedgerTabProps {
  entries: LedgerEntry[];
}

function formatTimestamp(micros: bigint): string {
  const date = new Date(Number(micros / BigInt(1000)));
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const TYPES = ['Invoice', 'Credit', 'Recovery'] as const;

const TYPE_META: Record<EntryKind, { label: string; color: string; icon: LucideIcon }> = {
  Invoice: { label: 'Invoiced', color: C.primary, icon: ArrowUpRight },
  Credit: { label: 'Credits paid', color: C.amber, icon: ArrowDownLeft },
  Recovery: { label: 'Recovered', color: C.accent, icon: RotateCcw },
};

type Filter = 'All' | ErpState;
const FILTERS: Filter[] = ['All', 'Pending', 'Submitted', 'Failed'];

const REVIEWER_KEY = 'gt-reviewer';
const PAGE = 100;

function Checkbox({ checked, indeterminate = false, disabled, onChange, label }: {
  checked: boolean; indeterminate?: boolean; disabled?: boolean; onChange: () => void; label: string;
}) {
  return (
    <input
      type="checkbox"
      className="erp-check"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      ref={el => { if (el) el.indeterminate = indeterminate; }}
      onClick={e => e.stopPropagation()}
      onChange={onChange}
    />
  );
}

export function LedgerTab({ entries }: LedgerTabProps) {
  const { postings, batches, batchById, submit } = useErp();
  const identity = useIdentity();
  const [filter, setFilter] = useState<Filter>('All');
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [name, setName] = useState(() => localStorage.getItem(REVIEWER_KEY) ?? 'ops.reviewer');
  const [inFlight, setInFlight] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<{ requestId: string; error?: string } | null>(null);

  const { totals, cumulative, perType } = useMemo(() => {
    const totals: Record<EntryKind, number> = { Invoice: 0, Credit: 0, Recovery: 0 };
    const perType: Record<EntryKind, number> = { Invoice: 0, Credit: 0, Recovery: 0 };
    for (const e of entries) {
      if ((TYPES as readonly string[]).includes(e.entryType)) {
        totals[e.entryType as EntryKind] += Math.abs(Number(e.amountCents));
        perType[e.entryType as EntryKind] += 1;
      }
    }
    const daily = dailyBuckets(entries, e => e.createdAt, ['Credit', 'Recovery'] as const, e =>
      e.entryType === 'Credit' || e.entryType === 'Recovery' ? { key: e.entryType, amount: Math.abs(Number(e.amountCents)) } : null);
    const cumulative: { x: string; Credit: number; Recovery: number }[] = [];
    for (const d of daily) {
      const prev = cumulative[cumulative.length - 1];
      cumulative.push({ x: d.x, Credit: (prev?.Credit ?? 0) + d.Credit, Recovery: (prev?.Recovery ?? 0) + d.Recovery });
    }
    return { totals, cumulative, perType };
  }, [entries]);

  const byId = useMemo(() => new Map(entries.map(e => [String(e.id), e])), [entries]);
  const state = (e: LedgerEntry) => stateOf(postings.get(String(e.id)));
  const erpTotals = useMemo(() => summarize(entries, postings), [entries, postings]);

  const rows = useMemo(
    () => (filter === 'All' ? entries : entries.filter(e => stateOf(postings.get(String(e.id))) === filter)),
    [entries, postings, filter],
  );
  const selectable = useMemo(() => rows.filter(e => stateOf(postings.get(String(e.id))) !== 'Submitted'), [rows, postings]);

  // Drop rows that were submitted meanwhile (by this tab or another one).
  const picked = useMemo(
    () => [...selected].map(k => byId.get(k)).filter((e): e is LedgerEntry => !!e && stateOf(postings.get(String(e.id))) !== 'Submitted'),
    [selected, byId, postings],
  );

  const preview = useMemo(() => {
    // Same order the module processes them in, so in-batch duplicates are caught too.
    const refs = postedRefs(postings.values());
    const sorted = [...picked].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const reasons = new Map<string, number>();
    let cents = 0;
    let rejected = 0;
    for (const e of sorted) {
      cents += Math.abs(Number(e.amountCents));
      const why = precheck(e, refs);
      if (why) {
        rejected += 1;
        const key = why.split(':')[0];
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      } else if (e.referenceId) {
        refs.set(e.referenceId.trim(), e.id);
      }
    }
    // Separation of duties: submitter cannot have approved any credit in the batch
    const sodBlocked = sodViolations(sorted, identity);
    return { cents, rejected, reasons: [...reasons.entries()], sodBlocked };
  }, [picked, postings, identity]);

  const allChecked = selectable.length > 0 && selectable.every(e => selected.has(String(e.id)));
  const someChecked = !allChecked && selectable.some(e => selected.has(String(e.id)));

  const toggleAll = () => setSelected(prev => {
    const next = new Set(prev);
    if (allChecked) selectable.forEach(e => next.delete(String(e.id)));
    else selectable.forEach(e => next.add(String(e.id)));
    return next;
  });
  const toggle = (key: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const onSubmit = async () => {
    if (picked.length === 0 || inFlight) return;
    const requestId = crypto.randomUUID();
    const who = name.trim() || 'ops.reviewer';
    localStorage.setItem(REVIEWER_KEY, who);
    setInFlight(requestId);
    setLastRequest({ requestId });
    try {
      await submit(requestId, picked.map(e => e.id), who);
      setSelected(new Set());
    } catch (err) {
      setLastRequest({ requestId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setInFlight(null);
    }
  };

  const resultBatch = lastRequest ? batches.find(b => b.requestId === lastRequest.requestId) : undefined;

  const focus = (focusId && byId.get(focusId))
    || picked[0]
    || entries.find(e => state(e) === 'Pending')
    || entries[0]
    || null;
  const focusPosting = focus ? postings.get(String(focus.id)) : undefined;
  const focusBatchRef = focusPosting ? batchById.get(String(focusPosting.batchId))?.batchRef ?? null : null;

  const columns: Column<LedgerEntry>[] = [
    {
      key: 'select',
      label: <Checkbox checked={allChecked} indeterminate={someChecked} disabled={selectable.length === 0} onChange={toggleAll}
        label={allChecked ? 'Clear selection' : `Select all ${selectable.length} unsubmitted entries in view`} />,
      width: '20px',
      render: e => {
        const submitted = state(e) === 'Submitted';
        return <Checkbox checked={!submitted && selected.has(String(e.id))} disabled={submitted} onChange={() => toggle(String(e.id))}
          label={submitted ? 'Already submitted' : `Select ${e.referenceId ?? e.id}`} />;
      },
    },
    { key: 'time', label: 'Time', width: '130px', sort: e => Number(e.createdAt), render: e => <span className="ui-table-muted">{formatTimestamp(e.createdAt)}</span> },
    {
      key: 'type', label: 'Type', width: '96px', sort: e => e.entryType,
      render: e => {
        const meta = TYPE_META[e.entryType as EntryKind];
        const Icon = meta?.icon;
        return <span className="ledger-type">{Icon && <Icon size={12} style={{ color: meta.color }} aria-hidden />}{e.entryType}</span>;
      },
    },
    { key: 'description', label: 'Description', width: 'minmax(0, 1fr)', sort: e => e.description, render: e => e.description || '—' },
    { key: 'ref', label: 'Reference', width: '170px', sort: e => e.referenceId ?? '', render: e => <span className="ui-table-muted fin-mono">{e.referenceId || '—'}</span> },
    {
      key: 'erp', label: 'ERP', width: '190px', sort: e => state(e),
      render: e => {
        const p = postings.get(String(e.id));
        const s = stateOf(p);
        if (s === 'Pending') return <Chip icon={Clock} title="On the ledger, not yet sent to the ERP">Pending</Chip>;
        const batch = p ? batchById.get(String(p.batchId)) : undefined;
        const when = batch ? `${batch.batchRef} · ${erpTime(batch.submittedAt)} · ${batch.submittedByName}` : '';
        if (s === 'Submitted') {
          return (
            <span className="erp-cell" title={`${p?.erpDocumentId} · ${when}\nIdempotency key ${p?.idempotencyKey}`}>
              <Chip tone="pass" icon={Check}>Submitted</Chip>
              <span className="fin-mono ui-table-muted">{p?.erpDocumentId}</span>
            </span>
          );
        }
        return (
          <span className="erp-cell" title={`${p?.error}\n${when} · attempt ${p?.attempts}`}>
            <Chip tone="block" icon={AlertTriangle}>Failed</Chip>
            <span className="ui-table-muted erp-err">{p?.error?.split(':')[0]}</span>
          </span>
        );
      },
    },
    {
      key: 'amount', label: 'Amount', width: '96px', align: 'right', sort: e => Number(e.amountCents),
      render: e => {
        const neg = e.amountCents < BigInt(0);
        return <span className={`ledger-amount ${neg ? 'negative' : 'positive'}`}>{neg ? '−' : '+'}{formatDollars(neg ? -e.amountCents : e.amountCents)}</span>;
      },
    },
  ];

  if (entries.length === 0) {
    return <EmptyState art="ledger" title="No ledger entries yet" hint="Invoices, credits and recoveries appear here as they post." />;
  }

  return (
    <div className="fin-tab">
      <div className="fin-tiles">
        {TYPES.map(t => {
          const meta = TYPE_META[t];
          const Icon = meta.icon;
          return (
            <div key={t} className="fin-tile">
              <span className="ui-stat-label"><Icon size={12} style={{ color: meta.color }} aria-hidden /> {meta.label} · 30 days</span>
              <span className="ui-stat-value"><CountUp value={totals[t]} format={compactUsd} /></span>
            </div>
          );
        })}
      </div>

      <div className="fin-chart">
        <div className="fin-chart-head">
          <span className="ui-section-title">Credits paid vs recovered · cumulative, 30 days</span>
          <span className="ui-legend">
            <span className="ui-legend-item"><span className="ui-legend-swatch" style={{ background: C.amber }} />Credits paid</span>
            <span className="ui-legend-item"><span className="ui-legend-swatch" style={{ background: C.accent }} />Recovered</span>
          </span>
        </div>
        <LineSeries
          data={cumulative}
          series={[
            { key: 'Credit', label: 'Credits paid', color: C.amber },
            { key: 'Recovery', label: 'Recovered', color: C.accent },
          ]}
          height={190}
          format={compactUsd}
          label="Cumulative credits paid and money recovered over the last 30 days, in dollars"
        />
      </div>

      <ErpPanel
        totals={erpTotals}
        perType={perType}
        batches={batches}
        focus={focus}
        focusPosting={focusPosting}
        focusBatchRef={focusBatchRef}
      />

      <div className="erp-table">
        <div className="erp-bar" role="toolbar" aria-label="ERP submission">
          <div className="earn-toggle" role="radiogroup" aria-label="ERP status">
            {FILTERS.map(f => (
              <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? 'on' : ''} onClick={() => { setFilter(f); setShown(PAGE); }}>
                {f} <span className="erp-count">{(f === 'All' ? entries.length : erpTotals[f].count).toLocaleString('en-US')}</span>
              </button>
            ))}
          </div>
          <button className="ui-link-btn" onClick={toggleAll} disabled={selectable.length === 0}>
            {allChecked ? 'Clear selection' : `Select all ${selectable.length.toLocaleString('en-US')} unsubmitted`}
          </button>
          <div className="erp-bar-right">
            {picked.length > 0 && (
              <span className="erp-selection">
                <strong>{picked.length.toLocaleString('en-US')}</strong> selected · {compactUsd(preview.cents)}
                {preview.rejected > 0 && (
                  <span className="bad" title={preview.reasons.map(([r, n]) => `${n} × ${r}`).join('\n')}>
                    {' '}· {preview.rejected} will fail checks
                  </span>
                )}
                {preview.sodBlocked.length > 0 && (
                  <span className="bad" title={`Separation of duties: you approved ${preview.sodBlocked.map(e => e.referenceId).join(', ')} and cannot also submit`}>
                    {' '}· <ShieldAlert size={12} aria-hidden /> SoD: you approved {preview.sodBlocked.length === 1 ? preview.sodBlocked[0].referenceId : `${preview.sodBlocked.length} credits`}
                  </span>
                )}
                <button className="ui-icon-btn" onClick={() => setSelected(new Set())} aria-label="Clear selection"><X size={13} /></button>
              </span>
            )}
            <label className="erp-who">
              as
              <input value={name} onChange={e => setName(e.target.value)} aria-label="Submitted by" maxLength={64} />
            </label>
            <button
              className="erp-submit"
              onClick={onSubmit}
              disabled={picked.length === 0 || !!inFlight || preview.sodBlocked.length > 0}
              title={preview.sodBlocked.length > 0 ? 'Separation of duties: a different user must submit credits you approved' : undefined}
            >
              <Send size={13} aria-hidden />
              {inFlight ? 'Submitting…' : preview.sodBlocked.length > 0 ? 'SoD blocked' : picked.length > 0 ? `Submit ${picked.length.toLocaleString('en-US')} to ERP` : 'Submit to ERP'}
            </button>
          </div>
        </div>

        {lastRequest && (
          <div className={`erp-result ${lastRequest.error ? 'bad' : ''}`} role="status">
            {lastRequest.error ? (
              <>Submission refused: {lastRequest.error}</>
            ) : resultBatch ? (
              <>
                <span className="fin-mono">{resultBatch.batchRef}</span>
                <span>by {resultBatch.submittedByName}:</span>
                <span className="good">{resultBatch.posted.toLocaleString('en-US')} posted</span>
                {resultBatch.failed > 0 && <span className="bad">· {resultBatch.failed} failed</span>}
                {resultBatch.skipped > 0 && <span>· {resultBatch.skipped.toLocaleString('en-US')} already submitted, skipped</span>}
                <span className="ui-table-muted">· {resultBatch.postedNetCents < 0 ? '−' : ''}{compactUsd(resultBatch.postedNetCents)} net posted</span>
              </>
            ) : (
              <>Submitting…</>
            )}
            <button className="ui-icon-btn" onClick={() => setLastRequest(null)} aria-label="Dismiss"><X size={13} /></button>
          </div>
        )}

        <DataTable
          rows={rows}
          columns={columns}
          rowKey={e => e.id.toString()}
          defaultSort={{ key: 'time', dir: 'desc' }}
          onRowClick={e => setFocusId(String(e.id))}
          selectedKey={focus ? String(focus.id) : null}
          limit={shown}
          label="Ledger entries"
          className="fin-table-v2 erp-ledger"
        />
        {rows.length > shown && (
          <div className="erp-more">
            <span className="ui-muted">Showing {shown.toLocaleString('en-US')} of {rows.length.toLocaleString('en-US')}</span>
            <button className="ui-link-btn" onClick={() => setShown(n => n + 5 * PAGE)}>Show {Math.min(5 * PAGE, rows.length - shown).toLocaleString('en-US')} more</button>
          </div>
        )}
      </div>
    </div>
  );
}
