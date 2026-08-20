#!/usr/bin/env node



require('dotenv').config();



const path = require('path');

const fs = require('fs');
const vm = require('vm');

const fsExtra = require('fs-extra');

const crypto = require('crypto');
const zlib = require('zlib');
const archiver = require('archiver');

const express = require('express');

const multer = require('multer');

const helmet = require('helmet');

const cors = require('cors');

const {

  PDFDocument,

  StandardFonts,

  rgb,

  EncryptedPDFError,

  UnexpectedObjectTypeError,

} = require('pdf-lib');



const app = express();

app.set('trust proxy', 1);



const ROOT_DIR = __dirname;

const FIELDS_PATH = path.join(ROOT_DIR, 'fields.json');

const MAPPING_PATH = path.join(ROOT_DIR, 'mapping.json');

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const OUTPUT_DIR = path.join(ROOT_DIR, 'out');

const DATA_DIR = path.join(ROOT_DIR, 'data');

const SUGGESTION_STORE_PATH = path.join(DATA_DIR, 'store.json');

const PROJECTS_STORE_PATH = path.join(DATA_DIR, 'projects.json');

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

const IS_PROD = (process.env.NODE_ENV || '').toLowerCase() === 'production';
const PADDLE_OCR_URL = process.env.PADDLE_OCR_URL || '';
const SIGN_SERVICE_URL = process.env.SIGN_SERVICE_URL || '';
const SIGN_INTERNAL_TOKEN = process.env.SIGN_INTERNAL_TOKEN || '';
const SIGN_SHARED_DIR = process.env.SIGN_SHARED_DIR || path.join(ROOT_DIR, 'sign');
// service2 -> hub internal notify (submit-failure push to admins). Disabled unless both
// are set in the stack env (matching HUB_INTERNAL_TOKEN on the hub).
const HUB_URL = process.env.HUB_URL || 'http://hub:8080';
const HUB_INTERNAL_TOKEN = process.env.HUB_INTERNAL_TOKEN || '';
const SIGN_INBOX_DIR = path.join(SIGN_SHARED_DIR, 'inbox');
const FILE_LIST_DEFAULT_LIMIT = 200;
const FILE_LIST_MAX_LIMIT = 1000;



function loadProjectsStore() {

  try {

    if (!fs.existsSync(PROJECTS_STORE_PATH)) return {};

    const raw = fs.readFileSync(PROJECTS_STORE_PATH, 'utf8');

    const data = JSON.parse(raw);

    return data && typeof data === 'object' ? data : {};

  } catch (err) {

    console.warn('[server] Unable to read projects store:', err.message);

    return {};

  }

}



function saveProjectsStore(store) {

  try {

    fs.writeFileSync(PROJECTS_STORE_PATH, JSON.stringify(store || {}, null, 2));

    return true;

  } catch (err) {

    console.warn('[server] Unable to write projects store:', err.message);

    return false;

  }

}

// --- Idempotent submissions (mobile sync): clientReportId -> stored success response ---

const SUBMISSIONS_STORE_PATH = path.join(DATA_DIR, 'submissions.json');

const SUBMISSION_STORE_MAX_ENTRIES = 2000;

const SUBMISSION_STORE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const inFlightClientReportIds = new Set();

function normalizeClientReportId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function loadSubmissionsStore() {
  try {
    if (!fs.existsSync(SUBMISSIONS_STORE_PATH)) return {};
    const raw = fs.readFileSync(SUBMISSIONS_STORE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    console.warn('[server] Unable to read submissions store:', err.message);
    return {};
  }
}

function saveSubmissionsStore(store) {
  try {
    fs.writeFileSync(SUBMISSIONS_STORE_PATH, JSON.stringify(store || {}, null, 2));
    return true;
  } catch (err) {
    console.warn('[server] Unable to write submissions store:', err.message);
    return false;
  }
}

function pruneSubmissionsStore(store) {
  const now = Date.now();
  const entries = Object.entries(store).filter(([, value]) => {
    const at = value && Number(value.at);
    return Number.isFinite(at) && now - at <= SUBMISSION_STORE_TTL_MS;
  });
  entries.sort((a, b) => Number(b[1].at) - Number(a[1].at));
  return Object.fromEntries(entries.slice(0, SUBMISSION_STORE_MAX_ENTRIES));
}

function findStoredSubmission(clientReportId) {
  const store = loadSubmissionsStore();
  const entry = store[clientReportId];
  if (!entry || !entry.response) return null;
  const at = Number(entry.at);
  if (!Number.isFinite(at) || Date.now() - at > SUBMISSION_STORE_TTL_MS) return null;
  return entry;
}

function rememberSubmission(clientReportId, response) {
  const store = loadSubmissionsStore();
  store[clientReportId] = { at: Date.now(), response };
  saveSubmissionsStore(pruneSubmissionsStore(store));
}



function clampNumber(value, min, max) {

  if (!Number.isFinite(value)) return min;

  if (value < min) return min;

  if (value > max) return max;

  return value;

}

function normalizeQueryText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeQueryLower(value) {
  return normalizeQueryText(value).toLowerCase();
}

function matchesFilter(value, filter) {
  if (!filter) return true;
  if (value === null || value === undefined) return false;
  return String(value).toLowerCase().includes(filter);
}

// Approval workflow (P4): report lifecycle states.
const REPORT_STATUSES = ['submitted', 'in_review', 'approved', 'rejected'];
function normalizeReportStatus(s) {
  return REPORT_STATUSES.includes(s) ? s : 'submitted';
}

// Which signature slots are present on a report, from its meta — a signature counts as
// present if it was drawn (signaturePlacements) or persisted for edit (signatureFiles).
// Blank pads never reach the meta: they're dropped at submit (see isBlankSignatureImage).
const SIGNATURE_SLOTS = { engineer: 'engineer_signature', customer: 'customer_signature' };
function reportSignatureSlots(meta) {
  const names = new Set();
  if (meta && Array.isArray(meta.signaturePlacements)) {
    meta.signaturePlacements.forEach((s) => { if (s && s.acroName) names.add(String(s.acroName)); });
  }
  if (meta && meta.signatureFiles && typeof meta.signatureFiles === 'object') {
    Object.keys(meta.signatureFiles).forEach((k) => names.add(String(k)));
  }
  const has = (acroName) => [...names].some((n) => new RegExp(acroName, 'i').test(n));
  return { engineer: has(SIGNATURE_SLOTS.engineer), customer: has(SIGNATURE_SLOTS.customer) };
}
// Returns 0..2 (engineer_signature, customer_signature).
function countReportSignatures(meta) {
  const slots = reportSignatureSlots(meta);
  return (slots.engineer ? 1 : 0) + (slots.customer ? 1 : 0);
}

// A signature pad that was never drawn on still produces a perfectly valid PNG — fully
// transparent, but a real `data:image/png` all the same. Those used to be persisted and
// counted, so web reports looked signed with visibly empty boxes (iOS issue #1 note 394).
// Detect and drop them at submit. Only uncompressed-friendly PNGs are inspected; anything
// we can't decode (JPEG, interlaced, exotic bit depth) is treated as a real signature.
function isBlankSignatureImage(dataUrl) {
  try {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || '').trim());
    if (!m) return false;
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return false;

    let offset = 8;
    let width = 0; let height = 0; let bitDepth = 0; let colorType = -1; let interlace = 0;
    const idat = [];
    while (offset + 8 <= buf.length) {
      const len = buf.readUInt32BE(offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);
      const dataStart = offset + 8;
      if (dataStart + len > buf.length) break;
      if (type === 'IHDR') {
        width = buf.readUInt32BE(dataStart);
        height = buf.readUInt32BE(dataStart + 4);
        bitDepth = buf[dataStart + 8];
        colorType = buf[dataStart + 9];
        interlace = buf[dataStart + 12];
      } else if (type === 'IDAT') {
        idat.push(buf.subarray(dataStart, dataStart + len));
      } else if (type === 'IEND') break;
      offset = dataStart + len + 4;
    }

    const channelsByColorType = { 0: 1, 2: 3, 4: 2, 6: 4 };
    const channels = channelsByColorType[colorType];
    if (!channels || bitDepth !== 8 || interlace !== 0 || !width || !height || !idat.length) return false;

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return false;

    // Un-filter scanlines in place, then compare every pixel against the first one.
    const prev = Buffer.alloc(stride);
    const cur = Buffer.alloc(stride);
    let first = null;
    const hasAlpha = colorType === 4 || colorType === 6;
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (stride + 1);
      const filter = raw[rowStart];
      raw.copy(cur, 0, rowStart + 1, rowStart + 1 + stride);
      for (let i = 0; i < stride; i += 1) {
        const a = i >= channels ? cur[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        let recon = cur[i];
        if (filter === 1) recon += a;
        else if (filter === 2) recon += b;
        else if (filter === 3) recon += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
          recon += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        } else if (filter !== 0) return false;
        cur[i] = recon & 0xff;
      }
      for (let x = 0; x < width; x += 1) {
        const px = cur.subarray(x * channels, x * channels + channels);
        if (hasAlpha && px[channels - 1] !== 0) {
          // Any non-transparent pixel: fall through to the uniform-colour comparison.
        }
        if (first === null) { first = Buffer.from(px); continue; }
        if (!px.equals(first)) return false;
      }
      cur.copy(prev);
    }
    return true; // every pixel identical → nothing was drawn
  } catch (err) {
    return false; // never reject a signature because we failed to parse it
  }
}

function buildFileListEntry(meta, type, fallbackFilename) {
  if (!meta || typeof meta !== 'object') return null;
  const templateType = normalizeQueryText(meta.templateType) || normalizeQueryText(type);
  const filename = normalizeQueryText(meta.filename) || fallbackFilename || '';
  if (!templateType || !filename) return null;
  const createdAt = normalizeQueryText(meta.createdAt);
  const dailyReport =
    meta.dailyReport && typeof meta.dailyReport === 'object'
      ? {
          projectNumber: normalizeQueryText(meta.dailyReport.projectNumber),
          reportDate: normalizeQueryText(meta.dailyReport.reportDate),
          submitterName: normalizeQueryText(meta.dailyReport.submitterName),
        }
      : null;

  // Key card fields (P6: surfaced in the listing + fuel for ?q= / /api/search).
  const rb = (meta.requestBody && typeof meta.requestBody === 'object') ? meta.requestBody : {};
  const summary = {
    endCustomerName: rb.end_customer_name || null,
    siteLocation: rb.site_location || null,
    projectNumber: resolveProjectNumber(rb) || (dailyReport && dailyReport.projectNumber) || null,
    // Colleagues look for the job by the name they call it, not by a six-digit number.
    projectName: resolveProjectName(rb) || null,
    customerRepresentative: rb.customer_representative || null,
    ledDisplayModel: rb.led_display_model || null,
    // Everything below exists on every report type, not just dailies. The listing and the
    // search used to read the daily block alone, so a service or installation report showed
    // dashes for project/date/submitter and could not be found by the engineer's name.
    reportDate: rb.date_of_service || (dailyReport && dailyReport.reportDate) || null,
    engineerName: rb.engineer_name || null,
    customerName: rb.customer_name || null,
    customerCompany: rb.customer_company || null,
    customerContact: rb.customer_contact || null,
    serviceCompanyName: rb.service_company_name || null,
  };

  // Normalised so the archive can group on it: the apps send 'ios', we send 'web'.
  //
  // Builds before 117 send neither key, and the version people actually have on their
  // phones today is 1.70 - so "no version" is not "unknown", it is information. Two fields
  // give it away: client_report_id and owner_user_id come from the app and from nothing
  // else, so a report carrying them without a version is an older app rather than a
  // browser. Inferred, and labelled as inferred: a guess printed as a fact is worse than
  // an honest blank, and this feeds the question "which build produced this document".
  const sentVia = String(rb.submitted_via || '').trim().toLowerCase() || null;

  const sentVersion = String(rb.client_version || '').trim() || null;

  const looksLikeApp = !!(rb.client_report_id || rb.owner_user_id);

  const submittedVia = sentVia || (looksLikeApp ? 'ios' : null);

  const clientVersion = sentVersion || (looksLikeApp ? '1.70 or older' : null);

  // True when we worked it out rather than being told.
  const clientVersionInferred = !sentVersion && !!clientVersion;

  return {
    templateType,
    templateLabel: normalizeQueryText(meta.templateLabel),
    filename,
    createdAt,
    createdAtMs: createdAt ? Date.parse(createdAt) : 0,
    downloadPath: `download/${encodeURIComponent(templateType)}/${encodeURIComponent(filename)}`,
    status: normalizeReportStatus(meta.status),
    remoteSigned: meta.remoteSigned === true,
    remoteSignedAt: meta.remoteSignedAt || null,
    photoCount: Array.isArray(meta.photoFiles) ? meta.photoFiles.length : 0,
    // Distinct signatures actually present on the report (engineer/customer) → 0, 1 or 2,
    // plus which slot each one is so the apps can name the party still missing.
    signatureCount: countReportSignatures(meta),
    signatures: reportSignatureSlots(meta),
    // Marked as a throwaway test submission; kept until an admin deletes it.
    ...(meta.test === true ? { test: true, testMarkedAt: meta.testMarkedAt || null } : {}),
    submittedBy: (function () {
      const n = String(detectSubmitterName(rb) || '').trim();
      return n && n !== 'Unknown' ? n : ((dailyReport && dailyReport.submitterName) || null);
    })(),
    submittedVia,
    clientVersion,
    ...(clientVersionInferred ? { clientVersionInferred: true } : {}),
    summary,
    dailyReport,
  };
}

async function listOutputTypes() {
  try {
    const entries = await fs.promises.readdir(OUTPUT_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      // Skip dotdirs like .trash so soft-deleted reports never surface in listings.
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    return [];
  }
}

function entryMatchesFilters(entry, filters) {
  if (!entry) return false;
  if (filters.type && entry.templateType.toLowerCase() !== filters.type) return false;
  if (filters.status && (entry.status || 'submitted') !== filters.status) return false;

  const daily = entry.dailyReport || {};
  const s = entry.summary || {};

  // Filter on whichever field the report type actually carries, so "project" and "submitter"
  // work on a service report and not only on a daily.
  if (!matchesFilter(s.projectNumber || daily.projectNumber, filters.project)) return false;
  if (!matchesFilter(s.reportDate || daily.reportDate, filters.reportDate)) return false;
  if (!matchesFilter(entry.submittedBy || daily.submitterName, filters.submitter)) return false;

  if (filters.query) {
    const haystack = [
      entry.filename,
      entry.templateLabel,
      entry.templateType,
      daily.projectNumber,
      daily.reportDate,
      daily.submitterName,
      entry.submittedBy,
      s.endCustomerName,
      s.siteLocation,
      s.projectNumber,
      s.projectName,
      s.reportDate,
      s.customerRepresentative,
      s.ledDisplayModel,
      // Who did the work and who received it: searching for an engineer by name is the
      // most common question asked of this archive and it used to return nothing.
      s.engineerName,
      s.customerName,
      s.customerCompany,
      s.customerContact,
      s.serviceCompanyName,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    // Every word must appear somewhere, so "marcus janker dhl" finds the engineer's DHL
    // visits instead of failing because the words live in different fields.
    const words = String(filters.query).split(/\s+/).filter(Boolean);
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  return true;
}

async function listFileEntries(filters) {
  const types = await listOutputTypes();
  const normalizedTypes = types.map((type) => type.toLowerCase());
  const typeIndex = filters.type ? normalizedTypes.indexOf(filters.type) : -1;
  const selectedType = typeIndex >= 0 ? types[typeIndex] : '';
  const scanTypes = selectedType ? [selectedType] : types;

  const entries = [];
  // Every PDF seen during the scan, filters aside — used below to pair a report with its
  // remote-signed copy even when the copy itself is filtered out of the current view.
  const allFilenames = new Set();
  for (const type of scanTypes) {
    const metaDir = path.join(OUTPUT_DIR, type, 'meta');
    if (!fs.existsSync(metaDir)) {
      continue;
    }
    let files = [];
    try {
      files = await fs.promises.readdir(metaDir);
    } catch (err) {
      continue;
    }
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.json')) continue;
      const metaPath = path.join(metaDir, file);
      let meta;
      try {
        const raw = await fs.promises.readFile(metaPath, 'utf8');
        meta = JSON.parse(raw);
      } catch (err) {
        continue;
      }
      const fallbackFilename = file.replace(/\.json$/i, '.pdf');
      const entry = buildFileListEntry(meta, type, fallbackFilename);
      if (!entry) continue;
      allFilenames.add(type + '/' + entry.filename);
      if (!entryMatchesFilters(entry, filters)) continue;
      entries.push(entry);
    }
  }

  // A remote signature writes a SECOND pdf (<base>_remote-signed.pdf) and leaves the
  // pre-signature original untouched — same timestamp, near-identical name, one row above
  // it in the archive. People download the original and report the signature as missing
  // (it was never in that file). Flag it so the UI can label it and sort it under its
  // signed copy. Computed on read, so existing pairs are covered without a migration.
  for (const entry of entries) {
    const base = String(entry.filename || '').replace(/\.pdf$/i, '');
    if (!base || /_remote-signed$/i.test(base)) continue;
    const signedTwin = base + '_remote-signed.pdf';
    if (allFilenames.has(entry.templateType + '/' + signedTwin)) {
      entry.supersededBy = signedTwin;
    }
  }

  entries.sort((a, b) => {
    const diff = (b.createdAtMs || 0) - (a.createdAtMs || 0);
    if (diff !== 0) return diff;
    // Same submission: the signed copy goes first, so the top row is the document
    // people actually want.
    const aSuperseded = a.supersededBy ? 1 : 0;
    const bSuperseded = b.supersededBy ? 1 : 0;
    if (aSuperseded !== bSuperseded) return aSuperseded - bSuperseded;
    return a.filename.localeCompare(b.filename);
  });

  const limit = filters.limit || FILE_LIST_DEFAULT_LIMIT;
  const offset = Number.isFinite(filters.offset) && filters.offset > 0 ? Math.trunc(filters.offset) : 0;
  return {
    types,
    entries: entries.slice(offset, offset + limit),
    total: entries.length,
    offset,
    limit,
  };
}

const FILE_ZIP_MAX = 1000;

function safeResolvePath(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget === resolvedBase) return resolvedTarget;
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) return null;
  return resolvedTarget;
}

function buildPdfPath(type, filename) {
  const safeType = sanitizeFilename(type);
  const safeFile = sanitizeFilename(filename);
  if (!safeType || !safeFile) return null;
  const baseDir = path.join(OUTPUT_DIR, safeType, 'pdf');
  const candidate = path.join(baseDir, safeFile);
  return safeResolvePath(baseDir, candidate);
}

function buildMetaPath(type, filename) {
  const safeType = sanitizeFilename(type);
  const safeFile = sanitizeFilename(filename);
  if (!safeType || !safeFile) return null;
  const metaDir = path.join(OUTPUT_DIR, safeType, 'meta');
  const baseName = safeFile.replace(/\.pdf$/i, '');
  const candidate = path.join(metaDir, `${baseName}.json`);
  return safeResolvePath(metaDir, candidate);
}

function normalizeFileSelection(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const templateType = sanitizeFilename(entry.templateType || entry.type || '');
  const filename = sanitizeFilename(entry.filename || entry.file || '');
  if (!templateType || !filename) return null;
  return { templateType, filename };
}

function collectFileSelections(body) {
  const list = Array.isArray(body && body.files) ? body.files : [];
  const results = [];
  const seen = new Set();
  list.forEach((item) => {
    const normalized = normalizeFileSelection(item);
    if (!normalized) return;
    const key = `${normalized.templateType}/${normalized.filename}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(normalized);
  });
  return results;
}

// --- Trash / soft-delete (recycle bin with retention) ---------------------------
// Layout: out/.trash/<type>/<base>/{pdf,meta,photos,signatures,daily}/ + trash.json.
// A soft delete MOVES the report's files here (never a destructive unlink); restore
// moves them back; a daily sweep purges entries past retentionDays.
const TRASH_DIR = path.join(OUTPUT_DIR, '.trash');
const TRASH_SETTINGS_PATH = path.join(TRASH_DIR, 'settings.json');
const TRASH_RETENTION_DEFAULT_DAYS = 30;
const TRASH_RETENTION_MIN_DAYS = 1;
const TRASH_RETENTION_MAX_DAYS = 3650;

function reportBaseName(filename) {
  return String(filename || '').replace(/\.pdf$/i, '');
}

function trashFolderFor(type, base) {
  const safeType = sanitizeFilename(type);
  const safeBase = sanitizeFilename(base);
  if (!safeType || !safeBase) return null;
  const baseDir = path.join(TRASH_DIR, safeType);
  return safeResolvePath(baseDir, path.join(baseDir, safeBase));
}

async function getTrashSettings() {
  try {
    const raw = await fs.promises.readFile(TRASH_SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    let days = parseInt(parsed && parsed.retentionDays, 10);
    if (!Number.isFinite(days)) days = TRASH_RETENTION_DEFAULT_DAYS;
    days = Math.max(TRASH_RETENTION_MIN_DAYS, Math.min(TRASH_RETENTION_MAX_DAYS, days));
    return { retentionDays: days };
  } catch (err) {
    return { retentionDays: TRASH_RETENTION_DEFAULT_DAYS };
  }
}

async function setTrashSettings(retentionDays) {
  let days = parseInt(retentionDays, 10);
  if (!Number.isFinite(days)) days = TRASH_RETENTION_DEFAULT_DAYS;
  days = Math.max(TRASH_RETENTION_MIN_DAYS, Math.min(TRASH_RETENTION_MAX_DAYS, days));
  await fsExtra.ensureDir(TRASH_DIR);
  await fs.promises.writeFile(TRASH_SETTINGS_PATH, JSON.stringify({ retentionDays: days }, null, 2));
  return { retentionDays: days };
}

// Move a report and all its sidecars into the trash folder. Returns the trash record
// or null if the report doesn't exist. deletedBy is the acting user (from x-hub-user).
async function trashReport(type, filename, deletedBy) {
  const safeType = sanitizeFilename(type);
  const base = reportBaseName(sanitizeFilename(filename));
  if (!safeType || !base) return null;

  const pdfPath = buildPdfPath(safeType, `${base}.pdf`);
  const metaPath = buildMetaPath(safeType, `${base}.pdf`);
  const pdfExists = pdfPath && fs.existsSync(pdfPath);
  const metaExists = metaPath && fs.existsSync(metaPath);
  if (!pdfExists && !metaExists) return null;

  let meta = {};
  if (metaExists) {
    try { meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')); } catch (e) { meta = {}; }
  }

  const folder = trashFolderFor(safeType, base);
  if (!folder) return null;
  await fsExtra.ensureDir(folder);

  const pdfFilename = pdfExists ? path.basename(pdfPath) : `${base}.pdf`;
  if (pdfExists) {
    await fsExtra.move(pdfPath, path.join(folder, 'pdf', pdfFilename), { overwrite: true });
  }
  if (metaExists) {
    await fsExtra.move(metaPath, path.join(folder, 'meta', `${base}.json`), { overwrite: true });
  }

  // Photos live in out/<type>/photos/<base>/ (whole directory).
  const photosSrc = path.join(OUTPUT_DIR, safeType, 'photos', base);
  if (fs.existsSync(photosSrc)) {
    await fsExtra.move(photosSrc, path.join(folder, 'photos'), { overwrite: true });
  }

  // Signature sidecars are out/<type>/signatures/<base>*.{png,jpg} (incl. *_remote-signed.*).
  const sigDir = path.join(OUTPUT_DIR, safeType, 'signatures');
  const movedSignatures = [];
  if (fs.existsSync(sigDir)) {
    let sigNames = [];
    try { sigNames = await fs.promises.readdir(sigDir); } catch (e) { sigNames = []; }
    for (const name of sigNames) {
      if (name.startsWith(base)) {
        await fsExtra.move(path.join(sigDir, name), path.join(folder, 'signatures', name), { overwrite: true });
        movedSignatures.push(name);
      }
    }
  }

  // Daily reports keep a second copy at meta.dailyReportPath (relative to OUTPUT_DIR).
  let dailyRelPath = null;
  if (meta && meta.dailyReportPath) {
    const dailyAbs = safeResolvePath(OUTPUT_DIR, path.join(OUTPUT_DIR, meta.dailyReportPath));
    if (dailyAbs && fs.existsSync(dailyAbs)) {
      dailyRelPath = path.relative(OUTPUT_DIR, dailyAbs).split(path.sep).join('/');
      await fsExtra.move(dailyAbs, path.join(folder, 'daily', path.basename(dailyAbs)), { overwrite: true });
    }
  }

  const settings = await getTrashSettings();
  const deletedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(deletedAt) + settings.retentionDays * 86400000).toISOString();
  const record = {
    type: safeType,
    filename: pdfFilename,
    base,
    deletedAt,
    deletedBy: deletedBy || null,
    expiresAt,
    retentionDays: settings.retentionDays,
    pdfFilename,
    hasMeta: metaExists,
    signatures: movedSignatures,
    dailyRelPath,
  };
  await fs.promises.writeFile(path.join(folder, 'trash.json'), JSON.stringify(record, null, 2));
  return record;
}

// Move a trashed report back to its live locations. Returns the restored filename or null.
async function restoreReport(type, base) {
  const safeType = sanitizeFilename(type);
  const safeBase = reportBaseName(sanitizeFilename(base));
  const folder = trashFolderFor(safeType, safeBase);
  if (!folder || !fs.existsSync(folder)) return null;

  let record = {};
  try { record = JSON.parse(await fs.promises.readFile(path.join(folder, 'trash.json'), 'utf8')); } catch (e) { record = {}; }
  const pdfFilename = record.pdfFilename || `${safeBase}.pdf`;

  const trashPdf = path.join(folder, 'pdf', pdfFilename);
  if (fs.existsSync(trashPdf)) {
    const dest = buildPdfPath(safeType, pdfFilename);
    if (dest) { await fsExtra.ensureDir(path.dirname(dest)); await fsExtra.move(trashPdf, dest, { overwrite: true }); }
  }
  const trashMeta = path.join(folder, 'meta', `${safeBase}.json`);
  if (fs.existsSync(trashMeta)) {
    const dest = buildMetaPath(safeType, pdfFilename);
    if (dest) { await fsExtra.ensureDir(path.dirname(dest)); await fsExtra.move(trashMeta, dest, { overwrite: true }); }
  }
  const trashPhotos = path.join(folder, 'photos');
  if (fs.existsSync(trashPhotos)) {
    await fsExtra.move(trashPhotos, path.join(OUTPUT_DIR, safeType, 'photos', safeBase), { overwrite: true });
  }
  const trashSigs = path.join(folder, 'signatures');
  if (fs.existsSync(trashSigs)) {
    const destSigDir = path.join(OUTPUT_DIR, safeType, 'signatures');
    await fsExtra.ensureDir(destSigDir);
    for (const name of await fs.promises.readdir(trashSigs)) {
      await fsExtra.move(path.join(trashSigs, name), path.join(destSigDir, name), { overwrite: true });
    }
  }
  if (record.dailyRelPath) {
    const destDaily = safeResolvePath(OUTPUT_DIR, path.join(OUTPUT_DIR, record.dailyRelPath));
    const trashDaily = path.join(folder, 'daily', path.basename(record.dailyRelPath));
    if (destDaily && fs.existsSync(trashDaily)) {
      await fsExtra.ensureDir(path.dirname(destDaily));
      await fsExtra.move(trashDaily, destDaily, { overwrite: true });
    }
  }

  await fsExtra.remove(folder);
  return pdfFilename;
}

async function purgeTrashReport(type, base) {
  const safeType = sanitizeFilename(type);
  const safeBase = reportBaseName(sanitizeFilename(base));
  const folder = trashFolderFor(safeType, safeBase);
  if (!folder || !fs.existsSync(folder)) return false;
  await fsExtra.remove(folder);
  return true;
}

// Build listing cards for every trashed report (reuses buildFileListEntry + trash meta).
async function listTrashEntries() {
  const out = [];
  let typeDirs = [];
  try {
    typeDirs = (await fs.promises.readdir(TRASH_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (e) { return out; }

  for (const type of typeDirs) {
    const typePath = path.join(TRASH_DIR, type);
    let bases = [];
    try {
      bases = (await fs.promises.readdir(typePath, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (e) { continue; }
    for (const base of bases) {
      const folder = path.join(typePath, base);
      let record = {};
      try { record = JSON.parse(await fs.promises.readFile(path.join(folder, 'trash.json'), 'utf8')); } catch (e) { record = {}; }
      let meta = {};
      try { meta = JSON.parse(await fs.promises.readFile(path.join(folder, 'meta', `${base}.json`), 'utf8')); } catch (e) { meta = {}; }
      const card = buildFileListEntry(meta, type, record.filename || `${base}.pdf`) || {
        templateType: type,
        filename: record.filename || `${base}.pdf`,
        templateLabel: null,
        createdAt: null,
        summary: {},
        dailyReport: null,
      };
      out.push({
        ...card,
        deletedAt: record.deletedAt || null,
        deletedBy: record.deletedBy || null,
        expiresAt: record.expiresAt || null,
      });
    }
  }
  out.sort((a, b) => Date.parse(b.deletedAt || 0) - Date.parse(a.deletedAt || 0));
  return out;
}

// One-shot migration: until blank pads were rejected at submit, an untouched signature pad
// was persisted and counted, so reports showed as signed with visibly empty boxes (iOS
// issue #1 note 394). Re-check the persisted signature images once and drop the blank ones
// so signatureCount/signatures tell the truth for reports created before that fix.
// Only slots with a persisted image can be judged; older reports without one are left alone.
async function backfillBlankSignatures() {
  const marker = path.join(DATA_DIR, '.signature-backfill-v1.done');
  if (fs.existsSync(marker)) return;
  let scanned = 0;
  let cleanedReports = 0;
  let clearedSlots = 0;
  try {
    const types = await fs.promises.readdir(OUTPUT_DIR, { withFileTypes: true });
    for (const type of types) {
      if (!type.isDirectory()) continue;
      const metaDir = path.join(OUTPUT_DIR, type.name, 'meta');
      const sigDir = path.join(OUTPUT_DIR, type.name, 'signatures');
      let metaFiles = [];
      try { metaFiles = await fs.promises.readdir(metaDir); } catch (err) { continue; }
      for (const metaFile of metaFiles) {
        if (!metaFile.endsWith('.json')) continue;
        const metaPath = path.join(metaDir, metaFile);
        let meta = null;
        try { meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')); } catch (err) { continue; }
        if (!meta || !meta.signatureFiles || typeof meta.signatureFiles !== 'object') continue;
        scanned += 1;
        const blank = [];
        for (const [acroName, sigFile] of Object.entries(meta.signatureFiles)) {
          try {
            const buf = await fs.promises.readFile(path.join(sigDir, sigFile));
            const mime = /\.png$/i.test(sigFile) ? 'png' : 'jpeg';
            if (isBlankSignatureImage(`data:image/${mime};base64,${buf.toString('base64')}`)) blank.push(acroName);
          } catch (err) { /* image missing — can't judge, leave the slot as-is */ }
        }
        if (!blank.length) continue;
        blank.forEach((name) => { delete meta.signatureFiles[name]; });
        if (Array.isArray(meta.signaturePlacements)) {
          meta.signaturePlacements = meta.signaturePlacements.filter(
            (p) => !(p && blank.some((name) => new RegExp(name, 'i').test(String(p.acroName || '')))),
          );
        }
        if (!Object.keys(meta.signatureFiles).length) delete meta.signatureFiles;
        await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
        cleanedReports += 1;
        clearedSlots += blank.length;
      }
    }
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.writeFile(marker, new Date().toISOString(), 'utf8');
    console.log(`[server] signature backfill: cleared ${clearedSlots} blank signature(s) across ${cleanedReports} report(s) (scanned ${scanned})`);
  } catch (err) {
    console.warn('[server] signature backfill failed:', err && err.message);
  }
}

// Permanently purge trashed reports whose expiresAt has passed. Runs on a daily timer.
async function sweepTrash() {
  const now = Date.now();
  let purged = 0;
  const entries = await listTrashEntries();
  for (const entry of entries) {
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= now) {
      const ok = await purgeTrashReport(entry.templateType, reportBaseName(entry.filename));
      if (ok) purged += 1;
    }
  }
  if (purged) console.log(`[server] trash sweep purged ${purged} expired report(s)`);
  return purged;
}

// --- In-app feedback + diagnostics (bug / idea / submit_failure) ------------------
// Storage: out/.feedback/<id>/{feedback.json, attachments/*, logs.txt, form_archive.json}.
// Intake is any authenticated app user (gated at the hub); management is admin-only.
const FEEDBACK_DIR = path.join(OUTPUT_DIR, '.feedback');
const FEEDBACK_KINDS = new Set(['bug', 'idea', 'submit_failure']);
const FEEDBACK_MAX_MESSAGE = 20000;
const FEEDBACK_MAX_ATTACHMENTS = 10;

function isValidFeedbackId(id) {
  return typeof id === 'string' && /^fb_[a-z0-9]{4,}$/.test(id);
}
function feedbackDirFor(id) {
  if (!isValidFeedbackId(id)) return null;
  return safeResolvePath(FEEDBACK_DIR, path.join(FEEDBACK_DIR, id));
}
function newFeedbackId() {
  return `fb_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}
function safeParseJson(str) {
  if (typeof str !== 'string' || !str.trim()) return null;
  try { return JSON.parse(str); } catch (e) { return null; }
}
function feedbackAttachmentExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/heic') return 'heic';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'application/json') return 'json';
  if (m.startsWith('text/')) return 'txt';
  if (m === 'audio/webm') return 'webm';
  if (m === 'audio/mp4' || m === 'audio/x-m4a' || m === 'audio/m4a') return 'm4a';
  if (m === 'audio/mpeg' || m === 'audio/mp3') return 'mp3';
  if (m === 'audio/ogg' || m === 'audio/oga') return 'ogg';
  if (m === 'audio/wav' || m === 'audio/x-wav' || m === 'audio/wave') return 'wav';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'video/mp4') return 'mp4';
  if (m === 'video/quicktime' || m === 'video/mov') return 'mov';
  if (m === 'video/webm') return 'webm';
  if (m === 'video/x-m4v' || m === 'video/m4v') return 'm4v';
  if (m.startsWith('video/')) return 'video';
  return 'bin';
}

// Build the admin list rows (compact) from every stored feedback.json.
async function listFeedbackRows() {
  let ids = [];
  try {
    ids = (await fs.promises.readdir(FEEDBACK_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (e) { return []; }
  const rows = [];
  for (const id of ids) {
    let rec = null;
    try { rec = JSON.parse(await fs.promises.readFile(path.join(FEEDBACK_DIR, id, 'feedback.json'), 'utf8')); } catch (e) { continue; }
    const ctx = rec.context || {};
    rows.push({
      id: rec.id || id,
      kind: rec.kind || null,
      username: rec.username || ctx.username || null,
      createdAt: rec.createdAt || null,
      message: String(rec.message || '').slice(0, 200),
      device: ctx.deviceModel || null,
      appBuild: ctx.build || ctx.appVersion || null,
      attachmentCount: Array.isArray(rec.attachments) ? rec.attachments.length : 0,
    });
  }
  rows.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  return rows;
}

// Fire-and-forget: tell the hub about a new feedback item so it lands in the admin-only
// chat feed (and, for submit_failure, pushes admins). No-op unless HUB_INTERNAL_TOKEN is
// configured. Never throws into the request path.
async function notifyHubFeedback(record) {
  if (!HUB_INTERNAL_TOKEN) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    await fetch(`${HUB_URL.replace(/\/$/, '')}/internal/notify/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-token': HUB_INTERNAL_TOKEN },
      body: JSON.stringify({
        feedbackId: record.id,
        kind: record.kind,
        username: record.username,
        message: record.message,
        context: record.context || {},
        attachmentCount: Array.isArray(record.attachments) ? record.attachments.length : 0,
        // The hub pulls these back (by feedback id + file) and re-posts them as real chat
        // attachments in Feedback & reports, so admins see photos/voice inline.
        attachments: Array.isArray(record.attachments)
          ? record.attachments.map((a) => ({ file: a.file, mime: a.mime || null, name: a.name || null, size: a.size || 0 }))
          : [],
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  } catch (err) {
    console.warn('[server] feedback hub notify failed:', err && err.message);
  }
}


const PORT = parseInt(process.env.SERVICE2_PORT || process.env.PORT, 10) || 3001;

const HOST_URL_ENV = process.env.HOST_URL;

const TEMPLATE_PATH_ENV = process.env.TEMPLATE_PATH;

const MAX_FILE_SIZE_BYTES = 128 * 1024 * 1024;

const MAX_TOTAL_UPLOAD_BYTES = 512 * 1024 * 1024;

const OCR_CDN_HOST = 'https://cdn.jsdelivr.net';

const OCR_DATA_HOST = 'https://tessdata.projectnaptha.com';

// The one place the web version lives. Bumped by 0.01 on every commit that touches this
// service (see .githooks/pre-commit), so a deployed build always announces a version nobody
// had to remember to change - and the reports it generates are stamped with the same value.
const SERVICE2_VERSION = (() => {
  const FALLBACK = '0.74';
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const value = String(parsed?.version || '').trim();
    return value || FALLBACK;
  } catch (err) {
    // A missing or malformed version file must never stop the service from starting:
    // reports are worth more than an accurate version string.
    console.warn(`[server] Unable to read version.json (${err.message}); using ${FALLBACK}.`);
    return FALLBACK;
  }
})();

// Which client made a report, and which build of it. The web form stamps itself; the apps
// send their own pair. Absence means the report predates provenance, which is itself
// information rather than a gap to paper over.
const SUBMITTED_VIA_WEB = 'web';
const SERVICE2_CLIENT_VERSION = (() => {
  const sha = String(process.env.GIT_SHA || '').trim();
  return sha ? `${SERVICE2_VERSION} (${sha.slice(0, 7)})` : SERVICE2_VERSION;
})();

// LED model catalog (series -> models). Defined early: the web form template uses it.
// The numeric suffix encodes pixel pitch (first two digits = pitch x10) and version (last digit).
const LED_CATALOG = [
  { series: 'Essential', code: 'E', models: ['LD-E121', 'LD-E151', 'LD-E181', 'LD-E251'] },
  { series: 'Mainstream / Enterprise V2', code: 'FE', version: 2, models: ['LD-FE092', 'LD-FE122', 'LD-FE152', 'LD-FE192', 'LD-FE252', 'LD-FE312', 'LD-FE382'] },
  { series: 'Mainstream / Enterprise V3', code: 'FE', version: 3, models: ['LD-FE093', 'LD-FE123', 'LD-FE153', 'LD-FE193'] },
  { series: 'High-End / Advanced V2', code: 'FA', version: 2, models: ['LD-FA092', 'LD-FA122', 'LD-FA152', 'LD-FA192', 'LD-FA252', 'LD-FA312', 'LD-FA382'] },
  { series: 'High-End / Advanced V3', code: 'FA', version: 3, models: ['LD-FA093', 'LD-FA123', 'LD-FA153', 'LD-FA193'] },
  { series: 'COB', code: 'COB', models: ['LD-EC091 & EC019-H', 'LD-EC121 & EC121-H', 'LD-EC151 & EC151-H', 'LD-EC181 & EC181-H', 'LD-D091', 'LD-D121', 'LD-D151'] },
];
function parseLedModel(model) {
  const first = String(model).split('&')[0].trim().replace(/-H$/i, '');
  const m = /(\d{2})(\d)\s*$/.exec(first);
  if (!m) return { pitchMm: null, version: null };
  return { pitchMm: parseInt(m[1], 10) / 10, version: parseInt(m[2], 10) };
}
// Group by the letter designation (LD-E / LD-FE / LD-FA / LD-EC / LD-D), merging
// repeats across series (e.g. LD-FE appears in V2 and V3); second level = the
// numeric designations, deduped and sorted. Picking code+number yields the model.
function ledCodeGroups() {
  const order = [];
  const groups = {};
  for (const s of LED_CATALOG) {
    for (const m of s.models) {
      const first = String(m).split('&')[0].trim();
      const match = /^(LD-[A-Za-z]+)(\d{3})/.exec(first);
      const code = match ? match[1] : first;
      const number = match ? match[2] : '';
      const p = parseLedModel(m);
      if (!groups[code]) { groups[code] = new Map(); order.push(code); }
      if (number && !groups[code].has(number)) {
        groups[code].set(number, {
          number,
          model: m,
          pitchMm: p.pitchMm,
          version: p.version,
          label: `${number}${p.pitchMm != null ? ` - ${p.pitchMm} mm` : ''}${p.version ? ` (V${p.version})` : ''}`,
        });
      }
    }
  }
  return order.map((code) => ({
    code,
    numbers: [...groups[code].values()].sort((a, b) => a.number.localeCompare(b.number)),
  }));
}



fsExtra.ensureDirSync(PUBLIC_DIR);

fsExtra.ensureDirSync(OUTPUT_DIR);

fsExtra.ensureDirSync(DATA_DIR);

fsExtra.ensureDirSync(TEMPLATE_STORAGE_DIR);

fsExtra.ensureFileSync(PROJECTS_STORE_PATH);



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

  const input = String(relativePath || '').replace(/\\/g, '/');

  const normalized = path.posix

    .normalize(input)

    .replace(/^\/+/, '')

    .replace(/\0/g, '');

  if (normalized.includes('..')) {

    return normalized

      .split('/')

      .filter((segment) => segment && segment !== '..')

      .join('/');

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

    const isEncrypted =

      err instanceof EncryptedPDFError ||

      (err && typeof err.message === 'string' && /is encrypted/i.test(err.message || ''));

    if (isEncrypted) {

      const friendly = new Error(

        'Template PDF appears to be password-protected. Remove restrictions and upload an unlocked copy.',

      );

      friendly.statusCode = 400;

      throw friendly;

    }

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

  const resolveFromDirectory = (dirPath, label) => {

    try {

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {

        if (!entry.isFile()) continue;

        const fullPath = path.join(dirPath, entry.name);

        if (isPdfFile(fullPath)) {

          console.warn(`[server] Template path "${label}" is a directory; using ${fullPath}`);

          return fullPath;

        }

      }

    } catch (err) {

      console.warn(`[server] Failed to scan template directory "${label}": ${err.message}`);

    }

    console.warn(`[server] Template path "${label}" is a directory with no PDF files.`);

    return null;

  };

  if (fs.existsSync(absoluteCandidate)) {

    try {

      const stat = fs.statSync(absoluteCandidate);

      if (stat.isDirectory()) {

        return resolveFromDirectory(absoluteCandidate, candidate);

      }

    } catch (err) {

      console.warn(`[server] Failed to stat template path "${candidate}": ${err.message}`);

      return null;

    }

    return absoluteCandidate;

  }

  const fallbackInPublic = path.join(PUBLIC_DIR, path.basename(unixified));

  if (fs.existsSync(fallbackInPublic)) {

    console.warn(

      `[server] Template path "${candidate}" not found. Using fallback ${fallbackInPublic}`

    );

    try {

      const stat = fs.statSync(fallbackInPublic);

      if (stat.isDirectory()) {

        return resolveFromDirectory(fallbackInPublic, fallbackInPublic);

      }

    } catch (err) {

      console.warn(`[server] Failed to stat fallback template path "${fallbackInPublic}": ${err.message}`);

      return null;

    }

    return fallbackInPublic;

  }

  return null;

}

function isPdfFile(filePath) {

  try {

    const fd = fs.openSync(filePath, 'r');

    const buffer = Buffer.alloc(4);

    fs.readSync(fd, buffer, 0, 4, 0);

    fs.closeSync(fd);

    return buffer.toString('utf8') === '%PDF';

  } catch (err) {

    return false;

  }

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

  fontSize: 9.5,

  multiline: false,

  lineHeightMultiplier: 1.2,

  minFontSize: 8.5,

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

  'employee_name',

  'employee_role',

]);

const SUGGESTION_ALIASES = {

  service_company_name: 'company_shared',

  engineer_company: 'company_shared',

  end_customer_name: 'customer_shared',

  customer_company: 'customer_shared',

  employee_name: 'person_shared',

  engineer_name: 'person_shared',

};

const ALLOWED_SUGGESTION_KEYS = new Set([

  ...SUGGESTION_FIELDS,

  ...Object.values(SUGGESTION_ALIASES),

]);

const MIN_SUGGESTION_LENGTH = 1;

const DEFAULT_SUGGESTIONS = {

  customer_shared: ['Mercedes-Benz AG', 'Siemens'],

  company_shared: ['Sharp / NEC LED Solution Center'],

  person_shared: ['Ivan Technician', 'Ulrich Maurer', 'Vladimir'],

  // legacy field-specific seeds (kept for compatibility)

  end_customer_name: ['Mercedes-Benz AG', 'Siemens'],

  site_location: ['Flughafen Berlin Brandenburg', 'Munich Airport'],

  service_company_name: ['Sharp / NEC LED Solution Center'],

  engineer_company: ['Sharp / NEC LED Solution Center'],

  engineer_name: ['Ivan Technician', 'Ulrich Maurer', 'Vladimir'],

  customer_company: ['Mercedes-Benz AG'],

  customer_name: ['Anna Schneider', 'Vladimir'],

  employee_name: ['Ivan Technician', 'Ulrich Maurer', 'Vladimir'],

  employee_role: ['Engineer', 'Service tech'],

};

const MAX_SUGGESTIONS_PER_FIELD = 12;

const INSTALLATION_BLOCK_ONLY = ['installation_report'];



function canonicalSuggestionField(fieldName) {

  const key = typeof fieldName === 'string' ? fieldName.trim() : '';

  if (!key) return '';

  return SUGGESTION_ALIASES[key] || key;

}



function getSeedSuggestions(fieldName) {

  if (!fieldName || !suggestionStore || !suggestionStore.suggestions) {

    return [];

  }

  const canonical = canonicalSuggestionField(fieldName);

  const bucket = suggestionStore.suggestions[canonical];

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



const SERVICE_EQUIPMENT_ROWS = [

  { action: 'Power supply OK', checkbox: 'equip_power_ok', notes: 'equip_power_notes' },

  { action: 'Controllers OK', checkbox: 'equip_controllers_ok', notes: 'equip_controllers_notes' },

  { action: 'Cables OK', checkbox: 'equip_cables_ok', notes: 'equip_cables_notes' },

  { action: 'Fans OK', checkbox: 'equip_fans_ok', notes: 'equip_fans_notes' },

  { action: 'Modules OK', checkbox: 'equip_modules_ok', notes: 'equip_modules_notes' },

  { action: 'Visual inspection OK', checkbox: 'equip_visual_ok', notes: 'equip_visual_notes' },

];



function isInstallation(templateType) {

  return templateType === 'installation_report';

}



function isServiceReport(templateType) {

  return templateType === 'service_report';

}

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

      if (!filtered.length) continue;

      const canonical = canonicalSuggestionField(field);

      const existing = normalized.suggestions[canonical] || [];

      const combined = [...existing, ...filtered];

      const deduped = [];

      const seen = new Set();

      combined.forEach((val) => {

        const lower = val.toLowerCase();

        if (seen.has(lower)) return;

        seen.add(lower);

        deduped.push(val);

      });

      normalized.suggestions[canonical] = deduped.slice(0, MAX_SUGGESTIONS_PER_FIELD);

    }

  }

  // merge defaults so the suggestions are there even before the first submission

  for (const [field, values] of Object.entries(DEFAULT_SUGGESTIONS)) {

    const canonical = canonicalSuggestionField(field);

    const existing = normalized.suggestions[canonical] || [];

    const combined = [...values, ...existing]

      .map((entry) => normalizeSuggestionValue(entry))

      .filter((entry) => entry.length >= MIN_SUGGESTION_LENGTH);

    if (combined.length) {

      const deduped = [];

      const seen = new Set();

      combined.forEach((val) => {

        const lower = val.toLowerCase();

        if (seen.has(lower)) return;

        seen.add(lower);

        deduped.push(val);

      });

      normalized.suggestions[canonical] = deduped.slice(0, MAX_SUGGESTIONS_PER_FIELD);

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

  if (!fieldName) {

    return false;

  }

  const canonical = canonicalSuggestionField(fieldName);

  if (!ALLOWED_SUGGESTION_KEYS.has(canonical)) {

    return false;

  }

  const normalized = normalizeSuggestionValue(value);

  if (normalized.length < MIN_SUGGESTION_LENGTH) {

    return false;

  }

  if (!suggestionStore.suggestions[canonical]) {

    suggestionStore.suggestions[canonical] = [];

  }

  const updateBucket = (bucket) => {

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

  };

  let changed = updateBucket(suggestionStore.suggestions[canonical]);

  // also mirrored under the old field name, so values saved earlier still come back

  if (canonical !== fieldName) {

    if (!suggestionStore.suggestions[fieldName]) {

      suggestionStore.suggestions[fieldName] = [];

    }

    changed = updateBucket(suggestionStore.suggestions[fieldName]) || changed;

  }

  return changed;

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



  // pull staff names and roles out of the employees[n][...] array

  Object.keys(body || {}).forEach((key) => {

    const match = key.match(/^employees\[(\d+)\]\[(name|role)\]$/);

    if (!match) return;

    const [, , field] = match;

    const value = toSingleValue(body[key]);

    const targetField = field === 'name' ? 'employee_name' : 'employee_role';

    if (recordSuggestionValue(targetField, value)) {

      changed = true;

    }

  });



  if (changed) {

    saveSuggestionStore();

  }

  return changed;

}



function getSuggestionsForField(fieldName, query) {

  if (!fieldName) {

    return [];

  }

  const canonical = canonicalSuggestionField(fieldName);

  if (!ALLOWED_SUGGESTION_KEYS.has(canonical)) {

    return [];

  }

  const prefix = normalizeSuggestionValue(query).toLowerCase();

  // D fix: never suggest internal staff (from the people registry) as a customer.
  const isCustomerField = /^customer_(name|representative)$/i.test(canonical) || /^customer_(name|representative)$/i.test(fieldName);

  const primaryBucket = suggestionStore.suggestions[canonical] || [];

  const legacyBucket =

    canonical !== fieldName ? suggestionStore.suggestions[fieldName] || [] : [];

  const combined = [...primaryBucket, ...legacyBucket];

  const filtered =

    prefix.length < MIN_SUGGESTION_LENGTH

      ? combined

      : combined.filter((entry) => entry.toLowerCase().startsWith(prefix));

  // dedupe while preserving order

  const seen = new Set();

  const result = [];

  for (const entry of filtered) {

    const lower = String(entry || '').toLowerCase();

    if (!lower || seen.has(lower)) continue;

    if (isCustomerField && isInternalName(entry)) continue;

    seen.add(lower);

    result.push(entry);

    if (result.length >= MAX_SUGGESTIONS_PER_FIELD) break;

  }

  return result;

}



const PARTS_ROW_COUNT = 15;

// Project numbers are YY-NNNN. Both clients mask the input, but a masked field only decides
// UX — an older build or a scripted POST can still store anything, so the value is normalised
// here as well. Deliberately conservative: only a value that carries exactly six digits is
// reformatted; anything else is stored untouched rather than mangled into a wrong number.
const PROJECT_NUMBER_FIELDS = ['batch_number', 'lsc_project_number', 'daily_project_number'];
function normalizeProjectNumber(value) {
  const raw = String(value === undefined || value === null ? '' : value);
  const digits = raw.replace(/\D+/g, '');
  if (digits.length !== 6) return raw;
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

// ---------------------------------------------------------------------------
// A project has TWO identifiers and they are not interchangeable:
//
//   number  26-0042            lsc_project_number   machine-readable, YY-NNNN
//   name    Siemens Erlangen   lsc_project_name     what people call the job
//
// Those two keys are the contract. Everything else below is a legacy alias kept
// only so reports already in the archive keep rendering, and every one of them
// means the NUMBER — including `project_name`, whose spelling says otherwise.
// That alias is why this block exists: read it by hand in one more place and
// sooner or later the job's name lands in the number row of a signed document.
//
// Nothing outside this file should touch the aliases. Call resolveProjectNumber
// and resolveProjectName; they are the only two functions that know the list.
// ---------------------------------------------------------------------------

// Number aliases, most trusted first. `project_name` is last on purpose.
const PROJECT_NUMBER_ALIASES = [
  'lsc_project_number',
  'batch_number',
  'daily_project_number',
  'project_name', // the app's key for the NUMBER, despite the spelling. Being retired.
];

const PROJECT_NAME_ALIASES = ['lsc_project_name'];

// A project number never contains a space and never has a long run of letters.
// "26-0042" and "LSC-DBG-001" are numbers; "Siemens Erlangen" is a name. Used to
// tell them apart when a value arrives under the ambiguous `project_name` key,
// so a client that flips that key's meaning cannot print a name where a number
// belongs — it self-corrects instead of quietly producing a wrong document.
function looksLikeProjectName(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return false;
  return /\s/.test(text) || /[A-Za-z]{4,}/.test(text);
}

function firstFilled(body, keys) {
  for (const key of keys) {
    const value = String(toSingleValue(body?.[key]) ?? '').trim();
    if (value) return value;
  }
  return '';
}

function resolveProjectNumber(body) {
  for (const key of PROJECT_NUMBER_ALIASES) {
    const value = String(toSingleValue(body?.[key]) ?? '').trim();
    if (!value) continue;
    // The ambiguous alias only counts as a number when it actually looks like one.
    if (key === 'project_name' && looksLikeProjectName(value)) continue;
    return value;
  }
  return '';
}

function resolveProjectName(body) {
  const explicit = firstFilled(body, PROJECT_NAME_ALIASES);
  if (explicit) return explicit;
  // No name was sent, but `project_name` holds something that plainly is one:
  // take it rather than drop it on the floor.
  const ambiguous = String(toSingleValue(body?.project_name) ?? '').trim();
  return looksLikeProjectName(ambiguous) ? ambiguous : '';
}

const PARTS_FIELD_PREFIXES = [

  'parts_type_',

  'parts_removed_desc_',

  'parts_removed_part_',

  // The removed part's serial: printed by the maintenance renderer and sent by the app,
  // but missing here, so a row carrying only that value did not count as a filled row.
  'parts_removed_serial_',

  'parts_used_part_',

  'parts_used_serial_',

];

// What kind of part a row is about. Offered as a dropdown so the common ones are one tap,
// but the control is a free-text input bound to a datalist — an engineer can still type
// something specific that isn't on the list instead of being blocked by it.
// Full names only — the abbreviations were dropped so the document reads the same to
// anyone, including a customer who has never seen the internal shorthand.
const SPARE_PART_TYPES = [
  'Receiver card',
  'Hub board',
  'Pixel card',
  'Power supply',
  'AC Hub',
  'Removal tool',
];



const EMPLOYEE_MAX_COUNT = 20;



const PARTS_TABLE_LAYOUT = {

  pageIndex: 2,

  leftMargin: 40,

  rightMargin: 40,

  topOffset: 150,

  rowHeight: 24,

  headerHeight: 24,

  columnWidths: [190, 120, 120, 130],

};



const TABLE_BORDER_COLOR = rgb(0.1, 0.1, 0.4);

const TABLE_BORDER_WIDTH = 0.8;

const TEXT_FIELD_INNER_PADDING = 2;

const DAILY_REPORT_FIELDS = {

  projectNumber: 'daily_project_number',

  reportDate: 'daily_report_date',

  submitterName: 'submitter_name',

  reportText: 'daily_report_text',

  photos: 'daily_photos',

};

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



// One Site-information block for every document, so a service, maintenance and installation
// report open with the same grid instead of three near-identical variants. Empty fields are
// dropped, so a form that never asks for a phone number simply prints one row fewer.
function buildSiteInfoRows(body, options = {}) {
  // No "Service type" row: the document already says which report this is, so repeating
  // "installation" on an installation report told the reader nothing.
  // dateLabel: an installation runs over days, so its first date is a start date, not the
  // single "date of service" the other two reports describe.
  const dateLabel = options.dateLabel || 'Date of service';
  return [
    { label: 'End customer name', value: toSingleValue(body?.end_customer_name) || '' },
    { label: 'LSC project number', value: resolveProjectNumber(body) },
    { label: 'LSC project name', value: resolveProjectName(body) },
    { label: 'Site location', value: toSingleValue(body?.site_location) || '' },
    { label: dateLabel, value: formatDisplayDate(toSingleValue(body?.date_of_service)) },
    { label: 'LED display model / batch', value: toSingleValue(body?.led_display_model) || '' },
    { label: 'Service company name', value: toSingleValue(body?.service_company_name) || '' },
    // The person who received the work on site, plus how to reach them — the app collects
    // all three and they were previously nowhere on the page.
    { label: 'Contact person', value: toSingleValue(body?.customer_contact) || toSingleValue(body?.customer_representative) || '' },
    { label: 'Phone', value: toSingleValue(body?.customer_phone) || '' },
    { label: 'Email', value: toSingleValue(body?.customer_email) || '' },
  ].filter((row) => row.value && String(row.value).trim());
}

// Spares left with the customer after a maintenance visit — the stock the next crew will
// find on site. Separate from the parts table, which records what was consumed today.
const SPARE_STOCK_PREFIXES = ['spare_stock_type_', 'spare_stock_part_', 'spare_stock_desc_', 'spare_stock_qty_'];
function collectSpareStockRows(body) {
  const rows = [];
  for (let index = 1; index <= PARTS_ROW_COUNT; index += 1) {
    const fields = {};
    let hasData = false;
    SPARE_STOCK_PREFIXES.forEach((prefix) => {
      const raw = body ? toSingleValue(body[`${prefix}${index}`]) : undefined;
      const value = raw === undefined || raw === null ? '' : String(raw).trim();
      if (value) hasData = true;
      fields[prefix] = value;
    });
    if (hasData) {
      rows.push({
        type: fields['spare_stock_type_'],
        part: fields['spare_stock_part_'],
        description: fields['spare_stock_desc_'],
        quantity: fields['spare_stock_qty_'],
      });
    }
  }
  return rows;
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

function normalizeEmployeeToken(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildEmployeeIdentity(entry, fallbackIndex) {
  if (!entry || typeof entry !== 'object') {
    return 'row:' + fallbackIndex;
  }
  const groupId = normalizeEmployeeToken(entry.groupId || entry.group);
  if (groupId) return 'group:' + groupId;
  const nameKey = normalizeEmployeeToken(entry.name);
  const roleKey = normalizeEmployeeToken(entry.role);
  if (nameKey || roleKey) {
    return 'nr:' + nameKey + '|' + roleKey;
  }
  return 'row:' + fallbackIndex;
}

function computeUniqueEmployeeCount(entries) {
  if (!Array.isArray(entries) || !entries.length) return 0;
  const seen = new Set();
  entries.forEach((entry, index) => {
    const fallbackIndex = Number(entry && entry.index) || index + 1;
    const key = buildEmployeeIdentity(entry, fallbackIndex);
    seen.add(key);
  });
  return seen.size;
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

    `${pad(parsed.getDate())}.${pad(parsed.getMonth() + 1)}.${parsed.getFullYear()} ` +

    `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`

  );

}



// Display-only: turn an ISO `yyyy-mm-dd[THH:MM]` into German `dd.mm.yyyy[ HH:MM]`.
// Stored values, filenames and the wire contract stay ISO — this is for drawn/rendered text.
function formatDisplayDate(value) {
  const str = String(value || '').trim();
  if (!str) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(str);
  if (!m) return str;
  const date = `${m[3]}.${m[2]}.${m[1]}`;
  return m[4] ? `${date} ${m[4]}:${m[5]}` : date;
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
    uniqueCount: 0,
    breaksEnabled: false,

  };

  const breaksEnabled = normalizeCheckboxValue(body?.breaks_enabled);
  summary.breaksEnabled = breaksEnabled;

  if (!body || typeof body !== 'object') {

    return summary;

  }



  const sources = [];

  let rawEmployees = body.employees;

  // iOS submits `employees` as a JSON string (multipart); the web form sends
  // employees[n][...] which the urlencoded parser already expands to an array/object.
  if (typeof rawEmployees === 'string' && rawEmployees.trim()) {
    try { rawEmployees = JSON.parse(rawEmployees); } catch (e) { rawEmployees = null; }
  }

  // iOS shape is nested per employee: {name, role, days:[{date, arrival "HH:mm",
  // departure "HH:mm", breakMinutes}]}. Flatten to one source per employee-day (the web's
  // flat shape) tagged with a stable `group` so the day-rows collapse under one employee.
  if (Array.isArray(rawEmployees) && rawEmployees.some((e) => e && Array.isArray(e.days))) {
    const flat = [];
    rawEmployees.forEach((emp, empIdx) => {
      if (!emp || typeof emp !== 'object') return;
      const group = `emp-${empIdx + 1}`;
      const days = Array.isArray(emp.days) ? emp.days : null;
      if (days && days.length) {
        days.forEach((d) => {
          if (!d || typeof d !== 'object') return;
          const date = String(d.date || '').trim();
          const arr = String(d.arrival || '').trim();
          const dep = String(d.departure || '').trim();
          flat.push({
            name: emp.name,
            role: emp.role,
            group,
            arrival: date && arr ? `${date}T${arr}` : arr,
            departure: date && dep ? `${date}T${dep}` : dep,
            breakMinutes: d.breakMinutes,
          });
        });
      } else {
        flat.push({ name: emp.name, role: emp.role, group, arrival: emp.arrival, departure: emp.departure });
      }
    });
    rawEmployees = flat;
  }

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
      const groupId = toSingleValue(record.group) ? String(toSingleValue(record.group)).trim() : '';

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

      const breakInfo = breaksEnabled
        ? determineBreakRequirement(normalized.minutes)
        : { code: 'DISABLED', minutes: 0, label: 'Breaks disabled' };

      // Actual break the engineer recorded (app field). Net worked = gross - actual break,
      // matching the app's own "Worked" math (departure - arrival - breakMinutes).
      const parsedBreak = parseInt(toSingleValue(record.breakMinutes), 10);
      const actualBreakMinutes = Number.isFinite(parsedBreak) && parsedBreak >= 0 ? parsedBreak : null;
      const workedMinutes = Math.max(0, normalized.minutes - (actualBreakMinutes || 0));

      entries.push({

        index: index + 1,

        name,

        role,

        groupId,

        arrival: normalized.arrivalIso,

        departure: normalized.departureIso,

        arrivalDisplay: formatEmployeeDateTime(normalized.arrivalIso),

        departureDisplay: formatEmployeeDateTime(normalized.departureIso),

        durationMinutes: normalized.minutes,

        durationLabel: formatEmployeeDuration(normalized.minutes),

        breakMinutes: actualBreakMinutes,

        workedMinutes,

        breakCode: breakInfo.code,

        breakRequiredMinutes: breakInfo.minutes,

        breakLabel: breakInfo.label,

      });

      summary.totalMinutes += normalized.minutes;

      if (breaksEnabled) {

        summary.totalBreakMinutes += breakInfo.minutes || 0;

        if (summary.breakStats[breakInfo.code] === undefined) {

          summary.breakStats.UNKNOWN += 1;

        } else {

          summary.breakStats[breakInfo.code] += 1;

        }

      }

    });


  summary.uniqueCount = computeUniqueEmployeeCount(entries);

  return summary;

}



function addPageNumbers(pdfDoc, font, options = {}) {

  if (!pdfDoc || !font) return;

  const pages = pdfDoc.getPages();

  if (!pages.length) return;

  const color = options.color || rgb(0.25, 0.25, 0.3);

  const size = options.fontSize || 9;

  const xMargin = options.margin || 18;

  const footerY = options.footerY || 10;

  const total = pages.length;

  pages.forEach((page, index) => {

    const label = `Page ${index + 1} of ${total}`;

    const width = font.widthOfTextAtSize(label, size);

    page.drawText(label, {

      x: page.getWidth() - xMargin - width,

      y: footerY,

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



  const columnWidths = layout.columnWidths || [190, 120, 120, 130];

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

    'Part batch (description)',

    'Part number',

    'Part used in display',

    'Serial number',

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

    drawCenteredTextBlock(

      page,

      label,

      font,

      { x: cursorX, y: originY - headerHeight, width, height: headerHeight },

      {

        align: 'center',

        paddingX: 4,

        paddingY: 2,

        color: rgb(0.1, 0.1, 0.3),

        fontSize: 10,

        minFontSize: 8,

        lineHeightMultiplier: 1.2,

      },

    );

    cursorX += width;

  });



  let currentY = originY - headerHeight;

  usedRows.forEach((row) => {

    const cellValues = [

      row.fields[`parts_removed_desc_${row.number}`] || '',

      row.fields[`parts_removed_part_${row.number}`] || '',

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

    cursorY -= 12;

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



function clearOriginalSignoffSection(pdfDoc, options = {}) {

  if (!pdfDoc || typeof pdfDoc.getPages !== 'function') return null;

  const pages = pdfDoc.getPages();

  const targetPage = pages[0];

  if (!targetPage) return null;



  const pageHeight = targetPage.getHeight();

  const bodyTopOffset = Number.isFinite(options.bodyTopOffset)

    ? options.bodyTopOffset

    : defaultBodyTopOffset(pageHeight);

  // Start of the render, just below the content line (bodyTopOffset), so it lines up with the line shown in the admin page.

  const marginTop = 12;

  const startY = Math.max(marginTop + 8, pageHeight - bodyTopOffset - 6);



  // Clear the body under the header, leaving the top strip (logo / letterhead) untouched.

  targetPage.drawRectangle({

    x: 0,

    y: 0,

    width: targetPage.getWidth(),

    height: startY,

    color: rgb(1, 1, 1),

    borderWidth: 0,

  });



  return { page: targetPage, index: 0, startY };

}



async function drawInstallationReport(pdfDoc, font, body, signatureImages, partsRows, options = {}) {

  const pagesList = pdfDoc.getPages();

  const baseSize = pagesList.length ? pagesList[0].getSize() : { width: 595.28, height: 841.89 };

  const margin = 18;

  const headingColor = rgb(0.08, 0.2, 0.4);

  const textColor = rgb(0.1, 0.1, 0.16);

  const headingTitle = 'Installation report';

  const PAGE_TOP_PADDING = 32;

  const SECTION_TITLE_SIZE = 12;

  const SECTION_TITLE_HEIGHT = SECTION_TITLE_SIZE + 4;

  const SECTION_TITLE_GAP = 6;

  // Air above a heading. The title is drawn on its baseline, so with nothing here the
  // letters ride on the border of the block above and the descenders cut through it.
  const SECTION_TITLE_TOP_GAP = 24;

  const LABEL_FONT_SIZE = 10;

  const FIELD_GAP = 10;
  const BLOCK_HEADER_HEIGHT = 18;
  const BLOCK_HEADER_FONT_SIZE = 8.5;
  const BLOCK_VALUE_MIN_HEIGHT = 34;
  const BLOCK_VALUE_FONT_SIZE = 10.5;
  const BLOCK_COL_GAP = 10;
  // Zero: the maintenance grid stacks its rows with shared borders, and a gap here made
  // the same block read as a looser, different table.
  const BLOCK_ROW_GAP = 0;

  const initialStartY =

    options.startY && Number.isFinite(options.startY)

      ? Math.max(options.startY - 6, margin + PAGE_TOP_PADDING)

      : null;

  const pageStartY = (baseY) => Math.max(margin + PAGE_TOP_PADDING, baseY - PAGE_TOP_PADDING);



  const initialPage =

    options.targetPage && pagesList.includes(options.targetPage)

      ? options.targetPage

      : pdfDoc.addPage([baseSize.width, baseSize.height]);

  let page = initialPage;

  let cursorY =

    initialStartY !== null ? pageStartY(initialStartY) : pageStartY(page.getHeight() - margin);

  const signaturePlacements = [];



  // A heading that opens a page already sits below the page title and needs no extra
  // leading; one that follows a block does.
  let atPageTop = true;

  let currentSection = '';

  const setCurrentPage = (target, heading = headingTitle) => {

    atPageTop = true;

    page = target;

    cursorY =

      initialStartY !== null && target === initialPage ? pageStartY(initialStartY) : pageStartY(page.getHeight() - margin);

    const textWidth = font.widthOfTextAtSize(heading, 18);

    const centeredX = (page.getWidth() - textWidth) / 2;

    page.drawText(heading, {

      x: centeredX,

      y: cursorY,

      size: 18,

      font,

      color: headingColor,

    });

    cursorY -= 26;

  };



  const addPageWithHeading = (heading = headingTitle) => {

    const next = pdfDoc.addPage([baseSize.width, baseSize.height]);

    setCurrentPage(next, heading);

    return next;

  };



  const ensureSpace = (requiredHeight, heading) => {

    if (cursorY - requiredHeight < margin) {

      addPageWithHeading(heading || headingTitle);

      return true;

    }

    return false;

  };



  const drawSectionTitle = (label) => {

    ensureSpace(SECTION_TITLE_TOP_GAP + SECTION_TITLE_HEIGHT + SECTION_TITLE_GAP);

    if (!atPageTop) cursorY -= SECTION_TITLE_TOP_GAP;

    atPageTop = false;

    // Strip the marker so a section continued twice does not become "(continued) (continued)".
    currentSection = String(label || '').replace(/ \(continued\)$/, '');

    page.drawText(label, {

      x: margin,

      y: cursorY,

      size: SECTION_TITLE_SIZE,

      font,

      color: headingColor,

    });

    cursorY -= SECTION_TITLE_HEIGHT + SECTION_TITLE_GAP;

  };

  // A section whose rows spill onto the next page announces itself again there. The page
  // keeps the report's own name; this is the section saying "still me".
  const resumeSection = () => {

    if (currentSection) drawSectionTitle(`${currentSection} (continued)`);

  };



  const normalizeBlockField = (field) => {
    if (!field || !field.label) return null;
    const text = toSingleValue(field.value);
    const hasText = text !== undefined && text !== null && String(text).trim() !== '';
    // This document is generated entirely by us — we mirror the original's set of blocks,
    // not its layout — so a block only exists when it has something to say. Empty fields
    // are dropped; pass allowEmpty: true for a box that must appear even when blank
    // (e.g. something meant to be filled in by hand on the printed sheet).
    if (!hasText && field.allowEmpty !== true) return null;
    return { ...field, text: text ?? '' };
  };

  // halfWidth keeps a lone field in the left column instead of stretching it across the
  // page: an odd number of rows in a two-column grid otherwise ends with one value (an
  // email address, say) running the full width and looking like a different kind of field.
  const drawBlockRow = (fields, { fullWidth = false, halfWidth = false } = {}) => {
    const normalized = (fields || []).map(normalizeBlockField).filter(Boolean);
    if (!normalized.length) return;
    const columns = !fullWidth && (halfWidth || normalized.length > 1) ? 2 : 1;
    const colGap = columns === 1 ? 0 : BLOCK_COL_GAP;
    const columnWidth =
      columns === 1 ? page.getWidth() - margin * 2 : (page.getWidth() - margin * 2 - colGap) / 2;
    const maxDataHeight = Math.max(
      BLOCK_VALUE_MIN_HEIGHT,
      ...normalized.map((field) => {
        const paddingY = field.paddingY ?? 10;
        const text = String(field.text ?? '');
        // An empty box keeps the minimum height; measuring nothing yields nothing useful.
        let needed = 0;
        if (text.trim()) {
          // The same function the drawing path uses, so the measured height and the drawn
          // height cannot disagree - measuring with a different one is how the address box
          // stayed 34pt tall while two lines were painted into it.
          const layout = layoutMultilineText(text, font, columnWidth - 16, {
            fontSize: BLOCK_VALUE_FONT_SIZE,
            minFontSize: 9,
            lineHeightMultiplier: 1.15,
          });
          const total = Number(layout && layout.totalHeight);
          if (Number.isFinite(total)) needed = Math.ceil(total + paddingY * 2);
        }
        const explicit = Number(field.height);
        return Math.max(
          BLOCK_VALUE_MIN_HEIGHT,
          needed,
          Number.isFinite(explicit) ? explicit : 0,
        );
      }),
    );
    const rowHeight = BLOCK_HEADER_HEIGHT + maxDataHeight;
    if (ensureSpace(rowHeight + BLOCK_ROW_GAP)) resumeSection();
    atPageTop = false;
    normalized.forEach((field, index) => {
      const x = margin + index * (columnWidth + colGap);
      const headerY = cursorY - BLOCK_HEADER_HEIGHT;
      const dataY = headerY - maxDataHeight;
      page.drawRectangle({
        x,
        y: headerY,
        width: columnWidth,
        height: BLOCK_HEADER_HEIGHT,
        borderWidth: TABLE_BORDER_WIDTH,
        borderColor: TABLE_BORDER_COLOR,
        color: rgb(0.92, 0.95, 0.99),
      });
      // Centred, as on the other two reports.
      const labelWidth = font.widthOfTextAtSize(field.label, BLOCK_HEADER_FONT_SIZE);

      page.drawText(field.label, {
        x: x + Math.max(6, (columnWidth - labelWidth) / 2),
        y: headerY + BLOCK_HEADER_HEIGHT - BLOCK_HEADER_FONT_SIZE,
        size: BLOCK_HEADER_FONT_SIZE,
        font,
        color: headingColor,
      });
      page.drawRectangle({
        x,
        y: dataY,
        width: columnWidth,
        height: maxDataHeight,
        borderWidth: TABLE_BORDER_WIDTH,
        borderColor: TABLE_BORDER_COLOR,
        color: rgb(1, 1, 1),
      });
      drawCenteredTextBlock(page, String(field.text ?? ''), font, { x, y: dataY, width: columnWidth, height: maxDataHeight }, {
        align: field.align || 'center',
        verticalAlign: field.verticalAlign || 'middle',
        paddingX: 8,
        paddingY: field.paddingY ?? 10,
        color: textColor,
        fontSize: BLOCK_VALUE_FONT_SIZE,
        minFontSize: 9,
        lineHeightMultiplier: 1.15,
      });
    });
    cursorY -= rowHeight + BLOCK_ROW_GAP;
  };



  const drawCheckboxList = (items, title) => {

    const visible = items.filter((item) => item && item.label);

    if (!visible.length) return;

    const rowHeight = 20;

    const titleHeight = title ? SECTION_TITLE_HEIGHT + SECTION_TITLE_GAP : 0;

    const totalHeight = visible.length * rowHeight + titleHeight + FIELD_GAP;

    ensureSpace(totalHeight);

    if (title) {

      drawSectionTitle(title);

    }

    visible.forEach((item) => {

      page.drawRectangle({

        x: margin,

        y: cursorY - rowHeight + 4,

        width: 12,

        height: 12,

        borderWidth: 1,

        borderColor: TABLE_BORDER_COLOR,

        color: item.value ? rgb(0.15, 0.4, 0.8) : rgb(1, 1, 1),

      });

      if (item.value) {

        // Drawn as two strokes rather than a glyph: this used to be a '✓' literal that a
        // re-encoding of this file mangled into 'Ã¢Å“â€œ', which is what actually printed
        // on the acceptance certificate. A tick can't be written with the standard font
        // anyway — WinAnsi has no U+2713 — so vectors keep it correct whatever the font.
        const boxX = margin;
        const boxY = cursorY - rowHeight + 4;
        page.drawLine({
          start: { x: boxX + 2.5, y: boxY + 6 },
          end: { x: boxX + 4.8, y: boxY + 3.2 },
          thickness: 1.6,
          color: rgb(1, 1, 1),
        });
        page.drawLine({
          start: { x: boxX + 4.8, y: boxY + 3.2 },
          end: { x: boxX + 9.5, y: boxY + 9 },
          thickness: 1.6,
          color: rgb(1, 1, 1),
        });

      }

      const labelRect = {

        x: margin + 18,

        y: cursorY - rowHeight + 2,

        width: page.getWidth() - margin * 2 - 18,

        height: rowHeight,

      };

      drawCenteredTextBlock(page, item.label, font, labelRect, {

        align: 'left',

        paddingX: 4,

        paddingY: 4,

        color: textColor,

        fontSize: LABEL_FONT_SIZE,

        minFontSize: 9,

      });

      cursorY -= rowHeight;

    });

    cursorY -= FIELD_GAP;

  };



  const boolVal = (key) => normalizeCheckboxValue(body?.[key]);

  const val = (key) => toSingleValue(body?.[key]) || '';

  // Date fields arrive ISO from type="date" inputs; non-ISO values ('unknown') pass through.
  const dateVal = (key) => formatDisplayDate(val(key));

  // Recent app builds stopped sending engineer_name, which left the supplier side of this
  // certificate unnamed - a signature with nobody's name beside it. The submitter is not a
  // guess: it is who filled the report in, and we already print it in the footer.
  const submittedByName = (() => {
    const detected = detectSubmitterName(body || {});
    return detected && detected !== 'Unknown' ? detected : '';
  })();




  setCurrentPage(page, headingTitle);



  // Same opening block as the service and maintenance reports rather than a bespoke
  // "Project details": one grid, one order, so the three documents read alike.
  // "Building project" struck off by Vladimir — the project number identifies the job and
  // the second line only repeated it in words.
  const installSiteRows = buildSiteInfoRows(body, { dateLabel: 'Installation start date' });

  if (installSiteRows.length) {

    drawSectionTitle('Site information');

    const siteRowsPerCol = Math.ceil(installSiteRows.length / 2);

    for (let i = 0; i < siteRowsPerCol; i += 1) {

      const pair = [installSiteRows[i], installSiteRows[i + siteRowsPerCol]].filter(Boolean);

      drawBlockRow(
        pair.map((row) => ({ label: row.label, value: row.value })),
        pair.length === 1 ? { halfWidth: true } : {},
      );

    }

  }

  // The narrative block the other reports carry, so an installation says what was done.
  const installSummaryRows = [
    { label: 'Problem description', value: val('problem_description') },
    { label: 'Work performed', value: val('work_performed') },
    { label: 'Recommendations', value: val('recommendations') },
    { label: 'Summary', value: val('signoff_summary') },
    // The customer's own words about the handover, and the engineer's notes. Both were
    // collected by the form and dropped by this renderer - found by the read-back check.
    { label: 'Customer comments', value: val('customer_comments') },
    { label: 'Additional notes', value: val('general_notes') || val('client_notes') },
  ].filter((row) => row.value && String(row.value).trim());

  if (installSummaryRows.length) {

    drawSectionTitle('Service summary');

    installSummaryRows.forEach((row) => {

      drawBlockRow(
        [{ label: row.label, value: row.value, height: 60, align: 'left', verticalAlign: 'top', paddingY: 8 }],
        { fullWidth: true },
      );

    });

  }

  // Completion date is acceptance-specific and keeps its place in the Acceptance block.



  // A heading with nothing under it is as wrong as an empty box, so each section is
  // announced only when something was filled in for it.
  const anyFilled = (...keys) => keys.some((key) => String(val(key) || '').trim() !== '' || boolVal(key));

  if (anyFilled('attendee_client', 'customer_name', 'attendee_supplier', 'engineer_name') || submittedByName) {

    drawSectionTitle('Attendees');

    drawBlockRow([
      { label: 'For the client', value: val('attendee_client') || resolveCustomerSignatoryName(body) },
      { label: 'For the supplier', value: val('attendee_supplier') || val('engineer_name') || submittedByName },
    ]);

  }



  if (anyFilled('acceptance_date', 'date_of_service', 'acceptance_location', 'acceptance_overall', 'acceptance_partial')) {

  drawSectionTitle('Acceptance');

  drawBlockRow(
    [
      { label: 'Appointment date', value: dateVal('acceptance_date') || dateVal('date_of_service') },
      // Where the handover took place — collected by the form but previously never printed.
      { label: 'Acceptance location', value: val('acceptance_location') || val('site_location') },
    ],
    { halfWidth: true },
  );
  // Moved out of the opening grid, which is now shared with the other reports: completion
  // is an acceptance fact, so it belongs beside the appointment date.
  drawBlockRow(
    [{ label: 'Completion date', value: dateVal('completion_date') }],
    { halfWidth: true },
  );

  drawCheckboxList(

    [

      { label: 'The whole agreed project', value: boolVal('acceptance_overall') },

      { label: 'Only a finished part of the project, accepted on its own', value: boolVal('acceptance_partial') },

    ],

    'What is being accepted',

  );

  drawBlockRow(
    [
      {
        label: 'Which part of the project',
        value: val('partial_services'),
        height: 60,
        align: 'left',
        verticalAlign: 'top',
        paddingY: 8,
      },
    ],
    { fullWidth: true },
  );

  }



  // Installation status, in the engineer's own words. The old free-standing "Notification of
  // defects" checkbox list is replaced by a plain statement, because a customer reading this
  // needs a sentence, not three ticked boxes to interpret.
  const installStatus = val('installation_status');

  // When the job isn't finished, the date it will be is the commitment on this page.
  // Built here because it prints twice: under the status, and on the detachable annex.
  const followupSentence = (() => {
    const type = val('installation_followup_type');
    const date = formatDisplayDate(
      val('installation_followup_date') || val('defects_deadline') || val('remaining_deadline'),
    );
    if (!type && !date) return '';
    const labels = { urgent: 'Fix urgently', planned: 'Planned completion' };
    const urgency = labels[String(type || '').trim().toLowerCase()] || type || 'Planned completion';
    return date ? `${urgency} - no later than ${date}` : urgency;
  })();

  const installPartialNotes = val('installation_partial_notes');

  const installationIsFinished = /^(yes|ja|fully|complete)/i.test(String(installStatus || '').trim());

  if (installStatus || installPartialNotes || followupSentence) {

    drawSectionTitle('Installation status');

    const statusText = installationIsFinished
      ? 'Installation finished completely.'
      : ('Installation not fully finished.' + (installPartialNotes ? ' ' + installPartialNotes : ''));

    drawBlockRow(
      [{ label: 'Status', value: statusText, height: 52, align: 'left', verticalAlign: 'top', paddingY: 8 }],
      { fullWidth: true },
    );

    if (followupSentence) {

      drawBlockRow(
        [{ label: 'To be completed', value: followupSentence, height: 30, align: 'left', verticalAlign: 'top', paddingY: 8 }],
        { fullWidth: true },
      );

    }

  }

  // Warranty: the app sends the start date and a number of years, the end is arithmetic —
  // asking a person to work it out invites a wrong date on a document that promises
  // something. warranty_begin is still read so older reports keep rendering.
  const signedWarrantyStart = val('warranty_start_date') || val('warranty_begin');

  // Vladimir's rule: the warranty runs from the moment the installation is actually
  // complete, not from the day the paper was signed. When work is still outstanding, that
  // moment is the completion date agreed in Installation status - so the clock starts
  // there, later than the signature, which is the reading that favours the customer.
  const completionDate = val('installation_followup_date') || val('defects_deadline') || val('remaining_deadline');

  const startsOnCompletion = !!(completionDate && !installationIsFinished);

  const warrantyStart = startsOnCompletion ? completionDate : signedWarrantyStart;

  const warrantyYearsRaw = val('warranty_years');

  const warrantyYears = String(warrantyYearsRaw || '').trim() || (warrantyStart ? '2' : '');

  const warrantyEnd = (() => {
    // An explicit end is only honoured when nothing moved the start; otherwise a client
    // that computed its end from the signing date would contradict the start printed above.
    const explicit = val('warranty_end');
    if (explicit && !startsOnCompletion) return formatDisplayDate(explicit);
    const parsed = parseLocalDateTime(String(warrantyStart || '').trim() + 'T00:00');
    const years = parseInt(warrantyYears, 10);
    if (!parsed || !Number.isFinite(years)) return '';
    const ends = new Date(parsed.getTime());
    ends.setFullYear(ends.getFullYear() + years);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(ends.getDate())}.${pad(ends.getMonth() + 1)}.${ends.getFullYear()}`;
  })();

  if (warrantyStart || warrantyYears) {

    drawSectionTitle('Warranty');

    drawBlockRow([
      { label: 'Warranty (years)', value: warrantyYears },
      { label: 'Warranty begins on', value: formatDisplayDate(warrantyStart), height: 28 },
    ]);

    if (warrantyEnd) {

      drawBlockRow(
        [{ label: 'Warranty ends on', value: warrantyEnd, height: 28 }],
        { halfWidth: true },
      );

    }

    // The date above is a planned one until the work is signed off. Saying so is the
    // difference between a document that can be wrong and one that cannot: if the crew
    // comes back later than planned, this sentence still describes the agreement.
    if (startsOnCompletion) {

      drawBlockRow(
        [{
          label: 'Basis',
          value: `The warranty runs from completion of the outstanding work listed in Annex 1, planned for ${formatDisplayDate(completionDate)}. If that work is completed on a different date, the warranty period starts then.`,
          height: 44,
          align: 'left',
          verticalAlign: 'top',
          paddingY: 8,
        }],
        { fullWidth: true },
      );

    }

  }



  // Deferred to the end of the document: the annex is a page of its own, handed over or
  // filed separately, so it must not interrupt the parts tables and the signatures.
  const drawAnnex1Page = async () => {

    // Annex 1 — the defect list that turns a conditional acceptance into a commitment. Its own
    // page, so it can be handed over or filed separately. New installation_* keys, with the
    // previous annex1_* / deadline keys read as fallbacks so older reports still render.
    const annexDefects = val('installation_defects') || val('annex1_defects');

    const annexRemaining = val('installation_remaining') || val('annex1_remaining');

    const annexHasDefects = boolVal('installation_has_defects') || !!(annexDefects || annexRemaining);

    if (annexHasDefects && (annexDefects || annexRemaining)) {

      addPageWithHeading('Annex 1');

      const annexDate = formatDisplayDate(val('date_of_service') || val('acceptance_date'));

      if (annexDate) {

        drawSectionTitle(`To the acceptance certificate dated ${annexDate}`);

      }

      const annexNumber = resolveProjectNumber(body);

      const annexName = resolveProjectName(body);

      if (annexNumber || annexName) {

        drawBlockRow(
          [
            { label: 'LSC project number', value: annexNumber },
            { label: 'LSC project name', value: annexName },
          ],
          { halfWidth: true },
        );

      }

      if (annexDefects) {

        drawBlockRow(
          [{ label: 'Defects', value: annexDefects, height: 110, align: 'left', verticalAlign: 'top', paddingY: 8 }],
          { fullWidth: true },
        );

      }

      if (annexRemaining) {

        drawBlockRow(
          [{ label: 'Remaining activities', value: annexRemaining, height: 110, align: 'left', verticalAlign: 'top', paddingY: 8 }],
          { fullWidth: true },
        );

      }

      // Repeated from Installation status on purpose, unlike the earlier decision to state
      // it once: this page leaves the certificate, and a defect list with no date on it is
      // a complaint rather than a commitment.
      if (followupSentence) {

        drawBlockRow(
          [{
            label: 'To be completed',
            value: followupSentence,
            height: 30,
            align: 'left',
            verticalAlign: 'top',
            paddingY: 8,
          }],
          { fullWidth: true },
        );

      }

      // Both parties sign the annex as well. Signing the certificate is agreement to
      // accept the work; this is agreement to the list and the date it names.
      ensureSpace(signatureHeight + 60);

      drawSectionTitle('Both parties agree to the above');

      await drawSignatureBoxes();

    }

  };

  const drawSimpleTable = (title, headers, ratios, rows) => {

    if (!rows.length) return;

    cursorY -= 14;

    const widths = ratios.map((ratio) => ratio * (page.getWidth() - margin * 2));

    const hHeight = 20;

    const rHeight = 26;

    ensureSpace(hHeight + rHeight * rows.length + 16);

    const label = title;

    drawSectionTitle(label);

    let x = margin;

    headers.forEach((head, index) => {

      page.drawRectangle({
        x, y: cursorY - hHeight, width: widths[index], height: hHeight,
        color: rgb(0.92, 0.95, 0.99), borderWidth: TABLE_BORDER_WIDTH, borderColor: TABLE_BORDER_COLOR,
      });

      drawCenteredTextBlock(
        page, head, font,
        { x, y: cursorY - hHeight, width: widths[index], height: hHeight },
        { align: 'center', paddingX: 3, paddingY: 2, color: headingColor, fontSize: 8.5, minFontSize: 7.5, lineHeightMultiplier: 1.15 },
      );

      x += widths[index];

    });

    cursorY -= hHeight;

    rows.forEach((cells) => {

      let cellX = margin;

      cells.forEach((value, index) => {

        page.drawRectangle({
          x: cellX, y: cursorY - rHeight, width: widths[index], height: rHeight,
          color: rgb(1, 1, 1), borderWidth: TABLE_BORDER_WIDTH, borderColor: TABLE_BORDER_COLOR,
        });

        drawCenteredTextBlock(
          page, String(value || ''), font,
          { x: cellX, y: cursorY - rHeight, width: widths[index], height: rHeight },
          { align: 'center', paddingX: 4, paddingY: 3, color: textColor, fontSize: 9.5, minFontSize: 8, lineHeightMultiplier: 1.15 },
        );

        cellX += widths[index];

      });

      cursorY -= rHeight;

    });

    cursorY -= 12;

  };

  drawSimpleTable(
    'Spare parts left on site',
    ['Type', 'Part number', 'Description', 'Quantity left'],
    [0.22, 0.26, 0.34, 0.18],
    collectSpareStockRows(body || {}).map((row) => [row.type, row.part, row.description, row.quantity]),
  );

  // What the customer is actually signing. Printed verbatim and in English, like the rest of
  // the document — a declaration paraphrased by the renderer is not the one that was agreed.
  const acceptanceStatement = val('acceptance_statement')
    || val('declaration_text')
    || val('declaration_statement');

  if (acceptanceStatement) {

    ensureSpace(120);

    drawSectionTitle('Customer declares');

    drawBlockRow(
      [{
        label: 'Acceptance statement',
        value: acceptanceStatement,
        height: 72,
        align: 'left',
        verticalAlign: 'top',
        paddingY: 8,
      }],
      { fullWidth: true },
    );

  }

  const columnWidth = (page.getWidth() - margin * 2 - 12) / 2;

  const signatureHeight = 160;

  const buildSignatureBoxes = () => [

    {

      label: 'For the client',

      acroName: 'customer_signature',

      x: margin,

      name: val('attendee_client') || resolveCustomerSignatoryName(body),

      company: val('customer_company'),

      // No signing date under the box: the certificate is already dated by the appointment
      // date above, and the field it came from no longer exists on either form.
      when: '',

    },

    {

      label: 'For the supplier',

      acroName: 'engineer_signature',

      x: margin + columnWidth + 12,

      name: val('attendee_supplier') || val('engineer_name') || submittedByName,

      company: val('engineer_company'),

      when: '',

    },

  ];

  const resolvePageNumber = () => pdfDoc.getPages().indexOf(page) + 1;

  // Draws the two signature boxes wherever the cursor is. Used by the certificate and by
  // Annex 1, which is detached and handed over on its own and therefore has to carry its
  // own confirmation that both sides agreed to what it lists.
  const drawSignatureBoxes = async () => {

  const signatureBoxes = buildSignatureBoxes();

  for (const box of signatureBoxes) {

    const entry = (signatureImages || []).find((item) => new RegExp(box.acroName, 'i').test(item.acroName));

    const boxRect = { x: box.x, y: cursorY - signatureHeight, width: columnWidth, height: signatureHeight };

    page.drawText(box.label, {

      x: boxRect.x,

      y: boxRect.y + boxRect.height + 6,

      size: 10,

      font,

      color: headingColor,

    });

    // Name, company and the moment of signing, each printed only when it was filled in —
    // an empty line is left out rather than shown blank. Drawn AFTER the box below, because
    // the box is filled white and painting it afterwards hid whatever was already there —
    // which is why the signatory's name never actually appeared on this document.
    const identityLines = [box.name, box.company, box.when]
      .map((line) => String(line || '').trim())
      .filter(Boolean);

    page.drawRectangle({

      x: boxRect.x,

      y: boxRect.y,

      width: boxRect.width,

      height: boxRect.height,

      borderWidth: TABLE_BORDER_WIDTH,

      borderColor: TABLE_BORDER_COLOR,

      color: rgb(1, 1, 1),

    });

    identityLines.forEach((line, index) => {

      page.drawText(line, {

        x: boxRect.x + 6,

        y: boxRect.y + boxRect.height - 12 - index * 11,

        size: 9,

        font,

        color: textColor,

      });

    });

    if (entry) {

      try {

        const decoded = decodeImageDataUrl(entry.data);

        if (decoded) {

          const image =

            decoded.mimeType === 'image/png'

              ? await pdfDoc.embedPng(decoded.buffer)

              : await pdfDoc.embedJpg(decoded.buffer);

          const availableWidth = boxRect.width - 12;

          const availableHeight = boxRect.height - 12;

          const scale = Math.min(availableWidth / image.width, availableHeight / image.height);

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

    cursorY -= signatureHeight + 16;

  };

  ensureSpace(signatureHeight + 40, headingTitle);

  drawSectionTitle('Signatures');

  await drawSignatureBoxes();

  await drawAnnex1Page();



  return signaturePlacements;

}



async function drawDailyReportPage(pdfDoc, font, reportData, options = {}) {

  const fallbackSize = { width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT };

  const pageSize =

    options.pageSize &&

    Number.isFinite(options.pageSize.width) &&

    Number.isFinite(options.pageSize.height)

      ? options.pageSize

      : fallbackSize;

  const pagesList = pdfDoc.getPages();

  const targetPage =
    options.targetPage && pagesList.includes(options.targetPage) ? options.targetPage : null;

  let page = targetPage || pdfDoc.addPage([pageSize.width, pageSize.height]);

  const margin = 36;

  const marginTop = 12;

  const headingColor = rgb(0.08, 0.2, 0.4);

  const textColor = rgb(0.1, 0.1, 0.16);

  const headingTitle = 'Daily report';

  const signaturePlacements = [];

  const projectNumber = reportData && reportData.projectNumber ? String(reportData.projectNumber) : '';

  const reportDate = reportData && reportData.reportDate ? String(reportData.reportDate) : '';

  const submitterName = reportData && reportData.submitterName ? String(reportData.submitterName) : '';

  const reportText = reportData && reportData.reportText ? String(reportData.reportText) : '';

  const pageHeight = page.getHeight();

  const bodyTopOffset = Number.isFinite(options.bodyTopOffset)

    ? options.bodyTopOffset

    : targetPage

      ? defaultBodyTopOffset(pageHeight)

      : null;

  const startY =

    bodyTopOffset !== null ? Math.max(marginTop + 8, pageHeight - bodyTopOffset - 6) : null;

  if (startY !== null && options.clearBelowHeader !== false) {

    page.drawRectangle({

      x: 0,

      y: 0,

      width: page.getWidth(),

      height: startY,

      color: rgb(1, 1, 1),

      borderWidth: 0,

    });

  }

  const PAGE_TOP_PADDING = 32;

  const pageStartY = (baseY) => Math.max(margin + PAGE_TOP_PADDING, baseY - PAGE_TOP_PADDING);

  let cursorY = startY !== null ? pageStartY(startY) : pageHeight - margin;

  const headingSize = 18;

  const headingWidth = font.widthOfTextAtSize(headingTitle, headingSize);

  page.drawText(headingTitle, {

    x: (page.getWidth() - headingWidth) / 2,

    y: cursorY,

    size: headingSize,

    font,

    color: headingColor,

  });

  cursorY -= 28;

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

  const drawInfoRow = (fields, { fullWidth = false } = {}) => {

    const normalized = (fields || [])

      .filter((field) => field && field.label)

      .map((field) => ({ label: field.label, value: field.value || '' }));

    if (!normalized.length) return;

    const columns = fullWidth || normalized.length === 1 ? 1 : 2;

    const colGap = columns === 1 ? 0 : 12;

    const columnWidth =

      columns === 1 ? page.getWidth() - margin * 2 : (page.getWidth() - margin * 2 - colGap) / 2;

    const labelHeight = 14;

    const valueHeight = 30;

    const rowHeight = labelHeight + valueHeight;

    if (cursorY - rowHeight < margin) {

      page = pdfDoc.addPage([pageSize.width, pageSize.height]);

      cursorY = page.getHeight() - margin;

    }

    normalized.forEach((field, index) => {

      const x = margin + index * (columnWidth + colGap);

      const labelY = cursorY - labelHeight;

      const valueY = labelY - valueHeight;

      page.drawRectangle({

        x,

        y: labelY,

        width: columnWidth,

        height: labelHeight,

        borderWidth: TABLE_BORDER_WIDTH,

        borderColor: TABLE_BORDER_COLOR,

        color: rgb(0.92, 0.95, 0.99),

      });

      page.drawText(field.label, {

        x: x + 6,

        y: labelY + 3,

        size: 9,

        font,

        color: headingColor,

      });

      page.drawRectangle({

        x,

        y: valueY,

        width: columnWidth,

        height: valueHeight,

        borderWidth: TABLE_BORDER_WIDTH,

        borderColor: TABLE_BORDER_COLOR,

        color: rgb(1, 1, 1),

      });

      drawCenteredTextBlock(

        page,

        String(field.value || ''),

        font,

        { x, y: valueY, width: columnWidth, height: valueHeight },

        {

          align: 'left',

          verticalAlign: 'middle',

          paddingX: 8,

          paddingY: 6,

          color: textColor,

          fontSize: 10,

          minFontSize: 9,

        },

      );

    });

    cursorY -= rowHeight + 12;

  };

  drawSectionTitle('Report details');

  drawInfoRow(

    [

      { label: 'Project number', value: projectNumber },

      { label: 'Report date', value: formatDisplayDate(reportDate) },

    ],

    { fullWidth: false },

  );

  drawInfoRow([{ label: 'Filled by', value: submitterName }], { fullWidth: true });

  drawSectionTitle('Report text');

  // A daily report is a one-way status update — no signatures, so nothing needs reserving
  // below the text box any more (iOS issue #1 note 394); the text gets that space instead.
  const availableTextHeight = cursorY - margin - 24;

  const textBoxHeight = clampNumber(availableTextHeight, 140, 460);

  const textRect = {

    x: margin,

    y: cursorY - textBoxHeight,

    width: page.getWidth() - margin * 2,

    height: textBoxHeight,

  };

  page.drawRectangle({

    x: textRect.x,

    y: textRect.y,

    width: textRect.width,

    height: textRect.height,

    borderWidth: TABLE_BORDER_WIDTH,

    borderColor: TABLE_BORDER_COLOR,

    color: rgb(1, 1, 1),

  });

  const textLayout = layoutMultilineText(reportText, font, textRect.width - 16, {

    fontSize: 10,

    minFontSize: 9,

    lineHeightMultiplier: 1.25,

  });

  const lineHeight = textLayout.entries && textLayout.entries.length ? textLayout.entries[0].lineHeight : 12;

  const maxLines = Math.max(1, Math.floor((textRect.height - 16) / Math.max(lineHeight, 1)));

  let visibleText = reportText;

  if (textLayout.entries.length > maxLines) {

    visibleText = textLayout.entries.slice(0, maxLines).map((entry) => entry.text).join('\n');

    const overflowText = textLayout.entries.slice(maxLines).map((entry) => entry.text).join('\n').trim();

    if (overflowText && Array.isArray(options.overflowTextEntries)) {

      options.overflowTextEntries.push({

        acroName: DAILY_REPORT_FIELDS.reportText,

        requestName: DAILY_REPORT_FIELDS.reportText,

        label: 'Daily report text',

        text: overflowText,

        fontSize: 10,

      });

    }

  }

  drawCenteredTextBlock(page, visibleText, font, textRect, {

    align: 'left',

    verticalAlign: 'top',

    paddingX: 8,

    paddingY: 8,

    color: textColor,

    fontSize: 10,

    minFontSize: 9,

    lineHeightMultiplier: 1.25,

  });


  return signaturePlacements;

}

async function drawSignOffPage(pdfDoc, font, body, signatureImages, partsRows, options = {}) {

  const pagesList = pdfDoc.getPages();

  const baseSize = pagesList.length ? pagesList[0].getSize() : { width: 595.28, height: 841.89 };

  const margin = 18;

  const headingColor = rgb(0.08, 0.2, 0.4);

  const textColor = rgb(0.1, 0.1, 0.16);

  const templateType = (body && body.template_type) || 'service_report';

  const headingTitle =

    {

      maintenance: 'Maintenance Report',

      installation_report: 'Installation Report',

      calibration: 'Calibration (draft)',

      service_report: 'Service Report',

    }[templateType] || 'Service Report';

  const isInstallation = templateType === 'installation_report';

  const isService = isServiceReport(templateType);

  const isMaintenance = templateType === 'maintenance';

  if (isInstallation) {

    return drawInstallationReport(pdfDoc, font, body, signatureImages, partsRows, options);

  }

  // Start drawing below the header: the admin page stores bodyTopOffset.

  const initialStartY =

    options.startY && Number.isFinite(options.startY)

      ? Math.max(options.startY - 6, margin + 28)

      : null;

  const PAGE_TOP_PADDING = 32;

  const pageStartY = (baseY) => Math.max(margin + PAGE_TOP_PADDING, baseY - PAGE_TOP_PADDING);



  const initialPage =

    options.targetPage && pagesList.includes(options.targetPage)

      ? options.targetPage

      : pdfDoc.addPage([baseSize.width, baseSize.height]);

  let page = initialPage;

  let cursorY =

    initialStartY !== null ? pageStartY(initialStartY) : pageStartY(page.getHeight() - margin);

  let firstPageDone = false;



  const setCurrentPage = (target, heading) => {

    page = target;

    // The first page uses the configured offset; later pages get the full top of the sheet.

    if (!firstPageDone && initialStartY !== null) {

      cursorY = pageStartY(initialStartY);

      firstPageDone = true;

    } else {

      cursorY = pageStartY(page.getHeight() - margin);

    }

    const headingText = heading || headingTitle;

    const textWidth = font.widthOfTextAtSize(headingText, 18);

    const centeredX = (page.getWidth() - textWidth) / 2;

    page.drawText(headingText, {

      x: centeredX,

      y: cursorY,

      size: 18,

      font,

      color: headingColor,

    });

    cursorY -= 26;

  };



  const addPageWithHeading = (heading = headingTitle) => {

    const next = pdfDoc.addPage([baseSize.width, baseSize.height]);

    setCurrentPage(next, heading);

    atPageTop = true;

    return next;

  };



  const addContinuationPage = (heading = headingTitle) => {

    return addPageWithHeading(heading);

  };



  const ensureSpace = (requiredHeight, heading) => {

    if (cursorY - requiredHeight < margin) {

      return addContinuationPage(heading);

    }

    return null;

  };



  // Air above a heading that follows a block. The title is drawn on its baseline, so with
  // nothing here the letters sit on the border of the block above and the descenders cut
  // through it. A heading that opens a page already sits under the page title.
  const SECTION_TITLE_TOP_GAP = 14;

  let atPageTop = true;

  const drawSectionTitle = (label) => {

    if (!atPageTop && !ensureSpace(SECTION_TITLE_TOP_GAP + 18)) cursorY -= SECTION_TITLE_TOP_GAP;

    atPageTop = false;

    page.drawText(label, {

      x: margin,

      y: cursorY,

      size: 12,

      font,

      color: headingColor,

    });

    cursorY -= 18;

  };



  setCurrentPage(page, headingTitle);



  const tableWidth = page.getWidth() - margin * 2;

  const signaturePlacements = [];



  const ensureBlock = (height, heading) => {

    if (cursorY - height < margin) {

      addPageWithHeading(heading);

      return true;

    }

    return false;

  };



  const employeesData =

    options.employees && Array.isArray(options.employees.entries)

      ? options.employees

      : collectEmployeeEntries(body || {});

  const employeeEntries = Array.isArray(employeesData.entries) ? employeesData.entries : [];

  const employeeTotalMinutes = Number(employeesData.totalMinutes || 0);

  const employeeTotalBreakMinutes = Number(employeesData.totalBreakMinutes || 0);

  const employeeBreakStats = employeesData.breakStats || { NONE: 0, MIN30: 0, MIN45: 0, UNKNOWN: 0 };
  const employeeUniqueCount = Number(employeesData.uniqueCount || 0);
  const employeeCount =
    employeeUniqueCount > 0 ? employeeUniqueCount : employeeEntries.length;
  const breaksEnabled = employeesData.breaksEnabled !== false;



  const renderEmployeesSection = () => {
    if (!employeeEntries.length) return;

    // Compact, screenshot-parity team table: one block per employee (header with
    // name/role + day/hour totals) then a per-day Date/Arrival/Departure/Break/Worked
    // table, instead of repeating name/role/full datetimes on every day-row.
    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayParts = (s) => {
      const str = String(s || '');
      const d = str.match(/(\d{4})-(\d{2})-(\d{2})/);
      const t = str.match(/(\d{1,2}):(\d{2})/);
      return {
        date: d ? { y: +d[1], m: +d[2], day: +d[3] } : null,
        time: t ? `${String(+t[1]).padStart(2, '0')}:${t[2]}` : '',
      };
    };
    const dateLabel = (dt) => {
      if (!dt || !dt.date) return '--';
      const { y, m, day } = dt.date;
      const wd = WEEKDAYS[new Date(y, m - 1, day).getDay()];
      return `${wd} ${String(day).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
    };

    // Group day-entries by employee (groupId falls back to name+role).
    const groups = [];
    const byKey = new Map();
    employeeEntries.forEach((entry) => {
      const key = entry.groupId || `${entry.name || ''}|${entry.role || ''}`;
      let g = byKey.get(key);
      if (!g) {
        g = { name: entry.name || '--', role: entry.role || '', days: [], minutes: 0 };
        byKey.set(key, g);
        groups.push(g);
      }
      g.days.push(entry);
      g.minutes += Number(entry.workedMinutes != null ? entry.workedMinutes : (entry.durationMinutes || 0));
    });

    const cols = [
      { key: 'date', label: 'Date', w: tableWidth * 0.28, align: 'left' },
      { key: 'arr', label: 'Arrival', w: tableWidth * 0.16, align: 'center' },
      { key: 'dep', label: 'Departure', w: tableWidth * 0.16, align: 'center' },
      { key: 'brk', label: 'Break', w: tableWidth * 0.16, align: 'center' },
      { key: 'work', label: 'Worked', w: tableWidth * 0.24, align: 'center' },
    ];
    const groupHeaderH = 20;
    const colHeaderH = 16;
    const dayRowH = 18;

    const drawColHeader = () => {
      let x = margin;
      cols.forEach((c) => {
        page.drawRectangle({
          x, y: cursorY - colHeaderH, width: c.w, height: colHeaderH,
          color: rgb(0.92, 0.95, 0.99), borderWidth: TABLE_BORDER_WIDTH, borderColor: TABLE_BORDER_COLOR,
        });
        drawCenteredTextBlock(page, c.label, font,
          { x, y: cursorY - colHeaderH, width: c.w, height: colHeaderH },
          { align: c.align, paddingX: 6, paddingY: 2, color: rgb(0.1, 0.1, 0.3), fontSize: 8.5, minFontSize: 8, lineHeightMultiplier: 1.15 });
        x += c.w;
      });
      cursorY -= colHeaderH;
    };

    const drawGroupHeader = (g) => {
      page.drawRectangle({
        x: margin, y: cursorY - groupHeaderH, width: tableWidth, height: groupHeaderH,
        color: rgb(0.96, 0.97, 1), borderWidth: TABLE_BORDER_WIDTH, borderColor: TABLE_BORDER_COLOR,
      });
      const left = g.role ? `${g.name}  ·  ${g.role}` : g.name;
      const right = `${g.days.length} ${g.days.length === 1 ? 'day' : 'days'} · ${formatEmployeeDuration(g.minutes)}`;
      page.drawText(left, { x: margin + 6, y: cursorY - groupHeaderH + 6, size: 10, font, color: headingColor });
      let rightW = 0;
      try { rightW = font.widthOfTextAtSize(right, 9); } catch (e) { rightW = right.length * 5; }
      page.drawText(right, { x: margin + tableWidth - rightW - 6, y: cursorY - groupHeaderH + 6, size: 9, font, color: textColor });
      cursorY -= groupHeaderH;
    };

    const label = ensureBlock(groupHeaderH + colHeaderH + dayRowH + 12, 'On-site team (continued)')
      ? 'On-site team (continued)' : 'On-site team';
    drawSectionTitle(label);

    groups.forEach((g) => {
      // Keep the group header + its column header + one day-row together.
      if (ensureSpace(groupHeaderH + colHeaderH + dayRowH + 6)) {
        drawSectionTitle('On-site team (continued)');
      }
      drawGroupHeader(g);
      drawColHeader();

      g.days.forEach((entry) => {
        if (ensureSpace(dayRowH + 4)) {
          drawSectionTitle('On-site team (continued)');
          drawGroupHeader(g);
          drawColHeader();
        }
        const arr = dayParts(entry.arrival);
        const dep = dayParts(entry.departure);
        // Break = the actual break the engineer recorded (app field); '—' when not provided.
        const brk = entry.breakMinutes != null ? formatEmployeeDuration(entry.breakMinutes) : '—';
        // Worked = net (gross - actual break), matching the app's own math.
        const worked = entry.workedMinutes != null ? entry.workedMinutes : entry.durationMinutes;
        const rowVals = {
          date: dateLabel(arr),
          arr: arr.time || '--',
          dep: dep.time || '--',
          brk,
          work: formatEmployeeDuration(worked),
        };
        let x = margin;
        cols.forEach((c) => {
          page.drawRectangle({
            x, y: cursorY - dayRowH, width: c.w, height: dayRowH,
            color: rgb(1, 1, 1), borderWidth: TABLE_BORDER_WIDTH, borderColor: TABLE_BORDER_COLOR,
          });
          drawCenteredTextBlock(page, String(rowVals[c.key]), font,
            { x, y: cursorY - dayRowH, width: c.w, height: dayRowH },
            { align: c.align, paddingX: 6, paddingY: 3, color: textColor, fontSize: 9, minFontSize: 8, lineHeightMultiplier: 1.1 });
          x += c.w;
        });
        cursorY -= dayRowH;
      });

      cursorY -= 8;
    });

    cursorY -= 6;
    // Total worked = sum of net per-day worked, so it matches the per-row Worked column.
    const netTotalMinutes = employeeEntries.reduce(
      (s, e) => s + Number(e.workedMinutes != null ? e.workedMinutes : (e.durationMinutes || 0)), 0);
    const durationSummary = formatEmployeeDuration(netTotalMinutes);
    const knownBreakCount =
      (employeeBreakStats.MIN45 || 0) + (employeeBreakStats.MIN30 || 0) + (employeeBreakStats.NONE || 0);
    const breakMinutesLabel = knownBreakCount > 0
      ? (employeeTotalBreakMinutes ? formatEmployeeDuration(employeeTotalBreakMinutes) : '0m')
      : (employeeBreakStats.UNKNOWN > 0 ? 'pending' : '0m');
    const breakDetails = knownBreakCount > 0
      ? formatBreakStatsSummary(employeeBreakStats)
      : (employeeBreakStats.UNKNOWN > 0 ? `${employeeBreakStats.UNKNOWN} pending` : '');
    page.drawText(
      `Total recorded time: ${durationSummary} across ${employeeCount} ${employeeCount === 1 ? 'employee' : 'employees'}.`,
      { x: margin, y: cursorY, size: 10, font, color: textColor });
    cursorY -= 16;
    if (breaksEnabled) {
      page.drawText(
        `Mandated breaks: ${breakMinutesLabel}${breakDetails ? ` (${breakDetails})` : ''}.`,
        { x: margin, y: cursorY, size: 10, font, color: textColor });
      cursorY -= 26;
    } else {
      cursorY -= 10;
    }
  };



  const drawChecklistSection = (section, opts = {}) => {

    const alwaysRender = opts.alwaysRender || false;

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

        drawCenteredTextBlock(

          page,

          label,

          font,

          { x: headerX, y: cursorY - headerHeight, width, height: headerHeight },

          {

            align: 'center',

            paddingX: 4,

            paddingY: 2,

            color: rgb(0.1, 0.1, 0.3),

            fontSize: 9,

            minFontSize: 8,

            lineHeightMultiplier: 1.2,

          },

        );

        headerX += width;

      });

      cursorY -= headerHeight;

    };



    // Most rows are a plain checkbox + notes pair keyed by field name. Some carry a measured
    // value instead (dead pixel count, brightness verdict): those supply resolvers so the
    // tick reflects "in order" while the reading itself lands in the notes column.
    const rowChecked = (row) => (typeof row.resolveChecked === 'function'
      ? !!row.resolveChecked(body)
      : normalizeCheckboxValue(body?.[row.checkbox]));

    const rowNote = (row) => (typeof row.resolveNote === 'function'
      ? String(row.resolveNote(body) || '')
      : (toSingleValue(body?.[row.notes]) || ''));

    const filteredRows = section.rows.filter((row) => {

      const checked = rowChecked(row);

      const note = rowNote(row);

      return alwaysRender || checked || (note && String(note).trim().length > 0);

    });

    if (!filteredRows.length) return;



    const totalHeightEstimate = headerHeight + rowBaseHeight * filteredRows.length + 12;

    const movedPage = ensureSpace(totalHeightEstimate);

    const headingLabel = movedPage ? `${section.title} (continued)` : section.title;

    drawSectionTitle(headingLabel);

    drawHeaderRow();



    filteredRows.forEach((row) => {

      const actionLayout = layoutTextForWidth({

        value: row.action,

        font,

        fontSize: 10,

        minFontSize: 9,

        lineHeightMultiplier: 1.2,

        maxWidth: columnWidths[0] - 8,

      });

      const noteValue = rowNote(row);

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

        drawSectionTitle(`${section.title} (continued)`);

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

      if (rowChecked(row)) {

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



  // The iOS service form carries its own field set — LED inspection, control checkpoints
  // and spare parts. None of those keys are in the AcroForm schema and no programmatic
  // block looked at them, so a fully filled app report came out with only the generic
  // client/dates/signatures/photos and the engineer's actual findings silently missing
  // (iOS issue #1 note 409). Both dialects are valid, so this renders the app's one
  // alongside the web's Service summary; each section is skipped when empty, which keeps
  // web submissions unchanged.
  const drawKeyValueSection = (title, rows) => {

    const present = rows.filter((row) => row.value && String(row.value).trim());

    if (!present.length) return;

    const rowsPerCol = Math.ceil(present.length / 2);

    const columnWidth = (page.getWidth() - margin * 2 - 8) / 2;

    const headerHeight = 18;

    const dataHeight = 36;

    const rowHeight = headerHeight + dataHeight;

    const blockHeight = rowsPerCol * rowHeight + 20;

    ensureBlock(blockHeight);

    const sectionLabel = title;

    drawSectionTitle(sectionLabel);

    const colX = [margin, margin + columnWidth + 8];

    present.forEach((row, idx) => {

      const colIdx = idx < rowsPerCol ? 0 : 1;

      const rowIdx = idx % rowsPerCol;

      const x = colX[colIdx];

      const y = cursorY - rowHeight * rowIdx;

      const headerY = y - headerHeight;

      const dataY = headerY - dataHeight;

      page.drawRectangle({

        x, y: headerY, width: columnWidth, height: headerHeight,

        borderWidth: TABLE_BORDER_WIDTH, borderColor: TABLE_BORDER_COLOR,

        color: rgb(0.92, 0.95, 0.99),

      });

      drawCenteredTextBlock(

        page, row.label, font,

        { x, y: headerY, width: columnWidth, height: headerHeight },

        { align: 'center', paddingX: 4, paddingY: 2, color: headingColor, fontSize: 8.5, minFontSize: 7.5, lineHeightMultiplier: 1.2 },

      );

      page.drawRectangle({

        x, y: dataY, width: columnWidth, height: dataHeight,

        borderWidth: TABLE_BORDER_WIDTH, borderColor: TABLE_BORDER_COLOR,

        color: rgb(1, 1, 1),

      });

      drawCenteredTextBlock(

        page, String(row.value || ''), font,

        { x, y: dataY, width: columnWidth, height: dataHeight },

        { align: 'center', paddingX: 8, paddingY: 4, color: textColor, fontSize: 11, minFontSize: 9, lineHeightMultiplier: 1.15 },

      );

    });

    cursorY -= rowsPerCol * rowHeight + 12;

  };



  // Free-text blocks (observations, notes, open issues) — same framed style as the
  // Service summary so the two dialects look like one document.
  const drawTextBlocks = (title, fields) => {

    const present = fields.filter((field) => field.value && String(field.value).trim());

    if (!present.length) return;

    let sectionStarted = false;

    present.forEach((field) => {

      const content = String(field.value).trim();

      const layout = layoutMultilineText(content, font, tableWidth - 12, {

        fontSize: DEFAULT_TEXT_FIELD_STYLE.fontSize,

        minFontSize: DEFAULT_TEXT_FIELD_STYLE.minFontSize,

        lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,

      });

      let blockHeight = Math.max(40, Math.ceil(layout.totalHeight + 30));

      if (!Number.isFinite(blockHeight) || blockHeight <= 0) blockHeight = 40;

      if (ensureSpace(blockHeight + 8)) sectionStarted = false;

      if (!sectionStarted) {

        drawSectionTitle(title);

        sectionStarted = true;

      }

      page.drawRectangle({

        x: margin, y: cursorY - blockHeight, width: tableWidth, height: blockHeight,

        color: rgb(1, 1, 1), borderWidth: TABLE_BORDER_WIDTH, borderColor: TABLE_BORDER_COLOR,

      });

      page.drawText(field.label, {

        x: margin + 6, y: cursorY - 14, size: 9, font, color: headingColor,

      });

      drawCenteredTextBlock(

        page, content, font,

        { x: margin, y: cursorY - blockHeight, width: tableWidth, height: blockHeight - 20 },

        {

          align: 'left', verticalAlign: 'top', paddingX: 6, paddingY: 6, color: textColor,

          fontSize: layout.appliedFontSize || DEFAULT_TEXT_FIELD_STYLE.fontSize,

          minFontSize: DEFAULT_TEXT_FIELD_STYLE.minFontSize,

          lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,

        },

      );

      cursorY -= blockHeight + 8;

    });

  };



  // Order mirrors the app's own composer so its preview and this document line up.
  const CONTROL_CHECKPOINT_ROWS = [

    // Measured readings live here rather than in the LED inspection grid: they are pass/fail
    // observations like the rest of the checklist, and an engineer reads one table instead of
    // hunting the same judgement in two places. The tick means "in order", the reading itself
    // stays visible in Notes so a count of 0 is never mistaken for "not checked".
    {
      action: 'Dead pixels',
      resolveChecked: (b) => String(toSingleValue(b?.led_dead_pixels) || '').trim() === '0',
      resolveNote: (b) => {
        const v = String(toSingleValue(b?.led_dead_pixels) || '').trim();
        return v === '' ? '' : `${v} dead ${v === '1' ? 'pixel' : 'pixels'}`;
      },
    },

    {
      action: 'Dead modules',
      resolveChecked: (b) => String(toSingleValue(b?.led_dead_modules) || '').trim() === '0',
      resolveNote: (b) => {
        const v = String(toSingleValue(b?.led_dead_modules) || '').trim();
        return v === '' ? '' : `${v} dead ${v === '1' ? 'module' : 'modules'}`;
      },
    },

    // Renamed from "Brightness uniformity" in plain words: the people filling this in are not
    // all confident in English, and "uniformity" is the kind of term that gets guessed at.
    {
      action: 'Even brightness (no dark or bright spots)',
      resolveChecked: (b) => /^(ok|yes|good)$/i.test(String(toSingleValue(b?.led_brightness_uniformity) || '').trim()),
      resolveNote: (b) => {
        const v = String(toSingleValue(b?.led_brightness_uniformity) || '').trim();
        return /^(ok|yes|good)$/i.test(v) ? '' : v;
      },
    },

    // Same judgement, same wording problem, and it now sits directly under the brightness
    // row — leaving one plain and the other as "Colour uniformity" would read as an oversight.
    {
      action: 'Even colour (no patchy areas)',
      resolveChecked: (b) => /^(ok|yes|good)$/i.test(String(toSingleValue(b?.led_color_uniformity) || '').trim()),
      resolveNote: (b) => {
        const v = String(toSingleValue(b?.led_color_uniformity) || '').trim();
        return /^(ok|yes|good)$/i.test(v) ? '' : v;
      },
    },

    { action: 'Power supply', checkbox: 'control_power_supply' },

    { action: 'Grounding', checkbox: 'control_grounding' },

    { action: 'Surge protection', checkbox: 'control_surge_protection' },

    { action: 'Signal integrity', checkbox: 'control_signal_integrity' },

    { action: 'Redundancy', checkbox: 'control_redundancy' },

    { action: 'Firmware up to date', checkbox: 'control_firmware_up_to_date' },

    // "Software logs" and "Fire safety" struck off the checklist on Vladimir's mark-up.
    { action: 'Remote access', checkbox: 'control_remote_access' },

    { action: 'Environment', checkbox: 'control_environment' },

    { action: 'Cleaning', checkbox: 'control_cleaning' },

  ];



  const drawIosServiceSections = () => {

    drawKeyValueSection('LED inspection', [

      // Display model is deliberately absent: it is already in Site information at the top,
      // and repeating it here just made the reader check whether the two agreed.
      // Dead pixels / dead modules / even brightness / even colour moved to Control
      // checkpoints; Cabling and Cooling were dropped outright on Vladimir's mark-up.
      { label: 'Controller / firmware', value: toSingleValue(body?.led_controller_firmware) || '' },

      { label: 'Cabinet issues', value: normalizeCheckboxValue(body?.led_cabinet_issues) ? 'Yes' : '' },

    ]);

    drawTextBlocks('LED inspection notes', [

      { label: 'Add notes', value: toSingleValue(body?.led_observations) || '' },

    ]);

    // Four of these rows are measured readings resolved from their own fields rather than a
    // checkbox, so testing row.checkbox alone asked body[undefined] and always said no. An
    // engineer who reported three dead pixels and nothing else got no table at all: the
    // reading was submitted, stored, and silently absent from the document.
    const rowHasContent = (row) => {
      if (row.checkbox && normalizeCheckboxValue(body?.[row.checkbox])) return true;
      if (typeof row.resolveNote === 'function' && String(row.resolveNote(body) || '').trim()) return true;
      if (typeof row.resolveChecked === 'function' && row.resolveChecked(body)) return true;
      return false;
    };

    const anyCheckpoint = CONTROL_CHECKPOINT_ROWS.some(rowHasContent)

      || String(toSingleValue(body?.control_open_issues) || '').trim();

    if (anyCheckpoint) {

      drawChecklistSection({ title: 'Control checkpoints', rows: CONTROL_CHECKPOINT_ROWS });

      drawTextBlocks('Control checkpoints', [

        { label: 'Open issues', value: toSingleValue(body?.control_open_issues) || '' },

      ]);

    }

    drawKeyValueSection('Spare parts', [

      { label: 'Parts replaced', value: toSingleValue(body?.spares_replaced_count) || '' },

      { label: 'Warranty claim', value: normalizeCheckboxValue(body?.spares_warranty_claim) ? 'Yes' : '' },

      { label: 'Invoice / RMA number', value: toSingleValue(body?.spares_invoice_number) || '' },

    ]);

    drawTextBlocks('Spare parts', [

      { label: 'Parts list', value: toSingleValue(body?.spares_list) || '' },

      { label: 'Notes', value: toSingleValue(body?.spares_notes) || '' },

    ]);

  };



  const drawServiceSummary = () => {

    const summaryFields = [

      { label: 'Problem description', value: toSingleValue(body?.problem_description) || '' },

      { label: 'Work performed', value: toSingleValue(body?.work_performed) || '' },

      // "Root cause" dropped on Vladimir's mark-up: it overlapped with Problem description
      // and Work performed, and engineers were repeating themselves across the three.
      { label: 'Recommendations', value: toSingleValue(body?.recommendations) || '' },

      // signoff_summary = the app's "Summary" field in the Sign-off section; the closing
      // summary of the visit. Rendered here (not via fields.json/AcroForm) so it lands in
      // the Service summary block matching the app's local preview/export.
      { label: 'Summary', value: toSingleValue(body?.signoff_summary) || '' },

    ].filter((field) => field.value && String(field.value).trim());

    if (!summaryFields.length) return;

    let sectionStarted = false;

    summaryFields.forEach((field, index) => {

      const content = String(field.value || '').trim();

      const layout = layoutMultilineText(content, font, tableWidth - 12, {

        fontSize: DEFAULT_TEXT_FIELD_STYLE.fontSize,

        minFontSize: DEFAULT_TEXT_FIELD_STYLE.minFontSize,

        lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,

      });

      // Box = label zone (20) + text height + breathing room; text is drawn top-down
      // below the label with the SAME precomputed layout, so it can never cross the frame.
      let blockHeight = Math.max(40, Math.ceil(layout.totalHeight + 30));

      if (!Number.isFinite(blockHeight) || blockHeight <= 0) {

        blockHeight = 40;

      }

      if (ensureSpace(blockHeight + 8)) {

        sectionStarted = false;

      }

      if (!sectionStarted) {

        drawSectionTitle('Service summary');

        sectionStarted = true;

      }

      page.drawRectangle({

        x: margin,

        y: cursorY - blockHeight,

        width: tableWidth,

        height: blockHeight,

        color: rgb(1, 1, 1),

        borderWidth: TABLE_BORDER_WIDTH,

        borderColor: TABLE_BORDER_COLOR,

      });

      page.drawText(field.label, {

        x: margin + 6,

        y: cursorY - 12,

        size: 9,

        font,

        color: headingColor,

      });

      drawCenteredTextBlock(

        page,

        content,

        font,

        { x: margin, y: cursorY - blockHeight, width: tableWidth, height: blockHeight - 20 },

        {

          align: 'left',

          verticalAlign: 'top',

          paddingX: 6,

          paddingY: 4,

          color: textColor,

          fontSize: layout.fontSize,

          minFontSize: layout.fontSize,

          lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,

          precomputed: layout,

        },

      );

      cursorY -= blockHeight + 6;

    });

    cursorY -= 4;

  };



  const drawNotesBlock = (label, value) => {

    const textValue = toSingleValue(value) || '';

    if (!textValue || !String(textValue).trim()) return;

    const marginTop = 10;

    cursorY -= marginTop;

    const layout = layoutMultilineText(String(textValue), font, tableWidth - 12, {

      fontSize: DEFAULT_TEXT_FIELD_STYLE.fontSize,

      minFontSize: DEFAULT_TEXT_FIELD_STYLE.minFontSize,

      lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,

    });

    let blockHeight = Math.max(48, Math.ceil(layout.totalHeight + 20));

    ensureSpace(blockHeight + 8);

    drawSectionTitle(label);

    page.drawRectangle({

      x: margin,

      y: cursorY - blockHeight,

      width: tableWidth,

      height: blockHeight,

      color: rgb(1, 1, 1),

      borderWidth: TABLE_BORDER_WIDTH,

      borderColor: TABLE_BORDER_COLOR,

    });

    drawCenteredTextBlock(

      page,

      String(textValue),

      font,

      { x: margin + 4, y: cursorY - blockHeight, width: tableWidth - 8, height: blockHeight },

      {

        align: 'left',

        verticalAlign: 'middle',

        paddingX: 8,

        paddingY: 10,

        color: textColor,

        fontSize: layout.fontSize,

        minFontSize: layout.fontSize,

        lineHeightMultiplier: DEFAULT_TEXT_FIELD_STYLE.lineHeightMultiplier,

        layout,

      },

    );

    cursorY -= blockHeight + 10;

  };



  // Site information first (two columns)

  // Only filled fields make it onto the page — an empty framed box says nothing and makes
  // the document look half-finished. Checklists keep their own rule (a row shows when it is
  // ticked or carries a note), so anything the engineer actually touched still prints.
  const siteInfoRows = buildSiteInfoRows(body);

  const hasSiteInfo = siteInfoRows.length > 0;

  if (hasSiteInfo) {

    const rowsPerCol = Math.ceil(siteInfoRows.length / 2);

    const columnWidth = (page.getWidth() - margin * 2 - 8) / 2;

    const headerHeight = 18;

    const dataHeight = 36;

    const rowHeight = headerHeight + dataHeight;

    const blockHeight = rowsPerCol * (headerHeight + dataHeight) + 20;

    ensureBlock(blockHeight);

    drawSectionTitle('Site information');

    const colX = [margin, margin + columnWidth + 8];

    siteInfoRows.forEach((row, idx) => {

      const colIdx = idx < rowsPerCol ? 0 : 1;

      const rowIdx = idx % rowsPerCol;

      const x = colX[colIdx];

      const y = cursorY - rowHeight * rowIdx;

      const headerY = y - headerHeight;

      const dataY = headerY - dataHeight;



      // Header cell with description

      page.drawRectangle({

        x,

        y: headerY,

        width: columnWidth,

        height: headerHeight,

        borderWidth: TABLE_BORDER_WIDTH,

        borderColor: TABLE_BORDER_COLOR,

        color: rgb(0.92, 0.95, 0.99),

      });

      drawCenteredTextBlock(

        page,

        row.label,

        font,

        { x, y: headerY, width: columnWidth, height: headerHeight },

        {

          align: 'center',

          paddingX: 4,

          paddingY: 2,

          color: headingColor,

          fontSize: 8.5,

          minFontSize: 7.5,

          lineHeightMultiplier: 1.2,

        },

      );



      // Data cell with value

      page.drawRectangle({

        x,

        y: dataY,

        width: columnWidth,

        height: dataHeight,

        borderWidth: TABLE_BORDER_WIDTH,

        borderColor: TABLE_BORDER_COLOR,

        color: rgb(1, 1, 1),

      });

      drawCenteredTextBlock(

        page,

        row.value || '',

        font,

        { x, y: dataY, width: columnWidth, height: dataHeight },

        {

          align: 'center',

          paddingX: 8,

          paddingY: 4,

          color: textColor,

          fontSize: 11,

          minFontSize: 9,

          lineHeightMultiplier: 1.15,

        },

      );

    });

    cursorY -= rowsPerCol * (headerHeight + dataHeight) + 12;

  }



  // A small gap after the site info

  cursorY -= 6;



  // Then the employees and the checklists

  renderEmployeesSection();



  // Maintenance gets the narrative block too. It was service-only, so an engineer who
  // described what they did on a maintenance visit had that text stored and dropped - the
  // read-back check found it on its first run, in the same class as the notes above.
  // The iOS LED-inspection sections stay service-only: maintenance has its own checklists.
  if (isService || isMaintenance) {

    drawServiceSummary();

  }

  if (isService) {

    drawIosServiceSections();

  }

  if (isService) {

    drawChecklistSection({ title: 'Equipment condition check', rows: SERVICE_EQUIPMENT_ROWS });

  }

  const checklistSections = isInstallation || isService ? [] : CHECKLIST_SECTIONS;

  checklistSections.forEach((section) => drawChecklistSection(section));

  const signoffRows = isInstallation || isService ? [] : SIGN_OFF_CHECKLIST_ROWS;

  if (signoffRows.length) {

    drawChecklistSection({ title: 'Sign-off checklist', rows: signoffRows });

  }



  // Parts record — right at the end, before Sign-off details

  const partsUsedRows = (partsRows || []).filter((row) => row.hasData);

  if (partsUsedRows.length) {

    const isServiceParts = isService;

    const columnWidths = (isServiceParts ? [0.18, 0.28, 0.26, 0.1, 0.18] : [0.16, 0.24, 0.15, 0.15, 0.16, 0.14]).map(

      (ratio) => tableWidth * ratio,

    );

    const rowHeightBase = isServiceParts ? 28 : 30;

    const headers = isServiceParts

      ? ['Type', 'Part number', 'Description', 'Quantity', 'Reason']

      : [

          'Type',

          'Part removed (description)',

          'Part number',

          'Serial number (removed)',

          'Part used in display',

          'Serial number (used)',

        ];

    // Header height follows the longest label instead of a fixed 18pt: "Serial number
    // (removed)" wraps to two lines in a narrow column, and the fixed box cut the second
    // line off, leaving "Serial number" over a mystery column.
    const headerHeight = Math.max(
      18,
      ...headers.map((label, index) => {
        const layout = layoutTextForWidth({
          value: label,
          font,
          fontSize: 8.5,
          minFontSize: 7.5,
          lineHeightMultiplier: 1.2,
          maxWidth: columnWidths[index] - 8,
        });
        return Math.ceil(layout.lineCount * layout.lineHeight + 7);
      }),
    );

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

        drawCenteredTextBlock(

          page,

          label,

          font,

          { x: headerX, y: cursorY - headerHeight, width, height: headerHeight },

          {

            align: 'center',

            paddingX: 4,

            paddingY: 2,

            color: rgb(0.1, 0.1, 0.3),

            fontSize: 8.5,

            minFontSize: 7.5,

            lineHeightMultiplier: 1.2,

          },

        );

        headerX += width;

      });

      cursorY -= headerHeight;

    };

    const usedRowsFiltered = partsUsedRows.filter((row) => row.hasData);

    if (usedRowsFiltered.length) {

      const partsTitle = 'Parts used during this visit';

      const headerLabel =

        ensureSpace(headerHeight + rowHeightBase * Math.min(usedRowsFiltered.length, 3) + 8)

          ? `${partsTitle} (continued)`

          : partsTitle;

      drawSectionTitle(headerLabel);

      drawPartsHeader();



      usedRowsFiltered.forEach((row) => {

        const partType = row.fields[`parts_type_${row.number}`] || '';

        const cellValues = isServiceParts

          ? [

              partType,

              row.fields[`parts_used_part_${row.number}`] || '',

              row.fields[`parts_removed_desc_${row.number}`] || '',

              row.fields[`parts_removed_part_${row.number}`] || '',

              row.fields[`parts_used_serial_${row.number}`] || '',

            ]

          : [

              partType,

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

            maxWidth: columnWidths[index] - 10,

          });

          return { value, layout };

        });

        let rowHeight = Math.max(

          rowHeightBase,

          ...cellLayouts.map(({ layout }) => Math.ceil(layout.lineCount * layout.lineHeight + 14)),

        );

        if (!Number.isFinite(rowHeight) || rowHeight <= 0) {

          rowHeight = rowHeightBase;

        }

        if (ensureSpace(rowHeight + 6)) {

          drawSectionTitle(`${partsTitle} (continued)`);

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

              paddingX: 10,

              paddingY: 12,

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

      cursorY -= 8;

    }

  }

  // What the next crew will find on site. Only on maintenance, and only when something was
  // recorded — an empty "nothing left" table would say less than no table at all.
  const spareStockRows = collectSpareStockRows(body || {});

  if (spareStockRows.length) {

    // Breathing room before the heading: it follows the parts table directly and without a
    // gap the two tables read as one block with a stray line of text between them.
    cursorY -= 14;

    const stockColumnWidths = [0.22, 0.26, 0.34, 0.18].map((ratio) => tableWidth * ratio);

    const stockHeaders = ['Type', 'Part number', 'Description', 'Quantity left'];

    const stockHeaderHeight = 18;

    const stockRowHeight = 24;

    const stockBlockHeight = stockHeaderHeight + stockRowHeight * spareStockRows.length + 12;

    ensureSpace(stockBlockHeight);

    drawSectionTitle('Spare parts left on site');

    let stockX = margin;

    stockHeaders.forEach((label, index) => {

      const width = stockColumnWidths[index];

      page.drawRectangle({
        x: stockX, y: cursorY - stockHeaderHeight, width, height: stockHeaderHeight,
        color: rgb(0.92, 0.95, 0.99), borderWidth: TABLE_BORDER_WIDTH, borderColor: TABLE_BORDER_COLOR,
      });

      drawCenteredTextBlock(
        page, label, font,
        { x: stockX, y: cursorY - stockHeaderHeight, width, height: stockHeaderHeight },
        { align: 'center', paddingX: 4, paddingY: 2, color: headingColor, fontSize: 9, minFontSize: 8, lineHeightMultiplier: 1.2 },
      );

      stockX += width;

    });

    cursorY -= stockHeaderHeight;

    spareStockRows.forEach((row) => {

      const values = [row.type, row.part, row.description, row.quantity];

      let cellX = margin;

      values.forEach((value, index) => {

        const width = stockColumnWidths[index];

        page.drawRectangle({
          x: cellX, y: cursorY - stockRowHeight, width, height: stockRowHeight,
          color: rgb(1, 1, 1), borderWidth: TABLE_BORDER_WIDTH, borderColor: TABLE_BORDER_COLOR,
        });

        drawCenteredTextBlock(
          page, String(value || ''), font,
          { x: cellX, y: cursorY - stockRowHeight, width, height: stockRowHeight },
          { align: 'center', paddingX: 4, paddingY: 3, color: textColor, fontSize: 10, minFontSize: 8, lineHeightMultiplier: 1.15 },
        );

        cellX += width;

      });

      cursorY -= stockRowHeight;

    });

    cursorY -= 12;

  }

  // The app has always sent the engineer's own notes as `client_notes`; this file only ever
  // read `general_notes`, so that text was accepted, stored, and silently left off the page.
  // A real report lost eight hours of travel time and a recommendation to the customer.
  const generalNotes = toSingleValue(body?.general_notes) || toSingleValue(body?.client_notes) || '';

  const customerComments = toSingleValue(body?.customer_comments) || '';

  if (isService) {

    // Both, when both were filled in. The old `a || b` printed whichever came first and
    // dropped the other without a trace - the same failure in a smaller disguise.
    drawNotesBlock('Customer comments', customerComments);

    drawNotesBlock('Additional notes', generalNotes);

    // Avoid duplicating template heading; just ensure space for signatures.

    ensureSpace(260);

  } else {

    drawNotesBlock('Customer comments', customerComments);

    drawNotesBlock('Additional notes', generalNotes);

    addPageWithHeading();

  }



  const submittedByName = (() => {
    const detected = detectSubmitterName(body || {});
    return detected && detected !== 'Unknown' ? detected : '';
  })();

  const engineerDetails = [

    // No date & time here: the visit is dated once, by "Date of service" in Site information.
    { label: 'On-site engineer company', value: toSingleValue(body?.engineer_company) || '' },

    { label: 'Engineer name', value: toSingleValue(body?.engineer_name) || submittedByName },

  ].filter((d) => d.value && String(d.value).trim());

  const customerDetails = [

    { label: 'Customer company', value: toSingleValue(body?.customer_company) || '' },

    { label: 'Customer name', value: resolveCustomerSignatoryName(body) },

  ].filter((d) => d.value && String(d.value).trim());

  const hasSignoffDetails =

    engineerDetails.some((d) => d.value && String(d.value).trim()) ||

    customerDetails.some((d) => d.value && String(d.value).trim());

  const columnWidth = (page.getWidth() - margin * 2 - 12) / 2;

  const detailHeight = 50;

  // The two columns are filtered independently, so reserve for the taller one.
  const detailRows = Math.max(engineerDetails.length, customerDetails.length);

  const signatureHeight = 180;

  // Reserve room for the details block plus the signatures, so the headings do not stick to the table above

  const combinedRequired = detailHeight * detailRows + signatureHeight + 140;

  ensureSpace(combinedRequired);



  if (hasSignoffDetails) {

    drawSectionTitle('Sign-off details');

    const baseDetailY = cursorY;

    // The two columns are filtered independently, so walk the taller one and draw each
    // side only where it still has a row — indexing one by the other's length crashed here.
    Array.from({ length: detailRows }, (unused, i) => i).forEach((index) => {

      const detail = engineerDetails[index];

      if (detail) {

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

      const engineerLabelY = engineerRect.y + engineerRect.height - 14;

      page.drawText(detail.label, {

        x: engineerRect.x + 6,

        y: engineerLabelY,

        size: 9,

        font,

        color: headingColor,

      });

      drawCenteredTextBlock(page, detail.value, font, engineerRect, {

        fontSize: 10,

        paddingY: 22,

        align: 'left',

        verticalAlign: 'middle',

      });



      }

      const customer = customerDetails[index];

      if (!customer) return;

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

      const customerLabelY = customerRect.y + customerRect.height - 14;

      page.drawText(customer.label, {

        x: customerRect.x + 6,

        y: customerLabelY,

        size: 9,

        font,

        color: headingColor,

      });

      drawCenteredTextBlock(page, customer.value, font, customerRect, {

        fontSize: 10,

        paddingY: 22,

        align: 'left',

        verticalAlign: 'middle',

      });

    });

    cursorY -= detailHeight * detailRows + 10;

  }



  // The signature boxes are wide but need less height.

  ensureSpace(signatureHeight + 40);

  drawSectionTitle('Signatures');

  const signatureWidth = columnWidth;

  const signatureBoxes = [

    { label: 'Engineer signature', acroName: 'engineer_signature', x: margin },

    { label: 'Customer signature', acroName: 'customer_signature', x: margin + columnWidth + 12 },

  ];

  const resolvePageNumber = () => pdfDoc.getPages().indexOf(page) + 1;



  for (const box of signatureBoxes) {

    const entry = (signatureImages || []).find((item) =>

      new RegExp(box.acroName, 'i').test(item.acroName),

    );

    const boxRect = { x: box.x, y: cursorY - signatureHeight, width: signatureWidth, height: signatureHeight };

    // Record each signature box's geometry (even if empty) so a remote signature
    // can later be drawn into the exact customer_signature box. Purely additive.
    if (Array.isArray(options.signatureSlots)) {
      options.signatureSlots.push({
        acroName: box.acroName,
        page: resolvePageNumber(),
        x: Number(boxRect.x.toFixed(2)),
        y: Number(boxRect.y.toFixed(2)),
        width: Number(boxRect.width.toFixed(2)),
        height: Number(boxRect.height.toFixed(2)),
      });
    }

    page.drawText(box.label, {

      x: boxRect.x,

      y: boxRect.y + boxRect.height + 6,

      size: 10,

      font,

      color: headingColor,

    });

    // Frame restored, matching the acceptance certificate: on a printed sheet the box is
    // what tells a customer where to sign. Drawn before anything else goes inside it -
    // it is filled white, so painting it afterwards hides the contents.
    page.drawRectangle({

      x: boxRect.x,

      y: boxRect.y,

      width: boxRect.width,

      height: boxRect.height,

      borderWidth: TABLE_BORDER_WIDTH,

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

          const scale = Math.min(availableWidth / image.width, availableHeight / image.height);

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

  cursorY -= signatureHeight + 16;



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



  const projectNumberOptions = (() => {
    const projectsStore = loadProjectsStore();
    const values = new Set();
    const addValue = (value) => {
      const normalized = String(value || '').trim();
      if (normalized) values.add(normalized);
    };
    if (projectsStore && typeof projectsStore === 'object') {
      Object.entries(projectsStore).forEach(([key, card]) => {
        addValue(key);
        if (card && typeof card === 'object') {
          addValue(card.batch_number);
          addValue(card.lsc_project_number);
        }
      });
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  })();


  const demoValues = new Map([

    ['end_customer_name', ''],

    ['site_location', ''],

    ['led_display_model', ''],

    ['batch_number', ''],

    ['date_of_service', ''],

    ['service_company_name', ''],

    ['led_notes_1', ''],

    ['led_notes_2', ''],

    ['led_notes_3', ''],

    ['control_notes_1', ''],

    ['control_notes_3', ''],

    ['spares_notes_1', ''],

    ['spares_notes_2', ''],

    ['general_notes', ''],

    ['parts_removed_desc_1', ''],

    ['parts_removed_part_1', ''],

    ['parts_removed_serial_1', ''],

    ['parts_used_part_1', ''],

    ['parts_used_serial_1', ''],

    ['signoff_notes_1', ''],

    ['signoff_notes_2', ''],

  ]);



  const signatureSamples = new Map([

    ['engineer_signature', ''],

    ['customer_signature', ''],

  ]);

  demoValues.set('control_notes_3', '');



  const demoChecked = new Set([

    'led_complete_1',

    'led_complete_2',

    'led_complete_3',

    'control_complete_1',

    'control_complete_3',

    'spares_complete_1',

    'signoff_complete_1',

  ]);



  const renderTextInput = (

    name,

    label,

    {
      type = 'text',
      textarea = false,
      placeholder = '',
      allowUnknown = false,
      required = false,
      id: idOverride = null,
      suggestField = null,
      listId = null,
      listOptions = null,
      // Restrict a single field to certain form types. Needed where the same server key is
      // asked for by two different sections: two enabled inputs with one name submit twice
      // and the LAST one wins, so an empty duplicate silently wipes what was typed.
      dataFormTypes = null,
    } = {},

  ) => {

    const descriptor = descriptorByName.get(name);

    if (!descriptor && !allowUnknown) {

      return `        <!-- Missing field: ${escapeHtml(label)} (${escapeHtml(name)}) -->`;

    }

    const requestName = descriptor ? descriptor.requestName : name;

    const id = idOverride || toHtmlId(name) || `field-${toHtmlId(descriptor ? descriptor.acroName : name)}`;

    const initial = demoValues.get(name);

    const requiredAttr = required ? ' required' : '';

    const formTypesAttr = dataFormTypes ? ` data-form-types="${escapeHtml(dataFormTypes)}"` : '';

    if (textarea) {

      const rows = type === 'textarea-lg' ? 8 : 4;

      const content = initial ? escapeHtml(initial) : '';

      return `        <label class="field"${formTypesAttr} for="${id}">

          <span>${escapeHtml(label)}</span>

          <textarea id="${id}" name="${escapeHtml(requestName)}" rows="${rows}" placeholder="${escapeHtml(placeholder || label)}" data-auto-resize${requiredAttr}>${content}</textarea>

        </label>`;

    }

    const valueAttr = initial ? ` value="${escapeHtml(initial)}"` : '';

    const suggestionField =
      suggestField || (descriptor && SUGGESTION_FIELDS.has(descriptor.requestName) ? descriptor.requestName : null);

    let suggestionAttrs = '';

    let datalistMarkup = '';

    if (suggestionField) {

      const resolvedListId = listId || `suggest-${id}`;

      suggestionAttrs =

        ` data-suggest-field="${escapeHtml(suggestionField)}" list="${escapeHtml(resolvedListId)}" autocomplete="off"`;

      datalistMarkup = `\n          <datalist id="${escapeHtml(resolvedListId)}" data-suggest-list="${escapeHtml(suggestionField)}"></datalist>`;

    } else if (listId) {

      const resolvedListId = listId;

      suggestionAttrs = ` list="${escapeHtml(resolvedListId)}"`;

      if (Array.isArray(listOptions) && listOptions.length) {

        const optionMarkup = listOptions
          .map((value) => `            <option value="${escapeHtml(String(value))}"></option>`)
          .join('\n');

        datalistMarkup = `\n          <datalist id="${escapeHtml(resolvedListId)}">\n${optionMarkup}\n          </datalist>`;

      } else {

        datalistMarkup = `\n          <datalist id="${escapeHtml(resolvedListId)}"></datalist>`;

      }

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

      resolvedPlaceholder = 'DD.MM.YYYY HH:MM';

      extraAttrs =

        ' data-datetime-text step="60" lang="de-DE" inputmode="numeric" pattern="[0-9]{2}[.][0-9]{2}[.][0-9]{4} [0-2][0-9]:[0-5][0-9]" title="Use 24-hour format DD.MM.YYYY HH:MM"';

    }

    return `        <label class="field"${formTypesAttr} for="${id}">

          <span>${escapeHtml(label)}</span>

          <input type="${escapeHtml(actualType)}" id="${id}" name="${escapeHtml(requestName)}"${valueAttr} placeholder="${escapeHtml(resolvedPlaceholder)}"${suggestionAttrs}${extraAttrs}${requiredAttr} />${datalistMarkup}

        </label>`;

  };



  const renderChecklistSection = (title, rows, options = {}) => {

    const header = `      <section class="card"${options.dataFormTypes ? ` data-form-types="${options.dataFormTypes}"` : ''}>

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

      const checkboxRequest = checkbox ? checkbox.requestName : row.checkbox;

      const notesRequest = notes ? notes.requestName : row.notes;

      const checkboxId = checkbox ? toHtmlId(checkbox.requestName) || `check-${checkbox.requestName}` : toHtmlId(row.checkbox) || `check-${row.checkbox}`;

      const isChecked = row.checked || demoChecked.has(row.checkbox);

      const checkboxMarkup = checkbox || options.allowUnknown

        ? `<input type="checkbox" id="${checkboxId}" name="${escapeHtml(checkboxRequest)}"${isChecked ? ' checked' : ''} />`

        : `<span class="missing">Missing field</span>`;

      const notesInitial = row.notesValue ?? (notes ? demoValues.get(notes.requestName) : '');

      const notesMarkup = notes || options.allowUnknown

        ? `<textarea name="${escapeHtml(notesRequest)}" data-auto-resize rows="1" placeholder="Add notes">${notesInitial ? escapeHtml(notesInitial) : ''}</textarea>`

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



  const renderInlineInput = (name, placeholder = '') => {

    const descriptor = descriptorByName.get(name);

    if (!descriptor) {

      return `<span class="missing">Missing: ${escapeHtml(name)}</span>`;

    }

    const initial = demoValues.get(name);

    if (/_notes_/i.test(name) || name === 'general_notes') {

      return `<textarea name="${escapeHtml(descriptor.requestName)}" data-auto-resize rows="1" placeholder="Add notes">${initial ? escapeHtml(initial) : ''}</textarea>`;

    }

    const valueAttr = initial ? ` value="${escapeHtml(initial)}"` : '';

    // A column header alone is too terse in a narrow cell: "Part number" was being read as
    // "how many". Each box says what it wants, with an example.
    const placeholderAttr = placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : '';

    return `<input type="text" name="${escapeHtml(descriptor.requestName)}"${valueAttr}${placeholderAttr} />`;

  };



  // What is still on the shelf when the team drives away. A maintenance visit both consumes
  // spares and leaves a stock behind, and the next crew needs to know what is there before
  // they load the van — that question was previously answered by phone, if at all.
  // Kept apart from the parts table on purpose: at submit the form disables every
  // [data-parts-section] except the active one, so this carries its own attribute and would
  // otherwise arrive empty.
  const spareStockTable = (dataAttr) => {

    const listId = `spare-stock-types-${toHtmlId(dataAttr) || 'stock'}`;

    const cell = (name, placeholder, extra = '') =>
      `<input type="text" name="${escapeHtml(name)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"${extra} />`;

    const rows = [];

    for (let i = 1; i <= PARTS_ROW_COUNT; i += 1) {
      const rowClass = i === 1 ? 'parts-row' : 'parts-row is-hidden-row';
      rows.push(`            <tr class="${rowClass}" data-row-index="${i}">
              <td>${cell(`spare_stock_type_${i}`, 'Type', ` list="${listId}"`)}</td>
              <td>${cell(`spare_stock_part_${i}`, 'Part number')}</td>
              <td>${cell(`spare_stock_desc_${i}`, 'Description')}</td>
              <td>${cell(`spare_stock_qty_${i}`, 'Qty')}</td>
            </tr>`);
    }

    return `      <section class="card" data-stock-section data-form-types="${dataAttr}">

        <h2>Spare parts left on site</h2>

        <p class="hint">Spare parts that stay with the customer after this visit. Record what is still
        available so the next team knows what is on site before the next service — this is stock, not
        what you used today. Parts you fitted or replaced belong in the table above.</p>

        <table class="parts-table" data-parts-table>
          <colgroup>
            <col data-col="type" />
            <col data-col="part" />
            <col data-col="desc" />
            <col data-col="qty" />
          </colgroup>
          <datalist id="${listId}">
${SPARE_PART_TYPES.map((t) => `            <option value="${escapeHtml(t)}"></option>`).join('\n')}
          </datalist>
          <thead>
            <tr>
              <th>Type</th>
              <th>Part number</th>
              <th>Description</th>
              <th>Quantity left</th>
            </tr>
          </thead>
          <tbody>
${rows.join('\n')}
          </tbody>
        </table>

        <div class="parts-table-actions">
          <button type="button" class="button" data-action="parts-add-row">+ Add another spare</button>
          <button type="button" class="button" data-action="parts-remove-row">- Remove last row</button>
          <p class="parts-table-hint">Maximum of ${PARTS_ROW_COUNT} rows. Leave empty if nothing is left on site.</p>
        </div>

      </section>`;

  };

  const partsTable = (options = {}) => {

    const { isService = false, dataAttr = '' } = options;

    // One datalist per section — both sections live in the DOM at once, so the id has to
    // be unique even though only one is ever visible.
    const typeListId = `spare-part-types-${toHtmlId(dataAttr) || 'parts'}`;

    const renderTypeInput = (index) => `<input type="text" name="parts_type_${index}" list="${typeListId}" placeholder="Type" autocomplete="off" />`;

    const typeDatalist = `          <datalist id="${typeListId}">
${SPARE_PART_TYPES.map((t) => `            <option value="${escapeHtml(t)}"></option>`).join('\n')}
          </datalist>`;

    const rows = [];

    for (let i = 1; i <= PARTS_ROW_COUNT; i += 1) {

      const rowClass = i === 1 ? 'parts-row' : 'parts-row is-hidden-row';

      if (isService) {

        rows.push(`            <tr class="${rowClass}" data-row-index="${i}">

              <td>${renderTypeInput(i)}</td>

              <td>${renderInlineInput(`parts_used_part_${i}`, 'Part number printed on the part, e.g. A5s')}</td>

              <td>${renderInlineInput(`parts_removed_desc_${i}`, 'What the part is')}</td>

              <td>${renderInlineInput(`parts_removed_part_${i}`, 'How many')}</td>

              <td>${renderInlineInput(`parts_used_serial_${i}`, 'Why it was replaced')}</td>

            </tr>`);

      } else {

        rows.push(`            <tr class="${rowClass}" data-row-index="${i}">

              <td>${renderTypeInput(i)}</td>

              <td>${renderInlineInput(`parts_removed_desc_${i}`, 'What was taken out')}</td>

              <td>${renderInlineInput(`parts_removed_part_${i}`, 'Part number printed on it, e.g. A5s')}</td>

              <td>${renderInlineInput(`parts_removed_serial_${i}`, 'Serial of the part taken out')}</td>

              <td>${renderInlineInput(`parts_used_part_${i}`, 'Part number of the new one')}</td>

              <td>${renderInlineInput(`parts_used_serial_${i}`, 'Serial of the new one')}</td>

            </tr>`);

      }

    }

    const headers = isService

      ? ['Type', 'Part number', 'Description', 'Quantity', 'Reason']

      : [
          'Type',
          'Part removed (description)',
          'Part number',
          'Serial number (removed)',
          'Part used in display',
          'Serial number (used)',
        ];

    return `      <section class="card" data-parts-section data-form-types="${dataAttr}">

        <h2>Parts used during this visit</h2>

        <p class="hint">${isService
          ? 'Parts you fitted or replaced during this visit. One row per part.'
          : 'Parts you fitted or replaced during this visit. One row per part — spares that stay with the customer go in the section below.'}</p>

        <table class="parts-table" data-parts-table>

          ${isService ? `<colgroup>

            <col data-col="type" />

            <col data-col="part" />

            <col data-col="desc" />

            <col data-col="qty" />

            <col data-col="reason" />

          </colgroup>` : ''}

${typeDatalist}

          <thead>

            <tr>

${headers.map((h) => `              <th>${escapeHtml(h)}</th>`).join('\n')}

            </tr>

          </thead>

          <tbody>

${rows.join('\n')}

          </tbody>

        </table>

        <div class="parts-table-actions">

          <button type="button" class="button" data-action="parts-add-row">+ Add another part</button>

          <button type="button" class="button" data-action="parts-remove-row">- Remove last row</button>

          <button type="button" class="button" data-parts-ocr>+ Add photo (OCR)</button>

          <input type="file" data-parts-ocr-input accept="image/*" hidden />

          <p class="parts-table-hint">Maximum of ${PARTS_ROW_COUNT} rows.</p>

          <p class="parts-table-hint" data-parts-ocr-status></p>

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

            <div class="signature-pad__actions">

              <button type="button" class="signature-fullscreen">Fullscreen</button>

              <button type="button" class="signature-clear">Clear</button>

            </div>

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

    <title>PDF forms generator - v${SERVICE2_VERSION} Lin</title>

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

        --control-scale: 1;

        --base-font-size: 16px;

      }

      body {

        margin: 0;

        padding: 1.5rem;

        font-size: var(--base-font-size);

      }

      .container {

        max-width: 960px;

        margin: 0 auto;

        display: flex;

        flex-direction: column;

        gap: 1.5rem;

        width: 100%;

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

      input[type="email"],

      input[type="tel"],

      input[type="number"],

      input[type="time"],

      input[type="password"],

      textarea,

      select {

        font: inherit;

        font-size: calc(1rem * var(--control-scale, 1));

        padding: calc(0.75rem * var(--control-scale, 1));

        border: 1px solid #d8d8e5;

        border-radius: 10px;

        background: #fafafe;

      }

      select {

        min-height: calc(48px * var(--control-scale, 1));

      }

      textarea {

        resize: vertical;

        min-height: calc(120px * var(--control-scale, 1));

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

      /* A required field left empty: the label turns red too, so the section that needs
         attention is visible while scrolling past, not only the box itself. */
      .field.is-missing > span,
      .field.is-missing > label,
      .signature-pad.is-missing .signature-pad__label > span {
        color: #dc2626;
        font-weight: 600;
      }

      .field.is-missing > span::after,
      .field.is-missing > label::after,
      .signature-pad.is-missing .signature-pad__label > span::after {
        content: ' — required';
        font-weight: 500;
        font-size: 0.85em;
      }

      .field.is-missing input,
      .field.is-missing select,
      .field.is-missing textarea {
        border-color: #dc2626;
        background: #fee2e2;
      }

      /* A checkbox group has no field box to redden, so the whole card is marked - the
         engineer needs to see which decision is missing, not which input. */
      section.card.is-missing > h2 {
        color: #dc2626;
      }

      section.card.is-missing > h2::after {
        content: ' — required';
        font-weight: 500;
        font-size: 0.85em;
      }

      .required-summary {
        margin: 8px 0 0;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid #fecaca;
        background: #fef2f2;
        color: #b91c1c;
        font-size: 0.9rem;
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

        table-layout: fixed;

      }

      .parts-table th,

      .parts-table td {

        border: 1px solid #d8d8e5;

        padding: 0.25rem 0.35rem;

        background: white;

      }

      .parts-table th {

        background: #eef1fb;

        font-size: 0.8rem;

      }

      .parts-table td input,

      .parts-table td textarea {

        width: 100%;

        box-sizing: border-box;

        padding: 0.25rem 0.35rem;

        border-radius: 8px;

        border: 1px solid #d8d8e5;

        background: #fafafe;

      }

      .parts-table td:nth-child(3) input {

        padding: 2px !important;

        min-height: 1.6rem;

        font-size: 0.95rem;

      }

      .parts-table td textarea {

        resize: vertical;

        min-height: 2.75rem;

        font: inherit;

      }

      .parts-table colgroup col[data-col="type"] {

        width: 18%;

      }

      .parts-table colgroup col[data-col="part"] {

        width: 28%;

      }

      .parts-table colgroup col[data-col="desc"] {

        width: 26%;

      }

      .parts-table colgroup col[data-col="qty"] {

        width: 10%;

      }

      .parts-table colgroup col[data-col="reason"] {

        width: 18%;

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

      /* Explanatory line under a section heading: what the section is for, in plain English,
         so the distinction between "used today" and "left on site" is settled on the page
         rather than by asking a colleague. */
      .hint {

        margin: 0 0 12px;

        font-size: 0.88rem;

        line-height: 1.45;

        color: #4b5563;

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

      .photo-slot.drag-over {

        border-color: #2563eb;

        border-style: solid;

        background: #eef2ff;

        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);

      }

      .photo-drop-hint {

        color: #6b7280;

        font-size: 0.8rem;

        font-weight: 500;

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

      .photo-item-thumb {

        position: relative;

        line-height: 0;

      }

      .photo-item-remove,
      .photo-item-zoom {

        position: absolute;

        border: none;

        color: #ffffff;

        cursor: pointer;

        opacity: 0;

        transition: opacity 0.15s ease, background 0.15s ease;

        z-index: 2;

        display: flex;

        align-items: center;

        justify-content: center;

        padding: 0;

      }

      .photo-item-remove {

        top: 6px;

        right: 6px;

        width: 24px;

        height: 24px;

        border-radius: 50%;

        background: rgba(17, 24, 39, 0.72);

        font-size: 16px;

      }

      .photo-item-remove:hover {

        background: #dc2626;

      }

      .photo-item-zoom {

        top: 50%;

        left: 50%;

        transform: translate(-50%, -50%);

        width: 40px;

        height: 40px;

        border-radius: 50%;

        background: rgba(17, 24, 39, 0.6);

        font-size: 18px;

      }

      .photo-item-zoom:hover {

        background: rgba(17, 24, 39, 0.88);

      }

      .photo-item-thumb:hover .photo-item-remove,
      .photo-item-thumb:hover .photo-item-zoom,
      .photo-item-thumb:focus-within .photo-item-remove,
      .photo-item-thumb:focus-within .photo-item-zoom {

        opacity: 1;

      }

      .photo-lightbox {

        position: fixed;

        inset: 0;

        z-index: 1000;

        background: rgba(0, 0, 0, 0.82);

        display: flex;

        align-items: center;

        justify-content: center;

        padding: 24px;

      }

      .photo-lightbox[hidden] {

        display: none;

      }

      .photo-lightbox img {

        max-width: 95vw;

        max-height: 90vh;

        border-radius: 8px;

        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);

      }

      .photo-lightbox-close {

        position: absolute;

        top: 16px;

        right: 20px;

        width: 40px;

        height: 40px;

        border-radius: 50%;

        border: none;

        background: rgba(255, 255, 255, 0.16);

        color: #ffffff;

        font-size: 24px;

        cursor: pointer;

      }

      .fb-fab {

        position: fixed;

        right: 20px;

        bottom: 20px;

        width: 58px;

        height: 58px;

        border: none;

        background: transparent;

        cursor: pointer;

        z-index: 900;

        display: flex;

        align-items: center;

        justify-content: center;

        filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.25));

        transition: transform 0.12s ease;

      }

      .fb-fab:hover { transform: translateY(-2px) scale(1.04); }

      .fb-fab-tri { width: 58px; height: 58px; }

      .fb-fab-hand {

        position: absolute;

        top: 54%;

        left: 50%;

        transform: translate(-50%, -50%);

        font-size: 20px;

        pointer-events: none;

      }

      .fb-overlay {

        position: fixed;

        inset: 0;

        z-index: 1000;

        background: rgba(15, 23, 42, 0.55);

        display: flex;

        align-items: center;

        justify-content: center;

        padding: 16px;

      }

      .fb-overlay[hidden] { display: none; }

      .fb-dialog {

        width: 100%;

        max-width: 480px;

        background: #ffffff;

        border-radius: 14px;

        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);

        overflow: hidden;

        max-height: 90vh;

        display: flex;

        flex-direction: column;

      }

      .fb-dialog-head {

        display: flex;

        align-items: center;

        justify-content: space-between;

        padding: 14px 16px;

        background: #c8102e;

        color: #ffffff;

      }

      .fb-close {

        border: none;

        background: transparent;

        color: #ffffff;

        font-size: 22px;

        cursor: pointer;

        line-height: 1;

      }

      .fb-dialog-body {

        padding: 16px;

        display: flex;

        flex-direction: column;

        gap: 12px;

        overflow-y: auto;

      }

      .fb-types { display: flex; gap: 8px; }

      .fb-type {

        flex: 1;

        padding: 0.5rem 0.75rem;

        border: 1px solid #d1d5db;

        border-radius: 999px;

        background: #f9fafb;

        cursor: pointer;

        font-weight: 600;

      }

      .fb-type.is-active { background: #c8102e; color: #ffffff; border-color: #c8102e; }

      .fb-dialog-body textarea {

        width: 100%;

        border: 1px solid #d1d5db;

        border-radius: 10px;

        padding: 0.6rem 0.75rem;

        font: inherit;

        resize: vertical;

        min-height: 84px;

      }

      .fb-row { display: flex; flex-wrap: wrap; gap: 8px; }

      .fb-attach-btn {

        display: inline-flex;

        align-items: center;

        gap: 6px;

        padding: 0.5rem 0.9rem;

        border: 1px solid #d1d5db;

        border-radius: 999px;

        background: #f3f4f6;

        cursor: pointer;

        font-weight: 500;

        font-size: 0.9rem;

      }

      .fb-attach-btn.is-recording { background: #fee2e2; border-color: #dc2626; color: #b91c1c; }

      .fb-attach-preview { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

      .fb-attach-preview img {

        width: 64px;

        height: 64px;

        object-fit: cover;

        border-radius: 8px;

        border: 1px solid #e5e7eb;

      }

      .fb-attach-preview audio { height: 36px; max-width: 220px; }

      .fb-hint {

        margin: 0;

        font-size: 0.8rem;

        color: #6b7280;

        background: #f3f4f6;

        border-radius: 8px;

        padding: 8px 10px;

      }

      .fb-hint b { color: #374151; }

      .fb-chip {

        display: inline-flex;

        align-items: center;

        gap: 6px;

        background: #eef2ff;

        border-radius: 999px;

        padding: 2px 6px 2px 10px;

        font-size: 0.8rem;

      }

      .fb-chip button { border: none; background: transparent; cursor: pointer; font-size: 14px; color: #6b7280; }

      .fb-actions { display: flex; align-items: center; gap: 12px; }

      .fb-send {

        padding: 0.6rem 1.2rem;

        border: none;

        border-radius: 999px;

        background: #c8102e;

        color: #ffffff;

        font-weight: 600;

        cursor: pointer;

      }

      .fb-send:disabled { opacity: 0.6; cursor: default; }

      .fb-status { font-size: 0.85rem; color: #6b7280; }

      .fb-status.error { color: #dc2626; }

      .fb-status.ok { color: #059669; }

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

        max-width: 520px;

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

        min-height: calc(150px * var(--control-scale, 1));

      }

      .signature-pad canvas {

        width: 100%;

        height: 100%;

        min-height: calc(140px * var(--control-scale, 1));

        max-height: calc(320px * var(--control-scale, 1));

        touch-action: none;

        background: white;

        border-radius: 8px;

      }

      .signature-fullscreen {

        margin-left: 0.5rem;

        border: none;

        background: none;

        color: #2563eb;

        font-weight: 600;

        cursor: pointer;

        padding: 0;

      }

      .signature-overlay {

        position: fixed;

        inset: 0;

        background: rgba(0, 0, 0, 0.65);

        display: flex;

        align-items: center;

        justify-content: center;

        padding: 1rem;

        z-index: 2000;

      }

      .signature-overlay[hidden] {

        display: none;

      }

      .signature-overlay__panel {

        width: min(960px, 100%);

        height: min(85vh, 720px);

        background: #fff;

        border-radius: 12px;

        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);

        display: flex;

        flex-direction: column;

        padding: 0.75rem;

      }

      .signature-overlay[data-orientation="landscape"] .signature-overlay__panel {

        width: min(96vw, 1100px);

        height: min(70vh, 640px);

      }

      .signature-overlay__actions {

        display: flex;

        align-items: center;

        gap: 0.75rem;

        margin-bottom: 0.5rem;

        font-weight: 600;

        color: #1f2a5b;

      }

      .signature-overlay__actions .spacer {

        flex: 1;

      }

      .signature-overlay__actions button {

        border: none;

        border-radius: 8px;

        padding: 0.5rem 0.9rem;

        font-weight: 600;

        cursor: pointer;

      }

      .signature-overlay__actions .secondary {

        background: #e5e7eb;

        color: #111827;

      }

      .signature-overlay__actions .secondary.is-active {

        background: #2563eb;

        color: #fff;

      }

      .signature-overlay__actions .primary {

        background: #2563eb;

        color: #fff;

      }

      .signature-overlay canvas {

        flex: 1;

        width: 100%;

        border: 1px solid #d1d5db;

        border-radius: 10px;

        background: #fff;

        touch-action: none;

      }

      /* â”€â”€ Mobileâ€‘mode signature overlay â”€â”€ */

      body.mobile-mode .signature-overlay {

        padding: 0;

        background: rgba(0, 0, 0, 0.85);

      }

      body.mobile-mode .signature-overlay__panel {

        width: 100%;

        height: 100%;

        border-radius: 0;

        padding: 0;

        position: relative;

      }

      body.mobile-mode .signature-overlay__actions {

        position: absolute;

        top: 0;

        left: 0;

        right: 0;

        z-index: 10;

        padding: 0.6rem 0.75rem;

        margin: 0;

        background: rgba(255,255,255,0.92);

        backdrop-filter: blur(8px);

        -webkit-backdrop-filter: blur(8px);

        border-bottom: 1px solid #e5e7eb;

      }

      body.mobile-mode .signature-overlay__actions > span:first-child,

      body.mobile-mode .signature-overlay__actions > .spacer,

      body.mobile-mode .signature-overlay__actions [data-overlay-rotate],

      body.mobile-mode .signature-overlay__actions [data-overlay-orientation],

      body.mobile-mode .signature-overlay__actions [data-overlay-cancel] {

        display: none;

      }

      body.mobile-mode .signature-overlay__actions [data-overlay-clear] {

        margin-right: auto;

        background: #f3f4f6;

        color: #374151;

        border-radius: 10px;

        padding: 0.55rem 1.2rem;

        font-size: 0.95rem;

      }

      body.mobile-mode .signature-overlay__actions [data-overlay-apply] {

        border-radius: 10px;

        padding: 0.55rem 1.4rem;

        font-size: 0.95rem;

      }

      body.mobile-mode .signature-overlay canvas {

        border: none;

        border-radius: 0;

        flex: 1;

        width: 100%;

      }

      /* Arrow hint */

      .signature-arrow-hint {

        display: none;

      }

      body.mobile-mode .signature-arrow-hint {

        display: flex;

        position: absolute;

        left: 50%;

        bottom: 12%;

        transform: translateX(-50%);

        z-index: 5;

        flex-direction: column;

        align-items: center;

        pointer-events: none;

        animation: arrowBounce 1.6s ease-in-out infinite;

        transition: opacity 0.4s ease;

      }

      body.mobile-mode .signature-arrow-hint.is-hidden {

        opacity: 0;

        pointer-events: none;

      }

      .signature-arrow-hint__icon {

        width: 48px;

        height: 120px;

        position: relative;

      }

      .signature-arrow-hint__icon::before {

        content: '';

        position: absolute;

        left: 50%;

        bottom: 0;

        width: 4px;

        height: 100%;

        background: linear-gradient(to top, rgba(37,99,235,0.15), rgba(37,99,235,0.7));

        border-radius: 4px;

        transform: translateX(-50%);

      }

      .signature-arrow-hint__icon::after {

        content: '';

        position: absolute;

        left: 50%;

        top: 0;

        width: 0;

        height: 0;

        border-left: 14px solid transparent;

        border-right: 14px solid transparent;

        border-bottom: 20px solid rgba(37,99,235,0.7);

        transform: translateX(-50%);

      }

      .signature-arrow-hint__label {

        margin-top: 0.6rem;

        font-size: 0.85rem;

        font-weight: 600;

        color: rgba(37,99,235,0.65);

        letter-spacing: 0.03em;

      }

      @keyframes arrowBounce {

        0%, 100% { transform: translateX(-50%) translateY(0); }

        50% { transform: translateX(-50%) translateY(-18px); }

      }

      .employee-name-overlay {

        position: fixed;

        inset: 0;

        background: rgba(15, 23, 42, 0.55);

        display: flex;

        align-items: center;

        justify-content: center;

        padding: 1rem;

        z-index: 2100;

      }

      .employee-name-overlay[hidden] {

        display: none;

      }

      .employee-name-dialog {

        width: min(420px, 92vw);

        background: #fff;

        border-radius: 12px;

        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);

        padding: 1rem 1.25rem;

        display: flex;

        flex-direction: column;

        gap: 0.75rem;

      }

      .employee-name-dialog h3 {

        margin: 0;

        font-size: 1.05rem;

        color: #1f2a5b;

      }

      .employee-name-dialog label {

        display: flex;

        flex-direction: column;

        gap: 0.35rem;

        font-weight: 600;

        color: #1f2a5b;

      }

      .employee-name-dialog input {

        border: 1px solid #cbd5f5;

        border-radius: 8px;

        padding: 0.6rem 0.75rem;

        font-size: 1rem;

      }

      .employee-name-actions {

        display: flex;

        justify-content: flex-end;

        gap: 0.5rem;

      }

      .employee-name-actions button {

        border: none;

        border-radius: 8px;

        padding: 0.5rem 0.9rem;

        font-weight: 600;

        cursor: pointer;

      }

      .employee-name-actions .secondary {

        background: #e5e7eb;

        color: #111827;

      }

      .employee-name-actions .primary {

        background: #2563eb;

        color: #fff;

      }

      body.mobile-mode {

        --control-scale: var(--mobile-scale, 0.7);

        --base-font-size: calc(16px * var(--mobile-scale, 0.7));

        overflow-x: hidden;

        display: flex;

        justify-content: center;

        font-size: var(--base-font-size);

        padding: 0.5rem;

        box-sizing: border-box;

        width: 100%;

      }

      body.mobile-mode > .container {

        width: 100%;

        max-width: 100%;

        min-width: 0;

        margin: 0;

        padding: 0 0.5rem;

        box-sizing: border-box;

      }

      h1,

      h2,

      h3,

      p,

      label,

      .field > span {

        font-size: calc(1rem * var(--control-scale, 1));

      }

      header h1 {

        font-size: calc(1.75rem * var(--control-scale, 1));

      }

      .card h2,

      .card h1 {

        font-size: calc(1.3rem * var(--control-scale, 1));

      }

      button,

      .btn,

      .upload-button {

        font-size: calc(1rem * var(--control-scale, 1));

      }

      .mobile-scale-row {

        display: flex;

        align-items: center;

        gap: 0.75rem;

        flex-wrap: wrap;

        margin-top: 0.4rem;

      }

      .mobile-scale-row small {

        font-weight: 600;

        color: #1f2937;

      }

      .mobile-scale-buttons {

        display: inline-flex;

        gap: 0.5rem;

      }

      .mobile-scale-buttons button {

        border: 1px solid #cbd5e1;

        background: #e5e7eb;

        border-radius: 50%;

        width: 44px;

        height: 44px;

        font-weight: 700;

        font-size: 1rem;

        cursor: pointer;

        display: inline-flex;

        align-items: center;

        justify-content: center;

        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);

      }

      .mobile-scale-debug {

        display: block;

        margin-top: 0.25rem;

        font-size: 0.85rem;

        color: #475569;

      }

      /* â”€â”€ Rotation lock popup â”€â”€ */

      .rotation-lock-popup {

        position: fixed;

        inset: 0;

        z-index: 3000;

        display: flex;

        align-items: center;

        justify-content: center;

        padding: 1.5rem;

        background: rgba(0, 0, 0, 0.6);

        backdrop-filter: blur(6px);

        -webkit-backdrop-filter: blur(6px);

        animation: fadeInPopup 0.3s ease;

      }

      .rotation-lock-popup[hidden] {

        display: none;

      }

      .rotation-lock-popup__card {

        background: #fff;

        border-radius: 20px;

        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.3);

        max-width: 340px;

        width: 100%;

        overflow: hidden;

        animation: slideUpPopup 0.35s ease;

      }

      .rotation-lock-popup__img {

        width: 100%;

        max-height: 280px;

        object-fit: cover;

        border-bottom: 1px solid #e5e7eb;

      }

      .rotation-lock-popup__body {

        padding: 1.25rem;

        text-align: center;

      }

      .rotation-lock-popup__title {

        margin: 0 0 0.5rem;

        font-size: 1.05rem;

        font-weight: 700;

        color: #1f2937;

      }

      .rotation-lock-popup__text {

        margin: 0 0 1rem;

        font-size: 0.9rem;

        color: #4b5563;

        line-height: 1.45;

      }

      .rotation-lock-popup__btn {

        display: inline-block;

        background: #2563eb;

        color: #fff;

        border: none;

        border-radius: 12px;

        padding: 0.65rem 2rem;

        font-size: 1rem;

        font-weight: 600;

        cursor: pointer;

        transition: background 0.2s;

      }

      .rotation-lock-popup__btn:hover {

        background: #1d4ed8;

      }

      @keyframes fadeInPopup {

        from { opacity: 0; }

        to { opacity: 1; }

      }

      @keyframes slideUpPopup {

        from { transform: translateY(30px); opacity: 0; }

        to { transform: translateY(0); opacity: 1; }

      }

      @media (max-width: 640px) {

        .signature-pad {

          max-width: 100%;

        }

        .signature-canvas-wrapper {

          min-height: 130px;

        }

        .signature-pad canvas {

          min-height: 130px;

          max-height: 160px;

        }

        .signature-overlay__panel {

          width: 100%;

          height: 100%;

          border-radius: 0;

        }

        .signature-overlay__actions {

          flex-wrap: wrap;

        }

      }

      @media (max-width: 640px) {

        .signature-pad {

          max-width: 100%;

        }

        .signature-canvas-wrapper {

          min-height: 130px;

        }

        .signature-pad canvas {

          min-height: 130px;

          max-height: 160px;

        }

        .signature-overlay__panel {

          width: 100%;

          height: 100%;

          border-radius: 0;

        }

        .signature-overlay__actions {

          flex-wrap: wrap;

        }

      }

      .footer-actions {

        display: flex;

        flex-direction: column;

        gap: 0.75rem;

      }

      .version-label {

        font-size: 0.85rem;

        color: #64748b;

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

      .admin-preview__frame canvas {

        width: 100%;

        height: auto;

        display: block;

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

      body[data-admin-window='true'] .container {

        display: none;

      }

      body[data-admin-window='true'] {

        background: #e5e7fb;

        overflow-y: auto;

      }

      body[data-admin-window='true'] .admin-modal {

        position: static;

        background: transparent;

        padding: 2rem;

      }

      body[data-admin-window='true'] .admin-modal__dialog {

        max-width: 960px;

        width: 100%;

        max-height: none;

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

      @media (max-width: 768px) {

        .employee-table-wrapper {

          overflow-x: visible;

        }

        .employee-table {

          min-width: 100%;

          table-layout: fixed;

        }

        .employee-table thead {

          display: none;

        }

        .employee-table tr {

          display: block;

          border: 1px solid #d9def8;

          border-radius: 10px;

          margin-bottom: 0.75rem;

          overflow: hidden;

        }

        .employee-table td {

          display: block;

          width: 100%;

          box-sizing: border-box;

          border: none;

          border-top: 1px solid #d9def8;

        }

        .employee-table td:first-child {

          border-top: none;

        }

        .employee-index-cell {

          width: 100%;

          min-width: 0;

        }

        .employee-person-fields {

          gap: 0.5rem;

        }

      }

    </style>

  </head>

  <body>

    <div class="container">

      <header>

        <button type="button" class="admin-launch" data-admin-open>Admin</button>

        <h1>PDF forms generator - v${SERVICE2_VERSION} Lin</h1>

        <p>Fill in the service visit details: site info, on-site team, checklists, parts, and signatures. Fields are blank so you can start from scratch.</p>

      </header>

      <form id="pm-form" enctype="multipart/form-data">

        <!-- Provenance: which client made this report and which build of it. Hidden because
             it is about the software, not about the visit - nobody should have to fill it in. -->
        <input type="hidden" name="submitted_via" value="${escapeHtml(SUBMITTED_VIA_WEB)}" />
        <input type="hidden" name="client_version" value="${escapeHtml(SERVICE2_CLIENT_VERSION)}" />

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

            <label class="field" style="max-width:360px">

              <span>Form type</span>

              <select name="template_type" data-template-type>

                <option value="service_report" selected>Service report</option>

                <option value="maintenance">Maintenance</option>

                <option value="daily_report">Daily report</option>

                <option value="installation_report">Installation report</option>

                <option value="calibration" disabled>Calibration (coming soon)</option>

              </select>

            </label>

            <label class="field" style="max-width:260px">

              <span>Mobile mode</span>

              <label class="checkbox" style="margin-top:8px; display:flex; align-items:center; gap:8px;">

                <input type="checkbox" data-mobile-mode />

                <span>Rotate signature + 70% scale</span>

              </label>

              <div class="mobile-scale-row">

                <small data-mobile-scale-label>Scale: 70%</small>

                <div class="mobile-scale-buttons">

                  <button type="button" data-mobile-scale-dec>-5%</button>

                  <button type="button" data-mobile-scale-inc>+5%</button>

                </div>

                <small class="mobile-scale-debug" data-mobile-scale-debug></small>

              </div>

            </label>

            <div class="template-details" data-template-info>

              <p data-template-status>Loading available templates...</p>

              <p class="template-description" data-template-description hidden></p>

              <a href="#" class="link-button" data-template-preview target="_blank" rel="noopener" hidden>Preview template</a>

            </div>

          </div>

        </section>

        <section class="card" data-form-types="daily_report">

          <h2>Daily report</h2>

          <div class="grid two-col">

${renderTextInput(DAILY_REPORT_FIELDS.projectNumber, 'Project number', { allowUnknown: true, required: true, listId: 'daily-project-number-list', listOptions: projectNumberOptions })}

${renderTextInput(DAILY_REPORT_FIELDS.reportDate, 'Report date', { type: 'date', allowUnknown: true, required: true })}

${renderTextInput(DAILY_REPORT_FIELDS.submitterName, 'Filled by', { allowUnknown: true, required: true, suggestField: 'employee_name' })}

          </div>

${renderTextInput(DAILY_REPORT_FIELDS.reportText, 'Report text', { textarea: true, type: 'textarea-lg', allowUnknown: true, placeholder: 'Describe progress, issues, and next steps' })}

        </section>

        <section class="card photos-card" data-form-types="daily_report">

          <h2>Daily report photos</h2>

          <div class="photo-slot" data-photo-slot="daily_photos">

            <span>Photo attachments</span>

            <p>Upload photos related to the daily report.</p>

            <label class="upload-button">

              <input type="file" name="daily_photos" accept="image/*" multiple data-photo-input="daily_photos" />

              Upload photos

            </label>

            <div class="photo-preview" data-photo-preview="daily_photos" data-photo-mode="multi" data-photo-label="Daily report photo" data-state="empty">

              <span>No files selected yet.</span>

            </div>

            <small>JPEG/PNG only, up to 20 images.</small>

          </div>

        </section>

        <section class="card" data-form-types="service_report,maintenance,installation_report">

          <h2>Site information</h2>

          <div class="grid two-col">

${renderTextInput('end_customer_name', 'End customer name')}

${renderTextInput('site_location', 'Site location')}

${renderTextInput('customer_representative', 'Contact person', { allowUnknown: true })}
<input type="hidden" name="attendee_client" id="attendee-client-hidden" data-form-types="service_report,maintenance" />

${renderTextInput('batch_number', 'LSC Project number')}

${renderTextInput('lsc_project_name', 'LSC project name', { allowUnknown: true, placeholder: 'What the customer calls this project, e.g. Hub Leipzig hall 3' })}

${renderTextInput('service_company_name', 'Service company name')}

${renderTextInput('date_of_service', 'Date of service', { type: 'date' })}

${renderTextInput('customer_phone', 'Phone', { type: 'tel', allowUnknown: true })}

${renderTextInput('customer_email', 'Email', { type: 'email', allowUnknown: true })}

          </div>

        </section>

        <section class="card" data-form-types="service_report,maintenance,installation_report">

          <h2>Display model</h2>


<!-- Wherever the document talks about the display, the engineer picks its model here —
     acceptance certificates name the installed display too, so this belongs on the
     installation form as well (only the daily report has no use for it). -->
<div class="field" data-form-types="service_report,maintenance,installation_report">
  <label for="led-code-select">LED model picker (type &rarr; number)</label>
  <div style="display:flex;gap:8px;">
    <select id="led-code-select" style="flex:1;min-width:0;">
      <option value="">Type&hellip;</option>
      ${ledCodeGroups().map((g) => `<option value="${escapeHtml(g.code)}">${escapeHtml(g.code)}</option>`).join('')}
    </select>
    <select id="led-number-select" style="flex:1;min-width:0;" disabled>
      <option value="">Model No.&hellip;</option>
    </select>
  </div>
</div>
<!-- led_display_model is derived from the picker above; kept as a hidden field so the
     user does not re-enter the same value (was a visible duplicate). -->
<input type="hidden" name="led_display_model" id="led-display-model-hidden" />
<script>
(function () {
  var CAT = ${JSON.stringify(ledCodeGroups())};
  function init() {
    var cs = document.getElementById('led-code-select');
    var ns = document.getElementById('led-number-select');
    var input = document.querySelector('input[name="led_display_model"]');
    if (!cs || !ns || !input) return;
    cs.addEventListener('change', function () {
      ns.innerHTML = '<option value="">Model No.\\u2026</option>';
      var g = null;
      for (var i = 0; i < CAT.length; i++) { if (CAT[i].code === cs.value) { g = CAT[i]; break; } }
      if (!g) { ns.disabled = true; return; }
      g.numbers.forEach(function (n) {
        var o = document.createElement('option');
        o.value = n.model;
        o.textContent = n.label || n.number;
        ns.appendChild(o);
      });
      ns.disabled = false;
    });
    ns.addEventListener('change', function () {
      if (!ns.value) return;
      input.value = ns.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
</script>

        </section>


        <section class="card" data-form-types="installation_report">

          <h2>Acceptance details</h2>

          <div class="grid two-col">

${renderTextInput('customer_company', 'Client company', { allowUnknown: true, id: 'customer-company-acceptance', placeholder: 'The company accepting the work' })}

${renderTextInput('completion_date', 'Completion date', { type: 'date', allowUnknown: true })}

${renderTextInput('acceptance_date', 'Acceptance date', { type: 'date', allowUnknown: true })}

${renderTextInput('acceptance_location', 'Acceptance location', { allowUnknown: true, placeholder: 'Defaults to the site address - change it if the handover was somewhere else' })}

          </div>

          <p>Who was present at the handover. Names of people, not companies - these two go under "Attendees" on the document and above the signature boxes.</p>

          <div class="grid two-col">

${renderTextInput('attendee_client', 'For the client', { allowUnknown: true, placeholder: 'Who attended for the client, e.g. Marcus Janker' })}

${renderTextInput('attendee_supplier', 'For the supplier', { allowUnknown: true, placeholder: 'Who attended for us, e.g. Vladimir Linart' })}

          </div>

        </section>

        <section class="card" data-form-types="installation_report">

          <h2>What is being accepted</h2>

          <p>A part accepted on its own starts its own warranty, so tick it only when that part of the project is genuinely finished and handed over.</p>

          <div class="grid two-col">

            <label class="checkbox"><input type="checkbox" name="acceptance_overall" /> <span>The whole agreed project</span></label>

            <label class="checkbox"><input type="checkbox" name="acceptance_partial" /> <span>Only a finished part of the project, accepted on its own</span></label>

          </div>

${renderTextInput('partial_services', 'Which part of the project', { textarea: true, allowUnknown: true, placeholder: 'Name the finished part being accepted, e.g. the main wall only' })}

        </section>

        <section class="card" data-form-types="installation_report">

          <h2>Installation status</h2>

          <label class="field">

            <span>Was the installation finished completely?</span>

            <select name="installation_status">

              <option value="">-- select --</option>

              <option value="fully_finished">Yes, installation finished completely</option>

              <option value="not_finished">No, not fully finished</option>

            </select>

          </label>

${renderTextInput('installation_partial_notes', 'What is still outstanding (if not fully finished)', { textarea: true, allowUnknown: true })}

          <p>If anything is still open, agree here and now when it will be done - this is the date the customer is signing up to.</p>

          <div class="grid two-col">

            <label class="field">

              <span>How urgent</span>

              <select name="installation_followup_type">

                <option value="">-- select --</option>

                <option value="urgent">Fix urgently</option>

                <option value="planned">Planned completion</option>

              </select>

            </label>

${renderTextInput('installation_followup_date', 'To be completed no later than', { type: 'date', allowUnknown: true })}

          </div>

          <label class="checkbox"><input type="checkbox" name="installation_has_defects" data-annex-toggle /> <span>List the defects and remaining activities in Annex 1</span></label>

        </section>

        <section class="card" data-form-types="installation_report">

          <h2>Annex 1 - defects and remaining activities</h2>

          <p>Filled in only when the box above is ticked. Printed on a separate page, with the completion date, so it can be handed over on its own.</p>

${renderTextInput('installation_defects', 'Defects', { textarea: true, allowUnknown: true })}

${renderTextInput('installation_remaining', 'Remaining activities', { textarea: true, allowUnknown: true })}

        </section>

        <section class="card" data-form-types="installation_report">

          <h2>Warranty</h2>

          <p>The end date is calculated from the start date and the number of years - it is not asked for twice.</p>

          <div class="grid two-col">

${renderTextInput('warranty_years', 'Warranty (years)', { type: 'number', allowUnknown: true })}

${renderTextInput('warranty_start_date', 'Warranty begins on', { type: 'date', allowUnknown: true })}

          </div>

          <p data-warranty-end-preview></p>

        </section>

        <section class="card" data-form-types="installation_report">

          <h2>Customer declares</h2>

          <p>Printed verbatim above the signatures. The same four wordings the app offers, so a report says the same thing whichever side filled it in.</p>

          <label class="field">

            <span>Acceptance statement</span>

            <select name="acceptance_statement">

              <option value="Acceptance has taken place." selected>Acceptance has taken place.</option>

              <option value="Acceptance takes effect once the listed defects are fully remedied.">Acceptance takes effect once the listed defects are fully remedied.</option>

              <option value="Acceptance is refused due to significant defects.">Acceptance is refused due to significant defects.</option>

              <option value="Acceptance is made under the conditions set out in Annex 1.">Acceptance is made under the conditions set out in Annex 1.</option>

            </select>

          </label>

        </section>

        <section class="card employee-card" data-employees-section data-employee-max="${EMPLOYEE_MAX_COUNT}" data-form-types="service_report,maintenance">

          <h2>On-site team time sheet</h2>

          <p>Record everyone working on site to keep automatic time & break totals. The first employee becomes the document signer.</p>

          <div class="employee-actions">

            <button type="button" class="button" data-action="employee-add">+ Add employee</button>

            <small>Defaults use the moment you opened this form; fine-tune via manual input or +/-30m shortcuts.</small>

            <label class="checkbox">
              <input type="checkbox" name="breaks_enabled" data-breaks-toggle />
              <span>Calculate mandatory breaks</span>
            </label>

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

                    <input type="text" data-field="name" placeholder="Full name" autocomplete="off" data-suggest-field="employee_name" list="suggest-employee-name" />

                  </label>

                  <label class="field" data-field-wrapper="role">

                    <span>Role / position</span>

                    <input type="text" data-field="role" placeholder="Role on site" autocomplete="off" data-suggest-field="employee_role" list="suggest-employee-role" />

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
                      <button type="button" class="time-shortcut" data-action="employee-add-day" title="Add another work day">+ Day</button>

                    </div>

                  </div>

                  <input type="hidden" data-field="departure" />
                  <input type="hidden" data-field="group" />

                </div>

              </td>

            </tr>

          </template>

          <datalist id="suggest-employee-name" data-suggest-list="employee_name"></datalist>

          <datalist id="suggest-employee-role" data-suggest-list="employee_role"></datalist>

          <script>
          (function () {
            // Person autofill: picking a known name fills the paired role (on-site team)
            // or company (engineer/customer) from that person's last form â€” so a worker
            // only types their name and the rest is filled in. Never overwrites edits.
            var PMAP = {};
            // The form is served at / in development and behind /service2/ in production,
            // so an absolute /api/... path 404s on prod only - invisible in local testing.
            // Resolve against the page's own directory instead.
            function apiUrl(p) {
              var dir = window.location.pathname.replace(/[^/]*$/, '');
              if (dir.charAt(dir.length - 1) !== '/') dir += '/';
              var rel = String(p);
              while (rel.charAt(0) === '/') rel = rel.slice(1);
              return dir + rel;
            }
            function pkey(s) { return String(s || '').trim().toLowerCase(); }
            function loadPeople() {
              fetch(apiUrl('api/people'), { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                  if (!d || !d.ok || !Array.isArray(d.people)) return;
                  d.people.forEach(function (p) { if (p && p.name) PMAP[pkey(p.name)] = p; });
                })
                .catch(function () {});
            }
            function setIfEmpty(el, val) {
              if (el && val && !String(el.value || '').trim()) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
            function autofill(input) {
              var p = PMAP[pkey(input.value)];
              if (!p) return;
              if (input.getAttribute('data-suggest-field') === 'employee_name') {
                var box = input.closest('.employee-person-fields, .employee-name-dialog, tr') || input.parentElement;
                var roleEl = box && box.querySelector('[data-suggest-field="employee_role"]');
                if (p.role) setIfEmpty(roleEl, p.role);
              } else if (input.name === 'engineer_name') {
                if (p.company) setIfEmpty(document.querySelector('[name="engineer_company"]'), p.company);
              } else if (input.name === 'customer_name' || input.name === 'customer_representative') {
                if (p.company) setIfEmpty(document.querySelector('[name="customer_company"]'), p.company);
              }
            }
            // The client is named once at the top (End customer name) â€” mirror it into the
            // Signatures "Customer company" so it is not entered twice.
            function syncCustomerCompany() {
              var ecn = document.querySelector('[name="end_customer_name"]');
              var cc = document.querySelector('[name="customer_company"]');
              if (ecn && cc && String(ecn.value || '').trim()) setIfEmpty(cc, String(ecn.value).trim());
            }
            document.addEventListener('change', function (e) {
              var t = e.target;
              if (!t) return;
              if (t.name === 'end_customer_name') { syncCustomerCompany(); return; }
              if (t.tagName !== 'INPUT') return;
              if (t.getAttribute('data-suggest-field') === 'employee_name'
                  || t.name === 'engineer_name' || t.name === 'customer_name' || t.name === 'customer_representative') {
                autofill(t);
              }
            }, true);
            function boot() { loadPeople(); syncCustomerCompany(); }
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
            else boot();
          })();
          </script>

        </section>

        <section class="card" data-form-types="service_report">

          <h2>Service summary</h2>



${renderTextInput('problem_description', 'Problem description', { textarea: true, type: 'textarea-lg', allowUnknown: true })}

${renderTextInput('work_performed', 'Work performed', { textarea: true, type: 'textarea-lg', allowUnknown: true })}

${renderTextInput('recommendations', 'Recommendations', { textarea: true, type: 'textarea-lg', allowUnknown: true })}

        </section>

${partsTable({ isService: true, dataAttr: 'service_report' })}

${renderChecklistSection('Equipment condition check', SERVICE_EQUIPMENT_ROWS, { dataFormTypes: 'service_report', allowUnknown: true })}

${CHECKLIST_SECTIONS.map((section) => renderChecklistSection(section.title, section.rows, { dataFormTypes: 'maintenance' })).join('\n')}

        <section class="card" data-form-types="service_report,maintenance,installation_report">

          <div data-form-types="service_report">

            <h2>Customer comments</h2>

${renderTextInput('customer_comments', 'Customer comments', { textarea: true, type: 'textarea-lg', placeholder: 'Add customer feedback', allowUnknown: true })}

          </div>

          <div data-form-types="maintenance">

            <h2>Additional notes</h2>

${renderTextInput('general_notes', 'Overall notes', { textarea: true, type: 'textarea-lg', placeholder: 'Record any observations or follow-up actions' })}

          </div>

        </section>

        <section class="card photos-card" data-form-types="service_report,maintenance">

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

        <section class="card photos-card" data-form-types="installation_report">

          <h2>Installation photos (optional)</h2>

          <div class="photo-slot" data-photo-slot="photo_defects">

            <span>Defect photos</span>

            <p>Upload up to 20 images that show existing defects.</p>

            <label class="upload-button">

              <input type="file" name="photo_defects" accept="image/*" multiple data-photo-input="photo_defects" />

              Upload defect photos

            </label>

            <div class="photo-preview" data-photo-preview="photo_defects" data-photo-mode="multi" data-photo-label="Defect photo" data-state="empty">

              <span>No files selected yet.</span>

            </div>

            <small>JPEG/PNG only, up to 20 images.</small>

          </div>

          <div class="photo-slot" data-photo-slot="photo_installation">

            <span>Installation photos</span>

            <p>Upload up to 20 images that show the completed installation.</p>

            <label class="upload-button">

              <input type="file" name="photo_installation" accept="image/*" multiple data-photo-input="photo_installation" />

              Upload installation photos

            </label>

            <div class="photo-preview" data-photo-preview="photo_installation" data-photo-mode="multi" data-photo-label="Installation photo" data-state="empty">

              <span>No files selected yet.</span>

            </div>

            <small>JPEG/PNG only, up to 20 images.</small>

          </div>

        </section>

${partsTable({ dataAttr: 'maintenance' })}

${spareStockTable('maintenance,installation_report')}

${renderChecklistSection('Sign off checklist', SIGN_OFF_CHECKLIST_ROWS, { dataFormTypes: 'maintenance' })}



        <section class="card" data-form-types="service_report,maintenance,installation_report">

          <h2>Signatures</h2>

          <div class="grid two-col signature-info">

            <!-- Engineer/customer date & time removed: the visit is already dated by
                 "Date of service" at the top, and asking for it again here produced two
                 dates on one document that could disagree. -->
            ${renderTextInput('engineer_company', 'On-site engineer company')}

            ${renderTextInput('engineer_name', 'Engineer name')}

            ${renderTextInput('customer_company', 'Customer company', { id: 'customer-company-signoff', dataFormTypes: 'service_report,maintenance' })}

            ${renderTextInput('customer_name', 'Customer representative(s)', {
              allowUnknown: true,
              placeholder: 'List representatives (comma-separated)',
            })}

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

          <span class="version-label" data-app-version></span>

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

              <canvas data-admin-preview-canvas aria-label="Template preview"></canvas>

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

   <script src="/service2/vendor/pdfjs/pdf.min.js"></script>

    <script>

      (function () {

        const formEl = document.getElementById('pm-form');

        if (!formEl) return;



        const statusEl = document.getElementById('status');
        const APP_VERSION = '${SERVICE2_VERSION}';
        const versionLabel = document.querySelector('[data-app-version]');
        if (versionLabel) {
          versionLabel.textContent = 'Version ' + APP_VERSION;
        }

        const submitButton = formEl.querySelector('button[type="submit"]');

        const uploadProgressEl = document.querySelector('[data-upload-progress]');

        const uploadProgressBarEl = document.querySelector('[data-upload-progress-bar]');

        const uploadProgressLabelEl = document.querySelector('[data-upload-progress-label]');

        const uploadFilesSummaryEl = document.querySelector('[data-upload-files]');

        let debugToggleEls = Array.from(document.querySelectorAll('[data-debug-toggle]'));

        const debugPanelEl = document.querySelector('[data-debug-panel]');

        const debugLogEl = document.querySelector('[data-debug-log]');

        const DEBUG_KEY = 'pm-form-debug-enabled';

        const MOBILE_MODE_KEY = 'pm-form-mobile-mode';

        const MOBILE_SCALE_KEY = 'pm-form-mobile-scale';

        let debugState = { enabled: false, timeline: [] };

        const templateSelectEl = document.querySelector('[data-template-select]');

        const templateSlugInput = document.querySelector('[data-template-slug]');

        const templateInfoEl = document.querySelector('[data-template-info]');

        const templateStatusEl = templateInfoEl ? templateInfoEl.querySelector('[data-template-status]') : null;

        const templateDescriptionEl = templateInfoEl

          ? templateInfoEl.querySelector('[data-template-description]')

          : null;

        const templatePreviewLink = templateInfoEl ? templateInfoEl.querySelector('[data-template-preview]') : null;

        const formTypeSelectEl = document.querySelector('[data-template-type]');

        const mobileModeToggle = document.querySelector('[data-mobile-mode]');

        const mobileScaleLabel = document.querySelector('[data-mobile-scale-label]');

        const mobileScaleDecBtn = document.querySelector('[data-mobile-scale-dec]');

        const mobileScaleIncBtn = document.querySelector('[data-mobile-scale-inc]');

        const mobileScaleDebug = document.querySelector('[data-mobile-scale-debug]');

        const partsOcrButton = document.querySelector('[data-parts-ocr]');

        const partsOcrInput = document.querySelector('[data-parts-ocr-input]');

        const partsOcrStatus = document.querySelector('[data-parts-ocr-status]');

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

          : null;

        const adminUploadDescriptionInput = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-upload-description]')

          : null;

        const adminTemplateListEl = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-template-list]')

          : null;



        const isMobileMode = () => {

          return mobileModeToggle ? mobileModeToggle.checked : false;

        };



        const clampScale = (val) => {

          const num = Number(val);

          if (!Number.isFinite(num)) return 0.7;

          return Math.min(1.0, Math.max(0.4, num));

        };



        const updateMobileScaleLabel = (scale) => {

          if (mobileScaleLabel) {

            mobileScaleLabel.textContent = 'Scale: ' + Math.round(scale * 100) + '%';

          }

          if (mobileScaleDebug) {

            const container = document.querySelector('.container');

            const rect = container ? container.getBoundingClientRect() : null;

            const appliedScale = getComputedStyle(document.body).getPropertyValue('--mobile-scale').trim() || scale;

            mobileScaleDebug.textContent =

              'Applied: ' +

              appliedScale +

              ' | rect: ' +

              (rect ? Math.round(rect.width) + 'px' : 'n/a') +

              ' / viewport ' +

              Math.round(window.innerWidth) +

              'px';

          }

        };



        const getContainerRect = () => {

          const container = document.querySelector('.container');

          const rect = container ? container.getBoundingClientRect() : null;

          return rect

            ? { width: Math.round(rect.width), height: Math.round(rect.height) }

            : { width: null, height: null };

        };



        const applyMobileMode = (enabled, overrideScale) => {

          const scale = clampScale(overrideScale !== undefined ? overrideScale : window.localStorage.getItem(MOBILE_SCALE_KEY) || 0.7);

          document.body.style.setProperty('--mobile-scale', scale);

          updateMobileScaleLabel(scale);

          const rect = getContainerRect();

          const info = {

            enabled,

            scale,

            rect,

            viewport: { width: window.innerWidth, height: window.innerHeight },

          };

          console.log('[mobile-scale]', info);

          if (enabled) {

            document.body.classList.add('mobile-mode');

            window.localStorage.setItem(MOBILE_MODE_KEY, '1');

            window.localStorage.setItem(MOBILE_SCALE_KEY, String(scale));

          } else {

            document.body.classList.remove('mobile-mode');

            window.localStorage.removeItem(MOBILE_MODE_KEY);

          }

        };



        if (mobileModeToggle) {

          const storedMobile = window.localStorage.getItem(MOBILE_MODE_KEY);

          const storedScale = clampScale(window.localStorage.getItem(MOBILE_SCALE_KEY) || 0.7);

          mobileModeToggle.checked = storedMobile === '1';

          applyMobileMode(mobileModeToggle.checked, storedScale);

          mobileModeToggle.addEventListener('change', (event) => {

            applyMobileMode(event.target.checked);

            if (event.target.checked) {

              showRotationLockPopup();

            }

          });

          function showRotationLockPopup() {

            let popup = document.querySelector('.rotation-lock-popup');

            if (popup) { popup.hidden = false; return; }

            popup = document.createElement('div');

            popup.className = 'rotation-lock-popup';

            popup.innerHTML =

              '<div class="rotation-lock-popup__card">' +

              '<img class="rotation-lock-popup__img" src="rotation-lock-hint.png" alt="Enable rotation lock" />' +

              '<div class="rotation-lock-popup__body">' +

              '<h3 class="rotation-lock-popup__title">ðŸ“± Enable Rotation Lock</h3>' +

              '<p class="rotation-lock-popup__text">' +

              'For the best experience, please lock your screen orientation.<br>' +

              'Open <b>Control Center</b> and tap the <b>rotation lock</b> button.' +

              '</p>' +

              '<button type="button" class="rotation-lock-popup__btn" data-rotation-ok>OK, got it</button>' +

              '</div></div>';

            document.body.appendChild(popup);

            popup.querySelector('[data-rotation-ok]').addEventListener('click', () => {

              popup.hidden = true;

            });

            popup.addEventListener('click', (e) => {

              if (e.target === popup) {

                popup.hidden = true;

              }

            });

          }

          const adjustScale = (delta) => {

            const current = clampScale(document.body.style.getPropertyValue('--mobile-scale') || storedScale);

            const next = clampScale(current + delta);

            if (mobileModeToggle && !mobileModeToggle.checked) {

              mobileModeToggle.checked = true;

            }

            applyMobileMode(mobileModeToggle ? mobileModeToggle.checked : true, next);

          };

          if (mobileScaleDecBtn) {

            mobileScaleDecBtn.addEventListener('click', (event) => {

              event.preventDefault();

              adjustScale(-0.05);

            });

          }

          if (mobileScaleIncBtn) {

            mobileScaleIncBtn.addEventListener('click', (event) => {

              event.preventDefault();

              adjustScale(0.05);

            });

          }

        } else {

          updateMobileScaleLabel(0.7);

        }



        window.pmTools = {

          setMobile: (enabled = true, scale = 0.7) => {

            if (mobileModeToggle) mobileModeToggle.checked = !!enabled;

            applyMobileMode(enabled, scale);

            console.log('[pmTools] setMobile', { enabled, scale });

          },

          logSizes: () => {

            const rect = getContainerRect();

            const scale =

              getComputedStyle(document.body).getPropertyValue('--mobile-scale').trim() || 'n/a';

            const mobile = isMobileMode();

            const viewport = { width: window.innerWidth, height: window.innerHeight };

            console.log('[pmTools] sizes', { mobile, scale, rect, viewport });

            return { mobile, scale, rect, viewport };

          },

        };





        const applyFormTypeVisibility = (formType) => {

          const type = formType || (formTypeSelectEl ? formTypeSelectEl.value : '');

          const targets = Array.from(document.querySelectorAll('[data-form-types]'));

          targets.forEach((el) => {

            const allowed = (el.getAttribute('data-form-types') || '')

              .split(',')

              .map((s) => s.trim())

              .filter(Boolean);

            const shouldShow = allowed.length === 0 || allowed.includes(type);

            el.hidden = !shouldShow;

            el.style.display = shouldShow ? '' : 'none';

            const inputs = el.querySelectorAll('input, select, textarea, button');

            inputs.forEach((node) => {

              if (node.hasAttribute('data-admin-open') || node.hasAttribute('data-admin-close')) return;

              node.disabled = !shouldShow;

            });

          });

          // The shared block asks for one date, but an installation runs over days, so the
          // document calls its first date a start date. The form has to say the same thing.
          const serviceDateLabel = document.querySelector('label[for="field-date-of-service"] > span')
            || document.querySelector('input[name="date_of_service"]')?.closest('label')?.querySelector('span');

          if (serviceDateLabel) {

            serviceDateLabel.textContent =
              type === 'installation_report' ? 'Installation start date' : 'Date of service';

          }

        };

        if (formTypeSelectEl) {

          formTypeSelectEl.addEventListener('change', (event) => {

            applyFormTypeVisibility(event.target.value);

          });

          applyFormTypeVisibility(formTypeSelectEl.value);

        } else {

          applyFormTypeVisibility();

        }



        // The warranty end is arithmetic, so the form shows it instead of asking for it —
        // the server computes the same value when it renders the document.
        const warrantyYearsInput = formEl.querySelector('input[name="warranty_years"]');

        const warrantyStartInput = formEl.querySelector('input[name="warranty_start_date"]');

        const warrantyEndPreview = formEl.querySelector('[data-warranty-end-preview]');



        const parseIsoDate = (value) => {

          if (!value || typeof value !== 'string') return null;

          const parts = value.split('-').map((p) => Number(p));

          if (parts.length !== 3) return null;

          const [year, month, day] = parts;

          if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;

          const date = new Date(Date.UTC(year, month - 1, day));

          if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {

            return null;

          }

          return date;

        };



        const updateWarrantyEnd = () => {

          if (!warrantyEndPreview) return;

          const baseDate = warrantyStartInput ? parseIsoDate(warrantyStartInput.value) : null;

          const years = warrantyYearsInput ? Number(warrantyYearsInput.value) : NaN;

          if (!baseDate || !Number.isFinite(years) || !warrantyYearsInput.value) {

            warrantyEndPreview.textContent = '';

            return;

          }

          const target = new Date(baseDate.getTime());

          target.setUTCFullYear(target.getUTCFullYear() + years);

          const pad = (n) => String(n).padStart(2, '0');

          const shown = pad(target.getUTCDate()) + '.' + pad(target.getUTCMonth() + 1) + '.' + target.getUTCFullYear();

          warrantyEndPreview.textContent = 'Warranty ends on ' + shown;

        };



        [warrantyYearsInput, warrantyStartInput].forEach((input) => {

          if (input) input.addEventListener('input', updateWarrantyEnd);

        });

        updateWarrantyEnd();



        // The handover is almost always at the site, so the acceptance location follows the
        // site address until someone types their own. Tracking "still the copy" rather than
        // "is empty" means clearing the field on purpose is respected instead of refilled.
        const siteLocationInput = formEl.querySelector('[name="site_location"]');

        const acceptanceLocationInput = formEl.querySelector('[name="acceptance_location"]');

        if (siteLocationInput && acceptanceLocationInput) {

          let acceptanceLocationOwned = String(acceptanceLocationInput.value || '').trim() !== '';

          acceptanceLocationInput.addEventListener('input', () => {

            acceptanceLocationOwned = true;

          });

          const mirrorSiteLocation = () => {

            if (acceptanceLocationOwned) return;

            acceptanceLocationInput.value = siteLocationInput.value;

          };

          siteLocationInput.addEventListener('input', mirrorSiteLocation);

          siteLocationInput.addEventListener('change', mirrorSiteLocation);

          mirrorSiteLocation();

        }



        const findActivePartsSection = () => {

          const sections = Array.from(document.querySelectorAll('[data-parts-section]'));

          return sections.find((section) => !section.hidden && section.style.display !== 'none') || null;

        };



        const findActivePartsTable = () => {

          const section = findActivePartsSection();

          if (!section) return null;

          return section.querySelector('[data-parts-table]');

        };



        const findFirstVisiblePartsRow = () => {

          const table = findActivePartsTable();

          if (!table) return null;

          const rows = Array.from(table.querySelectorAll('tbody tr')).filter((r) => !r.classList.contains('is-hidden-row'));

          // Fill the last open row (normally the one just added)

          return rows.length ? rows[rows.length - 1] : null;

        };



        const loadTesseract = () =>

          new Promise((resolve, reject) => {

            if (window.Tesseract) return resolve(window.Tesseract);

            const script = document.createElement('script');

            script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/tesseract.min.js';

            script.onload = () => resolve(window.Tesseract);

            script.onerror = () => reject(new Error('Failed to load Tesseract.js'));

            document.head.appendChild(script);

          });

        const loadZxing = () =>

          new Promise((resolve, reject) => {

            if (window.ZXing) return resolve(window.ZXing);

            const script = document.createElement('script');

            script.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js';

            script.onload = () => resolve(window.ZXing);

            script.onerror = () => reject(new Error('Failed to load ZXing'));

            document.head.appendChild(script);

          });

        const readFileAsDataUrl = (file) =>

          new Promise((resolve, reject) => {

            const reader = new FileReader();

            reader.onload = () => resolve(reader.result);

            reader.onerror = () => reject(new Error('Failed to read file'));

            reader.readAsDataURL(file);

          });



        
        const callPaddleOcr = async (dataUrl) => {
          const base64 = (dataUrl || '').split(',').pop();
          if (!base64) throw new Error('Unable to read image.');
          const response = await fetch(buildAppUrl('api/ocr/paddle'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64 }),
          });
          let payload = {};
          try {
            payload = await response.json();
          } catch (err) {
            payload = {};
          }
          if (!response.ok) {
            const message = (payload && payload.error) || response.statusText || 'Paddle OCR failed';
            throw new Error(message);
          }
          const textResult = payload && typeof payload.text === 'string' ? payload.text : '';
          return textResult.trim();
        };

        const setPartsOcrStatus = (msg, isError = false) => {

          const section = findActivePartsSection();

          const statusEl = (section && section.querySelector('[data-parts-ocr-status]')) || partsOcrStatus;

          if (!statusEl) return;

          statusEl.textContent = msg || '';

          statusEl.style.color = isError ? '#c1121f' : '#475569';

        };



        const parseOcrText = (text) => {

          const STOP_WORDS = new Set([

            'DATE',

            'TIME',

            'TOTAL',

            'PRICE',

            'CASH',

            'EUR',

            'USD',

            'TAX',

            'QTY',

            'ITEM',

            'SN',

            'S/N',

            'SERIAL',

            'MODEL',

            'REF',

            'ORDER',

          ]);



          const lines = text

            .split('\\n')

            .map((l) => l.trim())

            .filter(Boolean);


          const regexModelCandidate = (() => {
            const m1 = text.match(/FA\\d+[A-Z0-9]*/i);
            if (m1) return m1[0].toUpperCase();
            const m2 = text.match(/LED-[A-Z0-9]+/i);
            if (m2) return m2[0].toUpperCase();
            return '';
          })();



          const normalizeToken = (t) =>

            t

              .replace(/[^A-Za-z0-9/-]/g, ' ')

              .replace(/\\s+/g, ' ')

              .trim();



          const rawTokens = text

            .split(/\\s+/)

            .map(normalizeToken)

            .map((t) => t.replace(/\\s+/g, ''))

            .filter(Boolean);



          const tokens = rawTokens.map((t) => t.toUpperCase());
          const tokensWithCombos = [...tokens];
          for (let i = 0; i < tokens.length - 1; i += 1) {
            const joined = tokens[i] + tokens[i + 1];
            if (
              joined.length >= 7 &&
              joined.length <= 24 &&
              /[A-Z]/.test(joined) &&
              /[0-9]/.test(joined)
            ) {
              tokensWithCombos.push(joined);
            }
          }



          const tokenScore = (value) => {

            const v = value || '';

            if (STOP_WORDS.has(v)) return -5;

            let score = 0;

            if (/[A-Z]/.test(v) && /[0-9]/.test(v)) score += 4;

            if (v.includes('-') || v.includes('/')) score += 1;

            if (v.length >= 6 && v.length <= 18) score += 3;

            if (v.length > 18) score -= 2;

            if (v.length < 5) score -= 2;

            const uniqueChars = new Set(v.split(''));

            score += Math.min(uniqueChars.size, 5) * 0.2;

            return score;

          };



          const looksLikeModel = (value) => {

            if (!value) return false;

            if (/^LED-[A-Z0-9]{3,}$/i.test(value)) return true;

            if (/^FA\\d+[A-Z0-9]*$/i.test(value)) return true;

            return false;

          };



          const scoredTokens = tokensWithCombos

            .map((t, idx) => ({ t, idx, score: tokenScore(t) }))

            .filter((s) => s.score > 0)

            .sort((a, b) => b.score - a.score);



          let model = '';

          let modelIndex = -1;

          const modelCandidate = scoredTokens.find((s) => looksLikeModel(s.t));

          if (regexModelCandidate) {

            model = regexModelCandidate;

            modelIndex = tokens.findIndex((t) => t.includes(regexModelCandidate));

          } else if (modelCandidate) {

            model = modelCandidate.t;

            modelIndex = modelCandidate.idx;

          } else {

            const lineModel = lines

              .map((l) => normalizeToken(l).toUpperCase())

              .find((l) => looksLikeModel(l.replace(/\\s+/g, '')));

            if (lineModel) model = lineModel.replace(/\\s+/g, '');

          }

          const serialRegexes = [
            /\\b\\d{2}[A-Z0-9]{6,18}T?\\b/,
            /\\b\\d{8,10}T?\\b/,
          ];

          const pickSerialFromRegex = (values) => {
            const candidates = [];
            values.forEach((value) => {
              serialRegexes.forEach((regex) => {
                const match = String(value || '').toUpperCase().match(regex);
                if (match && match[0]) candidates.push(match[0]);
              });
            });
            if (!candidates.length) return '';
            const unique = Array.from(new Set(candidates));
            const withTrailingT = unique.filter((v) => v.endsWith('T'));
            const pool = withTrailingT.length ? withTrailingT : unique;
            pool.sort((a, b) => b.length - a.length);
            return pool[0];
          };

          const regexSerial = pickSerialFromRegex(tokensWithCombos);



          const pickSerial = (list, startIdx = 0) => {

            const candidates = list.filter(

              (s) =>

                s.idx >= startIdx &&

                /[0-9]/.test(s.t) &&

                s.t.replace(/[^A-Z0-9]/gi, '').length >= 7,

            );

            if (!candidates.length) return '';

            return candidates[0].t;

          };



          let serialCandidate = regexSerial || pickSerial(scoredTokens, modelIndex >= 0 ? modelIndex + 1 : 0);

          if (!serialCandidate) serialCandidate = pickSerial(scoredTokens, 0);



          const extractBatch = (serial) => {

            if (!serial) return '';

            const cleaned = serial.replace(/[^A-Z0-9]/gi, '').toUpperCase();

            const letterDigit3 = cleaned.match(/[A-Z][0-9]{2}/);

            if (letterDigit3) return letterDigit3[0];

            const digitLetter2 = cleaned.match(/[0-9]{2}[A-Z]/);

            if (digitLetter2) return digitLetter2[0];

            const digitsOnly = cleaned.replace(/[^0-9]/g, '');
            if (digitsOnly.length >= 8 && digitsOnly.length <= 12) {
              return digitsOnly.slice(2, 5);
            }

            if (digitsOnly.length >= 3) {

              const midStart = Math.max(0, Math.floor(digitsOnly.length / 2) - 1);

              return digitsOnly.slice(midStart, midStart + 3);

            }



            if (cleaned.length >= 5) return cleaned.slice(0, 5);

            if (cleaned.length >= 3) return cleaned.slice(0, 3);

            return '';

          };



          const batch = extractBatch(serialCandidate);



          const topCandidates = scoredTokens.slice(0, 3).map((c) => c.t);



          return { model, serial: serialCandidate, batch, candidates: topCandidates };

        };



        const fillPartsFromOcr = (parsed) => {

          const row = findFirstVisiblePartsRow();

          if (!row) return false;

          const formType = formTypeSelectEl ? formTypeSelectEl.value : '';

          const isServiceForm = formType === 'service_report';

          const safeModel = parsed.model || '';

          const safeBatch = parsed.batch || '';

          const safeSerial = parsed.serial || '';

          const combinedModelBatch = safeModel && safeBatch ? safeModel + '/' + safeBatch : safeModel;

          if (isServiceForm) {

            const partInput = row.querySelector('input[name^="parts_used_part_"]');

            if (partInput && combinedModelBatch) partInput.value = combinedModelBatch;

            const descInput = row.querySelector('input[name^="parts_removed_desc_"]');

            if (descInput && safeSerial && !descInput.value.trim()) descInput.value = safeSerial;

            const reasonInput = row.querySelector('input[name^="parts_used_serial_"]');

            if (reasonInput && safeSerial && !reasonInput.value.trim() && !descInput?.value.trim()) {

              reasonInput.value = safeSerial;

            }

          } else {

            if (parsed.serial) {

              const serialInput = row.querySelector('input[name^="parts_used_serial_"]');

              if (serialInput) serialInput.value = safeSerial;

            }

            if (parsed.model) {

              const partInput = row.querySelector('input[name^="parts_used_part_"]');

              if (partInput) partInput.value = safeModel;

            }

            const batchDescInput = row.querySelector('input[name^="parts_removed_desc_"]');

            if (safeBatch && batchDescInput && !batchDescInput.value.trim()) {

              batchDescInput.value = safeBatch;

            }

          }

          const ledField = document.querySelector('input[name="led_display_model"]');

          const combined = safeModel && safeBatch ? safeModel + '/' + safeBatch : safeModel || '';

          if (ledField && combined) {

            const current = ledField.value ? ledField.value.split(',').map((s) => s.trim()).filter(Boolean) : [];

            const normalizedCombined = combined.toUpperCase();

            const have = new Set(current.map((s) => s.toUpperCase()));

            if (!have.has(normalizedCombined)) {

              current.push(combined);

              ledField.value = current.join(', ');

            }

          }

          return true;

        };


        const isLikelySerialBarcode = (value) => {
          if (!value) return false;
          const cleaned = String(value).replace(/[^A-Z0-9]/gi, '').toUpperCase();
          if (cleaned.length < 8 || cleaned.length > 24) return false;
          if (!/[A-Z]/.test(cleaned) || !/[0-9]/.test(cleaned)) return false;
          const longPattern = /^\d{2}[A-Z0-9]{6,}$/;
          const shortPattern = /^\d{8,12}T?$/;
          return longPattern.test(cleaned) || shortPattern.test(cleaned);
        };




        const disableBarcodeOcr = true;

        const handlePartsOcrFile = async (file) => {
          if (!file) return;
          setPartsOcrStatus('Reading photo...');
          let dataUrl = '';
          try {
            if (!disableBarcodeOcr) {
              // Try barcode decoding first (more reliable for serial stickers).
              try {
                setPartsOcrStatus('Checking barcode...');
                const ZXing = await loadZxing();
                dataUrl = dataUrl || (await readFileAsDataUrl(file));
                const reader = new ZXing.BrowserBarcodeReader();
                const result = await reader.decodeFromImageUrl(dataUrl);
                if (result && result.text) {
                  const barcode = String(result.text).trim();
                  if (isLikelySerialBarcode(barcode)) {
                    fillPartsFromOcr({ model: '', serial: barcode, batch: '', candidates: [barcode] });
                    setPartsOcrStatus('Barcode decoded: ' + barcode + '. Check and edit if needed.');
                    return;
                  }
                  recordDebug('parts-ocr-barcode-skip', { barcode });
                  setPartsOcrStatus('Barcode looks incorrect. Switching to OCR...');
                }
              } catch (barcodeErr) {
                // Fallback silently to OCR
                recordDebug('parts-ocr-barcode-error', {
                  error: String(barcodeErr && barcodeErr.message ? barcodeErr.message : barcodeErr),
                });
              }
            }

            // Paddle OCR as next fallback (better for noisy images).
            try {
              setPartsOcrStatus('Recognizing text (Paddle OCR)...');
              dataUrl = dataUrl || (await readFileAsDataUrl(file));
              const paddleText = await callPaddleOcr(dataUrl);
              if (paddleText) {
                const parsedPaddle = parseOcrText(paddleText);
                if (parsedPaddle.serial || parsedPaddle.model) {
                  fillPartsFromOcr(parsedPaddle);
                  const summary =
                    'OCR ok (Paddle). Serial: ' +
                    (parsedPaddle.serial || 'n/a') +
                    '; Model: ' +
                    (parsedPaddle.model || 'n/a') +
                    '; Batch: ' +
                    (parsedPaddle.batch || 'n/a') +
                    '; Top tokens: ' +
                    (parsedPaddle.candidates && parsedPaddle.candidates.length
                      ? parsedPaddle.candidates.join(', ')
                      : 'n/a') +
                    '. Check and edit if needed.';
                  setPartsOcrStatus(summary);
                  return;
                }
              }
            } catch (paddleErr) {
              recordDebug('parts-ocr-paddle-error', {
                error: String(paddleErr && paddleErr.message ? paddleErr.message : paddleErr),
              });
            }

            const Tesseract = await loadTesseract();
            setPartsOcrStatus('Recognizing text...');
            const { data } = await Tesseract.recognize(file, 'eng', {
              tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/ ',
              tessedit_pageseg_mode: 6,
            });
            const parsed = parseOcrText(data.text || '');
            if (!parsed.serial && !parsed.model) {
              setPartsOcrStatus('No text found, please try a clearer photo.', true);
              return;
            }
            fillPartsFromOcr(parsed);
            const summary =
              'OCR ok. Serial: ' +
              (parsed.serial || 'n/a') +
              '; Model: ' +
              (parsed.model || 'n/a') +
              '; Batch: ' +
              (parsed.batch || 'n/a') +
              '; Top tokens: ' +
              (parsed.candidates && parsed.candidates.length ? parsed.candidates.join(', ') : 'n/a') +
              '. Check and edit if needed.';
            setPartsOcrStatus(summary);
          } catch (err) {
            setPartsOcrStatus(err.message || 'OCR failed.', true);
          } finally {
            if (partsOcrInput) partsOcrInput.value = '';
          }
        };

        const adminPreviewEl = adminSectionEl ? adminSectionEl.querySelector('[data-admin-preview]') : null;

        const adminPreviewLabelEl = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-preview-label]')

          : null;

        const adminPreviewFrameWrapper = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-preview-frame-wrapper]')

          : null;

        const adminPreviewCanvas = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-preview-canvas]')

          : null;

        const adminPreviewEmptyEl = adminSectionEl

          ? adminSectionEl.querySelector('[data-admin-preview-empty]')

          : null;

        const adminPreviewOverlayEl = adminSectionEl

          ? adminSectionEl.querySelector('[data-template-overlay]')

          : null;

        const adminPreviewBoundaryEl = adminSectionEl

          ? adminSectionEl.querySelector('[data-template-boundary-line]')

          : null;



        const boundaryControlsEl = adminSectionEl

          ? adminSectionEl.querySelector('[data-boundary-controls]')

          : null;

        const boundaryRangeInput = boundaryControlsEl

          ? boundaryControlsEl.querySelector('[data-boundary-range]')

          : null;

        const boundaryNumberInput = boundaryControlsEl

          ? boundaryControlsEl.querySelector('[data-boundary-input]')

          : null;

        const boundarySaveBtn = boundaryControlsEl

          ? boundaryControlsEl.querySelector('[data-boundary-save]')

          : null;

        const adminStatusEl = adminSectionEl ? adminSectionEl.querySelector('[data-admin-status]') : null;

        const adminProfileEl = adminSectionEl ? adminSectionEl.querySelector('[data-admin-profile]') : null;

        const DEFAULT_PAGE_WIDTH = 595.28;

        const BOUNDARY_DEFAULT_HEIGHT = 841.89;

        const urlSearchParams = new URL(window.location.href).searchParams;

        const requestedTemplateSlug = (urlSearchParams.get('template') || '').trim().toLowerCase();

        const requestedTemplateId = (urlSearchParams.get('templateId') || '').trim();

        const requestedAdminWindow = urlSearchParams.get('adminWindow') === '1';

        const boundaryState = {

          templateId: null,

          pageWidth: DEFAULT_PAGE_WIDTH,

          pageHeight: BOUNDARY_DEFAULT_HEIGHT,

          value: 0,

          dirty: false,

        };

        let adminWindowOpened = requestedAdminWindow;

        const openStandaloneAdminWindow = () => {

          const adminUrl = new URL(window.location.href);

          adminUrl.searchParams.set('adminWindow', '1');

          adminUrl.hash = '';

          window.open(adminUrl.toString(), '_blank', 'noopener');

        };

        let boundaryOverlayFrame = null;

        let previewResizeObserver = null;

        const clampValue = (value, min, max) => {

          const number = Number(value);

          if (!Number.isFinite(number)) return min;

          if (number < min) return min;

          if (number > max) return max;

          return number;

        };

        const defaultBoundaryFromHeight = (height) => {

          const safeHeight = Number.isFinite(height) && height > 0 ? height : BOUNDARY_DEFAULT_HEIGHT;

          return clampValue(safeHeight * 0.22, 0, Math.max(safeHeight - 40, 0));

        };

        const templateState = {

          templates: [],

          activeTemplateId: null,

        };

        const ADMIN_TOKEN_KEY = 'pm-admin-token';

        let adminTokenStore = null;

        try {

          adminTokenStore = window.localStorage;

        } catch (err) {

          adminTokenStore = null;

        }

        if (adminTemplateListEl) {

          adminTemplateListEl.innerHTML =

            '<div style="padding:0.75rem;color:#475569;">Log in to manage templates.</div>';

        }



        const appBaseUrl = new URL('.', window.location.href);

        const buildAppUrl = (path) => {

          const normalized = (path || '').replace(/^\/+/, '');

          return new URL(normalized || '.', appBaseUrl).toString();

        };



        const debounce = (fn, delay = 250) => {

          let timer = null;

          return (...args) => {

            if (timer) {

              window.clearTimeout(timer);

            }

            timer = window.setTimeout(() => fn(...args), delay);

          };

        };



        const projectFields = {

          batch_number: formEl.querySelector('input[name="batch_number"]'),

          lsc_project_name: formEl.querySelector('input[name="lsc_project_name"]'),

          end_customer_name: formEl.querySelector('input[name="end_customer_name"]'),

          site_location: formEl.querySelector('input[name="site_location"]'),

          led_display_model: formEl.querySelector('input[name="led_display_model"]'),

          date_of_service: formEl.querySelector('input[name="date_of_service"]'),

          service_company_name: formEl.querySelector('input[name="service_company_name"]'),

        };



        const projectStatusEl = (() => {

          const parentField = projectFields.batch_number ? projectFields.batch_number.closest('.field') : null;

          if (!parentField) return null;

          const hint = document.createElement('small');

          hint.className = 'field-hint project-status-hint';

          hint.style.color = '#475569';

          hint.style.fontWeight = '400';

          hint.style.marginTop = '-6px';

          hint.hidden = true;

          parentField.appendChild(hint);

          return hint;

        })();



        const updateProjectStatus = (message, isError = false) => {

          if (!projectStatusEl) return;

          projectStatusEl.textContent = message || '';

          projectStatusEl.hidden = !message;

          projectStatusEl.style.color = isError ? '#b91c1c' : '#475569';

        };



        const applyProjectCard = (card) => {

          if (!card || typeof card !== 'object') return;

          const mapping = {

            batch_number: card.batch_number || card.lsc_project_number || '',

            lsc_project_name: card.lsc_project_name,

            end_customer_name: card.end_customer_name,

            site_location: card.site_location,

            led_display_model: card.led_display_model,

            date_of_service: card.date_of_service,

            service_company_name: card.service_company_name,

          };

          Object.entries(mapping).forEach(([name, value]) => {

            const input = projectFields[name];

            if (!input || value === undefined || value === null) return;

            const next = String(value);

            if (input.value !== next) {

              input.value = next;

              input.dispatchEvent(new Event('input', { bubbles: true }));

            }

          });

        };



        const fetchProjectCard = (projectNumber) => {

          const key = (projectNumber || '').trim();

          if (!key) {

            updateProjectStatus('');

            return Promise.resolve(null);

          }

          updateProjectStatus('Loading saved project...');

          const url = buildAppUrl('projects/' + encodeURIComponent(key));

          return fetch(url)

            .then((response) => {

              if (response.status === 404) {

                const notFound = new Error('Not found');

                notFound.code = 'NOT_FOUND';

                throw notFound;

              }

              if (!response.ok) {

                throw new Error('Lookup failed');

              }

              return response.json();

            })

            .then((payload) => {

              if (payload && payload.ok && payload.project) {

                applyProjectCard(payload.project);

                updateProjectStatus('Loaded saved project data.');

                return payload.project;

              }

              throw new Error('Invalid response');

            })

            .catch((err) => {

              if (err && err.code === 'NOT_FOUND') {

                updateProjectStatus('No saved data for this project yet.', true);

                return null;

              }

              updateProjectStatus('Project lookup failed.', true);

              return null;

            });

        };



        const triggerProjectLookup = debounce(() => {

          const projectNumber = projectFields.batch_number ? projectFields.batch_number.value : '';

          const key = (projectNumber || '').trim();

          if (!key) {

            updateProjectStatus('');

            return;

          }

          fetchProjectCard(key);

        }, 350);



        if (projectFields.batch_number) {

          ['change', 'blur'].forEach((eventName) => {

            projectFields.batch_number.addEventListener(eventName, triggerProjectLookup);

          });

          const initialKey = (projectFields.batch_number.value || '').trim();

          if (initialKey) {

            triggerProjectLookup();

          }

        }



        const setTemplateStatus = (message, isError = false) => {

          if (!templateStatusEl) return;

          templateStatusEl.textContent = message || '';

          templateStatusEl.style.color = isError ? '#b91c1c' : '#475569';

        };



        const updateBoundaryControls = () => {

          if (!boundaryControlsEl) return;

          if (!boundaryState.templateId) {

            boundaryControlsEl.hidden = true;

            if (boundarySaveBtn) boundarySaveBtn.disabled = true;

            if (adminPreviewOverlayEl) adminPreviewOverlayEl.hidden = true;

            return;

          }

          boundaryControlsEl.hidden = false;

          const maxValue = Math.max(0, Math.round(boundaryState.pageHeight));

          if (boundaryRangeInput) {

            boundaryRangeInput.min = '0';

            boundaryRangeInput.max = String(maxValue);

            boundaryRangeInput.value = String(Math.round(boundaryState.value));

          }

          if (boundaryNumberInput) {

            boundaryNumberInput.min = '0';

            boundaryNumberInput.max = String(maxValue);

            boundaryNumberInput.value = String(Math.round(boundaryState.value));

          }

          if (boundarySaveBtn) {

            boundarySaveBtn.disabled = !boundaryState.dirty;

          }

        };



        const updateBoundaryOverlay = () => {

          if (

            !adminPreviewOverlayEl ||

            !adminPreviewBoundaryEl ||

            !adminPreviewFrameWrapper ||

            !boundaryState.templateId

          ) {

            if (adminPreviewOverlayEl) {

              adminPreviewOverlayEl.hidden = true;

            }

            return;

          }

          const wrapperRect = adminPreviewFrameWrapper.getBoundingClientRect();

          const canvasRect = adminPreviewCanvas ? adminPreviewCanvas.getBoundingClientRect() : null;

          const wrapperHeight = wrapperRect.height;

          const wrapperWidth = wrapperRect.width;

          const canvasHeight = canvasRect ? canvasRect.height : 0;

          const canvasWidth = canvasRect ? canvasRect.width : 0;

          if (

            !wrapperHeight ||

            !wrapperWidth ||

            !canvasHeight ||

            !canvasWidth ||

            !Number.isFinite(boundaryState.pageHeight) ||

            boundaryState.pageHeight <= 0 ||

            !Number.isFinite(boundaryState.pageWidth) ||

            boundaryState.pageWidth <= 0

          ) {

            adminPreviewOverlayEl.hidden = true;

            return;

          }

          const ratio = clampValue(boundaryState.value / boundaryState.pageHeight, 0, 1);

          const overlayTop = canvasRect.top - wrapperRect.top;

          const overlayLeft = canvasRect.left - wrapperRect.left;

          adminPreviewOverlayEl.style.top = overlayTop + 'px';

          adminPreviewOverlayEl.style.left = overlayLeft + 'px';

          adminPreviewOverlayEl.style.height = canvasHeight + 'px';

          adminPreviewOverlayEl.style.width = canvasWidth + 'px';

          const topPosition = overlayTop + canvasHeight * ratio;

          adminPreviewBoundaryEl.style.top = topPosition + 'px';

          adminPreviewOverlayEl.hidden = false;

        };



        const scheduleBoundaryOverlay = () => {

          if (boundaryOverlayFrame) {

            cancelAnimationFrame(boundaryOverlayFrame);

          }

          boundaryOverlayFrame = requestAnimationFrame(updateBoundaryOverlay);

        };



        const attachPreviewResizeObserver = () => {

          if (typeof ResizeObserver === 'undefined' || !adminPreviewFrameWrapper) {

            return;

          }

          if (previewResizeObserver) {

            previewResizeObserver.disconnect();

          }

          previewResizeObserver = new ResizeObserver(() => {

            scheduleBoundaryOverlay();

          });

          previewResizeObserver.observe(adminPreviewFrameWrapper);

        };

        attachPreviewResizeObserver();

        let previewRenderToken = 0;

        const renderTemplatePreview = async (previewUrl, template) => {

          if (!pdfjsLib || !adminPreviewCanvas) {

            return;

          }

          const token = ++previewRenderToken;

          try {

            const loadingTask = pdfjsLib.getDocument({ url: previewUrl });

            const pdf = await loadingTask.promise;

            const page = await pdf.getPage(1);

            const wrapperWidth = adminPreviewFrameWrapper ? adminPreviewFrameWrapper.clientWidth : 640;

            const viewport = page.getViewport({

              scale: Math.max(wrapperWidth / page.getViewport({ scale: 1 }).width, 1),

            });

            if (token !== previewRenderToken) {

              return;

            }

            const context = adminPreviewCanvas.getContext('2d');

            adminPreviewCanvas.width = viewport.width;

            adminPreviewCanvas.height = viewport.height;

            context.clearRect(0, 0, adminPreviewCanvas.width, adminPreviewCanvas.height);

            await page.render({ canvasContext: context, viewport }).promise;

            if (token !== previewRenderToken) {

              return;

            }

            boundaryState.pageWidth = viewport.width;

            boundaryState.pageHeight = viewport.height;

            scheduleBoundaryOverlay();

          } catch (err) {

            console.error('[admin] Failed to render preview', err);

            if (token === previewRenderToken && adminPreviewEmptyEl) {

              adminPreviewEmptyEl.hidden = false;

            }

          }

        };



        const setBoundaryTemplate = (template) => {

          if (!template) {

            boundaryState.templateId = null;

            boundaryState.pageHeight = BOUNDARY_DEFAULT_HEIGHT;

            boundaryState.pageWidth = DEFAULT_PAGE_WIDTH;

            boundaryState.value = 0;

            boundaryState.dirty = false;

            updateBoundaryControls();

            scheduleBoundaryOverlay();

            return;

          }

          boundaryState.templateId = template.id;

          boundaryState.pageWidth =

            Number.isFinite(template.pageWidth) && template.pageWidth > 0

              ? Number(template.pageWidth)

              : DEFAULT_PAGE_WIDTH;

          boundaryState.pageHeight =

            Number.isFinite(template.pageHeight) && template.pageHeight > 0

              ? Number(template.pageHeight)

              : BOUNDARY_DEFAULT_HEIGHT;

          const providedOffset =

            Number.isFinite(template.bodyTopOffset) && template.bodyTopOffset >= 0

              ? Number(template.bodyTopOffset)

              : defaultBoundaryFromHeight(boundaryState.pageHeight);

          boundaryState.value = clampValue(providedOffset, 0, boundaryState.pageHeight);

          boundaryState.dirty = false;

          updateBoundaryControls();

          scheduleBoundaryOverlay();

        };



        const handleBoundaryValueChange = (nextValue, source) => {

          if (!boundaryState.templateId) return;

          const clamped = clampValue(nextValue, 0, boundaryState.pageHeight);

          boundaryState.value = clamped;

          boundaryState.dirty = true;

          if (boundarySaveBtn) {

            boundarySaveBtn.disabled = false;

          }

          if (boundaryRangeInput && source !== 'range') {

            boundaryRangeInput.value = String(Math.round(clamped));

          }

          if (boundaryNumberInput && source !== 'number') {

            boundaryNumberInput.value = String(Math.round(clamped));

          }

          scheduleBoundaryOverlay();

        };



        const applyTemplateSelection = () => {

          if (!templateSelectEl) return;

          const selectedId = templateSelectEl.value;

          const selected =

            templateState.templates.find((tpl) => tpl.id === selectedId) || null;

          if (templateSlugInput) {

            templateSlugInput.value = selected && selected.slug ? selected.slug : '';

          }

          if (templateDescriptionEl) {

            if (selected && selected.description && selected.description.trim().length) {

              templateDescriptionEl.hidden = false;

              templateDescriptionEl.textContent = selected.description;

            } else {

              templateDescriptionEl.hidden = true;

              templateDescriptionEl.textContent = '';

            }

          }

          if (templatePreviewLink) {

            if (selected && selected.previewUrl) {

              const previewPath = selected.previewUrl.replace(/^\/+/, '');



              templatePreviewLink.href = buildAppUrl(previewPath);

              templatePreviewLink.hidden = false;

            } else {

              templatePreviewLink.hidden = true;

              templatePreviewLink.href = '#';

            }

          }

          if (selected) {

            const slugDisplay = selected.slug ? ' - ' + selected.slug : '';

            setTemplateStatus(

              (selected.label || selected.slug || 'Template') +

                slugDisplay +

                (selected.isActive ? ' - Active by default' : ''),

            );

          } else {

            setTemplateStatus('Select a template to continue.');

          }

        };



        const loadTemplateOptions = () => {

          if (!templateSelectEl) return;

          setTemplateStatus('Loading available templates...');

          templateSelectEl.disabled = true;

          templateSelectEl.innerHTML = '<option value="">Loading...</option>';

          fetch(buildAppUrl('api/templates'), { credentials: 'same-origin' })

            .then((response) => {

              if (!response.ok) {

                throw new Error('Failed to load templates.');

              }

              return response.json();

            })

            .then((payload) => {

              if (!payload || !Array.isArray(payload.templates)) {

                throw new Error('Template response malformed.');

              }

              templateState.templates = payload.templates;

              templateState.activeTemplateId = payload.activeTemplateId || '';

              templateSelectEl.innerHTML = '';

              if (!payload.templates.length) {

                const option = document.createElement('option');

                option.value = '';

                option.textContent = 'No templates found';

                templateSelectEl.appendChild(option);

                templateSelectEl.disabled = true;

                if (templateSlugInput) templateSlugInput.value = '';

                if (templateDescriptionEl) {

                  templateDescriptionEl.hidden = false;

                  templateDescriptionEl.textContent = 'Upload a template in the admin panel to continue.';

                }

                setTemplateStatus('Templates are not configured yet.', true);

                return;

              }

              payload.templates.forEach((tpl) => {

                const option = document.createElement('option');

                option.value = tpl.id;

                option.textContent = tpl.label || tpl.slug || tpl.id;

                templateSelectEl.appendChild(option);

              });

              let defaultTemplate = null;

              if (requestedTemplateSlug) {

                defaultTemplate = payload.templates.find(

                  (tpl) => (tpl.slug || '').toLowerCase() === requestedTemplateSlug,

                );

              }

              if (!defaultTemplate && requestedTemplateId) {

                defaultTemplate = payload.templates.find((tpl) => tpl.id === requestedTemplateId);

              }

              if (!defaultTemplate) {

                defaultTemplate =

                  payload.templates.find((tpl) => tpl.isActive) || payload.templates[0];

              }

              templateSelectEl.disabled = false;

              templateSelectEl.value = defaultTemplate ? defaultTemplate.id : payload.templates[0].id;

              applyTemplateSelection();

            })

            .catch((err) => {

              setTemplateStatus(err.message || 'Unable to load templates.', true);

              templateSelectEl.innerHTML = '<option value="">Templates unavailable</option>';

              templateSelectEl.disabled = true;

              if (templateSlugInput) templateSlugInput.value = '';

              if (templateDescriptionEl) templateDescriptionEl.hidden = true;

              if (templatePreviewLink) templatePreviewLink.hidden = true;

            });

        };



        const readJsonPayload = async (response) => {

          try {

            const text = await response.text();

            if (!text) return null;

            return JSON.parse(text);

          } catch (err) {

            return null;

          }

        };



        if (requestedAdminWindow) {

          document.body.dataset.adminWindow = 'true';

        }



        const adminState = {

          token: adminTokenStore ? adminTokenStore.getItem(ADMIN_TOKEN_KEY) || '' : '',

        };

         const pdfjsLib =

          (window.pdfjsLib || (window['pdfjs-dist/build/pdf'] ? window['pdfjs-dist/build/pdf'] : null)) || null;

        if (pdfjsLib && pdfjsLib.GlobalWorkerOptions) {

        pdfjsLib.GlobalWorkerOptions.workerSrc = '/service2/vendor/pdfjs/pdf.worker.min.js';

        }

        const adminUiState = {

          previewTemplateId: null,

        };

        if (templateSelectEl) {

          templateSelectEl.addEventListener('change', applyTemplateSelection);

          loadTemplateOptions();

        } else if (templateInfoEl) {

          setTemplateStatus('Template selector unavailable.', true);

        }



        if (boundaryRangeInput) {

          boundaryRangeInput.addEventListener('input', (event) => {

            handleBoundaryValueChange(Number(event.target.value), 'range');

          });

        }

        if (boundaryNumberInput) {

          boundaryNumberInput.addEventListener('input', (event) => {

            handleBoundaryValueChange(Number(event.target.value), 'number');

          });

        }

        if (boundarySaveBtn) {

          boundarySaveBtn.addEventListener('click', () => {

            if (!boundaryState.templateId) return;

            showAdminStatus('Saving boundary...');

            adminFetch('admin/templates/boundary', {

              method: 'POST',

              headers: { 'Content-Type': 'application/json' },

              body: JSON.stringify({

                templateId: boundaryState.templateId,

                bodyTopOffset: boundaryState.value,

              }),

            })

              .then((payload) => {

                boundaryState.dirty = false;

                if (boundarySaveBtn) boundarySaveBtn.disabled = true;

                adminUiState.previewTemplateId = boundaryState.templateId;

                showAdminStatus('Boundary updated.');

                renderAdminTemplates(payload);

              })

              .catch((err) => {

                showAdminStatus(err.message, true);

              });

          });

        }

        window.addEventListener('resize', () => scheduleBoundaryOverlay());



        const setAdminModalVisible = (visible) => {

          if (!adminModalEl) return;

          adminModalEl.hidden = !visible;

          if (visible) {

            document.body.dataset.adminModal = 'open';

            if (!requestedAdminWindow) {

              document.body.style.overflow = 'hidden';

            }

            if (adminState.token) {

              loadAdminTemplates();

            }

          } else {

            delete document.body.dataset.adminModal;

            if (!requestedAdminWindow) {

              document.body.style.overflow = '';

            }

          }

        };



        const canUseStandaloneAdminWindow = () => {

          return Boolean(adminState.token);

        };



        if (adminOpenBtn) {

          adminOpenBtn.addEventListener('click', () => {

            if (canUseStandaloneAdminWindow() && !requestedAdminWindow) {

              openStandaloneAdminWindow();

              return;

            }

            setAdminModalVisible(true);

          });

        }



        adminCloseButtons.forEach((btn) => {

          btn.addEventListener('click', () => setAdminModalVisible(false));

        });



        if (adminModalEl) {

          adminModalEl.addEventListener('click', (event) => {

            if (event.target === adminModalEl) {

              setAdminModalVisible(false);

            }

          });

        }



        if (adminDialogEl) {

          adminDialogEl.addEventListener('click', (event) => event.stopPropagation());

        }



        document.addEventListener('keydown', (event) => {

          if (event.key === 'Escape') {

            setAdminModalVisible(false);

          }

        });



        const setAdminToken = (token) => {

          adminState.token = token || '';

          if (adminTokenStore) {

            if (adminState.token) {

              adminTokenStore.setItem(ADMIN_TOKEN_KEY, adminState.token);

            } else {

              adminTokenStore.removeItem(ADMIN_TOKEN_KEY);

            }

          }

          updateAdminVisibility();

        };



        const showAdminStatus = (message, isError = false) => {

          if (!adminStatusEl) return;

          adminStatusEl.style.color = isError ? '#b91c1c' : '#0f172a';

          adminStatusEl.textContent = message || '';

        };



        const renderAdminProfile = (payload) => {

          if (!adminProfileEl) return;

          if (!payload || !payload.username) {

            adminProfileEl.textContent = '';

            return;

          }

          const updated = payload.passwordUpdatedAt

            ? new Date(payload.passwordUpdatedAt).toLocaleString()

            : 'unknown';

          adminProfileEl.textContent =

            'Logged in as ' + payload.username + '. Password updated ' + updated + '.';

        };



        const clearPreviewCanvas = () => {

          if (!adminPreviewCanvas) return;

          const ctx = adminPreviewCanvas.getContext('2d');

          ctx.clearRect(0, 0, adminPreviewCanvas.width, adminPreviewCanvas.height);

          adminPreviewCanvas.width = 0;

          adminPreviewCanvas.height = 0;

        };



        const showAdminPreview = (template) => {

          if (!adminPreviewEl || !adminPreviewLabelEl || !adminPreviewEmptyEl) return;

          if (!template) {

            adminPreviewEl.hidden = true;

            clearPreviewCanvas();

            adminPreviewEmptyEl.hidden = false;

            adminUiState.previewTemplateId = null;

            setBoundaryTemplate(null);

            return;

          }

          adminPreviewEl.hidden = false;

          const previewLabel = template.label || template.relativePath || template.id;

          adminPreviewLabelEl.textContent =

            'Template preview: ' + previewLabel + (template.slug ? ' (' + template.slug + ')' : '');

          const previewUrl = buildAppUrl('admin/templates/' + encodeURIComponent(template.id) + '/preview');

          adminPreviewEmptyEl.hidden = true;

          adminUiState.previewTemplateId = template.id;

          attachPreviewResizeObserver();

          setBoundaryTemplate(template);

          renderTemplatePreview(previewUrl, template);

        };



        const updateAdminVisibility = () => {

          if (!adminSectionEl) return;

          const isAuthed = Boolean(adminState.token);

          if (adminUnauthEl) adminUnauthEl.hidden = isAuthed;

          if (adminAuthEl) adminAuthEl.hidden = !isAuthed;

          if (!isAuthed) {

            if (adminStatusEl) adminStatusEl.textContent = '';

            if (adminProfileEl) adminProfileEl.textContent = '';

            if (adminTemplateListEl) {

              adminTemplateListEl.innerHTML =

                '<div style="padding:0.75rem;color:#475569;">Log in to manage templates.</div>';

            }

            showAdminPreview(null);

          }

        };



        const adminFetch = (relativePath, options = {}) => {

          if (!adminState.token) {

            const err = new Error('AUTH_REQUIRED');

            err.code = 'AUTH_REQUIRED';

            return Promise.reject(err);

          }

          const init = Object.assign({ headers: {}, credentials: 'same-origin' }, options);

          init.headers = Object.assign({}, init.headers, {

            Authorization: 'Bearer ' + adminState.token,

          });

          const targetUrl = buildAppUrl(relativePath || '');

          return fetch(targetUrl, init).then(async (response) => {

            const payload = await readJsonPayload(response);

            if (!response.ok) {

              if (response.status === 401) {

                setAdminToken('');

                const authErr = new Error('AUTH_REQUIRED');

                authErr.code = 'AUTH_REQUIRED';

                throw authErr;

              }

              const message = (payload && payload.error) || response.statusText || 'Request failed';

              throw new Error(message);

            }

            return payload;

          });

        };



        const refreshAdminProfile = () => {

          if (!adminState.token) return;

          adminFetch('admin/profile')

            .then((payload) => {

              renderAdminProfile(payload);

            })

            .catch((err) => {

              if (err && err.code === 'AUTH_REQUIRED') {

                showAdminStatus('Admin authentication required. Please log in.', true);

                return;

              }

              console.warn('[admin] profile refresh failed', err);

            });

        };



        const renderAdminTemplates = (payload) => {

          if (!adminTemplateListEl) return;

          if (!payload || !Array.isArray(payload.templates) || !payload.templates.length) {

            adminTemplateListEl.innerHTML =

              '<div style="padding:0.75rem;color:#475569;">No templates uploaded yet.</div>';

            showAdminPreview(null);

            return;

          }

          const table = document.createElement('table');

          const thead = document.createElement('thead');

          thead.innerHTML =

            '<tr><th>Template</th><th>Status</th><th style="width:160px;">Actions</th></tr>';

          table.appendChild(thead);

          const tbody = document.createElement('tbody');

          let previewCandidate = null;

          payload.templates.forEach((tpl) => {

            const row = document.createElement('tr');

            const colInfo = document.createElement('td');

            const nameSpan = document.createElement('span');

            nameSpan.className = 'admin-template__name';

            nameSpan.textContent = tpl.label || tpl.relativePath;

            const meta = document.createElement('span');

            meta.className = 'admin-template__meta';

            const size = tpl.size ? (tpl.size / 1024 / 1024).toFixed(2) + ' MB' : 'Unknown size';

            const uploaded = tpl.uploadedAt ? new Date(tpl.uploadedAt).toLocaleString() : 'Unknown date';

            meta.textContent = size + ' Ã¢â‚¬Â¢ ' + uploaded;

            colInfo.appendChild(nameSpan);

            colInfo.appendChild(meta);

            if (tpl.slug) {

              const slugInfo = document.createElement('span');

              slugInfo.className = 'admin-template__slug';

              slugInfo.textContent = 'Slug: ' + tpl.slug;

              colInfo.appendChild(slugInfo);

            }

            if (tpl.description) {

              const desc = document.createElement('p');

              desc.className = 'admin-template__desc';

              desc.textContent = tpl.description;

              colInfo.appendChild(desc);

            }



            const colStatus = document.createElement('td');

            if (tpl.id === payload.activeTemplateId) {

              const badge = document.createElement('span');

              badge.className = 'admin-badge';

              badge.textContent = 'Active';

              colStatus.appendChild(badge);

            } else {

              colStatus.textContent = 'Available';

            }



            const colActions = document.createElement('td');

            colActions.className = 'admin-template__actions';

            const downloadLink = document.createElement('a');

            const relativeHref = (tpl.relativePath || '').replace(/\\/g, '/');

            downloadLink.href = buildAppUrl(relativeHref);

            downloadLink.textContent = 'Download';

            downloadLink.target = '_blank';

            downloadLink.rel = 'noopener noreferrer';

            colActions.appendChild(downloadLink);



            const previewBtn = document.createElement('button');

            previewBtn.type = 'button';

            previewBtn.className = 'link-button';

            previewBtn.textContent = 'Preview';

            previewBtn.addEventListener('click', (event) => {

              event.stopPropagation();

              showAdminPreview(tpl);

            });

            colActions.appendChild(previewBtn);



            const selectBtn = document.createElement('button');

            selectBtn.type = 'button';

            selectBtn.className = 'link-button';

            selectBtn.textContent = tpl.id === payload.activeTemplateId ? 'Current' : 'Activate';

            selectBtn.disabled = tpl.id === payload.activeTemplateId;

            if (tpl.id !== payload.activeTemplateId) {

              selectBtn.addEventListener('click', () => selectAdminTemplate(tpl.id));

            }

            colActions.appendChild(selectBtn);



            const deleteBtn = document.createElement('button');

            deleteBtn.type = 'button';

            deleteBtn.className = 'link-button danger';

            deleteBtn.textContent = 'Delete';

            if (tpl.source === 'builtin') {

              deleteBtn.disabled = true;

              deleteBtn.title = 'Builtin template cannot be deleted';

            } else {

              deleteBtn.addEventListener('click', () => {

                const proceed = window.confirm(

                  'Delete template "' + (tpl.label || tpl.slug || tpl.id) + '"? This cannot be undone.',

                );

                if (!proceed) return;

                deleteAdminTemplate(tpl.id);

              });

            }

            colActions.appendChild(deleteBtn);



            row.appendChild(colInfo);

            row.appendChild(colStatus);

            row.appendChild(colActions);

            tbody.appendChild(row);



            if (!previewCandidate) {

              if (adminUiState.previewTemplateId && adminUiState.previewTemplateId === tpl.id) {

                previewCandidate = tpl;

              } else if (tpl.id === payload.activeTemplateId) {

                previewCandidate = tpl;

              }

            }

          });

          table.appendChild(tbody);

          adminTemplateListEl.innerHTML = '';

          adminTemplateListEl.appendChild(table);

          if (!previewCandidate) {

            previewCandidate = payload.templates[0];

          }

          showAdminPreview(previewCandidate);

        };



        const loadAdminTemplates = () => {

          if (!adminState.token) {

            if (adminTemplateListEl) {

              adminTemplateListEl.innerHTML =

                '<div style="padding:0.75rem;color:#475569;">Log in to manage templates.</div>';

            }

            return;

          }

          adminFetch('admin/templates')

            .then((payload) => {

              renderAdminTemplates(payload);

            })

            .catch((err) => {

              if (err && err.code === 'AUTH_REQUIRED') {

                showAdminStatus('Admin authentication required. Please log in.', true);

                return;

              }

              showAdminStatus(err.message, true);

            });

        };



        const selectAdminTemplate = (templateId) => {

          if (!templateId) return;

          showAdminStatus('Activating template...');

          adminFetch('admin/templates/select', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ templateId }),

          })

            .then((payload) => {

              showAdminStatus('Template activated.');

              adminUiState.previewTemplateId = payload.activeTemplateId || templateId;

              renderAdminTemplates(payload);

            })

            .catch((err) => {

              showAdminStatus(err.message, true);

            });

        };



        const deleteAdminTemplate = (templateId) => {

          if (!templateId) return;

          showAdminStatus('Deleting template...');

          adminFetch('admin/templates/delete', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ templateId }),

          })

            .then((payload) => {

              showAdminStatus('Template deleted.');

              renderAdminTemplates(payload);

            })

            .catch((err) => {

              showAdminStatus(err.message || 'Unable to delete template.', true);

            });

        };



        if (adminLoginForm) {

          adminLoginForm.addEventListener('submit', (event) => {

            event.preventDefault();

            if (!adminPasswordInput || !adminPasswordInput.value) {

              showAdminStatus('Enter the admin password.', true);

              return;

            }

            const password = adminPasswordInput.value;

            showAdminStatus('Signing in...');

            fetch(buildAppUrl('admin/login'), {

              method: 'POST',

              headers: { 'Content-Type': 'application/json' },

              credentials: 'same-origin',

              body: JSON.stringify({ password }),

            })

              .then(readJsonPayload)

              .then((payload) => {

                if (!payload || !payload.token) {

                  throw new Error('Unexpected response.');

                }

                adminPasswordInput.value = '';

                if (adminLoginErrorEl) adminLoginErrorEl.textContent = '';

                setAdminToken(payload.token);

                showAdminStatus('Logged in.');

                if (!adminWindowOpened) {

                  openStandaloneAdminWindow();

                  adminWindowOpened = true;

                }

                if (payload.username) {

                  renderAdminProfile(payload);

                } else {

                  refreshAdminProfile();

                }

                loadAdminTemplates();

              })

              .catch((err) => {

                if (adminLoginErrorEl) adminLoginErrorEl.textContent = err.message || 'Login failed.';

                showAdminStatus(err.message || 'Login failed.', true);

              });

          });

        }



        if (adminLogoutBtn) {

          adminLogoutBtn.addEventListener('click', () => {

            setAdminToken('');

            showAdminStatus('Logged out.');

            if (adminTemplateListEl) {

              adminTemplateListEl.innerHTML =

                '<div style="padding:0.75rem;color:#475569;">Log in to manage templates.</div>';

            }

          });

        }



        if (adminPasswordForm) {

          adminPasswordForm.addEventListener('submit', (event) => {

            event.preventDefault();

            if (!adminPasswordCurrentInput || !adminPasswordNewInput) return;

            const currentPassword = adminPasswordCurrentInput.value;

            const newPassword = adminPasswordNewInput.value;

            if (!newPassword || newPassword.length < 4) {

              showAdminStatus('New password must be at least 4 characters.', true);

              return;

            }

            showAdminStatus('Updating password...');

            adminFetch('admin/password', {

              method: 'POST',

              headers: { 'Content-Type': 'application/json' },

              body: JSON.stringify({ currentPassword, newPassword }),

            })

              .then(() => {

                adminPasswordCurrentInput.value = '';

                adminPasswordNewInput.value = '';

                setAdminToken('');

                showAdminStatus('Password updated. Please log in again.');

              })

              .catch((err) => {

                showAdminStatus(err.message || 'Password update failed.', true);

              });

          });

        }



        if (adminUploadForm) {

          adminUploadForm.addEventListener('submit', (event) => {

            event.preventDefault();

            if (!adminUploadInput || !adminUploadInput.files || !adminUploadInput.files[0]) {

              showAdminStatus('Choose a PDF file to upload.', true);

              return;

            }

            const formData = new FormData(adminUploadForm);

            showAdminStatus('Uploading template...');

            adminFetch('admin/templates/upload', {

              method: 'POST',

              body: formData,

            })

              .then((payload) => {

                adminUploadInput.value = '';

                if (adminUploadLabelInput) adminUploadLabelInput.value = '';

                if (adminUploadDescriptionInput) adminUploadDescriptionInput.value = '';

                showAdminStatus('Template uploaded and activated.');

                adminUiState.previewTemplateId = payload.activeTemplateId;

                renderAdminTemplates(payload);

              })

              .catch((err) => {

                showAdminStatus(err.message, true);

              });

          });

        }



        updateAdminVisibility();

        if (requestedAdminWindow) {

          setAdminModalVisible(true);

        }

        if (adminState.token) {

          refreshAdminProfile();

          loadAdminTemplates();

        }



        const selectedFiles = new Map();

        const previewUrls = new Map();

        debugState = { enabled: false, timeline: [] };

        // Fields a report is not valid without. Vladimir marked these on a printed service
        // report: submitting with any of them empty produces a document that is useless to
        // the customer, so the form sends the engineer back to fill them instead of
        // generating it. Keyed by form type — each document needs its own answer.
        // Vladimir's call, as already applied in the app: the same set on all three report
        // types. The browser has to refuse the submission the app refuses, or the rule only
        // holds for whoever happens to be using a phone.
        const REQUIRED_ON_EVERY_REPORT = [
          { name: 'end_customer_name', label: 'End customer name' },
          { name: 'batch_number', label: 'LSC Project number', projectNumber: true },
          { name: 'lsc_project_name', label: 'LSC project name' },
          { name: 'site_location', label: 'Site location' },
          { name: 'date_of_service', label: 'Date of service' },
          { name: 'service_company_name', label: 'Service company name' },
          { name: 'led_display_model', label: 'LED display model / batch' },
          { name: 'work_performed', label: 'Work performed' },
          // The two people the document is about. The app calls the first submitter_name;
          // on this form it is the engineer named beside their signature.
          { name: 'engineer_name', label: 'Engineer name' },
          { name: 'customer_representative', label: 'Contact person' },
        ];

        const REQUIRED_FIELDS = {
          service_report: REQUIRED_ON_EVERY_REPORT,
          maintenance: REQUIRED_ON_EVERY_REPORT,
          installation_report: [
            ...REQUIRED_ON_EVERY_REPORT,
            // An acceptance certificate that does not say whether the work is finished, or
            // what the customer declared, is not a certificate.
            { name: 'installation_status', label: 'Was the installation finished completely?' },
            { name: 'acceptance_statement', label: 'Acceptance statement' },
            {
              anyOf: ['acceptance_overall', 'acceptance_partial'],
              label: 'What is being accepted',
              reason: 'needs one of the two options ticked',
            },
          ],
        };

        const requiredFieldsFor = (formType) => REQUIRED_FIELDS[formType] || [];

        // The value carrier for a field, preferring a visible control; led_display_model is
        // a hidden input fed by the two picker selects, so fall back to the hidden one.
        const findRequiredInput = (name) => {
          const all = Array.from(document.querySelectorAll('[name="' + name + '"]'));
          const visible = all.find((el) => !el.disabled && el.offsetParent !== null);
          return visible || all.find((el) => !el.disabled) || null;
        };

        // What to paint red: the label box for a normal field, the pad for a signature, and
        // for the hidden model field the picker the engineer actually interacts with.
        const findRequiredContainer = (name, input) => {
          if (name === 'led_display_model') {
            const picker = document.getElementById('led-code-select');
            return picker ? picker.closest('.field') : null;
          }
          return input ? input.closest('.field') : null;
        };

        const clearRequiredMark = (name) => {
          const input = findRequiredInput(name);
          const container = findRequiredContainer(name, input);
          if (container) container.classList.remove('is-missing');
          if (input) input.classList.remove('is-invalid');
        };

        // Clear the red as soon as the engineer starts fixing it, rather than making them
        // submit again to find out.
        document.addEventListener('input', (event) => {
          const target = event.target;
          if (!target || !target.name) return;
          if (String(target.value || '').trim()) clearRequiredMark(target.name);
        });

        document.addEventListener('change', (event) => {
          const target = event.target;
          if (!target) return;
          if (target.id === 'led-code-select' || target.id === 'led-number-select') {
            const hidden = findRequiredInput('led_display_model');
            if (hidden && String(hidden.value || '').trim()) clearRequiredMark('led_display_model');
            return;
          }
          if (target.name && String(target.value || '').trim()) clearRequiredMark(target.name);
        });

        // Project numbers are YY-NNNN and the engineer never types the dash. Written without
        // a regex on purpose: this whole script is emitted through a template literal, where
        // backslash escapes get eaten and a mangled pattern kills the page.
        const PROJECT_NUMBER_SELECTOR = 'input[name="batch_number"], input[name="lsc_project_number"], input[name="daily_project_number"]';

        const maskProjectNumber = (raw) => {
          const text = String(raw === undefined || raw === null ? '' : raw);
          let digits = '';
          for (let i = 0; i < text.length && digits.length < 6; i += 1) {
            const ch = text.charAt(i);
            if (ch >= '0' && ch <= '9') digits += ch;
          }
          if (digits.length <= 2) return digits;
          return digits.slice(0, 2) + '-' + digits.slice(2);
        };

        const applyProjectNumberMask = (input) => {
          if (!input) return;
          const before = input.value;
          const masked = maskProjectNumber(before);
          if (masked === before) return;
          // Keep the caret at the end — these fields are short and always typed left to right,
          // so restoring an offset would fight the auto-inserted dash.
          input.value = masked;
          if (input === document.activeElement) {
            try { input.setSelectionRange(masked.length, masked.length); } catch (err) { /* not selectable */ }
          }
        };

        // Every write path, not just keystrokes: paste and autocomplete/OCR fire input/change,
        // and the submit handler re-masks in case something wrote the value silently.
        document.addEventListener('input', (event) => {
          if (event.target && event.target.matches && event.target.matches(PROJECT_NUMBER_SELECTOR)) {
            applyProjectNumberMask(event.target);
          }
        });

        document.addEventListener('change', (event) => {
          if (event.target && event.target.matches && event.target.matches(PROJECT_NUMBER_SELECTOR)) {
            applyProjectNumberMask(event.target);
          }
        });

        const DATETIME_TEXT_SELECTOR = '[data-datetime-text]';

        const TIME_INPUT_SELECTOR = 'input[data-datetime-part="time"]';

        const TIME_PRESET_LIST_ID = 'time-presets';

        const TIME_PRESET_STEP_MINUTES = 15;

        const TIME_VALUE_REGEX = /^([01]\\d|2[0-3]):([0-5]\\d)$/;

        const endCustomerInput = document.getElementById('end-customer-name');

        const customerNameInput = document.getElementById('customer-name');

        const customerNameSync = { manual: false };

        const serviceCompanyInput = document.getElementById('service-company-name');

        const engineerCompanyInput = document.getElementById('engineer-company');

        const customerCompanyInput = document.getElementById('customer-company');

        const customerRepresentativeInput = document.getElementById('customer-representative');

        const attendeeClientInput = document.getElementById('attendee-client');

        const attendeeClientHidden = document.getElementById('attendee-client-hidden');

        const signatureCompanySync = { engineerManual: false, customerManual: false };

        const resolveCustomerRepresentativeInput = () => {
          const candidates = [customerRepresentativeInput, attendeeClientInput, attendeeClientHidden];
          return candidates.find((input) => input && !input.disabled) || null;
        };

        const getCustomerRepresentativeValue = () => {
          const sourceInput = resolveCustomerRepresentativeInput();
          return sourceInput ? sourceInput.value.trim() : '';
        };

        const syncCustomerNameFromRepresentative = () => {
          if (!customerNameInput) return;
          if (customerNameSync.manual) {
            return;
          }
          const sourceInput = resolveCustomerRepresentativeInput();
          if (!sourceInput) return;
          customerNameInput.value = sourceInput.value.trim();
        };

        const attachCustomerNameSourceListeners = (input) => {
          if (!input || !customerNameInput) return;
          ['input', 'change'].forEach((eventName) => {
            input.addEventListener(eventName, () => {
              if (!customerNameSync.manual || !customerNameInput.value.trim()) {
                if (!customerNameInput.value.trim()) {
                  customerNameSync.manual = false;
                }
                syncCustomerNameFromRepresentative();
              }
            });
          });
        };

        if (customerNameInput) {
          syncCustomerNameFromRepresentative();
          [customerRepresentativeInput, attendeeClientInput, attendeeClientHidden].forEach(
            attachCustomerNameSourceListeners,
          );
          customerNameInput.addEventListener('input', () => {
            const current = customerNameInput.value.trim();
            const source = getCustomerRepresentativeValue();
            if (!current) {
              customerNameSync.manual = false;
              syncCustomerNameFromRepresentative();
              return;
            }
            customerNameSync.manual = current !== source;
          });
        }



        const syncEngineerCompanyFromService = () => {

          if (!serviceCompanyInput || !engineerCompanyInput) return;

          if (signatureCompanySync.engineerManual) return;

          engineerCompanyInput.value = serviceCompanyInput.value.trim();

        };



        const syncCustomerCompanyFromHeader = () => {

          if (!endCustomerInput || !customerCompanyInput) return;

          if (signatureCompanySync.customerManual) return;

          customerCompanyInput.value = endCustomerInput.value.trim();

        };



        if (serviceCompanyInput && engineerCompanyInput) {

          syncEngineerCompanyFromService();

          ['input', 'change'].forEach((eventName) => {

            serviceCompanyInput.addEventListener(eventName, () => {

              if (!signatureCompanySync.engineerManual || !engineerCompanyInput.value.trim()) {

                if (!engineerCompanyInput.value.trim()) {

                  signatureCompanySync.engineerManual = false;

                }

                syncEngineerCompanyFromService();

              }

            });

          });

          engineerCompanyInput.addEventListener('input', () => {

            const current = engineerCompanyInput.value.trim();

            const source = serviceCompanyInput.value.trim();

            if (!current) {

              signatureCompanySync.engineerManual = false;

              syncEngineerCompanyFromService();

              return;

            }

            signatureCompanySync.engineerManual = current !== source;

          });

        }



        if (endCustomerInput && customerCompanyInput) {

          syncCustomerCompanyFromHeader();

          ['input', 'change'].forEach((eventName) => {

            endCustomerInput.addEventListener(eventName, () => {

              if (!signatureCompanySync.customerManual || !customerCompanyInput.value.trim()) {

                if (!customerCompanyInput.value.trim()) {

                  signatureCompanySync.customerManual = false;

                }

                syncCustomerCompanyFromHeader();

              }

            });

          });

          customerCompanyInput.addEventListener('input', () => {

            const current = customerCompanyInput.value.trim();

            const source = endCustomerInput.value.trim();

            if (!current) {

              signatureCompanySync.customerManual = false;

              syncCustomerCompanyFromHeader();

              return;

            }

            signatureCompanySync.customerManual = current !== source;

          });

        }

        const syncCustomerRepToSignature = () => {
          if (attendeeClientHidden) {
            attendeeClientHidden.value = (customerRepresentativeInput && customerRepresentativeInput.value.trim()) || '';
          }
        };

        if (customerRepresentativeInput) {
          ['input', 'change'].forEach((eventName) => {
            customerRepresentativeInput.addEventListener(eventName, syncCustomerRepToSignature);
          });
          syncCustomerRepToSignature();
        }

        const clampNumber = (value, min, max) => {

          if (!Number.isFinite(value)) return min;

          return Math.min(max, Math.max(min, value));

        };



        const pad2 = (value) => {

          const numeric = Number.isFinite(value) ? Math.trunc(value) : 0;

          const clamped = clampNumber(numeric, 0, 99);

          return String(clamped).padStart(2, '0');

        };



        const ensureTimePresetList = () => {

          let listEl = document.getElementById(TIME_PRESET_LIST_ID);

          if (listEl) {

            return TIME_PRESET_LIST_ID;

          }

          listEl = document.createElement('datalist');

          listEl.id = TIME_PRESET_LIST_ID;

          for (let hour = 0; hour < 24; hour += 1) {

            for (let minute = 0; minute < 60; minute += TIME_PRESET_STEP_MINUTES) {

              const option = document.createElement('option');

              option.value = pad2(hour) + ':' + pad2(minute);

              listEl.appendChild(option);

            }

          }

          if (formEl && formEl.parentNode) {

            formEl.parentNode.insertBefore(listEl, formEl.nextSibling);

          } else {

            document.body.appendChild(listEl);

          }

          return TIME_PRESET_LIST_ID;

        };



        const formatTimeDraft = (raw) => {

          if (typeof raw !== 'string') return '';

          const digits = raw.replace(/\\D/g, '').slice(0, 4);

          if (!digits) return '';

          if (digits.length <= 2) {

            return digits;

          }

          if (digits.length === 3) {

            return digits.slice(0, 1) + ':' + digits.slice(1);

          }

          return digits.slice(0, 2) + ':' + digits.slice(2);

        };



        const normalizeTimeInputValue = (raw) => {

          if (typeof raw !== 'string') return '';

          const digits = raw.replace(/\\D/g, '').slice(0, 4);

          if (!digits) return '';

          let hours = '';

          let minutes = '';

          if (digits.length === 1) {

            hours = '0' + digits;

            minutes = '00';

          } else if (digits.length === 2) {

            hours = digits;

            minutes = '00';

          } else if (digits.length === 3) {

            hours = digits.slice(0, 1);

            minutes = digits.slice(1);

          } else {

            hours = digits.slice(0, 2);

            minutes = digits.slice(2);

          }

          const hourNum = clampNumber(Number(hours), 0, 23);

          const minuteNum = clampNumber(Number(minutes), 0, 59);

          return pad2(hourNum) + ':' + pad2(minuteNum);

        };



        const applyTimeInputBehavior = (input) => {

          if (!input || input.dataset.timeFormatterApplied === '1') return;

          input.dataset.timeFormatterApplied = '1';

          input.type = 'text';

          input.setAttribute('inputmode', 'numeric');

          input.setAttribute('pattern', '[0-2][0-9]:[0-5][0-9]');

          input.setAttribute('title', 'Use 24-hour format HH:MM');

          if (!input.getAttribute('placeholder')) {

            input.setAttribute('placeholder', 'HH:MM');

          }

          input.setAttribute('autocomplete', 'off');

          const listId = ensureTimePresetList();

          if (listId) {

            input.setAttribute('list', listId);

          }

          const commitIfChanged = () => {

            const current = input.value.trim();

            if (input.dataset.timeCommittedValue === current) return;

            input.dataset.timeCommittedValue = current;

            input.dispatchEvent(new Event('change', { bubbles: true }));

          };

          const enforce = () => {

            const trimmed = input.value.trim();

            if (!trimmed) {

              input.classList.remove('is-invalid');

              input.setCustomValidity('');

              input.value = '';

              commitIfChanged();

              return;

            }

            const normalized = normalizeTimeInputValue(trimmed);

            if (!TIME_VALUE_REGEX.test(normalized)) {

              input.classList.add('is-invalid');

              input.setCustomValidity('Use 24-hour format HH:MM');

              input.value = normalized;

            } else {

              input.classList.remove('is-invalid');

              input.setCustomValidity('');

              input.value = normalized;

              commitIfChanged();

            }

          };

          input.addEventListener('input', () => {

            const draft = formatTimeDraft(input.value);

            input.value = draft;

            if (!draft) {

              input.classList.remove('is-invalid');

              input.setCustomValidity('');

              commitIfChanged();

              return;

            }

            if (TIME_VALUE_REGEX.test(draft)) {

              input.classList.remove('is-invalid');

              input.setCustomValidity('');

              commitIfChanged();

            }

          });

          input.addEventListener('blur', () => {

            enforce();

          });

          input.addEventListener('keydown', (event) => {

            if (event.key === 'Enter') {

              event.preventDefault();

              enforce();

            }

          });

          input.addEventListener('focus', () => {

            requestAnimationFrame(() => {

              try {

                input.select();

              } catch (err) {

                /* ignore selection failures */

              }

            });

          });

          const initial = normalizeTimeInputValue(input.value || '');

          if (initial && TIME_VALUE_REGEX.test(initial)) {

            input.value = initial;

            input.dataset.timeCommittedValue = initial;

          } else {

            input.dataset.timeCommittedValue = (input.value || '').trim();

          }

        };



        const normalizeDateTimeText = (raw) => {

          if (typeof raw !== 'string') return { iso: '', display: '' };

          const trimmed = raw.trim();

          if (!trimmed) return { iso: '', display: '' };

          let cleaned = trimmed

            .replace(/[\/\.]/g, '-')

            .replace(/[tT]/, ' ')

            .replace(/\\s+/g, ' ')

            .trim();



          // Typed/displayed as dd.mm.yyyy HH:MM; ISO yyyy-mm-dd is still accepted so a
          // pasted or previously-stored value round-trips. The submitted value stays ISO.
          let year;

          let month;

          let day;

          let hours;

          let minutes;

          let match = /^(\\d{1,2})-(\\d{1,2})-(\\d{4})\\s+([0-2]?\\d):([0-5]?\\d)$/.exec(cleaned);

          if (match) {

            day = match[1];

            month = match[2];

            year = match[3];

          } else {

            match = /^(\\d{4})-(\\d{1,2})-(\\d{1,2})\\s+([0-2]?\\d):([0-5]?\\d)$/.exec(cleaned);

            if (match) {

              year = match[1];

              month = match[2];

              day = match[3];

            }

          }

          if (match) {

            hours = match[4];

            minutes = match[5];

          } else {

            const digitsOnly = cleaned.replace(/\\D/g, '');

            if (digitsOnly.length !== 12) {

              return { iso: '', display: cleaned };

            }

            day = digitsOnly.slice(0, 2);

            month = digitsOnly.slice(2, 4);

            year = digitsOnly.slice(4, 8);

            hours = digitsOnly.slice(8, 10);

            minutes = digitsOnly.slice(10, 12);

          }



          const yyyy = String(clampNumber(Number(year), 1970, 9999)).padStart(4, '0');

          const mm = String(clampNumber(Number(month), 1, 12)).padStart(2, '0');

          const dd = String(clampNumber(Number(day), 1, 31)).padStart(2, '0');

          const hh = String(clampNumber(Number(hours), 0, 23)).padStart(2, '0');

          const min = String(clampNumber(Number(minutes), 0, 59)).padStart(2, '0');

          return { iso: yyyy + '-' + mm + '-' + dd + 'T' + hh + ':' + min, display: dd + '.' + mm + '.' + yyyy + ' ' + hh + ':' + min };

        };



        const applyDateTimeTextBehavior = (input) => {

          if (!input || input.dataset.datetimeFormatterApplied === '1') return;

          input.dataset.datetimeFormatterApplied = '1';

          const enforce = () => {

            const normalized = normalizeDateTimeText(input.value);

            if (input.value.trim() && !normalized.iso) {

              input.classList.add('is-invalid');

              input.setCustomValidity('Use DD.MM.YYYY HH:MM');

            } else {

              input.classList.remove('is-invalid');

              input.setCustomValidity('');

            }

            input.value = normalized.display;

          };

          input.addEventListener('input', () => {

            input.value = input.value.replace(/[^0-9 T:.-]/g, '');

          });

          input.addEventListener('blur', enforce);

          enforce();

        };



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

          debugToggleEls.forEach((el) => {

            el.checked = debugState.enabled;

          });

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

            requestAnimationFrame(() => fillDebugDefaults());

          }

          try {

            window.localStorage.setItem(DEBUG_KEY, debugState.enabled ? '1' : '0');

          } catch (err) {

            // ignore storage failures

          }

        }



        function fillDebugDefaults() {

          if (!debugState.enabled) return;



          const formType = formTypeSelectEl ? formTypeSelectEl.value : '';

          const isInstallation = formType === 'installation_report';

          const isServiceOrMaintenance = formType === 'service_report' || formType === 'maintenance';



          const firstOptionValue = (datalistId) => {

            if (!datalistId) return '';

            const list =

              document.getElementById(datalistId) ||

              document.querySelector('datalist#' + datalistId) ||

              document.querySelector('[data-suggest-list=\"' + datalistId + '\"]');

            if (!list) return '';

            const opt = list.querySelector('option');

            return opt ? opt.value || '' : '';

          };



          const setIfEmpty = (selector, value) => {

            const el = formEl.querySelector(selector);

            if (el && !el.value.trim()) {

              el.value = value;

              el.dispatchEvent(new Event('input', { bubbles: true }));

              el.dispatchEvent(new Event('change', { bubbles: true }));

            }

            return el;

          };



          const setCheckbox = (name, checked = true) => {

            const el = formEl.querySelector('input[name=\"' + name + '\"]');

            if (el && el.type === 'checkbox' && el.checked !== checked) {

              el.checked = checked;

              el.dispatchEvent(new Event('change', { bubbles: true }));

            }

            return el;

          };



          const setSelect = (name, value) => {

            const el = formEl.querySelector('select[name=\"' + name + '\"]');

            if (el && !el.value) {

              el.value = value;

              el.dispatchEvent(new Event('change', { bubbles: true }));

            }

            return el;

          };



          const toLocalDateTimeValue = (date) => {

            if (!(date instanceof Date)) return '';

            const tzSafe = new Date(date.getTime() - date.getTimezoneOffset() * 60000);

            return tzSafe.toISOString().slice(0, 16);

          };



          const todayIso = new Date().toISOString().slice(0, 10);

          if (formType === 'daily_report') {

            setIfEmpty('[name="daily_project_number"]', 'DR-001');

            setIfEmpty('[name="daily_report_date"]', todayIso);

            setIfEmpty('[name="submitter_name"]', 'Debug Reporter');

            setIfEmpty('[name="daily_report_text"]', 'Daily report summary (debug).');

            return;

          }

          if (isInstallation) {

            const projectSeed = 'Demo Building Project';

            const clientSeed = firstOptionValue('suggest-end-customer-name') || 'Debug Client GmbH';

            const supplierSeed =

              firstOptionValue('suggest-service-company-name') || 'Sharp / NEC Install Team';



            setIfEmpty('[name=\"batch_number\"]', 'LSC-DBG-001');


            setIfEmpty('[name=\"customer_company\"]', clientSeed);

            setIfEmpty('[name=\"completion_date\"]', todayIso);

            setIfEmpty('[name=\"acceptance_date\"]', todayIso);

            setIfEmpty('[name=\"acceptance_location\"]', 'Berlin');

            setIfEmpty('[name=\"attendee_client\"]', clientSeed + ' representative');

            setIfEmpty('[name=\"attendee_supplier\"]', supplierSeed + ' representative');



            setCheckbox('acceptance_overall', true);

            setCheckbox('acceptance_partial', false);

            setIfEmpty('[name=\"partial_services\"]', 'Installed LED wall, cabling, and handover.');



            setSelect('installation_status', 'not_finished');

            setIfEmpty('[name=\"installation_partial_notes\"]', 'Cable trunking on the rear side still open.');

            setCheckbox('installation_has_defects', true);

            setIfEmpty('[name=\"installation_defects\"]', 'Two modules show a slight colour shift in the lower right corner.');

            setIfEmpty('[name=\"installation_remaining\"]', 'Cleaning and handover of documentation.');

            setSelect('installation_followup_type', 'planned');

            setIfEmpty('[name=\"installation_followup_date\"]', todayIso);



            setIfEmpty('[name=\"warranty_years\"]', '2');

            setIfEmpty('[name=\"warranty_start_date\"]', todayIso);

            updateWarrantyEnd();



            const nowInput = toLocalDateTimeValue(new Date());

            setIfEmpty('[name=\"engineer_company\"]', supplierSeed);

            setIfEmpty('[name=\"engineer_name\"]', 'Debug Installer');


            setIfEmpty('[name=\"customer_company\"]', clientSeed);

            setIfEmpty('[name=\"customer_name\"]', clientSeed + ' representative');




            return;

          }



          setIfEmpty(

            '[name=\"end_customer_name\"]',

            firstOptionValue('suggest-end-customer-name') || 'Debug Customer GmbH',

          );

          setIfEmpty(

            '[name=\"site_location\"]',

            firstOptionValue('suggest-site-location') || 'Berlin, Teststrasse 1',

          );

          setIfEmpty(

            '[name=\"led_display_model\"]',

            firstOptionValue('suggest-led-display-model') || 'FA 1.5 / 1.9 / 2.5',

          );

          setIfEmpty('[name=\"batch_number\"]', 'DBG-001');

          setIfEmpty('[name=\"date_of_service\"]', todayIso);

          setIfEmpty(

            '[name=\"service_company_name\"]',

            firstOptionValue('suggest-service-company-name') || 'Sharp / NEC LED Solution Center',

          );



          const firstEngineer = firstOptionValue('suggest-employee-name') || 'Debug Engineer';

          const firstCustomer = firstOptionValue('suggest-end-customer-name') || 'Debug Customer';

          setIfEmpty('#engineer-name', firstEngineer);

          setIfEmpty('#customer-representative', firstCustomer + ' representative');

          setIfEmpty(

            '#engineer-company',

            firstOptionValue('suggest-service-company-name') || 'Debug Service Co',

          );

          setIfEmpty(

            '#customer-company',

            firstOptionValue('suggest-end-customer-name') || 'Debug Client Co',

          );



          if (!isServiceOrMaintenance) return;



          const ensureEmployeeRow = () => {

            let rows = Array.from(document.querySelectorAll('[data-employee-row]'));

            if (!rows.length) {

              const addBtn = document.querySelector('[data-action=\"employee-add\"]');

              if (addBtn) {

                addBtn.click();

                rows = Array.from(document.querySelectorAll('[data-employee-row]'));

              }

            }

            return rows;

          };



          const rows = ensureEmployeeRow();

          if (rows.length) {

            const row = rows[0];

            const setRowField = (field, value) => {

              const input = row.querySelector('input[data-field=\"' + field + '\"]');

              if (input && !input.value.trim()) {

                input.value = value;

                input.dispatchEvent(new Event('input', { bubbles: true }));

                input.dispatchEvent(new Event('change', { bubbles: true }));

              }

            };

            const employeeNameSeed = firstOptionValue('suggest-employee-name') || 'Debug Engineer';

            const employeeRoleSeed = firstOptionValue('suggest-employee-role') || 'Technician';

            setRowField('name', employeeNameSeed);

            setRowField('role', employeeRoleSeed);



            const setDateTime = (field, iso) => {

              const wrap = row.querySelector('[data-datetime-field=\"' + field + '\"]');

              if (!wrap) return;

              const dateInput = wrap.querySelector('input[data-datetime-part=\"date\"]');

              const timeInput = wrap.querySelector('input[data-datetime-part=\"time\"]');

              const hiddenInput = wrap.querySelector('input[data-field=\"' + field + '\"]');

              const parts = iso.split('T');

              if (dateInput && !dateInput.value.trim()) {

                dateInput.value = parts[0] || '';

                dateInput.dispatchEvent(new Event('input', { bubbles: true }));

              }

              if (timeInput && !timeInput.value.trim()) {

                const timeVal = (parts[1] || '').slice(0, 5);

                timeInput.value = timeVal;

                timeInput.dataset.timeCommittedValue = timeVal;

                timeInput.dispatchEvent(new Event('input', { bubbles: true }));

              }

              if (hiddenInput && !hiddenInput.value.trim()) {

                hiddenInput.value = iso;

              }

            };



            const now = new Date();

            const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);

            const fmt = (d) =>

              d.getFullYear() +

              '-' +

              String(d.getMonth() + 1).padStart(2, '0') +

              '-' +

              String(d.getDate()).padStart(2, '0') +

              'T' +

              String(d.getHours()).padStart(2, '0') +

              ':' +

              String(d.getMinutes()).padStart(2, '0');

            setDateTime('arrival', fmt(now));

            setDateTime('departure', fmt(oneHourLater));

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



        const PHOTO_COMPRESS_MAX_EDGE = 1600;
        const PHOTO_COMPRESS_QUALITY = 0.78;
        const PHOTO_COMPRESS_MIN_BYTES = 350 * 1024;

        const loadImageFromFile = (file) =>
          new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
              URL.revokeObjectURL(objectUrl);
              resolve(img);
            };
            img.onerror = (err) => {
              URL.revokeObjectURL(objectUrl);
              reject(err || new Error('Image load failed.'));
            };
            img.src = objectUrl;
          });

        const normalizeCompressedName = (name, mimeType) => {
          const base = String(name || 'upload').replace(/\.[^/.]+$/, '');
          if (mimeType === 'image/jpeg') {
            return base + '.jpg';
          }
          return base;
        };

        const compressImageFile = async (file) => {
          if (!(file instanceof File)) return file;
          if (!file.type || !file.type.startsWith('image/')) return file;
          if (file.size && file.size < PHOTO_COMPRESS_MIN_BYTES) return file;
          let img;
          try {
            img = await loadImageFromFile(file);
          } catch (err) {
            return file;
          }
          const width = img.naturalWidth || img.width || 0;
          const height = img.naturalHeight || img.height || 0;
          if (!width || !height) return file;
          const maxEdge = Math.max(width, height);
          const scale = maxEdge > PHOTO_COMPRESS_MAX_EDGE ? PHOTO_COMPRESS_MAX_EDGE / maxEdge : 1;
          const targetWidth = Math.max(1, Math.round(width * scale));
          const targetHeight = Math.max(1, Math.round(height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) return file;
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, targetWidth, targetHeight);
          ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
          const blob = await new Promise((resolve) => {
            canvas.toBlob((value) => resolve(value), 'image/jpeg', PHOTO_COMPRESS_QUALITY);
          });
          if (!blob || !blob.size || blob.size >= file.size) return file;
          return new File([blob], normalizeCompressedName(file.name, blob.type), {
            type: blob.type,
            lastModified: file.lastModified,
          });
        };

        const compressFormImages = async (rawFormData) => {
          let originalBytes = 0;
          let compressedBytes = 0;
          let compressedCount = 0;
          let totalFiles = 0;
          const compressedFormData = new FormData();

          for (const [key, value] of rawFormData.entries()) {
            if (value instanceof File) {
              totalFiles += 1;
              const size = value.size || 0;
              originalBytes += size;
              let nextFile = value;
              try {
                nextFile = await compressImageFile(value);
              } catch (err) {
                nextFile = value;
              }
              if (nextFile !== value) {
                compressedCount += 1;
                compressedBytes += nextFile.size || 0;
              } else {
                compressedBytes += size;
              }
              compressedFormData.append(key, nextFile, nextFile.name);
            } else {
              compressedFormData.append(key, value);
            }
          }

          if (!totalFiles) {
            return {
              formData: rawFormData,
              originalBytes: 0,
              compressedBytes: 0,
              compressedCount: 0,
              totalFiles: 0,
            };
          }

          return {
            formData: compressedFormData,
            originalBytes,
            compressedBytes,
            compressedCount,
            totalFiles,
          };
        };


        function revokePreviewUrls(fieldName) {

          const urls = previewUrls.get(fieldName);

          if (urls) {

            urls.forEach((url) => URL.revokeObjectURL(url));

          }

          previewUrls.delete(fieldName);

        }

        // Remove one photo (by index) from a field's real <input type=file> via a
        // DataTransfer, then refresh the preview — mirrors how photos are added.
        function removePhotoAt(fieldName, index) {
          const input = formEl.querySelector('[data-photo-input="' + fieldName + '"]');
          if (!input) return;
          const container = document.querySelector('[data-photo-preview="' + fieldName + '"]');
          const mode = (container && container.dataset.photoMode) || (input.multiple ? 'multi' : 'single');
          const kept = Array.prototype.slice.call(input.files || []).filter(function (_f, i) { return i !== index; });
          let dt;
          try { dt = new DataTransfer(); } catch (e) { return; }
          kept.forEach(function (f) { dt.items.add(f); });
          input.files = dt.files;
          handleFileSelection(fieldName, input.files, mode);
        }

        // Full-size preview overlay (single reused element). Click backdrop/×/Esc to close.
        function openPhotoLightbox(src, name) {
          let ov = document.querySelector('[data-photo-lightbox]');
          if (!ov) {
            ov = document.createElement('div');
            ov.dataset.photoLightbox = 'true';
            ov.className = 'photo-lightbox';
            ov.hidden = true;
            const img = document.createElement('img');
            img.dataset.photoLightboxImg = 'true';
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'photo-lightbox-close';
            close.setAttribute('aria-label', 'Close');
            close.textContent = '×';
            ov.appendChild(close);
            ov.appendChild(img);
            document.body.appendChild(ov);
            // Clear the src on close so the overlay never keeps a blob URL that a later
            // photo removal revokes (which would log a broken-image error).
            const hide = function () { ov.hidden = true; img.removeAttribute('src'); };
            ov.addEventListener('click', function (e) { if (e.target === ov || e.target === close) hide(); });
            document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !ov.hidden) hide(); });
          }
          const img = ov.querySelector('[data-photo-lightbox-img]');
          img.src = src;
          img.alt = name || '';
          ov.hidden = false;
        }

        // Build one preview tile: thumbnail + hover controls (× remove, magnifier preview)
        // + caption. Pushes the created object URL into urls for later revocation.
        function buildPhotoPreviewItem(fieldName, file, mode, index, urls) {
          const item = document.createElement('div');
          item.className = 'photo-preview-item';

          const thumb = document.createElement('div');
          thumb.className = 'photo-item-thumb';

          const img = document.createElement('img');
          const url = URL.createObjectURL(file);
          urls.push(url);
          img.src = url;
          img.alt = file.name;
          img.onerror = function () {
            URL.revokeObjectURL(url);
            const reader = new FileReader();
            reader.onload = function () { img.src = reader.result; };
            reader.readAsDataURL(file);
          };

          const zoomBtn = document.createElement('button');
          zoomBtn.type = 'button';
          zoomBtn.className = 'photo-item-zoom';
          zoomBtn.title = 'Preview';
          zoomBtn.setAttribute('aria-label', 'Preview photo');
          zoomBtn.textContent = '🔍';
          zoomBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            openPhotoLightbox(img.src, file.name);
          });

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'photo-item-remove';
          removeBtn.title = 'Remove';
          removeBtn.setAttribute('aria-label', 'Remove photo');
          removeBtn.textContent = '×';
          removeBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            removePhotoAt(fieldName, index);
          });

          thumb.appendChild(img);
          thumb.appendChild(zoomBtn);
          thumb.appendChild(removeBtn);

          const caption = document.createElement('span');
          caption.textContent = file.name + ' (' + formatBytes(file.size || 0) + ')';

          item.appendChild(thumb);
          item.appendChild(caption);
          return item;
        }

        function renderPreview(fieldName, files, mode) {

          const container = document.querySelector('[data-photo-preview="' + fieldName + '"]');

          if (!container) return;

          // Clear the DOM first, then revoke the old object URLs — revoking while the old
          // <img> tags are still attached makes the browser log ERR_FILE_NOT_FOUND for them.
          container.innerHTML = '';

          revokePreviewUrls(fieldName);

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

            files.forEach((file, index) => {

              list.appendChild(buildPhotoPreviewItem(fieldName, file, mode, index, urls));

            });

            container.appendChild(list);

          } else {

            const file = files[0];

            container.appendChild(buildPhotoPreviewItem(fieldName, file, mode, 0, urls));

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



        function setupDateTimeTextInputs() {

          document.querySelectorAll(DATETIME_TEXT_SELECTOR).forEach((input) => {

            applyDateTimeTextBehavior(input);

          });

        }



        function setupPartsTable() {

          const hiddenClass = 'is-hidden-row';

          // The spare-stock table reuses this row add/remove behaviour but carries its own
          // attribute, so it is not caught by the submit-time "disable every parts section
          // except the active one" rule.
          const sections = Array.from(document.querySelectorAll('[data-parts-section], [data-stock-section]'));

          if (!sections.length) return;



          sections.forEach((section) => {

            const table = section.querySelector('[data-parts-table]');

            if (!table) return;

            const rows = Array.from(table.querySelectorAll('.parts-row'));

            const addButton = section.querySelector('[data-action="parts-add-row"]');

            const removeButton = section.querySelector('[data-action="parts-remove-row"]');



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

          });

        }



        function setupPartsOcr() {

          const anyTrigger = document.querySelector('[data-parts-ocr]');

          if (!anyTrigger) return;

          const friendlyHint = 'Upload a clear photo of the part label to auto-fill serial/model fields (OCR).';



          const ensureHint = () => {

            const section = findActivePartsSection();

            const statusEl = section ? section.querySelector('[data-parts-ocr-status]') : null;

            if (statusEl && !statusEl.textContent.trim()) {

              statusEl.textContent = friendlyHint;

              statusEl.style.color = '#475569';

            }

          };

          ensureHint();



          const processFile = (file, inputEl) => {

            if (!file) {

              setPartsOcrStatus('No photo selected.', true);

              return;

            }

            recordDebug('parts-ocr-start', { name: file.name, size: file.size || 0 });

            Promise.resolve(handlePartsOcrFile(file))

              .then(() => {

                recordDebug('parts-ocr-complete', { name: file.name });

              })

              .catch((err) => {

                setPartsOcrStatus(err && err.message ? err.message : 'OCR failed.', true);

                recordDebug('parts-ocr-error', { error: String(err && err.message ? err.message : err) });

              });

            if (inputEl) {

              inputEl.value = '';

            }

          };



          document.addEventListener('click', (event) => {

            const button = event.target.closest('[data-parts-ocr]');

            if (!button) return;

            event.preventDefault();

            const section = button.closest('[data-parts-section]') || findActivePartsSection();

            const inputEl = section ? section.querySelector('[data-parts-ocr-input]') : null;

            if (inputEl) {

              inputEl.click();

            } else {

              setPartsOcrStatus('Photo input is unavailable on this device.', true);

            }

          });



          document.addEventListener('change', (event) => {

            const input = event.target && event.target.closest ? event.target.closest('[data-parts-ocr-input]') : null;

            if (!input) return;

            const section = input.closest('[data-parts-section]');

            if (section && (section.hidden || section.style.display === 'none')) return;

            const files = event.target && event.target.files ? Array.from(event.target.files) : [];

            processFile(files[0], input);

          });

        }



        function setupEmployees() {

          const section = document.querySelector('[data-employees-section]');

          if (!section) return;

          ensureTimePresetList();



          const listEl = section.querySelector('[data-employee-list]');

          const template = section.querySelector('#employee-row-template');

          const addButton = section.querySelector('[data-action="employee-add"]');
          const breaksToggleEl = section.querySelector('[data-breaks-toggle]');

          const summaryEl = section.querySelector('[data-employee-summary]');

          const summaryTotalEl = summaryEl ? summaryEl.querySelector('[data-employee-total]') : null;

          const summaryCountEl = summaryEl ? summaryEl.querySelector('[data-employee-count]') : null;



          if (!listEl || !template) return;



          const engineerNameInput = document.querySelector('#engineer-name');

          const engineerDatetimeInput = document.querySelector('#engineer-datetime');

          const customerDatetimeInput = document.querySelector('#customer-datetime');



          const maxRows = Math.max(1, Number(section.dataset.employeeMax || '0') || 20);

          const DEFAULT_SHIFT_MINUTES = 8 * 60;

          const rowStates = new Map();

          let groupCounter = 1;

          const createGroupId = () => 'emp-' + groupCounter++;

          let suppressSummaryLog = false;



          const signoffSync = {

            name: { manual: false, syncedValue: '' },

            datetime: { manual: false, syncedValue: '' },

          };
          const breaksEnabled = () => Boolean(breaksToggleEl && breaksToggleEl.checked);



          const pad = (value) => (value < 10 ? '0' + value : String(value));



          const formatIsoFromDate = (date) => {

            if (!(date instanceof Date) || Number.isNaN(date.getTime())) {

              return '';

            }

            return (

              date.getFullYear() +

              '-' +

              pad(date.getMonth() + 1) +

              '-' +

              pad(date.getDate()) +

              'T' +

              pad(date.getHours()) +

              ':' +

              pad(date.getMinutes())

            );

          };



          const parseLocalDateTime = (value) => {

            if (typeof value !== 'string') return null;

            const trimmed = value.trim();

            if (!trimmed) return null;

            const match = /^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})$/.exec(trimmed);

            if (!match) return null;

            const date = new Date(

              Number(match[1]),

              Number(match[2]) - 1,

              Number(match[3]),

              Number(match[4]),

              Number(match[5]),

              0,

              0

            );

            if (Number.isNaN(date.getTime())) return null;

            return date;

          };



          const nowLocalIso = () => formatIsoFromDate(new Date());

          const formSessionStartIso = nowLocalIso();



          const addMinutesToIso = (iso, minutes) => {

            const base = parseLocalDateTime(iso);

            if (!base) return '';

            const delta = Number(minutes || 0);

            if (Number.isNaN(delta)) return iso;

            base.setMinutes(base.getMinutes() + delta);

            return formatIsoFromDate(base);

          };

          const addDaysToIso = (iso, days) => {

            const base = parseLocalDateTime(iso);

            if (!base) return '';

            const delta = Number(days || 0);

            if (Number.isNaN(delta)) return iso;

            base.setDate(base.getDate() + delta);

            return formatIsoFromDate(base);

          };



          const formatEmployeeDuration = (minutes) => {

            if (!Number.isFinite(minutes) || minutes <= 0) return '0m';

            const rounded = Math.round(minutes);

            const hours = Math.floor(rounded / 60);

            const mins = Math.max(0, rounded - hours * 60);

            const parts = [];

            if (hours) parts.push(hours + 'h');

            if (mins) parts.push(mins + 'm');

            return parts.length ? parts.join(' ') : '0m';

          };



          const determineBreakRequirement = (minutes) => {

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

          };



          const formatBreakStatsSummary = (stats) => {

            if (!stats) return '';

            const descriptors = [

              { key: 'MIN45', label: '>=45m (>9h)' },

              { key: 'MIN30', label: '>=30m (6-9h, 2x15m)' },

              { key: 'NONE', label: 'no mandatory break (<=6h)' },

            ];

            const parts = [];

            descriptors.forEach(({ key, label }) => {

              const count = Number(stats[key] || 0);

              if (count > 0) {

                parts.push(count + ' x ' + label);

              }

            });

            const pending = Number(stats.UNKNOWN || 0);

            if (pending > 0 && parts.length) {

              parts.push(pending + ' x pending');

            }

            return parts.join(', ');

          };



          const rowElements = () => Array.from(listEl.querySelectorAll('[data-employee-row]'));

          const isPrimaryRow = (row) => row && row === rowElements()[0];



          const ensureSignoffDefaults = () => {

            const defaultIso = nowLocalIso();

            if (engineerDatetimeInput && !engineerDatetimeInput.value) {

              engineerDatetimeInput.value = defaultIso;

              signoffSync.datetime.syncedValue = defaultIso;

            }

            if (customerDatetimeInput && !customerDatetimeInput.value) {

              customerDatetimeInput.value = defaultIso;

            }

          };



          ensureSignoffDefaults();



          if (engineerNameInput) {

            engineerNameInput.addEventListener('input', () => {

              signoffSync.name.manual = true;

            });

          }

          if (engineerDatetimeInput) {

            engineerDatetimeInput.addEventListener('input', () => {

              signoffSync.datetime.manual = true;

            });

          }



          function setDateTimeValue(row, field, iso) {

            const wrapper = row.querySelector('[data-datetime-field="' + field + '"]');

            if (!wrapper) return;

            const hidden = wrapper.querySelector('input[data-field="' + field + '"]');

            const dateInput = wrapper.querySelector('input[data-datetime-part="date"]');

            const timeInput = wrapper.querySelector('input[data-datetime-part="time"]');

            const safeIso = iso || '';

            if (hidden) hidden.value = safeIso;

            const parts = safeIso.split('T');

            if (dateInput) {

              dateInput.value = parts[0] || '';

            }

            if (timeInput) {

              const nextValue = parts[1] ? parts[1].slice(0, 5) : '';

              timeInput.value = nextValue;

              if (timeInput.dataset) {

                timeInput.dataset.timeCommittedValue = (nextValue || '').trim();

              }

            }

          }



          function getDateTimePair(row, field) {

            const wrapper = row.querySelector('[data-datetime-field="' + field + '"]');

            if (!wrapper) return null;

            return {

              dateInput: wrapper.querySelector('input[data-datetime-part="date"]'),

              timeInput: wrapper.querySelector('input[data-datetime-part="time"]'),

              hiddenInput: wrapper.querySelector('input[data-field="' + field + '"]'),

            };

          }



          const syncGroupInput = (row, groupId) => {

            if (!row) return;

            if (groupId) {

              row.dataset.employeeGroup = groupId;

            }

            const input = row.querySelector('input[data-field="group"]');

            if (input) {

              input.value = row.dataset.employeeGroup || groupId || '';

            }

          };


          function combineDateTimeValue(row, field) {

            const pair = getDateTimePair(row, field);

            if (!pair) return '';

            const dateValue = pair.dateInput ? pair.dateInput.value.trim() : '';

            const timeValue = pair.timeInput ? pair.timeInput.value.trim() : '';

            const hasValidTime = TIME_VALUE_REGEX.test(timeValue);

            const iso = dateValue && hasValidTime ? dateValue + 'T' + timeValue : '';

            if (pair.hiddenInput) {

              if (iso) {

                pair.hiddenInput.value = iso;

              } else if (!dateValue && !timeValue) {

                pair.hiddenInput.value = '';

              } else if (!hasValidTime) {

                pair.hiddenInput.value = '';

              }

            }

            return iso;

          }



          function updateRowDurationDisplay(row, state) {

            const target = row.querySelector('[data-employee-duration]');

            if (!target) return;

            target.textContent =

              'Working time: ' +

              formatEmployeeDuration(state.durationMinutes) +

              ' | Break: ' +

              state.breakLabel;

          }



          const updateControlState = () => {

            if (addButton) {

              addButton.disabled = rowElements().length >= maxRows;

            }

          };



          function renumberRows() {

            rowElements().forEach((row, index) => {

              row.dataset.index = String(index + 1);

              const title = row.querySelector('[data-employee-title]');

              if (title) {

                title.textContent = 'Employee #' + (index + 1);

              }

              const setName = (selector, field) => {

                const input = row.querySelector(selector);

                if (input) {

                  input.name = 'employees[' + index + '][' + field + ']';

                }

              };

              setName('input[data-field="name"]', 'name');

              setName('input[data-field="role"]', 'role');

              setName('input[data-field="arrival"]', 'arrival');

              setName('input[data-field="departure"]', 'departure');

              setName('input[data-field="group"]', 'group');

              syncGroupInput(row, row.dataset.employeeGroup);

            });

            updateControlState();

          }



          const employeeNamePicker = {
            overlay: null,
            input: null,
            roleInput: null,
            resolve: null,
          };

          const ensureEmployeeNameOverlay = () => {
            if (employeeNamePicker.overlay) return;
            if (!document || !document.body) return;
            const overlay = document.createElement('div');
            overlay.dataset.employeeNameOverlay = 'true';
            overlay.className = 'employee-name-overlay';
            overlay.hidden = true;
            overlay.innerHTML =
              '<div class="employee-name-dialog">' +
              '<h3>Select employee</h3>' +
              '<label>' +
              '<span>Employee name</span>' +
              '<input type="text" data-employee-name-input data-suggest-field="employee_name" list="suggest-employee-name" autocomplete="off" placeholder="Start typing..." />' +
              '</label>' +
              '<label>' +
              '<span>Role / position</span>' +
              '<input type="text" data-employee-role-input data-suggest-field="employee_role" list="suggest-employee-role" autocomplete="off" placeholder="Role / position" />' +
              '</label>' +
              '<div class="employee-name-actions">' +
              '<button type="button" class="secondary" data-employee-name-cancel>Cancel</button>' +
              '<button type="button" class="primary" data-employee-name-add>Add</button>' +
              '</div>' +
              '</div>';
            document.body.appendChild(overlay);
            const input = overlay.querySelector('[data-employee-name-input]');
            const roleInput = overlay.querySelector('[data-employee-role-input]');
            const addButton = overlay.querySelector('[data-employee-name-add]');
            const cancelButton = overlay.querySelector('[data-employee-name-cancel]');

            const closeOverlay = (value) => {
              overlay.hidden = true;
              if (input) input.value = '';
              if (roleInput) roleInput.value = '';
              if (employeeNamePicker.resolve) {
                const resolver = employeeNamePicker.resolve;
                employeeNamePicker.resolve = null;
                resolver(value);
              }
            };

            const submitValue = () => {
              const trimmed = input ? input.value.trim() : '';
              const roleTrimmed = roleInput ? roleInput.value.trim() : '';
              closeOverlay({ name: trimmed, role: roleTrimmed });
            };

            const cancel = () => closeOverlay(null);

            overlay.addEventListener('click', (event) => {
              if (event.target === overlay) {
                cancel();
              }
            });

            if (addButton) {
              addButton.addEventListener('click', (event) => {
                event.preventDefault();
                submitValue();
              });
            }

            if (cancelButton) {
              cancelButton.addEventListener('click', (event) => {
                event.preventDefault();
                cancel();
              });
            }

            [input, roleInput].forEach((field) => {
              if (!field) return;
              field.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitValue();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancel();
                }
              });
            });

            employeeNamePicker.overlay = overlay;
            employeeNamePicker.input = input;
            employeeNamePicker.roleInput = roleInput;
            setupAutoSuggestions();
          };

          const requestEmployeeDetails = () => {
            if (!window || !document || !document.body) return Promise.resolve(null);
            ensureEmployeeNameOverlay();
            if (!employeeNamePicker.overlay || !employeeNamePicker.input) {
              return Promise.resolve(null);
            }
            employeeNamePicker.overlay.hidden = false;
            employeeNamePicker.input.value = '';
            if (employeeNamePicker.roleInput) {
              employeeNamePicker.roleInput.value = '';
            }
            employeeNamePicker.input.focus();
            return new Promise((resolve) => {
              employeeNamePicker.resolve = resolve;
            });
          };

          const normalizeEmployeeToken = (value) => {

            return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

          };

          const buildEmployeeKey = (state, row) => {

            const groupId =

              state && state.groupId

                ? state.groupId

                : row && row.dataset

                  ? row.dataset.employeeGroup

                  : '';

            if (groupId) {

              return 'group:' + groupId;

            }

            const nameKey = normalizeEmployeeToken(state ? state.name : '');


            const roleKey = normalizeEmployeeToken(state ? state.role : '');

            if (nameKey || roleKey) {

              return 'nr:' + nameKey + '|' + roleKey;

            }

            const rowIndex = row && row.dataset ? row.dataset.index : '';


            return 'row:' + (rowIndex || '');

          };


          function updateSummary(reason) {
          
            const summary = {
          
              count: 0,
          
              uniqueCount: 0,
          
              totalMinutes: 0,
          
              totalBreakMinutes: 0,
          
              breakStats: { NONE: 0, MIN30: 0, MIN45: 0, UNKNOWN: 0 },
          
            };
          
            const breaksActive = breaksEnabled();
          
            const uniqueKeys = new Set();
          
            rowElements().forEach((row) => {
          
              const state = rowStates.get(row);
          
              if (!state || !state.hasData) return;
          
              summary.count += 1;
          
              const key = buildEmployeeKey(state, row);
          
              if (key) {
          
                uniqueKeys.add(key);
          
              }
          
              summary.totalMinutes += state.durationMinutes;
          
              if (breaksActive) {
          
                summary.totalBreakMinutes += state.breakRequiredMinutes;
          
                if (summary.breakStats[state.breakCode] === undefined) {
          
                  summary.breakStats.UNKNOWN += 1;
          
                } else {
          
                  summary.breakStats[state.breakCode] += 1;
          
                }
          
              }
          
            });
          
            summary.uniqueCount = uniqueKeys.size;
          
            if (summaryTotalEl) {
          
              if (summary.count === 0) {
          
                summaryTotalEl.textContent = 'Working time: 0m | Required breaks: pending';
          
              } else {
          
                summaryTotalEl.textContent =
          
                  'Working time: ' +
          
                  formatEmployeeDuration(summary.totalMinutes) +
          
                  ' | Required breaks: ' +
          
                  (breaksActive ? formatEmployeeDuration(summary.totalBreakMinutes) : 'disabled');
          
              }
          
            }
          
            if (summaryCountEl) {
          
              if (summary.count === 0) {
          
                summaryCountEl.textContent = 'No employees added yet.';
          
              } else {
          
                const employeeCount = summary.uniqueCount || summary.count;
          
                const base =
          
                  employeeCount === 1
          
                    ? '1 employee recorded.'
          
                    : employeeCount + ' employees recorded.';
          
                const breakSummary = breaksActive
          
                  ? formatBreakStatsSummary(summary.breakStats)
          
                  : '';
          
                summaryCountEl.textContent = breakSummary ? base + ' ' + breakSummary : base;
          
              }
          
            }
          
            if (!suppressSummaryLog) {
          
              recordDebug('employee-summary', {
          
                reason: reason || 'update',
          
                totalMinutes: summary.totalMinutes,
          
                totalBreakMinutes: summary.totalBreakMinutes,
          
                breakStats: summary.breakStats,
          
                count: summary.count,
          
                uniqueCount: summary.uniqueCount,
          
                breaksEnabled: breaksActive,
          
              });
          
            }
          
            return summary;
          
          }



          function syncEngineerSignoff(primaryState) {

            if (!primaryState) return;

            if (engineerNameInput && !signoffSync.name.manual && primaryState.name) {

              engineerNameInput.value = primaryState.name;

              signoffSync.name.syncedValue = primaryState.name;

            }

            if (engineerDatetimeInput && !signoffSync.datetime.manual) {

              const candidate = primaryState.departure || primaryState.arrival || nowLocalIso();

              if (candidate) {

                engineerDatetimeInput.value = candidate;

                signoffSync.datetime.syncedValue = candidate;

              }

            }

          }



          function updateRowState(row, reason, options = {}) {

            const previous = rowStates.get(row) || {};

            const indexLabel = row.dataset.index || '';

            const nameInput = row.querySelector('input[data-field="name"]');

            const roleInput = row.querySelector('input[data-field="role"]');



            const name = nameInput ? nameInput.value.trim() : '';

            const role = roleInput ? roleInput.value.trim() : '';

            let arrivalIso = combineDateTimeValue(row, 'arrival');

            let departureIso = combineDateTimeValue(row, 'departure');



            const arrivalDate = parseLocalDateTime(arrivalIso);

            let departureDate = parseLocalDateTime(departureIso);

            let durationMinutes = 0;



            const departurePair = getDateTimePair(row, 'departure');

            const departureTimeInput = departurePair ? departurePair.timeInput : null;

            const departureActive =

              departureTimeInput && document.activeElement === departureTimeInput;

            const departureRaw =

              departureTimeInput && typeof departureTimeInput.value === 'string'

                ? departureTimeInput.value.trim()

                : '';

            const departureValueValid = TIME_VALUE_REGEX.test(departureRaw);



            if (arrivalDate && !departureDate) {

              if (!(departureActive && !departureValueValid)) {

                departureDate = new Date(arrivalDate.getTime() + 60 * 60000);

                departureIso = formatIsoFromDate(departureDate);

                setDateTimeValue(row, 'departure', departureIso);

              }

            }



            if (arrivalDate && departureDate) {

              durationMinutes = Math.round((departureDate.getTime() - arrivalDate.getTime()) / 60000);

              if (durationMinutes <= 0) {

                departureDate = new Date(arrivalDate.getTime() + 15 * 60000);

                departureIso = formatIsoFromDate(departureDate);

                setDateTimeValue(row, 'departure', departureIso);

                durationMinutes = 15;

              }

            }



            const breaksActive = breaksEnabled();

            const breakInfo = breaksActive
              ? determineBreakRequirement(durationMinutes)
              : { code: 'DISABLED', minutes: 0, label: 'Breaks disabled' };

            const hasData = Boolean(name || role || arrivalIso || departureIso);



            let syncedWithPrimary = previous.syncedWithPrimary || false;

            if (options.markSynced === true) {

              syncedWithPrimary = true;

            } else if (reason !== 'primary-sync' && !options.preserveSyncFlag) {

              syncedWithPrimary = false;

            }



            const state = {

              hasData,

              name,

              role,

              groupId: row.dataset.employeeGroup || '',

              arrival: arrivalIso,

              departure: departureIso,

              durationMinutes,

              breakCode: breakInfo.code,

              breakRequiredMinutes: breakInfo.minutes,

              breakLabel: breakInfo.label,

              syncedWithPrimary,

            };



            updateRowDurationDisplay(row, state);

            rowStates.set(row, state);



            if (!suppressSummaryLog && options.logDebug !== false) {

              recordDebug('employee-updated', {

                index: indexLabel,

                reason: reason || 'change',

                hasData,

                durationMinutes,

                breakCode: breakInfo.code,

                syncedWithPrimary,

              });

            }



            if (isPrimaryRow(row)) {

              if (!options.skipPropagation) {

                propagatePrimarySchedule();

              }

              syncEngineerSignoff(state);

            }



            return state;

          }



          function propagatePrimarySchedule() {

            const rows = rowElements();

            if (!rows.length) return;

            const primaryRow = rows[0];

            const primaryState = rowStates.get(primaryRow);

            if (!primaryState || !primaryState.arrival) return;



            let summaryPending = false;

            rows.slice(1).forEach((row) => {

              const state = rowStates.get(row);

              if (!state || !state.hasData || state.syncedWithPrimary) {

                setDateTimeValue(row, 'arrival', primaryState.arrival);

                setDateTimeValue(row, 'departure', primaryState.departure || '');

                updateRowState(row, 'primary-sync', {

                  markSynced: true,

                  skipPropagation: true,

                  logDebug: false,

                  preserveSyncFlag: true,

                });

                summaryPending = true;

              }

            });



            if (summaryPending) {

              updateSummary('primary-sync');

            }

          }



          function attachListeners(row) {

            row

              .querySelectorAll('input[data-field]:not([type="hidden"])')

              .forEach((input) => {

                input.addEventListener('input', () => {

                  updateRowState(row, 'input');

                  updateSummary('input');

                });

                input.addEventListener('change', () => {

                  updateRowState(row, 'change');

                  updateSummary('change');

                });

              });



            ['arrival', 'departure'].forEach((field) => {

              const pair = getDateTimePair(row, field);

              if (!pair) return;

              [pair.dateInput, pair.timeInput].forEach((input) => {

                if (!input) return;

                input.addEventListener('input', () => {

                  updateRowState(row, 'datetime');

                  updateSummary('datetime');

                });

                input.addEventListener('change', () => {

                  updateRowState(row, 'datetime');

                  updateSummary('datetime');

                });

              });

            });


            const addDayBtn = row.querySelector('[data-action="employee-add-day"]');

            if (addDayBtn) {

              addDayBtn.addEventListener('click', (event) => {

                event.preventDefault();

                if (!row.dataset.employeeGroup) {

                  row.dataset.employeeGroup = createGroupId();

                }

                const groupId = row.dataset.employeeGroup;

                syncGroupInput(row, groupId);

                const currentState =

                  rowStates.get(row) ||

                  updateRowState(row, 'add-day', { preserveSyncFlag: true, logDebug: false });

                const name = currentState && currentState.name ? currentState.name : '';

                const role = currentState && currentState.role ? currentState.role : '';

                const baseArrival = (currentState && currentState.arrival) || formSessionStartIso;

                const baseDeparture =

                  (currentState && currentState.departure) ||

                  (baseArrival ? addMinutesToIso(baseArrival, DEFAULT_SHIFT_MINUTES) : '');

                const nextArrival = addDaysToIso(baseArrival, 1) || baseArrival;

                const nextDeparture =

                  baseDeparture ? addDaysToIso(baseDeparture, 1) || baseDeparture : '';

                const clonedRow = addRow(

                  { name, role, arrival: nextArrival, departure: nextDeparture },

                  { summaryTrigger: 'add-day', insertAfter: row, markSynced: false, groupId },

                );

                if (clonedRow) {

                  recordDebug('employee-add-day', {

                    index: clonedRow.dataset.index,

                    sourceIndex: row.dataset.index,

                    arrival: nextArrival,

                    departure: nextDeparture,

                  });

                }

              });

            }

            const removeBtn = row.querySelector('[data-action="employee-remove"]');

            if (removeBtn) {

              removeBtn.addEventListener('click', (event) => {

                event.preventDefault();

                recordDebug('employee-removed', { index: row.dataset.index });

                rowStates.delete(row);

                row.remove();

                renumberRows();

                updateSummary('remove');

                propagatePrimarySchedule();

                const primaryRow = rowElements()[0];

                if (primaryRow) {

                  const primaryState = rowStates.get(primaryRow);

                  if (primaryState) {

                    primaryState.syncedWithPrimary = false;

                    rowStates.set(primaryRow, primaryState);

                    syncEngineerSignoff(primaryState);

                  }

                }

              });

            }

          }



          function bindTimeShortcuts(row) {

            if (!row) return;

            row.querySelectorAll(TIME_INPUT_SELECTOR).forEach((input) => applyTimeInputBehavior(input));

            if (row.dataset.timeShortcutsBound === '1') return;

            row.dataset.timeShortcutsBound = '1';

            row.addEventListener('click', (event) => {

              const trigger = event.target.closest('[data-action="time-now"], [data-action="time-adjust"]');

              if (!trigger) return;

              event.preventDefault();

              const wrapper = trigger.closest('[data-datetime-field]');

              if (!wrapper) return;

              const field = wrapper.dataset.datetimeField;

              if (!field) return;

              const pair = getDateTimePair(row, field);

              if (!pair || !pair.timeInput) return;

              if (trigger.dataset.action === 'time-now') {

                const nowIso = nowLocalIso();

                const dateValue = nowIso.slice(0, 10);

                const timeValue = normalizeTimeInputValue(nowIso.slice(11, 16));

                const iso = dateValue && timeValue ? dateValue + 'T' + timeValue : '';

                if (iso) {

                  setDateTimeValue(row, field, iso);

                } else {

                  if (pair.dateInput && !pair.dateInput.value) {

                    pair.dateInput.value = dateValue;

                  }

                  pair.timeInput.value = timeValue;

                  if (pair.timeInput.dataset) {

                    pair.timeInput.dataset.timeCommittedValue = (timeValue || '').trim();

                  }

                }

                const combinedIso = combineDateTimeValue(row, field) || iso;

                updateRowState(row, 'time-now');

                updateSummary('time-now');

                recordDebug('employee-time-now', {

                  index: row.dataset.index,

                  field,

                  value: combinedIso,

                });

                return;

              }

              if (trigger.dataset.action === 'time-adjust') {

                const step = Number(trigger.dataset.step || 0);

                if (!step) return;

                let iso = combineDateTimeValue(row, field);

                if (!iso) {

                  const datePart =

                    (pair.dateInput && pair.dateInput.value && pair.dateInput.value.trim()) ||

                    nowLocalIso().slice(0, 10);

                  const timePart =

                    normalizeTimeInputValue(pair.timeInput.value) || nowLocalIso().slice(11, 16);

                  iso = datePart + 'T' + timePart;

                }

                if (!iso) return;

                const adjusted = addMinutesToIso(iso, step);

                if (adjusted) {

                  setDateTimeValue(row, field, adjusted);

                  updateRowState(row, 'time-adjust');

                  updateSummary('time-adjust');

                  recordDebug('employee-time-adjust', {

                    index: row.dataset.index,

                    field,

                    step,

                    value: adjusted,

                  });

                }

              }

            });

          }



          function addRow(data = {}, options = {}) {

            const existing = rowElements().length;

            if (existing >= maxRows) {

              if (!options.silent) {

                recordDebug('employee-add-blocked', { reason: 'max-reached', max: maxRows });

              }

              return null;

            }



            const fragment = template.content.cloneNode(true);

            const row = fragment.querySelector('[data-employee-row]');

            const insertAfter = options.insertAfter;

            if (insertAfter && insertAfter.parentNode === listEl) {

              const nextSibling = insertAfter.nextSibling;

              if (nextSibling) {

                listEl.insertBefore(fragment, nextSibling);

              } else {

                listEl.appendChild(fragment);

              }

            } else {

              listEl.appendChild(fragment);

            }

            const resolvedGroupId = options.groupId || createGroupId();

            syncGroupInput(row, resolvedGroupId);

            renumberRows();

            // ensure suggestion handlers are attached for newly added inputs

            setupAutoSuggestions();



            const isPrimary = isPrimaryRow(row);

            const primaryState = rowStates.get(rowElements()[0]) || null;



            const nameInput = row.querySelector('input[data-field="name"]');

            if (nameInput) {

              nameInput.value = data.name ? String(data.name) : '';

            }

            const roleInput = row.querySelector('input[data-field="role"]');

            if (roleInput) {

              roleInput.value = data.role ? String(data.role) : '';

            }



            const arrivalValue =

              (data.arrival ? String(data.arrival) : '') ||

              options.prefillArrival ||

              (isPrimary ? '' : primaryState?.arrival) ||

              '';



            const departureValue =

              (data.departure ? String(data.departure) : '') ||

              options.prefillDeparture ||

              (isPrimary ? '' : primaryState?.departure) ||

              (arrivalValue ? addMinutesToIso(arrivalValue, DEFAULT_SHIFT_MINUTES) : '');



            setDateTimeValue(row, 'arrival', arrivalValue);

            setDateTimeValue(row, 'departure', departureValue);



            bindTimeShortcuts(row);



            attachListeners(row);



            const markSynced =

              options.markSynced !== undefined ? options.markSynced : !isPrimary;

            const skipPropagation =

              options.skipPropagation !== undefined

                ? options.skipPropagation

                : !isPrimary && Boolean(primaryState);


            const state = updateRowState(

              row,

              options.summaryTrigger || (isPrimary ? 'init' : 'seed'),

              {

                markSynced,

                skipPropagation,

                logDebug: !options.silent,

              },

            );



            const summaryReason =

              options.summaryTrigger ||

              (state.hasData ? (isPrimary ? 'init' : 'seed') : 'refresh');

            updateSummary(summaryReason);



            if (!options.silent) {

              recordDebug('employee-added', {

                index: row.dataset.index,

                seeded: Boolean(options.summaryTrigger === 'seed'),

                syncedWithPrimary: markSynced,

              });

              const focusTarget = row.querySelector('input[data-field="name"]');

              if (focusTarget) {

                focusTarget.focus();

              }

            }



            return row;

          }



          let seedEmployees = [];

          if (section.dataset.employeesSeed) {

            try {

              const parsed = JSON.parse(section.dataset.employeesSeed);

              if (Array.isArray(parsed)) {

                seedEmployees = parsed.slice(0, maxRows);

              }

            } catch (err) {

              recordDebug('employee-seed-error', { message: err.message });

            }

          }



          suppressSummaryLog = true;

          if (seedEmployees.length) {

            seedEmployees.forEach((employee) => {

              addRow(

                {

                  name: employee.name,

                  role: employee.role,

                  arrival: employee.arrival,

                  departure: employee.departure,

                },

                { silent: true, summaryTrigger: 'seed' },

              );

            });

          } else {

            addRow(

              {},

              {

                silent: true,

                summaryTrigger: 'init',

              },

            );

          }

          suppressSummaryLog = false;

          updateSummary('init');

          propagatePrimarySchedule();

          const primaryRow = rowElements()[0];

          if (primaryRow) {

            const primaryState = rowStates.get(primaryRow);

            if (primaryState) {

              primaryState.syncedWithPrimary = false;

              rowStates.set(primaryRow, primaryState);

              syncEngineerSignoff(primaryState);

            }

          }



          if (addButton) {

            addButton.addEventListener('click', async (event) => {

              event.preventDefault();
              const details = await requestEmployeeDetails();
              if (!details || !details.name) {
                recordDebug('employee-add-cancelled', {
                  reason: details === null ? 'cancelled' : 'empty-name',
                });
                return;
              }

              const rows = rowElements();

              const primaryRow = rows[0] || null;

              const primaryState = primaryRow ? rowStates.get(primaryRow) : null;

              const primaryGroupId =
                primaryRow && primaryRow.dataset ? primaryRow.dataset.employeeGroup : '';

              const groupRows = primaryGroupId
                ? rows.filter((row) => row.dataset.employeeGroup === primaryGroupId)
                : primaryRow
                ? [primaryRow]
                : [];

              if (groupRows.length > 1) {

                const newGroupId = createGroupId();

                let insertAfter = rows[rows.length - 1] || null;

                let firstNewRow = null;

                groupRows.forEach((sourceRow, index) => {

                  const sourceState = rowStates.get(sourceRow) || {};

                  const baseArrival =
                    sourceState.arrival || (primaryState && primaryState.arrival) || formSessionStartIso;

                  const baseDeparture =
                    sourceState.departure ||
                    (primaryState && primaryState.departure) ||
                    (baseArrival ? addMinutesToIso(baseArrival, DEFAULT_SHIFT_MINUTES) : '');

                  const created = addRow(

                    {
                      name: details.name,
                      role: details.role,
                      arrival: baseArrival,
                      departure: baseDeparture,
                    },

                    {

                      summaryTrigger: 'add',

                      insertAfter,

                      markSynced: false,

                      groupId: newGroupId,

                      silent: index > 0,

                    },

                  );

                  if (created) {

                    if (!firstNewRow) firstNewRow = created;

                    insertAfter = created;

                  }

                });

                if (firstNewRow && primaryState && primaryState.arrival) {

                  recordDebug('employee-arrival-prefill', {

                    index: firstNewRow.dataset.index,

                    value: primaryState.arrival,

                    multiDay: true,

                    count: groupRows.length,

                  });

                }

                return;

              }

              const baseArrival = (primaryState && primaryState.arrival) || formSessionStartIso;

              const row = addRow(

                { name: details.name, role: details.role },

                {

                  prefillArrival: baseArrival,

                  prefillDeparture:

                    (primaryState && primaryState.departure) ||

                    addMinutesToIso(baseArrival, DEFAULT_SHIFT_MINUTES),

                  summaryTrigger: 'add',

                },

              );

              if (row && primaryState && primaryState.arrival) {

                recordDebug('employee-arrival-prefill', {

                  index: row.dataset.index,

                  value: primaryState.arrival,

                });

              }

            });

          }



          if (breaksToggleEl) {

            breaksToggleEl.addEventListener('change', () => {

              rowElements().forEach((row) => {

                updateRowState(row, 'break-toggle', {

                  logDebug: false,

                  preserveSyncFlag: true,

                  skipPropagation: true,

                });

              });

              updateSummary('break-toggle');

            });

          }

        }

        let activePhotoField = null;

        function isPhotoElementVisible(el) {
          return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        }

        // Add dropped/pasted images to a photo field's real <input type=file> (the source of
        // truth for submission) via a DataTransfer, then refresh the preview. multi appends,
        // single replaces. Non-image items are ignored; nameless pastes get a filename.
        function addFilesToPhotoField(fieldName, newFiles) {
          const input = formEl.querySelector('[data-photo-input="' + fieldName + '"]');
          if (!input) return;
          const container = document.querySelector('[data-photo-preview="' + fieldName + '"]');
          const mode = (container && container.dataset.photoMode) || (input.multiple ? 'multi' : 'single');

          const images = Array.prototype.slice.call(newFiles || [])
            .filter(function (f) { return f && f.type && f.type.indexOf('image/') === 0; })
            .map(function (f) {
              if (f.name) return f;
              const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
              try {
                return new File([f], 'pasted-' + Date.now() + '.' + ext, { type: f.type, lastModified: Date.now() });
              } catch (e) { return f; }
            });
          if (!images.length) return;

          let dt;
          try { dt = new DataTransfer(); } catch (e) { return; }
          if (mode === 'multi') {
            Array.prototype.slice.call(input.files || []).forEach(function (f) { dt.items.add(f); });
            images.forEach(function (f) { dt.items.add(f); });
          } else {
            dt.items.add(images[images.length - 1]);
          }
          input.files = dt.files;
          handleFileSelection(fieldName, input.files, mode);
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

            // Drag & drop onto the whole slot; also mark it active so Ctrl+V routes here.
            const zone = container.closest('[data-photo-slot]') || container;
            if (zone.dataset.dropWired !== '1') {
              zone.dataset.dropWired = '1';
              const markActive = () => { activePhotoField = fieldName; };
              zone.addEventListener('mouseenter', markActive);
              zone.addEventListener('click', markActive);
              ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                zone.classList.add('drag-over');
                activePhotoField = fieldName;
              }));
              ['dragleave', 'dragend'].forEach((ev) => zone.addEventListener(ev, (e) => {
                if (ev === 'dragend' || !zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
              }));
              zone.addEventListener('drop', (e) => {
                e.preventDefault();
                zone.classList.remove('drag-over');
                const files = e.dataTransfer && e.dataTransfer.files;
                if (files && files.length) addFilesToPhotoField(fieldName, files);
              });
              const hint = document.createElement('div');
              hint.className = 'photo-drop-hint';
              hint.textContent = 'Tip: drag & drop photos here, or paste them with Ctrl+V.';
              const uploadBtn = zone.querySelector('.upload-button');
              if (uploadBtn && uploadBtn.parentNode) {
                uploadBtn.parentNode.insertBefore(hint, uploadBtn.nextSibling);
              } else {
                zone.appendChild(hint);
              }
            }

          });

          // Paste an image anywhere on the form → route it to the active (or first visible)
          // photo field. Wired once. Non-image pastes fall through to normal text paste.
          if (!document.__photoPasteWired) {
            document.__photoPasteWired = true;
            document.addEventListener('paste', (e) => {
              const items = (e.clipboardData && e.clipboardData.items) || null;
              if (!items) return;
              const imgs = [];
              for (let i = 0; i < items.length; i += 1) {
                const it = items[i];
                if (it && it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
                  const f = it.getAsFile();
                  if (f) imgs.push(f);
                }
              }
              if (!imgs.length) return;
              let field = null;
              if (activePhotoField) {
                const activeSlot = document.querySelector('[data-photo-slot="' + activePhotoField + '"]');
                if (activeSlot && isPhotoElementVisible(activeSlot)) field = activePhotoField;
              }
              if (!field) {
                const firstVisible = Array.prototype.slice.call(document.querySelectorAll('[data-photo-slot]'))
                  .find((slot) => isPhotoElementVisible(slot));
                if (firstVisible) field = firstVisible.dataset.photoSlot;
              }
              if (field) {
                e.preventDefault();
                addFilesToPhotoField(field, imgs);
              }
            });
          }

        }



        function setupSignaturePads() {

          const ratio = window.devicePixelRatio || 1;

          const rotateSignatureDataUrl = (dataUrl, targetWidth, targetHeight) => {

            return new Promise((resolve) => {

              if (!dataUrl || !dataUrl.startsWith('data:image/')) {

                return resolve(null);

              }

              const img = new Image();

              img.onload = () => {

                const canvas = document.createElement('canvas');

                canvas.width = targetHeight * ratio;

                canvas.height = targetWidth * ratio;

                const ctx = canvas.getContext('2d');

                ctx.setTransform(1, 0, 0, 1, 0, 0);

                ctx.clearRect(0, 0, canvas.width, canvas.height);

                ctx.translate(canvas.width / 2, canvas.height / 2);

                ctx.rotate(Math.PI / 2);

                ctx.translate(-canvas.height / 2, -canvas.width / 2);

                ctx.drawImage(img, 0, 0, canvas.height, canvas.width);

                resolve(canvas.toDataURL('image/png'));

              };

              img.onerror = () => resolve(null);

              img.src = dataUrl;

            });

          };

          let overlay = document.querySelector('[data-signature-overlay]');

          if (!overlay) {

            overlay = document.createElement('div');

            overlay.dataset.signatureOverlay = 'true';

            overlay.className = 'signature-overlay';

            overlay.hidden = true;

            overlay.innerHTML =

              '<div class="signature-overlay__panel">' +

              '<div class="signature-overlay__actions">' +

              '<span>Draw signature</span>' +

              '<span class="spacer"></span>' +

              '<button type="button" class="secondary" data-overlay-rotate>Rotate 90 deg</button>' +

              '<button type="button" class="secondary" data-overlay-orientation>Landscape</button>' +

              '<button type="button" class="secondary" data-overlay-clear>Clear</button>' +

              '<button type="button" class="secondary" data-overlay-cancel>Cancel</button>' +

              '<button type="button" class="primary" data-overlay-apply>Apply</button>' +

              '</div>' +

              '<canvas data-overlay-canvas></canvas>' +

              '<div class="signature-arrow-hint" data-arrow-hint>' +

              '<div class="signature-arrow-hint__icon"></div>' +

              '<span class="signature-arrow-hint__label">Sign here</span>' +

              '</div>' +

              '</div>';

            document.body.appendChild(overlay);

          }



          const overlayCanvas = overlay.querySelector('[data-overlay-canvas]');

          const overlayCtx = overlayCanvas.getContext('2d');

          const overlayApply = overlay.querySelector('[data-overlay-apply]');

          const overlayCancel = overlay.querySelector('[data-overlay-cancel]');

          const overlayClear = overlay.querySelector('[data-overlay-clear]');

          const overlayOrientationBtn = overlay.querySelector('[data-overlay-orientation]');

          const overlayRotateBtn = overlay.querySelector('[data-overlay-rotate]');

          const arrowHint = overlay.querySelector('[data-arrow-hint]');



          const overlayState = {

            active: false,

            targetPad: null,

            hiddenInput: null,

            sampleText: '',

            drawing: false,

            orientation: 'portrait',

            rotateDeg: 0,

            rotateDeg: 0,

            mobileFullscreen: false,

            hasDrawn: false,

            cleared: false,

          };



          const logSignatureMetrics = (info) => {

            try {

              console.log('[signature-metrics]', info);

            } catch (e) {

              // ignore

            }

            try {

              recordDebug('signature-metrics', info);

            } catch (e) {

              // ignore

            }

          };



          const drawImageFitted = (ctx, img, targetW, targetH) => {

            const scale = Math.min(targetW / img.width, targetH / img.height);

            const drawW = img.width * scale;

            const drawH = img.height * scale;

            const offsetX = (targetW - drawW) / 2;

            const offsetY = (targetH - drawH) / 2;

            ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

          };



          const setOverlayOrientation = (mode = 'portrait') => {

            overlayState.orientation = mode === 'landscape' ? 'landscape' : 'portrait';

            overlay.dataset.orientation = overlayState.orientation;

            if (overlayOrientationBtn) {

              overlayOrientationBtn.textContent =

                overlayState.orientation === 'landscape' ? 'Portrait' : 'Landscape';

            }

          };



          const updateRotateButton = () => {

            if (!overlayRotateBtn) return;

            const active = overlayState.rotateDeg % 180 !== 0;

            overlayRotateBtn.classList.toggle('is-active', active);

          };



          const resizeCanvasToImage = (canvas, img, maxW, maxH, ratio = 1) => {

            const scale = Math.min(maxW / img.width, maxH / img.height, 1);

            const targetW = Math.max(140, Math.min(img.width * scale, maxW));

            const targetH = Math.max(140, Math.min(img.height * scale, maxH));

            canvas.width = targetW * ratio;

            canvas.height = targetH * ratio;

            canvas.style.width = targetW + 'px';

            canvas.style.height = targetH + 'px';

          };



          const showArrowHint = () => {

            if (arrowHint) arrowHint.classList.remove('is-hidden');

          };



          const hideArrowHint = () => {

            if (arrowHint) arrowHint.classList.add('is-hidden');

          };



          const openOverlay = (pad, hiddenInput, sampleText) => {

            overlayState.active = true;

            overlayState.targetPad = pad;

            overlayState.hiddenInput = hiddenInput;

            overlayState.sampleText = sampleText || '';

            overlay.hidden = false;

            document.body.style.overflow = 'hidden';

            const mobile = isMobileMode();

            overlayState.mobileFullscreen = mobile;

            if (mobile) {

              overlayState.rotateDeg = 90;

              setOverlayOrientation('portrait');

              showArrowHint();

            } else {

              overlayState.rotateDeg = 0;

              setOverlayOrientation(overlayState.orientation);

              hideArrowHint();

            }

            updateRotateButton();



            const resizeOverlayCanvas = () => {

              const panel = overlay.querySelector('.signature-overlay__panel');

              const actionsBar = overlay.querySelector('.signature-overlay__actions');

              const actionsH = actionsBar ? actionsBar.offsetHeight : 48;

              let deviceW, deviceH;

              if (mobile) {

                deviceW = panel.clientWidth || window.innerWidth;

                deviceH = (panel.clientHeight || window.innerHeight) - actionsH;

              } else {

                const isLandscape = overlayState.orientation === 'landscape';

                const w = Math.max(overlay.clientWidth - 32, 320);

                const h = Math.max(overlay.clientHeight - 96, 240);

                deviceW = isLandscape ? Math.max(w, h) : w;

                deviceH = isLandscape ? Math.min(w, h) : h;

              }

              overlayCanvas.width = deviceW * ratio;

              overlayCanvas.height = deviceH * ratio;

              overlayCanvas.style.width = deviceW + 'px';

              overlayCanvas.style.height = deviceH + 'px';

              overlayCtx.setTransform(1, 0, 0, 1, 0, 0);

              overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

              overlayCtx.scale(ratio, ratio);

              overlayCtx.lineCap = 'round';

              overlayCtx.lineJoin = 'round';

              overlayCtx.lineWidth = 2.5;

              overlayCtx.strokeStyle = '#1f2937';

              overlayCtx.fillStyle = '#1f2937';

              // Draw vertical watermark in mobile mode
              if (mobile) {
                overlayCtx.save();
                overlayCtx.globalAlpha = 0.06;
                // Size text to fill ~80% of canvas height (which is width when rotated)
                var wmTargetW = deviceH * 0.8;
                var wmFontSize = 40;
                overlayCtx.font = 'italic ' + wmFontSize + 'px "Segoe Script", "Brush Script MT", "Dancing Script", cursive';
                var wmMeasured = overlayCtx.measureText('Signature').width;
                wmFontSize = Math.floor(wmFontSize * (wmTargetW / wmMeasured));
                wmFontSize = Math.min(wmFontSize, 260);
                overlayCtx.font = 'italic ' + wmFontSize + 'px "Segoe Script", "Brush Script MT", "Dancing Script", cursive';
                overlayCtx.fillStyle = '#2563eb';
                overlayCtx.translate(deviceW / 2, deviceH / 2);
                overlayCtx.rotate(-Math.PI / 2);
                overlayCtx.textAlign = 'center';
                overlayCtx.textBaseline = 'middle';
                overlayCtx.fillText('Signature', 0, 0);
                overlayCtx.restore();
                // Reset pen after watermark
                overlayCtx.fillStyle = '#1f2937';
              }

              overlayState.hasDrawn = false;
              overlayState.cleared = false;

              if (hiddenInput.value) {

                const img = new Image();

                img.onload = () => {

                  drawImageFitted(overlayCtx, img, deviceW, deviceH);

                };

                img.src = hiddenInput.value;

              } else if (sampleText) {

                overlayCtx.font = '28px "Segoe Script", cursive';

                overlayCtx.fillText(sampleText, 24, deviceH / 2 + 10);

              }

            };



            resizeOverlayCanvas();

            window.addEventListener('resize', resizeOverlayCanvas, { once: true });

          };



          const closeOverlay = () => {

            overlayState.active = false;

            overlayState.targetPad = null;

            overlayState.hiddenInput = null;

            overlayState.mobileFullscreen = false;

            overlay.hidden = true;

            document.body.style.overflow = '';

            hideArrowHint();

          };



          let overlayDrawing = false;

          const overlayGetPoint = (event) => {

            const rect = overlayCanvas.getBoundingClientRect();

            return {

              x: (event.clientX ?? (event.touches && event.touches[0]?.clientX) ?? 0) - rect.left,

              y: (event.clientY ?? (event.touches && event.touches[0]?.clientY) ?? 0) - rect.top,

            };

          };



          overlayCanvas.addEventListener('pointerdown', (event) => {

            if (!overlayState.active) return;

            event.preventDefault();

            overlayCanvas.setPointerCapture(event.pointerId);

            overlayDrawing = true;
            overlayState.cleared = false;
            hideArrowHint();

            const { x, y } = overlayGetPoint(event);

            // hasDrawn gates whether Apply keeps the drawing, so it must be set for ANY
            // stroke. It used to be set only when the hidden field was empty — and the pad
            // wrote a blank PNG there on page load, so the field was never empty: the
            // engineer drew in fullscreen, saw the ink, pressed Apply and the signature was
            // silently discarded. Same story when re-signing a report that already has one.
            if (!overlayState.hasDrawn) {
              // Only wipe the canvas when starting from nothing; an existing signature is
              // drawn on top of, not erased.
              if (!overlayState.hiddenInput || !overlayState.hiddenInput.value) {
                overlayCtx.save();
                overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
                overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
                overlayCtx.restore();
              }
              overlayState.hasDrawn = true;
            }

            overlayCtx.beginPath();

            overlayCtx.moveTo(x, y);

          });

          overlayCanvas.addEventListener('pointermove', (event) => {

            if (!overlayDrawing) return;

            event.preventDefault();

            const { x, y } = overlayGetPoint(event);

            overlayCtx.lineTo(x, y);

            overlayCtx.stroke();

          });

          const overlayFinish = (event) => {

            if (!overlayDrawing) return;

            event.preventDefault();

            try {

              overlayCanvas.releasePointerCapture(event.pointerId);

            } catch (err) {}

            overlayDrawing = false;

            overlayCtx.closePath();

          };

          overlayCanvas.addEventListener('pointerup', overlayFinish);

          overlayCanvas.addEventListener('pointerleave', overlayFinish);

          overlayCanvas.addEventListener('pointercancel', overlayFinish);



          overlayClear.addEventListener('click', (event) => {

            event.preventDefault();

            overlayCtx.setTransform(1, 0, 0, 1, 0, 0);

            overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

            overlayCtx.scale(ratio, ratio);

            overlayCtx.lineCap = 'round';

            overlayCtx.lineJoin = 'round';

            overlayCtx.lineWidth = 2.5;

            overlayCtx.strokeStyle = '#1f2937';

            overlayCtx.fillStyle = '#1f2937';

            overlayState.hasDrawn = false;
            
            // Redraw watermark
            const deviceW = overlayCanvas.parentElement.clientWidth;
            const deviceH = overlayCanvas.parentElement.clientHeight;
            const mobile = document.body.style.getPropertyValue('--mobile-scale') || 
                          getComputedStyle(document.body).getPropertyValue('--mobile-scale').trim();
            if (mobile) {
              overlayCtx.save();
              overlayCtx.globalAlpha = 0.06;
              var wmTargetW = deviceH * 0.8;
              var wmFontSize = 40;
              overlayCtx.font = 'italic ' + wmFontSize + 'px "Segoe Script", "Brush Script MT", "Dancing Script", cursive';
              var wmMeasured = overlayCtx.measureText('Signature').width;
              wmFontSize = Math.floor(wmFontSize * (wmTargetW / wmMeasured));
              wmFontSize = Math.min(wmFontSize, 260);
              overlayCtx.font = 'italic ' + wmFontSize + 'px "Segoe Script", "Brush Script MT", "Dancing Script", cursive';
              overlayCtx.fillStyle = '#2563eb';
              overlayCtx.translate(deviceW / 2, deviceH / 2);
              overlayCtx.rotate(-Math.PI / 2);
              overlayCtx.textAlign = 'center';
              overlayCtx.textBaseline = 'middle';
              overlayCtx.fillText('Signature', 0, 0);
              overlayCtx.restore();
              overlayCtx.fillStyle = '#1f2937';
            } else if (overlayState.sampleText) {
              overlayCtx.font = '28px "Segoe Script", cursive';
              overlayCtx.globalAlpha = 0.1;
              overlayCtx.fillText(overlayState.sampleText, 24, deviceH / 2 + 10);
              overlayCtx.globalAlpha = 1.0;
            }

            if (overlayState.mobileFullscreen) showArrowHint();

          });



          if (overlayOrientationBtn) {

            overlayOrientationBtn.addEventListener('click', (event) => {

              event.preventDefault();

              const next = overlayState.orientation === 'landscape' ? 'portrait' : 'landscape';

              setOverlayOrientation(next);

              const resizeEvt = new Event('resize');

              window.dispatchEvent(resizeEvt);

            });

          }

          if (overlayRotateBtn) {

            overlayRotateBtn.addEventListener('click', (event) => {

              event.preventDefault();

              overlayState.rotateDeg = overlayState.rotateDeg ? 0 : 90;

              updateRotateButton();

            });

          }



          overlayCancel.addEventListener('click', (event) => {

            event.preventDefault();

            closeOverlay();

          });



          overlayApply.addEventListener('click', async (event) => {

            event.preventDefault();

            if (!overlayState.active || !overlayState.targetPad || !overlayState.hiddenInput) {

              closeOverlay();

              return;

            }

            if (!overlayState.hasDrawn) {
              if (overlayState.cleared) {
                overlayState.hiddenInput.value = '';
                const targetCanvas = overlayState.targetPad.querySelector('canvas');
                if (targetCanvas) {
                  const targetCtx = targetCanvas.getContext('2d');
                  targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
                }
                overlayState.hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
                window.dispatchEvent(new CustomEvent('signature:cleared', { detail: { pad: overlayState.targetPad } }));
              }
              closeOverlay();
              return;
            }

            let dataUrl = overlayCanvas.toDataURL('image/png');

            const targetCanvas = overlayState.targetPad.querySelector('canvas');

            const targetCtx = targetCanvas.getContext('2d');

            const wrapper = overlayState.targetPad.querySelector('.signature-canvas-wrapper');

            const w = wrapper.clientWidth || 340;

            const h = wrapper.clientHeight || 160;

            const targetRatio = window.devicePixelRatio || 1;

            if (overlayState.rotateDeg) {

              let rotatedUrl = dataUrl;

              const turns = (overlayState.rotateDeg / 90) % 4;

              let currentW = w;

              let currentH = h;

              for (let i = 0; i < turns; i += 1) {

                const rotated = await rotateSignatureDataUrl(rotatedUrl, currentH, currentW);

                if (rotated) {

                  rotatedUrl = rotated;

                }

                const tmp = currentW;

                currentW = currentH;

                currentH = tmp;

              }

              dataUrl = rotatedUrl;

            }

            overlayState.hiddenInput.value = dataUrl;

            targetCanvas.width = w * targetRatio;

            targetCanvas.height = h * targetRatio;

            targetCanvas.style.width = w + 'px';

            targetCanvas.style.height = h + 'px';

            targetCtx.setTransform(1, 0, 0, 1, 0, 0);

            targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);

            targetCtx.scale(targetRatio, targetRatio);

            // Preserve aspect ratio when placing into target canvas

            const img = new Image();

            img.onload = () => {

              resizeCanvasToImage(targetCanvas, img, w, h, targetRatio);

              targetCtx.setTransform(1, 0, 0, 1, 0, 0);

              targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);

              targetCtx.scale(targetRatio, targetRatio);

              drawImageFitted(

                targetCtx,

                img,

                targetCanvas.width / targetRatio,

                targetCanvas.height / targetRatio,

              );

              logSignatureMetrics({

                label: 'signature-apply',

                naturalWidth: img.width,

                naturalHeight: img.height,

                targetWidth: targetCanvas.width,

                targetHeight: targetCanvas.height,

                targetCanvasWidth: targetCanvas.width,

                targetCanvasHeight: targetCanvas.height,

                overlayWidth: overlayCanvas.width,

                overlayHeight: overlayCanvas.height,

                mobileMode: isMobileMode(),

              });

            };

            img.src = dataUrl;

            closeOverlay();

          });



          document.querySelectorAll('.signature-pad').forEach((pad) => {

            const canvas = pad.querySelector('canvas');

            const hiddenInput = pad.querySelector('input[type="hidden"]');

            const clearButton = pad.querySelector('.signature-clear');

            const fullscreenButton = pad.querySelector('.signature-fullscreen');

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

                resizeCanvasToImage(canvas, img, canvasWidth, 320, ratio);

                setPenDefaults();

                drawImageFitted(ctx, img, canvas.width / ratio, canvas.height / ratio);

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

              const idealHeight = Math.max(canvasWidth * 0.45, 140);

              canvasHeight = Math.min(Math.max(idealHeight, 140), 320);

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

              if (window.matchMedia('(max-width: 768px)').matches) {

                event.preventDefault();

                openOverlay(pad, hiddenInput, sampleText);

                return;

              }

              event.preventDefault();

              canvas.setPointerCapture(event.pointerId);

              if (sampleActive) {
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.restore();
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

            // Deliberately NOT syncing here: an untouched pad still serialises to a valid
            // (fully transparent) PNG, and syncing it on load made every submission look
            // signed. The value is written on the first real stroke instead, so an unsigned
            // report arrives unsigned.



            if (fullscreenButton && overlay) {

              fullscreenButton.addEventListener('click', (event) => {

                event.preventDefault();

                openOverlay(pad, hiddenInput, sampleText);

              });

            }

          });

        }



        function setupAutoSuggestions() {

          const inputs = document.querySelectorAll('input[data-suggest-field]');

          if (!inputs.length || typeof fetch !== 'function') return;



          inputs.forEach((input) => {

            if (input.dataset.suggestBound === '1') return;

            input.dataset.suggestBound = '1';

            const fieldName = input.dataset.suggestField;

            if (!fieldName) return;

            const listId = input.getAttribute('list');

            if (!listId) return;

            const dataList = document.getElementById(listId);

            if (!dataList) return;



            // local suggestions built from what has already been typed, including a restored draft

            const localSeeds = [];

            const addLocalSeed = (val) => {

              const next = (val || '').trim();

              if (!next) return;

              if (localSeeds.find((item) => item.toLowerCase() === next.toLowerCase())) return;

              localSeeds.push(next);

              // send them to the server so the suggestions are shared

              if (next.length >= ${MIN_SUGGESTION_LENGTH}) {

                const body = JSON.stringify({ field: fieldName, value: next });

                fetch(buildAppUrl('suggest/save'), {

                  method: 'POST',

                  headers: { 'Content-Type': 'application/json' },

                  body,

                }).catch(() => {});

              }

            };

            if (input.value && input.value.trim()) {

              addLocalSeed(input.value);

            }



            let lastQuery = '';

            let pendingController = null;



            const applySuggestions = (values) => {

              dataList.innerHTML = '';

              const combined = [...localSeeds, ...(Array.isArray(values) ? values : [])];

              const seen = new Set();

              combined.forEach((value) => {

                const normalized = (value || '').trim();

                if (!normalized) return;

                const lower = normalized.toLowerCase();

                if (seen.has(lower)) return;

                seen.add(lower);

                const option = document.createElement('option');

                option.value = normalized;

                dataList.appendChild(option);

              });

            };



            const requestSuggestions = (rawValue, { force = false } = {}) => {

              const query = (rawValue || '').trim();

              if (!force && query === lastQuery) {

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

              fetch(buildAppUrl('suggest' + params), init)

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

            input.addEventListener('focus', () => requestSuggestions(input.value, { force: true }));

            ['change', 'blur'].forEach((eventName) => {

              input.addEventListener(eventName, () => addLocalSeed(input.value));

            });

          });

        }



        if (debugToggleEls.length) {

          let stored = null;

          try {

            stored = window.localStorage.getItem(DEBUG_KEY);

          } catch (err) {

            stored = null;

          }

          applyDebugState(stored === '1');

          debugToggleEls.forEach((el) => {

            el.addEventListener('change', () => {

              applyDebugState(el.checked);

            });

          });

        } else {

          applyDebugState(false);

        }



        setupAutoResizeTextareas();

        setupPartsTable();

        setupPartsOcr();

        setupEmployees();

        setupPhotoUploads();

        setupSignaturePads();

        setupDateTimeTextInputs();

        setupAutoSuggestions();

        updateFilesSummary();



        formEl.addEventListener('submit', async (event) => {

          event.preventDefault();

          if (statusEl) {

            statusEl.textContent = 'Preparing submission...';

          }

          submitButton.classList.remove('is-success', 'is-error');

          submitButton.classList.add('is-disabled');

          submitButton.disabled = true;

          const resetSubmitState = () => {

            submitButton.disabled = false;

            submitButton.classList.remove('is-disabled');

          };



          // Last line of defence: a value written programmatically without firing events
          // would otherwise slip past the mask.
          formEl.querySelectorAll(PROJECT_NUMBER_SELECTOR).forEach(applyProjectNumberMask);

          // Required fields for this document. Nothing is generated until they are filled —
          // the engineer is taken back to the first one instead of getting a half-empty PDF.
          const activeFormType = formTypeSelectEl ? formTypeSelectEl.value : '';
          const requiredList = requiredFieldsFor(activeFormType);
          const missingFields = [];

          requiredList.forEach((field) => {
            // Checkbox group: satisfied when any one of the named boxes is ticked.
            if (field.anyOf) {
              const boxes = field.anyOf
                .map((name) => formEl.querySelector('input[name="' + name + '"]'))
                .filter(Boolean);
              const ticked = boxes.some((box) => box.checked);
              const groupCard = boxes.length ? boxes[0].closest('section.card') : null;
              if (groupCard) groupCard.classList.remove('is-missing');
              if (ticked) return;
              missingFields.push({ ...field, input: boxes[0] || null, reason: field.reason || 'is empty' });
              if (groupCard) groupCard.classList.add('is-missing');
              return;
            }
            clearRequiredMark(field.name);
            const input = findRequiredInput(field.name);
            const value = input ? String(input.value || '').trim() : '';
            let missing = !value;
            let reason = 'is empty';
            // A project number is only usable once it is complete: "44" or "26-21" would
            // pass an emptiness check and still be unusable on the document.
            if (!missing && field.projectNumber) {
              let digits = '';
              for (let i = 0; i < value.length; i += 1) {
                const ch = value.charAt(i);
                if (ch >= '0' && ch <= '9') digits += ch;
              }
              if (digits.length !== 6) { missing = true; reason = 'is incomplete (needs YY-NNNN)'; }
            }
            if (!missing) return;
            missingFields.push({ ...field, input, reason });
            const container = findRequiredContainer(field.name, input);
            if (container) container.classList.add('is-missing');
            if (input && input.offsetParent !== null) input.classList.add('is-invalid');
          });

          const existingSummary = formEl.querySelector('.required-summary');
          if (existingSummary) existingSummary.remove();

          if (missingFields.length) {
            const summary = document.createElement('p');
            summary.className = 'required-summary';
            summary.textContent = 'Please complete before submitting: '
              + missingFields.map((f) => f.label + ' (' + f.reason + ')').join(', ');
            submitButton.parentNode.insertBefore(summary, submitButton);

            const first = missingFields[0];
            const focusTarget = first.name === 'led_display_model'
              ? document.getElementById('led-code-select')
              : first.input;
            if (focusTarget) {
              focusTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
              try { focusTarget.focus({ preventScroll: true }); } catch (err) { focusTarget.focus(); }
            }
            if (statusEl) {
              statusEl.textContent = missingFields.length === 1
                ? '1 required field is missing.'
                : missingFields.length + ' required fields are missing.';
            }
            resetSubmitState();
            return;
          }

          const dateTimeSnapshots = Array.from(formEl.querySelectorAll(DATETIME_TEXT_SELECTOR)).map((input) => ({

            input,

            normalized: normalizeDateTimeText(input.value),

          }));

          const hasInvalidDateTimes = dateTimeSnapshots.some(({ input, normalized }) => {

            const raw = input.value.trim();

            if (raw && !normalized.iso) {

              input.classList.add('is-invalid');

              input.setCustomValidity('Use DD.MM.YYYY HH:MM');

              return true;

            }

            input.classList.remove('is-invalid');

            input.setCustomValidity('');

            return false;

          });

          if (hasInvalidDateTimes) {

            if (statusEl) {

              statusEl.textContent = 'Check date/time fields (use DD.MM.YYYY HH:MM).';

            }

            resetSubmitState();

            return;

          }

          dateTimeSnapshots.forEach(({ input, normalized }) => {

            input.dataset.displayValue = normalized.display;

            input.value = normalized.iso;

          });



          // An untouched signature pad submits nothing, and the report used to go out
          // looking signed while its box was empty. Ask once, by name, so nobody leaves
          // the site believing a document was signed when it wasn't.
          const unsignedPads = [];
          formEl.querySelectorAll('.signature-pad').forEach((pad) => {
            if (pad.offsetParent === null) return; // hidden for this report type
            const hidden = pad.querySelector('input[type="hidden"]');
            if (!hidden || hidden.disabled) return;
            const value = (hidden.value || '').trim();
            if (value.startsWith('data:image/')) return;
            const labelEl = pad.querySelector('.signature-pad__label span');
            let name = String((labelEl ? labelEl.textContent : '') || hidden.name || 'signature').trim();
            // No regex here on purpose: this block is emitted through a template literal,
            // so backslash escapes get eaten and a mangled pattern kills the whole page script.
            while (name.endsWith('*')) name = name.slice(0, -1).trim();
            unsignedPads.push(name);
          });
          if (unsignedPads.length) {
            const list = unsignedPads.join(' and ');
            const proceed = window.confirm(
              'No signature was drawn for: ' + list + '.\\n\\n'
              + 'The document will be submitted without it. Continue anyway?'
            );
            if (!proceed) {
              if (statusEl) statusEl.textContent = 'Submission cancelled — signature missing.';
              resetSubmitState();
              return;
            }
          }



          // Ensure parts inputs are enabled only for the active section to avoid empty overrides.

          const activePartsSection = findActivePartsSection ? findActivePartsSection() : null;

          const allPartsSections = Array.from(document.querySelectorAll('[data-parts-section]'));

          allPartsSections.forEach((section) => {

            const isActive = section === activePartsSection;

            const inputs = section.querySelectorAll('input, select, textarea');

            inputs.forEach((el) => {

              el.disabled = !isActive;

            });

          });

          if (activePartsSection) {

            const activeRows = Array.from(

              activePartsSection.querySelectorAll('[data-parts-table] tbody tr:not(.is-hidden-row)'),

            );

            activeRows.forEach((row) => {

              row.querySelectorAll('input, select, textarea').forEach((el) => {

                el.disabled = false;

              });

            });

          }



          const rawFormData = new FormData(formEl);

          dateTimeSnapshots.forEach(({ input, normalized }) => {

            input.value = normalized.display;

          });

          const hasFileUploads = Array.from(rawFormData.values()).some((value) => value instanceof File);

          if (hasFileUploads && statusEl) {

            statusEl.textContent = 'Compressing photos...';

          }

          let compression = null;

          try {

            compression = await compressFormImages(rawFormData);

          } catch (err) {

            recordDebug('image-compress-error', {

              message: err && err.message ? err.message : String(err),

            });

            compression = {

              formData: rawFormData,

              originalBytes: 0,

              compressedBytes: 0,

              compressedCount: 0,

              totalFiles: 0,

            };

          }

          const formData = compression && compression.formData ? compression.formData : rawFormData;

          if (debugState.enabled) {

            formData.set('debug_mode', 'true');

          } else {

            formData.delete('debug_mode');

          }

          if (compression && compression.totalFiles) {

            const savedBytes = Math.max(0, compression.originalBytes - compression.compressedBytes);

            recordDebug('image-compress', {

              totalFiles: compression.totalFiles,

              compressedCount: compression.compressedCount,

              originalBytes: compression.originalBytes,

              compressedBytes: compression.compressedBytes,

              savedBytes,

            });

          }

          if (statusEl) {

            statusEl.textContent = 'Submitting...';

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

          if (debugState.enabled) {

            const partsEntries = [];

            formData.forEach((value, key) => {

              if (!key.startsWith('parts_')) return;

              if (value instanceof File) return;

              const v = String(value || '').trim();

              if (v) partsEntries.push({ key, value: v });

            });

            const visiblePartsTable = document.querySelector('[data-parts-section]:not([hidden]) [data-parts-table]');

            const visibleRows = visiblePartsTable

              ? Array.from(visiblePartsTable.querySelectorAll('tbody tr')).filter(

                  (row) => !row.classList.contains('is-hidden-row'),

                ).length

              : 0;

            recordDebug('form-parts-snapshot', {

              formType: formTypeSelectEl ? formTypeSelectEl.value : '',

              partsEntries,

              visibleRows,

              totalPartsFields: partsEntries.length,

            });

          }



          const xhr = new XMLHttpRequest();

          xhr.open('POST', buildAppUrl('submit'));



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



            const success =

              xhr.status >= 200 &&

              xhr.status < 300 &&

              payload &&

              payload.ok &&

              typeof payload.url === 'string';



            if (success) {

              submitButton.classList.add('is-success');

              if (statusEl) {

                statusEl.textContent = 'Download starting...';

              }

              setProgress(100, 'Upload complete');

              setTimeout(() => {

                hideProgress();

              const downloadUrl = new URL(payload.url || '', window.location.href).toString();

              window.location.href = downloadUrl;

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

    <button type="button" id="fb-fab" class="fb-fab" title="Report a problem or idea" aria-label="Report a problem or idea">
      <svg class="fb-fab-tri" viewBox="0 0 40 36" aria-hidden="true"><path d="M20 3 L37 32 H3 Z" fill="#ffffff" stroke="#c8102e" stroke-width="2.6" stroke-linejoin="round"/></svg>
      <span class="fb-fab-hand" aria-hidden="true">&#9995;</span>
    </button>
    <div id="fb-overlay" class="fb-overlay" hidden>
      <div class="fb-dialog" role="dialog" aria-modal="true" aria-label="Send feedback to support">
        <div class="fb-dialog-head">
          <strong>Report a problem or idea</strong>
          <button type="button" class="fb-close" id="fb-close" aria-label="Close">&times;</button>
        </div>
        <div class="fb-dialog-body">
          <div class="fb-types">
            <button type="button" class="fb-type is-active" data-fb-kind="bug">&#128736; Problem</button>
            <button type="button" class="fb-type" data-fb-kind="idea">&#128161; Idea</button>
          </div>
          <textarea id="fb-message" rows="4" placeholder="Describe the problem or your idea..."></textarea>
          <div class="fb-row">
            <label class="fb-attach-btn">&#128247; Add photos<input type="file" id="fb-photos" accept="image/*" multiple hidden></label>
            <button type="button" class="fb-attach-btn" id="fb-record">&#127908; Record voice</button>
            <label class="fb-attach-btn">&#127911; Audio file<input type="file" id="fb-audio-file" accept="audio/*" hidden></label>
          </div>
          <p class="fb-hint">&#128161; Tip: copy an image or file and press <b>Ctrl+V</b> here to attach it. On Windows, press <b>Win+Shift+S</b> to capture part of the screen, then <b>Ctrl+V</b> in this window.</p>
          <div id="fb-attach-preview" class="fb-attach-preview"></div>
          <div class="fb-actions">
            <button type="button" class="fb-send" id="fb-send">Send to support</button>
            <span id="fb-status" class="fb-status"></span>
          </div>
        </div>
      </div>
    </div>
    <script>
      (function () {
        const fab = document.getElementById('fb-fab');
        const overlay = document.getElementById('fb-overlay');
        if (!fab || !overlay) return;
        const closeBtn = document.getElementById('fb-close');
        const messageEl = document.getElementById('fb-message');
        const photosInput = document.getElementById('fb-photos');
        const audioFileInput = document.getElementById('fb-audio-file');
        const recordBtn = document.getElementById('fb-record');
        const preview = document.getElementById('fb-attach-preview');
        const sendBtn = document.getElementById('fb-send');
        const statusEl = document.getElementById('fb-status');
        const typeBtns = Array.prototype.slice.call(document.querySelectorAll('.fb-type'));

        let kind = 'bug';
        let photos = [];      // File[]
        let photoUrls = [];   // object URLs currently shown (revoked on re-render)
        let audioBlob = null; // Blob (recorded or picked)
        let audioName = '';
        let mediaRecorder = null;
        let recChunks = [];
        let recUrl = null;

        const setStatus = (msg, cls) => { statusEl.textContent = msg || ''; statusEl.className = 'fb-status' + (cls ? ' ' + cls : ''); };

        const open = () => { overlay.hidden = false; setStatus(''); messageEl.focus(); };
        const close = () => {
          overlay.hidden = true;
          if (mediaRecorder && mediaRecorder.state === 'recording') { try { mediaRecorder.stop(); } catch (e) {} }
        };
        fab.addEventListener('click', open);
        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });

        typeBtns.forEach((b) => b.addEventListener('click', () => {
          kind = b.dataset.fbKind || 'bug';
          typeBtns.forEach((x) => x.classList.toggle('is-active', x === b));
        }));

        const revokeRec = () => { if (recUrl) { URL.revokeObjectURL(recUrl); recUrl = null; } };

        function renderPreview() {
          // Clear the DOM first, then revoke the previous object URLs (revoking while the
          // old <img> tags are still attached logs broken-image errors on quick re-renders).
          preview.innerHTML = '';
          photoUrls.forEach((u) => URL.revokeObjectURL(u));
          photoUrls = [];
          photos.forEach((file, i) => {
            const wrap = document.createElement('span');
            wrap.className = 'fb-chip';
            const img = document.createElement('img');
            const u = URL.createObjectURL(file);
            photoUrls.push(u);
            img.src = u;
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '\\u00d7';
            rm.title = 'Remove';
            rm.addEventListener('click', () => { photos.splice(i, 1); renderPreview(); });
            wrap.appendChild(img);
            wrap.appendChild(rm);
            preview.appendChild(wrap);
          });
          if (audioBlob) {
            const chip = document.createElement('span');
            chip.className = 'fb-chip';
            const audio = document.createElement('audio');
            audio.controls = true;
            revokeRec();
            recUrl = URL.createObjectURL(audioBlob);
            audio.src = recUrl;
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '\\u00d7';
            rm.title = 'Remove voice';
            rm.addEventListener('click', () => { audioBlob = null; audioName = ''; revokeRec(); renderPreview(); });
            chip.appendChild(audio);
            chip.appendChild(rm);
            preview.appendChild(chip);
          }
        }

        photosInput.addEventListener('change', () => {
          Array.prototype.slice.call(photosInput.files || []).forEach((f) => { if (photos.length < 10) photos.push(f); });
          photosInput.value = '';
          renderPreview();
        });
        audioFileInput.addEventListener('change', () => {
          const f = (audioFileInput.files || [])[0];
          if (f) { audioBlob = f; audioName = f.name || 'audio'; }
          audioFileInput.value = '';
          renderPreview();
        });

        // Paste (Ctrl+V) an image/file from the clipboard while the dialog is open — e.g. a
        // screenshot taken with Win+Shift+S. Non-file pastes fall through to normal text paste.
        document.addEventListener('paste', (e) => {
          if (overlay.hidden) return;
          const items = (e.clipboardData && e.clipboardData.items) || null;
          if (!items) return;
          let added = 0;
          for (let i = 0; i < items.length; i += 1) {
            const it = items[i];
            if (!it || it.kind !== 'file') continue;
            const f = it.getAsFile();
            if (!f) continue;
            const type = String(f.type || '').toLowerCase();
            if (type.indexOf('image/') === 0) {
              if (photos.length < 10) { photos.push(f); added += 1; }
            } else if (type.indexOf('audio/') === 0) {
              audioBlob = f; audioName = f.name || 'audio'; added += 1;
            }
          }
          if (added) {
            e.preventDefault();
            renderPreview();
            setStatus(added + ' attachment(s) pasted.', 'ok');
          }
        });

        recordBtn.addEventListener('click', async () => {
          if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); return; }
          if (!navigator.mediaDevices || !window.MediaRecorder) { setStatus('Recording not supported in this browser — attach an audio file instead.', 'error'); return; }
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            recChunks = [];
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
            mediaRecorder.onstop = () => {
              stream.getTracks().forEach((t) => t.stop());
              audioBlob = new Blob(recChunks, { type: (mediaRecorder.mimeType || 'audio/webm') });
              audioName = 'voice-message';
              recordBtn.classList.remove('is-recording');
              recordBtn.innerHTML = '\\ud83c\\udf99 Record voice';
              renderPreview();
            };
            mediaRecorder.start();
            recordBtn.classList.add('is-recording');
            recordBtn.innerHTML = '\\u23f9 Stop recording';
            setStatus('Recording... tap Stop when done.');
          } catch (e) {
            setStatus('Microphone access denied.', 'error');
          }
        });

        sendBtn.addEventListener('click', async () => {
          const message = (messageEl.value || '').trim();
          if (!message && !photos.length && !audioBlob) { setStatus('Add a message, a photo, or a voice note.', 'error'); return; }
          sendBtn.disabled = true;
          setStatus('Sending...');
          try {
            const fd = new FormData();
            fd.append('kind', kind);
            fd.append('message', message);
            let formType = '';
            try { const el = document.querySelector('[name="template_type"]'); if (el) formType = el.value || ''; } catch (e) {}
            fd.append('context', JSON.stringify({ source: 'web_form', formType: formType, page: location.pathname, userAgent: navigator.userAgent }));
            photos.forEach((f, i) => fd.append('photo_' + i, f, f.name || ('photo_' + i + '.jpg')));
            if (audioBlob) {
              let fname;
              if (audioName && /\.[a-z0-9]{2,4}$/i.test(audioName)) {
                fname = audioName; // picked file already carries an extension
              } else {
                const ext = (audioBlob.type && audioBlob.type.indexOf('mp4') >= 0) ? 'm4a' : (audioBlob.type && audioBlob.type.indexOf('ogg') >= 0 ? 'ogg' : 'webm');
                fname = (audioName || 'voice') + '.' + ext;
              }
              fd.append('voice', audioBlob, fname);
            }
            const fbUrl = new URL('api/feedback', new URL('.', window.location.href)).toString();
            const resp = await fetch(fbUrl, { method: 'POST', body: fd, credentials: 'same-origin' });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || !data.ok) throw new Error((data && data.error) || ('HTTP ' + resp.status));
            setStatus('Sent — thank you!', 'ok');
            messageEl.value = '';
            photos = []; audioBlob = null; audioName = ''; revokeRec();
            renderPreview();
            setTimeout(close, 900);
          } catch (e) {
            setStatus('Could not send: ' + (e && e.message ? e.message : 'error'), 'error');
          } finally {
            sendBtn.disabled = false;
          }
        });
      })();
    </script>

  </body>

</html>`);

  const html = htmlParts.join('\n');

  // Safety net: ensure generated paths and regexes are correct even if cached templates slip in.

  const fixedBuildAppUrl = `const buildAppUrl = (path) => {

          const normalized = (path || '').replace(/^\\/+/, '');

          return new URL(normalized || '.', appBaseUrl).toString();

        };`;



  const sanitizedHtml = html

    .replace(/const buildAppUrl = \(path\) => \{[\s\S]*?};/, fixedBuildAppUrl)

    .replace(/selected\.previewUrl\.replace\([^)]*\)/g, "selected.previewUrl.replace(/^\\/+/, '')")

    .replace(/\(tpl\.relativePath \|\| ''\)\.replace\([^)]*\)/g, "(tpl.relativePath || '').replace(/\\\\/g, '/')")

    .replace('src="/vendor/pdfjs/pdf.min.js"', 'src="/service2/vendor/pdfjs/pdf.min.js"')

    .replace(

      "GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';",

      "GlobalWorkerOptions.workerSrc = '/service2/vendor/pdfjs/pdf.worker.min.js';",

    );



  writeIndexHtmlIfParseable(sanitizedHtml);

}

// This page is emitted from a template literal, so an unescaped backslash or backtick in
// the generator silently corrupts the browser script and the whole form goes dead — no
// error on the server, just a page that does nothing. It has happened twice. So: parse
// every inline script before the file is written, and if one is broken keep the previous
// index.html and say so loudly. A slightly stale form beats a dead one.
function collectInlineScripts(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue; // external file, nothing to parse here
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(attrs);
    // Only real scripts: skip JSON blobs, templates and anything else parked in a tag.
    if (type && !/^(text|application)\/(java|ecma)script$/i.test(type[1])) continue;
    scripts.push(match[2]);
  }
  return scripts;
}

function writeIndexHtmlIfParseable(html) {
  const target = path.join(PUBLIC_DIR, 'index.html');
  let broken = [];
  try {
    collectInlineScripts(html).forEach((code, index) => {
      if (!code.trim()) return;
      try {
        new vm.Script(code, { filename: `index.html:inline-script-${index + 1}` });
      } catch (err) {
        // Only a parse failure means the page is dead. Anything else is the checker's
        // problem, not the page's.
        if (err instanceof SyntaxError) {
          broken.push(`inline script #${index + 1}: ${err.message}`);
        } else {
          throw err;
        }
      }
    });
  } catch (err) {
    console.error(`[server] index.html script check could not run (${err.message}); writing the page unchecked.`);
    broken = [];
  }

  if (!broken.length) {
    fs.writeFileSync(target, html, 'utf8');
    return true;
  }

  console.error('[server] Generated index.html has broken inline script(s); NOT writing it:');
  broken.forEach((line) => console.error(`[server]   ${line}`));

  if (fs.existsSync(target)) {
    console.error('[server] Keeping the previous index.html. The form is stale but alive — fix the generator.');
    return false;
  }

  // Nothing to fall back to. Writing a dead page is still better than a 404, but this
  // must not pass unnoticed.
  console.error('[server] No previous index.html to fall back to; writing the broken page anyway.');
  fs.writeFileSync(target, html, 'utf8');
  return false;
}









generateIndexHtml();



app.use(

  helmet({

    contentSecurityPolicy: {

      directives: {

        defaultSrc: ["'self'"],

        scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", OCR_CDN_HOST, 'blob:'],

        styleSrc: ["'self'", "'unsafe-inline'"],

        imgSrc: ["'self'", "data:", "blob:"],

        mediaSrc: ["'self'", "data:", "blob:"],

        connectSrc: ["'self'", OCR_CDN_HOST, OCR_DATA_HOST, 'data:', 'blob:'],

        fontSrc: ["'self'"],

        objectSrc: ["'none'"],

        workerSrc: ["'self'", 'blob:', OCR_CDN_HOST],

        childSrc: ["'self'", 'blob:', OCR_CDN_HOST],

      },

    },

  }),

);

app.use(cors());

app.use(express.json({ limit: '2mb' }));

app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Simple rate limit for submissions (per IP)
const submitBuckets = new Map();
const SUBMIT_WINDOW_MS = 10 * 60 * 1000;
const SUBMIT_MAX = 30;
function rateLimitSubmit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  const bucket = submitBuckets.get(key) || { count: 0, ts: now };
  if (now - bucket.ts > SUBMIT_WINDOW_MS) {
    bucket.count = 0;
    bucket.ts = now;
  }
  bucket.count += 1;
  submitBuckets.set(key, bucket);
  if (bucket.count > SUBMIT_MAX) {
    return res.status(429).json({ ok: false, error: 'too_many_requests' });
  }
  return next();
}

// In-memory submit journal (admin-visible). Answers "what did the app actually send and
// what happened to it?" without shell access to the container. Ring buffer, newest last.
const SUBMIT_JOURNAL_MAX = 300;
const submitJournal = [];
function recordSubmit(entry) {
  submitJournal.push(entry);
  if (submitJournal.length > SUBMIT_JOURNAL_MAX) {
    submitJournal.splice(0, submitJournal.length - SUBMIT_JOURNAL_MAX);
  }
}

// First handler in the /submit chain: times the request, captures the response outcome
// (by wrapping res.json), and records one journal row on 'finish' — including 429/400 that
// short-circuit before the main handler. req.files is populated by uploadFields by then.
function journalSubmit(req, res, next) {
  const startedAt = Date.now();
  const fwd = req.headers['x-forwarded-for'];
  const ip = fwd ? String(fwd).split(',')[0].trim() : (req.ip || 'unknown');
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  const hubUser = req.headers['x-hub-user'] || null;
  let outcome = null;
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object') {
      outcome = {
        ok: body.ok === true,
        error: body.error || null,
        filename: body.filename || null,
        duplicate: body.duplicate === true,
      };
    }
    return origJson(body);
  };
  res.on('finish', () => {
    const fields = {};
    let fileCount = 0;
    let totalBytes = 0;
    const files = req.files;
    if (files && typeof files === 'object' && !Array.isArray(files)) {
      for (const [name, arr] of Object.entries(files)) {
        if (!Array.isArray(arr)) continue;
        fields[name] = arr.length;
        for (const f of arr) {
          fileCount += 1;
          if (f && typeof f.size === 'number' && Number.isFinite(f.size)) totalBytes += Math.max(0, f.size);
          else if (f && f.buffer && Buffer.isBuffer(f.buffer)) totalBytes += f.buffer.length;
        }
      }
    }
    recordSubmit({
      at: new Date(startedAt).toISOString(),
      ip,
      ua,
      hubUser,
      template: toSingleValue(req.body && (req.body.template_type || req.body.templateType)) || null,
      clientReportId: normalizeClientReportId(
        toSingleValue(req.body && (req.body.client_report_id || req.body.clientReportId))
      ) || null,
      fields,
      fileCount,
      totalBytes,
      status: res.statusCode,
      ok: outcome ? outcome.ok : (res.statusCode >= 200 && res.statusCode < 300),
      error: outcome ? outcome.error : null,
      filename: outcome ? outcome.filename : null,
      duplicate: outcome ? outcome.duplicate : false,
      durationMs: Date.now() - startedAt,
    });
  });
  next();
}

// Serve assets both at root and under /service2 (for proxied paths)

app.use('/service2', express.static(PUBLIC_DIR));

app.use(express.static(PUBLIC_DIR));



// Known upload parts and how many of each we keep.
// (led/control/spares_photos come from iOS full-field submissions; signatures arrive
// as raw binary PNG parts from iOS and as data-URL strings from the web form.)
const UPLOAD_FIELD_LIMITS = {
  photo_before: 20,
  photo_after: 20,
  photos: 20,
  'photos[]': 20,
  daily_photos: 20,
  photo_defects: 20,
  photo_installation: 20,
  led_photos: 20,
  control_photos: 20,
  spares_photos: 20,
  // A photo instead of typing: some readings (a controller label, a firmware screen) are
  // faster and more accurate photographed than transcribed. It joins the other photos and
  // is captioned with the section it came from so it is not an anonymous picture.
  led_controller_photo: 5,
  engineer_signature: 1,
  customer_signature: 1,
};

// multer's global file-count cap. Derived from UPLOAD_FIELD_LIMITS (+ headroom) so it
// never drifts below the sum of per-field limits again. A hardcoded 64 here used to
// hard-fail full iOS reports (up to 4 photo fields x 20 = 80 parts) with LIMIT_FILE_COUNT
// before the per-field trim logic in uploadFields() could run. Headroom lets a field that
// arrives slightly over its limit be trimmed gracefully instead of aborting the whole submit.
const MAX_UPLOAD_FILES =
  Object.values(UPLOAD_FIELD_LIMITS).reduce((sum, n) => sum + n, 0) + 32;

const upload = multer({

  storage: multer.memoryStorage(),

  limits: {

    fileSize: MAX_FILE_SIZE_BYTES,

    files: MAX_UPLOAD_FILES,

  },

  fileFilter: (req, file, cb) => {

    const allowed = new Set(['image/jpeg', 'image/png']);

    const rawType = (file.mimetype || '').toLowerCase();

    if (!rawType) {

      const err = new Error('Invalid file type.');

      err.statusCode = 400;

      return cb(err);

    }

    let normalized = rawType;

    if (rawType === 'image/jpg' || rawType === 'image/pjpeg') {

      normalized = 'image/jpeg';

    } else if (rawType === 'image/x-png') {

      normalized = 'image/png';

    }

    if (!allowed.has(normalized)) {

      const err = new Error('Only JPEG and PNG images are allowed.');

      err.statusCode = 400;

      return cb(err);

    }

    file.mimetype = normalized;

    return cb(null, true);

  },

});



const templateUpload = multer({

  storage: multer.diskStorage({

    destination: TEMPLATE_STORAGE_DIR,

    filename: (req, file, cb) => {

      const ext = path.extname(file.originalname || '.pdf') || '.pdf';

      const base = slugifyFilename(path.basename(file.originalname || 'template', ext));

      const filename = `${Date.now()}-${base}${ext.toLowerCase() === '.pdf' ? '' : '.pdf'}`;

      cb(null, filename);

    },

  }),

  limits: {

    fileSize: MAX_FILE_SIZE_BYTES,

    files: 1,

  },

  fileFilter: (req, file, cb) => {

    const mimetype = (file.mimetype || '').toLowerCase();

    const isPdf =

      mimetype === 'application/pdf' || (file.originalname || '').toLowerCase().endsWith('.pdf');

    if (!isPdf) {

      const err = new Error('Only PDF files are allowed.');

      err.statusCode = 400;

      return cb(err);

    }

    return cb(null, true);

  },

});



const uploadAnyParts = upload.any();

// Accept any file part, then normalise req.files into the same
// { fieldname: [file, ...] } shape multer's .fields() produces, dropping unknown
// parts and trimming each field to its limit.
// Why: with .fields() a single unrecognised part aborts the WHOLE submission with
// "Unexpected field" â€” a new client-side field name once blocked real reports in
// production. Unknown parts are now ignored (and logged) instead of failing the report.
function uploadFields(req, res, cb) {
  uploadAnyParts(req, res, (err) => {
    if (err) return cb(err);
    const list = Array.isArray(req.files) ? req.files : [];
    const grouped = {};
    const ignored = new Set();
    for (const file of list) {
      const name = file && file.fieldname;
      if (!name) continue;
      const limit = Object.prototype.hasOwnProperty.call(UPLOAD_FIELD_LIMITS, name)
        ? UPLOAD_FIELD_LIMITS[name]
        : 0;
      if (!limit) { ignored.add(name); continue; }
      const bucket = grouped[name] || (grouped[name] = []);
      if (bucket.length < limit) bucket.push(file);
      else ignored.add(`${name} (over limit ${limit})`);
    }
    if (ignored.size) {
      console.warn('[server] ignored unexpected/extra upload parts:', Array.from(ignored).join(', '));
    }
    req.files = grouped;
    return cb();
  });
}



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

  append(files.daily_photos);

  append(files.photo_defects);

  append(files.photo_installation);

  append(files.led_photos);

  append(files.control_photos);

  append(files.spares_photos);

  append(files.led_controller_photo);

  return photos;

}

// Reload a prior report's persisted photos into multer-shaped file objects so an
// edit-resubmit that carries no photo parts keeps the images (re-embed + re-persist).
// Reads meta.photoFiles (field/file/mime) and the bytes from out/<type>/photos/<base>/.
async function loadPersistedPhotoFiles(type, prevFilename) {
  try {
    const metaPath = buildMetaPath(type, prevFilename);
    if (!metaPath || !fs.existsSync(metaPath)) return [];
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    const manifest = Array.isArray(meta.photoFiles) ? meta.photoFiles : [];
    if (!manifest.length) return [];
    const base = String(prevFilename).replace(/\.pdf$/i, '');
    const photosDir = path.join(OUTPUT_DIR, type, 'photos', base);
    const restored = [];
    for (const pf of manifest) {
      if (!pf || !pf.file || !pf.field) continue;
      const filePath = safeResolvePath(photosDir, path.join(photosDir, pf.file));
      if (!filePath || !fs.existsSync(filePath)) continue;
      const buffer = await fs.promises.readFile(filePath);
      restored.push({
        fieldname: pf.field,
        originalname: pf.name || pf.file,
        mimetype: String(pf.mime || 'image/jpeg').toLowerCase(),
        buffer,
        size: buffer.length,
      });
    }
    return restored;
  } catch (err) {
    console.warn('[server] failed to reload persisted photos for edit:', err && err.message);
    return [];
  }
}



const adminTokens = new Map();

const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;



function cleanupAdminTokens() {

  const now = Date.now();

  for (const [token, meta] of adminTokens.entries()) {

    if (!meta || now - meta.createdAt > ADMIN_TOKEN_TTL_MS) {

      adminTokens.delete(token);

    }

  }

}



function issueAdminToken() {

  cleanupAdminTokens();

  const token = crypto.randomBytes(24).toString('hex');

  adminTokens.set(token, { createdAt: Date.now() });

  return token;

}



function extractAdminToken(req) {

  const auth = req.headers.authorization || '';

  if (auth.toLowerCase().startsWith('bearer ')) {

    return auth.slice(7).trim();

  }

  if (req.headers['x-admin-token']) {

    return String(req.headers['x-admin-token']).trim();

  }

  return null;

}



function requireAdmin(req, res, next) {

  const token = extractAdminToken(req);

  if (!token || !adminTokens.has(token)) {

    return res.status(401).json({ ok: false, error: 'Admin authentication required.' });

  }

  return next();

}

function requireHubAdmin(req, res, next) {
  const role = String(req.headers['x-hub-role'] || '').trim().toLowerCase();
  if (role === 'admin') {
    return next();
  }
  return res.status(403).json({ ok: false, error: 'Forbidden' });
}

function requireFileAdmin(req, res, next) {
  const role = String(req.headers['x-hub-role'] || '').trim().toLowerCase();
  if (role === 'admin') return next();
  const token = extractAdminToken(req);
  if (token && adminTokens.has(token)) return next();
  return res.status(403).json({ ok: false, error: 'Forbidden' });
}

function requireDeleteFiles(req, res, next) {
  const role = String(req.headers['x-hub-role'] || '').trim().toLowerCase();
  if (role === 'admin') return next();
  if (req.headers['x-hub-can-delete-files'] === '1') return next();
  const token = extractAdminToken(req);
  if (token && adminTokens.has(token)) return next();
  return res.status(403).json({ ok: false, error: 'Forbidden: requires delete files permission.' });
}

function requireGenerateLinks(req, res, next) {
  const role = String(req.headers['x-hub-role'] || '').trim().toLowerCase();
  if (role === 'admin') return next();
  if (req.headers['x-hub-can-generate-links'] === '1') return next();
  const token = extractAdminToken(req);
  if (token && adminTokens.has(token)) return next();
  return res.status(403).json({ ok: false, error: 'Forbidden: requires generate links permission.' });
}



if (verifyAdminPassword(ADMIN_DEFAULT_PASSWORD)) {

  console.warn('[server] Admin password is set to the default value (admin/admin). Update it via the admin panel.');

}



function decodeImageDataUrl(dataUrl) {

  if (typeof dataUrl !== 'string') return null;

  const match = /^data:(image\/(?:png|jpe?g))(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(dataUrl.trim());

  if (!match) return null;

  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();

  try {

    const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');

    if (!buffer.length) return null;

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

function normalizeDownloadPath(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.pathname.replace(/^\/+/, '');
  } catch (err) {
    return trimmed.replace(/^\/+/, '');
  }
}

function resolveOutputFileFromRequest(body) {
  const downloadPath = normalizeDownloadPath(body && (body.downloadPath || body.url));
  let templateType = body && typeof body.templateType === 'string' ? body.templateType.trim() : '';
  let filename = body && typeof body.filename === 'string' ? body.filename.trim() : '';

  if (downloadPath) {
    const match = /^download\/([^/]+)\/([^/]+)$/i.exec(downloadPath);
    if (match) {
      templateType = decodeURIComponent(match[1]);
      filename = decodeURIComponent(match[2]);
    }
  }

  if (!templateType || !filename) return null;
  const safeType = sanitizeFilename(templateType);
  const safeFile = sanitizeFilename(filename);
  if (!safeType || !safeFile) return null;

  const baseDir = path.join(OUTPUT_DIR, safeType, 'pdf');
  const filePath = path.join(baseDir, safeFile);
  if (!filePath.startsWith(baseDir)) return null;

  return { templateType: safeType, filename: safeFile, filePath };
}



async function embedUploadedImages(pdfDoc, form, photoFiles, embedOptions = {}) {

  if (!photoFiles.length) return [];



  const embeddings = [];

  for (const file of photoFiles) {

    if (!file || !file.buffer) continue;

    let image;

    try {

      image =

        file.mimetype && file.mimetype.toLowerCase() === 'image/png'

          ? await pdfDoc.embedPng(file.buffer)

          : await pdfDoc.embedJpg(file.buffer);

    } catch (err) {

      const name = sanitizeFilename(file.originalname || file.fieldname || 'image');

      const friendly = new Error(

        `Unable to embed image "${name}". Please ensure the file is a valid JPEG/PNG and below ${formatBytesHuman(

          MAX_FILE_SIZE_BYTES,

        )}. (${err.message})`,

      );

      friendly.statusCode = 400;

      throw friendly;

    }

    embeddings.push({ file, image });

  }



  if (!embeddings.length) return [];



  const margin = 36;

  const gutter = 18;

  const captionHeight = 24;

  const placements = [];

  const labelByField = {

    photo_before: 'Before photo',

    photo_after: 'After photo',

    photos: 'Supporting photo',

    'photos[]': 'Supporting photo',

    daily_photos: 'Daily report photo',

    photo_defects: 'Defect photo',

    photo_installation: 'Installation photo',

    // Section photos were landing in the appendix as anonymous "Photo" — captioned now, so
    // the reader knows which part of the report each one belongs to.
    led_photos: 'LED inspection photo',

    control_photos: 'Control checkpoints photo',

    spares_photos: 'Spare parts photo',

    led_controller_photo: 'LED inspection — Controller / firmware',

  };

  const counters = new Map();



  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);



  const landscapeSize = { width: 841.89, height: 595.28 }; // A4 landscape



  for (let i = 0; i < embeddings.length; i += 2) {

    const pair = embeddings.slice(i, i + 2);

    const page = pdfDoc.addPage([landscapeSize.width, landscapeSize.height]);

    const pageWidth = page.getWidth();

    const pageHeight = page.getHeight();

    const projectNumber = embedOptions.projectNumber || '';

    const headingHeight = projectNumber ? 24 : 0;

    if (projectNumber) {

      const headingText = `Photos \u2014 ${projectNumber}`;

      const headingSize = 13;

      const headingWidth = boldFont.widthOfTextAtSize(headingText, headingSize);

      const headingX = (pageWidth - headingWidth) / 2;

      page.drawText(headingText, {

        x: headingX,

        y: pageHeight - margin - headingSize,

        size: headingSize,

        font: boldFont,

        color: rgb(0.08, 0.2, 0.4),

      });

    }



    const layoutSingle = pair.length === 1;

    const cellWidth = layoutSingle

      ? pageWidth - margin * 2

      : (pageWidth - margin * 2 - gutter) / 2;

    const cellHeight = pageHeight - margin * 2 - headingHeight;



    pair.forEach(({ file, image }, idxInPair) => {

      const fieldName = file.fieldname || 'photos';

      const labelBase = labelByField[fieldName] || 'Photo';

      const currentIndex = (counters.get(fieldName) || 0) + 1;

      counters.set(fieldName, currentIndex);

      const caption = labelBase + (currentIndex > 1 ? ` #${currentIndex}` : '');



      const col = layoutSingle ? 0 : idxInPair;

      const cellX = margin + col * (cellWidth + (layoutSingle ? 0 : gutter));

      const cellY = margin;



      const availableWidth = cellWidth;

      const availableHeight = cellHeight - captionHeight - 10;

      const scale = Math.min(availableWidth / image.width, availableHeight / image.height);

      const drawWidth = image.width * scale;

      const drawHeight = image.height * scale;

      const x = cellX + (availableWidth - drawWidth) / 2;

      const cellTop = cellY + captionHeight + availableHeight;

      const y = cellTop - drawHeight;



      page.drawImage(image, {

        x,

        y,

        width: drawWidth,

        height: drawHeight,

      });



      page.drawText(caption, {

        x,

        y: y - 16,

        size: 11,

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

    });

  }



  return placements;

}



// Did what the engineer typed actually reach the page?
//
// A field the renderer has never heard of is accepted, stored and silently left off the
// document. It happened with `client_notes`: an engineer's notes - eight hours of travel
// time and a recommendation to the customer - sat in the archive for weeks while the PDF
// showed nothing, and nobody could have known until a customer read their copy.
//
// So instead of trusting a list of known keys, which drifts the moment a client adds one,
// this reads the generated PDF back and asks the only question that matters: is this text
// on the page? Anything substantial that is not gets logged with the report, so an
// unrecognised field from any client - including builds older than this server - surfaces
// the day it is submitted rather than months later.
const UNRENDERED_CHECK_SKIP = new Set([
  // Metadata: never printed, and correctly so. This list is stable because it describes
  // the envelope, not the contents.
  'template_type', 'template_slug', 'template_id', 'template_version', 'template_label',
  'client_report_id', 'owner_user_id', 'submitted_at', 'submitted_via', 'client_version',
  'engineer_signature', 'customer_signature', 'employees', 'breaks_enabled',
  'signoff_complete', 'acceptance_overall', 'acceptance_partial',
]);

function extractPdfPlainText(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const pieces = [];
  const streamRe = /stream\r?\n/g;
  let match;
  while ((match = streamRe.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let chunk = Buffer.from(raw.slice(start, end), 'latin1');
    try {
      chunk = zlib.inflateSync(chunk);
    } catch (err) {
      // Not deflated, or an image stream; the text match below decides either way.
    }
    const text = chunk.toString('latin1');
    if (!text.includes('Tj') && !text.includes('TJ')) continue;
    const hexRe = /<([0-9A-Fa-f\s]+)>\s*Tj/g;
    let hex;
    while ((hex = hexRe.exec(text)) !== null) {
      const digits = hex[1].replace(/\s+/g, '');
      pieces.push(Buffer.from(digits.length % 2 ? `${digits}0` : digits, 'hex').toString('latin1'));
    }
    const litRe = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
    let lit;
    while ((lit = litRe.exec(text)) !== null) pieces.push(lit[1]);
  }
  return pieces.join(' ');
}

// Letters and digits only: the renderer re-wraps, re-cases and re-punctuates what it draws,
// so anything finer than this reports differences that are not losses.
const squashForComparison = (value) => String(value || '').replace(/[^A-Za-z0-9]+/g, '').toLowerCase();

function findUnrenderedFields(body, pdfBytes) {
  let pageText = '';
  try {
    pageText = squashForComparison(extractPdfPlainText(pdfBytes));
  } catch (err) {
    // The check must never be the thing that fails a submission.
    console.warn(`[server] Unable to read back the generated PDF: ${err.message}`);
    return [];
  }
  if (!pageText) return [];

  const missing = [];
  for (const [key, rawValue] of Object.entries(body || {})) {
    if (UNRENDERED_CHECK_SKIP.has(key)) continue;
    if (/signature|photo|_base64$/i.test(key)) continue;
    const value = toSingleValue(rawValue);
    if (typeof value !== 'string') continue;
    const text = value.trim();
    // Short values collide by accident and checkbox values are not prose; only look at
    // something long enough that its absence is unambiguous.
    if (text.length < 15) continue;
    if (/^data:/i.test(text)) continue;
    const needle = squashForComparison(text).slice(0, 40);
    if (needle.length < 12) continue;
    if (!pageText.includes(needle)) missing.push(key);
  }
  return missing;
}

// Who signed for the customer, when the client did not say.
//
// No app build has ever sent `customer_name` - not a regression, a permanent gap, and the
// engineers in the field run the App Store build and cannot install a fix. So the signature
// box on every app-submitted report carried no name at all.
//
// `customer_representative` is the app's sign-off field - the person who accepted the work,
// filled in next to the customer's signature - so on those submissions it IS the signer.
// On our own web form the same key is labelled "Contact person", which is a different thing
// and may well be a different person, and a wrong name under a signature is worse than
// none. Hence the narrowing: only where the payload is an app submission, which
// client_report_id and owner_user_id identify and nothing else sends.
function isAppSubmission(body) {
  return !!(toSingleValue(body?.client_report_id) || toSingleValue(body?.owner_user_id));
}

function resolveCustomerSignatoryName(body) {
  const explicit = toSingleValue(body?.customer_name);
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  if (!isAppSubmission(body)) return '';
  const rep = toSingleValue(body?.customer_representative);
  return rep && String(rep).trim() ? String(rep).trim() : '';
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

    if (
      /submit|technician|engineer|inspector/i.test(descriptor.acroName)
      && !/date|time|company|signature|comment|email|phone|note/i.test(descriptor.acroName)
    ) {

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



app.get('/favicon.ico', (req, res) => {

  res.status(204).end();

});



// Health endpoint used by docker healthcheck and hub

app.get('/health', (req, res) => {

  try {

    const uptime = process.uptime();

    return res.json({
      status: 'ok',
      service: 'service2',
      version: SERVICE2_VERSION,
      uptime: Math.floor(uptime),
      now: new Date().toISOString(),
    });

  } catch (err) {

    return res.status(500).json({ status: 'fail', service: 'service2', error: String(err && err.message ? err.message : err) });

  }

});



app.get('/', (req, res) => {

  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));

});

app.get(['/files', '/service2/files'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'files.html'));
});



const suggestRoutes = ['/suggest', '/service2/suggest'];

app.get(suggestRoutes, (req, res) => {

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



const projectRoutes = ['/projects/:projectKey', '/service2/projects/:projectKey'];

app.get(projectRoutes, (req, res) => {

  const projectKey = typeof req.params.projectKey === 'string' ? req.params.projectKey.trim() : '';

  if (!projectKey) {

    return res.status(400).json({ ok: false, error: 'Project number is required.' });

  }

  const projects = loadProjectsStore();

  const card = projects ? projects[projectKey] : null;

  if (!card) {

    return res.status(404).json({ ok: false, error: 'Project not found.' });

  }

  return res.json({ ok: true, project: card });

});



// --- Mobile app (P0): project autofill under /api/projects/* ---

// Aggregate report count + last submitter per project number by scanning meta.
// Project number is read from the stored requestBody (lsc_project_number / batch_number /
// daily_project_number) or the daily-report block. Reports without a number are skipped.
async function aggregateProjectStats() {
  const stats = {};
  const types = await listOutputTypes();
  for (const type of types) {
    const metaDir = path.join(OUTPUT_DIR, type, 'meta');
    let files = [];
    try {
      files = await fs.promises.readdir(metaDir);
    } catch (err) {
      continue;
    }
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.json')) continue;
      let meta;
      try {
        meta = JSON.parse(await fs.promises.readFile(path.join(metaDir, file), 'utf8'));
      } catch (err) {
        continue;
      }
      const rb = (meta.requestBody && typeof meta.requestBody === 'object') ? meta.requestBody : {};
      const daily = (meta.dailyReport && typeof meta.dailyReport === 'object') ? meta.dailyReport : {};
      const key = String(
        resolveProjectNumber(rb) || daily.projectNumber || ''
      ).trim();
      if (!key) continue;
      const submittedAt = String(meta.createdAt || '');
      const submitter = String(detectSubmitterName(rb) || daily.submitterName || '').trim();
      const cur = stats[key] || { reportCount: 0, lastSubmittedAt: '', lastSubmitterName: '', lastFields: null, lastType: '' };
      cur.reportCount += 1;
      if (!cur.lastSubmittedAt || submittedAt > cur.lastSubmittedAt) {
        cur.lastSubmittedAt = submittedAt;
        if (submitter) cur.lastSubmitterName = submitter;
        cur.lastFields = rb;
        cur.lastType = meta.templateType || type;
      }
      stats[key] = cur;
    }
  }
  return stats;
}

function projectCardSummary(key, card, stat) {
  const c = card && typeof card === 'object' ? card : {};
  const s = stat || {};
  const f = (s.lastFields && typeof s.lastFields === 'object') ? s.lastFields : {};
  // Prefer the curated projects.json card; fall back to the newest submission's
  // raw fields (covers daily reports, which never get a projects.json card).
  const pick = (...keys) => {
    for (const src of [c, f]) {
      for (const k of keys) {
        if (src[k] != null && String(src[k]).trim() !== '') return src[k];
      }
    }
    return null;
  };
  return {
    projectNumber: key,
    endCustomerName: pick('end_customer_name'),
    siteLocation: pick('site_location'),
    customerRepresentative: pick('customer_representative'),
    ledDisplayModel: pick('led_display_model'),
    formType: c.form_type || s.lastType || null,
    lastSubmitterName: s.lastSubmitterName || null,
    lastSubmittedAt: c.updated_at || s.lastSubmittedAt || null,
    reportCount: s.reportCount || 0,
  };
}

// Recent projects, newest first (project picker / autocomplete in the app).
app.get(['/api/projects/recent', '/service2/api/projects/recent'], async (req, res) => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? clampNumber(Math.floor(rawLimit), 1, 100) : 20;
  try {
    const store = loadProjectsStore() || {};
    const stats = await aggregateProjectStats();
    const keys = Array.from(new Set([...Object.keys(store), ...Object.keys(stats)]));
    const projects = keys
      .map((key) => projectCardSummary(key, store[key], stats[key]))
      .sort((a, b) => String(b.lastSubmittedAt || '').localeCompare(String(a.lastSubmittedAt || '')))
      .slice(0, limit);
    return res.json({ ok: true, projects });
  } catch (err) {
    console.error('[server] Failed to list recent projects', err);
    return res.status(500).json({ ok: false, error: 'projects_failed' });
  }
});

// Single project card by LSC project number (smart autofill on number entry).
app.get(['/api/projects/:projectKey', '/service2/api/projects/:projectKey'], async (req, res) => {
  const projectKey = typeof req.params.projectKey === 'string' ? req.params.projectKey.trim() : '';
  if (!projectKey) {
    return res.status(400).json({ ok: false, error: 'Project number is required.' });
  }
  try {
    const projects = loadProjectsStore() || {};
    const card = projects[projectKey] || null;
    const stats = await aggregateProjectStats();
    const stat = stats[projectKey] || null;
    if (!card && !stat) {
      return res.status(404).json({ ok: false, error: 'Project not found.' });
    }
    const summary = projectCardSummary(projectKey, card, stat);
    const lastFields = (card && typeof card === 'object') ? card : ((stat && stat.lastFields) || {});
    return res.json({ ok: true, project: { ...summary, lastFields } });
  } catch (err) {
    console.error('[server] Failed to load project', err);
    return res.status(500).json({ ok: false, error: 'project_failed' });
  }
});

// --- Mobile app (P5): full visit history for a project number ---
// All reports submitted under a project key, newest first, with a per-type breakdown.
// Powers the "9th visit to this site" UX. Project key resolves the same way as
// aggregateProjectStats (lsc_project_number / batch_number / daily_project_number / daily block).
async function collectProjectVisits(projectKey) {
  const visits = [];
  const types = await listOutputTypes();
  for (const type of types) {
    const metaDir = path.join(OUTPUT_DIR, type, 'meta');
    let files = [];
    try {
      files = await fs.promises.readdir(metaDir);
    } catch (err) {
      continue;
    }
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.json')) continue;
      let meta;
      try {
        meta = JSON.parse(await fs.promises.readFile(path.join(metaDir, file), 'utf8'));
      } catch (err) {
        continue;
      }
      const rb = (meta.requestBody && typeof meta.requestBody === 'object') ? meta.requestBody : {};
      const daily = (meta.dailyReport && typeof meta.dailyReport === 'object') ? meta.dailyReport : {};
      const key = String(
        resolveProjectNumber(rb) || daily.projectNumber || ''
      ).trim();
      if (key !== projectKey) continue;
      const resolvedType = meta.templateType || type;
      const resolvedName = meta.filename || file.replace(/\.json$/i, '.pdf');
      visits.push({
        filename: resolvedName,
        type: resolvedType,
        submittedAt: meta.createdAt || null,
        submitterName: String(detectSubmitterName(rb) || daily.submitterName || '').trim() || null,
        ownerUserId: rb.owner_user_id || null,
        clientReportId: rb.client_report_id || null,
        url: `download/${resolvedType}/${resolvedName}`,
        summary: {
          end_customer_name: rb.end_customer_name || null,
          site_location: rb.site_location || null,
          date_of_service: rb.date_of_service || rb.daily_report_date || null,
        },
      });
    }
  }
  visits.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
  return visits;
}

app.get(['/api/projects/:projectKey/history', '/service2/api/projects/:projectKey/history'], async (req, res) => {
  const projectKey = typeof req.params.projectKey === 'string' ? req.params.projectKey.trim() : '';
  if (!projectKey) {
    return res.status(400).json({ ok: false, error: 'Project number is required.' });
  }
  try {
    const visits = await collectProjectVisits(projectKey);
    if (!visits.length) {
      return res.status(404).json({ ok: false, error: 'Project not found.' });
    }
    const byType = {};
    for (const v of visits) { byType[v.type] = (byType[v.type] || 0) + 1; }
    const submitted = visits.map((v) => v.submittedAt).filter(Boolean).sort();
    return res.json({
      ok: true,
      projectNumber: projectKey,
      reportCount: visits.length,
      firstSubmittedAt: submitted[0] || null,
      lastSubmittedAt: submitted[submitted.length - 1] || null,
      byType,
      visits,
    });
  } catch (err) {
    console.error('[server] Failed to load project history', err);
    return res.status(500).json({ ok: false, error: 'project_history_failed' });
  }
});

// --- Manager dashboard (P2): aggregate report stats over all meta + PDF sizes ---
// Totals, per-type (count+bytes), per-month counts, and per-user breakdown.
// Cached 60s because the iOS dashboard polls frequently.
async function aggregateReportStats() {
  const result = {
    totals: { reportCount: 0, totalBytes: 0 },
    byType: {},   // type -> { count, bytes }
    byMonth: {},  // "YYYY-MM" -> count
    byUser: {},   // user -> { reportCount, bytes, lastSubmittedAt, last7Days }
  };
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const types = await listOutputTypes();
  for (const type of types) {
    const metaDir = path.join(OUTPUT_DIR, type, 'meta');
    const pdfDir = path.join(OUTPUT_DIR, type, 'pdf');
    let files = [];
    try {
      files = await fs.promises.readdir(metaDir);
    } catch (err) {
      continue;
    }
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.json')) continue;
      let meta;
      try {
        meta = JSON.parse(await fs.promises.readFile(path.join(metaDir, file), 'utf8'));
      } catch (err) {
        continue;
      }
      const rb = (meta.requestBody && typeof meta.requestBody === 'object') ? meta.requestBody : {};
      const resolvedType = meta.templateType || type;
      const resolvedName = meta.filename || file.replace(/\.json$/i, '.pdf');
      const createdAt = String(meta.createdAt || '');
      const user = String(rb.owner_user_id || detectSubmitterName(rb) || 'unknown').trim() || 'unknown';
      let bytes = 0;
      try { bytes = (await fs.promises.stat(path.join(pdfDir, resolvedName))).size; } catch (err) { /* pdf missing */ }

      result.totals.reportCount += 1;
      result.totals.totalBytes += bytes;

      const t = result.byType[resolvedType] || { count: 0, bytes: 0 };
      t.count += 1; t.bytes += bytes; result.byType[resolvedType] = t;

      const month = createdAt.slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(month)) result.byMonth[month] = (result.byMonth[month] || 0) + 1;

      const u = result.byUser[user] || { reportCount: 0, bytes: 0, lastSubmittedAt: '', last7Days: 0 };
      u.reportCount += 1; u.bytes += bytes;
      if (!u.lastSubmittedAt || createdAt > u.lastSubmittedAt) u.lastSubmittedAt = createdAt;
      if (createdAt && Date.parse(createdAt) >= weekAgo) u.last7Days += 1;
      result.byUser[user] = u;
    }
  }
  return result;
}

let _reportStatsCache = { at: 0, data: null };
async function getReportStats() {
  const now = Date.now();
  if (_reportStatsCache.data && (now - _reportStatsCache.at) < 60 * 1000) return _reportStatsCache.data;
  const data = await aggregateReportStats();
  _reportStatsCache = { at: now, data };
  return data;
}

app.get(['/api/admin/stats', '/service2/api/admin/stats'], async (req, res) => {
  try {
    const stats = await getReportStats();
    return res.json({ ok: true, ...stats });
  } catch (err) {
    console.error('[server] Failed to aggregate report stats', err);
    return res.status(500).json({ ok: false, error: 'stats_failed' });
  }
});



app.post(['/suggest/save', '/service2/suggest/save'], (req, res) => {

  const fieldName = typeof req.body?.field === 'string' ? req.body.field.trim() : '';

  const value = typeof req.body?.value === 'string' ? req.body.value : '';

  if (!recordSuggestionValue(fieldName, value)) {

    // Nothing was written (empty / too short / unknown field) — not treated as an error

    return res.json({ ok: true, skipped: true });

  }

  saveSuggestionStore();

  return res.json({ ok: true });

});



function buildAdminProfilePayload() {

  return {

    ok: true,

    username: adminCredentials.username || ADMIN_DEFAULT_USERNAME,

    passwordUpdatedAt: adminCredentials.updatedAt || null,

  };

}


app.post(['/api/ocr/paddle', '/service2/api/ocr/paddle'], async (req, res) => {
  if (!PADDLE_OCR_URL) {
    return res.status(503).json({ ok: false, error: 'PADDLE_OCR_URL is not configured on the server.' });
  }

  const imageBase64 = typeof req.body?.image === 'string' ? req.body.image.trim() : '';
  if (!imageBase64) {
    return res.status(400).json({ ok: false, error: 'image (base64-encoded) is required.' });
  }

  const collectText = (payload) => {
    const texts = [];
    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (typeof node === 'string') {
        const t = node.trim();
        if (t) texts.push(t);
        return;
      }
      if (node && typeof node === 'object') {
        if (node.text) walk(node.text);
        if (node.data) walk(node.data);
        if (node.result) walk(node.result);
        Object.values(node).forEach(walk);
      }
    };
    walk(payload);
    return texts.join('\n').trim();
  };

  const buildAltUrl = (url) => {
    if (!url) return '';
    if (url.includes('/predict/ocr_system')) {
      return url.replace(/\/predict\/ocr_system$/, '/ocr');
    }
    if (url.endsWith('/ocr')) {
      return url.replace(/\/ocr$/, '/predict/ocr_system');
    }
    return '';
  };

  const attempts = [];
  const pushAttempt = (url, body) => {
    if (!url) return;
    attempts.push({ url, body });
  };

  pushAttempt(PADDLE_OCR_URL, { images: [imageBase64] });
  pushAttempt(PADDLE_OCR_URL, { image: imageBase64 });
  const altUrl = buildAltUrl(PADDLE_OCR_URL);
  if (altUrl && altUrl !== PADDLE_OCR_URL) {
    pushAttempt(altUrl, { images: [imageBase64] });
    pushAttempt(altUrl, { image: imageBase64 });
  }

  let lastError = 'Paddle OCR request failed';
  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attempt.body),
      });
      if (!response.ok) {
        lastError = 'Paddle OCR request failed (' + response.status + ' ' + response.statusText + ')';
        continue;
      }
      const payload = await response.json();
      const text = collectText(payload);
      if (text) {
        return res.json({ ok: true, text });
      }
      lastError = 'Paddle OCR response was empty.';
    } catch (err) {
      lastError = 'Paddle OCR request failed: ' + (err && err.message ? err.message : 'Unknown error');
    }
  }

  console.error('[server] Paddle OCR request failed', lastError);
  return res.status(502).json({ ok: false, error: lastError });
});




app.post('/admin/login', (req, res) => {

  const password = (req.body && req.body.password) || '';

  if (!password || !verifyAdminPassword(password)) {

    return res.status(401).json({ ok: false, error: 'Invalid password.' });

  }

  const token = issueAdminToken();

  return res.json(Object.assign({ token }, buildAdminProfilePayload()));

});



app.get('/admin/profile', requireAdmin, (req, res) => {

  return res.json(buildAdminProfilePayload());

});



app.post('/admin/password', requireAdmin, (req, res) => {

  const currentPassword = req.body && req.body.currentPassword;

  const newPassword = req.body && req.body.newPassword;

  if (!newPassword || String(newPassword).length < 4) {

    return res

      .status(400)

      .json({ ok: false, error: 'New password must be at least 4 characters long.' });

  }

  if (!verifyAdminPassword(currentPassword || '')) {

    return res.status(400).json({ ok: false, error: 'Current password is incorrect.' });

  }

  updateAdminPassword(newPassword);

  adminTokens.clear();

  console.log('[server] Admin password updated.');

  logAdminEvent('password.change');

  return res.json({ ok: true });

});



app.get('/admin/templates', requireAdmin, (req, res) => {

  return res.json(buildTemplatesResponse());

});



app.post(

  '/admin/templates/upload',

  requireAdmin,

  templateUpload.single('file'),

  async (req, res) => {

    try {

      if (!req.file) {

        return res.status(400).json({ ok: false, error: 'PDF file is required.' });

      }

      const relativePath = sanitizeRelativePath(path.join('templates', req.file.filename));

      const absolutePath = path.join(PUBLIC_DIR, relativePath);

      const labelInput =

        req.body && typeof req.body.label === 'string' ? req.body.label.trim() : '';

      const descriptionInput =

        req.body && typeof req.body.description === 'string' ? req.body.description.trim() : '';

      const rawLabel =

        labelInput ||

        (req.file.originalname && req.file.originalname.trim()) ||

        req.file.filename;

      const label = rawLabel ? rawLabel.slice(0, 120) : 'Template';

      const description = descriptionInput ? descriptionInput.slice(0, 400) : '';

      const usedSlugs = new Set(

        templateManifest.templates.map((tpl) => (tpl.slug ? tpl.slug.toLowerCase() : '')).filter(Boolean),

      );

      const slug = generateTemplateSlug(label, usedSlugs);

      const analysis = await analyzeTemplatePdf(absolutePath);

      const entry = {

        id: `tpl-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,

        label,

        description,

        slug,

        relativePath,

        uploadedAt: new Date().toISOString(),

        size: req.file.size,

        source: 'upload',

        pageWidth: analysis.pageWidth,

        pageHeight: analysis.pageHeight,

        bodyTopOffset: defaultBodyTopOffset(analysis.pageHeight),

      };

      templateManifest.templates.push(entry);

      templateManifest.activeTemplateId = entry.id;

      saveTemplateManifest(templateManifest);

      try {

        applyActiveTemplateEntry(entry);

      } catch (err) {

        return res.status(500).json({ ok: false, error: err.message || 'Failed to activate template.' });

      }

      logAdminEvent('template.upload', { templateId: entry.id, label: entry.label, size: entry.size });

      return res.json(buildTemplatesResponse());

    } catch (err) {

      console.error('[server] Template upload failed', err);

      const status = Number.isInteger(err.statusCode) ? err.statusCode : 500;

      return res.status(status).json({ ok: false, error: err.message || 'Upload failed.' });

    }

  },

);



app.post('/admin/templates/select', requireAdmin, (req, res) => {

  const templateId = req.body && req.body.templateId;

  if (!templateId) {

    return res.status(400).json({ ok: false, error: 'templateId is required.' });

  }

  try {

    const entry = setActiveTemplateById(templateId);

    logAdminEvent('template.select', { templateId: entry.id, label: entry.label });

    return res.json(buildTemplatesResponse());

  } catch (err) {

    return res.status(404).json({ ok: false, error: err.message || 'Template not found.' });

  }

});



app.post('/admin/templates/boundary', requireAdmin, (req, res) => {

  const templateId = req.body && req.body.templateId;

  const rawOffset = req.body && req.body.bodyTopOffset;

  if (!templateId) {

    return res.status(400).json({ ok: false, error: 'templateId is required.' });

  }

  if (rawOffset === undefined || rawOffset === null) {

    return res.status(400).json({ ok: false, error: 'bodyTopOffset is required.' });

  }

  const offsetNumber = Number(rawOffset);

  if (!Number.isFinite(offsetNumber)) {

    return res.status(400).json({ ok: false, error: 'bodyTopOffset must be a number.' });

  }

  const entry = getTemplateEntryById(templateId);

  if (!entry) {

    return res.status(404).json({ ok: false, error: 'Template not found.' });

  }

  const pageHeight = Number.isFinite(entry.pageHeight) && entry.pageHeight > 0 ? entry.pageHeight : DEFAULT_PAGE_HEIGHT;

  entry.bodyTopOffset = clampNumber(offsetNumber, 0, pageHeight);

  saveTemplateManifest(templateManifest);

  logAdminEvent('template.boundary', {

    templateId: entry.id,

    bodyTopOffset: entry.bodyTopOffset,

    pageHeight,

  });

  return res.json(buildTemplatesResponse());

});



app.post('/admin/templates/delete', requireAdmin, (req, res) => {

  const templateId = req.body && req.body.templateId;

  if (!templateId) {

    return res.status(400).json({ ok: false, error: 'templateId is required.' });

  }

  const entry = getTemplateEntryById(templateId);

  if (!entry) {

    return res.status(404).json({ ok: false, error: 'Template not found.' });

  }

  if (entry.source === 'builtin') {

    return res.status(400).json({ ok: false, error: 'Builtin template cannot be deleted.' });

  }



  // Delete the file if it is there

  try {

    const safeRelative = sanitizeRelativePath(entry.relativePath || '');

    const absolute = path.join(PUBLIC_DIR, safeRelative);

    if (safeRelative && fs.existsSync(absolute)) {

      fs.unlinkSync(absolute);

    }

  } catch (err) {

    console.warn('[server] Failed to remove template file', err.message);

  }



  // Drop the entry from the manifest

  templateManifest.templates = templateManifest.templates.filter((tpl) => tpl.id !== entry.id);



  // If the active one was deleted, fall back to the first available or the builtin

  if (templateManifest.activeTemplateId === entry.id) {

    const fallback = getActiveTemplateEntry(templateManifest) || templateManifest.templates[0] || null;

    templateManifest.activeTemplateId = fallback ? fallback.id : null;

    if (fallback) {

      try {

        applyActiveTemplateEntry(fallback);

      } catch (err) {

        console.warn('[server] Failed to apply fallback template', err.message);

      }

    }

  }



  saveTemplateManifest(templateManifest);

  logAdminEvent('template.delete', { templateId: entry.id, label: entry.label, source: entry.source });

  return res.json(buildTemplatesResponse());

});

app.post(['/admin/sign/create', '/service2/admin/sign/create'], requireGenerateLinks, async (req, res) => {
  if (!SIGN_SERVICE_URL || !SIGN_INTERNAL_TOKEN) {
    return res.status(500).json({ ok: false, error: 'Signing service is not configured.' });
  }

  const resolved = resolveOutputFileFromRequest(req.body || {});
  if (!resolved) {
    return res.status(400).json({
      ok: false,
      error: 'Provide downloadPath (or url) or templateType + filename.',
    });
  }

  if (!fs.existsSync(resolved.filePath)) {
    return res.status(404).json({ ok: false, error: 'PDF file not found.' });
  }

  const requestedTtl = Number(req.body && req.body.expiresInDays);
  const expiresInDays = Number.isFinite(requestedTtl)
    ? clampNumber(requestedTtl, 1, 7)
    : 7;

  try {
    fsExtra.ensureDirSync(SIGN_INBOX_DIR);
    const baseName = resolved.filename.replace(/\.pdf$/i, '');
    const jobSuffix = crypto.randomBytes(4).toString('hex');
    const storedFilename = `${Date.now()}-${jobSuffix}-${baseName}.pdf`;
    const storedAbsPath = path.join(SIGN_INBOX_DIR, storedFilename);
    await fs.promises.copyFile(resolved.filePath, storedAbsPath);

    const storedRelPath = path.posix.join('inbox', storedFilename);
    const targetUrl = `${SIGN_SERVICE_URL.replace(/\/$/, '')}/internal/jobs`;
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': SIGN_INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        storedPath: storedRelPath,
        originalName: resolved.filename,
        expiresInDays,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      const error = payload && payload.error ? payload.error : 'Failed to create signing link.';
      return res.status(502).json({ ok: false, error });
    }

    return res.json({
      ok: true,
      signUrl: payload.url,
      expiresAt: payload.expiresAt,
      jobId: payload.jobId,
    });
  } catch (err) {
    console.error('[server] Failed to create signing job', err);
    return res.status(500).json({ ok: false, error: 'Unable to create signing job.' });
  }
});

app.get(['/api/sign/jobs', '/service2/api/sign/jobs'], requireGenerateLinks, async (req, res) => {
  if (!SIGN_SERVICE_URL || !SIGN_INTERNAL_TOKEN) {
    return res.status(500).json({ ok: false, error: 'Signing service is not configured.' });
  }
  try {
    const params = new URLSearchParams();
    const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : '';
    if (status) params.set('status', status);
    const limitRaw = Number(req.query.limit);
    if (Number.isFinite(limitRaw)) params.set('limit', String(Math.trunc(limitRaw)));
    const offsetRaw = Number(req.query.offset);
    if (Number.isFinite(offsetRaw)) params.set('offset', String(Math.trunc(offsetRaw)));
    const queryString = params.toString();
    const targetUrl = `${SIGN_SERVICE_URL.replace(/\/$/, '')}/internal/jobs${queryString ? `?${queryString}` : ''}`;
    const response = await fetch(targetUrl, {
      headers: { 'x-internal-token': SIGN_INTERNAL_TOKEN },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      const error = payload && payload.error ? payload.error : 'Failed to list sign jobs.';
      return res.status(502).json({ ok: false, error });
    }
    return res.json(payload);
  } catch (err) {
    console.error('[server] Failed to list sign jobs', err);
    return res.status(500).json({ ok: false, error: 'Unable to list sign jobs.' });
  }
});



app.get('/admin/templates/:templateId/preview', (req, res) => {

  const templateId = req.params.templateId;

  const entry = getTemplateEntryById(templateId);

  if (!entry) {

    return res.status(404).json({ ok: false, error: 'Template not found.' });

  }

  const safeRelative = sanitizeRelativePath(entry.relativePath || '');

  const absolute = path.join(PUBLIC_DIR, safeRelative);

  if (!fs.existsSync(absolute)) {

    return res.status(404).json({ ok: false, error: 'Template file missing.' });

  }

  res.setHeader('Content-Type', 'application/pdf');

  res.setHeader(

    'Content-Disposition',

    `inline; filename="${encodeURIComponent(path.basename(entry.relativePath || 'template.pdf'))}"`,

  );

  return res.sendFile(absolute);

});



app.get('/api/templates', (req, res) => {

  return res.json(buildPublicTemplatesResponse());

});

app.get(['/api/files', '/service2/api/files'], async (req, res) => {
  const type = normalizeQueryLower(req.query.type);
  const project = normalizeQueryLower(req.query.project);
  const reportDate = normalizeQueryLower(req.query.date || req.query.reportDate);
  const submitter = normalizeQueryLower(req.query.submitter || req.query.filledBy);
  const query = normalizeQueryLower(req.query.q || req.query.query || req.query.search);
  const status = normalizeQueryLower(req.query.status);
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit)
    ? clampNumber(Math.floor(rawLimit), 1, FILE_LIST_MAX_LIMIT)
    : FILE_LIST_DEFAULT_LIMIT;
  const rawOffset = Number(req.query.offset);
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.floor(rawOffset), 0) : 0;

  try {
    const result = await listFileEntries({
      type,
      project,
      reportDate,
      submitter,
      query,
      status,
      limit,
      offset,
    });
    return res.json({
      ok: true,
      files: result.entries,
      total: result.total,
      offset: result.offset,
      limit: result.limit,
      types: result.types,
      filters: { type, project, reportDate, submitter, query, status, limit, offset },
    });
  } catch (err) {
    console.error('[server] Failed to list files', err);
    return res.status(500).json({ ok: false, error: 'files_list_failed' });
  }
});

// --- Search (P6): unified substring search across files + projects (no new infra) ---
function scoreMatch(q, fields) {
  let best = 0;
  for (const f of fields) {
    if (!f) continue;
    const v = String(f).toLowerCase();
    if (v === q) best = Math.max(best, 1.0);
    else if (v.startsWith(q)) best = Math.max(best, 0.8);
    else if (v.includes(q)) best = Math.max(best, 0.5);
  }
  return best;
}

app.get(['/api/search', '/service2/api/search'], async (req, res) => {
  const q = normalizeQueryLower(req.query.q || req.query.query || req.query.search);
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? clampNumber(Math.floor(rawLimit), 1, 50) : 20;
  if (!q) return res.json({ ok: true, query: '', total: 0, results: [] });
  try {
    const fileResult = await listFileEntries({ query: q, limit: 200, offset: 0 });
    const fileHits = fileResult.entries.map((e) => ({
      kind: 'file',
      filename: e.filename,
      type: e.templateType,
      status: e.status,
      submittedAt: e.createdAt || null,
      summary: e.summary,
      score: scoreMatch(q, [e.filename, e.summary && e.summary.endCustomerName, e.summary && e.summary.siteLocation, e.summary && e.summary.projectNumber]),
    }));

    const store = loadProjectsStore() || {};
    const stats = await aggregateProjectStats();
    const keys = Array.from(new Set([...Object.keys(store), ...Object.keys(stats)]));
    const projHits = keys
      .map((key) => projectCardSummary(key, store[key], stats[key]))
      .filter((p) => {
        const hay = [p.projectNumber, p.endCustomerName, p.siteLocation, p.customerRepresentative, p.ledDisplayModel]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      })
      .map((p) => ({ kind: 'project', ...p, score: scoreMatch(q, [p.projectNumber, p.endCustomerName, p.siteLocation]) }));

    const results = [...projHits, ...fileHits].sort((a, b) => b.score - a.score).slice(0, limit);
    return res.json({ ok: true, query: q, total: results.length, results });
  } catch (err) {
    console.error('[server] search failed', err);
    return res.status(500).json({ ok: false, error: 'search_failed' });
  }
});

// --- Calendar (P8): reports grouped by submission day ---
async function collectCalendar(from, to) {
  const days = {};
  const types = await listOutputTypes();
  for (const type of types) {
    const metaDir = path.join(OUTPUT_DIR, type, 'meta');
    let files = [];
    try { files = await fs.promises.readdir(metaDir); } catch (err) { continue; }
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.json')) continue;
      let meta;
      try { meta = JSON.parse(await fs.promises.readFile(path.join(metaDir, file), 'utf8')); } catch (err) { continue; }
      const createdAt = String(meta.createdAt || '');
      const date = createdAt.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (from && date < from) continue;
      if (to && date > to) continue;
      const rb = (meta.requestBody && typeof meta.requestBody === 'object') ? meta.requestBody : {};
      const entry = {
        filename: meta.filename || file.replace(/\.json$/i, '.pdf'),
        type: meta.templateType || type,
        status: normalizeReportStatus(meta.status),
        projectNumber: resolveProjectNumber(rb) || null,
        submitterName: String(detectSubmitterName(rb) || '').trim() || null,
        submittedAt: createdAt || null,
      };
      if (!days[date]) days[date] = { count: 0, reports: [] };
      days[date].count += 1;
      days[date].reports.push(entry);
    }
  }
  for (const d of Object.keys(days)) {
    days[d].reports.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
  }
  return days;
}

app.get(['/api/calendar', '/service2/api/calendar'], async (req, res) => {
  const month = normalizeQueryText(req.query.month);
  let from = normalizeQueryText(req.query.from);
  let to = normalizeQueryText(req.query.to);
  if (month && /^\d{4}-\d{2}$/.test(month)) { from = `${month}-01`; to = `${month}-31`; }
  try {
    const days = await collectCalendar(from || '', to || '');
    const counts = {};
    let total = 0;
    for (const d of Object.keys(days)) { counts[d] = days[d].count; total += days[d].count; }
    return res.json({ ok: true, range: { from: from || null, to: to || null }, total, counts, days });
  } catch (err) {
    console.error('[server] calendar failed', err);
    return res.status(500).json({ ok: false, error: 'calendar_failed' });
  }
});

// --- LED model catalog: 2-step picker (series -> model) for "LED display model / batch" ---
// (LED_CATALOG + parseLedModel are defined near the top of the file â€” the form template uses them.)
app.get(['/api/led-models', '/service2/api/led-models'], (req, res) => {
  const series = LED_CATALOG.map((s) => ({
    series: s.series,
    code: s.code,
    ...(s.version ? { version: s.version } : {}),
    models: s.models.map((m) => {
      const p = parseLedModel(m);
      return { model: m, pitchMm: p.pitchMm, version: s.version || p.version, label: p.pitchMm != null ? `${m} Â· ${p.pitchMm} mm` : m };
    }),
  }));
  // codes = the letter-designation grouping (LD-E / LD-FE / LD-FA / LD-EC / LD-D),
  // repeats merged across series â€” preferred picker shape (type -> number).
  res.json({ ok: true, codes: ledCodeGroups(), series });
});

// --- People / role registry (E): remember who is internal staff (+role) vs customer-side ---
const PEOPLE_FILE = path.join(DATA_DIR, 'people.json');
function loadPeopleStore() {
  try { const d = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8')); return (d && typeof d === 'object') ? d : {}; } catch (e) { return {}; }
}
function savePeopleStore(store) {
  try { fs.writeFileSync(PEOPLE_FILE, JSON.stringify(store, null, 2)); } catch (e) { /* best-effort */ }
}
function personKey(name) { return String(name || '').trim().toLowerCase(); }
function recordPeople(body) {
  try {
    const store = loadPeopleStore();
    const now = new Date().toISOString();
    const bump = (name, kind, role, company) => {
      const key = personKey(name);
      if (!key || key.length < 2) return;
      const cur = store[key] || { name: String(name).trim(), kindCounts: {}, roles: {}, count: 0, lastSeen: null };
      cur.name = String(name).trim();
      cur.kindCounts[kind] = (cur.kindCounts[kind] || 0) + 1;
      const r = role ? String(role).trim() : '';
      if (r) { cur.roles[r] = (cur.roles[r] || 0) + 1; cur.lastRole = r; }
      const co = company ? String(company).trim() : '';
      if (co) cur.company = co; // remember the person's last-seen company for autofill
      cur.count += 1;
      cur.lastSeen = now;
      store[key] = cur;
    };
    const empSummary = collectEmployeeEntries(body);
    const employees = (empSummary && Array.isArray(empSummary.entries)) ? empSummary.entries : [];
    for (const e of employees) { if (e && e.name) bump(e.name, 'internal', e.role, null); }
    const eng = toSingleValue(body?.engineer_name);
    if (eng) bump(eng, 'internal', null, toSingleValue(body?.engineer_company));
    const cn = toSingleValue(body?.customer_name);
    if (cn) bump(cn, 'customer', null, toSingleValue(body?.customer_company));
    const cr = toSingleValue(body?.customer_representative);
    if (cr) bump(cr, 'customer', null, toSingleValue(body?.customer_company));
    savePeopleStore(store);
  } catch (e) { /* never block a submit on registry bookkeeping */ }
}
function personKind(entry) {
  const i = (entry.kindCounts && entry.kindCounts.internal) || 0;
  const c = (entry.kindCounts && entry.kindCounts.customer) || 0;
  if (i > c) return 'internal';
  if (c > i) return 'customer';
  return i ? 'internal' : 'customer';
}
function personTopRole(entry) {
  let best = null; let n = 0;
  for (const [r, c] of Object.entries(entry.roles || {})) { if (c > n) { n = c; best = r; } }
  return best;
}
function isInternalName(name) {
  const e = loadPeopleStore()[personKey(name)];
  return e ? personKind(e) === 'internal' : false;
}
app.get(['/api/people', '/service2/api/people'], (req, res) => {
  const kind = normalizeQueryLower(req.query.kind);
  const q = normalizeQueryLower(req.query.q);
  let people = Object.values(loadPeopleStore()).map((e) => ({
    name: e.name, kind: personKind(e), role: e.lastRole || personTopRole(e), company: e.company || null, count: e.count, lastSeen: e.lastSeen,
  }));
  if (kind === 'internal' || kind === 'customer') people = people.filter((p) => p.kind === kind);
  if (q) people = people.filter((p) => p.name.toLowerCase().includes(q) || String(p.role || '').toLowerCase().includes(q));
  people.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  res.json({ ok: true, people });
});

// One-time backfill so the registry knows existing staff/customers immediately.
async function backfillPeopleIfEmpty() {
  try {
    if (Object.keys(loadPeopleStore()).length > 0) return;
    const types = await listOutputTypes();
    for (const type of types) {
      const metaDir = path.join(OUTPUT_DIR, type, 'meta');
      let files = [];
      try { files = await fs.promises.readdir(metaDir); } catch (e) { continue; }
      for (const file of files) {
        if (!file.toLowerCase().endsWith('.json')) continue;
        try {
          const meta = JSON.parse(await fs.promises.readFile(path.join(metaDir, file), 'utf8'));
          if (meta && meta.requestBody) recordPeople(meta.requestBody);
        } catch (e) { /* skip */ }
      }
    }
    console.log('[server] people registry backfilled from existing submissions.');
  } catch (e) { /* best-effort */ }
}
backfillPeopleIfEmpty();

// --- Mobile app (P0): canonical form types + stored submission data ---

// Canonical list of report/form types â€” single source of truth for the app
// (removes the hardcoded mirror on iOS). available:false = recognised, not yet shippable.
const FORM_TYPES = [
  { id: 'service_report', label: 'Service report', available: true },
  { id: 'maintenance', label: 'Maintenance', available: true },
  { id: 'daily_report', label: 'Daily report', available: true },
  { id: 'installation_report', label: 'Installation report', available: true },
  { id: 'calibration', label: 'Calibration', available: false },
];

app.get(['/api/form-types', '/service2/api/form-types'], (req, res) => {
  // Attach the active template slug as defaultTemplateSlug for available types
  // (this codebase has one active template, not a per-type mapping). Omitted for
  // unavailable types, so iOS falls back to the server's active template.
  let activeSlug = null;
  try {
    const pub = buildPublicTemplatesResponse();
    const active = (pub.templates || []).find((t) => t.isActive || t.id === pub.activeTemplateId);
    activeSlug = active ? active.slug : null;
  } catch (err) {
    activeSlug = null;
  }
  const formTypes = FORM_TYPES.map((t) =>
    (t.available && activeSlug) ? { ...t, defaultTemplateSlug: activeSlug } : { ...t }
  );
  return res.json({ ok: true, formTypes });
});

// Return the stored submission fields used to render a past PDF, so the app can
// restore + edit + resubmit a previous report. Keys match the web form / fields.json.
async function readFileDataResponse(type, filename) {
  const metaPath = buildMetaPath(type, filename);
  if (!metaPath || !fs.existsSync(metaPath)) return null;
  const raw = await fs.promises.readFile(metaPath, 'utf8');
  const meta = JSON.parse(raw);
  const rb = (meta.requestBody && typeof meta.requestBody === 'object') ? { ...meta.requestBody } : {};
  // F: put stored signature images back as data URLs so edit-resubmit keeps them.
  let signaturesRestored = false;
  if (meta.signatureFiles && typeof meta.signatureFiles === 'object') {
    const signaturesDir = path.join(path.dirname(metaPath), '..', 'signatures');
    for (const [sigName, sigFile] of Object.entries(meta.signatureFiles)) {
      try {
        const safe = sanitizeFilename(String(sigFile));
        const sigPath = safeResolvePath(signaturesDir, path.join(signaturesDir, safe));
        if (!sigPath || !fs.existsSync(sigPath)) continue;
        const buf = await fs.promises.readFile(sigPath);
        const mime = /\.png$/i.test(safe) ? 'image/png' : 'image/jpeg';
        rb[sigName] = `data:${mime};base64,${buf.toString('base64')}`;
        signaturesRestored = true;
      } catch (err) { /* leave redacted */ }
    }
  }
  const outFilename = meta.filename || filename;
  const outType = meta.templateType || type;
  const photos = Array.isArray(meta.photoFiles)
    ? meta.photoFiles.map((p) => ({
        field: p.field || null,
        file: p.file || null,
        mime: p.mime || null,
        name: p.name || null,
        url: `/api/files/${encodeURIComponent(outType)}/${encodeURIComponent(outFilename)}/photos/${encodeURIComponent(p.file)}`,
      }))
    : [];
  return {
    ok: true,
    filename: outFilename,
    type: outType,
    templateSlug: meta.templateSlug || null,
    templateLabel: meta.templateLabel || null,
    submittedAt: meta.createdAt || null,
    clientReportId: rb.client_report_id || null,
    status: normalizeReportStatus(meta.status),
    signaturesRestored,
    remoteSigned: meta.remoteSigned === true,
    remoteSignedAt: meta.remoteSignedAt || null,
    signatureCount: countReportSignatures(meta),
    signatures: reportSignatureSlots(meta),
    photos,
    fields: rb,
  };
}

// Primary shape (type in the path), e.g. /api/files/daily_report/<file>.pdf/data
app.get(['/api/files/:type/:filename/data', '/service2/api/files/:type/:filename/data'], async (req, res) => {
  const type = sanitizeFilename(req.params.type || '');
  const filename = sanitizeFilename(req.params.filename || '');
  if (!type || !filename) {
    return res.status(400).json({ ok: false, error: 'invalid_request' });
  }
  try {
    const data = await readFileDataResponse(type, filename);
    if (!data) return res.status(404).json({ ok: false, error: 'file_not_found' });
    return res.json(data);
  } catch (err) {
    console.error('[server] Failed to read file data', err);
    return res.status(500).json({ ok: false, error: 'file_data_failed' });
  }
});

// Serve a persisted report photo by field-indexed filename (from meta.photoFiles).
app.get(['/api/files/:type/:filename/photos/:name', '/service2/api/files/:type/:filename/photos/:name'], async (req, res) => {
  const type = sanitizeFilename(req.params.type || '');
  const filename = sanitizeFilename(req.params.filename || '');
  const name = sanitizeFilename(req.params.name || '');
  if (!type || !filename || !name) return res.status(400).json({ ok: false, error: 'invalid_request' });
  const base = filename.replace(/\.pdf$/i, '');
  const photosDir = path.join(OUTPUT_DIR, type, 'photos', base);
  const filePath = safeResolvePath(photosDir, path.join(photosDir, name));
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'photo_not_found' });
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : (ext === '.heic' ? 'image/heic' : 'image/jpeg'));
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  return res.sendFile(filePath);
});

// Convenience: no type in the path â€” search across output types (optional ?type= hint).
app.get(['/api/files/:filename/data', '/service2/api/files/:filename/data'], async (req, res) => {
  const filename = sanitizeFilename(req.params.filename || '');
  if (!filename) {
    return res.status(400).json({ ok: false, error: 'invalid_filename' });
  }
  const rawType = normalizeQueryText(req.query.type);
  const types = rawType ? [sanitizeFilename(rawType)] : await listOutputTypes();
  try {
    for (const type of types) {
      const data = await readFileDataResponse(type, filename);
      if (data) return res.json(data);
    }
    return res.status(404).json({ ok: false, error: 'file_not_found' });
  } catch (err) {
    console.error('[server] Failed to read file data', err);
    return res.status(500).json({ ok: false, error: 'file_data_failed' });
  }
});

// --- Approval workflow (P4): review a report (admin/manager â€” gated at the hub) ---
// State machine (defaults; confirm transitions with the app dev):
//   start_review: submitted -> in_review
//   approve:      submitted|in_review -> approved
//   reject:       submitted|in_review -> rejected
//   reopen:       approved|rejected -> in_review
const REVIEW_ACTIONS = {
  start_review: { to: 'in_review', from: ['submitted'] },
  approve: { to: 'approved', from: ['submitted', 'in_review'] },
  reject: { to: 'rejected', from: ['submitted', 'in_review'] },
  reopen: { to: 'in_review', from: ['approved', 'rejected'] },
};

async function updateReportStatus(type, filename, action, reviewer) {
  const metaPath = buildMetaPath(type, filename);
  if (!metaPath || !fs.existsSync(metaPath)) return { error: 'not_found' };
  const def = REVIEW_ACTIONS[action];
  if (!def) return { error: 'invalid_action' };
  let meta;
  try {
    meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
  } catch (err) {
    return { error: 'meta_unreadable' };
  }
  const current = normalizeReportStatus(meta.status);
  if (!def.from.includes(current)) return { error: 'invalid_transition', current };
  meta.status = def.to;
  const entry = {
    action,
    status: def.to,
    previous: current,
    at: new Date().toISOString(),
    by: reviewer.user || null,
    role: reviewer.role || null,
    ...(reviewer.note ? { note: String(reviewer.note).slice(0, 1000) } : {}),
  };
  if (!Array.isArray(meta.reviewHistory)) meta.reviewHistory = [];
  meta.reviewHistory.push(entry);
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
  return { ok: true, status: def.to, previous: current, review: entry };
}

app.post(['/api/reports/:type/:filename/review', '/service2/api/reports/:type/:filename/review'], async (req, res) => {
  const type = sanitizeFilename(req.params.type || '');
  const filename = sanitizeFilename(req.params.filename || '');
  if (!type || !filename) return res.status(400).json({ ok: false, error: 'invalid_request' });
  const action = req.body && typeof req.body.action === 'string' ? req.body.action.trim() : '';
  const reviewer = {
    user: req.headers['x-hub-user'] || (req.body && req.body.reviewer) || null,
    role: req.headers['x-hub-role'] || null,
    note: req.body && req.body.note,
  };
  const r = await updateReportStatus(type, filename, action, reviewer);
  if (r.error === 'not_found') return res.status(404).json({ ok: false, error: 'not_found' });
  if (r.error === 'invalid_action') return res.status(400).json({ ok: false, error: 'invalid_action', allowed: Object.keys(REVIEW_ACTIONS) });
  if (r.error === 'invalid_transition') return res.status(409).json({ ok: false, error: 'invalid_transition', current: r.current, allowed: Object.keys(REVIEW_ACTIONS) });
  if (r.error) return res.status(500).json({ ok: false, error: r.error });
  return res.json({ ok: true, type, filename, status: r.status, previous: r.previous, review: r.review });
});

app.get(['/api/reports/:type/:filename/status', '/service2/api/reports/:type/:filename/status'], async (req, res) => {
  const type = sanitizeFilename(req.params.type || '');
  const filename = sanitizeFilename(req.params.filename || '');
  const metaPath = buildMetaPath(type, filename);
  if (!metaPath || !fs.existsSync(metaPath)) return res.status(404).json({ ok: false, error: 'not_found' });
  try {
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    return res.json({
      ok: true,
      type,
      filename,
      status: normalizeReportStatus(meta.status),
      reviewHistory: Array.isArray(meta.reviewHistory) ? meta.reviewHistory : [],
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'status_failed' });
  }
});

app.post(['/api/files/delete', '/service2/api/files/delete'], requireDeleteFiles, async (req, res) => {
  const selections = collectFileSelections(req.body || {});
  if (!selections.length) {
    return res.status(400).json({ ok: false, error: 'no_files_selected' });
  }

  const deleted = [];
  const missing = [];
  const errors = [];

  for (const entry of selections) {
    const key = `${entry.templateType}/${entry.filename}`;
    try {
      const pdfPath = buildPdfPath(entry.templateType, entry.filename);
      const metaPath = buildMetaPath(entry.templateType, entry.filename);
      let meta = null;
      if (metaPath && fs.existsSync(metaPath)) {
        try {
          const raw = await fs.promises.readFile(metaPath, 'utf8');
          meta = JSON.parse(raw);
        } catch (err) {
          // ignore metadata parsing failures
        }
      }

      let found = false;
      if (pdfPath && fs.existsSync(pdfPath)) {
        await fs.promises.unlink(pdfPath);
        found = true;
      }
      if (metaPath && fs.existsSync(metaPath)) {
        await fs.promises.unlink(metaPath);
        found = true;
      }

      if (meta && meta.dailyReportPath) {
        const dailyPath = safeResolvePath(OUTPUT_DIR, meta.dailyReportPath);
        if (dailyPath && fs.existsSync(dailyPath)) {
          await fs.promises.unlink(dailyPath);
          found = true;
        }
      }

      if (found) {
        deleted.push(key);
      } else {
        missing.push(key);
      }
    } catch (err) {
      console.error('[server] Failed to delete file', key, err);
      errors.push({ file: key, error: err.message || String(err) });
    }
  }

  return res.json({ ok: true, deleted, missing, errors });
});

// --- Trash / soft-delete endpoints (contract agreed with iOS in issue #1) ---------
// Literal /trash routes are registered before the :type/:filename param routes so
// e.g. GET /api/files/trash is never captured by a param pattern.

// List trashed reports (read-only; hub gates who can reach it).
app.get(['/api/files/trash', '/service2/api/files/trash'], async (req, res) => {
  try {
    const files = await listTrashEntries();
    const settings = await getTrashSettings();
    return res.json({ ok: true, files, total: files.length, retentionDays: settings.retentionDays });
  } catch (err) {
    console.error('[server] trash list failed', err);
    return res.status(500).json({ ok: false, error: 'trash_list_failed' });
  }
});

// Retention settings.
app.get(['/api/files/trash/settings', '/service2/api/files/trash/settings'], async (req, res) => {
  const settings = await getTrashSettings();
  return res.json({ ok: true, ...settings });
});

app.put(['/api/files/trash/settings', '/service2/api/files/trash/settings'], requireDeleteFiles, async (req, res) => {
  try {
    const settings = await setTrashSettings(req.body && req.body.retentionDays);
    return res.json({ ok: true, ...settings });
  } catch (err) {
    console.error('[server] trash settings update failed', err);
    return res.status(500).json({ ok: false, error: 'trash_settings_failed' });
  }
});

// Empty the whole trash (permanent).
app.post(['/api/files/trash/empty', '/service2/api/files/trash/empty'], requireDeleteFiles, async (req, res) => {
  try {
    const entries = await listTrashEntries();
    let purged = 0;
    for (const entry of entries) {
      const ok = await purgeTrashReport(entry.templateType, reportBaseName(entry.filename));
      if (ok) purged += 1;
    }
    return res.json({ ok: true, purged });
  } catch (err) {
    console.error('[server] trash empty failed', err);
    return res.status(500).json({ ok: false, error: 'trash_empty_failed' });
  }
});

// Soft-delete a single report into the trash.
app.post(['/api/files/:type/:filename/trash', '/service2/api/files/:type/:filename/trash'], requireDeleteFiles, async (req, res) => {
  try {
    const deletedBy = req.headers['x-hub-user'] || (req.body && req.body.deletedBy) || null;
    const record = await trashReport(req.params.type, req.params.filename, deletedBy);
    if (!record) return res.status(404).json({ ok: false, error: 'file_not_found' });
    return res.json({ ok: true, trashed: record });
  } catch (err) {
    console.error('[server] trash move failed', err);
    return res.status(500).json({ ok: false, error: 'trash_failed' });
  }
});

// Flag a report as a test so it is obvious in the archive which rows are throwaway.
// Nothing is deleted here on purpose — an admin decides when they go, this only labels them.
app.post(['/api/files/:type/:filename/test', '/service2/api/files/:type/:filename/test'], requireDeleteFiles, async (req, res) => {
  try {
    const metaPath = buildMetaPath(req.params.type, req.params.filename);
    if (!metaPath || !fs.existsSync(metaPath)) return res.status(404).json({ ok: false, error: 'file_not_found' });
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    const isTest = !(req.body && req.body.test === false);
    if (isTest) {
      meta.test = true;
      meta.testMarkedAt = new Date().toISOString();
      meta.testMarkedBy = req.headers['x-hub-user'] || (req.body && req.body.markedBy) || null;
    } else {
      delete meta.test;
      delete meta.testMarkedAt;
      delete meta.testMarkedBy;
    }
    await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
    return res.json({ ok: true, filename: req.params.filename, test: isTest });
  } catch (err) {
    console.error('[server] test flag failed', err);
    return res.status(500).json({ ok: false, error: 'test_flag_failed' });
  }
});

// Restore a trashed report to the live listing.
app.post(['/api/files/:type/:filename/restore', '/service2/api/files/:type/:filename/restore'], requireDeleteFiles, async (req, res) => {
  try {
    const restored = await restoreReport(req.params.type, req.params.filename);
    if (!restored) return res.status(404).json({ ok: false, error: 'trash_entry_not_found' });
    const type = sanitizeFilename(req.params.type);
    return res.json({
      ok: true,
      restored: { type, filename: restored, url: `/api/files/${encodeURIComponent(type)}/${encodeURIComponent(restored)}` },
    });
  } catch (err) {
    console.error('[server] trash restore failed', err);
    return res.status(500).json({ ok: false, error: 'restore_failed' });
  }
});

// Permanently purge a single trashed report.
app.delete(['/api/files/:type/:filename/purge', '/service2/api/files/:type/:filename/purge'], requireDeleteFiles, async (req, res) => {
  try {
    const ok = await purgeTrashReport(req.params.type, req.params.filename);
    if (!ok) return res.status(404).json({ ok: false, error: 'trash_entry_not_found' });
    return res.json({ ok: true, purged: 1 });
  } catch (err) {
    console.error('[server] trash purge failed', err);
    return res.status(500).json({ ok: false, error: 'purge_failed' });
  }
});

// --- Feedback / diagnostics endpoints (contract agreed with iOS in issue #1) -------
// Accepts images/PDF/text/json parts; unknown/oversized handled gracefully.
const feedbackUpload = multer({
  storage: multer.memoryStorage(),
  // 25 MB/file to accommodate short compressed videos (iOS uploads 720p MP4).
  limits: { fileSize: 25 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => {
    const m = String(file.mimetype || '').toLowerCase();
    const ok = m.startsWith('image/') || m.startsWith('audio/') || m.startsWith('video/') || m === 'application/pdf' || m.startsWith('text/') || m === 'application/json';
    if (!ok) { const e = new Error('Unsupported feedback attachment type.'); e.statusCode = 400; return cb(e); }
    return cb(null, true);
  },
}).any();

// Intake: any authenticated app user (the hub gates auth; service2 records x-hub-user).
app.post(['/api/feedback', '/service2/api/feedback'], (req, res) => {
  feedbackUpload(req, res, async (err) => {
    if (err) {
      const code = err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      return res.status(code).json({ ok: false, error: err.message || 'upload_failed' });
    }
    try {
      const kind = String(toSingleValue(req.body?.kind) || '').trim().toLowerCase();
      if (!FEEDBACK_KINDS.has(kind)) return res.status(400).json({ ok: false, error: 'invalid_kind' });
      const message = String(toSingleValue(req.body?.message) || '').slice(0, FEEDBACK_MAX_MESSAGE);
      const context = safeParseJson(toSingleValue(req.body?.context)) || {};
      const username = req.headers['x-hub-user'] || context.username || null;

      const id = newFeedbackId();
      const dir = feedbackDirFor(id);
      if (!dir) return res.status(500).json({ ok: false, error: 'feedback_id_failed' });
      await fsExtra.ensureDir(dir);

      const files = Array.isArray(req.files) ? req.files : [];
      const attachments = [];
      let hasLogs = false, hasFormArchive = false;
      for (const f of files) {
        if (!f || !f.buffer || !Buffer.isBuffer(f.buffer)) continue;
        const field = String(f.fieldname || '');
        if (field === 'logs') {
          await fs.promises.writeFile(path.join(dir, 'logs.txt'), f.buffer);
          hasLogs = true;
        } else if (field === 'form_archive') {
          await fs.promises.writeFile(path.join(dir, 'form_archive.json'), f.buffer);
          hasFormArchive = true;
        } else {
          if (attachments.length >= FEEDBACK_MAX_ATTACHMENTS) continue;
          const name = sanitizeFilename(`attachment_${attachments.length}.${feedbackAttachmentExt(f.mimetype)}`);
          await fsExtra.ensureDir(path.join(dir, 'attachments'));
          await fs.promises.writeFile(path.join(dir, 'attachments', name), f.buffer);
          attachments.push({ file: name, mime: f.mimetype || null, size: f.buffer.length, name: f.originalname || null });
        }
      }

      const createdAt = new Date().toISOString();
      const record = { id, kind, message, context, username, createdAt, attachments, hasLogs, hasFormArchive };
      await fs.promises.writeFile(path.join(dir, 'feedback.json'), JSON.stringify(record, null, 2));
      console.log(`[server] feedback ${id} (${kind}) from ${username || 'anon'}${kind === 'submit_failure' ? ' — SUBMIT FAILURE' : ''}`);
      // Surface every report in the admin-only chat feed (submit_failure also pushes).
      // Fire-and-forget; never blocks or fails intake.
      notifyHubFeedback(record);
      return res.json({ ok: true, id, createdAt });
    } catch (e) {
      console.error('[server] feedback intake failed', e);
      return res.status(500).json({ ok: false, error: 'feedback_failed' });
    }
  });
});

// Admin list (compact rows). requireFileAdmin = role admin or admin token (hub gates too).
app.get(['/api/feedback/admin/list', '/service2/api/feedback/admin/list'], requireFileAdmin, async (req, res) => {
  try {
    const items = await listFeedbackRows();
    return res.json({ ok: true, items, total: items.length });
  } catch (e) {
    console.error('[server] feedback list failed', e);
    return res.status(500).json({ ok: false, error: 'feedback_list_failed' });
  }
});

// Serve a feedback attachment (path-guarded).
app.get(['/api/feedback/admin/:id/attachments/:name', '/service2/api/feedback/admin/:id/attachments/:name'], requireFileAdmin, (req, res) => {
  const dir = feedbackDirFor(req.params.id);
  if (!dir) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const attachDir = path.join(dir, 'attachments');
  const filePath = safeResolvePath(attachDir, path.join(attachDir, sanitizeFilename(req.params.name || '')));
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'attachment_not_found' });
  const ext = path.extname(filePath).toLowerCase();
  const MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.heic': 'image/heic', '.pdf': 'application/pdf', '.json': 'application/json', '.txt': 'text/plain',
    '.webm': 'audio/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  };
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  // dotfiles:'allow' — the path lives under out/.feedback/ and sendFile ignores dotdirs by default.
  return res.sendFile(filePath, { dotfiles: 'allow' });
});

// Serve the diagnostic logs / form archive of a feedback item.
app.get(['/api/feedback/admin/:id/logs', '/service2/api/feedback/admin/:id/logs'], requireFileAdmin, (req, res) => {
  const dir = feedbackDirFor(req.params.id);
  const filePath = dir ? path.join(dir, 'logs.txt') : null;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'logs_not_found' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.sendFile(filePath, { dotfiles: 'allow' });
});
app.get(['/api/feedback/admin/:id/form_archive', '/service2/api/feedback/admin/:id/form_archive'], requireFileAdmin, (req, res) => {
  const dir = feedbackDirFor(req.params.id);
  const filePath = dir ? path.join(dir, 'form_archive.json') : null;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'form_archive_not_found' });
  res.setHeader('Content-Type', 'application/json');
  return res.sendFile(filePath, { dotfiles: 'allow' });
});

// Full detail (context + attachment/log URLs).
app.get(['/api/feedback/admin/:id', '/service2/api/feedback/admin/:id'], requireFileAdmin, async (req, res) => {
  const dir = feedbackDirFor(req.params.id);
  if (!dir || !fs.existsSync(path.join(dir, 'feedback.json'))) return res.status(404).json({ ok: false, error: 'feedback_not_found' });
  try {
    const rec = JSON.parse(await fs.promises.readFile(path.join(dir, 'feedback.json'), 'utf8'));
    const idEnc = encodeURIComponent(rec.id);
    rec.attachments = (Array.isArray(rec.attachments) ? rec.attachments : []).map((a) => ({
      ...a,
      url: `/api/feedback/admin/${idEnc}/attachments/${encodeURIComponent(a.file)}`,
    }));
    rec.logsUrl = rec.hasLogs ? `/api/feedback/admin/${idEnc}/logs` : null;
    rec.formArchiveUrl = rec.hasFormArchive ? `/api/feedback/admin/${idEnc}/form_archive` : null;
    return res.json({ ok: true, feedback: rec });
  } catch (e) {
    console.error('[server] feedback detail failed', e);
    return res.status(500).json({ ok: false, error: 'feedback_detail_failed' });
  }
});

app.delete(['/api/feedback/admin/:id', '/service2/api/feedback/admin/:id'], requireFileAdmin, async (req, res) => {
  const dir = feedbackDirFor(req.params.id);
  if (!dir || !fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'feedback_not_found' });
  try {
    await fsExtra.remove(dir);
    return res.json({ ok: true, deleted: req.params.id });
  } catch (e) {
    console.error('[server] feedback delete failed', e);
    return res.status(500).json({ ok: false, error: 'feedback_delete_failed' });
  }
});

app.post(['/api/files/zip', '/service2/api/files/zip'], requireDeleteFiles, async (req, res) => {
  const selections = collectFileSelections(req.body || {});
  if (!selections.length) {
    return res.status(400).json({ ok: false, error: 'no_files_selected' });
  }
  if (selections.length > FILE_ZIP_MAX) {
    return res.status(413).json({ ok: false, error: 'too_many_files' });
  }

  const filesToZip = [];
  selections.forEach((entry) => {
    const pdfPath = buildPdfPath(entry.templateType, entry.filename);
    if (pdfPath && fs.existsSync(pdfPath)) {
      filesToZip.push({
        path: pdfPath,
        name: `${entry.templateType}/${entry.filename}`,
      });
    }
  });

  if (!filesToZip.length) {
    return res.status(404).json({ ok: false, error: 'files_not_found' });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `reports-${timestamp}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('[server] Zip failed', err);
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  });

  archive.pipe(res);
  filesToZip.forEach((file) => {
    archive.file(file.path, { name: file.name });
  });
  archive.finalize();
});

app.get('/admin/submit-log', requireFileAdmin, (req, res) => {
  const parsed = parseInt(req.query.limit, 10);
  const limit = Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : 100, SUBMIT_JOURNAL_MAX);
  const items = submitJournal.slice(-limit).reverse();
  res.json({
    ok: true,
    total: submitJournal.length,
    maxUploadFiles: MAX_UPLOAD_FILES,
    items,
  });
});

app.post('/submit', journalSubmit, rateLimitSubmit, (req, res, next) => {

  uploadFields(req, res, (err) => {

    if (err) {

      return next(err);

    }

    return next();

  });

}, async (req, res) => {

  // Idempotency for mobile sync: same clientReportId never creates a duplicate report.
  const clientReportId = normalizeClientReportId(
    toSingleValue(req.body?.client_report_id) || toSingleValue(req.body?.clientReportId)
  );

  // F (edit-after-signed): edit=1 with a known client_report_id regenerates the
  // report IN PLACE of the previous file instead of replaying the cached response.
  const isEditRequest = ['1', 'true', 'yes', 'on'].includes(
    String(toSingleValue(req.body?.edit) || toSingleValue(req.body?.is_edit) || '').trim().toLowerCase()
  );
  let editingPrevious = null;

  if (clientReportId) {
    const stored = findStoredSubmission(clientReportId);
    if (stored) {
      if (!isEditRequest) {
        return res.json({ ...stored.response, duplicate: true });
      }
      editingPrevious = stored.response || null;
    }
    if (inFlightClientReportIds.has(clientReportId)) {
      return res.status(409).json({ ok: false, error: 'duplicate_in_progress' });
    }
    inFlightClientReportIds.add(clientReportId);
    const releaseInFlight = () => inFlightClientReportIds.delete(clientReportId);
    res.once('finish', releaseInFlight);
    res.once('close', releaseInFlight);
  }

  let photoFiles = collectPhotoFiles(req.files);

  // Edit-resubmit with no photo parts: restore the previous report's persisted photos so
  // the regenerated PDF keeps them. Web edits don't re-upload; iOS re-uploads originals so
  // this stays a no-op there. `drop_photos=1` opts out to intentionally clear all photos.
  if (editingPrevious && editingPrevious.filename && !photoFiles.length) {
    const dropPhotos = ['1', 'true', 'yes', 'on'].includes(
      String(toSingleValue(req.body?.drop_photos) || '').trim().toLowerCase()
    );
    if (!dropPhotos) {
      const prevType = editingPrevious.type || toSingleValue(req.body?.template_type) || 'service_report';
      const restored = await loadPersistedPhotoFiles(prevType, editingPrevious.filename);
      if (restored.length) {
        photoFiles = restored;
        console.log(`[server] edit ${editingPrevious.filename}: restored ${restored.length} persisted photo(s) (no new parts)`);
      }
    }
  }

  const totalPhotoBytes = photoFiles.reduce((sum, file) => {

    if (!file) return sum;

    if (typeof file.size === 'number' && Number.isFinite(file.size)) {

      return sum + Math.max(0, file.size);

    }

    if (file.buffer && Buffer.isBuffer(file.buffer)) {

      return sum + file.buffer.length;

    }

    return sum;

  }, 0);



  if (totalPhotoBytes > MAX_TOTAL_UPLOAD_BYTES) {

    return res.status(413).json({

      ok: false,

      error:

        'Total photo upload size is ' +

        formatBytesHuman(totalPhotoBytes) +

        ', which exceeds the ' +

        formatBytesHuman(MAX_TOTAL_UPLOAD_BYTES) +

        ' limit. Please remove or compress some images.',

    });

  }

  const signatureImages = [];

  // Enforce the YY-NNNN project number before anything reads it, so the stored value, the
  // filename and the project grouping all agree no matter which client sent it.
  if (req.body && typeof req.body === 'object') {
    PROJECT_NUMBER_FIELDS.forEach((key) => {
      const current = toSingleValue(req.body[key]);
      if (current === undefined || current === null || String(current).trim() === '') return;
      const normalized = normalizeProjectNumber(current);
      if (normalized !== String(current)) {
        console.log(`[server] project number ${key}: "${current}" -> "${normalized}"`);
        req.body[key] = normalized;
      }
    });
  }

  const sanitizedBody = {};

  const overflowTextEntries = [];

  const partsRowUsage = collectPartsRowUsage(req.body || {});

  const employeeSummary = collectEmployeeEntries(req.body || {});

  // iOS path: signature arrived as a binary file part â€” normalize to a data URL
  // so the rest of the pipeline (render, persist, restore) is format-agnostic.
  for (const sigName of ['engineer_signature', 'customer_signature']) {
    const part = req.files && Array.isArray(req.files[sigName]) ? req.files[sigName][0] : null;
    if (part && part.buffer && part.buffer.length) {
      const mime = /png$/i.test(part.mimetype || '') ? 'image/png' : 'image/jpeg';
      req.body[sigName] = `data:${mime};base64,${part.buffer.toString('base64')}`;
    }
  }

  const signatureInputs = {

    engineer_signature: req.body?.engineer_signature,

    customer_signature: req.body?.customer_signature,

  };

  // Default the service company to Sharp when the engineer left it blank (per ops).
  if (req.body && typeof req.body === 'object' && !String(toSingleValue(req.body.service_company_name) || '').trim()) {
    req.body.service_company_name = 'Sharp';
  }

  let overflowPlacements = [];

  let hiddenPartRows = [];

  let partsRowsRendered = [];

  let projectsStore = loadProjectsStore();

  const projectKey = resolveProjectNumber(req.body) || null;

  const templateType = toSingleValue(req.body?.template_type) || 'service_report';

  const isDailyReport = templateType === 'daily_report';

  const dailyReportData = isDailyReport

    ? {

        projectNumber: String(toSingleValue(req.body?.[DAILY_REPORT_FIELDS.projectNumber]) || '').trim(),

        reportDate: String(toSingleValue(req.body?.[DAILY_REPORT_FIELDS.reportDate]) || '').trim(),

        submitterName: String(toSingleValue(req.body?.[DAILY_REPORT_FIELDS.submitterName]) || '').trim(),

        reportText: String(toSingleValue(req.body?.[DAILY_REPORT_FIELDS.reportText]) || '').trim(),

      }

    : null;

  if (isDailyReport) {

    const missing = [];

    if (!dailyReportData.projectNumber) missing.push('project number');

    if (!dailyReportData.reportDate) missing.push('report date');

    if (!dailyReportData.submitterName) missing.push('filled by');

    if (missing.length) {

      return res.status(400).json({

        ok: false,

        error: `Daily report requires: ${missing.join(', ')}.`,

      });

    }

  }

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



  // Always pick up the signatures, even when the fields do not match the template.

  Object.entries(signatureInputs).forEach(([sigName, raw]) => {

    if (typeof raw === 'string' && raw.startsWith('data:image/')) {

      // An untouched signature pad still serialises to a valid, fully transparent PNG.
      // Treat that as "not signed" so it isn't drawn, persisted or counted.
      if (isBlankSignatureImage(raw)) {
        console.log(`[server] ignoring blank ${sigName} (empty signature pad)`);
        if (req.body) req.body[sigName] = '';
        return;
      }

      signatureImages.push({ acroName: sigName, data: raw });

    }

  });



  const templateIdParam =

    req.body && typeof req.body.template_id === 'string' ? req.body.template_id.trim() : '';

  const templateSlugParam =

    req.body && typeof req.body.template_slug === 'string' ? req.body.template_slug.trim() : '';

  const requestedTemplateRef = templateIdParam || templateSlugParam || '';

  let submissionTemplateEntry = null;

  let submissionTemplatePath = null;



  try {

    if (requestedTemplateRef) {

      submissionTemplateEntry = resolveTemplateEntryForSubmission(requestedTemplateRef);

      if (!submissionTemplateEntry) {

        return res

          .status(400)

          .json({ ok: false, error: 'Selected document template is unavailable. Please refresh and try again.' });

      }

    } else {

      submissionTemplateEntry = resolveTemplateEntryForSubmission(null);

    }



    if (!submissionTemplateEntry) {

      return res

        .status(500)

        .json({ ok: false, error: 'No active document template is configured. Contact an administrator.' });

    }



    submissionTemplatePath = resolveTemplateFileFromEntry(submissionTemplateEntry);



    if (!submissionTemplatePath || !fs.existsSync(submissionTemplatePath)) {

      return res.status(500).json({

        ok: false,

        error: 'Template PDF could not be located on disk. Please contact an administrator.',

      });

    }



    const pdfBytes = await fs.promises.readFile(submissionTemplatePath);

    let pdfDoc;

    try {

      pdfDoc = await PDFDocument.load(pdfBytes);

    } catch (err) {

      const isEncrypted =

        err instanceof EncryptedPDFError ||

        (err && typeof err.message === 'string' && /is encrypted/i.test(err.message || ''));

      const isUnsupported =

        err instanceof UnexpectedObjectTypeError ||

        (err && typeof err.message === 'string' && /expected instance of PDFDict/i.test(err.message || ''));

      if (isEncrypted || isUnsupported) {

        const friendly = new Error(

          `Selected template "${submissionTemplateEntry.label || submissionTemplateEntry.id}" is password-protected or uses a restricted PDF format. Please export an unlocked PDF without editing restrictions and upload it again.`,

        );

        friendly.statusCode = 400;

        throw friendly;

      }

      throw err;

    }

    let form = pdfDoc.getForm();

    const hasAcroForm =

      form &&

      typeof form.getFields === 'function' &&

      Array.isArray(form.getFields()) &&

      form.getFields().length > 0;

    if (!hasAcroForm) {

      console.warn(

        `[server] Selected template "${submissionTemplateEntry.label || submissionTemplateEntry.id}" has no AcroForm fields; skipping form population.`,

      );

      form = null;

    }

    const templatePageSize = pdfDoc.getPageCount()

      ? pdfDoc.getPages()[0].getSize()

      : { width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT };

    let helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

    let dailyReportHeaderPage = null;

    const templatePdfDoc = pdfDoc;

    if (isDailyReport) {

      pdfDoc = await PDFDocument.create();

      helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

      form = null;

      if (

        templatePdfDoc &&

        typeof templatePdfDoc.getPageCount === 'function' &&

        templatePdfDoc.getPageCount() > 0

      ) {

        try {

          const [copiedPage] = await pdfDoc.copyPages(templatePdfDoc, [0]);

          dailyReportHeaderPage = copiedPage;

          pdfDoc.addPage(copiedPage);

        } catch (err) {

          console.warn(`[server] Unable to reuse template header for daily report: ${err.message}`);

        }

      }

    }



    // Persist project card by LSC Project number

    if (projectKey) {

      projectsStore = projectsStore || {};

      const existingCard = projectsStore[projectKey] && typeof projectsStore[projectKey] === 'object'

        ? projectsStore[projectKey]

        : {};

      const siteInfoCard = { ...existingCard };

      const assignIfValue = (key, value) => {
        if (value !== undefined && value !== null && String(value).trim() !== '') {
          siteInfoCard[key] = value;
        }
      };
      assignIfValue('end_customer_name', toSingleValue(req.body?.end_customer_name));

      assignIfValue('site_location', toSingleValue(req.body?.site_location));

      assignIfValue('led_display_model', toSingleValue(req.body?.led_display_model));
      assignIfValue('batch_number', toSingleValue(req.body?.batch_number));
      assignIfValue('lsc_project_name', resolveProjectName(req.body));
      assignIfValue('date_of_service', toSingleValue(req.body?.date_of_service));
      assignIfValue('service_company_name', toSingleValue(req.body?.service_company_name));
      assignIfValue('supplier_name', toSingleValue(req.body?.supplier_name));
      assignIfValue('customer_company', toSingleValue(req.body?.customer_company));
      assignIfValue('customer_representative', toSingleValue(req.body?.customer_representative));
      assignIfValue('completion_date', toSingleValue(req.body?.completion_date));
      assignIfValue('acceptance_location', toSingleValue(req.body?.acceptance_location));
      assignIfValue('acceptance_date', toSingleValue(req.body?.acceptance_date));
      assignIfValue('attendee_client', toSingleValue(req.body?.attendee_client));
      assignIfValue('attendee_supplier', toSingleValue(req.body?.attendee_supplier));
      siteInfoCard.lsc_project_number = projectKey;

      siteInfoCard.form_type = templateType;

      siteInfoCard.updated_at = new Date().toISOString();

      projectsStore[projectKey] = siteInfoCard;

      saveProjectsStore(projectsStore);

    }



    if (form) {

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

            if (/signature/i.test(descriptor.acroName) && signatureData && signatureData.startsWith('data:image/') && !isBlankSignatureImage(signatureData)) {

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

    }



    let imagePlacements = [];

    let signaturePlacements = [];

    const signatureSlots = [];

    if (isDailyReport) {

      signaturePlacements = await drawDailyReportPage(

        pdfDoc,

        helveticaFont,

        dailyReportData,

        {

          pageSize: templatePageSize,

          overflowTextEntries,

          targetPage: dailyReportHeaderPage,

          bodyTopOffset:

            submissionTemplateEntry && Number.isFinite(submissionTemplateEntry.bodyTopOffset)

              ? submissionTemplateEntry.bodyTopOffset

              : null,

          // No signature boxes on a daily report — it's a one-way status update
          // (iOS issue #1 note 394), so nothing signature-related is passed in.

        },

      );

      imagePlacements = await embedUploadedImages(pdfDoc, null, photoFiles, {

        projectNumber: resolveProjectNumber(sanitizedBody)
          || (dailyReportData && dailyReportData.projectNumber)
          || '',

      });

      if (overflowTextEntries.length) {

        overflowPlacements = appendOverflowPages(pdfDoc, helveticaFont, overflowTextEntries);

      }

    } else {

      if (form) {

        form.flatten();

      }

      if (overflowTextEntries.length) {

        overflowPlacements = appendOverflowPages(pdfDoc, helveticaFont, overflowTextEntries);

      }

      hiddenPartRows = partsRowUsage.filter((row) => !row.hasData).map((row) => row.number);

      partsRowsRendered = partsRowUsage.filter((row) => row.hasData).map((row) => row.number);

      const clearedSignoff = clearOriginalSignoffSection(pdfDoc, {

        bodyTopOffset:

          submissionTemplateEntry && Number.isFinite(submissionTemplateEntry.bodyTopOffset)

            ? submissionTemplateEntry.bodyTopOffset

            : null,

      });

      signaturePlacements = await drawSignOffPage(

        pdfDoc,

        helveticaFont,

        sanitizedBody,

        signatureImages,

        partsRowUsage,

        {

          targetPage: clearedSignoff ? clearedSignoff.page : undefined,

          startY: clearedSignoff && Number.isFinite(clearedSignoff.startY) ? clearedSignoff.startY : undefined,

          employees: employeeSummary,

          signatureSlots,

        },

      );

      // Appended last, once the report itself is complete.
      imagePlacements = await embedUploadedImages(pdfDoc, form, photoFiles, {

        projectNumber: resolveProjectNumber(sanitizedBody)
          || (dailyReportData && dailyReportData.projectNumber)
          || '',

      });

    }



    addPageNumbers(pdfDoc, helveticaFont);



    const pages = pdfDoc.getPages();

    if (pages.length) {

      const footerPage = pages[pages.length - 1];

      const submittedAt = formatIsoFromDate(new Date());

      const submitterName = detectSubmitterName(req.body || {});

      const footerText = `Submitted by ${submitterName} at ${formatDisplayDate(submittedAt)}`;

      footerPage.drawText(footerText, {

        x: 36,

        y: 24,

        size: 10,

        font: helveticaFont,

        color: rgb(0.2, 0.2, 0.2),

      });

    }



    // Stamp who generated this file into the PDF's own metadata. Invisible on the printed
    // page, readable in any file inspector - so a document that has travelled away from the
    // archive still says which client and which build produced it.
    try {
      const via = String(toSingleValue(req.body?.submitted_via) || SUBMITTED_VIA_WEB).trim();
      const clientVersion = String(toSingleValue(req.body?.client_version) || SERVICE2_CLIENT_VERSION).trim();
      pdfDoc.setCreator(`LSC LED Doc ${via} ${clientVersion}`.trim());
      pdfDoc.setProducer(`LinArt service2 ${SERVICE2_CLIENT_VERSION}`);
    } catch (err) {
      // Metadata is a nice-to-have; never fail a submission over it.
      console.warn(`[server] Unable to stamp PDF metadata: ${err.message}`);
    }

    const pdfOutput = await pdfDoc.save();

    // Read the document back and check that what was typed is on it. Logged, never fatal:
    // the submission is already valid, and a report we cannot verify is still worth more
    // than a rejected one.
    const unrenderedFields = findUnrenderedFields(sanitizedBody, pdfOutput);

    if (unrenderedFields.length) {

      console.warn(
        `[server] Submitted but not printed: ${unrenderedFields.join(', ')}`
        + ` (type=${templateType}, via=${toSingleValue(req.body?.submitted_via) || 'web'}`
        + ` ${toSingleValue(req.body?.client_version) || '?'})`,
      );

    }



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

    const safeTemplateType = sanitizeFilename(templateType || 'service_report');

    const outputBaseDir = path.join(OUTPUT_DIR, safeTemplateType);

    const outputPdfDir = path.join(outputBaseDir, 'pdf');

    const outputMetaDir = path.join(outputBaseDir, 'meta');

    fsExtra.ensureDirSync(outputPdfDir);

    fsExtra.ensureDirSync(outputMetaDir);

    const dailyReportParts = isDailyReport && dailyReportData

      ? {

          project: cleanForFilename(dailyReportData.projectNumber) || 'project',

          date: cleanForFilename(dailyReportData.reportDate) || 'date',

          submitter: cleanForFilename(dailyReportData.submitterName) || 'name',

        }

      : null;

    const dailyStorageDir = dailyReportParts

      ? path.join(outputBaseDir, dailyReportParts.project, dailyReportParts.date)

      : null;

    if (dailyStorageDir) {

      fsExtra.ensureDirSync(dailyStorageDir);

    }



    const customerPart = customerName ? `${cleanForFilename(customerName)}-` : '';

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    const dailyBaseFilename = dailyReportParts

      ? [dailyReportParts.project, dailyReportParts.date, dailyReportParts.submitter].filter(Boolean).join('_')

      : '';

    const baseFilename = dailyBaseFilename || `filled-${customerPart}${timestamp}`;

    const pickUniqueFilename = (base, ext, dirs) => {

      let candidate = `${base}${ext}`;

      let counter = 1;

      while (dirs.some((dir) => fs.existsSync(path.join(dir, candidate)))) {

        candidate = `${base}-${counter}${ext}`;

        counter += 1;

      }

      return candidate;

    };

    const outputDirs = dailyStorageDir ? [outputPdfDir, dailyStorageDir] : [outputPdfDir];

    const filename = pickUniqueFilename(baseFilename, '.pdf', outputDirs);

    const outputPath = path.join(outputPdfDir, filename);

    await fs.promises.writeFile(outputPath, pdfOutput);

    const dailyStoragePath = dailyStorageDir ? path.join(dailyStorageDir, filename) : null;

    if (dailyStoragePath && dailyStoragePath !== outputPath) {

      await fs.promises.writeFile(dailyStoragePath, pdfOutput);

    }



    const metadata = {

      templatePath: submissionTemplatePath,

      templateId: submissionTemplateEntry.id,

      templateSlug: submissionTemplateEntry.slug,

      templateLabel: submissionTemplateEntry.label,

      templateType,

      createdAt: new Date().toISOString(),

      filename,

      outputDir: outputPdfDir,

      requestBody: sanitizedBody,

      fieldsUsed: fieldDescriptors.map((f) => ({ acroName: f.acroName, requestName: f.requestName, type: f.type })),

      files: photoFiles.map((file) => ({

        originalname: sanitizeFilename(file.originalname),

        mimetype: file.mimetype,

        size: file.size,

        fieldname: file.fieldname,

      })),

      totalPhotoBytes,

      imagePlacements,

      signaturePlacements,

      signatureSlots,

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

      partsDebug: (partsRowUsage || []).map((row) => ({

        number: row.number,

        hasData: row.hasData,

        fields: row.fields,

      })),

      employees: employeeSummary.entries.map((entry) => ({

        index: entry.index,

        name: entry.name,

        role: entry.role,

        arrival: entry.arrival,

        departure: entry.departure,

        durationMinutes: entry.durationMinutes,

        breakCode: entry.breakCode,

        breakRequiredMinutes: entry.breakRequiredMinutes,

        breakLabel: entry.breakLabel,

      })),

      employeesTotalMinutes: employeeSummary.totalMinutes,

      employeesTotalHours: Number((employeeSummary.totalMinutes / 60).toFixed(2)),

      employeesRequiredBreakMinutes: employeeSummary.totalBreakMinutes,

      employeesRequiredBreakDuration: formatEmployeeDuration(employeeSummary.totalBreakMinutes),

      employeesBreakStats: employeeSummary.breakStats,

      employeesBreakSummary: formatBreakStatsSummary(employeeSummary.breakStats),

    };

    if (dailyStoragePath) {

      metadata.dailyReportPath = dailyStoragePath;

      metadata.dailyReportDir = dailyStorageDir;

    }

    if (dailyReportData) {

      metadata.dailyReport = dailyReportData;

    }

    // F: persist signature images so "edit past report" can restore them
    // (requestBody redacts them to [embedded-image]).
    if (signatureImages.length) {
      const signaturesDir = path.join(path.dirname(outputMetaDir), 'signatures');
      const pdfBase = filename.replace(/\.pdf$/i, '');
      const signatureFiles = {};
      for (const sig of signatureImages) {
        try {
          const decoded = decodeImageDataUrl(sig.data);
          if (!decoded) continue;
          const ext = decoded.mimeType === 'image/png' ? 'png' : 'jpg';
          const sigFilename = `${pdfBase}.${sig.acroName}.${ext}`;
          await fs.promises.mkdir(signaturesDir, { recursive: true });
          await fs.promises.writeFile(path.join(signaturesDir, sigFilename), decoded.buffer);
          signatureFiles[sig.acroName] = sigFilename;
        } catch (err) {
          console.warn(`[server] failed to persist signature ${sig.acroName}: ${err.message}`);
        }
      }
      if (Object.keys(signatureFiles).length) metadata.signatureFiles = signatureFiles;
    }

    // Persist uploaded photos to disk, keyed by multipart field name. They are
    // embedded into the PDF and otherwise dropped, so this lets the apps fetch the
    // originals back (with per-field attribution) instead of scraping the PDF.
    if (photoFiles.length) {
      const photosBaseDir = path.join(path.dirname(outputMetaDir), 'photos');
      const pdfBase = filename.replace(/\.pdf$/i, '');
      const photoDir = path.join(photosBaseDir, pdfBase);
      const photoManifest = [];
      const perFieldIndex = {};
      for (const pf of photoFiles) {
        try {
          if (!pf || !pf.buffer || !Buffer.isBuffer(pf.buffer)) continue;
          const field = String(pf.fieldname || 'photo').replace(/[^a-zA-Z0-9_]/g, '_') || 'photo';
          const mime = String(pf.mimetype || 'image/jpeg').toLowerCase();
          const ext = mime.includes('png') ? 'png' : (mime.includes('webp') ? 'webp' : (mime.includes('heic') ? 'heic' : 'jpg'));
          const idx = (perFieldIndex[field] = (perFieldIndex[field] || 0) + 1) - 1;
          // sanitizeFilename is idempotent + collapses "__"â†’"_"; store the sanitized
          // name so the serving route (which re-sanitizes :name) resolves the same file.
          const photoFilename = sanitizeFilename(`${field}_${idx}.${ext}`);
          await fs.promises.mkdir(photoDir, { recursive: true });
          await fs.promises.writeFile(path.join(photoDir, photoFilename), pf.buffer);
          photoManifest.push({ field, file: photoFilename, mime, size: pf.buffer.length, name: pf.originalname || null });
        } catch (err) {
          console.warn(`[server] failed to persist photo ${pf && pf.fieldname}: ${err.message}`);
        }
      }
      if (photoManifest.length) metadata.photoFiles = photoManifest;
    }

    // F: an edit keeps the review trail of the report it replaces.
    if (editingPrevious && editingPrevious.filename) {
      try {
        const prevMetaPath = buildMetaPath(editingPrevious.type || templateType, editingPrevious.filename);
        if (prevMetaPath && fs.existsSync(prevMetaPath)) {
          const prevMeta = JSON.parse(await fs.promises.readFile(prevMetaPath, 'utf8'));
          const history = Array.isArray(prevMeta.reviewHistory) ? prevMeta.reviewHistory : [];
          history.push({
            action: 'edited',
            status: 'submitted',
            previous: normalizeReportStatus(prevMeta.status),
            at: new Date().toISOString(),
            by: req.headers['x-hub-user'] || toSingleValue(req.body?.owner_user_id) || null,
            replacedFilename: editingPrevious.filename,
          });
          metadata.reviewHistory = history;
          metadata.status = 'submitted';
        }
      } catch (err) {
        console.warn('[server] failed to carry review history on edit', err.message);
      }
    }

    const metadataFilename = filename.replace(/\.pdf$/i, '.json');

    await fs.promises.writeFile(

      path.join(outputMetaDir, metadataFilename),

      JSON.stringify(metadata, null, 2),

      'utf8'

    );



    recordSuggestionsFromSubmission(req.body || {});

    recordPeople(req.body || {});



    const baseHost =

      (HOST_URL_ENV && HOST_URL_ENV.trim()) ||

      '';

    const downloadPath = `download/${encodeURIComponent(safeTemplateType)}/${encodeURIComponent(filename)}`;

    const downloadUrl = baseHost

      ? `${baseHost.replace(/\/$/, '')}/${downloadPath}`

      : downloadPath;



    const successPayload = {

      ok: true,

      filename,

      type: templateType,

      duplicate: false,

      url: downloadUrl,

      templateId: submissionTemplateEntry.id,

      templateSlug: submissionTemplateEntry.slug,

      templateLabel: submissionTemplateEntry.label,

      templateType,

      overflowCount: overflowTextEntries.length,

      partsRowsHidden: hiddenPartRows,

      partsRowsRendered,

      employees: employeeSummary.entries.map((entry) => ({

        index: entry.index,

        name: entry.name,

        role: entry.role,

        arrival: entry.arrival,

        departure: entry.departure,

        durationMinutes: entry.durationMinutes,

        breakCode: entry.breakCode,

        breakRequiredMinutes: entry.breakRequiredMinutes,

        breakLabel: entry.breakLabel,

      })),

      employeesTotalMinutes: employeeSummary.totalMinutes,

      employeesTotalHours: Number((employeeSummary.totalMinutes / 60).toFixed(2)),

      employeesRequiredBreakMinutes: employeeSummary.totalBreakMinutes,

      employeesRequiredBreakDuration: formatEmployeeDuration(employeeSummary.totalBreakMinutes),

      employeesBreakStats: employeeSummary.breakStats,

      employeesBreakSummary: formatBreakStatsSummary(employeeSummary.breakStats),

    };

    // F: edit replaces the previous revision â€” remove its pdf/meta/signatures.
    if (editingPrevious && editingPrevious.filename) {
      successPayload.edited = true;
      if (editingPrevious.filename !== filename) {
        successPayload.replacedFilename = editingPrevious.filename;
        try {
          const prevType = editingPrevious.type || templateType;
          const prevPdf = buildPdfPath(prevType, editingPrevious.filename);
          const prevMeta = buildMetaPath(prevType, editingPrevious.filename);
          if (prevPdf && fs.existsSync(prevPdf)) await fs.promises.unlink(prevPdf);
          if (prevMeta && fs.existsSync(prevMeta)) await fs.promises.unlink(prevMeta);
          const prevSigDir = path.join(OUTPUT_DIR, sanitizeFilename(prevType), 'signatures');
          const prevBase = editingPrevious.filename.replace(/\.pdf$/i, '');
          if (fs.existsSync(prevSigDir)) {
            for (const f of await fs.promises.readdir(prevSigDir)) {
              if (f.startsWith(`${prevBase}.`)) {
                try { await fs.promises.unlink(path.join(prevSigDir, f)); } catch (e) { /* noop */ }
              }
            }
          }
        } catch (err) {
          console.warn('[server] failed to remove replaced revision', err.message);
        }
      }
    }

    if (clientReportId) {

      rememberSubmission(clientReportId, successPayload);

    }

    return res.json(successPayload);

  } catch (err) {

    console.error('[server] Failed to process submission', err);

    const statusCandidate =

      err && Object.prototype.hasOwnProperty.call(err, 'statusCode')

        ? err.statusCode

        : err && Object.prototype.hasOwnProperty.call(err, 'status')

          ? err.status

          : undefined;

    const statusNumber = Number(statusCandidate);

    const status = Number.isFinite(statusNumber) ? statusNumber : 500;

    return res

      .status(status >= 400 && status < 600 ? status : 500)

      .json({ ok: false, error: err && err.message ? err.message : 'Unexpected error' });

  }

});



app.get('/download/:type/:file', async (req, res) => {

  const requestedType = sanitizeFilename(req.params.type);

  const requestedFile = sanitizeFilename(req.params.file);

  const baseDir = path.join(OUTPUT_DIR, requestedType, 'pdf');

  const filePath = path.join(baseDir, requestedFile);

  if (!filePath.startsWith(baseDir)) {

    return res.status(400).json({ ok: false, error: 'Invalid file path.' });

  }

  if (!fs.existsSync(filePath)) {

    return res.status(404).json({ ok: false, error: 'File not found.' });

  }

  res.download(filePath, requestedFile);

});

// This route can be called directly from public interface if we are not authenticated. 
// But since we want to restrict link generation, we should protect it too!
app.post(['/api/sign/create', '/service2/api/sign/create'], requireGenerateLinks, async (req, res) => {
  try {
    const type = sanitizeFilename(req.body && req.body.type);
    const file = sanitizeFilename(req.body && req.body.file);
    if (!type || !file) {
      return res.status(400).json({ ok: false, error: 'Missing type or file.' });
    }
    const sourcePdfPath = path.join(OUTPUT_DIR, type, 'pdf', file);
    if (!fs.existsSync(sourcePdfPath)) {
      return res.status(404).json({ ok: false, error: 'Source PDF not found.' });
    }
    if (!SIGN_SERVICE_URL || !SIGN_INTERNAL_TOKEN) {
      return res.status(500).json({ ok: false, error: 'Signing service not configured.' });
    }

    fsExtra.ensureDirSync(SIGN_INBOX_DIR);
    const inboxFile = `${Date.now()}_${file}`;
    const inboxPath = path.join(SIGN_INBOX_DIR, inboxFile);
    fsExtra.copySync(sourcePdfPath, inboxPath);

    // Dynamic import for node-fetch if using Node < 18, else use global fetch
    const response = await fetch(`${SIGN_SERVICE_URL}/internal/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': SIGN_INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        storedPath: `inbox/${inboxFile}`,
        originalName: file,
        reportType: type,
        reportFile: file,
        expiresInDays: Number(req.body && req.body.expiresInDays) || 7
      })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data && data.error ? data.error : 'Failed to create sign job');
    }

    return res.json({
      ok: true,
      url: data.url,
      pin: data.pin,
      expiresAt: data.expiresAt
    });
  } catch (err) {
    console.error('[server] sign job error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Internal error' });
  }
});

// Internal callback auth (service-sign -> service2), shared SIGN_INTERNAL_TOKEN.
function requireInternalToken(req, res, next) {
  const token = String(req.headers['x-internal-token'] || '');
  if (!SIGN_INTERNAL_TOKEN || token !== SIGN_INTERNAL_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return next();
}

// Remote-sign completion: the sign service posts the customer's signature here.
// We draw it into the report's customer_signature box on the EXISTING PDF (no
// re-render, so photos/layout are preserved), persist a *_remote-signed.pdf copy
// alongside the original in the Files store, persist the signature image, and copy
// the meta with remoteSigned flags + signatureFiles (so later edits keep it).
app.post('/internal/sign-completed', requireInternalToken, async (req, res) => {
  try {
    const type = sanitizeFilename(req.body && req.body.reportType);
    const file = sanitizeFilename(req.body && req.body.reportFile);
    const signatureDataUrl = req.body && req.body.signatureDataUrl;
    const signedAt = (req.body && typeof req.body.signedAt === 'string' && req.body.signedAt) || new Date().toISOString();
    if (!type || !file) return res.status(400).json({ ok: false, error: 'missing reportType/reportFile' });
    if (typeof signatureDataUrl !== 'string' || !signatureDataUrl.startsWith('data:image/')) {
      return res.status(400).json({ ok: false, error: 'signatureDataUrl required' });
    }
    const pdfPath = buildPdfPath(type, file);
    const metaPath = buildMetaPath(type, file);
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ ok: false, error: 'report_not_found' });
    const decoded = decodeImageDataUrl(signatureDataUrl);
    if (!decoded) return res.status(400).json({ ok: false, error: 'bad_signature' });

    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { meta = {}; }
    const slots = Array.isArray(meta.signatureSlots) ? meta.signatureSlots : [];
    const slot = slots.find((s) => s && /customer/i.test(String(s.acroName || '')));

    const srcBytes = await fs.promises.readFile(pdfPath);
    const pdfDoc = await PDFDocument.load(srcBytes);
    const pages = pdfDoc.getPages();
    const image = decoded.mimeType === 'image/png'
      ? await pdfDoc.embedPng(decoded.buffer)
      : await pdfDoc.embedJpg(decoded.buffer);

    let placement = 'appendix';
    if (slot && Number.isFinite(slot.page) && slot.page >= 1 && slot.page <= pages.length
        && Number.isFinite(slot.x) && Number.isFinite(slot.y) && slot.width > 0 && slot.height > 0) {
      const page = pages[slot.page - 1];
      const availW = slot.width - 12;
      const availH = slot.height - 12;
      const scale = Math.min(availW / image.width, availH / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      page.drawImage(image, { x: slot.x + 6 + (availW - w) / 2, y: slot.y + 6 + (availH - h) / 2, width: w, height: h });
      placement = 'customer_box';
    } else {
      // Old reports have no recorded slot geometry â€” fall back to an appendix page.
      const baseSize = pages.length ? pages[0].getSize() : { width: 595, height: 842 };
      const page = pdfDoc.addPage([baseSize.width, baseSize.height]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      page.drawText('Customer signature (remote)', { x: 48, y: baseSize.height - 80, size: 18, font, color: rgb(0.1, 0.1, 0.1) });
      const scale = Math.min((baseSize.width - 120) / image.width, 200 / image.height);
      page.drawImage(image, { x: 48, y: baseSize.height - 300, width: image.width * scale, height: image.height * scale });
      page.drawText(`Signed at: ${signedAt}`, { x: 48, y: baseSize.height - 320, size: 12, font, color: rgb(0.25, 0.25, 0.25) });
    }

    const signedBytes = await pdfDoc.save();
    const base = file.replace(/\.pdf$/i, '');
    const signedFile = `${base}_remote-signed.pdf`;
    const signedPdfPath = buildPdfPath(type, signedFile);
    fsExtra.ensureDirSync(path.dirname(signedPdfPath));
    await fs.promises.writeFile(signedPdfPath, signedBytes);

    // Persist the signature image so an edit-after-remote-sign keeps it.
    const sigDir = path.join(OUTPUT_DIR, type, 'signatures');
    fsExtra.ensureDirSync(sigDir);
    const sigExt = decoded.mimeType === 'image/png' ? 'png' : 'jpg';
    const sigFilename = `${signedFile.replace(/\.pdf$/i, '')}.customer_signature.${sigExt}`;
    await fs.promises.writeFile(path.join(sigDir, sigFilename), decoded.buffer);

    const newMeta = { ...meta };
    newMeta.filename = signedFile;
    newMeta.remoteSigned = true;
    newMeta.remoteSignedAt = signedAt;
    newMeta.remoteSignPlacement = placement;
    newMeta.signatureFiles = Object.assign({}, meta.signatureFiles || {}, { customer_signature: sigFilename });
    const newMetaPath = buildMetaPath(type, signedFile);
    fsExtra.ensureDirSync(path.dirname(newMetaPath));
    await fs.promises.writeFile(newMetaPath, JSON.stringify(newMeta, null, 2));

    return res.json({
      ok: true, type, file: signedFile, placement,
      url: `/api/files/${encodeURIComponent(type)}/${encodeURIComponent(signedFile)}`,
      // When the signature landed in the customer box, hand the canonical PDF back to
      // the sign service so the signer downloads the box-placed copy (not a separate
      // appendix page). Only sent on box placement to keep the payload small.
      signedPdfBase64: placement === 'customer_box' ? Buffer.from(signedBytes).toString('base64') : undefined,
    });
  } catch (err) {
    console.error('[server] /internal/sign-completed failed', err);
    return res.status(500).json({ ok: false, error: 'sign_completed_failed' });
  }
});



app.get('/download/:type', (req, res, next) => {
  const requestedType = normalizeQueryText(req.params.type);
  if (!requestedType) return next();
  const typeDir = path.join(OUTPUT_DIR, requestedType);
  try {
    if (!fs.existsSync(typeDir)) return next();
    const stats = fs.statSync(typeDir);
    if (!stats.isDirectory()) return next();
  } catch (err) {
    return next();
  }
  return res.redirect(`/files?type=${encodeURIComponent(requestedType)}`);
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

    if (err.code === 'LIMIT_FILE_SIZE') {

      return res.status(400).json({

        ok: false,

        error:

          'One of the uploaded images exceeds the ' +

          formatBytesHuman(MAX_FILE_SIZE_BYTES) +

          ' per-file limit. Please compress or resize the photo and try again.',

      });

    }

    if (err.code === 'LIMIT_FILE_COUNT') {

      return res.status(400).json({

        ok: false,

        error: 'Too many images were uploaded in a single request. Please remove a few and retry.',

      });

    }

    return res.status(400).json({ ok: false, error: err.message });

  }

  if (err && err.statusCode) {

    return res

      .status(err.statusCode)

      .json({ ok: false, error: err.message || 'Request failed.' });

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

  // Trash retention sweep: once shortly after boot, then daily. Purges soft-deleted
  // reports past their expiresAt. unref() so the timer never keeps the process alive.
  const runSweep = () => { sweepTrash().catch((err) => console.warn('[server] trash sweep failed:', err && err.message)); };
  setTimeout(runSweep, 60 * 1000).unref();
  setInterval(runSweep, 24 * 60 * 60 * 1000).unref();

  // One-shot, off the boot path so a large archive never delays listening.
  setTimeout(() => {
    backfillBlankSignatures().catch((err) => console.warn('[server] signature backfill failed:', err && err.message));
  }, 15 * 1000).unref();

  return server;

}



if (require.main === module) {

  start();

}



module.exports = { app, start, fieldDescriptors, templatePath, collectEmployeeEntries };
