/** Loads the deterministic six-month labeled history through `seed_labeled_decisions`. */

import { connect } from './connect.ts';
import { generateHistory } from './history.ts';

const BATCH = 150;
const rows = generateHistory({ nowMicros: Date.now() * 1000 });

connect(async conn => {
  try {
    for (let i = 0; i < rows.length; i += BATCH) {
      await conn.reducers.seedLabeledDecisions({ rowsJson: JSON.stringify(rows.slice(i, i + BATCH)) });
    }
    console.log(`Seeded ${rows.length} labeled decisions covering 180 days`);
    process.exit(0);
  } catch (err) {
    console.error('Seeding labeled history failed:', err);
    process.exit(1);
  }
}, { retry: false });
