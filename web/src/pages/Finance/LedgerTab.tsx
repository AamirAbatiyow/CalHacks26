import type { LedgerEntry } from '../../types';
import { formatDollars } from '../../utils/money';

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

function getEntryTypeLabel(type: string): string {
  switch (type) {
    case 'Credit':
      return 'Credit';
    case 'Invoice':
      return 'Invoice';
    case 'Recovery':
      return 'Recovery';
    default:
      return type;
  }
}

export function LedgerTab({ entries }: LedgerTabProps) {
  const sortedEntries = [...entries].sort((a, b) => 
    Number(b.createdAt - a.createdAt)
  );

  if (sortedEntries.length === 0) {
    return (
      <div className="ledger-empty">
        No ledger entries yet. Transactions will appear here in real-time.
      </div>
    );
  }

  return (
    <table className="ledger-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Type</th>
          <th>Description</th>
          <th>Reference</th>
          <th style={{ textAlign: 'right' }}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {sortedEntries.map((entry) => {
          const isNegative = entry.amountCents < BigInt(0);
          return (
            <tr key={entry.id.toString()}>
              <td>{formatTimestamp(entry.createdAt)}</td>
              <td>
                <span className="ledger-type">
                  <span className={`ledger-type-indicator ${entry.entryType.toLowerCase()}`} />
                  {getEntryTypeLabel(entry.entryType)}
                </span>
              </td>
              <td>{entry.description}</td>
              <td style={{ color: 'var(--color-secondary)' }}>{entry.referenceId || '—'}</td>
              <td style={{ textAlign: 'right' }}>
                <span className={`ledger-amount ${isNegative ? 'negative' : 'positive'}`}>
                  {isNegative ? '−' : '+'}{formatDollars(entry.amountCents < BigInt(0) ? -entry.amountCents : entry.amountCents)}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
