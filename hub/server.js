const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
// Node 18+ includes a global fetch; avoid requiring node-fetch (ESM) to keep CommonJS simple

const cookieParser = require('cookie-parser');
const session = require('express-session');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.HUB_ADMIN_PASSWORD || 'admin';

app.use(cookieParser());
app.use(session({ secret: process.env.SESSION_SECRET || 'changeme', resave: false, saveUninitialized: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SERVICES_FILE = path.join(__dirname, 'services.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const UPLOAD_DIR = path.join(__dirname, 'static', 'uploads');
const DEFAULT_CONFIG = {
  siteLogo: '/static/logo1.svg',
  siteTitle: 'Linart Systems',
};

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
    return { ...DEFAULT_CONFIG, ...(data || {}) };
  }catch(err){
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(next){
  const merged = { ...DEFAULT_CONFIG, ...(next || {}) };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

const allowedImageTypes = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/svg+xml', '.svg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
]);

const allowedExtensions = new Set(['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp']);

function buildStoredFilename(originalName, mimetype) {
  const rawExt = path.extname(originalName || '').toLowerCase();
  const ext =
    allowedImageTypes.get(mimetype) ||
    (allowedExtensions.has(rawExt) ? rawExt : '.png');
  const base = path
    .basename(originalName || 'logo', rawExt)
    .replace(/[^a-z0-9_-]+/gi, '')
    .toLowerCase()
    .slice(0, 40) || 'logo';
  return `${Date.now()}-${base}${ext}`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, buildStoredFilename(file.originalname, file.mimetype)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowedImageTypes.has(file.mimetype)) {
      return cb(null, true);
    }
    if (file.originalname && allowedExtensions.has(path.extname(file.originalname).toLowerCase())) {
      return cb(null, true);
    }
    const err = new Error('Unsupported file type. Allowed: png, jpg, svg, gif, webp.');
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
    },
  });
});

// Admin: login page
app.get('/admin', (req, res) => {
  if (req.session && req.session.authenticated) return res.sendFile(path.join(__dirname, 'static', 'admin.html'));
  return res.sendFile(path.join(__dirname, 'static', 'admin-login.html'));
});

app.post('/admin/login', (req, res) => {
  const pass = req.body && req.body.password;
  if (pass === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect('/admin');
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

  const saved = saveConfig(next);
  res.json({ ok: true, config: saved });
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
