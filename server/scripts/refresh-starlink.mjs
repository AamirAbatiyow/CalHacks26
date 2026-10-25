// Refreshes the TLEs of the curated Starlink sample in fixtures/starlink.json.
//   - TLEs come from CelesTrak's GP API, one small query per satellite (SGP4-ready,
//     the same source as satellites.json).
//   - Each satellite is checked against SpaceX's public Starlink ephemerides
//     manifest (api.starlink.com/public-files/ephemerides), which lists every
//     operational Starlink. Those files are Modified ITC state vectors with
//     covariance, not TLEs, so they confirm status rather than feed SGP4.
// The NORAD IDs are fixed so the globe shows the same satellites every demo; only
// their elements change. The web app reads the fixture at build time, so rebuild
// (or redeploy) after running this. Nothing here is seeded into the module or billed.
// Usage: node refresh-starlink.mjs [fixture_path]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = process.argv[2] ?? path.join(here, '../fixtures/starlink.json');
const TLE_URL = 'https://celestrak.org/NORAD/elements/gp.php?CATNR={norad_id}&FORMAT=tle';
const MANIFEST_URL = 'https://api.starlink.com/public-files/ephemerides/MANIFEST.txt';

async function fetchText(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'ground-truth-calhacks26 (refresh-starlink.mjs)' } });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
}

function parseTle(text, noradId) {
  const lines = text.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  for (let i = 0; i + 2 < lines.length; i++) {
    if (lines[i + 1].startsWith('1 ') && lines[i + 2].startsWith('2 ') && Number(lines[i + 1].slice(2, 7)) === noradId) {
      return { name: lines[i].trim(), line1: lines[i + 1], line2: lines[i + 2] };
    }
  }
  return null;
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

// MEME_<id>_<NAME>_<epoch>_<Status>_<...>_UNCLASSIFIED.txt
const operational = new Set();
for (const file of (await fetchText(MANIFEST_URL)).split(/\r?\n/)) {
  const parts = file.trim().split('_');
  if (parts.length > 4 && parts[4] === 'Operational') operational.add(parts[2]);
}
if (operational.size === 0) throw new Error('Starlink manifest listed no operational satellites');

let refreshed = 0;
const satellites = [];
for (const sat of fixture.satellites) {
  const tle = await fetchText(TLE_URL.replace('{norad_id}', sat.norad_id))
    .then(text => parseTle(text, sat.norad_id))
    .catch(err => { console.error(String(err)); return null; });
  if (!tle) {
    console.error(`No TLE for NORAD ${sat.norad_id} (${sat.name}); keeping the old one`);
    satellites.push(sat);
    continue;
  }
  if (!operational.has(tle.name)) console.error(`${tle.name} is not listed as Operational in the Starlink manifest`);
  satellites.push({ norad_id: sat.norad_id, name: tle.name, tle_line1: tle.line1, tle_line2: tle.line2 });
  refreshed++;
}

const listed = satellites.filter(s => operational.has(s.name)).length;
const source = {
  tle: TLE_URL,
  status: MANIFEST_URL,
  refreshed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  operational_in_manifest: listed,
};
writeFileSync(fixturePath, JSON.stringify({ source, satellites }, null, 2) + '\n');
console.error(`Refreshed ${refreshed} of ${satellites.length} Starlink TLEs; `
  + `${listed} listed as Operational among ${operational.size} in the Starlink manifest.`);
