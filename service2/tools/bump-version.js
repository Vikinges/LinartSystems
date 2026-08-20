#!/usr/bin/env node
// Bump the web version by 0.01. Called by .githooks/pre-commit whenever a commit touches
// service2, so the deployed build always announces a version nobody had to remember to
// change — and every report it generates carries that same number in its provenance.
//
//   node tools/bump-version.js          bump and write
//   node tools/bump-version.js --print  print the current version, change nothing

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'version.json');

function read() {
  const raw = fs.readFileSync(FILE, 'utf8');
  const parsed = JSON.parse(raw);
  const value = String(parsed.version || '').trim();
  if (!/^\d+\.\d{2}$/.test(value)) {
    throw new Error(`version.json holds "${value}", expected N.NN`);
  }
  return value;
}

function bump(value) {
  // Work in hundredths rather than floats: 0.29 + 0.01 in floating point is 0.30000000000004,
  // and a version string is not the place to discover that.
  const hundredths = Math.round(Number(value) * 100) + 1;
  return (hundredths / 100).toFixed(2);
}

try {
  const current = read();
  if (process.argv.includes('--print')) {
    process.stdout.write(current);
    process.exit(0);
  }
  const next = bump(current);
  fs.writeFileSync(FILE, `${JSON.stringify({ version: next }, null, 2)}\n`, 'utf8');
  console.log(`service2 version ${current} -> ${next}`);
} catch (err) {
  console.error(`bump-version: ${err.message}`);
  process.exit(1);
}
