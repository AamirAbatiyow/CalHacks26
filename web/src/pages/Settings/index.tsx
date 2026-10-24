import { motion } from 'motion/react';
import { setTechMode, useTechMode } from '../../hooks/useTechMode';
import './Settings.css';

const TECHNICAL_ITEMS = [
  'Model accuracy and precision per version',
  'Confidence scores, SHAP and re-verify checks',
  'Model and policy versions',
  'Decision pipeline, learned-rule lineage and worker status',
  'Replay internals',
];

export default function SettingsPage() {
  const on = useTechMode();
  return (
    <div className="settings-page">
      <div className="settings-content">
        <span className="ui-eyebrow">Settings</span>
        <div className="settings-row">
          <div className="settings-text">
            <span className="settings-name">Show technical details</span>
            <span className="settings-hint">Analyst mode. Off shows dollars, claim status, decisions and short reasons.</span>
          </div>
          <button
            className={`settings-switch ${on ? 'on' : ''}`}
            role="switch"
            aria-checked={on}
            aria-label="Show technical details"
            onClick={() => setTechMode(!on)}
          >
            <motion.span className="settings-knob" layout transition={{ type: 'spring', stiffness: 600, damping: 35 }} />
          </button>
        </div>
        <ul className="settings-list" aria-label="Shown when technical details are on">
          {TECHNICAL_ITEMS.map(t => <li key={t}>{t}</li>)}
        </ul>
      </div>
    </div>
  );
}
