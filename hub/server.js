const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
// Node 18+ includes a global fetch; avoid requiring node-fetch (ESM) to keep CommonJS simple

const cookieParser = require('cookie-parser');
const session = require('express-session');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;
app.use(cookieParser());
app.use(session({ secret: process.env.SESSION_SECRET || 'changeme', resave: false, saveUninitialized: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SERVICES_FILE = path.join(__dirname, 'services.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ADMIN_STORE_FILE = path.join(__dirname, 'admin.json');
const UPLOAD_DIR = path.join(__dirname, 'static', 'uploads');
const DEFAULT_CONFIG = {
  siteLogo: '/static/logo1.svg',
  siteTitle: 'Linart Systems',
  brandTagline: 'Central hub running inside a container. Access every service from one place.',
  introTitle: 'Welcome to my server!',
  introBody: 'I am Vladimir. If you have any questions or need help, feel free to reach out on WhatsApp.',
  contactWhatsapp: '+491754000261',
  heroVideo: '',
  heroVideoBlur: 8,
  heroOverlayColor: '#05060b',
  heroOverlayOpacity: 0.85,
  surfaceColor: '#0c1820',
  surfaceOpacity: 0.72,
  pageBackgroundColor: '#05060b',
  pageBackgroundOpacity: 1,
  welcomeImage: '',
  socialLinks: [],
};
const DEFAULT_ADMIN_PASSWORD = process.env.HUB_ADMIN_PASSWORD || 'admin';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  if (number < min) return min;
  if (number > max) return max;
  return number;
}

function normalizeSocialLink(link) {
  if (!link || typeof link !== 'object') return null;
  const label = typeof link.label === 'string' ? link.label.trim() : '';
  const url = typeof link.url === 'string' ? link.url.trim() : '';
  if (!label || !url) return null;
  const icon = typeof link.icon === 'string' ? link.icon.trim() : '';
  const idRaw = typeof link.id === 'string' ? link.id.trim() : '';
  const id = idRaw || crypto.randomUUID();
  return { id, label, url, icon };
}

function sanitizeConfig(input) {
  const merged = { ...DEFAULT_CONFIG, ...(input || {}) };

  merged.siteLogo =
    typeof merged.siteLogo === 'string' && merged.siteLogo.trim()
      ? merged.siteLogo.trim()
      : DEFAULT_CONFIG.siteLogo;
  merged.siteTitle =
    typeof merged.siteTitle === 'string' && merged.siteTitle.trim()
      ? merged.siteTitle.trim()
      : DEFAULT_CONFIG.siteTitle;
  merged.brandTagline =
    typeof merged.brandTagline === 'string' && merged.brandTagline.trim()
      ? merged.brandTagline.trim()
      : DEFAULT_CONFIG.brandTagline;
  merged.introTitle =
    typeof merged.introTitle === 'string' && merged.introTitle.trim()
      ? merged.introTitle.trim()
      : DEFAULT_CONFIG.introTitle;
  merged.introBody =
    typeof merged.introBody === 'string' && merged.introBody.trim()
      ? merged.introBody.trim()
      : DEFAULT_CONFIG.introBody;
  merged.contactWhatsapp =
    typeof merged.contactWhatsapp === 'string' && merged.contactWhatsapp.trim()
      ? merged.contactWhatsapp.trim()
      : DEFAULT_CONFIG.contactWhatsapp;
  merged.heroVideo = typeof merged.heroVideo === 'string' ? merged.heroVideo.trim() : '';
  merged.heroVideoBlur = clamp(merged.heroVideoBlur, 0, 40);
  merged.heroOverlayOpacity = clamp(merged.heroOverlayOpacity, 0, 1);
  if (typeof merged.heroOverlayColor !== 'string' || !HEX_COLOR_PATTERN.test(merged.heroOverlayColor.trim())) {
    merged.heroOverlayColor = DEFAULT_CONFIG.heroOverlayColor;
  } else {
    merged.heroOverlayColor = merged.heroOverlayColor.trim();
  }
  if (typeof merged.surfaceColor !== 'string' || !HEX_COLOR_PATTERN.test(merged.surfaceColor.trim())) {
    merged.surfaceColor = DEFAULT_CONFIG.surfaceColor;
  } else {
    merged.surfaceColor = merged.surfaceColor.trim();
  }
  merged.surfaceOpacity = clamp(merged.surfaceOpacity, 0, 1);
  merged.pageBackgroundOpacity = clamp(merged.pageBackgroundOpacity, 0, 1);
  if (typeof merged.pageBackgroundColor !== 'string' || !HEX_COLOR_PATTERN.test(merged.pageBackgroundColor.trim())) {
    merged.pageBackgroundColor = DEFAULT_CONFIG.pageBackgroundColor;
  } else {
    merged.pageBackgroundColor = merged.pageBackgroundColor.trim();
  }
  merged.welcomeImage = typeof merged.welcomeImage === 'string' ? merged.welcomeImage.trim() : '';
  merged.socialLinks = Array.isArray(merged.socialLinks)
    ? merged.socialLinks
        .map(normalizeSocialLink)
        .filter(Boolean)
    : [];

  return merged;
}

function normalizeService(service) {
  if (!service || typeof service !== 'object') return null;
  const name = service.name ? String(service.name).trim() : '';
  if (!name) return null;
  const target = service.target ? String(service.target).trim() : '';
  let prefix = service.prefix ? String(service.prefix).trim() : `/${name}`;
  if (prefix && !prefix.startsWith('/')) {
    prefix = `/${prefix}`;
  }
  const displayName = service.displayName ? String(service.displayName).trim() : name;
  const description = service.description ? String(service.description).trim() : '';
  const logo = service.logo ? String(service.logo).trim() : null;

  return {
    name,
    target,
    prefix,
    displayName,
    description,
    logo,
  };
}

function loadServices(){
  try{
    const raw = JSON.parse(fs.readFileSync(SERVICES_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.services) ? raw.services : []);
    return list.map(normalizeService).filter(Boolean);
  }catch(e){
    return [];
  }
}

function saveServices(list){
  const normalized = list.map(normalizeService).filter(Boolean);
  fs.writeFileSync(SERVICES_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

function loadConfig(){
  try{
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return sanitizeConfig(data);
  }catch(err){
    return sanitizeConfig(null);
  }
}

function saveConfig(next){
  const sanitized = sanitizeConfig(next);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(sanitized, null, 2));
  return sanitized;
}

function loadAdminCredentials() {
  try {
    const data = JSON.parse(fs.readFileSync(ADMIN_STORE_FILE, 'utf8'));
    if (data && data.passwordHash) {
      return data;
    }
  } catch (err) {
    // ignore, will create defaults
  }
  const passwordHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10);
  const credentials = { passwordHash };
  fs.writeFileSync(ADMIN_STORE_FILE, JSON.stringify(credentials, null, 2));
  return credentials;
}

function saveAdminCredentials(credentials) {
  fs.writeFileSync(ADMIN_STORE_FILE, JSON.stringify(credentials, null, 2));
  adminCredentials = credentials;
}

let adminCredentials = loadAdminCredentials();

const allowedImageTypes = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/svg+xml', '.svg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
]);

const allowedVideoTypes = new Map([
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/ogg', '.ogv'],
]);

const allowedExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.gif',
  '.webp',
  '.mp4',
  '.webm',
  '.ogv',
]);

function buildStoredFilename(originalName, mimetype) {
  const rawExt = path.extname(originalName || '').toLowerCase();
  const extFromMime =
    allowedImageTypes.get(mimetype) || allowedVideoTypes.get(mimetype);
  const ext =
    extFromMime ||
    (allowedExtensions.has(rawExt) ? rawExt : '.png');
  const base = path
    .basename(originalName || 'logo', rawExt)
    .replace(/[^a-z0-9_-]+/gi, '')
    .toLowerCase()
    .slice(0, 40) || (ext && ext.startsWith('.mp') ? 'video' : 'file');
  return `${Date.now()}-${base}${ext}`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, buildStoredFilename(file.originalname, file.mimetype)),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowedImageTypes.has(file.mimetype) || allowedVideoTypes.has(file.mimetype)) {
      return cb(null, true);
    }
    if (file.originalname && allowedExtensions.has(path.extname(file.originalname).toLowerCase())) {
      return cb(null, true);
    }
    const err = new Error('Unsupported file type. Allowed: png, jpg, svg, gif, webp, mp4, webm, ogv.');
    err.code = 'UNSUPPORTED_FILE_TYPE';
    return cb(err);
  },
});

let dynamicProxies = [];
function registerProxies(app){
  // remove previous proxies by reloading express stack is non-trivial; for simplicity we will not remove old handlers in runtime
  const services = loadServices();
  services.forEach(s => {
    app.use(s.prefix, createProxyMiddleware({ target: s.target, changeOrigin: true, pathRewrite: { ['^'+s.prefix]: '' }, logLevel: 'warn' }));
  });
}

// register once on startup
registerProxies(app);

// Safer Referer-based proxy: only proxy when we can match a service by the Referer path.
// This avoids defaulting to an incorrect target (previously 'http://localhost') which
// caused ECONNREFUSED and 502 responses.
app.use(['/submit', '/suggest', '/api/suggest', '/upload', '/files'], (req, res, next) => {
  const allowed = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
  if (!allowed.includes(req.method)) return next();

  const ref = req.get('referer') || req.get('referrer') || '';
  if (!ref) {
    // No referer — cannot determine which service should handle this request
    return res.status(502).send('Bad gateway: missing Referer');
  }

  let target = null;
  try {
    const u = new URL(ref);
    const p = u.pathname || '/';
    const services = loadServices();
    for (const s of services) {
      if (!s || !s.prefix) continue;
      if (p === s.prefix || p.startsWith(s.prefix + '/')) {
        target = s.target;
        break;
      }
    }
  } catch (err) {
    console.warn('[hub] referer parse failed', err && err.message);
    return res.status(502).send('Bad gateway: invalid Referer');
  }

  if (!target) {
    return res.status(502).send('Bad gateway: no matching service for Referer ' + ref);
  }

  // Create a one-off proxy to the resolved target and pass the request through.
  const proxy = createProxyMiddleware({
    target: target,
    changeOrigin: true,
    logLevel: 'warn'
  });

  return proxy(req, res, next);
});

// Static files
app.use('/static', express.static(path.join(__dirname, 'static')));

// Main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// Status page (static)
app.get('/status', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'status.html'));
});

// Simple pages
// Aggregated status API that queries each service health endpoint
app.get('/api/status', async (req, res) => {
  const config = loadConfig();
  const services = loadServices();

  const results = await Promise.all(
    services.map(async (service) => {
      const base = {
        name: service.name,
        displayName: service.displayName,
        description: service.description,
        prefix: service.prefix,
        logo: service.logo,
        target: service.target,
      };

      let healthUrl = null;
      try {
        healthUrl = new URL('/health', service.target).toString();
      } catch (err) {
        return { ...base, ok: false, error: `Invalid target URL: ${err.message}` };
      }

      try {
        const response = await fetch(healthUrl, { timeout: 2000 });
        if (!response.ok) {
          return { ...base, ok: false, status: response.status };
        }
        const body = await response.json();
        return { ...base, ok: true, info: body };
      } catch (err) {
        return { ...base, ok: false, error: String(err) };
      }
    })
  );

  res.json({
    services: results,
    hub: {
      now: new Date().toISOString(),
      siteLogo: config.siteLogo,
      siteTitle: config.siteTitle,
      brandTagline: config.brandTagline,
      introTitle: config.introTitle,
      introBody: config.introBody,
      contactWhatsapp: config.contactWhatsapp,
      heroVideo: config.heroVideo,
      heroVideoBlur: config.heroVideoBlur,
      heroOverlayColor: config.heroOverlayColor,
      heroOverlayOpacity: config.heroOverlayOpacity,
      pageBackgroundColor: config.pageBackgroundColor,
      pageBackgroundOpacity: config.pageBackgroundOpacity,
      surfaceColor: config.surfaceColor,
      surfaceOpacity: config.surfaceOpacity,
      welcomeImage: config.welcomeImage,
      socialLinks: config.socialLinks,
    },
  });
});

// Admin: login page
app.get('/admin', (req, res) => {
  if (req.session && req.session.authenticated) return res.sendFile(path.join(__dirname, 'static', 'admin.html'));
  return res.sendFile(path.join(__dirname, 'static', 'admin-login.html'));
});

app.post('/admin/login', async (req, res) => {
  const pass = req.body && req.body.password;
  if (typeof pass !== 'string' || !pass.length) {
    return res.status(403).send('Forbidden');
  }
  try {
    const ok = await bcrypt.compare(pass, adminCredentials.passwordHash);
    if (ok) {
      req.session.authenticated = true;
      return res.redirect('/admin');
    }
  } catch (err) {
    console.warn('[hub] Failed to compare admin password', err);
  }
  return res.status(403).send('Forbidden');
});

function requireAuth(req, res, next){
  if (req.session && req.session.authenticated) return next();
  return res.status(401).send({ ok: false, error: 'unauthorized' });
}

// Admin API: list services
app.get('/admin/services', requireAuth, (req, res) => {
  res.json(loadServices());
});

// Add service: { name, target, prefix }
app.post('/admin/services', requireAuth, (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.target) {
    return res.status(400).json({ ok: false, error: 'missing fields' });
  }

  const list = loadServices();
  if (list.find((s) => s.name === body.name)) {
    return res.status(400).json({ ok: false, error: 'exists' });
  }

  const service = normalizeService({
    name: body.name,
    target: body.target,
    prefix: body.prefix,
    displayName: body.displayName,
    description: body.description,
    logo: body.logo,
  });

  if (!service) {
    return res.status(400).json({ ok: false, error: 'invalid service payload' });
  }

  list.push(service);
  saveServices(list);
  // naive: register proxies again (may duplicate in memory but acceptable for minimal admin)
  registerProxies(app);
  res.json({ ok: true, service });
});

app.patch('/admin/services/:name', requireAuth, (req, res) => {
  const list = loadServices();
  const idx = list.findIndex((s) => s.name === req.params.name);
  if (idx === -1) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  const payload = { ...list[idx] };
  const body = req.body || {};
  const fields = ['displayName', 'description', 'logo', 'target', 'prefix'];

  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      const value = body[field];
      if (field === 'logo' && (value === null || value === '')) {
        payload.logo = null;
      } else if (typeof value === 'string') {
        payload[field] = value;
      }
    }
  });

  const normalized = normalizeService(payload);
  if (!normalized) {
    return res.status(400).json({ ok: false, error: 'invalid update' });
  }

  list[idx] = normalized;
  saveServices(list);

  if (Object.prototype.hasOwnProperty.call(body, 'target') || Object.prototype.hasOwnProperty.call(body, 'prefix')) {
    registerProxies(app);
  }

  res.json({ ok: true, service: normalized });
});

app.delete('/admin/services/:name', requireAuth, (req, res) => {
  const name = req.params.name;
  let list = loadServices();
  list = list.filter(s=>s.name !== name);
  saveServices(list);
  res.json({ ok: true });
});

app.post('/admin/password', requireAuth, async (req, res) => {
  const body = req.body || {};
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  try {
    const matches = await bcrypt.compare(currentPassword, adminCredentials.passwordHash);
    if (!matches) {
      return res.status(400).json({ ok: false, error: 'invalid_current_password' });
    }
  } catch (err) {
    console.error('[hub] Password compare failed', err);
    return res.status(500).json({ ok: false, error: 'compare_failed' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: 'weak_password' });
  }

  try {
    const passwordHash = await bcrypt.hash(newPassword, 10);
    saveAdminCredentials({ passwordHash });
    res.json({ ok: true });
  } catch (err) {
    console.error('[hub] Failed to update password', err);
    res.status(500).json({ ok: false, error: 'update_failed' });
  }
});

app.get('/admin/config', requireAuth, (req, res) => {
  res.json(loadConfig());
});

app.post('/admin/config', requireAuth, (req, res) => {
  const body = req.body || {};
  const current = loadConfig();
  const next = { ...current };

  if (Object.prototype.hasOwnProperty.call(body, 'siteLogo')) {
    const value = typeof body.siteLogo === 'string' ? body.siteLogo.trim() : '';
    next.siteLogo = value || DEFAULT_CONFIG.siteLogo;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'siteTitle')) {
    const value = typeof body.siteTitle === 'string' ? body.siteTitle.trim() : '';
    next.siteTitle = value || DEFAULT_CONFIG.siteTitle;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'brandTagline')) {
    const value = typeof body.brandTagline === 'string' ? body.brandTagline.trim() : '';
    next.brandTagline = value || DEFAULT_CONFIG.brandTagline;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'introTitle')) {
    const value = typeof body.introTitle === 'string' ? body.introTitle.trim() : '';
    next.introTitle = value || DEFAULT_CONFIG.introTitle;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'introBody')) {
    const value =
      typeof body.introBody === 'string' ? body.introBody.trim() : '';
    next.introBody = value || DEFAULT_CONFIG.introBody;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'contactWhatsapp')) {
    const value =
      typeof body.contactWhatsapp === 'string' ? body.contactWhatsapp.trim() : '';
    next.contactWhatsapp = value || DEFAULT_CONFIG.contactWhatsapp;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'pageBackgroundColor')) {
    const value =
      typeof body.pageBackgroundColor === 'string' ? body.pageBackgroundColor.trim() : '';
    if (HEX_COLOR_PATTERN.test(value)) {
      next.pageBackgroundColor = value;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'pageBackgroundOpacity')) {
    const parsedOpacity = Number(body.pageBackgroundOpacity);
    if (Number.isFinite(parsedOpacity)) {
      next.pageBackgroundOpacity = Math.max(0, Math.min(1, parsedOpacity));
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'surfaceColor')) {
    const value =
      typeof body.surfaceColor === 'string' ? body.surfaceColor.trim() : '';
    if (HEX_COLOR_PATTERN.test(value)) {
      next.surfaceColor = value;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'surfaceOpacity')) {
    const parsedOpacity = Number(body.surfaceOpacity);
    if (Number.isFinite(parsedOpacity)) {
      next.surfaceOpacity = Math.max(0, Math.min(1, parsedOpacity));
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'heroVideo')) {
    const value = typeof body.heroVideo === 'string' ? body.heroVideo.trim() : '';
    next.heroVideo = value;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'heroVideoBlur')) {
    const parsed = Number(body.heroVideoBlur);
    if (Number.isFinite(parsed)) {
      next.heroVideoBlur = Math.max(0, Math.min(40, parsed));
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'heroOverlayColor')) {
    const value = typeof body.heroOverlayColor === 'string' ? body.heroOverlayColor.trim() : '';
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
      next.heroOverlayColor = value;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'heroOverlayOpacity')) {
    const parsedOpacity = Number(body.heroOverlayOpacity);
    if (Number.isFinite(parsedOpacity)) {
      next.heroOverlayOpacity = Math.max(0, Math.min(1, parsedOpacity));
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'welcomeImage')) {
    const value = typeof body.welcomeImage === 'string' ? body.welcomeImage.trim() : '';
    next.welcomeImage = value;
  }

  const saved = saveConfig(next);
  res.json({ ok: true, config: saved });
});

app.get('/admin/social-links', requireAuth, (req, res) => {
  const config = loadConfig();
  res.json({ ok: true, links: config.socialLinks });
});

app.post('/admin/social-links', requireAuth, (req, res) => {
  const body = req.body || {};
  const candidate = normalizeSocialLink({
    id: crypto.randomUUID(),
    label: body.label,
    url: body.url,
    icon: body.icon,
  });

  if (!candidate) {
    return res.status(400).json({ ok: false, error: 'invalid_link' });
  }

  const config = loadConfig();
  const next = { ...config, socialLinks: [...config.socialLinks, candidate] };
  const saved = saveConfig(next);
  res.json({ ok: true, link: candidate, links: saved.socialLinks });
});

app.patch('/admin/social-links/:id', requireAuth, (req, res) => {
  const linkId = String(req.params.id || '').trim();
  if (!linkId) {
    return res.status(400).json({ ok: false, error: 'missing_id' });
  }

  const body = req.body || {};
  const config = loadConfig();
  const index = config.socialLinks.findIndex((link) => link.id === linkId);
  if (index === -1) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  const updated = { ...config.socialLinks[index] };
  if (Object.prototype.hasOwnProperty.call(body, 'label')) {
    updated.label = typeof body.label === 'string' ? body.label.trim() : '';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'url')) {
    updated.url = typeof body.url === 'string' ? body.url.trim() : '';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'icon')) {
    updated.icon = typeof body.icon === 'string' ? body.icon.trim() : '';
  }

  const normalised = normalizeSocialLink({ ...updated, id: linkId });
  if (!normalised) {
    return res.status(400).json({ ok: false, error: 'invalid_link' });
  }

  const next = { ...config, socialLinks: [...config.socialLinks] };
  next.socialLinks[index] = normalised;
  const saved = saveConfig(next);
  res.json({ ok: true, link: saved.socialLinks[index], links: saved.socialLinks });
});

app.delete('/admin/social-links/:id', requireAuth, (req, res) => {
  const linkId = String(req.params.id || '').trim();
  if (!linkId) {
    return res.status(400).json({ ok: false, error: 'missing_id' });
  }

  const config = loadConfig();
  const nextLinks = config.socialLinks.filter((link) => link.id !== linkId);
  if (nextLinks.length === config.socialLinks.length) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  const saved = saveConfig({ ...config, socialLinks: nextLinks });
  res.json({ ok: true, links: saved.socialLinks });
});

app.post('/admin/upload-logo', requireAuth, (req, res, next) => {
  upload.single('logo')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'no_file' });
    }

    const relativePath = `/static/uploads/${req.file.filename}`;
    res.json({ ok: true, path: relativePath });
  });
});

// Reverse-proxy routes: expose services under /service1/ and /service2/
app.get('/service1', (req, res) => res.redirect(301, '/service1/'));
app.get('/service2', (req, res) => res.redirect(301, '/service2/'));
app.use('/service1', createProxyMiddleware({
  target: 'http://service1:3000',
  changeOrigin: true,
  pathRewrite: { '^/service1': '' },
  logLevel: 'warn'
}));

app.use('/service2', createProxyMiddleware({
  target: 'http://service2:3001',
  changeOrigin: true,
  pathRewrite: { '^/service2': '' },
  logLevel: 'warn'
}));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (err && err.code === 'UNSUPPORTED_FILE_TYPE') {
    return res.status(400).json({ ok: false, error: err.message || 'Unsupported file type' });
  }
  if (err) {
    console.error('[hub] Unhandled error', err);
    return res.status(500).json({ ok: false, error: err.message || 'Unexpected error' });
  }
  return next();
});

app.listen(PORT, () => console.log(`Hub listening on ${PORT}`));
