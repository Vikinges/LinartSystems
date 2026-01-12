#!/usr/bin/env node
/**
 * Sample payload for the installation report. Requires service2 to be running.
 *
 * Run:
 *   FORM_HOST=http://localhost:3001 node tools/gen-installation-sample.js
 */

const fs = require('fs');

const HOST = process.env.FORM_HOST || 'http://localhost:3001';
const TARGET = `${HOST.replace(/\/$/, '')}/submit`;

async function main() {
  const form = new FormData();

  form.set('template_type', 'installation_report');

  // Project details
  form.set('batch_number', 'LSC-2026-001');
  form.set('building_project_acceptance', 'Berlin HQ LED Wall');
  form.set('end_customer_name', 'Acme GmbH');
  form.set('completion_date', '2026-01-10');

  // Attendees
  form.set('attendee_client', 'John Doe');
  form.set('attendee_supplier', 'Vladimir Linartas');

  // Acceptance
  form.set('acceptance_date', '2026-01-11');
  form.set('acceptance_overall', 'on');
  form.set('partial_services', 'LED wall commissioning and calibration');

  // Defects / remaining
  form.set('defects_none', 'on');
  form.set('defects_deadline', '2026-01-20');
  form.set('remaining_deadline', '2026-02-01');
  form.set('supplier_objections', 'None');

  // Declaration
  form.set('declaration_accepted', 'on');

  // Warranty
  form.set('warranty_years', '2');
  form.set('warranty_begin', '2026-01-11');
  form.set('warranty_end', '2028-01-10');

  // Annex 1 sample (optional section)
  form.set('annex1_date', '2026-01-11');
  form.set('annex1_building_project', 'Berlin HQ LED Wall');
  form.set('annex1_defects', 'Minor pixel defect at top-left corner.');
  form.set('annex1_remaining', 'Final color tuning to be done after content sign-off.');
  form.set('annex1_objections', 'None.');
  form.set('annex1_reservations', 'Acceptance subject to minor pixel replacement.');

  // Parts (Annex 2)
  form.set('parts_removed_part_1', '2');
  form.set('parts_removed_desc_1', 'Pixel card cabinet B2');
  form.set('parts_used_part_1', '2');
  form.set('parts_used_serial_1', 'PC-7788 / PC-7789');
  form.set('parts_removed_part_2', '1');
  form.set('parts_removed_desc_2', 'Signal cable set');
  form.set('parts_used_part_2', '1');
  form.set('parts_used_serial_2', 'CABL-4433');

  // Signatures
  form.set('engineer_signature', '');
  form.set('customer_signature', '');

  console.log(`[gen-installation] POST ${TARGET}`);
  const res = await fetch(TARGET, { method: 'POST', body: form });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    console.error(`[gen-installation] Request failed ${res.status}: ${buf.toString()}`);
    process.exit(1);
  }
  fs.writeFileSync('out/sample-installation.pdf', buf);
  console.log(`[gen-installation] Saved out/sample-installation.pdf (${buf.length} bytes)`);
}

main().catch((err) => {
  console.error('[gen-installation] Error:', err);
  process.exit(1);
});
