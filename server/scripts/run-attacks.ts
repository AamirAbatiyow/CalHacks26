/**
 * Break It attacker script.
 *
 * Connects to the live Ground Truth module with the official SpacetimeDB SDK,
 * opens one attack run, then executes every attack fixture from its own fresh
 * identity (registered as the customer, operator or admin the fixture calls
 * for) and prints the run's measured score.
 *
 * Usage:
 *   npm run generate   # bindings for ../spacetimedb
 *   npm run attacks -- [--host http://localhost:3000] [--module ground-truth]
 */

import { DbConnection, tables } from './module_bindings';

interface Target {
  host: string;
  module: string;
}

const ROLE_CODES = { customer: 0, operator: 1, admin: 2 } as const;
type Role = keyof typeof ROLE_CODES;

function tag(value: unknown): string {
  if (value && typeof value === 'object' && 'tag' in value) return String((value as { tag: unknown }).tag);
  return String(value);
}

function dollars(cents: bigint): string {
  return `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function roleOf(params: string): Role {
  const role = /(?:^|,)role=(\w+)/.exec(params)?.[1];
  return role === 'admin' || role === 'operator' ? role : 'customer';
}

function connect(target: Target, subscribe: boolean): Promise<{ conn: DbConnection; identity: string }> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(target.host)
      .withDatabaseName(target.module)
      .onConnect((conn, identity) => {
        if (!subscribe) {
          resolve({ conn, identity: identity.toHexString() });
          return;
        }
        conn
          .subscriptionBuilder()
          .onApplied(() => resolve({ conn, identity: identity.toHexString() }))
          .onError(ctx => reject(new Error(`subscription failed: ${String(ctx.event)}`)))
          .subscribe([tables.attackFixture, tables.attackRunSession, tables.attackRun]);
      })
      .onConnectError((_ctx, err) => reject(err))
      .build();
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const target: Target = {
    host: flag('--host') ?? process.env.SPACETIMEDB_HOST ?? 'http://localhost:3000',
    module: flag('--module') ?? process.env.SPACETIMEDB_MODULE ?? 'ground-truth',
  };
  console.log(`Target: ${target.module} on ${target.host}`);

  const { conn: coordinator, identity: coordinatorId } = await connect(target, true);
  console.log(`Coordinator identity: ${coordinatorId}`);

  if (coordinator.db.attackFixture.count() === 0n) {
    await coordinator.reducers.seedAttackFixtures({});
  }
  const fixtures = [...coordinator.db.attackFixture.iter()].sort((a, b) => Number(a.id - b.id));

  const before = new Set([...coordinator.db.attackRunSession.iter()].map(s => s.id));
  await coordinator.reducers.startAttackRun({});
  const session = [...coordinator.db.attackRunSession.iter()]
    .filter(s => !before.has(s.id) && s.completedAt === undefined)
    .sort((a, b) => Number(b.id - a.id))[0];
  if (!session) throw new Error('start_attack_run did not open a session');
  console.log(`Attack run ${session.id}: ${fixtures.length} fixtures\n`);

  for (const fixture of fixtures) {
    const role = roleOf(fixture.attackParams);
    const { conn, identity } = await connect(target, false);
    try {
      await conn.reducers.registerAttacker({ roleCode: ROLE_CODES[role] });
      await conn.reducers.runAttackFixture({ sessionId: session.id, fixtureId: fixture.id });
    } catch (err) {
      console.error(`  fixture ${fixture.id} failed for ${identity.slice(0, 12)}: ${String(err)}`);
    } finally {
      conn.disconnect();
    }
  }

  await coordinator.reducers.finishAttackRun({ sessionId: session.id });

  const final = coordinator.db.attackRunSession.id.find(session.id);
  const rows = [...coordinator.db.attackRun.iter()]
    .filter(r => r.runId === session.id && tag(r.result) !== 'Pending')
    .sort((a, b) => Number(a.timestamp.microsSinceUnixEpoch - b.timestamp.microsSinceUnixEpoch));
  coordinator.disconnect();
  if (!final) throw new Error(`attack run ${session.id} disappeared`);

  const byType = new Map<string, { caught: number; total: number }>();
  for (const row of rows) {
    const entry = byType.get(tag(row.attackType)) ?? { caught: 0, total: 0 };
    entry.total += 1;
    if (tag(row.result) === 'Caught') entry.caught += 1;
    byType.set(tag(row.attackType), entry);
  }

  console.log('Per attack type:');
  for (const [type, { caught, total }] of byType) {
    console.log(`  ${type.padEnd(22)} ${caught}/${total}`);
  }

  const misses = rows.filter(r => tag(r.result) === 'Missed');
  console.log(`\nMisses (${misses.length}):`);
  for (const row of misses) {
    console.log(`  [${row.attackerIdentity?.slice(0, 12)}] ${row.logMessage}`);
  }

  const pct = final.totalAttacks > 0 ? ((final.caught / final.totalAttacks) * 100).toFixed(1) : '0.0';
  console.log(`\nSCORE: ${final.caught} / ${final.totalAttacks} caught (${pct}%)`);
  console.log(`Dollars protected: ${dollars(final.dollarsProtectedCents)}`);
  console.log(`Bad payouts:       ${dollars(final.badPayoutsCents)}`);
  console.log(`Distinct attacker identities: ${new Set(rows.map(r => r.attackerIdentity)).size}`);
}

main().then(
  () => process.exit(0),
  err => {
    console.error('Error running attacks:', err);
    process.exit(1);
  },
);
