// fetch-fedach.js — build data/routing-directory.json from the FedACH participant file.
//
// The Federal Reserve publishes the FedACH participant directory (every routing number
// in the ACH network plus the institution that owns it), but the live download at
// frbservices.org is behind an agreement gate and returns an empty body to a script.
// moov-io/fed keeps a plaintext copy in its repo, which is what this pulls.
//
//   node tools/fetch-fedach.js
//
// Writes data/routing-directory.json: { "021000021": "JPMORGAN CHASE", ... }
// The bot uses it to read the bank's name back to the caller ("I have that as Chase,
// is that right?"). validate.js works without the file — the ABA checksum is the
// load-bearing test and it is pure arithmetic. The directory only adds the name.

const https = require('https');
const fs = require('fs');
const path = require('path');

const SOURCES = [
  'https://raw.githubusercontent.com/moov-io/fed/master/data/FedACHdir.txt',
  'https://raw.githubusercontent.com/moov-io/fed/master/data/FedACHdir.json',
];

const OUT = path.join(__dirname, '..', 'data', 'routing-directory.json');

function get(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          return resolve(get(res.headers.location, depth + 1));
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

// Fixed-width FedACH record. 1-indexed field positions from the Fed's layout:
//   1-9 routing number, 10 office code, 11-19 servicing FRB, 20 record type,
//   21-26 change date, 27-35 new routing number, 36-71 customer name,
//   72-107 address, 108-127 city, 128-129 state, 130-134 zip.
function parseFixedWidth(text) {
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 129) continue;
    const rn = line.slice(0, 9);
    if (!/^\d{9}$/.test(rn)) continue;
    const name = line.slice(35, 71).trim();
    const state = line.slice(127, 129).trim();
    if (name) map[rn] = state ? `${name} (${state})` : name;
  }
  return map;
}

function parseJson(text) {
  const map = {};
  const rows = JSON.parse(text);
  const list = Array.isArray(rows) ? rows : rows.achParticipants || [];
  for (const r of list) {
    const rn = r.routingNumber || r.routing_number;
    const name = r.customerName || r.customer_name;
    if (/^\d{9}$/.test(String(rn)) && name) map[String(rn)] = String(name).trim();
  }
  return map;
}

(async () => {
  for (const url of SOURCES) {
    let res;
    try {
      res = await get(url);
    } catch (e) {
      console.log(`${url} -> ${e.message}`);
      continue;
    }
    console.log(`${url} -> ${res.status}, ${res.body.length} bytes`);
    if (res.status !== 200 || res.body.length < 10000) continue;

    let map;
    try {
      map = url.endsWith('.json') ? parseJson(res.body) : parseFixedWidth(res.body);
    } catch (e) {
      console.log(`  parse failed: ${e.message}`);
      continue;
    }

    const count = Object.keys(map).length;
    if (count < 1000) {
      console.log(`  only ${count} rows parsed, skipping`);
      continue;
    }

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(map));
    console.log(`wrote ${OUT} — ${count} routing numbers`);
    const sample = Object.entries(map).slice(0, 3);
    for (const [rn, name] of sample) console.log(`  ${rn}  ${name}`);
    return;
  }
  console.log('No source returned a usable directory. validate.js falls back to checksum only.');
  process.exit(1);
})();
