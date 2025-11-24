#!/usr/bin/env node

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const cors = require('cors');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const app = express();
app.set('trust proxy', 1);

const ROOT_DIR = __dirname;
const FIELDS_PATH = path.join(ROOT_DIR, 'fields.json');
const MAPPING_PATH = path.join(ROOT_DIR, 'mapping.json');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const OUTPUT_DIR = path.join(ROOT_DIR, 'out');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SUGGESTION_STORE_PATH = path.join(DATA_DIR, 'store.json');
const ADMIN_CREDENTIALS_PATH = path.join(DATA_DIR, 'admin.json');
const ADMIN_LOG_PATH = path.join(DATA_DIR, 'admin.log');
const TEMPLATE_STORAGE_DIR = path.join(PUBLIC_DIR, 'templates');
const TEMPLATE_MANIFEST_PATH = path.join(DATA_DIR, 'templates.json');
const DEFAULT_TEMPLATE_FILENAME = 'form-template1.pdf';
const DEFAULT_TEMPLATE = path.join(PUBLIC_DIR, DEFAULT_TEMPLATE_FILENAME);
const ADMIN_DEFAULT_USERNAME = 'admin';
const ADMIN_DEFAULT_PASSWORD = 'admin';
const DEFAULT_PAGE_WIDTH = 595.28;
const DEFAULT_PAGE_HEIGHT = 841.89;

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST_URL_ENV = process.env.HOST_URL;
const TEMPLATE_PATH_ENV = process.env.TEMPLATE_PATH;
const MAX_FILE_SIZE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_UPLOAD_BYTES = 512 * 1024 * 1024;

fsExtra.ensureDirSync(PUBLIC_DIR);
fsExtra.ensureDirSync(OUTPUT_DIR);
fsExtra.ensureDirSync(DATA_DIR);
fsExtra.ensureDirSync(TEMPLATE_STORAGE_DIR);

function formatBytesHuman(bytes) {
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
  return `${value.toFixed(decimals)} ${units[index]}`;
}

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
let templatePath = null;

function sanitizeRelativePath(relativePath) {
  const normalized = path
    .normalize(String(relativePath || ''))
    .replace(/^[\\/]+/, '')
    .replace(/\0/g, '');
  if (normalized.includes('..')) {
    return normalized
      .split(path.sep)
      .filter((segment) => segment && segment !== '..')
      .join(path.sep);
  }
  return normalized;
}

async function analyzeTemplatePdf(filePath) {
  const fallback = {
    pageWidth: DEFAULT_PAGE_WIDTH,
    pageHeight: DEFAULT_PAGE_HEIGHT,
  };
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return fallback;
    }
    const pdfBytes = await fs.promises.readFile(filePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const firstPage = pdfDoc.getPage(0);
    if (!firstPage) {
      return fallback;
    }
    const { width, height } = firstPage.getSize();
    return {
      pageWidth: width || DEFAULT_PAGE_WIDTH,
      pageHeight: height || DEFAULT_PAGE_HEIGHT,
    };
  } catch (err) {
    console.warn('[server] Failed to analyze template PDF:', err.message);
    return fallback;
  }
}

function defaultBodyTopOffset(pageHeight) {
  const height = Number.isFinite(pageHeight) ? pageHeight : DEFAULT_PAGE_HEIGHT;
  const defaultRatio = 0.22;
  const value = height * defaultRatio;
  return clampNumber(value, 0, Math.max(height - 40, 0));
}

function saveTemplateManifest(manifest) {
  fsExtra.ensureFileSync(TEMPLATE_MANIFEST_PATH);
  fs.writeFileSync(TEMPLATE_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

function ensureBuiltinTemplate(manifest) {
  const builtinId = 'builtin-form-template1';
  let entry = manifest.templates.find((tpl) => tpl.id === builtinId);
  const stats = fs.existsSync(DEFAULT_TEMPLATE) ? fs.statSync(DEFAULT_TEMPLATE) : null;
  let changed = false;
  if (!entry) {
    entry = {
      id: builtinId,
      label: 'Default template',
      relativePath: DEFAULT_TEMPLATE_FILENAME,
      uploadedAt: stats ? stats.mtime.toISOString() : null,
      size: stats ? stats.size : null,
      source: 'builtin',
    };
    manifest.templates.push(entry);
    changed = true;
  } else {
    if (entry.relativePath !== DEFAULT_TEMPLATE_FILENAME) {
      entry.relativePath = DEFAULT_TEMPLATE_FILENAME;
      changed = true;
    }
    if (stats) {
      entry.size = stats.size;
      if (!entry.uploadedAt) {
        entry.uploadedAt = stats.mtime.toISOString();
        changed = true;
      }
    }
  }
  if (!Number.isFinite(entry.pageWidth) || entry.pageWidth <= 0) {
    entry.pageWidth = DEFAULT_PAGE_WIDTH;
    changed = true;
  }
  if (!Number.isFinite(entry.pageHeight) || entry.pageHeight <= 0) {
    entry.pageHeight = DEFAULT_PAGE_HEIGHT;
    changed = true;
  }
  if (!Number.isFinite(entry.bodyTopOffset) || entry.bodyTopOffset < 0) {
    entry.bodyTopOffset = defaultBodyTopOffset(entry.pageHeight);
    changed = true;
  }
  if (!manifest.activeTemplateId) {
    manifest.activeTemplateId = builtinId;
    changed = true;
  }
  return changed;
}

function generateTemplateSlug(label, usedSlugs) {
  const base =
    String(label || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'template';
  let candidate = base;
  let counter = 1;
  while (usedSlugs.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  usedSlugs.add(candidate);
  return candidate;
}

function normalizeTemplateEntries(manifest) {
  const usedSlugs = new Set();
  let changed = false;
  manifest.templates.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    if (!entry.label) {
      entry.label = entry.relativePath ? path.basename(entry.relativePath) : `Template ${index + 1}`;
      changed = true;
    }
    if (!entry.source) {
      entry.source = 'managed';
      changed = true;
    }
    if (!entry.description) {
      entry.description = '';
      changed = true;
    }
    const slug =
      typeof entry.slug === 'string' && entry.slug.trim()
        ? entry.slug.trim().toLowerCase()
        : '';
    if (!slug || usedSlugs.has(slug)) {
      entry.slug = generateTemplateSlug(entry.label, usedSlugs);
      changed = true;
    } else {
      entry.slug = slug;
      usedSlugs.add(slug);
    }
    if (!Number.isFinite(entry.pageWidth) || entry.pageWidth <= 0) {
      entry.pageWidth = DEFAULT_PAGE_WIDTH;
      changed = true;
    }
    if (!Number.isFinite(entry.pageHeight) || entry.pageHeight <= 0) {
      entry.pageHeight = DEFAULT_PAGE_HEIGHT;
      changed = true;
    }
    if (!Number.isFinite(entry.bodyTopOffset) || entry.bodyTopOffset < 0) {
      entry.bodyTopOffset = defaultBodyTopOffset(entry.pageHeight);
      changed = true;
    } else if (entry.bodyTopOffset > entry.pageHeight) {
      entry.bodyTopOffset = entry.pageHeight;
      changed = true;
    }
  });
  return changed;
}

function loadTemplateManifest() {
  let manifest = loadJson(TEMPLATE_MANIFEST_PATH, null);
  if (!manifest || typeof manifest !== 'object') {
    manifest = { activeTemplateId: null, templates: [] };
  }
  if (!Array.isArray(manifest.templates)) {
    manifest.templates = [];
  }
  let dirty = false;
  if (ensureBuiltinTemplate(manifest)) {
    dirty = true;
  }
  if (normalizeTemplateEntries(manifest)) {
    dirty = true;
  }
  if (dirty) {
    saveTemplateManifest(manifest);
  }
  return manifest;
}

function getActiveTemplateEntry(manifest) {
  return manifest.templates.find((tpl) => tpl.id === manifest.activeTemplateId) || null;
}

function resolveManifestTemplatePath(manifest) {
  const entry = getActiveTemplateEntry(manifest);
  if (!entry) return null;
  const safeRelative = sanitizeRelativePath(entry.relativePath || DEFAULT_TEMPLATE_FILENAME);
  const absolute = path.join(PUBLIC_DIR, safeRelative);
  return resolveTemplatePath(absolute);
}

function logAdminEvent(event, payload = {}) {
  const entry = Object.assign(
    {
      at: new Date().toISOString(),
      event,
    },
    payload,
  );
  fs.appendFile(ADMIN_LOG_PATH, JSON.stringify(entry) + '\n', (err) => {
    if (err) {
      console.warn('[server] Failed to write admin log:', err.message);
    }
  });
}

let templateManifest = loadTemplateManifest();

function resolveTemplateFileFromEntry(entry) {
  if (!entry) return null;
  const safeRelative = sanitizeRelativePath(entry.relativePath || DEFAULT_TEMPLATE_FILENAME);
  const absolute = path.join(PUBLIC_DIR, safeRelative);
  return resolveTemplatePath(absolute);
}

function applyActiveTemplateEntry(entry) {
  const resolved = resolveTemplateFileFromEntry(entry);
  if (resolved) {
    templatePath = resolved;
  }
  return resolved;
}

function getTemplateEntryById(templateId) {
  return templateManifest.templates.find((tpl) => tpl.id === templateId) || null;
}

function getTemplateEntryBySlug(slug) {
  if (!slug) return null;
  const normalized = String(slug).toLowerCase();
  return templateManifest.templates.find((tpl) => tpl.slug === normalized) || null;
}

function getTemplateEntryByRef(ref) {
  if (!ref) return null;
  return getTemplateEntryById(ref) || getTemplateEntryBySlug(ref);
}

function refreshTemplatePathFromManifest() {
  const entry = getActiveTemplateEntry(templateManifest);
  return applyActiveTemplateEntry(entry);
}

function setActiveTemplateById(templateId, options = {}) {
  const entry = getTemplateEntryById(templateId);
  if (!entry) {
    throw new Error('Template not found.');
  }
  templateManifest.activeTemplateId = entry.id;
  if (options.persist !== false) {
    saveTemplateManifest(templateManifest);
  }
  const resolved = applyActiveTemplateEntry(entry);
  if (!resolved) {
    throw new Error('Template file missing on disk.');
  }
  return entry;
}

function resolveTemplateEntryForSubmission(ref) {
  if (ref) {
    return getTemplateEntryByRef(ref);
  }
  return getActiveTemplateEntry(templateManifest);
}

function buildTemplatesResponse() {
  return {
    ok: true,
    activeTemplateId: templateManifest.activeTemplateId,
    templates: templateManifest.templates
      .slice()
      .sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0))
      .map((entry) => ({
        id: entry.id,
        slug: entry.slug,
        label: entry.label,
        description: entry.description || '',
        relativePath: entry.relativePath,
        uploadedAt: entry.uploadedAt,
        size: entry.size,
        source: entry.source || 'managed',
        isActive: entry.id === templateManifest.activeTemplateId,
        pageWidth: entry.pageWidth,
        pageHeight: entry.pageHeight,
        bodyTopOffset: entry.bodyTopOffset,
      })),
  };
}

function buildPublicTemplatesResponse() {
  const { templates, activeTemplateId } = buildTemplatesResponse();
  return {
    ok: true,
    activeTemplateId,
    templates: templates.map((entry) => ({
      id: entry.id,
      slug: entry.slug,
      label: entry.label,
      description: entry.description,
      uploadedAt: entry.uploadedAt,
      size: entry.size,
      source: entry.source,
      isActive: entry.isActive,
      previewUrl: `/admin/templates/${encodeURIComponent(entry.id)}/preview`,
      pageWidth: entry.pageWidth,
      pageHeight: entry.pageHeight,
      bodyTopOffset: entry.bodyTopOffset,
    })),
  };
}

function slugifyFilename(name) {
  return String(name || 'template')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'template';
}


function generateSalt(length = 16) {
  return crypto.randomBytes(length).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(String(password || '') + salt).digest('hex');
}

function loadAdminCredentials() {
  if (!fs.existsSync(ADMIN_CREDENTIALS_PATH)) {
    const salt = generateSalt();
    const record = {
      username: ADMIN_DEFAULT_USERNAME,
      passwordHash: hashPassword(ADMIN_DEFAULT_PASSWORD, salt),
      salt,
      updatedAt: new Date().toISOString(),
    };
    fsExtra.ensureFileSync(ADMIN_CREDENTIALS_PATH);
    fs.writeFileSync(ADMIN_CREDENTIALS_PATH, JSON.stringify(record, null, 2), 'utf8');
    console.warn('[server] Admin password reset to default (admin/admin). Change it via the admin panel.');
    return record;
  }
  const record = loadJson(ADMIN_CREDENTIALS_PATH, null);
  if (!record || !record.passwordHash || !record.salt) {
    const salt = generateSalt();
    const restored = {
      username: ADMIN_DEFAULT_USERNAME,
      passwordHash: hashPassword(ADMIN_DEFAULT_PASSWORD, salt),
      salt,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(ADMIN_CREDENTIALS_PATH, JSON.stringify(restored, null, 2), 'utf8');
    console.warn('[server] Admin credentials were invalid and have been reset to admin/admin.');
    return restored;
  }
  return record;
}

function saveAdminCredentials(record) {
  fsExtra.ensureFileSync(ADMIN_CREDENTIALS_PATH);
  fs.writeFileSync(ADMIN_CREDENTIALS_PATH, JSON.stringify(record, null, 2), 'utf8');
}

let adminCredentials = loadAdminCredentials();

function verifyAdminPassword(password) {
  if (!adminCredentials || !adminCredentials.salt) return false;
  const hash = hashPassword(password, adminCredentials.salt);
  return hash === adminCredentials.passwordHash;
}

function updateAdminPassword(newPassword) {
  const salt = generateSalt();
  adminCredentials = {
    username: adminCredentials.username || ADMIN_DEFAULT_USERNAME,
    passwordHash: hashPassword(newPassword, salt),
    salt,
    updatedAt: new Date().toISOString(),
  };
  saveAdminCredentials(adminCredentials);
}

function resolveTemplatePath(candidate) {
  if (!candidate || typeof candidate !== 'string') {
    return null;
  }
  const normalized = candidate.replace(/^file:\/\//i, '').trim();
  const unixified = normalized.replace(/\\/g, '/');
  const absoluteCandidate = path.isAbsolute(unixified)
    ? unixified
    : path.resolve(ROOT_DIR, unixified);
  if (fs.existsSync(absoluteCandidate)) {
    return absoluteCandidate;
  }
  const fallbackInPublic = path.join(PUBLIC_DIR, path.basename(unixified));
  if (fs.existsSync(fallbackInPublic)) {
    console.warn(
      `[server] Template path "${candidate}" not found. Using fallback ${fallbackInPublic}`
    );
    return fallbackInPublic;
  }
  return null;
}

const templateCandidates = [
  TEMPLATE_PATH_ENV,
  fieldsConfig.templatePath,
  resolveManifestTemplatePath(templateManifest),
  DEFAULT_TEMPLATE,
];
for (const candidate of templateCandidates) {
  const resolved = resolveTemplatePath(candidate);
  if (resolved) {
    templatePath = resolved;
    break;
  }
}
if (!templatePath) {
  templatePath = DEFAULT_TEMPLATE;
}

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

const EMPLOYEE_MAX_COUNT = 20;

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
const TABLE_BORDER_WIDTH = 0.8;
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
  const effectiveLineHeightMultiplier = lineHeightMultiplier || 1.2;
  const baselineLineHeight = fontSize * effectiveLineHeightMultiplier;
  const minHeightForMultiline = baselineLineHeight * 1.8;
  const multilineAllowed = multiline && height >= minHeightForMultiline;

  const buildLayout = (candidateSize) => {
    const candidateLineHeight = candidateSize * effectiveLineHeightMultiplier;
    const wrappedLines = wrapTextToWidth(text, font, candidateSize, width);
    const trimmedLines = stripTrailingEmptyLines(wrappedLines);
    const maxLines = Math.max(1, Math.floor(height / Math.max(candidateLineHeight, 1)));
    const multilineActive = multilineAllowed && maxLines >= 2;

    if (!multilineActive) {
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

function parseLocalDateTime(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((item) => Number(item));
  if (
    [year, month, day, hour, minute].some((item) => Number.isNaN(item)) ||
    (second !== undefined && Number.isNaN(second))
  ) {
    return null;
  }
  const date = new Date(year, month - 1, day, hour, minute, second || 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }
  return date;
}

function formatEmployeeDateTime(value) {
  const parsed = parseLocalDateTime(value);
  if (!parsed) {
    return typeof value === 'string' ? value.trim() : '';
  }
  const pad = (input) => String(input).padStart(2, '0');
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ` +
    `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  );
}

function formatIsoFromDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (input) => String(input).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function formatEmployeeDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0m';
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  return parts.length ? parts.join(' ') : '0m';
}

function determineBreakRequirement(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { code: 'UNKNOWN', minutes: 0, label: 'Pending (set arrival and departure)' };
  }
  if (minutes <= 6 * 60) {
    return { code: 'NONE', minutes: 0, label: 'No mandatory break (<=6h)' };
  }
  if (minutes <= 9 * 60) {
    return { code: 'MIN30', minutes: 30, label: '>=30m (6-9h, 2x15m allowed)' };
  }
  return { code: 'MIN45', minutes: 45, label: '>=45m (>9h)' };
}

function formatBreakStatsSummary(breakStats) {
  if (!breakStats || typeof breakStats !== 'object') {
    return '';
  }
  const descriptors = [
    { key: 'MIN45', label: '>=45m (>9h)' },
    { key: 'MIN30', label: '>=30m (6-9h, 2x15m)' },
    { key: 'NONE', label: 'no mandatory break (<=6h)' },
  ];
  const parts = [];
  descriptors.forEach(({ key, label }) => {
    const count = Number(breakStats[key] || 0);
    if (count > 0) {
      parts.push(`${count} x ${label}`);
    }
  });
  const pendingCount = Number(breakStats.UNKNOWN || 0);
  if (pendingCount > 0 && parts.length) {
    parts.push(`${pendingCount} x pending`);
  }
  return parts.join(', ');
}

function collectEmployeeEntries(body) {
  const entries = [];
  const summary = {
    entries,
    totalMinutes: 0,
    totalBreakMinutes: 0,
    breakStats: { NONE: 0, MIN30: 0, MIN45: 0, UNKNOWN: 0 },
  };
  if (!body || typeof body !== 'object') {
    return summary;
  }

  const sources = [];
  const appendSource = (value, indexHint) => {
    if (value === undefined || value === null) return;
    const index = Number.isFinite(Number(indexHint)) ? Number(indexHint) : sources.length;
    sources.push({ index, value });
  };

  if (Array.isArray(body.employees)) {
    body.employees.slice(0, EMPLOYEE_MAX_COUNT).forEach((entry, idx) => appendSource(entry, idx));
  } else if (body.employees && typeof body.employees === 'object') {
    Object.keys(body.employees)
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, EMPLOYEE_MAX_COUNT)
      .forEach((key) => appendSource(body.employees[key], key));
  }

  if (!sources.length) {
    for (let i = 1; i <= EMPLOYEE_MAX_COUNT; i += 1) {
      const stub = {
        name: toSingleValue(body[`employee_name_${i}`]),
        role: toSingleValue(body[`employee_role_${i}`]),
        arrival: toSingleValue(body[`employee_arrival_${i}`]),
        departure: toSingleValue(body[`employee_departure_${i}`]),
      };
      if (
        (stub.name && String(stub.name).trim()) ||
        (stub.role && String(stub.role).trim()) ||
        (stub.arrival && String(stub.arrival).trim()) ||
        (stub.departure && String(stub.departure).trim())
      ) {
        appendSource(stub, i - 1);
      }
    }
  }

  sources
    .sort((a, b) => a.index - b.index)
    .slice(0, EMPLOYEE_MAX_COUNT)
    .forEach(({ index, value }) => {
      const record = value && typeof value === 'object' ? value : { name: value };
      const name = toSingleValue(record.name) ? String(toSingleValue(record.name)).trim() : '';
      const role = toSingleValue(record.role) ? String(toSingleValue(record.role)).trim() : '';
      let arrival = toSingleValue(record.arrival) ? String(toSingleValue(record.arrival)).trim() : '';
      let departure = toSingleValue(record.departure)
        ? String(toSingleValue(record.departure)).trim()
        : '';
      if (!name && !role && !arrival && !departure) {
        return;
      }

      let arrivalDate = parseLocalDateTime(arrival);
      if (!arrivalDate && (name || role || departure)) {
        arrivalDate = new Date();
        arrival = formatIsoFromDate(arrivalDate);
      }

      let departureDate = parseLocalDateTime(departure);
      if (!departureDate && arrivalDate) {
        departureDate = new Date(arrivalDate.getTime() + 60 * 60000);
        departure = formatIsoFromDate(departureDate);
      }

      let durationMinutes = 0;
      if (arrivalDate && departureDate) {
        durationMinutes = Math.round((departureDate.getTime() - arrivalDate.getTime()) / 60000);
        if (durationMinutes <= 0) {
          departureDate = new Date(arrivalDate.getTime() + 15 * 60000);
          departure = formatIsoFromDate(departureDate);
          durationMinutes = 15;
        }
      }

      const breakInfo = determineBreakRequirement(durationMinutes);
      entries.push({
        index: index + 1,
        name,
        role,
        arrival,
        departure,
        arrivalDisplay: formatEmployeeDateTime(arrival),
        departureDisplay: formatEmployeeDateTime(departure),
        durationMinutes,
        durationLabel: formatEmployeeDuration(durationMinutes),
        breakCode: breakInfo.code,
        breakRequiredMinutes: breakInfo.minutes,
        breakLabel: breakInfo.label,
      });

      summary.totalMinutes += durationMinutes;
      summary.totalBreakMinutes += breakInfo.minutes || 0;
      if (summary.breakStats[breakInfo.code] === undefined) {
        summary.breakStats.UNKNOWN += 1;
      } else {
        summary.breakStats[breakInfo.code] += 1;
      }
    });

  return summary;
}

function addPageNumbers(pdfDoc, font, options = {}) {
  if (!pdfDoc || !font) return;
  const pages = pdfDoc.getPages();
  if (!pages.length) return;
  const color = options.color || rgb(0.25, 0.25, 0.3);
  const size = options.fontSize || 10;
  const margin = options.margin || 36;
  const total = pages.length;
  pages.forEach((page, index) => {
    const label = `Page ${index + 1} of ${total}`;
    const width = font.widthOfTextAtSize(label, size);
    page.drawText(label, {
      x: page.getWidth() - margin - width,
      y: margin,
      size,
      font,
      color,
    });
  });
}


function parseLocalDateTime(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] !== undefined ? Number(match[6]) : 0;
  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    Number.isNaN(second)
  ) {
    return null;
  }
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (Number.isNaN(date.getTime())) return null;
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }
  return date;
}

function formatEmployeeDateTime(value) {
  const parsed = parseLocalDateTime(value);
  if (!parsed) {
    return typeof value === 'string' ? value.trim() : '';
  }
  const pad = (input) => String(input).padStart(2, '0');
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ` +
    `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  );
}

function formatIsoFromDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (input) => String(input).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function formatEmployeeDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0m';
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  return parts.length ? parts.join(' ') : '0m';
}

function determineBreakRequirement(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { code: 'UNKNOWN', minutes: 0, label: 'Pending (set arrival & departure)' };
  }
  if (minutes <= 6 * 60) {
    return { code: 'NONE', minutes: 0, label: 'No mandatory break (<=6h)' };
  }
  if (minutes <= 9 * 60) {
    return { code: 'MIN30', minutes: 30, label: '>=30m (6-9h, 2x15m allowed)' };
  }
  return { code: 'MIN45', minutes: 45, label: '>=45m (>9h)' };
}

function formatBreakStatsSummary(breakStats) {
  if (!breakStats || typeof breakStats !== 'object') {
    return '';
  }
  const descriptors = [
    { key: 'MIN45', label: '>=45m (>9h)' },
    { key: 'MIN30', label: '>=30m (6-9h, 2x15m)' },
    { key: 'NONE', label: 'no mandatory break (<=6h)' },
  ];
  const parts = [];
  descriptors.forEach(({ key, label }) => {
    const count = Number(breakStats[key] || 0);
    if (count > 0) {
      parts.push(`${count} x ${label}`);
    }
  });
  const pendingCount = Number(breakStats.UNKNOWN || 0);
  if (pendingCount > 0 && parts.length) {
    parts.push(`${pendingCount} x pending`);
  }
  return parts.join(', ');
}

function collectEmployeeEntries(body) {
  const entries = [];
  const summary = {
    entries,
    totalMinutes: 0,
    totalBreakMinutes: 0,
    breakStats: { NONE: 0, MIN30: 0, MIN45: 0, UNKNOWN: 0 },
  };
  if (!body || typeof body !== 'object') {
    return summary;
  }

  const sources = [];
  const rawEmployees = body.employees;
  const appendSource = (value, indexHint) => {
    if (value === undefined || value === null) return;
    const index = Number.isFinite(Number(indexHint)) ? Number(indexHint) : sources.length;
    sources.push({ index, value });
  };

  if (Array.isArray(rawEmployees)) {
    rawEmployees.slice(0, EMPLOYEE_MAX_COUNT).forEach((item, index) => appendSource(item, index));
  } else if (rawEmployees && typeof rawEmployees === 'object') {
    Object.keys(rawEmployees)
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, EMPLOYEE_MAX_COUNT)
      .forEach((key) => appendSource(rawEmployees[key], key));
  }

  if (!sources.length) {
    for (let i = 1; i <= EMPLOYEE_MAX_COUNT; i += 1) {
      const record = {
        name: toSingleValue(body[`employee_name_${i}`]),
        role: toSingleValue(body[`employee_role_${i}`]),
        arrival: toSingleValue(body[`employee_arrival_${i}`]),
        departure: toSingleValue(body[`employee_departure_${i}`]),
      };
      if (
        (record.name && String(record.name).trim()) ||
        (record.role && String(record.role).trim()) ||
        (record.arrival && String(record.arrival).trim()) ||
        (record.departure && String(record.departure).trim())
      ) {
        appendSource(record, i - 1);
      }
    }
  }

  const ensureFutureDeparture = (arrivalIso, departureIso) => {
    const arrivalDate = parseLocalDateTime(arrivalIso);
    const departureDate = parseLocalDateTime(departureIso);
    if (!arrivalDate) return { arrivalIso, departureIso, minutes: 0 };
    let normalizedArrival = formatIsoFromDate(arrivalDate);
    let normalizedDeparture = departureDate ? formatIsoFromDate(departureDate) : '';
    let minutes = 0;
    if (departureDate) {
      minutes = Math.round((departureDate.getTime() - arrivalDate.getTime()) / 60000);
    }
    if (!departureDate || minutes <= 0) {
      const fallback = new Date(arrivalDate.getTime() + 60 * 60000);
      normalizedDeparture = formatIsoFromDate(fallback);
      minutes = 60;
    }
    return { arrivalIso: normalizedArrival, departureIso: normalizedDeparture, minutes };
  };

  sources
    .sort((a, b) => a.index - b.index)
    .slice(0, EMPLOYEE_MAX_COUNT)
    .forEach(({ index, value }) => {
      const record = value && typeof value === 'object' ? value : { name: value };
      const name = toSingleValue(record.name) ? String(toSingleValue(record.name)).trim() : '';
      const role = toSingleValue(record.role) ? String(toSingleValue(record.role)).trim() : '';
      let arrivalIso = toSingleValue(record.arrival) ? String(toSingleValue(record.arrival)).trim() : '';
      let departureIso = toSingleValue(record.departure)
        ? String(toSingleValue(record.departure)).trim()
        : '';
      if (!arrivalIso && (name || role || departureIso)) {
        arrivalIso = formatIsoFromDate(new Date());
      }
      if (!departureIso && arrivalIso) {
        const arrivalDate = parseLocalDateTime(arrivalIso) || new Date();
        departureIso = formatIsoFromDate(new Date(arrivalDate.getTime() + 60 * 60000));
      }
      if (!name && !role && !arrivalIso && !departureIso) {
        return;
      }
      const normalized = ensureFutureDeparture(arrivalIso, departureIso);
      const breakInfo = determineBreakRequirement(normalized.minutes);
      entries.push({
        index: index + 1,
        name,
        role,
        arrival: normalized.arrivalIso,
        departure: normalized.departureIso,
        arrivalDisplay: formatEmployeeDateTime(normalized.arrivalIso),
        departureDisplay: formatEmployeeDateTime(normalized.departureIso),
        durationMinutes: normalized.minutes,
        durationLabel: formatEmployeeDuration(normalized.minutes),
        breakCode: breakInfo.code,
        breakRequiredMinutes: breakInfo.minutes,
        breakLabel: breakInfo.label,
      });
      summary.totalMinutes += normalized.minutes;
      summary.totalBreakMinutes += breakInfo.minutes || 0;
      if (summary.breakStats[breakInfo.code] === undefined) {
        summary.breakStats.UNKNOWN += 1;
      } else {
        summary.breakStats[breakInfo.code] += 1;
      }
    });

  return summary;
}

function addPageNumbers(pdfDoc, font, options = {}) {
  if (!pdfDoc || !font) return;
  const pages = pdfDoc.getPages();
  if (!pages.length) return;
  const color = options.color || rgb(0.25, 0.25, 0.3);
  const size = options.fontSize || 10;
  const margin = options.margin || 36;
  const total = pages.length;
  pages.forEach((page, index) => {
    const label = `Page ${index + 1} of ${total}`;
    const width = font.widthOfTextAtSize(label, size);
    page.drawText(label, {
      x: page.getWidth() - margin - width,
      y: margin,
      size,
      font,
      color,
    });
  });
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
      borderWidth: TABLE_BORDER_WIDTH,
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
        borderWidth: TABLE_BORDER_WIDTH,
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
  const content = text === undefined || text === null ? '' : String(text);
  const fontSize = options.fontSize || 10;
  const lineHeightMultiplier = options.lineHeightMultiplier || 1.2;
  const paddingX = options.paddingX !== undefined ? options.paddingX : 8;
  const paddingY = options.paddingY !== undefined ? options.paddingY : 8;
  const align = options.align || 'center';
  const verticalAlign = options.verticalAlign || 'middle';
  const color = options.color || rgb(0.12, 0.12, 0.18);

  const availableWidth = Math.max(4, rect.width - paddingX * 2);
  const measurement =
    options.precomputed ||
    layoutMultilineText(content, font, availableWidth, {
      fontSize,
      minFontSize: options.minFontSize || fontSize,
      lineHeightMultiplier,
    });

  const entries = measurement.entries || [];

  if (!entries.length) {
    if (options.drawPlaceholder) {
      page.drawText(' ', {
        x: rect.x + paddingX,
        y: rect.y + rect.height / 2,
        size: fontSize,
        font,
        color,
      });
    }
    return measurement;
  }

  const totalHeight = measurement.totalHeight;
  const usableHeight = Math.max(0, rect.height - paddingY * 2);
  let cursorY;
  if (verticalAlign === 'top') {
    cursorY = rect.y + rect.height - paddingY;
  } else if (verticalAlign === 'bottom') {
    cursorY = rect.y + paddingY + Math.min(totalHeight, usableHeight);
  } else {
    const extraSpace = Math.max(0, usableHeight - totalHeight);
    cursorY = rect.y + rect.height - paddingY - extraSpace / 2;
  }

  entries.forEach((entry) => {
    cursorY -= entry.fontSize;
    const lineWidth = font.widthOfTextAtSize(entry.text, entry.fontSize);
    let textX = rect.x + paddingX;
    if (align === 'center') {
      textX = rect.x + (rect.width - lineWidth) / 2;
    } else if (align === 'right') {
      textX = rect.x + rect.width - paddingX - lineWidth;
    }
    page.drawText(entry.text, {
      x: textX,
      y: cursorY,
      size: entry.fontSize,
      font,
      color,
    });
    cursorY -= entry.lineHeight - entry.fontSize;
  });

  return measurement;
}

function layoutMultilineText(value, font, maxWidth, options = {}) {
  const fontSize = options.fontSize || 10;
  const minFontSize = options.minFontSize || fontSize;
  const lineHeightMultiplier = options.lineHeightMultiplier || 1.2;
  const content = value === undefined || value === null ? '' : String(value);
  const segments = content.split(/\n/);
  const entries = [];
  let totalHeight = 0;

  segments.forEach((segment) => {
    const layout = layoutTextForWidth({
      value: segment,
      font,
      fontSize,
      minFontSize,
      lineHeightMultiplier,
      maxWidth,
    });
    if (!layout || !Array.isArray(layout.lines) || !layout.lines.length) {
      const fallbackHeight = fontSize * lineHeightMultiplier;
      entries.push({ text: '', fontSize, lineHeight: fallbackHeight });
      totalHeight += fallbackHeight;
      return;
    }
    layout.lines.forEach((line) => {
      entries.push({ text: line, fontSize: layout.fontSize, lineHeight: layout.lineHeight });
      totalHeight += layout.lineHeight;
    });
  });

  if (!entries.length) {
    const fallbackHeight = fontSize * lineHeightMultiplier;
    entries.push({ text: '', fontSize, lineHeight: fallbackHeight });
    totalHeight = fallbackHeight;
  }

  return { entries, totalHeight };
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

  const addPageWithHeading = (heading) => {
    const next = pdfDoc.addPage([baseSize.width, baseSize.height]);
    setCurrentPage(next, heading);
    return next;
  };

  const addContinuationPage = (heading = 'Maintenance Summary (cont.)') => {
    return addPageWithHeading(heading);
  };

  const ensureSpace = (requiredHeight, heading) => {
    if (cursorY - requiredHeight < margin) {
      return addContinuationPage(heading);
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

  const employeesData =
    options.employees && Array.isArray(options.employees.entries)
      ? options.employees
      : collectEmployeeEntries(body || {});
  const employeeEntries = Array.isArray(employeesData.entries) ? employeesData.entries : [];
  const employeeTotalMinutes = Number(employeesData.totalMinutes || 0);
  const employeeTotalBreakMinutes = Number(employeesData.totalBreakMinutes || 0);
  const employeeBreakStats = employeesData.breakStats || { NONE: 0, MIN30: 0, MIN45: 0, UNKNOWN: 0 };

  const renderEmployeesSection = () => {
    const columnWidths = [
      tableWidth * 0.05,
      tableWidth * 0.2,
      tableWidth * 0.16,
      tableWidth * 0.16,
      tableWidth * 0.15,
      tableWidth * 0.28,
    ];
    const headerHeight = 18;
    const rowBaseHeight = 34;
    const sectionLabel =
      ensureSpace(headerHeight + rowBaseHeight * Math.max(1, employeeEntries.length) + 24)
        ? 'On-site team (cont.)'
        : 'On-site team';
    drawSectionTitle(sectionLabel);

    if (!employeeEntries.length) {
      page.drawText('No employees were recorded for this visit.', {
        x: margin,
        y: cursorY,
        size: 11,
        font,
        color: textColor,
      });
      cursorY -= 24;
      return;
    }

    const headers = ['#', 'Employee', 'Role', 'Arrival', 'Departure', 'Duration / break'];
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
          borderWidth: TABLE_BORDER_WIDTH,
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

    drawHeaderRow();

    const formatBreakLabelForPdf = (label) => {
      if (!label) return '';
      if (label.includes('6-9h') && label.includes('2x15m')) {
        return label.replace('6-9h, ', '6-9h,\n');
      }
      if (label.includes('>9h') && label.includes('45m')) {
        return label.replace('>9h', '>9h\n');
      }
      if (label.includes('No mandatory break')) {
        return label.replace('No mandatory break', 'No mandatory break\n');
      }
      return label;
    };

    employeeEntries.forEach((entry, index) => {
      const durationLabel = entry.durationLabel || formatEmployeeDuration(entry.durationMinutes);
      const breakLabel = entry.breakLabel || '';
      const durationCell = breakLabel
        ? `${durationLabel}\n${formatBreakLabelForPdf(breakLabel)}`
        : durationLabel;
      const cells = [
        String(index + 1),
        entry.name || '--',
        entry.role || '--',
        entry.arrivalDisplay || entry.arrival || '--',
        entry.departureDisplay || entry.departure || '--',
        durationCell,
      ];
      const measurements = cells.map((value, idx) =>
        layoutMultilineText(value, font, Math.max(4, columnWidths[idx] - 8), {
          fontSize: DEFAULT_TEXT_FIELD_STYLE.fontSize,
          minFontSize: DEFAULT_TEXT_FIELD_STYLE.minFontSize,
          lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,
        }),
      );
      const rowHeight = Math.max(
        rowBaseHeight,
        ...measurements.map((measurement) => Math.ceil(measurement.totalHeight + 18)),
      );
      if (ensureSpace(rowHeight + 8)) {
        drawSectionTitle('On-site team (cont.)');
        drawHeaderRow();
      }
      let cellX = margin;
      measurements.forEach((measurement, idx) => {
        const cellWidth = columnWidths[idx];
        page.drawRectangle({
          x: cellX,
          y: cursorY - rowHeight,
          width: cellWidth,
          height: rowHeight,
          color: rgb(1, 1, 1),
          borderWidth: TABLE_BORDER_WIDTH,
          borderColor: TABLE_BORDER_COLOR,
        });
        drawCenteredTextBlock(
          page,
          cells[idx],
          font,
          { x: cellX, y: cursorY - rowHeight, width: cellWidth, height: rowHeight },
          {
            align: 'center',
            paddingX: 6,
            paddingY: 8,
            color: textColor,
            fontSize: DEFAULT_TEXT_FIELD_STYLE.fontSize,
            minFontSize: DEFAULT_TEXT_FIELD_STYLE.minFontSize,
            lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,
            precomputed: measurement,
          },
        );
        cellX += cellWidth;
      });
      cursorY -= rowHeight;
    });

    cursorY -= 14;
    const durationSummary = employeeEntries.length
      ? formatEmployeeDuration(employeeTotalMinutes)
      : '0m';
    const knownBreakCount =
      (employeeBreakStats.MIN45 || 0) +
      (employeeBreakStats.MIN30 || 0) +
      (employeeBreakStats.NONE || 0);
    const breakMinutesLabel =
      employeeEntries.length === 0
        ? 'pending'
        : knownBreakCount > 0
        ? employeeTotalBreakMinutes
          ? formatEmployeeDuration(employeeTotalBreakMinutes)
          : '0m'
        : employeeBreakStats.UNKNOWN > 0
        ? 'pending'
        : '0m';
    const breakDetails =
      knownBreakCount > 0
        ? formatBreakStatsSummary(employeeBreakStats)
        : employeeBreakStats.UNKNOWN > 0
        ? `${employeeBreakStats.UNKNOWN} pending`
        : '';
    page.drawText(
      `Total recorded time: ${durationSummary} across ${employeeEntries.length} ${
        employeeEntries.length === 1 ? 'employee' : 'employees'
      }.`,
      {
        x: margin,
        y: cursorY,
        size: 10,
        font,
        color: textColor,
      },
    );
    cursorY -= 16;
    page.drawText(
      `Mandated breaks: ${breakMinutesLabel}${breakDetails ? ` (${breakDetails})` : ''}.`,
      {
        x: margin,
        y: cursorY,
        size: 10,
        font,
        color: textColor,
      },
    );
    cursorY -= 26;
  };

  renderEmployeesSection();

  const usedRows = (partsRows || []).filter((row) => row.hasData);
  if (usedRows.length) {
    const columnWidths = [0.32, 0.18, 0.18, 0.18, 0.14].map((ratio) => tableWidth * ratio);
    const headerHeight = 18;
    const rowHeightBase = 32;
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
          borderWidth: TABLE_BORDER_WIDTH,
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
          Math.ceil(layout.lineCount * layout.lineHeight + 16),
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
          borderWidth: TABLE_BORDER_WIDTH,
          borderColor: TABLE_BORDER_COLOR,
        });
        drawCenteredTextBlock(
          page,
          value,
          font,
          { x: cellX, y: cursorY - rowHeight, width: cellWidth, height: rowHeight },
          {
            align: 'center',
            paddingX: 6,
            paddingY: 8,
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
          borderWidth: TABLE_BORDER_WIDTH,
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
        borderWidth: TABLE_BORDER_WIDTH,
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
        borderWidth: TABLE_BORDER_WIDTH,
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
        borderWidth: TABLE_BORDER_WIDTH,
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

  addPageWithHeading('Sign-off details');

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
    ensureSpace(detailHeight * detailRows + 40, 'Sign-off details (cont.)')
      ? 'Sign-off details (cont.)'
      : 'Sign-off details';
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
      borderWidth: TABLE_BORDER_WIDTH,
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
      borderWidth: TABLE_BORDER_WIDTH,
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
    ensureSpace(signatureHeight + 60, 'Signatures (cont.)') ? 'Signatures (cont.)' : 'Signatures';
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
    let actualType = type;
    let resolvedPlaceholder = placeholder || label;
    let extraAttrs = '';
    if (type === 'time') {
      actualType = 'text';
      resolvedPlaceholder = 'HH:MM';
      extraAttrs =
        ' data-input-kind="time" step="60" lang="en-GB" inputmode="numeric" pattern="[0-2][0-9]:[0-5][0-9]" title="Use 24-hour format HH:MM" min="00:00" max="23:59"';
    } else if (type === 'datetime-local') {
      actualType = 'text';
      resolvedPlaceholder = 'YYYY-MM-DD HH:MM';
      extraAttrs =
        ' data-datetime-text step="60" lang="en-GB" inputmode="numeric" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-2][0-9]:[0-5][0-9]" title="Use 24-hour format YYYY-MM-DD HH:MM"';
    }
    return `        <label class="field" for="${id}">
          <span>${escapeHtml(label)}</span>
          <input type="${escapeHtml(actualType)}" id="${id}" name="${escapeHtml(descriptor.requestName)}"${valueAttr} placeholder="${escapeHtml(resolvedPlaceholder)}"${suggestionAttrs}${extraAttrs} />${datalistMarkup}
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
<html lang="en-GB">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Preventative Maintenance Checklist</title>
    <link
      rel="icon"
      type="image/gif"
      href="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
    />
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
        position: relative;
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
      .template-details {
        font-size: 0.9rem;
        color: #475569;
      }
      .template-description {
        margin: 0.35rem 0;
        font-size: 0.95rem;
        color: #1e293b;
        white-space: pre-wrap;
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
      textarea,
      select {
        font: inherit;
        padding: 0.75rem;
        border: 1px solid #d8d8e5;
        border-radius: 10px;
        background: #fafafe;
      }
      select {
        min-height: 48px;
      }
      textarea {
        resize: vertical;
        min-height: 120px;
      }
      input[type="time"],
      input[type="datetime-local"] {
        min-width: 120px;
      }
      input[type="time"]::-webkit-datetime-edit-ampm-field,
      input[type="datetime-local"]::-webkit-datetime-edit-ampm-field {
        display: none;
      }
      input.is-invalid {
        border-color: #dc2626;
        background: #fee2e2;
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
      .employee-card p {
        margin: 0 0 0.35rem 0;
        color: #4c4f63;
      }
      .employee-card small {
        color: #6b7280;
      }
      .employee-actions {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .employee-actions .button {
        background: #2563eb;
        color: #ffffff;
        border: none;
        border-radius: 999px;
        padding: 0.6rem 1.2rem;
        font-weight: 600;
        cursor: pointer;
      }
      .employee-actions .button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .employee-table-wrapper {
        margin-top: 1rem;
        border: 1px solid #c7d2fe;
        border-radius: 16px;
        background: #eef2ff;
        padding: 0.75rem;
        overflow-x: auto;
      }
      .employee-table {
        width: 100%;
        min-width: 640px;
        border-collapse: collapse;
        font-size: 0.9rem;
      }
      .employee-table th,
      .employee-table td {
        border: 1px solid #d9def8;
        padding: 0.55rem 0.65rem;
        vertical-align: top;
        background: #f8f9ff;
      }
      .employee-table thead th {
        background: #dfe6ff;
        color: #1f2a5b;
        font-weight: 600;
        font-size: 0.82rem;
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }
      .employee-table tbody tr:nth-child(even) td {
        background: #fdfdff;
      }
      .employee-index-cell {
        min-width: 95px;
        width: 14%;
      }
      .employee-index-header {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.35rem;
        font-weight: 600;
        color: #1f2a5b;
        margin-bottom: 0.35rem;
      }
      .employee-person-fields {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .employee-person-fields .field,
      .employee-table td .field {
        margin: 0;
      }
      .employee-table td .field > span,
      .field-datetime > span {
        font-size: 0.82rem;
        color: #4b5563;
      }
      .field-datetime {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .field-datetime .datetime-inputs {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .field-datetime .datetime-inputs input {
        padding: 0.55rem;
        border: 1px solid #c7cbef;
        border-radius: 8px;
        background: #ffffff;
        font: inherit;
      }
      .time-input-wrapper {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
        align-items: center;
      }
      .time-input-wrapper input {
        flex: 0 1 120px;
        min-width: 110px;
      }
      .time-shortcut {
        border: 1px solid #c7cbef;
        border-radius: 6px;
        background: #f0f4ff;
        color: #1f2a5b;
        font-size: 0.75rem;
        font-weight: 600;
        padding: 0.4rem 0.7rem;
        min-width: 3rem;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .time-shortcut:hover,
      .time-shortcut:focus-visible {
        background: #e0e7ff;
        border-color: #94a3f2;
        outline: none;
      }
      .time-shortcut:active {
        background: #c7d2fe;
      }
      .time-shortcut:disabled {
        cursor: not-allowed;
        opacity: 0.65;
      }
      .employee-duration {
        font-weight: 600;
        color: #1d4ed8;
        white-space: pre-line;
        font-size: 0.85rem;
      }
      .employee-remove-button {
        border: 1px dashed #c7cbef;
        border-radius: 999px;
        padding: 0.45rem 0.75rem;
        background: #ffffff;
        color: #b91c1c;
        font-weight: 600;
        cursor: pointer;
      }
      .employee-remove-button:hover,
      .employee-remove-button:focus-visible {
        border-color: #ef4444;
        color: #ef4444;
        outline: none;
      }
      .employee-remove-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .employee-summary {
        display: grid;
        gap: 0.4rem;
        font-weight: 600;
        color: #1f2a5b;
      }
      .employee-summary span {
        display: block;
      }
      .employee-summary [data-employee-total] {
        white-space: pre-line;
      }
      @media (min-width: 640px) {
        .employee-summary {
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        }
      }
      @media (max-width: 720px) {
        .employee-table {
          min-width: 560px;
        }
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
      .admin-card {
        margin-top: 1.5rem;
      }
      .admin-card[hidden] {
        display: none !important;
      }
      .admin-card form {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
        align-items: flex-end;
        margin-top: 0.75rem;
      }
      .admin-card input[type="password"] {
        font: inherit;
        border: 1px solid #d8d8e5;
        border-radius: 8px;
        padding: 0.5rem 0.65rem;
        min-width: 220px;
      }
      .admin-errors {
        margin-top: 0.5rem;
        color: #b91c1c;
        font-size: 0.85rem;
      }
      .admin-section__status {
        margin-top: 0.5rem;
        font-size: 0.9rem;
        color: #0f172a;
      }
      .admin-profile {
        font-size: 0.85rem;
        color: #475569;
      }
      .link-button {
        border: none;
        background: none;
        color: #2563eb;
        font-weight: 600;
        cursor: pointer;
        padding: 0;
      }
      .link-button.secondary {
        color: #1e293b;
      }
      .link-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .admin-templates {
        margin-top: 1rem;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        overflow: hidden;
      }
      .admin-templates table {
        width: 100%;
        border-collapse: collapse;
      }
      .admin-templates th,
      .admin-templates td {
        padding: 0.65rem 0.75rem;
        border-bottom: 1px solid #e2e8f0;
        font-size: 0.9rem;
      }
      .admin-templates tr:last-child td {
        border-bottom: none;
      }
      .admin-template__name {
        font-weight: 600;
        display: block;
      }
      .admin-template__meta {
        font-size: 0.8rem;
        color: #475569;
      }
      .admin-template__slug {
        font-size: 0.78rem;
        color: #0f172a;
      }
      .admin-template__desc {
        margin-top: 0.3rem;
        font-size: 0.85rem;
        color: #1e293b;
        white-space: pre-wrap;
      }
      .admin-template__actions {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .admin-preview {
        margin-top: 1rem;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        overflow: hidden;
        min-height: 320px;
        background: #f8fafc;
        display: flex;
        flex-direction: column;
      }
      .admin-preview header {
        padding: 0.65rem 1rem;
        border-bottom: 1px solid #e2e8f0;
        font-weight: 600;
        font-size: 0.9rem;
        background: #fff;
      }
      .admin-preview__frame {
        position: relative;
        flex: 1;
        background: #fff;
        min-height: 320px;
      }
      .admin-preview__frame iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: none;
        background: #fff;
      }
      .admin-preview__overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 2;
      }
      .admin-preview__boundary {
        position: absolute;
        left: 0;
        right: 0;
        height: 2px;
        background: rgba(249, 115, 22, 0.9);
        box-shadow: 0 0 0 1px rgba(249, 115, 22, 0.4);
      }
      .admin-preview__controls {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.75rem;
        padding: 0.75rem 1rem;
        border-top: 1px solid #e2e8f0;
        background: #fff;
      }
      .admin-preview__controls label {
        font-size: 0.85rem;
        color: #475569;
        font-weight: 600;
      }
      .admin-preview__controls input[type="range"] {
        flex: 1 1 220px;
      }
      .admin-preview__controls input[type="number"] {
        width: 110px;
        padding: 0.35rem 0.5rem;
        border: 1px solid #cbd5f5;
        border-radius: 6px;
        font: inherit;
      }
      .admin-preview__empty {
        padding: 1rem;
        font-size: 0.9rem;
        color: #475569;
      }
      .admin-badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 0.15rem 0.65rem;
        font-size: 0.75rem;
        font-weight: 600;
        background: #e0e7ff;
        color: #1e40af;
      }
      .admin-launch {
        position: absolute;
        top: 1rem;
        right: 1rem;
        border: none;
        border-radius: 999px;
        padding: 0.5rem 1rem;
        background: #0f172a;
        color: white;
        font-weight: 600;
        cursor: pointer;
        font-size: 0.9rem;
      }
      .admin-launch:focus-visible {
        outline: 2px solid #2563eb;
        outline-offset: 2px;
      }
      .admin-modal {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
        z-index: 40;
      }
      .admin-modal[hidden] {
        display: none;
      }
      .admin-modal__dialog {
        background: #fff;
        border-radius: 16px;
        padding: 1.5rem;
        max-width: 460px;
        width: 100%;
        position: relative;
        box-shadow: 0 20px 40px rgba(15, 23, 42, 0.35);
      }
      .admin-modal__close {
        position: absolute;
        top: 0.75rem;
        right: 0.75rem;
        background: none;
        border: none;
        font-size: 1.2rem;
        cursor: pointer;
        color: #475569;
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
        <button type="button" class="admin-launch" data-admin-open>Admin</button>
        <h1>Preventative Maintenance Checklist</h1>
        <p>Please review each item and attach up to eight supporting photos. The fields below are pre-filled with example data for quick testing.</p>
      </header>
      <form id="pm-form" enctype="multipart/form-data">
        <section class="card" data-template-selector>
          <h2>Document template</h2>
          <p>Pick the PDF header to merge with this report. Templates define the logo, header text, and footer copy.</p>
          <div class="grid two-col">
            <label class="field" style="max-width:360px">
              <span>Template</span>
              <select name="template_id" data-template-select required>
                <option value="">Loading templates...</option>
              </select>
              <input type="hidden" name="template_slug" data-template-slug />
            </label>
            <div class="template-details" data-template-info>
              <p data-template-status>Loading available templates...</p>
              <p class="template-description" data-template-description hidden></p>
              <a href="#" class="link-button" data-template-preview target="_blank" rel="noopener" hidden>Preview template</a>
            </div>
          </div>
        </section>
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
        <section class="card employee-card" data-employees-section data-employee-max="${EMPLOYEE_MAX_COUNT}">
          <h2>On-site team time sheet</h2>
          <p>Record everyone working on site to keep automatic time & break totals. The first employee becomes the document signer.</p>
          <div class="employee-actions">
            <button type="button" class="button" data-action="employee-add">+ Add employee</button>
            <small>Defaults use the moment you opened this form; fine-tune via manual input or ±30m shortcuts.</small>
          </div>
          <div class="employee-table-wrapper">
            <table class="employee-table">
              <thead>
                <tr>
                  <th scope="col">Employee</th>
                  <th scope="col">Name & role</th>
                  <th scope="col">Arrival</th>
                  <th scope="col">Departure</th>
                </tr>
              </thead>
              <tbody data-employee-list></tbody>
              <tfoot>
                <tr>
                  <td colspan="7">
                    <div class="employee-summary" data-employee-summary>
                      <span data-employee-total>Working time: 0m | Required breaks: pending</span>
                      <span data-employee-count>No employees added yet.</span>
                    </div>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <template id="employee-row-template">
            <tr class="employee-row" data-employee-row>
              <td class="employee-index-cell">
                <div class="employee-index-header">
                  <span data-employee-title>Employee #1</span>
                  <button type="button" class="employee-remove-button" data-action="employee-remove">Remove</button>
                </div>
                <div class="employee-duration" data-employee-duration>Working time: 0m | Break: pending</div>
              </td>
              <td>
                <div class="employee-person-fields">
                  <label class="field" data-field-wrapper="name">
                    <span>Employee name</span>
                    <input type="text" data-field="name" placeholder="Full name" autocomplete="off" />
                  </label>
                  <label class="field" data-field-wrapper="role">
                    <span>Role / position</span>
                    <input type="text" data-field="role" placeholder="Role on site" autocomplete="off" />
                  </label>
                </div>
              </td>
              <td>
                <div class="field field-datetime" data-datetime-field="arrival">
                  <span>Arrival (24h)</span>
                  <div class="datetime-inputs">
                    <input type="date" data-datetime-part="date" />
                    <div class="time-input-wrapper" data-time-input-wrapper>
                      <input
                        type="text"
                        data-datetime-part="time"
                        placeholder="HH:MM"
                        inputmode="numeric"
                        autocomplete="off"
                        pattern="[0-2][0-9]:[0-5][0-9]"
                        title="Use 24-hour format HH:MM"
                      />
                      <button type="button" class="time-shortcut" data-action="time-now" title="Set current time">Now</button>
                      <button type="button" class="time-shortcut" data-action="time-adjust" data-step="-30" title="Subtract 30 minutes">-30m</button>
                      <button type="button" class="time-shortcut" data-action="time-adjust" data-step="30" title="Add 30 minutes">+30m</button>
                    </div>
                  </div>
                  <input type="hidden" data-field="arrival" />
                </div>
              </td>
              <td>
                <div class="field field-datetime" data-datetime-field="departure">
                  <span>Departure (24h)</span>
                  <div class="datetime-inputs">
                    <input type="date" data-datetime-part="date" />
                    <div class="time-input-wrapper" data-time-input-wrapper>
                      <input
                        type="text"
                        data-datetime-part="time"
                        placeholder="HH:MM"
                        inputmode="numeric"
                        autocomplete="off"
                        pattern="[0-2][0-9]:[0-5][0-9]"
                        title="Use 24-hour format HH:MM"
                      />
                      <button type="button" class="time-shortcut" data-action="time-now" title="Set current time">Now</button>
                      <button type="button" class="time-shortcut" data-action="time-adjust" data-step="-30" title="Subtract 30 minutes">-30m</button>
                      <button type="button" class="time-shortcut" data-action="time-adjust" data-step="30" title="Add 30 minutes">+30m</button>
                    </div>
                  </div>
                  <input type="hidden" data-field="departure" />
                </div>
              </td>
            </tr>
          </template>
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
            ${engineerSignatureMarkup}
            ${customerSignatureMarkup}
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
    <section class="admin-modal" data-admin-modal hidden>
      <div class="admin-modal__dialog" data-admin-content>
        <button type="button" class="admin-modal__close" title="Close" data-admin-close>&times;</button>
        <div class="card admin-card" data-admin-section>
          <div data-admin-unauth>
            <h2>Admin tools</h2>
            <p>Log in to manage protected features.</p>
            <form data-admin-login>
              <label class="field" style="flex:1 1 220px">
                <span>Password</span>
                <input type="password" data-admin-password autocomplete="current-password" required />
              </label>
              <button type="submit" class="link-button">Log in</button>
            </form>
            <div class="admin-errors" data-admin-login-error></div>
          </div>
          <div data-admin-auth hidden>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap;">
              <div>
                <h2 style="margin:0;">Admin tools</h2>
                <div class="admin-profile" data-admin-profile></div>
              </div>
              <button type="button" class="link-button secondary" data-admin-logout>Log out</button>
            </div>
            <form data-admin-password-change>
              <label class="field" style="flex:1 1 200px">
                <span>Current password</span>
                <input type="password" autocomplete="current-password" required data-admin-password-current />
              </label>
            <label class="field" style="flex:1 1 200px">
              <span>New password</span>
              <input type="password" autocomplete="new-password" required data-admin-password-new />
            </label>
            <button type="submit" class="link-button">Change password</button>
          </form>
          <form data-admin-upload enctype="multipart/form-data">
            <label class="field" style="flex:1 1 240px">
              <span>Upload document PDF</span>
              <input type="file" name="file" accept="application/pdf" data-admin-upload-input required />
            </label>
            <label class="field" style="flex:1 1 220px">
              <span>Display name</span>
              <input type="text" name="label" placeholder="e.g. Calibration Certificate" data-admin-upload-label />
            </label>
            <label class="field" style="flex:1 1 320px">
              <span>Description / notes (optional)</span>
              <textarea name="description" rows="3" data-admin-upload-description placeholder="Shown in the template picker."></textarea>
            </label>
            <button type="submit" class="link-button">Upload &amp; activate</button>
          </form>
          <div class="admin-templates" data-admin-template-list></div>
          <div class="admin-preview" data-admin-preview hidden>
            <header data-admin-preview-label>Template preview</header>
            <div class="admin-preview__frame" data-admin-preview-frame-wrapper>
              <iframe title="Template preview" data-admin-preview-frame></iframe>
              <div class="admin-preview__overlay" data-template-overlay hidden>
                <div class="admin-preview__boundary" data-template-boundary-line></div>
              </div>
            </div>
            <div class="admin-preview__controls" data-boundary-controls hidden>
              <label for="boundary-range">Content starts after</label>
              <input type="range" id="boundary-range" min="0" max="800" step="5" value="200" data-boundary-range />
              <input type="number" min="0" max="800" step="1" value="200" data-boundary-input /> pt
              <button type="button" class="link-button" data-boundary-save disabled>Save boundary</button>
            </div>
            <div class="admin-preview__empty" data-admin-preview-empty>No template selected.</div>
          </div>
          <div class="admin-section__status" data-admin-status></div>
        </div>
      </div>
    </div>
  </section>
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
        const templateSelectEl = document.querySelector('[data-template-select]');
        const templateSlugInput = document.querySelector('[data-template-slug]');
        const templateInfoEl = document.querySelector('[data-template-info]');
        const templateStatusEl = templateInfoEl ? templateInfoEl.querySelector('[data-template-status]') : null;
        const templateDescriptionEl = templateInfoEl
          ? templateInfoEl.querySelector('[data-template-description]')
          : null;
        const templatePreviewLink = templateInfoEl ? templateInfoEl.querySelector('[data-template-preview]') : null;
        const adminModalEl = document.querySelector('[data-admin-modal]');
        const adminOpenBtn = document.querySelector('[data-admin-open]');
        const adminCloseButtons = adminModalEl
          ? adminModalEl.querySelectorAll('[data-admin-close]')
          : [];
        const adminDialogEl = adminModalEl ? adminModalEl.querySelector('[data-admin-content]') : null;
        const adminSectionEl = adminDialogEl ? adminDialogEl.querySelector('[data-admin-section]') : null;
        const adminUnauthEl = adminSectionEl ? adminSectionEl.querySelector('[data-admin-unauth]') : null;
        const adminAuthEl = adminSectionEl ? adminSectionEl.querySelector('[data-admin-auth]') : null;
        const adminLoginForm = adminSectionEl ? adminSectionEl.querySelector('[data-admin-login]') : null;
        const adminPasswordInput = adminSectionEl ? adminSectionEl.querySelector('[data-admin-password]') : null;
        const adminLoginErrorEl = adminSectionEl ? adminSectionEl.querySelector('[data-admin-login-error]') : null;
        const adminLogoutBtn = adminSectionEl ? adminSectionEl.querySelector('[data-admin-logout]') : null;
        const adminPasswordForm = adminSectionEl ? adminSectionEl.querySelector('[data-admin-password-change]') : null;
        const adminPasswordCurrentInput = adminSectionEl
          ? adminSectionEl.querySelector('[data-admin-password-current]')
          : null;
        const adminPasswordNewInput = adminSectionEl
          ? adminSectionEl.querySelector('[data-admin-password-new]')
          : null;
        const adminUploadForm = adminSectionEl ? adminSectionEl.querySelector('[data-admin-upload]') : null;
        const adminUploadInput = adminSectionEl
          ? adminSectionEl.querySelector('[data-admin-upload-input]')
          : null;
        const adminUploadLabelInput = adminSectionEl
          ? adminSectionEl.querySelector('[data-admin-upload-label]')
