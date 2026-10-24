import { useMemo } from 'react';
import { motion } from 'motion/react';
import { compactUsd } from '../../ui/CountUp';
import { ATTACK_TYPE_LABELS, ATTACK_TYPES_ORDER, type AttackType } from './types';
import { PolicyLink } from './AttackDetail';
import { attackTypeOf, totals, type AttackEvalRow, type Totals } from './useAttackEvals';

function Versions({ t }: { t: Totals }) {
  const policies = t.policyVersion.split(', ').filter(Boolean);
  return (
    <span className="ba-versions">
      {policies.map((v, i) => <span key={v}>{i > 0 && ', '}<PolicyLink version={v} /></span>)} · {t.modelVersion}
    </span>
  );
}

function Bar({ t, label }: { t: Totals; label: string }) {
  const parts = [
    { key: 'caught', n: t.caught, text: 'caught' },
    { key: 'escalated', n: t.escalated, text: 'held' },
    { key: 'missed', n: t.missed, text: 'missed' },
  ];
  return (
    <div className="ba-row">
      <div className="ba-label">
        <b>{label}</b>
        <Versions t={t} />
      </div>
      <div className="ba-bar" role="img" aria-label={`${label}: ${t.caught} caught, ${t.escalated} held for review, ${t.missed} missed of ${t.total}`}>
        {parts.filter(p => p.n > 0).map(p => (
          <motion.span
            key={p.key}
            className={`ba-seg ${p.key}`}
            initial={false}
            animate={{ flexGrow: p.n }}
            transition={{ duration: 0.6, ease: [0.2, 0, 0, 1] }}
            title={`${p.n} ${p.text}`}
          >
            {p.n} {p.text}
          </motion.span>
        ))}
      </div>
      <div className="ba-money">
        <span><small>Protected</small>{compactUsd(t.protectedCents)}</span>
        <span className={t.badCents > 0 ? 'bad' : ''}><small>Bad payouts</small>{compactUsd(t.badCents)}</span>
      </div>
    </div>
  );
}

function delta(n: number) {
  return n === 0 ? '—' : `${n > 0 ? '+' : '−'}${Math.abs(n)}`;
}

/** The same attacks decided under the earlier policy and model and under the current ones. */
export function BeforeAfter({ before, after }: { before: AttackEvalRow[]; after: AttackEvalRow[] }) {
  const b = useMemo(() => totals(before), [before]);
  const a = useMemo(() => totals(after), [after]);
  const byType = useMemo(() => {
    const group = (rows: AttackEvalRow[]) => {
      const m = new Map<AttackType, AttackEvalRow[]>();
      rows.forEach(r => m.set(attackTypeOf(r), [...(m.get(attackTypeOf(r)) ?? []), r]));
      return m;
    };
    const bm = group(before);
    const am = group(after);
    return ATTACK_TYPES_ORDER.filter(t => am.has(t)).map(t => ({ type: t, before: totals(bm.get(t) ?? []), after: totals(am.get(t) ?? []) }));
  }, [before, after]);
  if (after.length === 0 || before.length === 0) return null;

  return (
    <section className="ba">
      <div className="breakit-section-head">
        <span className="ui-section-title">Before and after learning</span>
        <span className="ui-legend">
          <span className="ui-legend-item"><span className="breakit-dot caught" />Caught</span>
          <span className="ui-legend-item"><span className="breakit-dot escalated" />Held for a human</span>
          <span className="ui-legend-item"><span className="breakit-dot missed" />Missed</span>
        </span>
      </div>
      <p className="ba-sub">
        The same {a.total} attacks, each decided twice in this run: by the policy the first learned version was built on with the first System 1 model, and by the active policy and model.
        Held attacks paid nothing yet but each needs a human.
      </p>
      <Bar t={b} label="Before" />
      <Bar t={a} label="After" />
      <table className="ba-table">
        <thead>
          <tr><th>Attack</th><th className="num">Caught before</th><th className="num">Caught after</th><th className="num">Δ caught</th><th className="num">Δ held</th><th className="num">Δ bad payouts</th></tr>
        </thead>
        <tbody>
          {byType.map(r => (
            <tr key={r.type}>
              <td>{ATTACK_TYPE_LABELS[r.type]}</td>
              <td className="num">{r.before.caught} / {r.before.total}</td>
              <td className="num">{r.after.caught} / {r.after.total}</td>
              <td className={`num ${r.after.caught > r.before.caught ? 'up' : ''}`}>{delta(r.after.caught - r.before.caught)}</td>
              <td className="num">{delta(r.after.escalated - r.before.escalated)}</td>
              <td className={`num ${r.after.badCents > r.before.badCents ? 'bad' : ''}`}>{r.after.badCents === r.before.badCents ? '—' : `${r.after.badCents > r.before.badCents ? '+' : '−'}${compactUsd(Math.abs(r.after.badCents - r.before.badCents))}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
