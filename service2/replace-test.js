const fs = require('fs');
const path = 'server.js';
let text = fs.readFileSync(path, 'utf8');
const original = "${renderSignaturePad('customer_signature', \"Customer signature\")}";
if (!text.includes(original)) {
  throw new Error('line not found');
}
const replacement = '        <div class="signature-pad placeholder">Customer signature pad</div>';
text = text.replace(original, replacement);
fs.writeFileSync(path, text);
