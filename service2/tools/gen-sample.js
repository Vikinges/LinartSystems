#!/usr/bin/env node
/**
 * Быстрый само‑тест: отправляет минимальный набор данных на запущенный service2
 * и сохраняет PDF в out/sample-debug.pdf.
 *
 * Запуск:
 *   FORM_HOST=http://localhost:3001 node tools/gen-sample.js
 * (host по умолчанию http://localhost:3001)
 */

const fs = require('fs');

const HOST = process.env.FORM_HOST || 'http://localhost:3001';
const TARGET = `${HOST.replace(/\/$/, '')}/submit`;

async function main() {
  const form = new FormData();

  // Site info
  form.set('end_customer_name', 'Siemens AG');
  form.set('site_location', 'Erlangen');
  form.set('led_display_model', 'FA 1.5/1.9/2.5');
  form.set('batch_number', 'BATCH-001');
  form.set('date_of_service', '2025-11-26');
  form.set('service_company_name', 'Sharp');

  // Employees
  form.set('employees[0][name]', 'Vladimir Linartas');
  form.set('employees[0][role]', 'Engineer');
  form.set('employees[0][arrival]', '2025-11-26T08:37');
  form.set('employees[0][departure]', '2025-11-26T09:37');

  // Checklists (галочки)
  form.set('led_complete_1', 'on');
  form.set('control_complete_1', 'on');
  form.set('signoff_complete_1', 'on');

  // Sign-off
  form.set('engineer_company', 'Sharp / NEC LED Solution Center');
  form.set('engineer_datetime', '2025-11-26T08:20');
  form.set('engineer_name', 'Vladimir Linartas');
  form.set('customer_company', 'Mercedes-Benz AG');
  form.set('customer_datetime', '2025-11-26T07:19');
  form.set('customer_name', 'Mercedes-Benz AG');

  // Подписи (пустые, но поля есть)
  form.set('engineer_signature', '');
  form.set('customer_signature', '');

  // Parts (чтобы увидеть блок)
  form.set('parts_removed_desc_1', 'Pixel card cabinet B2');

  console.log(`[gen-sample] POST ${TARGET}`);
  const res = await fetch(TARGET, { method: 'POST', body: form });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    console.error(`[gen-sample] Request failed ${res.status}: ${buf.toString()}`);
    process.exit(1);
  }
  fs.writeFileSync('out/sample-debug.pdf', buf);
  console.log(`[gen-sample] Saved out/sample-debug.pdf (${buf.length} bytes)`);
}

main().catch((err) => {
  console.error('[gen-sample] Error:', err);
  process.exit(1);
});
