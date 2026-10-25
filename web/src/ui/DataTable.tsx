import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';

export interface Column<T> {
  key: string;
  /** Header content; a control such as a select-all checkbox is allowed when `sort` is omitted. */
  label: ReactNode;
  /** CSS grid track, e.g. `120px` or `minmax(0, 1fr)`. */
  width: string;
  align?: 'left' | 'right';
  /** Omit to make the column unsortable. */
  sort?: (row: T) => number | string;
  render: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  rowTitle?: (row: T) => string | undefined;
  limit?: number;
  label: string;
  className?: string;
}

/** Compact sortable table in Overview's style: thin dividers, small caps header, click a header to sort. */
export function DataTable<T>({ rows, columns, rowKey, defaultSort, onRowClick, selectedKey, rowTitle, limit, label, className = '' }: DataTableProps<T>) {
  const [sort, setSort] = useState(defaultSort ?? null);
  const template = columns.map(c => c.width).join(' ');

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find(c => c.key === sort.key);
    if (!col?.sort) return rows;
    const get = col.sort;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [rows, columns, sort]);

  const visible = limit ? sorted.slice(0, limit) : sorted;

  const toggle = (c: Column<T>) => {
    if (!c.sort) return;
    setSort(s => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.align === 'right' ? 'desc' : 'asc' }));
  };

  return (
    <div className={`ui-table ${className}`} role="table" aria-label={label}>
      <div className="ui-table-row ui-table-head" role="row" style={{ gridTemplateColumns: template }}>
        {columns.map(c => {
          const active = sort?.key === c.key;
          const Arrow = sort?.dir === 'asc' ? ArrowUp : ArrowDown;
          return (
            <span key={c.key} role="columnheader" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
              className={`ui-table-cell ${c.align === 'right' ? 'right' : ''}`}>
              {c.sort ? (
                <button className={`ui-table-sort ${active ? 'active' : ''}`} onClick={() => toggle(c)}>
                  {c.label}
                  {active && <Arrow size={10} aria-hidden />}
                </button>
              ) : c.label}
            </span>
          );
        })}
      </div>
      {visible.map(r => {
        const k = rowKey(r);
        return (
          <div
            key={k}
            role="row"
            className={`ui-table-row ${onRowClick ? 'clickable' : ''} ${selectedKey === k ? 'selected' : ''}`}
            style={{ gridTemplateColumns: template }}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            onKeyDown={onRowClick ? e => { if (e.key === 'Enter') onRowClick(r); } : undefined}
            tabIndex={onRowClick ? 0 : undefined}
            title={rowTitle?.(r)}
          >
            {columns.map(c => (
              <span key={c.key} role="cell" className={`ui-table-cell ${c.align === 'right' ? 'right' : ''}`}>{c.render(r)}</span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
