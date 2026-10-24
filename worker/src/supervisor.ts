/**
 * `npm start` entry point. Runs the decision worker (src/index.ts) as a child
 * process and restarts it whenever it exits: on a dropped connection, a module
 * republish, or the heartbeat watchdog finding the socket dead. Break It's
 * prompt-injection row and every System 1/System 2 decision need this one process.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/** A run that lasted this long counts as healthy and resets the backoff. */
const HEALTHY_RUN_MS = 60_000;

let delay = MIN_DELAY_MS;
let child: ChildProcess | null = null;
let stopping = false;

function run() {
  const started = Date.now();
  child = spawn(process.execPath, ['--import', 'tsx', entry], { stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(code ?? 0);
    if (Date.now() - started > HEALTHY_RUN_MS) delay = MIN_DELAY_MS;
    console.error(`[supervisor] worker exited (${signal ?? `code ${code}`}); restarting in ${delay / 1000}s`);
    setTimeout(run, delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

run();
