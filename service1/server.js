#!/usr/bin/env node

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');
const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const cors = require('cors');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const app = express();

const ROOT_DIR = __dirname;
const FIELDS_PATH = path.join(ROOT_DIR, 'fields.json');
const MAPPING_PATH = path.join(ROOT_DIR, 'mapping.json');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const OUTPUT_DIR = path.join(ROOT_DIR, 'out');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SUGGESTION_STORE_PATH = path.join(DATA_DIR, 'store.json');
const PUBLIC_TEMPLATE_PATH = path.join(PUBLIC_DIR, 'form-template.pdf');
const LEGACY_TEMPLATE_PATHS = [
  '/mnt/data/SNDS-LED-Preventative-Maintenance-Checklist BER Blanko.pdf',
  'C:\\Code\\PDF_LinArt_form\\public\\form-template.pdf',
];

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST_URL_ENV = process.env.HOST_URL;
const TEMPLATE_PATH_ENV = process.env.TEMPLATE_PATH;

fsExtra.ensureDirSync(PUBLIC_DIR);
fsExtra.ensureDirSync(OUTPUT_DIR);
fsExtra.ensureDirSync(DATA_DIR);

/**
 * Load a JSON file from disk, returning a fallback value on failure.
 */
function loadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[server] Unable to parse ${filePath}: ${err.message}`);
    return fallback;
  }
}

const fieldsConfig = loadJson(FIELDS_PATH, { fields: [] }) || { fields: [] };
const mappingOverrides = loadJson(MAPPING_PATH, {}) || {};

function normalizeTemplateCandidate(candidate) {
  if (!candidate) return null;
  const trimmed = String(candidate).trim();
  if (!trimmed) return null;

  if (/^~[\\/]/.test(trimmed)) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ROOT_DIR;
    return path.join(homeDir, trimmed.slice(2));
  }

  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
    return trimmed;
  }

  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }

  return path.join(ROOT_DIR, trimmed);
}

function resolveTemplatePath() {
  const preferredCandidates = [
    normalizeTemplateCandidate(TEMPLATE_PATH_ENV),
    normalizeTemplateCandidate(fieldsConfig.templatePath),
  ].filter(Boolean);

  const fallbackCandidates = [
    normalizeTemplateCandidate(PUBLIC_TEMPLATE_PATH),
    ...LEGACY_TEMPLATE_PATHS.map(normalizeTemplateCandidate),
  ].filter(Boolean);

  const seen = new Set();
  const candidates = [...preferredCandidates, ...fallbackCandidates].filter((candidate) => {
    if (!candidate) return false;
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const primaryPreferred = preferredCandidates[0] || null;

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      if (primaryPreferred && candidate !== primaryPreferred) {
        console.warn(`[server] Template path ${primaryPreferred} not found; using fallback ${candidate}`);
      }
      return candidate;
    }
  }

  const fallback = primaryPreferred || fallbackCandidates[0] || path.join(ROOT_DIR, 'public', 'form-template.pdf');
  console.warn(`[server] Template file not found at any candidate path. Using fallback: ${fallback}`);
  return fallback;
}

const templatePath = resolveTemplatePath();

function toSingleValue(value) {
  if (Array.isArray(value)) {
    return value.length ? value[value.length - 1] : undefined;
  }
  return value;
}

/**
 * Take the list of AcroForm field definitions and build a mapping that translates
 * template field names to request form field names. Defaults to identity mapping,
 * but allows overrides from mapping.json.
 */
function buildFieldDescriptors() {
  const descriptors = [];
  const seenRequestNames = new Set();

  for (const field of fieldsConfig.fields || []) {
    if (!field || !field.name) continue;
    const acroName = String(field.name);
    const override = mappingOverrides[acroName];
    const requestName = override ? String(override) : acroName;

    let uniqueRequestName = requestName;
    let collisionIndex = 1;
    while (seenRequestNames.has(uniqueRequestName)) {
      collisionIndex += 1;
      uniqueRequestName = `${requestName}_${collisionIndex}`;
    }
    seenRequestNames.add(uniqueRequestName);

    descriptors.push({
      acroName,
      type: field.type ? String(field.type).toLowerCase() : 'text',
      requestName: uniqueRequestName,
      label: field.label || acroName,
    });
  }

  return descriptors;
}

const fieldDescriptors = buildFieldDescriptors();

console.log(`[server] Loaded ${fieldDescriptors.length} fields from fields.json`);
if (fieldDescriptors.length) {
  console.log('[server] Field mapping (AcroForm -> request):');
  for (const descriptor of fieldDescriptors) {
    console.log(`  - ${descriptor.acroName} -> ${descriptor.requestName} (${descriptor.type})`);
  }
} else {
  console.warn('[server] No fields discovered. Run npm run extract-fields once the template is available.');
}

const DEFAULT_TEXT_FIELD_STYLE = {
  fontSize: 10,
  multiline: false,
  lineHeightMultiplier: 1.2,
  minFontSize: 7,
};

const TEXT_FIELD_STYLE_RULES = [
  { test: /(?:^|_)notes(?:_|$)/i, style: { multiline: true, minFontSize: 6 } },
  { test: /general_notes/i, style: { multiline: true, minFontSize: 6 } },
  { test: /(?:^|_)desc(?:_|$)/i, style: { multiline: true, minFontSize: 6 } },
];

const SUGGESTION_FIELDS = new Set([
  'end_customer_name',
  'site_location',
  'service_company_name',
  'engineer_company',
  'engineer_name',
  'customer_company',
  'customer_name',
]);
const MIN_SUGGESTION_LENGTH = 3;
const MAX_SUGGESTIONS_PER_FIELD = 12;

function getSeedSuggestions(fieldName) {
  if (!fieldName || !suggestionStore || !suggestionStore.suggestions) {
    return [];
  }
  const bucket = suggestionStore.suggestions[fieldName];
  if (!Array.isArray(bucket)) return [];
  return bucket.slice(0, MAX_SUGGESTIONS_PER_FIELD);
}

const CHECKLIST_SECTIONS = [
  {
    title: 'LED display checks',
    rows: [
      { action: 'Check for any visible issues. Resolve as necessary.', checkbox: 'led_complete_1', notes: 'led_notes_1', checked: true },
      { action: 'Apply test pattern on full red, green, blue and white. Identify faults.', checkbox: 'led_complete_2', notes: 'led_notes_2', checked: true },
      { action: 'Replace any pixel cards with dead or non-functioning pixels.', checkbox: 'led_complete_3', notes: 'led_notes_3', checked: true },
      { action: 'Check power and data cables between cabinets for secure connections.', checkbox: 'led_complete_4', notes: 'led_notes_4' },
      { action: 'Inspect for damage and replace any damaged or broken cables.', checkbox: 'led_complete_5', notes: 'led_notes_5' },
      { action: 'Check monitoring feature for issues. Resolve as necessary.', checkbox: 'led_complete_6', notes: 'led_notes_6' },
      { action: 'Check brightness levels in configurator and note levels down.', checkbox: 'led_complete_7', notes: 'led_notes_7' },
    ],
  },
  {
    title: 'Control equipment',
    rows: [
      { action: 'Check controllers are connected and cables seated correctly.', checkbox: 'control_complete_1', notes: 'control_notes_1', checked: true },
      { action: 'Check controller redundancy; resolve issues where necessary.', checkbox: 'control_complete_2', notes: 'control_notes_2' },
      { action: 'Check brightness levels on controllers and note levels.', checkbox: 'control_complete_3', notes: 'control_notes_3', checked: true },
      { action: 'Check fans on controllers are working.', checkbox: 'control_complete_4', notes: 'control_notes_4' },
      { action: 'Carefully wipe clean controllers.', checkbox: 'control_complete_5', notes: 'control_notes_5' },
    ],
  },
  {
    title: 'Spare parts',
    rows: [
      { action: 'Replace pixel cards in display with spare cards (ensure zero failures).', checkbox: 'spares_complete_1', notes: 'spares_notes_1', checked: true },
      { action: 'Complete inventory log of spare parts.', checkbox: 'spares_complete_2', notes: 'spares_notes_2' },
    ],
  },
];

const SIGN_OFF_CHECKLIST_ROWS = [
  {
    action: 'LED equipment maintained and preventative work completed.',
    checkbox: 'signoff_complete_1',
    notes: 'signoff_notes_1',
    checked: true,
  },
  {
    action: 'Outstanding actions noted for customer follow-up.',
    checkbox: 'signoff_complete_2',
    notes: 'signoff_notes_2',
  },
];

function normalizeSuggestionValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

function loadSuggestionStore() {
  const fallback = { suggestions: {} };
  const loaded = loadJson(SUGGESTION_STORE_PATH, fallback) || fallback;
  const normalized = { suggestions: {} };
  if (loaded && typeof loaded === 'object' && loaded.suggestions) {
    for (const [field, values] of Object.entries(loaded.suggestions)) {
      if (!Array.isArray(values)) continue;
      const filtered = values
        .map((entry) => normalizeSuggestionValue(entry))
        .filter((entry) => entry.length >= MIN_SUGGESTION_LENGTH);
      if (filtered.length) {
        normalized.suggestions[field] = filtered.slice(0, MAX_SUGGESTIONS_PER_FIELD);
      }
    }
  }
  return normalized;
}

let suggestionStore = loadSuggestionStore();

function saveSuggestionStore(store = suggestionStore) {
  try {
    fsExtra.writeJsonSync(SUGGESTION_STORE_PATH, store, { spaces: 2 });
  } catch (err) {
    console.warn(`[server] Unable to persist suggestion store: ${err.message}`);
  }
}

function recordSuggestionValue(fieldName, value) {
  if (!fieldName || !SUGGESTION_FIELDS.has(fieldName)) {
    return false;
  }
  const normalized = normalizeSuggestionValue(value);
  if (normalized.length < MIN_SUGGESTION_LENGTH) {
    return false;
  }
  if (!suggestionStore.suggestions[fieldName]) {
    suggestionStore.suggestions[fieldName] = [];
  }
  const bucket = suggestionStore.suggestions[fieldName];
  const lower = normalized.toLowerCase();
  const existingIndex = bucket.findIndex((entry) => entry.toLowerCase() === lower);
  if (existingIndex === 0) {
    return false;
  }
  if (existingIndex > 0) {
    bucket.splice(existingIndex, 1);
  }
  bucket.unshift(normalized);
  if (bucket.length > MAX_SUGGESTIONS_PER_FIELD) {
    bucket.length = MAX_SUGGESTIONS_PER_FIELD;
  }
  return true;
}

function recordSuggestionsFromSubmission(body) {
  if (!body || typeof body !== 'object') {
    return false;
  }
  let changed = false;
  for (const fieldName of SUGGESTION_FIELDS) {
    if (!(fieldName in body)) continue;
    const value = toSingleValue(body[fieldName]);
    if (recordSuggestionValue(fieldName, value)) {
      changed = true;
    }
  }
  if (changed) {
    saveSuggestionStore();
  }
  return changed;
}

function getSuggestionsForField(fieldName, query) {
  if (!fieldName || !SUGGESTION_FIELDS.has(fieldName)) {
    return [];
  }
  const prefix = normalizeSuggestionValue(query).toLowerCase();
  if (prefix.length < MIN_SUGGESTION_LENGTH) {
    return [];
  }
  const bucket = suggestionStore.suggestions[fieldName] || [];
  return bucket
    .filter((entry) => entry.toLowerCase().startsWith(prefix))
    .slice(0, MAX_SUGGESTIONS_PER_FIELD);
}

const PARTS_ROW_COUNT = 15;
const PARTS_FIELD_PREFIXES = [
  'parts_removed_desc_',
  'parts_removed_part_',
  'parts_removed_serial_',
  'parts_used_part_',
  'parts_used_serial_',
];

const PARTS_TABLE_LAYOUT = {
  pageIndex: 2,
  leftMargin: 40,
  rightMargin: 40,
  topOffset: 150,
  rowHeight: 24,
  headerHeight: 24,
  columnWidths: [160, 110, 110, 110, 110],
};

const TABLE_BORDER_COLOR = rgb(0.1, 0.1, 0.4);
const TEXT_FIELD_INNER_PADDING = 2;

const SIGN_OFF_REQUEST_FIELDS = new Set([
  'signoff_complete_1',
  'signoff_notes_1',
  'signoff_complete_2',
  'signoff_notes_2',
  'engineer_company',
  'engineer_datetime',
  'engineer_name',
  'customer_company',
  'customer_datetime',
  'customer_name',
  'engineer_signature',
  'customer_signature',
]);

function stripTrailingEmptyLines(lines) {
  const result = [...lines];
  while (result.length && !result[result.length - 1].trim()) {
    result.pop();
  }
  return result;
}

function stripLeadingEmptyLines(lines) {
  let index = 0;
  while (index < lines.length && !lines[index].trim()) {
    index += 1;
  }
  return lines.slice(index);
}

function splitLongWord(word, font, fontSize, maxWidth) {
  if (!word) return [''];
  if (!font || !Number.isFinite(maxWidth) || maxWidth <= 0) {
    return [word];
  }
  if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
    return [word];
  }
  const parts = [];
  let current = '';
  for (const char of word) {
    const candidate = current + char;
    if (!current || font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      parts.push(current);
      current = char;
    }
  }
  if (current) {
    parts.push(current);
  }
  return parts.length ? parts : [word];
}

function wrapTextToWidth(text, font, fontSize, maxWidth) {
  const safeText = text === undefined || text === null ? '' : String(text);
  if (!safeText) return [''];
  if (!font || !Number.isFinite(maxWidth) || maxWidth <= 0) {
    return safeText.split(/\r?\n/);
  }
  const paragraphs = safeText.replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  paragraphs.forEach((paragraph) => {
    if (!paragraph.trim()) {
      lines.push('');
      return;
    }
    const words = paragraph.trim().split(/\s+/);
    let currentLine = '';
    words.forEach((word) => {
      if (!word) return;
      const segments = splitLongWord(word, font, fontSize, maxWidth);
      segments.forEach((segment, segmentIndex) => {
        const prefix = segmentIndex === 0 ? ' ' : '';
        if (!currentLine) {
          currentLine = segment;
          return;
        }
        const candidate = `${currentLine}${prefix}${segment}`;
        if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
          currentLine = candidate;
        } else {
          lines.push(currentLine);
          currentLine = segment;
        }
      });
    });
    if (currentLine) {
      lines.push(currentLine);
    }
  });
  return stripTrailingEmptyLines(lines);
}

function layoutTextForField(options) {
  const {
    value,
    font,
    fontSize = DEFAULT_TEXT_FIELD_STYLE.fontSize,
    multiline = false,
    lineHeightMultiplier = DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,
    widget,
    minFontSize = DEFAULT_TEXT_FIELD_STYLE.minFontSize,
  } = options;

  const text = value === undefined || value === null ? '' : String(value);
  if (!font || !widget) {
    const lines = text ? text.split(/\r?\n/) : [''];
    return {
      fieldText: lines.join('\n'),
      overflowText: '',
      overflowDetected: false,
      totalLines: lines.length,
      displayedLines: lines.length,
      lineHeight: fontSize * lineHeightMultiplier,
      appliedFontSize: fontSize,
    };
  }

  const rect = widget.getRectangle();
  const width =
    Math.max((rect.x2 || rect[2]) - (rect.x1 || rect[0]) - TEXT_FIELD_INNER_PADDING * 2, 1);
  const height =
    Math.max((rect.y2 || rect[3]) - (rect.y1 || rect[1]) - TEXT_FIELD_INNER_PADDING * 2, fontSize);

  const buildLayout = (candidateSize) => {
    const candidateLineHeight = candidateSize * (lineHeightMultiplier || 1.2);
    const wrappedLines = wrapTextToWidth(text, font, candidateSize, width);
    const trimmedLines = stripTrailingEmptyLines(wrappedLines);
    const maxLines = Math.max(1, Math.floor(height / Math.max(candidateLineHeight, 1)));

    if (!multiline) {
      const [firstLine = ''] = trimmedLines;
      const remaining = stripLeadingEmptyLines(trimmedLines.slice(1));
      return {
        fieldText: firstLine,
        overflowText: remaining.join('\n').trim(),
        overflowDetected: remaining.some((line) => line.trim().length),
        totalLines: trimmedLines.length,
        displayedLines: 1,
        lineHeight: candidateLineHeight,
        appliedFontSize: candidateSize,
      };
    }

    const fieldLines = trimmedLines.slice(0, maxLines);
    const overflowLines = stripLeadingEmptyLines(trimmedLines.slice(maxLines));
    return {
      fieldText: fieldLines.join('\n'),
      overflowText: overflowLines.join('\n').trim(),
      overflowDetected: overflowLines.some((line) => line.trim().length),
      totalLines: trimmedLines.length,
      displayedLines: fieldLines.length,
      lineHeight: candidateLineHeight,
      appliedFontSize: candidateSize,
    };
  };

  let workingSize = fontSize;
  let layout = buildLayout(workingSize);
  while (layout.overflowDetected && workingSize > minFontSize) {
    workingSize = Math.max(minFontSize, workingSize - 0.5);
    layout = buildLayout(workingSize);
    if (!layout.overflowDetected || workingSize <= minFontSize) {
      break;
    }
  }

  return layout;
}

function layoutTextForWidth(options) {
  const {
    value,
    font,
    fontSize = DEFAULT_TEXT_FIELD_STYLE.fontSize,
    minFontSize = DEFAULT_TEXT_FIELD_STYLE.minFontSize,
    lineHeightMultiplier = DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,
    maxWidth,
  } = options;

  const text = value === undefined || value === null ? '' : String(value);
  if (!font || !Number.isFinite(maxWidth) || maxWidth <= 0) {
    const lines = text ? text.split(/\r?\n/) : [''];
    return {
      lines,
      fontSize,
      lineHeight: fontSize * lineHeightMultiplier,
      lineCount: lines.length || 1,
    };
  }

  let workingSize = fontSize;
  let layout = null;

  const computeLayout = (size) => {
    const candidateLines = wrapTextToWidth(text, font, size, maxWidth);
    const normalizedLines = candidateLines.length ? candidateLines : [''];
    const maxLineWidth = normalizedLines.reduce(
      (max, line) => Math.max(max, font.widthOfTextAtSize(line, size)),
      0,
    );
    return {
      lines: normalizedLines,
      fontSize: size,
      lineHeight: size * lineHeightMultiplier,
      lineCount: normalizedLines.length,
      fits: maxLineWidth <= maxWidth + 0.1,
    };
  };

  layout = computeLayout(workingSize);
  while (!layout.fits && workingSize > minFontSize) {
    workingSize = Math.max(minFontSize, workingSize - 0.5);
    layout = computeLayout(workingSize);
    if (layout.fits || workingSize <= minFontSize) {
      break;
    }
  }

  const finalLines = stripTrailingEmptyLines(layout.lines);
  return {
    lines: finalLines,
    fontSize: layout.fontSize,
    lineHeight: layout.lineHeight,
    lineCount: finalLines.length || 1,
  };
}

function resolveTextFieldStyle(name) {
  if (!name) return { ...DEFAULT_TEXT_FIELD_STYLE };
  for (const rule of TEXT_FIELD_STYLE_RULES) {
    if (rule.test.test(name)) {
      return { ...DEFAULT_TEXT_FIELD_STYLE, ...rule.style };
    }
  }
  return { ...DEFAULT_TEXT_FIELD_STYLE };
}

function collectPartsRowUsage(body) {
  const rows = [];
  for (let index = 1; index <= PARTS_ROW_COUNT; index += 1) {
    const rowData = { number: index, fields: {}, hasData: false };
    PARTS_FIELD_PREFIXES.forEach((prefix) => {
      const key = `${prefix}${index}`;
      const value = body ? toSingleValue(body[key]) : undefined;
      const normalized = value !== undefined && value !== null ? String(value).trim() : '';
      if (normalized) {
        rowData.hasData = true;
      }
      rowData.fields[key] = normalized;
    });
    rows.push(rowData);
  }
  return rows;
}

function renderPartsTable(pdfDoc, rows, options = {}) {
  if (!pdfDoc || !Array.isArray(rows)) {
    return { hiddenRows: [], renderedRows: [] };
  }
  const layout = { ...PARTS_TABLE_LAYOUT, ...(options.layout || {}) };
  const font = options.font || null;
  const page = pdfDoc.getPages()[layout.pageIndex];
  if (!page || !font) {
    return { hiddenRows: rows.filter((row) => !row.hasData).map((row) => row.number), renderedRows: [] };
  }

  const columnWidths = layout.columnWidths || [160, 110, 110, 110, 110];
  const totalWidth = columnWidths.reduce((sum, width) => sum + width, 0);
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const left = layout.leftMargin;
  const right = pageWidth - layout.rightMargin;
  const scale = (right - left) / totalWidth;
  const scaledWidths = columnWidths.map((width) => width * scale);
  const headerHeight = layout.headerHeight || layout.rowHeight;
  const rowHeightBase = layout.rowHeight || 24;

  const headerLabels = [
    'Part removed (description)',
    'Part number',
    'Serial number (removed)',
    'Part used in display',
    'Serial number (used)',
  ];

  const usedRows = rows.filter((row) => row.hasData);
  const hiddenRows = rows.filter((row) => !row.hasData).map((row) => row.number);
  const renderedRows = [];

  const tableHeight = headerHeight + rowHeightBase * PARTS_ROW_COUNT;
  const originY = pageHeight - layout.topOffset;

  // Clear existing area
  page.drawRectangle({
    x: left - 2,
    y: originY - tableHeight - 2,
    width: right - left + 4,
    height: tableHeight + 4,
    color: rgb(1, 1, 1),
    borderWidth: 0,
  });

  if (!usedRows.length) {
    return { hiddenRows, renderedRows };
  }

  // Header row
  let cursorX = left;
  headerLabels.forEach((label, index) => {
    const width = scaledWidths[index];
    page.drawRectangle({
      x: cursorX,
      y: originY - headerHeight,
      width,
      height: headerHeight,
      color: rgb(0.88, 0.92, 0.98),
      borderWidth: 0.7,
      borderColor: TABLE_BORDER_COLOR,
    });
    const labelLayout = layoutTextForWidth({
      value: label,
      font,
      fontSize: 10,
      maxWidth: width - 8,
    });
    let textY = originY - headerHeight + headerHeight - 6;
    labelLayout.lines.forEach((line) => {
      page.drawText(line, {
        x: cursorX + 4,
        y: textY,
        size: labelLayout.fontSize,
        font,
        color: rgb(0.1, 0.1, 0.3),
      });
      textY -= labelLayout.lineHeight;
    });
    cursorX += width;
  });

  let currentY = originY - headerHeight;
  usedRows.forEach((row) => {
    const cellValues = [
      row.fields[`parts_removed_desc_${row.number}`] || '',
      row.fields[`parts_removed_part_${row.number}`] || '',
      row.fields[`parts_removed_serial_${row.number}`] || '',
      row.fields[`parts_used_part_${row.number}`] || '',
      row.fields[`parts_used_serial_${row.number}`] || '',
    ];

    const cellLayouts = cellValues.map((value, index) => {
      const layout = layoutTextForWidth({
        value,
        font,
        fontSize: DEFAULT_TEXT_FIELD_STYLE.fontSize,
        minFontSize: DEFAULT_TEXT_FIELD_STYLE.minFontSize,
        lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,
        maxWidth: scaledWidths[index] - 8,
      });
      return { value, layout };
    });

    const rowHeight = Math.max(
      rowHeightBase,
      ...cellLayouts.map(({ layout }) =>
        Math.ceil(layout.lineCount * layout.lineHeight + 8),
      ),
    );

    let cellX = left;
    cellLayouts.forEach(({ value, layout }, index) => {
      const cellWidth = scaledWidths[index];
      page.drawRectangle({
        x: cellX,
        y: currentY - rowHeight,
        width: cellWidth,
        height: rowHeight,
        color: rgb(1, 1, 1),
        borderWidth: 0.6,
        borderColor: TABLE_BORDER_COLOR,
      });

      drawCenteredTextBlock(
        page,
        value,
        font,
        { x: cellX, y: currentY - rowHeight, width: cellWidth, height: rowHeight },
        {
          align: 'left',
          paddingX: 4,
          paddingY: 6,
          color: rgb(0.12, 0.12, 0.18),
          fontSize: layout.fontSize,
          minFontSize: layout.fontSize,
          lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,
          layout,
        },
      );

      cellX += cellWidth;
    });

    renderedRows.push({ number: row.number, height: rowHeight });
    currentY -= rowHeight;
  });

  return { hiddenRows, renderedRows };
}

function drawCenteredTextBlock(page, text, font, rect, options = {}) {
  if (!page || !font || !rect) return;
  const content = text === undefined || text === null ? '' : String(text).trim();
  const fontSize = options.fontSize || 10;
  const lineHeightMultiplier = options.lineHeightMultiplier || 1.2;
  const paddingX = options.paddingX !== undefined ? options.paddingX : 6;
  const paddingY = options.paddingY !== undefined ? options.paddingY : 6;
  const align = options.align || 'center';
  const verticalAlign = options.verticalAlign || 'middle';
  const color = options.color || rgb(0.12, 0.12, 0.18);

  const layout =
    options.layout ||
    layoutTextForWidth({
      value: content,
      font,
      fontSize,
      minFontSize: options.minFontSize || fontSize,
      lineHeightMultiplier,
      maxWidth: Math.max(4, rect.width - paddingX * 2),
    });

  if (!layout || !Array.isArray(layout.lines) || !layout.lines.length) {
    if (options.drawPlaceholder) {
      page.drawText(' ', {
        x: rect.x + paddingX,
        y: rect.y + rect.height / 2,
        size: fontSize,
        font,
        color,
      });
    }
    return layout;
  }

  const totalHeight = layout.lineCount * layout.lineHeight;
  let textY;
  if (verticalAlign === 'top') {
    textY = rect.y + rect.height - paddingY - layout.fontSize;
  } else if (verticalAlign === 'bottom') {
    textY = rect.y + paddingY;
  } else {
    textY = rect.y + (rect.height - totalHeight) / 2 + layout.lineHeight - layout.fontSize;
  }

  layout.lines.forEach((line) => {
    const lineWidth = font.widthOfTextAtSize(line, layout.fontSize);
    let textX = rect.x + paddingX;
    if (align === 'center') {
      textX = rect.x + (rect.width - lineWidth) / 2;
    } else if (align === 'right') {
      textX = rect.x + rect.width - paddingX - lineWidth;
    }
    page.drawText(line, {
      x: textX,
      y: textY,
      size: layout.fontSize,
      font,
      color,
    });
    textY -= layout.lineHeight;
  });

  return layout;
}

function appendOverflowPages(pdfDoc, font, overflowEntries, options = {}) {
  if (!pdfDoc || !font || !Array.isArray(overflowEntries) || !overflowEntries.length) {
    return [];
  }
  const baseSize = pdfDoc.getPages().length
    ? pdfDoc.getPages()[0].getSize()
    : { width: 595.28, height: 841.89 };
  const margin = options.margin ?? 56;
  const lineHeightMultiplier = options.lineHeightMultiplier ?? DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier;
  const placements = [];

  const entriesPerPage = [];
  let currentPageEntries = [];
  let currentLineCount = 0;
  const maxLinesPerPage = Math.floor((baseSize.height - margin * 2) / (DEFAULT_TEXT_FIELD_STYLE.fontSize * lineHeightMultiplier));

  overflowEntries.forEach((entry) => {
    const text = entry.text || '';
    const lineCount = text.split(/\r?\n/).length + 2;
    if (currentLineCount + lineCount > maxLinesPerPage && currentPageEntries.length) {
      entriesPerPage.push(currentPageEntries);
      currentPageEntries = [];
      currentLineCount = 0;
    }
    currentPageEntries.push(entry);
    currentLineCount += lineCount;
  });
  if (currentPageEntries.length) {
    entriesPerPage.push(currentPageEntries);
  }

  entriesPerPage.forEach((entries) => {
    const page = pdfDoc.addPage([baseSize.width, baseSize.height]);
    let cursorY = baseSize.height - margin;
    page.drawText('Extended Text', {
      x: margin,
      y: cursorY,
      size: 14,
      font,
      color: rgb(0.1, 0.1, 0.3),
    });
    cursorY -= 24;
    entries.forEach((entry) => {
      page.drawText(`${entry.label || entry.acroName}:`, {
        x: margin,
        y: cursorY,
        size: 11,
        font,
        color: rgb(0.12, 0.12, 0.18),
      });
      cursorY -= 16;
      const layout = layoutTextForWidth({
        value: entry.text,
        font,
        fontSize: DEFAULT_TEXT_FIELD_STYLE.fontSize,
        minFontSize: DEFAULT_TEXT_FIELD_STYLE.minFontSize,
        lineHeightMultiplier,
        maxWidth: baseSize.width - margin * 2,
      });
      layout.lines.forEach((line) => {
        page.drawText(line, {
          x: margin,
          y: cursorY,
          size: layout.fontSize,
          font,
          color: rgb(0.15, 0.15, 0.2),
        });
        cursorY -= layout.lineHeight;
      });
      cursorY -= 12;
      placements.push({
        acroName: entry.acroName,
        requestName: entry.requestName,
        page: pdfDoc.getPageCount(),
      });
    });
  });

  return placements;
}

function clearOriginalSignoffSection(pdfDoc) {
  if (!pdfDoc || typeof pdfDoc.getPages !== 'function') return null;
  const pages = pdfDoc.getPages();
  const templatePage = pages[PARTS_TABLE_LAYOUT.pageIndex];
  if (!templatePage) return null;
  templatePage.drawRectangle({
    x: 0,
    y: 0,
    width: templatePage.getWidth(),
    height: templatePage.getHeight(),
    color: rgb(1, 1, 1),
    borderWidth: 0,
  });
  return { page: templatePage, index: PARTS_TABLE_LAYOUT.pageIndex };
}

async function drawSignOffPage(pdfDoc, font, body, signatureImages, partsRows, options = {}) {
  const pagesList = pdfDoc.getPages();
  const baseSize = pagesList.length ? pagesList[0].getSize() : { width: 595.28, height: 841.89 };
  const margin = 56;
  const headingColor = rgb(0.08, 0.2, 0.4);
  const textColor = rgb(0.12, 0.12, 0.18);

  const initialPage =
    options.targetPage && pagesList.includes(options.targetPage)
      ? options.targetPage
      : pdfDoc.addPage([baseSize.width, baseSize.height]);
  let page = initialPage;
  let cursorY = 0;

  const setCurrentPage = (target, heading) => {
    page = target;
    cursorY = page.getHeight() - margin;
    page.drawText(heading, {
      x: margin,
      y: cursorY,
      size: 18,
      font,
      color: headingColor,
    });
    cursorY -= 26;
  };

  const addContinuationPage = () => {
    const next = pdfDoc.addPage([baseSize.width, baseSize.height]);
    setCurrentPage(next, 'Maintenance Summary (cont.)');
    return next;
  };

  const ensureSpace = (requiredHeight) => {
    if (cursorY - requiredHeight < margin) {
      return addContinuationPage();
    }
    return null;
  };

  const drawSectionTitle = (label) => {
    page.drawText(label, {
      x: margin,
      y: cursorY,
      size: 12,
      font,
      color: headingColor,
    });
    cursorY -= 18;
  };

  setCurrentPage(page, 'Maintenance Summary');

  const tableWidth = page.getWidth() - margin * 2;
  const signaturePlacements = [];

  const usedRows = (partsRows || []).filter((row) => row.hasData);
  if (usedRows.length) {
    const columnWidths = [0.32, 0.18, 0.18, 0.18, 0.14].map((ratio) => tableWidth * ratio);
    const headerHeight = 18;
    const rowHeightBase = 22;
    const headers = [
      'Part removed (description)',
      'Part number',
      'Serial number (removed)',
      'Part used in display',
      'Serial number (used)',
    ];

    const drawPartsHeader = () => {
      let headerX = margin;
      headers.forEach((label, index) => {
        const width = columnWidths[index];
        page.drawRectangle({
          x: headerX,
          y: cursorY - headerHeight,
          width,
          height: headerHeight,
          color: rgb(0.88, 0.92, 0.98),
          borderWidth: 0.6,
          borderColor: TABLE_BORDER_COLOR,
        });
        const labelLayout = layoutTextForWidth({
          value: label,
          font,
          fontSize: 9,
          minFontSize: 8,
          lineHeightMultiplier: 1.2,
          maxWidth: width - 8,
        });
        let textY = cursorY - headerHeight + headerHeight - 6;
        labelLayout.lines.forEach((line) => {
          page.drawText(line, {
            x: headerX + 4,
            y: textY,
            size: labelLayout.fontSize,
            font,
            color: rgb(0.1, 0.1, 0.3),
          });
          textY -= labelLayout.lineHeight;
        });
        headerX += width;
      });
      cursorY -= headerHeight;
    };

    const headerLabel =
      ensureSpace(headerHeight + rowHeightBase * Math.min(usedRows.length, 3) + 12)
        ? 'Parts record (cont.)'
        : 'Parts record';
    drawSectionTitle(headerLabel);
    drawPartsHeader();

    usedRows.forEach((row) => {
      const cellValues = [
        row.fields[`parts_removed_desc_${row.number}`] || '',
        row.fields[`parts_removed_part_${row.number}`] || '',
        row.fields[`parts_removed_serial_${row.number}`] || '',
        row.fields[`parts_used_part_${row.number}`] || '',
        row.fields[`parts_used_serial_${row.number}`] || '',
      ];
      const cellLayouts = cellValues.map((value, index) => {
        const layout = layoutTextForWidth({
          value,
          font,
          fontSize: DEFAULT_TEXT_FIELD_STYLE.fontSize,
          minFontSize: DEFAULT_TEXT_FIELD_STYLE.minFontSize,
          lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,
          maxWidth: columnWidths[index] - 8,
        });
        return { value, layout };
      });
      const rowHeight = Math.max(
        rowHeightBase,
        ...cellLayouts.map(({ layout }) =>
          Math.ceil(layout.lineCount * layout.lineHeight + 8),
        ),
      );
      if (ensureSpace(rowHeight + 6)) {
        drawSectionTitle('Parts record (cont.)');
        drawPartsHeader();
      }
      let cellX = margin;
      cellLayouts.forEach(({ value, layout }, index) => {
        const cellWidth = columnWidths[index];
        page.drawRectangle({
          x: cellX,
          y: cursorY - rowHeight,
          width: cellWidth,
          height: rowHeight,
          color: rgb(1, 1, 1),
          borderWidth: 0.6,
          borderColor: TABLE_BORDER_COLOR,
        });
        drawCenteredTextBlock(
          page,
          value,
          font,
          { x: cellX, y: cursorY - rowHeight, width: cellWidth, height: rowHeight },
          {
            align: 'left',
            paddingX: 4,
            paddingY: 6,
            color: textColor,
            fontSize: layout.fontSize,
            minFontSize: layout.fontSize,
            lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,
            layout,
          },
        );
        cellX += cellWidth;
      });
      cursorY -= rowHeight;
    });

    cursorY -= 24;
  } else {
    if (ensureSpace(24)) {
      drawSectionTitle('Parts record (cont.)');
    } else {
      drawSectionTitle('Parts record');
    }
    page.drawText('No spare parts were recorded for this visit.', {
      x: margin,
      y: cursorY,
      size: 11,
      font,
      color: textColor,
    });
    cursorY -= 24;
  }

  const drawChecklistSection = (section) => {
    const columnWidths = [tableWidth * 0.55, tableWidth * 0.12, tableWidth * 0.33];
    const headerHeight = 18;
    const rowBaseHeight = 24;
    const headers = ['Action', 'Complete', 'Notes'];

    const drawHeaderRow = () => {
      let headerX = margin;
      headers.forEach((label, index) => {
        const width = columnWidths[index];
        page.drawRectangle({
          x: headerX,
          y: cursorY - headerHeight,
          width,
          height: headerHeight,
          color: rgb(0.92, 0.95, 0.99),
          borderWidth: 0.6,
          borderColor: TABLE_BORDER_COLOR,
        });
        page.drawText(label, {
          x: headerX + 4,
          y: cursorY - headerHeight + headerHeight - 8,
          size: 9,
          font,
          color: rgb(0.1, 0.1, 0.3),
        });
        headerX += width;
      });
      cursorY -= headerHeight;
    };

    const headingLabel =
      ensureSpace(headerHeight + rowBaseHeight + 12) ? `${section.title} (cont.)` : section.title;
    drawSectionTitle(headingLabel);
    drawHeaderRow();

    section.rows.forEach((row) => {
      const actionLayout = layoutTextForWidth({
        value: row.action,
        font,
        fontSize: 10,
        minFontSize: 9,
        lineHeightMultiplier: 1.2,
        maxWidth: columnWidths[0] - 8,
      });
      const noteValue = toSingleValue(body?.[row.notes]) || '';
      const noteLayout = layoutTextForWidth({
        value: noteValue,
        font,
        fontSize: DEFAULT_TEXT_FIELD_STYLE.fontSize,
        minFontSize: DEFAULT_TEXT_FIELD_STYLE.minFontSize,
        lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,
        maxWidth: columnWidths[2] - 8,
      });
      const rowHeight = Math.max(
        rowBaseHeight,
        Math.ceil(actionLayout.lineCount * actionLayout.lineHeight + 8),
        Math.ceil(noteLayout.lineCount * noteLayout.lineHeight + 8),
      );
      if (ensureSpace(rowHeight + 8)) {
        drawSectionTitle(`${section.title} (cont.)`);
        drawHeaderRow();
      }

      let cellX = margin;
      page.drawRectangle({
        x: cellX,
        y: cursorY - rowHeight,
        width: columnWidths[0],
        height: rowHeight,
        color: rgb(1, 1, 1),
        borderWidth: 0.6,
        borderColor: TABLE_BORDER_COLOR,
      });
      drawCenteredTextBlock(
        page,
        row.action,
        font,
        { x: cellX, y: cursorY - rowHeight, width: columnWidths[0], height: rowHeight },
        {
          align: 'left',
          paddingX: 4,
          paddingY: 6,
          color: textColor,
          fontSize: actionLayout.fontSize,
          minFontSize: actionLayout.fontSize,
          lineHeightMultiplier: 1.2,
          layout: actionLayout,
        },
      );
      cellX += columnWidths[0];

      page.drawRectangle({
        x: cellX,
        y: cursorY - rowHeight,
        width: columnWidths[1],
        height: rowHeight,
        color: rgb(1, 1, 1),
        borderWidth: 0.6,
        borderColor: TABLE_BORDER_COLOR,
      });
      const checkboxSize = 12;
      const checkboxX = cellX + (columnWidths[1] - checkboxSize) / 2;
      const checkboxY = cursorY - rowHeight + (rowHeight - checkboxSize) / 2;
      page.drawRectangle({
        x: checkboxX,
        y: checkboxY,
        width: checkboxSize,
        height: checkboxSize,
        borderWidth: 0.8,
        borderColor: TABLE_BORDER_COLOR,
      });
      if (normalizeCheckboxValue(body?.[row.checkbox])) {
        page.drawLine({
          start: { x: checkboxX + 3, y: checkboxY + checkboxSize / 2 },
          end: { x: checkboxX + checkboxSize / 2, y: checkboxY + 3 },
          thickness: 1.2,
          color: textColor,
        });
        page.drawLine({
          start: { x: checkboxX + checkboxSize / 2, y: checkboxY + 3 },
          end: { x: checkboxX + checkboxSize - 3, y: checkboxY + checkboxSize - 3 },
          thickness: 1.2,
          color: textColor,
        });
      }
      cellX += columnWidths[1];

      page.drawRectangle({
        x: cellX,
        y: cursorY - rowHeight,
        width: columnWidths[2],
        height: rowHeight,
        color: rgb(1, 1, 1),
        borderWidth: 0.6,
        borderColor: TABLE_BORDER_COLOR,
      });
      drawCenteredTextBlock(
        page,
        noteValue,
        font,
        { x: cellX, y: cursorY - rowHeight, width: columnWidths[2], height: rowHeight },
        {
          align: 'left',
          paddingX: 4,
          paddingY: 6,
          color: textColor,
          fontSize: noteLayout.fontSize,
          minFontSize: noteLayout.fontSize,
          lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,
          layout: noteLayout,
        },
      );

      cursorY -= rowHeight;
    });

    cursorY -= 18;
  };

  CHECKLIST_SECTIONS.forEach((section) => drawChecklistSection(section));
  drawChecklistSection({ title: 'Sign-off checklist', rows: SIGN_OFF_CHECKLIST_ROWS });

  const engineerDetails = [
    { label: 'On-site engineer company', value: toSingleValue(body?.engineer_company) || '' },
    { label: 'Engineer date & time', value: toSingleValue(body?.engineer_datetime) || '' },
    { label: 'Engineer name', value: toSingleValue(body?.engineer_name) || '' },
  ];
  const customerDetails = [
    { label: 'Customer company', value: toSingleValue(body?.customer_company) || '' },
    { label: 'Customer date & time', value: toSingleValue(body?.customer_datetime) || '' },
    { label: 'Customer name', value: toSingleValue(body?.customer_name) || '' },
  ];
  const detailRows = engineerDetails.length;
  const detailHeight = 28;
  const detailHeading =
    ensureSpace(detailHeight * detailRows + 40) ? 'Sign-off details (cont.)' : 'Sign-off details';
  drawSectionTitle(detailHeading);
  const columnWidth = (page.getWidth() - margin * 2 - 16) / 2;
  const baseDetailY = cursorY;
  engineerDetails.forEach((detail, index) => {
    const engineerRect = {
      x: margin,
      y: baseDetailY - detailHeight * (index + 1),
      width: columnWidth,
      height: detailHeight,
    };
    page.drawRectangle({
      x: engineerRect.x,
      y: engineerRect.y,
      width: engineerRect.width,
      height: engineerRect.height,
      borderWidth: 0.6,
      borderColor: TABLE_BORDER_COLOR,
      color: rgb(1, 1, 1),
    });
    page.drawText(detail.label, {
      x: engineerRect.x,
      y: engineerRect.y + engineerRect.height + 6,
      size: 9,
      font,
      color: headingColor,
    });
    drawCenteredTextBlock(page, detail.value, font, engineerRect, { fontSize: 10 });

    const customer = customerDetails[index];
    const customerRect = {
      x: margin + columnWidth + 16,
      y: baseDetailY - detailHeight * (index + 1),
      width: columnWidth,
      height: detailHeight,
    };
    page.drawRectangle({
      x: customerRect.x,
      y: customerRect.y,
      width: customerRect.width,
      height: customerRect.height,
      borderWidth: 0.6,
      borderColor: TABLE_BORDER_COLOR,
      color: rgb(1, 1, 1),
    });
    page.drawText(customer.label, {
      x: customerRect.x,
      y: customerRect.y + customerRect.height + 6,
      size: 9,
      font,
      color: headingColor,
    });
    drawCenteredTextBlock(page, customer.value, font, customerRect, { fontSize: 10 });
  });
  cursorY -= detailHeight * detailRows + 20;

  const signatureHeight = 90;
  const signatureHeading =
    ensureSpace(signatureHeight + 60) ? 'Signatures (cont.)' : 'Signatures';
  drawSectionTitle(signatureHeading);
  const signatureWidth = columnWidth;
  const signatureBoxes = [
    { label: 'Engineer signature', acroName: 'engineer_signature', x: margin },
    { label: 'Customer signature', acroName: 'customer_signature', x: margin + columnWidth + 16 },
  ];
  const resolvePageNumber = () => pdfDoc.getPages().indexOf(page) + 1;

  for (const box of signatureBoxes) {
    const entry = (signatureImages || []).find((item) =>
      new RegExp(box.acroName, 'i').test(item.acroName),
    );
    const boxRect = { x: box.x, y: cursorY - signatureHeight, width: signatureWidth, height: signatureHeight };
    page.drawText(box.label, {
      x: boxRect.x,
      y: boxRect.y + boxRect.height + 6,
      size: 10,
      font,
      color: headingColor,
    });
    page.drawRectangle({
      x: boxRect.x,
      y: boxRect.y,
      width: boxRect.width,
      height: boxRect.height,
      borderWidth: 1,
      borderColor: TABLE_BORDER_COLOR,
      color: rgb(1, 1, 1),
    });

    if (entry) {
      try {
        const decoded = decodeImageDataUrl(entry.data);
        if (decoded) {
          const image =
            decoded.mimeType === 'image/png'
              ? await pdfDoc.embedPng(decoded.buffer)
              : await pdfDoc.embedJpg(decoded.buffer);
          const availableWidth = signatureWidth - 12;
          const availableHeight = signatureHeight - 12;
          const scale = Math.min(availableWidth / image.width, availableHeight / image.height, 1);
          const drawWidth = image.width * scale;
          const drawHeight = image.height * scale;
          const offsetX = boxRect.x + 6 + (availableWidth - drawWidth) / 2;
          const offsetY = boxRect.y + 6 + (availableHeight - drawHeight) / 2;
          page.drawImage(image, {
            x: offsetX,
            y: offsetY,
            width: drawWidth,
            height: drawHeight,
          });
          signaturePlacements.push({
            acroName: entry.acroName,
            page: resolvePageNumber(),
            width: Number(drawWidth.toFixed(2)),
            height: Number(drawHeight.toFixed(2)),
          });
        }
      } catch (err) {
        console.warn(`[server] Unable to draw signature for ${box.label}: ${err.message}`);
      }
    }
  }
  cursorY -= signatureHeight + 30;

  return signaturePlacements;
}
/**
 * Escape HTML entities for safe template rendering.
 */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize a value for use in HTML id attributes.
 */
function toHtmlId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}

/**
 * Generate index.html on start so / can serve a ready-to-go form.
 */
function generateIndexHtml() {
  const descriptorByName = new Map(fieldDescriptors.map((d) => [d.requestName, d]));

  const demoValues = new Map([
    ['end_customer_name', 'Mercedes-Benz AG'],
    ['site_location', 'Flughafen Berlin Brandenburg, Melli-Beese Ring 1'],
    ['led_display_model', 'FE 038i2 Highres / Stripes Lowres'],
    ['batch_number', '2024-06-24-B'],
    ['date_of_service', '2024-06-24'],
    ['service_company_name', 'Sharp / NEC LED Solution Center'],
    ['led_notes_1', 'Cleaned ventilation grilles.'],
    ['led_notes_2', 'Pattern test passed on all colors.'],
    ['led_notes_3', 'Replaced one Pixel card cabinet B2.'],
    ['control_notes_1', 'Controllers reseated and firmware checked.'],
    ['control_notes_3', 'Brightness aligned with preset 450 cd/mÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â².'],
    ['spares_notes_1', 'Swapped in spare pixel card from inventory.'],
    ['spares_notes_2', 'Inventory log updated for remaining spares.'],
    ['general_notes', 'Updated monitoring agent and logged minor seam adjustment.\nPlease schedule follow-up for cabinet C4 fan swap.'],
    ['parts_removed_desc_1', 'Pixel card cabinet B2'],
    ['parts_removed_part_1', 'FE038-PCARD'],
    ['parts_removed_serial_1', 'SN-34782'],
    ['parts_used_part_1', 'FE038-PCARD'],
    ['parts_used_serial_1', 'SN-99012'],
    ['signoff_notes_1', 'All visual checks complete; system stable.'],
    ['signoff_notes_2', 'Customer to monitor cabinet C4 fan speed.'],
    ['engineer_company', 'LSC Sharp NEC'],
    ['engineer_datetime', '2024-06-24T10:30'],
    ['engineer_name', 'Ivan Technician'],
    ['customer_company', 'Mercedes-Benz AG'],
    ['customer_datetime', '2024-06-24T11:15'],
    ['customer_name', 'Anna Schneider'],
  ]);

  const signatureSamples = new Map([
    ['engineer_signature', 'Ivan Technician'],
    ['customer_signature', 'Anna Schneider'],
  ]);
  demoValues.set('control_notes_3', 'Brightness aligned with preset 450 cd/m2.');

  const demoChecked = new Set([
    'led_complete_1',
    'led_complete_2',
    'led_complete_3',
    'control_complete_1',
    'control_complete_3',
    'spares_complete_1',
    'signoff_complete_1',
  ]);

  const renderTextInput = (name, label, { type = 'text', textarea = false, placeholder = '' } = {}) => {
    const descriptor = descriptorByName.get(name);
    if (!descriptor) {
      return `        <!-- Missing field: ${escapeHtml(label)} (${escapeHtml(name)}) -->`;
    }
    const id = toHtmlId(name) || `field-${toHtmlId(descriptor.acroName)}`;
    const initial = demoValues.get(name);
    if (textarea) {
      const rows = type === 'textarea-lg' ? 8 : 4;
      const content = initial ? escapeHtml(initial) : '';
      return `        <label class="field" for="${id}">
          <span>${escapeHtml(label)}</span>
          <textarea id="${id}" name="${escapeHtml(descriptor.requestName)}" rows="${rows}" placeholder="${escapeHtml(placeholder || label)}" data-auto-resize>${content}</textarea>
        </label>`;
    }
    const valueAttr = initial ? ` value="${escapeHtml(initial)}"` : '';
    const enableSuggestions = SUGGESTION_FIELDS.has(descriptor.requestName);
    let suggestionAttrs = '';
    let datalistMarkup = '';
    if (enableSuggestions) {
      const listId = `suggest-${id}`;
      suggestionAttrs =
        ` data-suggest-field="${escapeHtml(descriptor.requestName)}" list="${escapeHtml(listId)}" autocomplete="off"`;
      datalistMarkup = `\n          <datalist id="${escapeHtml(listId)}" data-suggest-list="${escapeHtml(descriptor.requestName)}"></datalist>`;
    }
    return `        <label class="field" for="${id}">
          <span>${escapeHtml(label)}</span>
          <input type="${escapeHtml(type)}" id="${id}" name="${escapeHtml(descriptor.requestName)}"${valueAttr} placeholder="${escapeHtml(placeholder || label)}"${suggestionAttrs} />${datalistMarkup}
        </label>`;
  };

  const renderChecklistSection = (title, rows) => {
    const header = `      <section class="card">
        <h2>${escapeHtml(title)}</h2>
        <table class="checklist-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Complete</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>`;
    const body = rows.map((row) => {
      const checkbox = descriptorByName.get(row.checkbox);
      const notes = descriptorByName.get(row.notes);
      const checkboxId = checkbox ? toHtmlId(checkbox.requestName) || `check-${checkbox.requestName}` : `missing-${row.checkbox}`;
      const isChecked = row.checked || demoChecked.has(row.checkbox);
      const checkboxMarkup = checkbox
        ? `<input type="checkbox" id="${checkboxId}" name="${escapeHtml(checkbox.requestName)}"${isChecked ? ' checked' : ''} />`
        : `<span class="missing">Missing field</span>`;
      const notesInitial = row.notesValue ?? (notes ? demoValues.get(notes.requestName) : '');
      const notesMarkup = notes
        ? `<textarea name="${escapeHtml(notes.requestName)}" data-auto-resize rows="1" placeholder="Add notes">${notesInitial ? escapeHtml(notesInitial) : ''}</textarea>`
        : `<span class="missing">Missing notes field</span>`;
      const checkboxLabelStart = checkbox ? `<label class="check-wrapper" for="${checkboxId}">` : '<div class="check-wrapper">';
      const checkboxLabelEnd = checkbox ? '</label>' : '</div>';
      return `            <tr>
              <td>${escapeHtml(row.action)}</td>
              <td>${checkboxLabelStart}${checkboxMarkup}${checkboxLabelEnd}</td>
              <td>${notesMarkup}</td>
            </tr>`;
    }).join('\n');
    const footer = '          </tbody>\n        </table>\n      </section>';
    return `${header}\n${body}\n${footer}`;
  };

  const renderInlineInput = (name) => {
    const descriptor = descriptorByName.get(name);
    if (!descriptor) {
      return `<span class="missing">Missing: ${escapeHtml(name)}</span>`;
    }
    const initial = demoValues.get(name);
    if (/_notes_/i.test(name) || name === 'general_notes') {
      return `<textarea name="${escapeHtml(descriptor.requestName)}" data-auto-resize rows="1" placeholder="Add notes">${initial ? escapeHtml(initial) : ''}</textarea>`;
    }
    const valueAttr = initial ? ` value="${escapeHtml(initial)}"` : '';
    return `<input type="text" name="${escapeHtml(descriptor.requestName)}"${valueAttr} />`;
  };

  const partsTable = () => {
    const rows = [];
    for (let i = 1; i <= PARTS_ROW_COUNT; i += 1) {
      const rowClass = i === 1 ? 'parts-row' : 'parts-row is-hidden-row';
      rows.push(`            <tr class="${rowClass}" data-row-index="${i}">
              <td>${renderInlineInput(`parts_removed_desc_${i}`)}</td>
              <td>${renderInlineInput(`parts_removed_part_${i}`)}</td>
              <td>${renderInlineInput(`parts_removed_serial_${i}`)}</td>
              <td>${renderInlineInput(`parts_used_part_${i}`)}</td>
              <td>${renderInlineInput(`parts_used_serial_${i}`)}</td>
            </tr>`);
    }
    return `      <section class="card">
        <h2>Parts record</h2>
        <table class="parts-table" data-parts-table>
          <thead>
            <tr>
              <th>Part removed (description)</th>
              <th>Part number</th>
              <th>Serial number (removed)</th>
              <th>Part used in display</th>
              <th>Serial number (used)</th>
            </tr>
          </thead>
          <tbody>
${rows.join('\n')}
          </tbody>
        </table>
        <div class="parts-table-actions">
          <button type="button" class="button" data-action="parts-add-row">+ Add another part</button>
          <button type="button" class="button" data-action="parts-remove-row">- Remove last row</button>
          <p class="parts-table-hint">Maximum of ${PARTS_ROW_COUNT} rows.</p>
        </div>
      </section>`;
  };

  const renderSignaturePad = (name, label) => {
    const descriptor = descriptorByName.get(name);
    if (!descriptor) {
      return `        <!-- Missing signature field ${escapeHtml(name)} -->`;
    }
    const sample = signatureSamples.get(name) || '';
    return `        <div class="signature-pad" data-field="${escapeHtml(descriptor.requestName)}" data-sample="${escapeHtml(sample)}">
          <div class="signature-pad__label">
            <span>${escapeHtml(label)}</span>
            <button type="button" class="signature-clear">Clear</button>
          </div>
          <div class="signature-canvas-wrapper">
            <canvas aria-label="${escapeHtml(label)} signature area"></canvas>
          </div>
          <input type="hidden" name="${escapeHtml(descriptor.requestName)}" value="" />
        </div>`;
  };

  const engineerSignatureMarkup = renderSignaturePad('engineer_signature', "Engineer signature");
  const customerSignatureMarkup = renderSignaturePad('customer_signature', "Customer signature");

  const htmlParts = [];
  htmlParts.push(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Preventative Maintenance Checklist</title>
    <style>
      :root {
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f5f5fb;
        color: #1c1c1e;
      }
      body {
        margin: 0;
        padding: 1.5rem;
      }
      .container {
        max-width: 960px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
      }
      header {
        background: white;
        padding: 1.5rem;
        border-radius: 16px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      header h1 {
        margin: 0;
        font-size: 1.75rem;
      }
      header p {
        margin: 0;
        color: #4a4a4a;
        line-height: 1.4;
      }
      .card {
        background: white;
        padding: 1.5rem;
        border-radius: 16px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .card h2 {
        margin: 0;
        font-size: 1.3rem;
        color: #1f2a5b;
      }
      .grid.two-col {
        display: grid;
        gap: 1rem;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
        font-weight: 600;
      }
      .field > span {
        color: #2f2f37;
      }
      input[type="text"],
      input[type="date"],
      input[type="datetime-local"],
      textarea {
        font: inherit;
        padding: 0.75rem;
        border: 1px solid #d8d8e5;
        border-radius: 10px;
        background: #fafafe;
      }
      textarea {
        resize: vertical;
        min-height: 120px;
      }
      input[type="checkbox"] {
        width: 26px;
        height: 26px;
        accent-color: #2563eb;
      }
      .checkbox {
        display: flex;
        align-items: center;
        gap: 0.8rem;
        font-weight: 600;
      }
      .checklist-table {
        width: 100%;
        border-collapse: collapse;
      }
      .checklist-table th,
      .checklist-table td {
        border: 1px solid #d8d8e5;
        padding: 0.75rem;
        vertical-align: middle;
        background: white;
      }
      .checklist-table th {
        background: #eef1fb;
        text-align: left;
        font-size: 0.95rem;
      }
      .checklist-table td input[type="text"] {
        width: 100%;
        box-sizing: border-box;
        padding: 0.55rem;
        border-radius: 8px;
        border: 1px solid #d8d8e5;
      }
      .checklist-table td textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 0.55rem;
        border-radius: 8px;
        border: 1px solid #d8d8e5;
        resize: vertical;
        min-height: 2.75rem;
        line-height: 1.35;
        font: inherit;
      }
      .check-wrapper {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 32px;
      }
      .check-wrapper input {
        width: 26px;
        height: 26px;
      }
      .parts-table {
        width: 100%;
        border-collapse: collapse;
      }
      .parts-table th,
      .parts-table td {
        border: 1px solid #d8d8e5;
        padding: 0.6rem;
        background: white;
      }
      .parts-table th {
        background: #eef1fb;
        font-size: 0.9rem;
      }
      .parts-table td input,
      .parts-table td textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 0.5rem;
        border-radius: 8px;
        border: 1px solid #d8d8e5;
        background: #fafafe;
      }
      .parts-table td textarea {
        resize: vertical;
        min-height: 2.75rem;
        font: inherit;
      }
      .parts-table .is-hidden-row {
        display: none;
      }
      .parts-table-actions {
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .parts-table-actions .button {
        background: #2563eb;
        color: white;
        border: none;
        border-radius: 999px;
        padding: 0.65rem 1.2rem;
        font-weight: 600;
        cursor: pointer;
      }
      .parts-table-actions .button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .parts-table-hint {
        margin: 0;
        font-size: 0.85rem;
        color: #6b7280;
      }
      .photos-card {
        display: grid;
        gap: 1rem;
      }
      .photo-slot {
        border: 1px dashed #a0a3c2;
        border-radius: 12px;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        background: #fafbff;
      }
      .photo-slot span {
        font-weight: 600;
      }
      .photo-slot small {
        color: #6b7280;
      }
      .upload-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0.65rem 1.25rem;
        border-radius: 999px;
        background: #2563eb;
        color: #ffffff;
        font-weight: 600;
        cursor: pointer;
        width: fit-content;
      }
      .upload-button input {
        display: none;
      }
      .photo-preview {
        display: grid;
        gap: 0.75rem;
        padding: 0.75rem;
        border-radius: 10px;
        border: 1px solid #d8ddf0;
        background: rgba(59, 130, 246, 0.05);
      }
      .photo-preview[data-state="empty"] {
        color: #6b7280;
        font-style: italic;
        border-style: dashed;
      }
      .photo-preview-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 0.75rem;
      }
      .photo-preview-item {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        background: #ffffff;
        border: 1px solid #e0e3f5;
        border-radius: 10px;
        padding: 0.5rem;
        box-shadow: 0 4px 12px rgba(30, 64, 175, 0.08);
      }
      .photo-preview-item img {
        width: 100%;
        height: 100px;
        object-fit: cover;
        border-radius: 8px;
        background: #f3f4f6;
      }
      .photo-preview-item span {
        font-size: 0.8rem;
        word-break: break-word;
      }
      .signature-info {
        margin-bottom: 0.5rem;
      }
      .signature-row {
        display: grid;
        gap: 1rem;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      }
      .signature-pad {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .signature-pad__label {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-weight: 600;
        color: #2f2f37;
      }
      .signature-clear {
        appearance: none;
        border: none;
        background: none;
        color: #2563eb;
        font-weight: 600;
        cursor: pointer;
        padding: 0;
      }
      .signature-canvas-wrapper {
        border: 1px solid #d8d8e5;
        border-radius: 12px;
        padding: 0.5rem;
        background: white;
      }
      .signature-pad canvas {
        width: 100%;
        height: 180px;
        touch-action: none;
        background: white;
        border-radius: 8px;
      }
      .footer-actions {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      button[type="submit"] {
        background: #2563eb;
        color: white;
        border: none;
        border-radius: 999px;
        padding: 1rem;
        font-size: 1.05rem;
        font-weight: 600;
      }
      button[type="submit"]:hover:not(.is-disabled) {
        background: #1d4ed8;
      }
      button[type="submit"].is-disabled {
        opacity: 0.7;
        cursor: wait;
      }
      button[type="submit"].is-success {
        background: #16a34a;
      }
      button[type="submit"].is-error {
        background: #dc2626;
      }
      .upload-progress {
        display: none;
        flex-direction: column;
        gap: 0.5rem;
        margin-top: 0.5rem;
      }
      .upload-progress.is-visible {
        display: flex;
      }
      .upload-progress-bar {
        position: relative;
        height: 8px;
        border-radius: 999px;
        background: #e0e7ff;
        overflow: hidden;
      }
      .upload-progress-bar::after {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        width: var(--progress, 0%);
        height: 100%;
        background: linear-gradient(90deg, #2563eb, #7c3aed);
      }
      .upload-progress-label {
        font-size: 0.9rem;
        color: #1f2937;
      }
      .upload-files-summary {
        display: grid;
        gap: 0.25rem;
        font-size: 0.9rem;
        color: #374151;
      }
      .upload-files-summary strong {
        font-weight: 600;
      }
      .debug-controls {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .debug-controls .checkbox {
        margin: 0;
      }
      .debug-hint {
        font-size: 0.85rem;
        color: #6b7280;
      }
      .debug-panel {
        display: none;
        margin-top: 0.75rem;
        padding: 1rem;
        background: #f3f4ff;
        border-radius: 12px;
        border: 1px solid #c7d2fe;
        max-height: 260px;
        overflow: auto;
      }
      .debug-panel.is-visible {
        display: block;
      }
      .debug-panel pre {
        margin: 0;
        font-size: 0.85rem;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #status {
        margin: 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 0.85rem;
        color: #3d3d5c;
        white-space: pre-wrap;
      }
      .missing {
        color: #b91c1c;
        font-size: 0.85rem;
        font-weight: 600;
      }
      @media (max-width: 680px) {
        .checklist-table td {
          padding: 0.6rem;
        }
        .checklist-table td textarea {
          min-height: 2.2rem;
        }
        .signature-pad canvas {
          height: 150px;
        }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <header>
        <h1>Preventative Maintenance Checklist</h1>
        <p>Please review each item and attach up to eight supporting photos. The fields below are pre-filled with example data for quick testing.</p>
      </header>
      <form id="pm-form" enctype="multipart/form-data">
        <section class="card">
          <h2>Site information</h2>
          <div class="grid two-col">
${renderTextInput('end_customer_name', 'End customer name')}
${renderTextInput('site_location', 'Site location')}
${renderTextInput('led_display_model', 'LED display model')}
${renderTextInput('batch_number', 'Batch number')}
${renderTextInput('date_of_service', 'Date of service', { type: 'date' })}
${renderTextInput('service_company_name', 'Service company name')}
          </div>
        </section>
${CHECKLIST_SECTIONS.map((section) => renderChecklistSection(section.title, section.rows)).join('\n')}
        <section class="card">
          <h2>Additional notes</h2>
${renderTextInput('general_notes', 'Overall notes', { textarea: true, type: 'textarea-lg', placeholder: 'Record any observations or follow-up actions' })}
        </section>
        <section class="card photos-card">
          <h2>Photos</h2>
          <div class="photo-slot" data-photo-slot="photo_before">
            <span>Photos before maintenance</span>
            <p>Select up to 20 images that show the equipment before work started.</p>
            <label class="upload-button">
              <input type="file" name="photo_before" accept="image/*" multiple data-photo-input="photo_before" />
              Upload before photos
            </label>
            <div class="photo-preview" data-photo-preview="photo_before" data-photo-mode="multi" data-photo-label="Before photo" data-state="empty">
              <span>No files selected yet.</span>
            </div>
            <small>JPEG/PNG only, up to 20 images.</small>
          </div>
          <div class="photo-slot" data-photo-slot="photo_after">
            <span>Photos after maintenance</span>
            <p>Select up to 20 images that show the completed work.</p>
            <label class="upload-button">
              <input type="file" name="photo_after" accept="image/*" multiple data-photo-input="photo_after" />
              Upload after photos
            </label>
            <div class="photo-preview" data-photo-preview="photo_after" data-photo-mode="multi" data-photo-label="After photo" data-state="empty">
              <span>No files selected yet.</span>
            </div>
            <small>JPEG/PNG only, up to 20 images.</small>
          </div>
          <div class="photo-slot" data-photo-slot="photos">
            <span>Supporting photos (optional)</span>
            <p>Attach up to 20 additional images that document this visit.</p>
            <label class="upload-button">
              <input type="file" name="photos" accept="image/*" multiple data-photo-input="photos" />
              Upload supporting photos
            </label>
            <div class="photo-preview" data-photo-preview="photos" data-photo-mode="multi" data-photo-label="Supporting photo" data-state="empty">
              <span>No files selected yet.</span>
            </div>
            <small>JPEG/PNG only, up to 20 images.</small>
          </div>
        </section>
${partsTable()}
${renderChecklistSection('Sign off checklist', SIGN_OFF_CHECKLIST_ROWS)}

        <section class="card">
          <h2>Signatures</h2>
          <div class="grid two-col signature-info">
            ${renderTextInput('engineer_company', 'On-site engineer company')}
            ${renderTextInput('engineer_datetime', 'Engineer date & time', { type: 'datetime-local' })}
            ${renderTextInput('engineer_name', 'Engineer name')}
            ${renderTextInput('customer_company', 'Customer company')}
            ${renderTextInput('customer_datetime', 'Customer date & time', { type: 'datetime-local' })}
            ${renderTextInput('customer_name', 'Customer name')}
          </div>
          <div class="signature-row">
            ${renderSignaturePad('engineer_signature', 'Engineer signature')}
            ${renderSignaturePad('customer_signature', 'Customer signature')}
          </div>
        </section>
        <div class="footer-actions">
          <button type="submit">Submit checklist</button>
          <div class="upload-progress" data-upload-progress>
            <div class="upload-progress-bar" data-upload-progress-bar></div>
            <span class="upload-progress-label" data-upload-progress-label>Preparing upload...</span>
          </div>
          <div class="upload-files-summary" data-upload-files></div>
          <div class="debug-controls">
            <label class="checkbox">
              <input type="checkbox" data-debug-toggle />
              <span>Enable debug feedback</span>
            </label>
            <span class="debug-hint">Toggle to capture request details for troubleshooting.</span>
          </div>
          <div class="debug-panel" data-debug-panel>
            <pre data-debug-log>Debug output will appear here once enabled.</pre>
          </div>
          <pre id="status"></pre>
        </div>
      </form>
    </div>
    <script>
      (function () {
        const formEl = document.getElementById('pm-form');
        if (!formEl) return;

        const statusEl = document.getElementById('status');
        const submitButton = formEl.querySelector('button[type="submit"]');
        const uploadProgressEl = document.querySelector('[data-upload-progress]');
        const uploadProgressBarEl = document.querySelector('[data-upload-progress-bar]');
        const uploadProgressLabelEl = document.querySelector('[data-upload-progress-label]');
        const uploadFilesSummaryEl = document.querySelector('[data-upload-files]');
        const debugToggleEl = document.querySelector('[data-debug-toggle]');
        const debugPanelEl = document.querySelector('[data-debug-panel]');
        const debugLogEl = document.querySelector('[data-debug-log]');
        const DEBUG_KEY = 'pm-form-debug-enabled';

        const selectedFiles = new Map();
        const previewUrls = new Map();
        const debugState = { enabled: false, timeline: [] };

        function formatBytes(bytes) {
          if (!Number.isFinite(bytes) || bytes <= 0) {
            return '0 B';
          }
          const units = ['B', 'KB', 'MB', 'GB', 'TB'];
          let value = bytes;
          let index = 0;
          while (value >= 1024 && index < units.length - 1) {
            value /= 1024;
            index += 1;
          }
          const decimals = value < 10 && index > 0 ? 1 : 0;
          return value.toFixed(decimals) + ' ' + units[index];
        }

        function setProgress(percent, label) {
          if (uploadProgressBarEl) {
            const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
            uploadProgressBarEl.style.setProperty('--progress', clamped + '%');
          }
          if (uploadProgressLabelEl && label !== undefined) {
            uploadProgressLabelEl.textContent = label;
          }
        }

        function showProgress(totalBytes) {
          if (uploadProgressEl) {
            uploadProgressEl.classList.add('is-visible');
          }
          const label = totalBytes
            ? 'Preparing upload (' + formatBytes(totalBytes) + ')'
            : 'Preparing upload...';
          setProgress(0, label);
        }

        function hideProgress() {
          if (uploadProgressEl) {
            uploadProgressEl.classList.remove('is-visible');
          }
          setProgress(0, '');
        }

        function emitDebug() {
          if (!debugState.enabled || !debugLogEl) return;
          debugLogEl.textContent = JSON.stringify(debugState.timeline, null, 2);
        }

        function recordDebug(eventName, data) {
          if (!debugState.enabled) return;
          debugState.timeline.push(
            Object.assign({ event: eventName, at: new Date().toISOString() }, data || {})
          );
          if (debugState.timeline.length > 120) {
            debugState.timeline.shift();
          }
          emitDebug();
        }

        function applyDebugState(enabled) {
          debugState.enabled = !!enabled;
          if (debugToggleEl) {
            debugToggleEl.checked = debugState.enabled;
          }
          if (debugPanelEl) {
            if (debugState.enabled) {
              debugPanelEl.classList.add('is-visible');
            } else {
              debugPanelEl.classList.remove('is-visible');
            }
          }
          if (!debugState.enabled && debugLogEl) {
            debugLogEl.textContent = 'Debug output will appear here once enabled.';
          } else if (debugState.enabled) {
            emitDebug();
          }
          try {
            window.localStorage.setItem(DEBUG_KEY, debugState.enabled ? '1' : '0');
          } catch (err) {
            // ignore storage failures
          }
        }

        function getPhotoLabel(fieldName) {
          const container = document.querySelector('[data-photo-preview="' + fieldName + '"]');
          if (!container) return fieldName;
          return container.dataset.photoLabel || fieldName;
        }

        function updateFilesSummary() {
          if (!uploadFilesSummaryEl) return;
          uploadFilesSummaryEl.innerHTML = '';
          let hasEntries = false;
          selectedFiles.forEach((files, fieldName) => {
            if (!files || !files.length) {
              return;
            }
            hasEntries = true;
            const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
            const item = document.createElement('div');
            const label = getPhotoLabel(fieldName);
            const countText = files.length === 1 ? '1 file' : files.length + ' files';
            item.innerHTML =
              '<strong>' +
              label +
              ':</strong> ' +
              countText +
              ' (' +
              formatBytes(totalBytes) +
              ')';
            uploadFilesSummaryEl.appendChild(item);
          });
          if (!hasEntries) {
            const emptyRow = document.createElement('div');
            emptyRow.textContent = 'No photos selected yet.';
            uploadFilesSummaryEl.appendChild(emptyRow);
          }
        }

        function revokePreviewUrls(fieldName) {
          const urls = previewUrls.get(fieldName);
          if (urls) {
            urls.forEach((url) => URL.revokeObjectURL(url));
          }
          previewUrls.delete(fieldName);
        }

        function renderPreview(fieldName, files, mode) {
          const container = document.querySelector('[data-photo-preview="' + fieldName + '"]');
          if (!container) return;
          revokePreviewUrls(fieldName);
          container.innerHTML = '';
          if (!files || !files.length) {
            container.dataset.state = 'empty';
            const span = document.createElement('span');
            span.textContent = mode === 'multi' ? 'No files selected yet.' : 'No file selected yet.';
            container.appendChild(span);
            return;
          }
          container.dataset.state = 'filled';
          const urls = [];
          if (mode === 'multi') {
            const list = document.createElement('div');
            list.className = 'photo-preview-list';
            files.forEach((file) => {
              const item = document.createElement('div');
              item.className = 'photo-preview-item';
              const img = document.createElement('img');
              const url = URL.createObjectURL(file);
              urls.push(url);
              img.src = url;
              img.alt = file.name;
              img.onerror = () => {
                URL.revokeObjectURL(url);
                const reader = new FileReader();
                reader.onload = () => {
                  img.src = reader.result;
                };
                reader.readAsDataURL(file);
              };
              const caption = document.createElement('span');
              caption.textContent = file.name + ' (' + formatBytes(file.size || 0) + ')';
              item.appendChild(img);
              item.appendChild(caption);
              list.appendChild(item);
            });
            container.appendChild(list);
          } else {
            const file = files[0];
            const item = document.createElement('div');
            item.className = 'photo-preview-item';
            const img = document.createElement('img');
            const url = URL.createObjectURL(file);
            urls.push(url);
            img.src = url;
            img.alt = file.name;
            img.onerror = () => {
              URL.revokeObjectURL(url);
              const reader = new FileReader();
              reader.onload = () => {
                img.src = reader.result;
              };
              reader.readAsDataURL(file);
            };
            const caption = document.createElement('span');
            caption.textContent = file.name + ' (' + formatBytes(file.size || 0) + ')';
            item.appendChild(img);
            item.appendChild(caption);
            container.appendChild(item);
          }
          previewUrls.set(fieldName, urls);
        }

        function handleFileSelection(fieldName, fileList, mode) {
          const files = fileList ? Array.from(fileList) : [];
          selectedFiles.set(fieldName, files);
          renderPreview(fieldName, files, mode);
          updateFilesSummary();
          recordDebug('files-updated', {
            field: fieldName,
            count: files.length,
            totalBytes: files.reduce((sum, file) => sum + (file.size || 0), 0),
            names: files.map((file) => file.name),
          });
        }

        function setupPartsTable() {
          const table = document.querySelector('[data-parts-table]');
          if (!table) return;
          const rows = Array.from(table.querySelectorAll('.parts-row'));
          const addButton = document.querySelector('[data-action="parts-add-row"]');
          const removeButton = document.querySelector('[data-action="parts-remove-row"]');
          const hiddenClass = 'is-hidden-row';

          const enableRow = (row) => {
            row.classList.remove(hiddenClass);
            row.querySelectorAll('input, textarea').forEach((input) => {
              input.disabled = false;
            });
          };

          const disableRow = (row, clear = false) => {
            row.classList.add(hiddenClass);
            row.querySelectorAll('input, textarea').forEach((input) => {
              if (clear) input.value = '';
              input.disabled = true;
            });
          };

          const refresh = () => {
            const visibleRows = rows.filter((row) => !row.classList.contains(hiddenClass));
            if (addButton) {
              addButton.disabled = visibleRows.length >= rows.length;
            }
            if (removeButton) {
              removeButton.disabled = visibleRows.length <= 1;
            }
          };

          rows.forEach((row, index) => {
            if (index === 0) {
              enableRow(row);
            } else if (
              Array.from(row.querySelectorAll('input, textarea')).some((input) => input.value.trim().length)
            ) {
              enableRow(row);
            } else {
              disableRow(row, true);
            }
          });

          refresh();

          if (addButton) {
            addButton.addEventListener('click', (event) => {
              event.preventDefault();
              const nextHidden = rows.find((row) => row.classList.contains(hiddenClass));
              if (!nextHidden) return;
              enableRow(nextHidden);
              const firstInput = nextHidden.querySelector('input, textarea');
              if (firstInput) firstInput.focus();
              refresh();
            });
          }

          if (removeButton) {
            removeButton.addEventListener('click', (event) => {
              event.preventDefault();
              const visibleRows = rows.filter((row) => !row.classList.contains(hiddenClass));
              if (visibleRows.length <= 1) return;
              const lastVisible = visibleRows[visibleRows.length - 1];
              disableRow(lastVisible, true);
              refresh();
            });
          }
        }

        function setupPhotoUploads() {
          document.querySelectorAll('[data-photo-preview]').forEach((container) => {
            const fieldName = container.dataset.photoPreview;
            if (!fieldName) return;
            const input = formEl.querySelector('[data-photo-input="' + fieldName + '"]');
            if (!input) return;
            const mode = container.dataset.photoMode || (input.multiple ? 'multi' : 'single');
            handleFileSelection(fieldName, input.files, mode);
            input.addEventListener('change', () => handleFileSelection(fieldName, input.files, mode));
          });
        }

        function setupAutoResizeTextareas() {
          const textareas = document.querySelectorAll('textarea[data-auto-resize]');
          if (!textareas.length) return;
          const resize = (textarea) => {
            textarea.style.height = 'auto';
            const newHeight = Math.max(textarea.scrollHeight, 44);
            textarea.style.height = newHeight + 'px';
          };
          textareas.forEach((textarea) => {
            textarea.style.overflow = 'hidden';
            resize(textarea);
            textarea.addEventListener('input', () => resize(textarea));
            textarea.addEventListener('change', () => resize(textarea));
          });
        }

        function setupSignaturePads() {
          const ratio = window.devicePixelRatio || 1;

          document.querySelectorAll('.signature-pad').forEach((pad) => {
            const canvas = pad.querySelector('canvas');
            const hiddenInput = pad.querySelector('input[type="hidden"]');
            const clearButton = pad.querySelector('.signature-clear');
            const sampleText = pad.dataset.sample || '';
            const ctx = canvas.getContext('2d');
            let drawing = false;
            let sampleActive = false;
            let canvasWidth = 0;
            let canvasHeight = 0;

            canvas.style.touchAction = 'none';

            const setPenDefaults = () => {
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.scale(ratio, ratio);
              ctx.lineCap = 'round';
              ctx.lineJoin = 'round';
              ctx.lineWidth = 2.5;
              ctx.strokeStyle = '#1f2937';
              ctx.fillStyle = '#1f2937';
            };

            const syncHiddenValue = () => {
              try {
                hiddenInput.value = canvas.toDataURL('image/png');
              } catch (err) {
                hiddenInput.value = '';
              }
            };

            const drawFromDataUrl = (dataUrl) => {
              if (!dataUrl || !dataUrl.startsWith('data:image/')) return;
              const img = new Image();
              img.onload = () => {
                setPenDefaults();
                ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
              };
              img.src = dataUrl;
            };

            const renderSample = () => {
              if (!sampleText) return;
              setPenDefaults();
              ctx.font = '28px "Segoe Script", cursive';
              ctx.fillText(sampleText, 24, canvasHeight / 2 + 10);
              sampleActive = true;
              syncHiddenValue();
            };

            const resizeCanvas = () => {
              const wrapper = pad.querySelector('.signature-canvas-wrapper');
              canvasWidth = wrapper.clientWidth || 340;
              canvasHeight = wrapper.clientHeight || 160;
              canvas.width = canvasWidth * ratio;
              canvas.height = canvasHeight * ratio;
              canvas.style.width = canvasWidth + 'px';
              canvas.style.height = canvasHeight + 'px';
              setPenDefaults();
              if (sampleActive) {
                renderSample();
                return;
              }
              if (hiddenInput.value) {
                drawFromDataUrl(hiddenInput.value);
              } else if (sampleText) {
                renderSample();
              }
            };

            resizeCanvas();
            window.addEventListener('resize', () => {
              const previousValue = hiddenInput.value;
              const wasSample = sampleActive;
              resizeCanvas();
              if (previousValue && !wasSample) {
                drawFromDataUrl(previousValue);
              } else if (wasSample) {
                renderSample();
              }
            });

            const getPoint = (event) => {
              const rect = canvas.getBoundingClientRect();
              return {
                x: (event.clientX ?? (event.touches && event.touches[0]?.clientX) ?? 0) - rect.left,
                y: (event.clientY ?? (event.touches && event.touches[0]?.clientY) ?? 0) - rect.top,
              };
            };

            canvas.addEventListener('pointerdown', (event) => {
              event.preventDefault();
              canvas.setPointerCapture(event.pointerId);
              if (sampleActive) {
                setPenDefaults();
                hiddenInput.value = '';
                sampleActive = false;
              }
              drawing = true;
              const { x, y } = getPoint(event);
              ctx.beginPath();
              ctx.moveTo(x, y);
            });

            canvas.addEventListener('pointermove', (event) => {
              if (!drawing) return;
              event.preventDefault();
              const { x, y } = getPoint(event);
              ctx.lineTo(x, y);
              ctx.stroke();
            });

            const finishStroke = (event) => {
              if (!drawing) return;
              event.preventDefault();
              try {
                canvas.releasePointerCapture(event.pointerId);
              } catch (err) {
                // ignore
              }
              drawing = false;
              ctx.closePath();
              sampleActive = false;
              syncHiddenValue();
            };

            canvas.addEventListener('pointerup', finishStroke);
            canvas.addEventListener('pointerleave', finishStroke);
            canvas.addEventListener('pointercancel', finishStroke);

            clearButton.addEventListener('click', (event) => {
              event.preventDefault();
              drawing = false;
              sampleActive = false;
              hiddenInput.value = '';
              setPenDefaults();
            });
            syncHiddenValue();
          });
        }

        function setupAutoSuggestions() {
          const inputs = document.querySelectorAll('input[data-suggest-field]');
          if (!inputs.length || typeof fetch !== 'function') return;

          inputs.forEach((input) => {
            const fieldName = input.dataset.suggestField;
            if (!fieldName) return;
            const listId = input.getAttribute('list');
            if (!listId) return;
            const dataList = document.getElementById(listId);
            if (!dataList) return;

            let lastQuery = '';
            let pendingController = null;

            const applySuggestions = (values) => {
              dataList.innerHTML = '';
              if (!Array.isArray(values) || !values.length) {
                return;
              }
              values.forEach((value) => {
                const option = document.createElement('option');
                option.value = value;
                dataList.appendChild(option);
              });
            };

            const requestSuggestions = (rawValue) => {
              const query = (rawValue || '').trim();
              if (query.length < 3) {
                lastQuery = '';
                applySuggestions([]);
                if (pendingController && typeof pendingController.abort === 'function') {
                  pendingController.abort();
                }
                pendingController = null;
                return;
              }
              if (query === lastQuery) {
                return;
              }
              lastQuery = query;
              if (pendingController && typeof pendingController.abort === 'function') {
                pendingController.abort();
              }
              pendingController =
                typeof AbortController === 'function' ? new AbortController() : null;
              const params =
                '?field=' + encodeURIComponent(fieldName) + '&q=' + encodeURIComponent(query);
              const init = pendingController ? { signal: pendingController.signal } : undefined;
              fetch('./suggest' + params, init)
                .then((response) => (response.ok ? response.json() : null))
                .then((payload) => {
                  if (!payload || !Array.isArray(payload.suggestions)) {
                    applySuggestions([]);
                    return;
                  }
                  applySuggestions(payload.suggestions);
                })
                .catch((err) => {
                  if (err && err.name === 'AbortError') {
                    return;
                  }
                  console.warn('Suggestion lookup failed', err);
                });
            };

            input.addEventListener('input', () => requestSuggestions(input.value));
            input.addEventListener('focus', () => requestSuggestions(input.value));
          });
        }

        if (debugToggleEl) {
          let stored = null;
          try {
            stored = window.localStorage.getItem(DEBUG_KEY);
          } catch (err) {
            stored = null;
          }
          applyDebugState(stored === '1');
          debugToggleEl.addEventListener('change', () => {
            applyDebugState(debugToggleEl.checked);
          });
        } else {
          applyDebugState(false);
        }

        setupAutoResizeTextareas();
        setupPartsTable();
        setupPhotoUploads();
        setupSignaturePads();
        setupAutoSuggestions();
        updateFilesSummary();

        formEl.addEventListener('submit', (event) => {
          event.preventDefault();
          if (statusEl) {
            statusEl.textContent = 'Submitting...';
          }
          submitButton.classList.remove('is-success', 'is-error');
          submitButton.classList.add('is-disabled');
          submitButton.disabled = true;

          const formData = new FormData(formEl);
          if (debugState.enabled) {
            formData.set('debug_mode', 'true');
          } else {
            formData.delete('debug_mode');
          }

          const totalBytes = Array.from(formData.values()).reduce((sum, value) => {
            if (value instanceof File) {
              return sum + (value.size || 0);
            }
            return sum;
          }, 0);

          showProgress(totalBytes);
          debugState.timeline = [];
          recordDebug('submit-start', {
            totalFields: Array.from(formData.keys()).length,
            totalUploadBytes: totalBytes,
          });

          const xhr = new XMLHttpRequest();
          xhr.open('POST', './submit');

          xhr.upload.onprogress = (event) => {
            if (!event) return;
            if (event.lengthComputable) {
              const percent = Math.min(99, Math.round((event.loaded / event.total) * 100));
              setProgress(
                percent,
                'Uploading ' +
                  percent +
                  '% (' +
                  formatBytes(event.loaded) +
                  ' of ' +
                  formatBytes(event.total) +
                  ')'
              );
              recordDebug('upload-progress', {
                lengthComputable: true,
                loaded: event.loaded,
                total: event.total,
                percent,
              });
            } else {
              setProgress(15, 'Uploading...');
              recordDebug('upload-progress', {
                lengthComputable: false,
                loaded: event.loaded || 0,
              });
            }
          };

          const resetSubmitState = () => {
            submitButton.disabled = false;
            submitButton.classList.remove('is-disabled');
          };

          xhr.onerror = () => {
            recordDebug('submit-error', { type: 'network' });
            submitButton.classList.add('is-error');
            if (statusEl) {
              statusEl.textContent = 'Network error during submission.';
            }
            hideProgress();
            resetSubmitState();
          };

          xhr.ontimeout = () => {
            recordDebug('submit-error', { type: 'timeout' });
            submitButton.classList.add('is-error');
            if (statusEl) {
              statusEl.textContent = 'Submission timed out.';
            }
            hideProgress();
            resetSubmitState();
          };

          xhr.onload = () => {
            let payload = null;
            let parseError = null;
            if (xhr.responseText) {
              try {
                payload = JSON.parse(xhr.responseText);
              } catch (err) {
                parseError = err.message;
              }
            }
            recordDebug('submit-complete', {
              status: xhr.status,
              payload,
              parseError,
            });

            const downloadTarget =
              payload && typeof (payload.path || payload.url) === 'string'
                ? payload.path || payload.url
                : null;
            const success =
              xhr.status >= 200 &&
              xhr.status < 300 &&
              payload &&
              payload.ok &&
              typeof downloadTarget === 'string';

            if (success) {
              submitButton.classList.add('is-success');
              if (statusEl) {
                statusEl.textContent = 'Download starting...';
              }
              setProgress(100, 'Upload complete');
              setTimeout(() => {
                hideProgress();
                window.location.href = downloadTarget;
              }, 200);
            } else {
              submitButton.classList.add('is-error');
              const message =
                (payload && (payload.error || payload.message)) ||
                'Submission failed (status ' + xhr.status + ')';
              if (statusEl) {
                statusEl.textContent = message;
              }
              hideProgress();
            }

            resetSubmitState();
          };

          xhr.send(formData);
        });
      })();
    </script>
  </body>
</html>`);
  const html = htmlParts.join('\n');
  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), html, 'utf8');
}




generateIndexHtml();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 64,
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png'];
    if (!file.mimetype) {
      return cb(new Error('Invalid file type.'));
    }
    if (!allowed.includes(file.mimetype.toLowerCase())) {
      return cb(new Error('Only JPEG and PNG images are allowed.'));
    }
    return cb(null, true);
  },
});

const uploadFields = upload.fields([
  { name: 'photo_before', maxCount: 20 },
  { name: 'photo_after', maxCount: 20 },
  { name: 'photos', maxCount: 20 },
  { name: 'photos[]', maxCount: 20 },
]);

function collectPhotoFiles(files) {
  if (!files) return [];
  const photos = [];
  const append = (list) => {
    if (Array.isArray(list)) {
      photos.push(...list.filter(Boolean));
    }
  };
  append(files.photo_before);
  append(files.photo_after);
  append(files.photos);
  append(files['photos[]']);
  return photos;
}

function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:(image\/(?:png|jpe?g));base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  try {
    const buffer = Buffer.from(match[2], 'base64');
    return { mimeType, buffer };
  } catch (err) {
    return null;
  }
}

function normalizeCheckboxValue(value) {
  const single = toSingleValue(value);
  if (single === undefined || single === null) return false;
  const normalized = String(single).trim().toLowerCase();
  return ['true', '1', 'on', 'yes', 'checked'].includes(normalized);
}

function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[^a-z0-9\-_.]+/gi, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'file';
}

async function embedUploadedImages(pdfDoc, form, photoFiles) {
  if (!photoFiles.length) return [];

  const embeddings = [];
  for (const file of photoFiles) {
    if (!file || !file.buffer) continue;
    const image =
      file.mimetype && file.mimetype.toLowerCase() === 'image/png'
        ? await pdfDoc.embedPng(file.buffer)
        : await pdfDoc.embedJpg(file.buffer);
    embeddings.push({ file, image });
  }

  if (!embeddings.length) return [];

  const pages = pdfDoc.getPages();
  const baseSize = pages.length ? pages[pages.length - 1].getSize() : { width: 595.28, height: 841.89 };
  const margin = 36;
  const captionHeight = 28;
  const placements = [];
  const labelByField = {
    photo_before: 'Before photo',
    photo_after: 'After photo',
    photos: 'Supporting photo',
    'photos[]': 'Supporting photo',
  };
  const counters = new Map();

  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (const { file, image } of embeddings) {
    const fieldName = file.fieldname || 'photos';
    const labelBase = labelByField[fieldName] || 'Photo';
    const currentIndex = (counters.get(fieldName) || 0) + 1;
    counters.set(fieldName, currentIndex);
    const caption = labelBase + (currentIndex > 1 ? ` #${currentIndex}` : '');

    const isLandscape = image.width >= image.height;
    const pageSize = isLandscape
      ? [baseSize.height, baseSize.width]
      : [baseSize.width, baseSize.height];
    const page = pdfDoc.addPage(pageSize);

    const availableWidth = page.getWidth() - margin * 2;
    const availableHeight = page.getHeight() - margin * 2 - captionHeight;
    const scale = Math.min(
      availableWidth / image.width,
      availableHeight / image.height,
    );
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    const x = (page.getWidth() - drawWidth) / 2;
    const y = margin + (availableHeight - drawHeight) / 2;

    page.drawImage(image, {
      x,
      y,
      width: drawWidth,
      height: drawHeight,
    });

    page.drawText(caption, {
      x: margin,
      y: page.getHeight() - margin - captionHeight + 10,
      size: 12,
      font: boldFont,
      color: rgb(0.12, 0.12, 0.18),
    });

    placements.push({
      originalName: file.originalname,
      fieldName,
      label: caption,
      index: currentIndex,
      fieldTarget: `page-${pdfDoc.getPageCount()}`,
    });
  }

  return placements;
}

function detectSubmitterName(body) {
  const candidates = [
    'submitter_name',
    'Submitter name',
    'technician_name',
    'Technician name',
    'inspector_name',
    'Inspector name',
    'name',
  ];

  for (const descriptor of fieldDescriptors) {
    if (/submit|technician|engineer|inspector/i.test(descriptor.acroName)) {
      const value = toSingleValue(body[descriptor.requestName]);
      if (value) return String(value);
    }
  }

  for (const key of candidates) {
    const value = toSingleValue(body[key]);
    if (value) return String(value);
  }

  return 'Unknown';
}

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/suggest', (req, res) => {
  const fieldParam = typeof req.query.field === 'string' ? req.query.field.trim() : '';
  const queryParam = typeof req.query.q === 'string' ? req.query.q : '';
  if (!fieldParam) {
    return res.status(400).json({ ok: false, error: 'Missing field parameter.' });
  }
  const suggestions = getSuggestionsForField(fieldParam, queryParam);
  return res.json({
    ok: true,
    field: fieldParam,
    query: queryParam,
    suggestions,
  });
});

app.post('/submit', (req, res, next) => {
  uploadFields(req, res, (err) => {
    if (err) {
      return next(err);
    }
    return next();
  });
}, async (req, res) => {
  const photoFiles = collectPhotoFiles(req.files);
  const signatureImages = [];
  const sanitizedBody = {};
  const overflowTextEntries = [];
  const partsRowUsage = collectPartsRowUsage(req.body || {});
  let overflowPlacements = [];
  let hiddenPartRows = [];
  let partsRowsRendered = [];

  if (req.body && typeof req.body === 'object') {
    for (const [key, value] of Object.entries(req.body)) {
      if (Array.isArray(value)) {
        sanitizedBody[key] = value.map((item) => (typeof item === 'string' && item.startsWith('data:image/')) ? '[embedded-image]' : item);
      } else if (typeof value === 'string' && value.startsWith('data:image/')) {
        sanitizedBody[key] = '[embedded-image]';
      } else {
        sanitizedBody[key] = value;
      }
    }
  }

  try {
    if (!templatePath) {
      return res.status(500).json({ ok: false, error: 'Template path was not provided. Set TEMPLATE_PATH or update fields.json.' });
    }

    if (!fs.existsSync(templatePath)) {
      return res.status(500).json({ ok: false, error: `Template PDF not found at ${templatePath}` });
    }

    const pdfBytes = await fs.promises.readFile(templatePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const form = pdfDoc.getForm();

    if (!form) {
      return res.status(500).json({ ok: false, error: 'Template PDF does not contain an AcroForm.' });
    }
    const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

    for (const descriptor of fieldDescriptors) {
      const rawValue = req.body ? req.body[descriptor.requestName] : undefined;
      const value = toSingleValue(rawValue);
      const skipOriginalField = SIGN_OFF_REQUEST_FIELDS.has(descriptor.requestName);
      try {
        if (descriptor.type === 'checkbox') {
          if (skipOriginalField) {
            continue;
          }
          const checkbox = form.getCheckBox(descriptor.acroName);
          if (normalizeCheckboxValue(rawValue)) {
            checkbox.check();
          } else {
            checkbox.uncheck();
          }
        } else if (descriptor.type === 'text') {
          const textField = form.getTextField(descriptor.acroName);
          const signatureData =
            typeof rawValue === 'string'
              ? rawValue
              : typeof value === 'string'
              ? value
              : null;
          if (/signature/i.test(descriptor.acroName) && signatureData && signatureData.startsWith('data:image/')) {
            signatureImages.push({ acroName: descriptor.acroName, data: signatureData });
            textField.setText('');
            if (skipOriginalField) {
              continue;
            }
          } else {
            const normalizedValue =
              value !== undefined && value !== null ? String(value).replace(/\r\n/g, '\n') : '';
            const style = resolveTextFieldStyle(descriptor.acroName);
            const widgets =
              textField.acroField && typeof textField.acroField.getWidgets === 'function'
                ? textField.acroField.getWidgets()
                : [];
            const primaryWidget = widgets && widgets.length ? widgets[0] : null;
            const layout = layoutTextForField({
              value: normalizedValue,
              font: helveticaFont,
              fontSize: style.fontSize,
              multiline: style.multiline,
              lineHeightMultiplier:
                style.lineHeightMultiplier || DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,
              widget: primaryWidget,
              minFontSize: style.minFontSize,
            });
            const multilineNeeded =
              style.multiline || layout.displayedLines > 1 || layout.fieldText.includes('\n');
            if (!skipOriginalField) {
              if (multilineNeeded) {
                try {
                  textField.enableMultiline();
                } catch (enableErr) {
                  console.warn(`[server] Unable to enable multiline for ${descriptor.acroName}: ${enableErr.message}`);
                }
              } else {
                try {
                  textField.disableMultiline();
                } catch (disableErr) {
                  // ignore
                }
              }
              const displayText =
                layout.fieldText && layout.fieldText.trim().length
                  ? layout.fieldText
                  : normalizedValue;
              textField.setText(displayText || '');
              try {
                textField.updateAppearances(helveticaFont, {
                  fontSize: layout.appliedFontSize || style.fontSize,
                });
              } catch (appearanceErr) {
                console.warn(`[server] Unable to update appearance for ${descriptor.acroName}: ${appearanceErr.message}`);
              }
            } else {
              try {
                textField.setText('');
              } catch (clearErr) {
                // ignore
              }
            }
            if (layout.overflowDetected && layout.overflowText && layout.overflowText.trim().length) {
              overflowTextEntries.push({
                acroName: descriptor.acroName,
                requestName: descriptor.requestName,
                label: descriptor.label || descriptor.acroName,
                text: layout.overflowText,
                fontSize: layout.appliedFontSize || style.fontSize,
              });
            }
          }
        } else if (descriptor.type === 'dropdown') {
          const dropdown = form.getDropdown(descriptor.acroName);
          if (value) dropdown.select(String(value));
        } else if (descriptor.type === 'option-list') {
          const optionList = form.getOptionList(descriptor.acroName);
          if (Array.isArray(rawValue)) {
            optionList.select(...rawValue.map((item) => String(item)));
          } else if (value) {
            optionList.select(String(value));
          }
        }
      } catch (err) {
        console.warn(`[server] Unable to populate field ${descriptor.acroName}: ${err.message}`);
      }
    }

    const imagePlacements = await embedUploadedImages(pdfDoc, form, photoFiles);

    form.flatten();

    if (overflowTextEntries.length) {
      overflowPlacements = appendOverflowPages(pdfDoc, helveticaFont, overflowTextEntries);
    }

    hiddenPartRows = partsRowUsage.filter((row) => !row.hasData).map((row) => row.number);
    partsRowsRendered = partsRowUsage.filter((row) => row.hasData).map((row) => row.number);

    const clearedSignoff = clearOriginalSignoffSection(pdfDoc);
    const signaturePlacements = await drawSignOffPage(
      pdfDoc,
      helveticaFont,
      sanitizedBody,
      signatureImages,
      partsRowUsage,
      { targetPage: clearedSignoff ? clearedSignoff.page : undefined },
    );

    const pages = pdfDoc.getPages();
    if (pages.length) {
      const footerPage = pages[pages.length - 1];
      const submittedAt = new Date().toISOString();
      const submitterName = detectSubmitterName(req.body || {});
      const footerText = `Submitted by ${submitterName} at ${submittedAt}`;
      footerPage.drawText(footerText, {
        x: 36,
        y: 24,
        size: 10,
        font: helveticaFont,
        color: rgb(0.2, 0.2, 0.2),
      });
    }

    const pdfOutput = await pdfDoc.save();

    let customerName = '';
    if (req.body && req.body.end_customer_name) {
      customerName = String(req.body.end_customer_name).trim();
    }
    function cleanForFilename(str) {
      return String(str || '')
        .replace(/[^a-z0-9\-_.]+/gi, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    }
    const customerPart = customerName ? `${cleanForFilename(customerName)}-` : '';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseFilename = `filled-${customerPart}${timestamp}`;
    let filename = `${baseFilename}.pdf`;
    let counter = 1;
    while (fs.existsSync(path.join(OUTPUT_DIR, filename))) {
      filename = `${baseFilename}-${counter}.pdf`;
      counter += 1;
    }
    const outputPath = path.join(OUTPUT_DIR, filename);
    await fs.promises.writeFile(outputPath, pdfOutput);

    const metadata = {
      templatePath,
      createdAt: new Date().toISOString(),
      filename,
      requestBody: sanitizedBody,
      fieldsUsed: fieldDescriptors.map((f) => ({ acroName: f.acroName, requestName: f.requestName, type: f.type })),
      files: photoFiles.map((file) => ({
        originalname: sanitizeFilename(file.originalname),
        mimetype: file.mimetype,
        size: file.size,
        fieldname: file.fieldname,
      })),
      imagePlacements,
      signaturePlacements,
      overflowText: overflowTextEntries.map((entry) => ({
        acroName: entry.acroName,
        requestName: entry.requestName,
        label: entry.label,
        textLength: entry.text.length,
        preview: entry.text.slice(0, 200),
      })),
      overflowPlacements,
      partsRowsUsed: partsRowsRendered,
      partsRowsHidden: hiddenPartRows,
      partsRowsRendered,
    };

    const metadataFilename = filename.replace(/\.pdf$/i, '.json');
    await fs.promises.writeFile(
      path.join(OUTPUT_DIR, metadataFilename),
      JSON.stringify(metadata, null, 2),
      'utf8'
    );

    recordSuggestionsFromSubmission(req.body || {});

    const relativeDownloadPath = `download/${encodeURIComponent(filename)}`;
    const downloadPath = `./${relativeDownloadPath}`;
    const hostUrl = HOST_URL_ENV || `${req.protocol}://${req.get('host')}`;
    const absoluteUrl = `${hostUrl.replace(/\/$/, '')}/${relativeDownloadPath}`;

    return res.json({
      ok: true,
      url: absoluteUrl,
      path: downloadPath,
      overflowCount: overflowTextEntries.length,
      partsRowsHidden: hiddenPartRows,
      partsRowsRendered,
    });
  } catch (err) {
    console.error('[server] Failed to process submission', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/download/:file', async (req, res) => {
  const requested = sanitizeFilename(req.params.file);
  const filePath = path.join(OUTPUT_DIR, requested);

  if (!filePath.startsWith(OUTPUT_DIR)) {
    return res.status(400).json({ ok: false, error: 'Invalid file path.' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: 'File not found.' });
  }

  res.download(filePath, requested);
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (err) {
    console.error('[server] Unhandled error', err);
    return res.status(500).json({ ok: false, error: err.message || 'Unexpected error' });
  }
  return next();
});

function start() {
  const server = app.listen(PORT, () => {
    console.log(`[server] Listening on port ${PORT}`);
    console.log(`[server] Using template: ${templatePath}`);
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start, fieldDescriptors, templatePath };









