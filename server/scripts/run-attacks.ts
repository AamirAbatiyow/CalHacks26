#!/usr/bin/env npx ts-node
/**
 * Attacker Script for Ground Truth Break It
 * 
 * This script connects to SpacetimeDB as multiple separate identities
 * and executes adversarial attack scenarios.
 * 
 * Usage:
 *   npx ts-node run-attacks.ts [--host HOST] [--module MODULE]
 */

import WebSocket from 'ws';

const SPACETIMEDB_HOST = process.env.SPACETIMEDB_HOST || 'http://localhost:3000';
const SPACETIMEDB_MODULE = process.env.SPACETIMEDB_MODULE || 'ground-truth';

interface AttackScenario {
  name: string;
  attackType: number;
  description: string;
  role: 'customer' | 'operator' | 'admin';
}

const ATTACK_SCENARIOS: AttackScenario[] = [
  { name: 'Inflated Claim', attackType: 0, description: 'Adversarial customer files inflated claims', role: 'customer' },
  { name: 'Duplicate Claim', attackType: 1, description: 'Customer submits same claim twice', role: 'customer' },
  { name: 'Forged Station', attackType: 2, description: 'Customer claims pass at wrong station', role: 'customer' },
  { name: 'Insider Limit', attackType: 3, description: 'Operator tries to raise own payout limit', role: 'operator' },
  { name: 'Weather Excuse', attackType: 4, description: 'Customer blames space weather falsely', role: 'customer' },
  { name: 'Outside SLA', attackType: 5, description: 'Late claims outside contract window', role: 'customer' },
  { name: 'Messy Data', attackType: 6, description: 'Malformed input attempting to bypass validation', role: 'customer' },
  { name: 'Model Stress', attackType: 7, description: 'Adversarial inputs to stress the model', role: 'customer' },
  { name: 'Recovery', attackType: 8, description: 'Historical fraud detection patterns', role: 'customer' },
];

interface WSMessage {
  type?: string;
  data?: {
    database_update?: {
      tables?: Array<{
        table_name: string;
        inserts?: unknown[];
        deletes?: unknown[];
      }>;
    };
  };
}

class SpacetimeDBClient {
  private ws: WebSocket | null = null;
  private messageQueue: Array<(msg: WSMessage) => void> = [];
  private identity: string;
  private connected = false;

  constructor(private host: string, private module: string, private role: string) {
    this.identity = `attacker-${role}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.host.replace('http', 'ws') + '/database/subscribe/' + this.module;
      
      console.log(`[${this.identity}] Connecting to ${wsUrl}...`);
      
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log(`[${this.identity}] Connected`);
        this.connected = true;
        
        this.ws!.send(JSON.stringify({
          subscribe: {
            query_strings: [
              'SELECT * FROM attack_run',
              'SELECT * FROM attack_run_session',
              'SELECT * FROM claim',
            ],
          },
        }));
        
        setTimeout(resolve, 500);
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString());
          for (const handler of this.messageQueue) {
            handler(msg);
          }
        } catch {
          // Ignore parse errors
        }
      });

      this.ws.on('error', (err) => {
        console.error(`[${this.identity}] WebSocket error:`, err);
        reject(err);
      });

      this.ws.on('close', () => {
        console.log(`[${this.identity}] Disconnected`);
        this.connected = false;
      });

      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  async callReducer(reducerName: string, args: unknown[]): Promise<void> {
    if (!this.ws || !this.connected) {
      throw new Error('Not connected');
    }

    console.log(`[${this.identity}] Calling ${reducerName}(${JSON.stringify(args)})`);
    
    this.ws.send(JSON.stringify({
      call: {
        reducer: reducerName,
        args,
      },
    }));

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  async registerAttacker(roleCode: number): Promise<void> {
    await this.callReducer('register_attacker', [roleCode]);
  }

  async fileClaim(passId: number, stationId: string, amountCents: number, reason: string): Promise<void> {
    await this.callReducer('file_claim', [passId, stationId, amountCents, reason]);
  }

  async raiseOwnLimit(newLimitCents: number): Promise<void> {
    await this.callReducer('raise_own_limit', [newLimitCents]);
  }

  async editPolicy(policyId: string, newMaxClaimCents: number): Promise<void> {
    await this.callReducer('edit_policy', [policyId, newMaxClaimCents]);
  }

  async runAttackType(attackTypeCode: number): Promise<void> {
    await this.callReducer('run_attack_type', [attackTypeCode]);
  }

  async runAllAttacks(): Promise<void> {
    await this.callReducer('run_all_attacks', []);
  }

  async seedFixtures(): Promise<void> {
    await this.callReducer('seed_attack_fixtures', []);
  }

  async clearRuns(): Promise<void> {
    await this.callReducer('clear_attack_runs', []);
  }

  onMessage(handler: (msg: WSMessage) => void): void {
    this.messageQueue.push(handler);
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getIdentity(): string {
    return this.identity;
  }
}

async function runAttackAsIdentity(
  host: string,
  module: string,
  scenario: AttackScenario,
): Promise<{ caught: number; missed: number; identity: string }> {
  const client = new SpacetimeDBClient(host, module, scenario.role);
  
  try {
    await client.connect();
    
    const roleCode = scenario.role === 'admin' ? 2 : scenario.role === 'operator' ? 1 : 0;
    await client.registerAttacker(roleCode);
    
    console.log(`\n=== Running ${scenario.name} as ${scenario.role} ===`);
    console.log(`Description: ${scenario.description}`);
    
    let caught = 0;
    let missed = 0;
    
    client.onMessage((msg) => {
      if (msg.type === 'TransactionUpdate') {
        const tables = msg.data?.database_update?.tables || [];
        for (const table of tables) {
          if (table.table_name === 'attack_run_session') {
            for (const insert of table.inserts || []) {
              const session = insert as {
                caught?: number;
                missed?: number;
                completed_at?: unknown;
              };
              if (session.completed_at) {
                caught = session.caught || 0;
                missed = session.missed || 0;
              }
            }
          }
        }
      }
    });

    await client.runAttackType(scenario.attackType);
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log(`Result: Caught ${caught}, Missed ${missed}`);
    
    return { caught, missed, identity: client.getIdentity() };
  } finally {
    client.disconnect();
  }
}

async function runAllAttacksWithMultipleIdentities(
  host: string,
  module: string,
): Promise<void> {
  console.log('\n========================================');
  console.log('  Ground Truth Break It - Adversarial Testing');
  console.log('========================================\n');

  const adminClient = new SpacetimeDBClient(host, module, 'admin-setup');
  
  try {
    await adminClient.connect();
    
    console.log('Seeding fixtures and clearing previous runs...');
    await adminClient.clearRuns();
    await new Promise(resolve => setTimeout(resolve, 500));
    await adminClient.seedFixtures();
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('Fixtures seeded.\n');
  } finally {
    adminClient.disconnect();
  }

  let totalCaught = 0;
  let totalMissed = 0;
  const results: Array<{ scenario: string; caught: number; missed: number; identity: string }> = [];

  for (const scenario of ATTACK_SCENARIOS) {
    try {
      const result = await runAttackAsIdentity(host, module, scenario);
      totalCaught += result.caught;
      totalMissed += result.missed;
      results.push({
        scenario: scenario.name,
        ...result,
      });
    } catch (err) {
      console.error(`Failed to run ${scenario.name}:`, err);
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n========================================');
  console.log('  FINAL RESULTS');
  console.log('========================================\n');
  
  console.log('Per-Scenario Results:');
  for (const result of results) {
    const status = result.missed > 0 ? '⚠️  MISSED' : '✅ CAUGHT';
    console.log(`  ${status} ${result.scenario}: ${result.caught}/${result.caught + result.missed} (identity: ${result.identity})`);
  }

  const total = totalCaught + totalMissed;
  const percentage = total > 0 ? ((totalCaught / total) * 100).toFixed(1) : '0.0';
  
  console.log('\n========================================');
  console.log(`  SCORE: ${totalCaught} / ${total} caught (${percentage}%)`);
  console.log(`  Misses: ${totalMissed}`);
  console.log('========================================\n');
  
  if (totalMissed > 0) {
    console.log('⚠️  WARNING: Some attacks were not caught!');
    console.log('Review the fraud detection logic for improvements.\n');
  } else {
    console.log('✅ All attacks were successfully caught!\n');
  }
}

async function runDirectAttacks(host: string, module: string): Promise<void> {
  console.log('\n========================================');
  console.log('  Direct Attack Simulation');
  console.log('========================================\n');

  const customers = [
    new SpacetimeDBClient(host, module, 'adversarial-customer'),
    new SpacetimeDBClient(host, module, 'duplicate-claimer'),
    new SpacetimeDBClient(host, module, 'forger'),
  ];
  
  const insider = new SpacetimeDBClient(host, module, 'insider-operator');
  
  try {
    for (const client of customers) {
      await client.connect();
      await client.registerAttacker(0);
    }
    await insider.connect();
    await insider.registerAttacker(1);
    
    console.log('\n--- Adversarial Customer: Filing bogus claims ---');
    await customers[0].fileClaim(999, 'FAKE-STATION', 5000000, 'Dropped pass compensation for solar flare');
    await customers[0].fileClaim(1, 'STATION-A', 2500000, 'Inflated bandwidth charges');
    
    console.log('\n--- Duplicate Claimer: Double-submitting ---');
    await customers[1].fileClaim(10, 'STATION-B', 1500000, 'First legitimate claim');
    await new Promise(resolve => setTimeout(resolve, 200));
    await customers[1].fileClaim(10, 'STATION-B', 1500000, 'Duplicate submission');
    
    console.log('\n--- Forger: Wrong station claims ---');
    await customers[2].fileClaim(20, 'FORGED-STATION-X', 4500000, 'Telemetry compensation');
    
    console.log('\n--- Insider: Attempting to raise own limit ---');
    await insider.raiseOwnLimit(50000000);
    
    console.log('\n--- Insider: Attempting to edit policy ---');
    await insider.editPolicy('default', 999999999);

    console.log('\nDirect attacks completed. Check claims table for results.');
    
  } finally {
    for (const client of customers) {
      client.disconnect();
    }
    insider.disconnect();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let host = SPACETIMEDB_HOST;
  let module = SPACETIMEDB_MODULE;
  let mode = 'all';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && args[i + 1]) {
      host = args[i + 1];
      i++;
    } else if (args[i] === '--module' && args[i + 1]) {
      module = args[i + 1];
      i++;
    } else if (args[i] === '--direct') {
      mode = 'direct';
    }
  }

  console.log(`Host: ${host}`);
  console.log(`Module: ${module}`);
  console.log(`Mode: ${mode}`);

  try {
    if (mode === 'direct') {
      await runDirectAttacks(host, module);
    } else {
      await runAllAttacksWithMultipleIdentities(host, module);
    }
  } catch (err) {
    console.error('Error running attacks:', err);
    process.exit(1);
  }
}

main();
