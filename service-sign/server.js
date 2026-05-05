#!/usr/bin/env node

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 3002;
const SIGN_SHARED_DIR = process.env.SIGN_SHARED_DIR || path.join(__dirname, 'sign');
const SIGN_ROOT = path.resolve(SIGN_SHARED_DIR);
const INBOX_DIR = path.join(SIGN_ROOT, 'inbox');
const SIGNED_DIR = path.join(SIGN_ROOT, 'signed');
const DB_PATH = process.env.SIGN_DB_PATH || path.join(SIGN_ROOT, 'sign.db');
const PUBLIC_SIGN_BASE_URL = String(process.env.PUBLIC_SIGN_BASE_URL || '').replace(/\/$/, '');
const INTERNAL_TOKEN = String(process.env.SIGN_INTERNAL_TOKEN || '').trim();
const DEFAULT_TTL_DAYS = Number(process.env.SIGN_TTL_DAYS || '7');
const BASE_PATH = String(process.env.BASE_PATH || '').replace(/\/$/, '');

const MAX_COMMENT_LENGTH = 2000;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

ensureDir(SIGN_ROOT);
ensureDir(INBOX_DIR);
ensureDir(SIGNED_DIR);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sign_jobs (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    pin_hash TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,
    source_path TEXT NOT NULL,
    original_name TEXT,
    signed_path TEXT,
    comment TEXT,
    signed_at TEXT,
    audit_ip TEXT,
    audit_ua TEXT,
    download_count INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sign_jobs_token_hash ON sign_jobs (token_hash);
  CREATE INDEX IF NOT EXISTS idx_sign_jobs_status ON sign_jobs (status);
`);

// Migration: add pin_hash column if missing
try {
  db.exec(`ALTER TABLE sign_jobs ADD COLUMN pin_hash TEXT`);
} catch (_e) { /* column already exists */ }

const stmtInsertJob = db.prepare(`
  INSERT INTO sign_jobs (
    id, token_hash, pin_hash, created_at, expires_at, status, source_path, original_name
  ) VALUES (
    @id, @token_hash, @pin_hash, @created_at, @expires_at, @status, @source_path, @original_name
  )
`);
const stmtFindByToken = db.prepare(`SELECT * FROM sign_jobs WHERE token_hash = ? LIMIT 1`);
const stmtUpdateStatus = db.prepare(`
  UPDATE sign_jobs
  SET status = @status, signed_at = @signed_at, signed_path = @signed_path, comment = @comment,
      audit_ip = @audit_ip, audit_ua = @audit_ua
  WHERE id = @id
`);
const stmtIncrementDownload = db.prepare(
  `UPDATE sign_jobs SET download_count = download_count + 1 WHERE id = ?`,
);

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generatePin() {
  return String(crypto.randomInt(100000, 999999));
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function sanitizeRelativePath(input) {
  const normalized = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) return null;
  return normalized;
}

function absoluteSharedPath(relativePath) {
  const safe = sanitizeRelativePath(relativePath);
  if (!safe) return null;
  const absolutePath = path.resolve(SIGN_ROOT, safe);
  const rootPrefix = SIGN_ROOT.endsWith(path.sep) ? SIGN_ROOT : SIGN_ROOT + path.sep;
  if (!absolutePath.startsWith(rootPrefix)) return null;
  return absolutePath;
}

function buildPublicUrl(pathname) {
  if (PUBLIC_SIGN_BASE_URL) {
    return `${PUBLIC_SIGN_BASE_URL}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
  }
  return pathname;
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function isExpired(job) {
  const expiresAt = parseDate(job.expires_at);
  if (!expiresAt) return false;
  return Date.now() > expiresAt.getTime();
}

function markExpired(job) {
  if (!job || job.status !== 'pending') return job;
  db.prepare(`UPDATE sign_jobs SET status = 'expired' WHERE id = ?`).run(job.id);
  return { ...job, status: 'expired' };
}

function getJobByToken(token) {
  if (!token) return null;
  const job = stmtFindByToken.get(hashToken(token));
  if (!job) return null;
  if (isExpired(job)) {
    return markExpired(job);
  }
  return job;
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || 'unknown';
  const entry = rateLimit.state.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  rateLimit.state.set(key, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
    return res.status(429).send('Too many requests. Please try again soon.');
  }
  return next();
}
rateLimit.state = new Map();

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapText(text, font, fontSize, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    const width = font.widthOfTextAtSize(candidate, fontSize);
    if (width <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "style-src": ["'self'"],
        "script-src": ["'self'"],
        "frame-src": ["'self'"],
      },
    },
  }),
);

app.use('/assets', express.static(path.join(__dirname, 'public'), { fallthrough: false }));
app.use(express.json({ limit: '5mb' }));

function renderLayout({ title, token, body }) {
  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)}</title>
      <link rel="stylesheet" href="${BASE_PATH}/assets/sign.css" />
    </head>
    <body data-token="${escapeHtml(token || '')}" data-base-path="${escapeHtml(BASE_PATH)}">
      <div class="page">
        ${body}
      </div>
      <script src="${BASE_PATH}/assets/sign.js"></script>
    </body>
  </html>`;
}

function renderPendingPage(token, job) {
  const expiresAt = parseDate(job.expires_at);
  const expiresText = expiresAt ? expiresAt.toISOString() : 'unknown';
  const badge = job.original_name ? `<span class="badge">${escapeHtml(job.original_name)}</span>` : '';
  return renderLayout({
    title: 'Sign document',
    token,
    body: `
      <section class="hero">
        <div>
          <h1>Review and sign</h1>
          <p>Please review the document and add your signature below.</p>
          <div class="meta">
            ${badge}
            <span>Expires: ${escapeHtml(expiresText)}</span>
          </div>
        </div>
      </section>
      <div class="grid">
        <section class="card">
          <h2>Document preview</h2>
          <div class="pdf-frame">
            <iframe src="${BASE_PATH}/s/${encodeURIComponent(token)}/pdf" title="Document preview"></iframe>
          </div>
          <div class="footer">
            <a class="btn-link" href="${BASE_PATH}/s/${encodeURIComponent(token)}/pdf" target="_blank" rel="noopener">Open PDF in new tab</a>
          </div>
        </section>
        <section class="card">
          <h2>Your signature</h2>
          <div class="signature-box">
            <canvas data-signature-canvas aria-label="Signature pad"></canvas>
          </div>
          <div class="signature-actions">
            <button class="btn btn-secondary" type="button" data-clear>Clear</button>
            <button class="btn btn-primary" type="button" data-submit>Sign and download</button>
          </div>
          <div class="status" data-status></div>
          <h2 class="section-gap">Comment (optional)</h2>
          <textarea data-comment placeholder="Add a note for the sender (optional)"></textarea>
          <div class="status" data-download hidden>
            <a class="btn btn-primary" data-download-link href="#">Download signed PDF</a>
          </div>
        </section>
      </div>
    `,
  });
}

function renderSignedPage(token, job) {
  const signedAt = parseDate(job.signed_at);
  const signedText = signedAt ? signedAt.toISOString() : 'unknown';
  return renderLayout({
    title: 'Document signed',
    token,
    body: `
      <section class="hero">
        <div>
          <h1>Document signed</h1>
          <p>Thank you. Your signature has been recorded.</p>
          <div class="meta">
            <span class="badge">Signed</span>
            <span>Signed at: ${escapeHtml(signedText)}</span>
          </div>
        </div>
      </section>
      <section class="card">
        <h2>Download</h2>
        <p>You can download the signed PDF below.</p>
        <a class="btn btn-primary" href="${BASE_PATH}/s/${encodeURIComponent(token)}/download">Download signed PDF</a>
      </section>
    `,
  });
}

function renderExpiredPage() {
  return renderLayout({
    title: 'Link expired',
    token: '',
    body: `
      <section class="card">
        <h2>Link expired</h2>
        <p>This signing link has expired. Please contact the sender for a new link.</p>
      </section>
    `,
  });
}

function renderNotFoundPage() {
  return renderLayout({
    title: 'Link not found',
    token: '',
    body: `
      <section class="card">
        <h2>Link not found</h2>
        <p>The signing link is invalid or has been removed.</p>
      </section>
    `,
  });
}

function requireInternal(req, res, next) {
  if (!INTERNAL_TOKEN) {
    return res.status(500).json({ ok: false, error: 'Internal token not configured.' });
  }
  const token = String(req.headers['x-internal-token'] || '').trim();
  if (!token || token !== INTERNAL_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }
  return next();
}

app.get('/health', (req, res) => {
  return res.json({ ok: true });
});

app.post('/internal/jobs', requireInternal, (req, res) => {
  const storedPath = sanitizeRelativePath(req.body && req.body.storedPath);
  const originalName = req.body && typeof req.body.originalName === 'string' ? req.body.originalName.trim() : '';
  const ttlDaysRaw = Number(req.body && req.body.expiresInDays);
  let ttlDays = Number.isFinite(ttlDaysRaw) ? ttlDaysRaw : DEFAULT_TTL_DAYS || 7;
  ttlDays = Math.min(Math.max(ttlDays, 1), 7);

  if (!storedPath) {
    return res.status(400).json({ ok: false, error: 'storedPath is required.' });
  }
  if (!storedPath.toLowerCase().endsWith('.pdf')) {
    return res.status(400).json({ ok: false, error: 'storedPath must point to a PDF.' });
  }

  const absolutePath = absoluteSharedPath(storedPath);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return res.status(400).json({ ok: false, error: 'Stored file not found.' });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const pin = generatePin();
  const pinH = hashPin(pin);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  const jobId = `sj_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  stmtInsertJob.run({
    id: jobId,
    token_hash: tokenHash,
    pin_hash: pinH,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: 'pending',
    source_path: storedPath,
    original_name: originalName || null,
  });

  return res.json({
    ok: true,
    jobId,
    token,
    pin,
    expiresAt: expiresAt.toISOString(),
    url: buildPublicUrl(`/s/${token}`),
  });
});

function isPinVerified(req, job) {
  if (!job.pin_hash) return true;
  const cookie = req.cookies ? req.cookies[`sign_pin_${job.id}`] : null;
  if (!cookie) return false;
  return cookie === job.pin_hash;
}

function renderPinPage(token, job) {
  return renderLayout({
    title: 'Enter PIN',
    token,
    body: `
      <section class="card pin-card">
        <h2>🔒 PIN Required</h2>
        <p>Please enter the 6-digit PIN code that was provided to you.</p>
        <form class="pin-form" method="POST" action="${BASE_PATH}/s/${encodeURIComponent(token)}/verify-pin">
          <input type="text" name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6"
                 placeholder="• • • • • •" class="pin-input"
                 autocomplete="off" autofocus required />
          <button type="submit" class="btn btn-primary">Verify</button>
        </form>
        <div class="status" data-pin-status></div>
      </section>
    `,
  });
}

app.use(cookieParser());

app.get('/s/:token', rateLimit, (req, res) => {
  const token = req.params.token;
  const job = getJobByToken(token);
  noStore(res);

  if (!job) {
    return res.status(404).send(renderNotFoundPage());
  }
  if (job.status === 'expired') {
    return res.status(410).send(renderExpiredPage());
  }
  // If PIN exists and not verified, show PIN page
  if (job.pin_hash && !isPinVerified(req, job)) {
    return res.send(renderPinPage(token, job));
  }
  if (job.status === 'signed') {
    return res.send(renderSignedPage(token, job));
  }
  return res.send(renderPendingPage(token, job));
});

// PIN verification endpoint
app.post('/s/:token/verify-pin', rateLimit, express.urlencoded({ extended: false }), (req, res) => {
  const token = req.params.token;
  const job = getJobByToken(token);
  noStore(res);

  if (!job) return res.status(404).send(renderNotFoundPage());
  if (job.status === 'expired') return res.status(410).send(renderExpiredPage());

  const pin = typeof req.body.pin === 'string' ? req.body.pin.trim() : '';
  if (!pin || hashPin(pin) !== job.pin_hash) {
    return res.send(renderLayout({
      title: 'Enter PIN',
      token,
      body: `
        <section class="card pin-card">
          <h2>🔒 PIN Required</h2>
          <p>Please enter the 6-digit PIN code that was provided to you.</p>
          <form class="pin-form" method="POST" action="${BASE_PATH}/s/${encodeURIComponent(token)}/verify-pin">
            <input type="text" name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6"
                   placeholder="• • • • • •" class="pin-input"
                   autocomplete="off" autofocus required />
            <button type="submit" class="btn btn-primary">Verify</button>
          </form>
          <div class="status error" data-pin-status>Invalid PIN. Please try again.</div>
        </section>
      `,
    }));
  }

  // Set cookie to remember PIN verification (expires with the job)
  const maxAge = Math.max(0, new Date(job.expires_at).getTime() - Date.now());
  res.cookie(`sign_pin_${job.id}`, job.pin_hash, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge,
    path: '/',
  });
  return res.redirect(`${BASE_PATH}/s/${encodeURIComponent(token)}`);
});

// Also protect PDF and submit endpoints with PIN
function requirePin(req, res, next) {
  const token = req.params.token;
  const job = getJobByToken(token);
  if (!job) return res.status(404).send('Not found');
  if (job.pin_hash && !isPinVerified(req, job)) {
    return res.status(403).send('PIN verification required');
  }
  req.signJob = job;
  return next();
}

app.get('/s/:token/pdf', rateLimit, requirePin, (req, res) => {
  const token = req.params.token;
  const job = req.signJob;
  noStore(res);
  if (!job) {
    return res.status(404).send('Not found');
  }
  if (job.status === 'expired') {
    return res.status(410).send('Expired');
  }
  const storedPath =
    job.status === 'signed' && job.signed_path ? job.signed_path : job.source_path;
  const absolutePath = absoluteSharedPath(storedPath);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return res.status(404).send('File not found');
  }
  return res.sendFile(absolutePath);
});

app.get('/s/:token/download', rateLimit, requirePin, (req, res) => {
  const token = req.params.token;
  const job = req.signJob;
  noStore(res);
  if (!job || job.status !== 'signed' || !job.signed_path) {
    return res.status(404).send('Not available');
  }
  const absolutePath = absoluteSharedPath(job.signed_path);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return res.status(404).send('File not found');
  }
  stmtIncrementDownload.run(job.id);
  const filename = job.original_name
    ? job.original_name.replace(/\.pdf$/i, '') + '_signed.pdf'
    : 'signed.pdf';
  return res.download(absolutePath, filename);
});

app.post('/s/:token/submit', rateLimit, requirePin, async (req, res) => {
  const token = req.params.token;
  const job = req.signJob;
  noStore(res);

  if (!job) {
    return res.status(404).json({ ok: false, error: 'Invalid link.' });
  }
  if (job.status === 'expired') {
    return res.status(410).json({ ok: false, error: 'Link expired.' });
  }
  if (job.status === 'signed') {
    return res.status(400).json({ ok: false, error: 'Document already signed.' });
  }

  const signatureData = req.body && req.body.signatureData;
  if (!signatureData || typeof signatureData !== 'string' || !signatureData.startsWith('data:image/')) {
    return res.status(400).json({ ok: false, error: 'Signature data is required.' });
  }

  const comment = req.body && typeof req.body.comment === 'string'
    ? req.body.comment.trim().slice(0, MAX_COMMENT_LENGTH)
    : '';

  const match = /^data:(image\/(?:png|jpe?g));base64,(.+)$/i.exec(signatureData.trim());
  if (!match) {
    return res.status(400).json({ ok: false, error: 'Unsupported signature format.' });
  }

  let signatureBuffer;
  try {
    signatureBuffer = Buffer.from(match[2], 'base64');
  } catch (err) {
    return res.status(400).json({ ok: false, error: 'Invalid signature payload.' });
  }

  const sourcePath = absoluteSharedPath(job.source_path);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return res.status(404).json({ ok: false, error: 'Source document not found.' });
  }

  try {
    const pdfBytes = await fs.promises.readFile(sourcePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    const basePage = pages.length ? pages[0] : pdfDoc.addPage();
    const { width, height } = basePage.getSize();
    const page = pdfDoc.addPage([width, height]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const titleSize = 20;
    const textSize = 12;
    const margin = 48;

    page.drawText('Signature', {
      x: margin,
      y: height - margin - titleSize,
      size: titleSize,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });

    const boxHeight = 160;
    const boxWidth = width - margin * 2;
    const boxY = height - margin - titleSize - 24 - boxHeight;
    page.drawRectangle({
      x: margin,
      y: boxY,
      width: boxWidth,
      height: boxHeight,
      borderWidth: 1,
      borderColor: rgb(0.75, 0.78, 0.82),
    });

    const image =
      match[1].toLowerCase().includes('png')
        ? await pdfDoc.embedPng(signatureBuffer)
        : await pdfDoc.embedJpg(signatureBuffer);
    const maxWidth = boxWidth - 24;
    const maxHeight = boxHeight - 24;
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
    const sigWidth = image.width * scale;
    const sigHeight = image.height * scale;
    const sigX = margin + (boxWidth - sigWidth) / 2;
    const sigY = boxY + (boxHeight - sigHeight) / 2;
    page.drawImage(image, {
      x: sigX,
      y: sigY,
      width: sigWidth,
      height: sigHeight,
    });

    const signedAt = new Date().toISOString();
    page.drawText(`Signed at: ${signedAt}`, {
      x: margin,
      y: boxY - 28,
      size: textSize,
      font,
      color: rgb(0.25, 0.25, 0.25),
    });

    if (comment) {
      const lines = wrapText(comment, font, textSize, width - margin * 2);
      let cursorY = boxY - 52;
      for (const line of lines.slice(0, 8)) {
        page.drawText(line, {
          x: margin,
          y: cursorY,
          size: textSize,
          font,
          color: rgb(0.2, 0.2, 0.2),
        });
        cursorY -= textSize + 4;
        if (cursorY < margin) break;
      }
    }

    const signedBytes = await pdfDoc.save();
    const signedFilename = `${job.id}_signed.pdf`;
    const signedRelPath = path.posix.join('signed', signedFilename);
    const signedAbsPath = absoluteSharedPath(signedRelPath);
    if (!signedAbsPath) {
      throw new Error('Invalid output path.');
    }
    await fs.promises.writeFile(signedAbsPath, signedBytes);

    stmtUpdateStatus.run({
      id: job.id,
      status: 'signed',
      signed_at: signedAt,
      signed_path: signedRelPath,
      comment: comment || null,
      audit_ip: req.ip || null,
      audit_ua: String(req.headers['user-agent'] || '').slice(0, 240) || null,
    });

    return res.json({
      ok: true,
      downloadUrl: `/s/${encodeURIComponent(token)}/download`,
    });
  } catch (err) {
    console.error('[sign] Failed to embed signature', err);
    return res.status(500).json({ ok: false, error: 'Failed to save signature.' });
  }
});

function start() {
  app.listen(PORT, () => {
    console.log(`[sign] Listening on port ${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app };
