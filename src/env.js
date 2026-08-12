// env.js — read .env into process.env. Four lines of parsing beats a dependency.
// Values already in the environment win, so a shell export overrides the file.

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '.env');

try {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  // no .env; the environment is expected to carry the keys
}
