#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFButton, PDFRadioGroup, PDFSignature } = require('pdf-lib');

const DEFAULT_TEMPLATE = "/mnt/data/SNDS-LED-Preventative-Maintenance-Checklist BER Blanko.pdf";
const OUTPUT_PATH = path.resolve(process.cwd(), 'fields.json');

function fieldTypeName(field) {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'option-list';
  if (field instanceof PDFButton) return 'button';
  if (field instanceof PDFRadioGroup) return 'radio-group';
  if (field instanceof PDFSignature) return 'signature';
  return field.constructor ? field.constructor.name : 'unknown';
}

(async () => {
  const templatePath = process.env.TEMPLATE_PATH || DEFAULT_TEMPLATE;

  try {
    if (!templatePath) {
      throw new Error('Template path is not defined. Set TEMPLATE_PATH environment variable.');
    }

    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template PDF not found at: ${templatePath}`);
    }

    const pdfBytes = await fs.promises.readFile(templatePath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    const form = pdfDoc.getForm();
    if (!form) {
      throw new Error('The provided PDF does not contain an AcroForm.');
    }

    const fields = form.getFields().map((field) => {
      const name = field.getName();
      const type = fieldTypeName(field);
      return { name, type };
    });

    const result = {
      templatePath,
      extractedAt: new Date().toISOString(),
      fieldCount: fields.length,
      fields,
    };

    await fs.promises.writeFile(OUTPUT_PATH, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`[extract-fields] ${err.message}`);
    process.exit(1);
  }
})();

