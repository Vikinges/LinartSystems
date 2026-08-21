#!/usr/bin/env node
// Pre-deploy smoke test. service2 is production: the archive holds signed customer
// documents, so "it started without crashing" is not evidence that it works. This drives
// the real HTTP surface the way an engineer does and fails loudly on anything that would
// reach a customer.
//
//   node tools/smoke.js [baseUrl]      default http://localhost:3011
//
// Exit code 0 = safe to deploy, 1 = do not.

const vm = require('vm');
const zlib = require('zlib');

const BASE = (process.argv[2] || 'http://localhost:3011').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.SERVICE2_ADMIN_TOKEN || 'testtoken';

const failures = [];
const notes = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
  return condition;
}

async function submit(fields) {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, String(value)));
  const res = await fetch(`${BASE}/submit`, { method: 'POST', body: form });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// Content streams are Flate-compressed, so the drawn text is not in the raw bytes. Inflate
// every stream that carries a show-text operator and pull the strings back out; that is the
// only way to assert a value actually reached the page rather than merely being accepted.
function extractPdfText(buf) {
  const bytes = buf.toString('latin1');
  const pieces = [];
  const streamRe = /stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(bytes)) !== null) {
    const start = m.index + m[0].length;
    const end = bytes.indexOf('endstream', start);
    if (end < 0) continue;
    let chunk = Buffer.from(bytes.slice(start, end), 'latin1');
    try {
      chunk = zlib.inflateSync(chunk);
    } catch (err) {
      // Not compressed, or an image: use it as-is and let the text match decide.
    }
    const text = chunk.toString('latin1');
    if (!text.includes('Tj') && !text.includes('TJ')) continue;

    // pdf-lib writes what we draw as hex strings; literal strings show up too.
    const hexRe = /<([0-9A-Fa-f\s]+)>\s*Tj/g;
    let h;
    while ((h = hexRe.exec(text)) !== null) {
      const hex = h[1].replace(/\s+/g, '');
      pieces.push(Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('latin1'));
    }
    const litRe = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
    let l;
    while ((l = litRe.exec(text)) !== null) pieces.push(l[1]);
  }
  return pieces.join(' ');
}

async function pdfText(url) {
  const res = await fetch(`${BASE}/${String(url).replace(/^\/+/, '')}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { size: buf.length, raw: extractPdfText(buf) };
}

// A drawn string may be split across show-text operators, so compare on the letters alone.
const squash = (s) => s.replace(/[^A-Za-z0-9]+/g, '').toLowerCase();

async function checkFormPage() {
  console.log('\nform page');
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  check('GET / responds 200', res.status === 200, `got ${res.status}`);

  // The page script is emitted from a template literal. When it breaks, the server stays
  // up and the form silently does nothing — the failure this whole file exists for.
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let index = 0;
  let broken = 0;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (type && !/^(text|application)\/(java|ecma)script$/i.test(type[1])) continue;
    index += 1;
    if (!match[2].trim()) continue;
    try {
      new vm.Script(match[2], { filename: `index.html:inline-${index}` });
    } catch (err) {
      broken += 1;
      console.log(`  FAIL  inline script #${index} does not parse — ${err.message}`);
    }
  }
  check(`all ${index} inline scripts parse`, broken === 0);

  // An absolute /api/... path works here and 404s on prod, where the form is served behind
  // /service2/. That asymmetry means local testing cannot see the bug at all, so catch it
  // statically instead: found on prod once, never again.
  const absoluteApiCalls = [...html.matchAll(/fetch\(\s*['"`](\/[^'"`]*)/g)]
    .map((m) => m[1])
    .filter((p) => !p.startsWith('/service2/'));
  check(
    'no absolute /api paths in page scripts',
    absoluteApiCalls.length === 0,
    absoluteApiCalls.join(', '),
  );

  // Fields the renderer prints must be reachable from the browser, or the document comes
  // out with blank rows nobody can fill in.
  [
    'end_customer_name', 'site_location', 'batch_number', 'lsc_project_name',
    'service_company_name', 'date_of_service', 'customer_phone', 'customer_email',
    'attendee_client', 'attendee_supplier', 'installation_status', 'installation_defects',
    'warranty_years', 'warranty_start_date', 'acceptance_statement', 'spare_stock_type_1',
  ].forEach((name) => {
    check(`form has a field named ${name}`, html.includes(`name="${name}"`));
  });
}

async function checkReports() {
  const common = {
    end_customer_name: 'Smoke Test GmbH',
    site_location: 'Erlangen, Halle 1',
    batch_number: '20-0000',
    lsc_project_name: 'Siemens Erlangen',
    service_company_name: 'Sharp LED Solution Center',
    date_of_service: '2026-08-10',
    engineer_name: 'Smoke Engineer',
    customer_name: 'Smoke Client',
  };

  const cases = [
    {
      name: 'service report',
      fields: {
        ...common,
        template_type: 'service_report',
        problem_description: 'One module stayed dark.',
        work_performed: 'Replaced the module.',
      },
      expect: ['Smoke Test GmbH', '20-0000', 'Siemens Erlangen', 'Replaced the module.'],
    },
    {
      name: 'maintenance report',
      fields: {
        ...common,
        template_type: 'maintenance',
        parts_type_1: 'Receiving card',
        parts_used_part_1: 'RC-A5',
        spare_stock_type_1: 'Hub board',
        spare_stock_qty_1: '2',
      },
      expect: ['Smoke Test GmbH', '20-0000', 'Siemens Erlangen', 'Receiving card', 'Hub board'],
    },
    {
      name: 'installation report',
      fields: {
        ...common,
        template_type: 'installation_report',
        acceptance_date: '2026-08-14',
        attendee_client: 'Smoke Client',
        attendee_supplier: 'Smoke Engineer',
        installation_status: 'not_finished',
        installation_partial_notes: 'Trunking still open.',
        installation_has_defects: 'on',
        installation_defects: 'Two modules colour-shifted.',
        installation_followup_type: 'planned',
        installation_followup_date: '2026-09-05',
        warranty_years: '2',
        warranty_start_date: '2026-08-14',
        acceptance_statement: 'Acceptance has taken place.',
      },
      expect: [
        'Siemens Erlangen',
        'Installation not fully finished. Trunking still open.',
        'Warranty ends on',
        // The installation is not finished in this case, so the warranty runs from the
        // agreed completion date (05.09.2026) rather than the signing date, and the end is
        // computed from that. Guards the rule, not just the arithmetic.
        '05.09.2028',
        'The warranty runs from completion of the outstanding work',
        'Acceptance has taken place.',
        'Annex 1',
        'Two modules colour-shifted.',
        'Planned completion - no later than 05.09.2026',
      ],
    },
    {
      name: 'daily report',
      fields: {
        template_type: 'daily_report',
        daily_project_number: '20-0000',
        daily_report_date: '2026-08-14',
        submitter_name: 'Smoke Engineer',
        daily_report_text: 'Cabling continued on the north wall.',
      },
      expect: ['Cabling continued on the north wall.', '20-0000'],
    },
  ];

  for (const testCase of cases) {
    console.log(`\n${testCase.name}`);
    const { status, json } = await submit(testCase.fields);
    if (!check('submit accepted', status === 200 && json.ok, json.error || `HTTP ${status}`)) continue;

    const { size, raw } = await pdfText(json.url);
    check('pdf is not empty', size > 5000, `${size} bytes`);

    const flat = squash(raw);
    testCase.expect.forEach((needle) => {
      check(`document contains "${needle}"`, flat.includes(squash(needle)));
    });
  }
}

async function checkProjectKeys() {
  // The number and the name are two different things and one legacy alias is spelled like
  // the wrong one. If this ever regresses, a job's name prints in the number row.
  console.log('\nproject number vs project name');

  const asNumber = await submit({
    template_type: 'service_report',
    end_customer_name: 'Alias Test',
    project_name: '20-0001',                 // legacy alias holding the NUMBER
    work_performed: 'Alias check.',
    engineer_name: 'Smoke Engineer',
  });
  if (check('submit with project_name=number accepted', asNumber.status === 200 && asNumber.json.ok)) {
    const { raw } = await pdfText(asNumber.json.url);
    check('a number under project_name prints as the number', squash(raw).includes(squash('200001')));
  }

  const asName = await submit({
    template_type: 'service_report',
    end_customer_name: 'Alias Test',
    batch_number: '20-0002',
    project_name: 'Siemens Erlangen',        // same alias, plainly holding a NAME
    work_performed: 'Alias check.',
    engineer_name: 'Smoke Engineer',
  });
  if (check('submit with project_name=name accepted', asName.status === 200 && asName.json.ok)) {
    const { raw } = await pdfText(asName.json.url);
    const flat = squash(raw);
    check('the number row still shows the number', flat.includes(squash('20-0002')));
    check('a name under project_name lands in the name row', flat.includes(squash('Siemens Erlangen')));
  }
}

async function checkArchive() {
  console.log('\narchive');
  const res = await fetch(`${BASE}/api/files?q=siemens+erlangen`, {
    headers: { 'x-admin-token': ADMIN_TOKEN },
  });
  if (res.status === 401 || res.status === 403) {
    notes.push('archive search skipped: SERVICE2_ADMIN_TOKEN did not match this server');
    console.log('  skip  archive search (admin token rejected)');
    return;
  }
  const body = await res.json().catch(() => null);
  const items = Array.isArray(body) ? body : (body?.files || body?.items || body?.entries || []);
  check('search by project name finds the report', items.length > 0, `${items.length} results`);
}

async function main() {
  console.log(`smoke test against ${BASE}`);

  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health || health.status !== 200) {
    console.error(`\nCannot reach ${BASE}/health — is the server running?`);
    process.exit(1);
  }

  await checkFormPage();
  await checkReports();
  await checkProjectKeys();
  await checkArchive();

  notes.forEach((note) => console.log(`\nnote: ${note}`));

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed. Do not deploy.`);
    failures.forEach((name) => console.error(`  - ${name}`));
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((err) => {
  console.error(`\nSmoke test crashed: ${err.stack || err.message}`);
  process.exit(1);
});
