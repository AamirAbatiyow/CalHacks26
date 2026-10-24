import { useState } from 'react';
import { motion } from 'motion/react';
import { CircleDollarSign, Cpu, FileCheck2, Mail, Play, ShieldCheck, SunMedium, TriangleAlert, BookCheck } from 'lucide-react';
import { ClaimGate, DataIntegrityStatus } from '../../types';
import type { Claim, ClaimDecision, ClaimEvidence, ClaimOutcome, ClaimReason, ClaimWeather } from '../../types';
import { openReplay } from '../../replay/useDecisionTrace';
import { FlowGraph, COMPACT_NODE_W, type GraphNode, type GraphEdge } from '../../ui/FlowGraph';
import { Drawer, Fact } from '../../ui/Drawer';
import { Chip } from '../../ui/Chip';
import { C, DivergingBars, Gauge, SplitBar } from '../../ui/charts';
import { CountUp, usd, wholeUsd } from '../../ui/CountUp';
import { Skeleton, SkeletonGraph } from '../../ui/Skeleton';

interface ClaimPanelProps {
  claim: Claim;
  evidence: ClaimEvidence;
  decision: ClaimDecision;
  outcome: ClaimOutcome;
  weather: ClaimWeather;
  reasons: ClaimReason[];
  policyKnown: boolean;
}

/** The claim's evidence feeding System 1 and the credit, as one small graph with dollars beside it. */
export function ClaimPanel({ claim, evidence, decision, outcome, weather, reasons, policyKnown }: ClaimPanelProps) {
  const [openNode, setOpenNode] = useState<string | null>(null);
  const claimed = Number(claim.amountClaimedCents);
  const loss = Number(evidence.estimatedLossCents);
  const unverified = Number(evidence.missingEvidenceCents);
  const credit = Number(decision.creditAmountCents);
  const unsupported = Math.max(0, claimed - loss);
  const integrityPass = evidence.dataIntegrityStatus === DataIntegrityStatus.Pass;
  const auto = decision.gate === ClaimGate.Auto;

  const nodes: GraphNode[] = [
    { id: 'integrity', title: 'Integrity', icon: FileCheck2, value: integrityPass ? 'Pass' : evidence.dataIntegrityStatus === DataIntegrityStatus.Fail ? 'Fail' : 'Pending', tone: integrityPass ? 'neutral' : 'block' },
    { id: 'weather', title: 'Weather', icon: SunMedium, value: `Kp ${weather.kpIndex}`, tone: weather.stormActive ? 'warn' : 'neutral', hint: weather.stormActive ? 'Storm at signal loss' : 'Quiet' },
    { id: 'loss', title: 'Est. loss', icon: CircleDollarSign, value: wholeUsd(loss), hint: 'Model estimate of the lost share' },
    { id: 'unverified', title: 'Unverified', icon: TriangleAlert, value: wholeUsd(unverified), tone: unverified > 0 ? 'warn' : 'neutral', hint: 'Loss telemetry does not corroborate' },
    { id: 's1', title: 'System 1', icon: Cpu, value: `${decision.confidencePercent}%`, tone: decision.confidencePercent >= 95 ? 'pass' : 'warn' },
    { id: 'credit', title: auto ? 'Auto credit' : 'Escalated', icon: ShieldCheck, value: wholeUsd(credit), tone: auto ? 'pass' : 'warn', emphasis: true },
  ];
  const edges: GraphEdge[] = [
    ...['integrity', 'weather', 'loss', 'unverified'].map(from => ({ from, to: 's1' })),
    { from: 's1', to: 'credit', tone: auto ? 'pass' as const : 'warn' as const },
  ];

  const shap = [...reasons]
    .sort((a, b) => Math.abs(b.shapValue) - Math.abs(a.shapValue))
    .map(r => ({ name: r.feature, value: r.shapValue, detail: r.detail }));

  const drawerTitle: Record<string, string> = {
    integrity: 'Data integrity', weather: 'Space weather', loss: 'Estimated loss', unverified: 'Unverified share', s1: 'System 1', credit: 'Decision',
  };

  return (
    <div className="claim-detail-panel">
      <motion.div className="claim-head" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
        <span className="ui-eyebrow">{claim.id} · {claim.customerName}</span>
        <div className="claim-head-amount">
          <CountUp value={claimed} format={wholeUsd} />
          <span className="claim-head-unit">claimed</span>
        </div>
      </motion.div>

      <section className="claim-block">
        <div className="claim-gauge-row">
          <Gauge value={decision.confidencePercent} size={128}>
            <span className="claim-gauge-value">{decision.confidencePercent}%</span>
            <span className="ui-stat-sub">confidence</span>
          </Gauge>
          <div className="claim-credit">
            <span className="ui-stat-label">Credit</span>
            <span className="ui-stat-value"><CountUp value={credit} format={wholeUsd} /></span>
            <Chip tone={auto ? 'pass' : 'warn'}>{auto ? 'Auto-decided' : 'Escalated'}</Chip>
          </div>
        </div>
      </section>

      <section className="claim-block">
        <div className="ui-section-title">Where the {wholeUsd(claimed)} went</div>
        <SplitBar
          label={`${wholeUsd(credit)} credited, ${wholeUsd(unverified)} unverified, ${wholeUsd(unsupported)} not supported by the loss estimate`}
          parts={[
            { label: `Credited ${wholeUsd(credit)}`, value: credit, color: C.accent },
            { label: `Unverified ${wholeUsd(unverified)}`, value: unverified, color: C.amber, pattern: true },
            { label: `Not supported ${wholeUsd(unsupported)}`, value: unsupported, color: '#2a2a2a' },
          ]}
        />
        <div className="ui-legend claim-legend">
          <span className="ui-legend-item"><span className="ui-legend-swatch" style={{ background: C.accent }} />Credited <b>{wholeUsd(credit)}</b></span>
          <span className="ui-legend-item" style={{ color: C.amber }}><span className="ui-legend-swatch hatched" style={{ color: C.amber }} /><span style={{ color: 'var(--color-secondary)' }}>Unverified <b>{wholeUsd(unverified)}</b></span></span>
          <span className="ui-legend-item"><span className="ui-legend-swatch" style={{ background: '#2a2a2a' }} />Not supported <b>{wholeUsd(unsupported)}</b></span>
        </div>
      </section>

      <section className="claim-block">
        <div className="ui-section-title">Evidence to decision</div>
        <FlowGraph nodes={nodes} edges={edges} height={250} nodeWidth={COMPACT_NODE_W} rankSep={28}
          selectedId={openNode} onSelect={setOpenNode}
          label={`Integrity, weather, estimated loss and unverified share feed System 1 at ${decision.confidencePercent}%, which credits ${wholeUsd(credit)}`} />
      </section>

      {shap.length > 0 && (
        <section className="claim-block">
          <div className="ui-section-title">Why · SHAP</div>
          <DivergingBars data={shap} label="SHAP contribution of each feature to the confidence" />
        </section>
      )}

      <div className="claim-foot">
        <div className="ui-chips">
          <Chip tone={outcome.creditMemoSent ? 'pass' : 'neutral'} icon={Mail}>{outcome.creditMemoSent ? 'Memo sent' : 'Memo not sent'}</Chip>
          <Chip tone={outcome.ledgerPosted ? 'pass' : 'neutral'} icon={BookCheck}>{outcome.ledgerPosted ? 'Ledger posted' : 'Not posted'}</Chip>
        </div>
        <button className="ui-link-btn" onClick={() => openReplay(`claim:${claim.id}`)}><Play size={12} /> Replay</button>
      </div>

      <Drawer open={openNode !== null} onClose={() => setOpenNode(null)} eyebrow={claim.id} title={openNode ? drawerTitle[openNode] : ''}>
        {openNode === 'integrity' && <Fact label="Data integrity check" value={integrityPass ? 'Pass' : 'Fail'} tone={integrityPass ? 'pass' : 'block'} />}
        {openNode === 'weather' && (<>
          <Fact label="Kp index" value={weather.kpIndex} tone={weather.stormActive ? 'warn' : undefined} />
          <Fact label="Storm at signal loss" value={weather.stormActive ? 'Yes' : 'No'} />
        </>)}
        {openNode === 'loss' && (<>
          <Fact label="Estimated loss" value={usd(loss)} />
          <Fact label="Claimed" value={usd(claimed)} />
          <p>Share of the contact without downlink, priced at the pass's billed rate.</p>
        </>)}
        {openNode === 'unverified' && (<>
          <Fact label="Unverified" value={usd(unverified)} tone="warn" />
          <Fact label="Corroborated by telemetry" value={usd(loss - unverified)} />
        </>)}
        {openNode === 's1' && (<>
          <Fact label="Confidence" value={`${decision.confidencePercent}%`} />
          <Fact label="Auto-decide threshold" value="95%" />
          <Fact label="Model" value={decision.modelVersion} />
          {shap.length > 0 && <DivergingBars data={shap} label="SHAP contribution of each feature" />}
        </>)}
        {openNode === 'credit' && (<>
          <Fact label="Credit" value={usd(credit)} />
          <Fact label="Gate" value={auto ? 'Auto' : 'Escalated'} />
          <Fact label="Rule" value={<code>{decision.rule}</code>} />
          <Fact label="Policy" value={policyKnown ? <a className="decision-link" href={`#/policies/${encodeURIComponent(decision.policyVersion)}`}>{decision.policyVersion}</a> : decision.policyVersion} />
          <Fact label="Model" value={decision.modelVersion} />
        </>)}
      </Drawer>
    </div>
  );
}

export function ClaimSkeleton() {
  return (
    <div className="claim-page">
      <div className="claim-content">
        <div className="claim-globe-section claim-globe-skeleton"><Skeleton width={420} height={420} radius={210} /></div>
        <div className="claim-detail-panel">
          <Skeleton width={140} height={10} />
          <Skeleton width={120} height={28} />
          <Skeleton width="100%" height={70} />
          <Skeleton width="100%" height={8} />
          <SkeletonGraph columns={3} />
        </div>
      </div>
    </div>
  );
}
