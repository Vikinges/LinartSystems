#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const OUTPUT_PATH = path.resolve(__dirname, 'public', 'form-template1.pdf');

async function main() {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const form = pdfDoc.getForm();
  const pageSize = { width: 595.28, height: 841.89 };

  function drawHeader(page, title, options = {}) {
    const { includeIntro = false } = options;
    const baseY = page.getHeight() - 60;

    const logoText = 'SHARP';
    const logoWidth = boldFont.widthOfTextAtSize(logoText, 38);
    page.drawText(logoText, {
      x: (page.getWidth() - logoWidth) / 2,
      y: baseY + 8,
      size: 38,
      font: boldFont,
      color: rgb(0.85, 0.07, 0.12),
    });
    if (includeIntro) {
      const introLines = [
        'Preventative maintenance must be completed once per year for every LED display covered by a service contract.',
        'Use this checklist to confirm each task and capture any notes or follow-up actions that are required.',
        'Email the completed checklist to LED-Support@sharp.eu within 48 hours of the service visit.',
      ];
      const introLineHeight = 14;
      introLines.forEach((line, index) => {
        page.drawText(line, {
          x: 40,
          y: baseY - 58 - index * introLineHeight,
          size: 10.5,
          font,
          color: rgb(0.18, 0.18, 0.22),
        });
      });
    }
    if (title) {
      const introBlockHeight = includeIntro ? 58 + 14 * 3 : 0;
      const offset = includeIntro ? introBlockHeight + 24 : 40;
      const titleWidth = boldFont.widthOfTextAtSize(title, 17);
      page.drawText(title, {
        x: (page.getWidth() - titleWidth) / 2,
        y: baseY - offset,
        size: 17,
        font: boldFont,
        color: rgb(0.06, 0.12, 0.35),
      });
    }
  }

  function drawTable(page, { x, y, width, rowHeight, headers, rows }) {
    const colWidths = headers.map((h) => h.width);
    const totalWidth = colWidths.reduce((sum, w) => sum + w, 0);
    const scale = width / totalWidth;
    const scaledWidths = colWidths.map((w) => w * scale);

    let currentY = y;


    let currentX = x;
    headers.forEach((header, idx) => {
      const w = scaledWidths[idx];
      page.drawRectangle({
        x: currentX,
        y: currentY - rowHeight,
        width: w,
        height: rowHeight,
        borderWidth: 1,
        borderColor: rgb(0.1, 0.1, 0.4),
        color: rgb(0.88, 0.92, 0.98),
      });
      const headerText = String(header.label ?? '');
      const headerLines = headerText.split('\n');
      const headerLineHeight = header.lineHeight || 10;
      const headerFontSize = header.fontSize || 10;
      const headerColor = header.color || rgb(0.1, 0.1, 0.3);
      let textY = currentY - rowHeight + rowHeight - headerLineHeight - 2;
      headerLines.forEach((line) => {
        const safeLine = line.trim();
        page.drawText(safeLine, {
          x: currentX + 6,
          y: textY,
          font: boldFont,
          size: headerFontSize,
          color: headerColor,
        });
        textY -= headerLineHeight;
      });
      currentX += w;
    });

    currentY -= rowHeight;

    rows.forEach((row) => {
      currentX = x;
      row.cells.forEach((cell, idx) => {
        const w = scaledWidths[idx];
        page.drawRectangle({ x: currentX, y: currentY - rowHeight, width: w, height: rowHeight, borderWidth: 0.7, borderColor: rgb(0.1, 0.1, 0.4) });
        if (typeof cell === 'string') {
          page.drawText(cell, {
            x: currentX + 6,
            y: currentY - rowHeight + 8,
            font,
            size: 9,
            color: rgb(0.15, 0.15, 0.2),
          });
        }
        currentX += w;
      });
      currentY -= rowHeight;
    });
  }

  const FIELD_PADDING_X = 4;
  const FIELD_PADDING_Y = 2;

  function applyFieldDefaults(field, { font: fieldFont = font, fontSize = 10, multiline = false } = {}) {
    if (!field) return;
    if (multiline && typeof field.enableMultiline === 'function') {
      try {
        field.enableMultiline();
      } catch (err) {
        console.warn('[template] Unable to enable multiline', err.message);
      }
    }
    if (fieldFont) {
      try {
        field.updateAppearances(fieldFont);
      } catch (err) {
        console.warn('[template] Unable to update appearance', err.message);
      }
    }
    if (typeof field.setFontSize === 'function') {
      try {
        field.setFontSize(fontSize);
      } catch (err) {
        console.warn('[template] Unable to set font size', err.message);
      }
    }
  }


  let page = pdfDoc.addPage([pageSize.width, pageSize.height]);
  drawHeader(page, 'Preventative Maintenance Checklist', { includeIntro: true });

  const siteTableTop = pageSize.height - 220;
  drawTable(page, {
    x: 40,
    y: siteTableTop,
    width: pageSize.width - 80,
    rowHeight: 22,
    headers: [
      { label: 'Site information', width: 200 },
      { label: '', width: 320 },
    ],
    rows: [
      { cells: ['End customer name', ''] },
      { cells: ['Site location', ''] },
      { cells: ['LED display model', ''] },
      { cells: ['Batch number', ''] },
      { cells: ['Date of service', ''] },
      { cells: ['Service company name', ''] },
    ],
  });

  const siteFields = [
    'end_customer_name',
    'site_location',
    'led_display_model',
    'batch_number',
    'date_of_service',
    'service_company_name',
  ];

  siteFields.forEach((name, idx) => {
    const field = form.createTextField(name);
    const rowY = siteTableTop - 22 * (idx + 1);
    const baseHeight = 18;
    const baseX =
      40 + ((200 * (pageSize.width - 80)) / (200 + 320)) + 4;
    const baseWidth = ((pageSize.width - 80) * 320) / (200 + 320) - 8;
    const baseY = rowY - baseHeight;
    field.addToPage(page, {
      x: baseX + FIELD_PADDING_X,
      y: baseY + FIELD_PADDING_Y,
      width: baseWidth - FIELD_PADDING_X * 2,
      height: baseHeight - FIELD_PADDING_Y * 2,
    });
    applyFieldDefaults(field);
  });

  const ledTableTop = siteTableTop - 22 * (siteFields.length + 1) - 40;
  drawTable(page, {
    x: 40,
    y: ledTableTop,
    width: pageSize.width - 80,
    rowHeight: 30,
    headers: [
      { label: 'LED Display - Action', width: 260 },
      { label: 'Complete', width: 80 },
      { label: 'Notes', width: 180 },
    ],
    rows: [
      { cells: ['Check for visible issues. Resolve as necessary.', '', ''] },
      { cells: ['Apply test pattern on full colours. Identify faults.', '', ''] },
      { cells: ['Replace pixel cards with dead/non-functioning pixels.', '', ''] },
      { cells: ['Check power/data cables between cabinets for secure connections.', '', ''] },
      { cells: ['Inspect for damage and replace damaged cables.', '', ''] },
      { cells: ['Check monitoring feature for issues. Resolve as necessary.', '', ''] },
      { cells: ['Check brightness levels and note configurations.', '', ''] },
    ],
  });

  const ledRows = 7;
  for (let i = 0; i < ledRows; i += 1) {
    const cb = form.createCheckBox(`led_complete_${i + 1}`);
    const rowY = ledTableTop - 30 * (i + 1);
    cb.addToPage(page, {
      x: 40 + (pageSize.width - 80) * 260 / (260 + 80 + 180) + 24,
      y: rowY - 18,
      width: 14,
      height: 14,
    });
    const noteField = form.createTextField(`led_notes_${i + 1}`);
    const noteBaseX =
      40 + ((pageSize.width - 80) * (260 + 80)) / (260 + 80 + 180) + 6;
    const noteBaseWidth =
      ((pageSize.width - 80) * 180) / (260 + 80 + 180) - 12;
    const noteBaseHeight = 22;
    const noteBaseY = rowY - noteBaseHeight;
    noteField.addToPage(page, {
      x: noteBaseX + FIELD_PADDING_X,
      y: noteBaseY + FIELD_PADDING_Y,
      width: noteBaseWidth - FIELD_PADDING_X * 2,
      height: noteBaseHeight - FIELD_PADDING_Y * 2,
    });
    applyFieldDefaults(noteField);
  }


  page = pdfDoc.addPage([pageSize.width, pageSize.height]);

  const tables = [
    {
      title: 'Control Equipment',
      rows: [
        'Check controllers are connected and cables seated correctly.',
        'Check controller redundancy; resolve issues (FA series only).',
        'Check brightness levels on controllers and note levels.',
        'Check fans on controllers are working.',
        'Carefully wipe clean controllers.',
      ],
      prefix: 'control',
    },
    {
      title: 'Spare parts',
      rows: [
        'Replace pixel cards with spare cards (ensure zero failures).',
        'Complete full count/log of spare parts and update inventory.',
      ],
      prefix: 'spares',
    },
  ];

  let currentTop = page.getHeight() - 140;
  tables.forEach((tableInfo) => {
    page.drawText(tableInfo.title, {
      x: 40,
      y: currentTop + 6,
      font: boldFont,
      size: 12,
      color: rgb(0.1, 0.1, 0.3),
    });
    const rowHeight = 32;
    drawTable(page, {
      x: 40,
      y: currentTop,
      width: pageSize.width - 80,
      rowHeight,
      headers: [
        { label: 'Action', width: 260 },
        { label: 'Complete', width: 80 },
        { label: 'Notes', width: 180 },
      ],
      rows: tableInfo.rows.map((label) => ({ cells: [label, '', ''] })),
    });

    tableInfo.rows.forEach((row, idx) => {
      const cb = form.createCheckBox(`${tableInfo.prefix}_complete_${idx + 1}`);
      const rowY = currentTop - rowHeight * (idx + 1);
      cb.addToPage(page, {
        x: 40 + (pageSize.width - 80) * 260 / (260 + 80 + 180) + 24,
        y: rowY - 18,
        width: 14,
        height: 14,
      });
      const notes = form.createTextField(`${tableInfo.prefix}_notes_${idx + 1}`);
      const notesBaseX =
        40 + ((pageSize.width - 80) * (260 + 80)) / (260 + 80 + 180) + 6;
      const notesBaseWidth =
        ((pageSize.width - 80) * 180) / (260 + 80 + 180) - 12;
      const notesBaseHeight = rowHeight - 8;
      const notesBaseY = rowY - notesBaseHeight;
      notes.addToPage(page, {
        x: notesBaseX + FIELD_PADDING_X,
        y: notesBaseY + FIELD_PADDING_Y,
        width: notesBaseWidth - FIELD_PADDING_X * 2,
        height: notesBaseHeight - FIELD_PADDING_Y * 2,
      });
      applyFieldDefaults(notes, { multiline: true });
    });

    currentTop -= rowHeight * (tableInfo.rows.length + 2);
  });


  page.drawText('Notes', {
    x: 40,
    y: currentTop + 6,
    font: boldFont,
    size: 12,
    color: rgb(0.1, 0.1, 0.3),
  });
  const notesHeight = 160;
  page.drawRectangle({ x: 40, y: currentTop - notesHeight, width: pageSize.width - 80, height: notesHeight, borderWidth: 0.7, borderColor: rgb(0.1, 0.1, 0.4) });
  const notesField = form.createTextField('general_notes');
  const notesFieldBaseX = 44;
  const notesFieldBaseWidth = pageSize.width - 88;
  const notesFieldBaseHeight = notesHeight - 8;
  const notesFieldBaseY = currentTop - notesHeight + 4;
  notesField.addToPage(page, {
    x: notesFieldBaseX + FIELD_PADDING_X,
    y: notesFieldBaseY + FIELD_PADDING_Y,
    width: notesFieldBaseWidth - FIELD_PADDING_X * 2,
    height: notesFieldBaseHeight - FIELD_PADDING_Y * 2,
  });
  applyFieldDefaults(notesField, { multiline: true });


  page = pdfDoc.addPage([pageSize.width, pageSize.height]);

  const partsTop = page.getHeight() - 150;
  const partsRows = 15;
  const partsRowHeight = 24;
  drawTable(page, {
    x: 40,
    y: partsTop,
    width: pageSize.width - 80,
    rowHeight: partsRowHeight,
    headers: [
      { label: 'Part removed\n(description)', width: 160, lineHeight: 10 },
      { label: 'Part number', width: 110 },
      { label: 'Serial number\n(removed)', width: 110, lineHeight: 10 },
      { label: 'Part used\nin display', width: 110, lineHeight: 10 },
      { label: 'Serial number\n(used)', width: 110, lineHeight: 10 },
    ],
    rows: Array.from({ length: partsRows }, () => ({ cells: ['', '', '', '', ''] })),
  });

  for (let row = 0; row < partsRows; row += 1) {
    ['removed_desc', 'removed_part', 'removed_serial', 'used_part', 'used_serial'].forEach((col, colIdx) => {
      const name = `parts_${col}_${row + 1}`;
      const field = form.createTextField(name);
      const widths = [160, 110, 110, 110, 110];
      const total = widths.reduce((sum, w) => sum + w, 0);
      const scale = (pageSize.width - 80) / total;
      const left = 40 + widths.slice(0, colIdx).reduce((sum, w) => sum + w * scale, 0);
      const baseWidth = widths[colIdx] * scale - 8;
      const rowY = partsTop - partsRowHeight * (row + 1);
      const baseHeight = 16;
      const baseY = rowY - baseHeight;
      field.addToPage(page, {
        x: left + 4 + FIELD_PADDING_X,
        y: baseY + FIELD_PADDING_Y,
        width: baseWidth - FIELD_PADDING_X * 2,
        height: baseHeight - FIELD_PADDING_Y * 2,
      });
      applyFieldDefaults(field);
    });
  }


  const partsTableHeight = partsRowHeight * (partsRows + 1);
  const signSectionGap = 36;
  const signTop = partsTop - partsTableHeight - signSectionGap;
  page.drawText('Sign off', {
    x: 40,
    y: signTop + 10,
    font: boldFont,
    size: 12,
    color: rgb(0.1, 0.1, 0.3),
  });
  const signRowHeight = 26;
  drawTable(page, {
    x: 40,
    y: signTop,
    width: pageSize.width - 80,
    rowHeight: signRowHeight,
    headers: [
      { label: 'Statement', width: 340 },
      { label: 'Complete', width: 80 },
      { label: 'Notes', width: 140 },
    ],
    rows: [
      { cells: ['LED equipment maintained and preventative work completed to satisfaction.', '', ''] },
      { cells: ['Outstanding actions noted for follow-up by customer/service team.', '', ''] },
    ],
  });

  for (let i = 0; i < 2; i += 1) {
    const cb = form.createCheckBox(`signoff_complete_${i + 1}`);
    const rowY = signTop - signRowHeight * (i + 1);
    cb.addToPage(page, {
      x: 40 + (pageSize.width - 80) * 340 / (340 + 80 + 140) + 24,
      y: rowY - 18,
      width: 14,
      height: 14,
    });
    const notes = form.createTextField(`signoff_notes_${i + 1}`);
    notes.addToPage(page, {
      x: 40 + (pageSize.width - 80) * (340 + 80) / (340 + 80 + 140) + 6,
      y: rowY - 22,
      width: (pageSize.width - 80) * 140 / (340 + 80 + 140) - 12,
      height: 18,
    });
    applyFieldDefaults(notes);
  }


  const signTableHeight = signRowHeight * 3;
  const signatureSectionGap = 36;
  const signatureSectionTop = signTop - signTableHeight - signatureSectionGap;
  const columnGap = 24;
  const columnWidth = (pageSize.width - 80 - columnGap) / 2;
  const leftColumnX = 40;
  const rightColumnX = leftColumnX + columnWidth + columnGap;

  function addLabeledField({ name, label, x, y, width }) {
    page.drawText(label, {
      x,
      y,
      font,
      size: 9,
      color: rgb(0.2, 0.2, 0.3),
    });
    const field = form.createTextField(name);
    const baseHeight = 18;
    const baseY = y - baseHeight;
    field.addToPage(page, {
      x: x + FIELD_PADDING_X,
      y: baseY + FIELD_PADDING_Y,
      width: width - FIELD_PADDING_X * 2,
      height: baseHeight - FIELD_PADDING_Y * 2,
    });
    applyFieldDefaults(field);
    return y - 36;
  }

  let leftCursor = signatureSectionTop;
  leftCursor = addLabeledField({ name: 'engineer_company', label: 'On-site engineer company', x: leftColumnX, y: leftCursor, width: columnWidth });
  leftCursor = addLabeledField({ name: 'engineer_datetime', label: 'Engineer date & time', x: leftColumnX, y: leftCursor, width: columnWidth });
  leftCursor = addLabeledField({ name: 'engineer_name', label: 'Engineer name', x: leftColumnX, y: leftCursor, width: columnWidth });

  let rightCursor = signatureSectionTop;
  rightCursor = addLabeledField({ name: 'customer_company', label: 'Customer company', x: rightColumnX, y: rightCursor, width: columnWidth });
  rightCursor = addLabeledField({ name: 'customer_datetime', label: 'Customer date & time', x: rightColumnX, y: rightCursor, width: columnWidth });
  rightCursor = addLabeledField({ name: 'customer_name', label: 'Customer name', x: rightColumnX, y: rightCursor, width: columnWidth });

  const signatureBoxHeight = 70;

  function addSignaturePad({ name, label, x, y }) {
    page.drawText(label, {
      x,
      y: y + signatureBoxHeight + 6,
      font,
      size: 9,
      color: rgb(0.2, 0.2, 0.3),
    });
    page.drawRectangle({
      x,
      y,
      width: columnWidth,
      height: signatureBoxHeight,
      borderWidth: 0.8,
      borderColor: rgb(0.25, 0.28, 0.5),
    });
    const field = form.createTextField(name);
    field.addToPage(page, {
      x: x + 4,
      y: y + 4,
      width: columnWidth - 8,
      height: signatureBoxHeight - 8,
    });
    applyFieldDefaults(field);
  }

  const signatureBaseY = Math.min(leftCursor, rightCursor) - signatureBoxHeight - 10;
  addSignaturePad({ name: 'engineer_signature', label: 'Engineer signature', x: leftColumnX, y: signatureBaseY });
  addSignaturePad({ name: 'customer_signature', label: 'Customer signature', x: rightColumnX, y: signatureBaseY });
  const pdfBytes = await pdfDoc.save();
  await fs.promises.writeFile(OUTPUT_PATH, pdfBytes);
  console.log(`Template saved to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
