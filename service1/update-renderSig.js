const fs = require('fs');
const path = 'server.js';
let text = fs.readFileSync(path, 'utf8');
const pattern = /  const renderSignaturePad = \(name, label\) => \{[\s\S]+?\n  const htmlParts = \[];/;
if (!pattern.test(text)) {
  throw new Error('renderSignaturePad block not found');
}
const replacement = `  const renderSignaturePad = (name, label) => {\n    const descriptor = descriptorByName.get(name);\n    if (!descriptor) {\n      return \`        <!-- Missing signature field \\${escapeHtml(name)} -->\`;\n    }\n    const sample = signatureSamples.get(name) || '';\n    return \`        <div class="signature-pad" data-field="\\${escapeHtml(descriptor.requestName)}" data-sample="\\${escapeHtml(sample)}">\n          <div class="signature-pad__label">\n            <span>\\${escapeHtml(label)}</span>\n            <button type="button" class="signature-clear">Clear</button>\n          </div>\n          <div class="signature-canvas-wrapper">\n            <canvas aria-label="\\${escapeHtml(label)} signature area"></canvas>\n          </div>\n          <input type="hidden" name="\\${escapeHtml(descriptor.requestName)}" value="" />\n        </div>\`;\n  };\n\n  const engineerSignatureMarkup = renderSignaturePad('engineer_signature', "Engineer signature");\n  const customerSignatureMarkup = renderSignaturePad('customer_signature', "Customer signature");\n\n  const htmlParts = [];`;
text = text.replace(pattern, replacement);
fs.writeFileSync(path, text);
