const fs = require('fs');
const path = 'server.js';
let text = fs.readFileSync(path, 'utf8');
const original = "${renderSignaturePad('engineer_signature', \"Engineer signature\")}\r\n${renderSignaturePad('customer_signature', \"Customer signature\")}";
if (!text.includes(original)) {
  throw new Error('signature render calls not found');
}
const replacement = "${engineerSignatureMarkup}\r\n${customerSignatureMarkup}";
text = text.replace(original, replacement);
fs.writeFileSync(path, text);
