const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
// Node 18+ includes a global fetch; avoid requiring node-fetch (ESM) to keep CommonJS simple

const cookieParser = require('cookie-parser');
const session = require('express-session');
const fs = require('fs');
const { exec } = require('child_process');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;
const PROXY_PREFIXES = ['/service2'];

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable is not set.');
  process.exit(1);
}

const HUB_ADMIN_PASSWORD = process.env.HUB_ADMIN_PASSWORD;
if (!HUB_ADMIN_PASSWORD) {
  console.error('FATAL: HUB_ADMIN_PASSWORD environment variable is not set.');
  process.exit(1);
}

const shouldBypassBodyParsing = (req) => {
  const urlPath = req.url || '';
  return PROXY_PREFIXES.some((prefix) => urlPath.startsWith(prefix));
};

const jsonParser = express.json();
const urlencodedParser = express.urlencoded({ extended: true });

app.use(cookieParser());
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false }));
app.use((req, res, next) => {
  if (shouldBypassBodyParsing(req)) {
    return next();
  }
  return jsonParser(req, res, next);
});
app.use((req, res, next) => {
  if (shouldBypassBodyParsing(req)) {
    return next();
  }
  return urlencodedParser(req, res, next);
});

const SERVICES_FILE = path.join(__dirname, 'services.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ADMIN_STORE_FILE = path.join(__dirname, 'admin.json');
const UPLOAD_DIR = path.join(__dirname, 'static', 'uploads');
const TEMP_DIR = path.join(UPLOAD_DIR, 'tmp');
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
const DEFAULT_ADMIN_PASSWORD = HUB_ADMIN_PASSWORD;
const DEFAULT_ADMIN_USERNAME = 'admin';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

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

  const toBool = (val) => val === true || val === 'true' || val === '1' || val === 1;
  const id = sanitizeId(
    service.id && typeof service.id === 'string' && service.id.trim()
      ? service.id.trim()
      : name,
    name
  );
  const target = service.target ? String(service.target).trim() : '';
  let prefix = service.prefix ? String(service.prefix).trim() : `/${id}`;
  if (prefix && !prefix.startsWith('/')) {
    prefix = `/${prefix}`;
  }
  const displayName = service.displayName ? String(service.displayName).trim() : name;
  const description = service.description ? String(service.description).trim() : '';
  const logo = service.logo ? String(service.logo).trim() : null;
  const allowPublic = toBool(service.allowPublic);

  return {
    id,
    name,
    target,
    prefix,
    displayName,
    description,
    logo,
    allowPublic,
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
    if (data && (data.passwordHash || Array.isArray(data.users))) {
      const normalized = { users: Array.isArray(data.users) ? data.users : [] };
      if (data.passwordHash) {
        normalized.superadmin = { username: DEFAULT_ADMIN_USERNAME, passwordHash: data.passwordHash };
      } else if (data.superadmin && data.superadmin.passwordHash) {
        normalized.superadmin = {
          username: data.superadmin.username || DEFAULT_ADMIN_USERNAME,
          passwordHash: data.superadmin.passwordHash,
        };
      }
      return normalized;
    }
  } catch (err) {
    // ignore, will create defaults
  }
  const passwordHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10);
  const credentials = {
    superadmin: { username: DEFAULT_ADMIN_USERNAME, passwordHash },
    users: [],
  };
  fs.writeFileSync(ADMIN_STORE_FILE, JSON.stringify(credentials, null, 2));
  return credentials;
}

function saveAdminCredentials(credentials) {
  fs.writeFileSync(ADMIN_STORE_FILE, JSON.stringify(credentials, null, 2));
  adminCredentials = credentials;
}

function normalizeAllowedServices(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((s) => String(s || '').trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    return input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function getNextPort() {
  const services = loadServices();
  let maxPort = 3000;
  services.forEach((svc) => {
    try {
      const url = new URL(svc.target);
      const p = Number(url.port || '0');
      if (p > maxPort) maxPort = p;
    } catch (err) {
      // ignore
    }
  });
  return maxPort + 1;
}

async function stopContainer(name) {
  if (!name) return;
  try {
    await execAsync(`docker rm -f ${name}`);
  } catch (err) {
    // ignore
  }
}

function getProjectNetwork() {
  const project = process.env.COMPOSE_PROJECT_NAME || 'linartsystems';
  return `${project}_default`;
}

let adminCredentials = loadAdminCredentials();

function getSessionUser(req) {
  return req.session && req.session.user ? req.session.user : null;
}

function setSessionUser(req, user) {
  if (req.session) {
    req.session.user = user;
  }
}

function clearSessionUser(req) {
  if (req.session) {
    req.session.user = null;
    req.session.authenticated = false;
  }
}

function getAllowedServiceSet(req) {
  const user = getSessionUser(req);
  if (!user) return null;
  if (user.isSuperadmin) return null;
  if (!Array.isArray(user.allowedServices) || user.allowedServices.length === 0) return null;
  return new Set(user.allowedServices.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
}

function isServiceAllowed(service, allowedSet, user) {
  // Public services are always visible
  if (service.allowPublic) return true;

  // Unauthenticated users can only see public services
  if (!user) return false;

  // Superadmin or user with no restrictions
  if (!allowedSet) return true;

  const id = (service.id || service.name || '').toLowerCase();
  const name = (service.name || '').toLowerCase();
  return allowedSet.has(id) || allowedSet.has(name);
}

function sanitizeId(value, fallback) {
  if (!value) return fallback;
  const cleaned = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '');
  return cleaned || fallback;
}

function sanitizeEnvVars(env) {
  const result = {};
  if (!env || typeof env !== 'object') return result;
  for (const [key, value] of Object.entries(env)) {
    const k = String(key || '')
      .trim()
      .replace(/[^a-zA-Z0-9_]/g, '')
      .toUpperCase();
    if (!k) continue;
    result[k] = value === undefined || value === null ? '' : String(value);
  }
  return result;
}

function parseBundleConfig(workDir, ts) {
  const defaultId = `service-${ts}`;
  const candidates = ['hub-service.json', 'service.config.json', 'service.json', 'hub.service.json'];
  let raw = null;
  let configPath = null;
  for (const name of candidates) {
    const fullPath = path.join(workDir, name);
    if (fs.existsSync(fullPath)) {
      try {
        raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        configPath = name;
        break;
      } catch (err) {
        // ignore malformed config; treat as missing
      }
    }
  }

  const cfg = raw && typeof raw === 'object' ? raw : {};
  const id = sanitizeId(typeof cfg.id === 'string' ? cfg.id : cfg.name, defaultId);
  const name = typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : id;
  let prefix = typeof cfg.prefix === 'string' && cfg.prefix.trim() ? cfg.prefix.trim() : `/${id}`;
  if (prefix && !prefix.startsWith('/')) {
    prefix = `/${prefix}`;
  }
  const displayName = typeof cfg.displayName === 'string' && cfg.displayName.trim() ? cfg.displayName.trim() : name;
  const description = typeof cfg.description === 'string' ? cfg.description.trim() : '';
  const logo = typeof cfg.logo === 'string' && cfg.logo.trim() ? cfg.logo.trim() : null;
  const internalPortRaw = cfg.internalPort ?? cfg.targetPort ?? cfg.port;
  const portNum = Number(internalPortRaw);
  const internalPort = Number.isFinite(portNum) && portNum > 0 ? portNum : null;
  const env = sanitizeEnvVars(cfg.env);

  return {
    id,
    name,
    prefix,
    displayName,
    description,
    logo,
    internalPort,
    env,
    configPath,
  };
}

function detectStaticRoot(workDir) {
  const candidates = ['dist', 'build', 'public', '.'];
  for (const candidate of candidates) {
    const dir = path.join(workDir, candidate);
    const indexPath = path.join(dir, 'index.html');
    if (fs.existsSync(indexPath)) {
      return {
        dir,
        indexPath,
        relative: path.relative(workDir, dir) || '.',
      };
    }
  }
  return null;
}

function ensureDockerfile(workDir) {
  const dockerfilePath = path.join(workDir, 'Dockerfile');
  if (fs.existsSync(dockerfilePath)) {
    return { dockerfilePath, generated: false, internalPort: null, source: null };
  }

  const staticRoot = detectStaticRoot(workDir);
  if (!staticRoot) {
    return { dockerfilePath, generated: false, internalPort: null, source: null };
  }

  const copySource = staticRoot.relative === '.' ? '.' : staticRoot.relative.replace(/\\/g, '/');
  const content = [
    'FROM nginx:alpine',
    'WORKDIR /usr/share/nginx/html',
    `COPY ${copySource}/ .`,
    'EXPOSE 80',
    '',
  ].join('\n');
  fs.writeFileSync(dockerfilePath, content);
  return { dockerfilePath, generated: true, internalPort: 80, source: copySource };
}

function buildEnvArgs(envMap) {
  if (!envMap || typeof envMap !== 'object') return '';
  const args = [];
  for (const [key, value] of Object.entries(envMap)) {
    if (!key) continue;
    const safeKey = key.replace(/[^A-Z0-9_]/gi, '').toUpperCase();
    if (!safeKey) continue;
    const safeValue = String(value ?? '').replace(/'/g, "'\"'\"'");
    args.push(`-e ${safeKey}='${safeValue}'`);
  }
  return args.join(' ');
}

const allowedImageTypes = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/svg+xml', '.svg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
]);

function execAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

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

const HUB_LOG = [];
const MAX_LOG_LINES = 100;
function addLog(line) {
  if (line === undefined || line === null) return;
  const entry = `[${new Date().toISOString()}] ${String(line)}`;
  if (HUB_LOG.length >= MAX_LOG_LINES) HUB_LOG.shift();
  HUB_LOG.push(entry);
}

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

function buildBundleFilename(originalName) {
  const rawExt = path.extname(originalName || '').toLowerCase();
  const ext = rawExt === '.zip' ? '.zip' : '.zip';
  const base = path
    .basename(originalName || 'bundle', rawExt)
    .replace(/[^a-z0-9_-]+/gi, '')
    .toLowerCase()
    .slice(0, 60) || 'bundle';
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

const bundleUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, buildBundleFilename(file.originalname)),
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    if (ext === '.zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed') {
      return cb(null, true);
    }
    const err = new Error('Only ZIP bundles are allowed.');
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
  const allowedSet = getAllowedServiceSet(req);
  const user = getSessionUser(req);
  try {
    const u = new URL(ref);
    const p = u.pathname || '/';
    const services = loadServices();
    for (const s of services) {
      if (!s || !s.prefix) continue;
      if (p === s.prefix || p.startsWith(s.prefix + '/')) {
        if (isServiceAllowed(s, allowedSet, user)) {
          target = s.target;
          break;
        }
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
  const user = getSessionUser(req);
  const allowed = getAllowedServiceSet(req);
  const filteredServices = services.filter((s) => isServiceAllowed(s, allowed, user));

  const results = await Promise.all(
    filteredServices.map(async (service) => {
      const base = {
        name: service.name,
        displayName: service.displayName,
        description: service.description,
        prefix: service.prefix,
        logo: service.logo,
        target: service.target,
        allowPublic: service.allowPublic === true,
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
      filtered: Boolean(allowed) || !user,
      user: user ? { username: user.username, isSuperadmin: user.isSuperadmin, allowedServices: user.allowedServices || [] } : null,
    },
  });
});

// Admin: login page
app.get('/admin', (req, res) => {
  const user = getSessionUser(req);
  if (user && user.isSuperadmin) return res.sendFile(path.join(__dirname, 'static', 'admin.html'));
  return res.sendFile(path.join(__dirname, 'static', 'admin-login.html'));
});

app.post('/admin/login', async (req, res) => {
  const username = (req.body && typeof req.body.username === 'string' && req.body.username.trim()) || DEFAULT_ADMIN_USERNAME;
  const pass = req.body && req.body.password;
  if (typeof pass !== 'string' || !pass.length) {
    return res.status(403).json({ ok: false, error: 'missing_credentials' });
  }
  try {
    let matchedUser = null;
    const superadmin = adminCredentials.superadmin;
    if (
      superadmin &&
      typeof superadmin.passwordHash === 'string' &&
      await bcrypt.compare(pass, superadmin.passwordHash) &&
      username === (superadmin.username || DEFAULT_ADMIN_USERNAME)
    ) {
      matchedUser = { username: superadmin.username || DEFAULT_ADMIN_USERNAME, isSuperadmin: true, allowedServices: [] };
    } else if (Array.isArray(adminCredentials.users)) {
      for (const user of adminCredentials.users) {
        if (!user || typeof user.username !== 'string' || typeof user.passwordHash !== 'string') continue;
        if (user.username.trim() !== username.trim()) continue;
        const ok = await bcrypt.compare(pass, user.passwordHash);
        if (ok) {
          matchedUser = {
            username: user.username.trim(),
            isSuperadmin: false,
            allowedServices: Array.isArray(user.allowedServices) ? user.allowedServices : [],
          };
          break;
        }
      }
    }

    if (matchedUser) {
      req.session.authenticated = true;
      setSessionUser(req, matchedUser);
      const payload = { ok: true, user: { username: matchedUser.username, isSuperadmin: matchedUser.isSuperadmin, allowedServices: matchedUser.allowedServices } };
      const accept = req.headers.accept || '';
      if (accept.includes('text/html')) {
        return res.redirect(matchedUser.isSuperadmin ? '/admin' : '/');
      }
      return res.json(payload);
    }
  } catch (err) {
    console.warn('[hub] Failed to compare admin password', err);
    return res.status(500).json({ ok: false, error: 'login_failed' });
  }
  return res.status(403).json({ ok: false, error: 'forbidden' });
});

app.post('/api/logout', (req, res) => {
  clearSessionUser(req);
  if (req.session) {
    req.session.destroy(() => {});
  }
  res.json({ ok: true });
});

function requireAuth(req, res, next){
  if (req.session && req.session.authenticated && getSessionUser(req)) return next();
  return res.status(401).send({ ok: false, error: 'unauthorized' });
}

function requireSuperadmin(req, res, next) {
  const user = getSessionUser(req);
  if (user && user.isSuperadmin) return next();
  return res.status(403).json({ ok: false, error: 'forbidden' });
}

// Admin API: list services
app.get('/admin/services', requireSuperadmin, (req, res) => {
  res.json(loadServices());
});

// Add service: { name, target, prefix }
app.post('/admin/services', requireSuperadmin, (req, res) => {
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
    allowPublic: body.allowPublic,
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

app.patch('/admin/services/:name', requireSuperadmin, (req, res) => {
  const list = loadServices();
  const idx = list.findIndex((s) => s.name === req.params.name);
  if (idx === -1) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  const payload = { ...list[idx] };
  const body = req.body || {};
  const fields = ['displayName', 'description', 'logo', 'target', 'prefix', 'allowPublic'];

  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      const value = body[field];
      if (field === 'logo' && (value === null || value === '')) {
        payload.logo = null;
      } else if (field === 'allowPublic') {
        payload.allowPublic = value;
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

app.delete('/admin/services/:name', requireSuperadmin, (req, res) => {
  const name = req.params.name;
  let list = loadServices();
  list = list.filter(s=>s.name !== name);
  saveServices(list);
  res.json({ ok: true });
});

app.post('/admin/password', requireSuperadmin, async (req, res) => {
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

// Upload a service bundle (ZIP), build and run it on the project network (admin-only)
app.post('/admin/upload-service', requireSuperadmin, (req, res, next) => {
  bundleUpload.single('bundle')(req, res, async (err) => {
    if (err) return next(err);
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'missing_file' });
    }

    const ts = Date.now();
    const zipPath = req.file.path;
    const workDir = path.join(TEMP_DIR, `svc-${ts}`);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      addLog(`upload-service: received ${path.basename(zipPath)} (${req.file.size || 0} bytes)`);
      await execAsync(`unzip -q "${zipPath}" -d "${workDir}"`);
    } catch (unzipErr) {
      addLog(`upload-service: unzip failed - ${unzipErr.stderr || unzipErr.message}`);
      return res.status(500).json({ ok: false, error: 'unzip_failed', detail: unzipErr.stderr || unzipErr.message });
    }

    const bundle = parseBundleConfig(workDir, ts);
    const overrides = req.body || {};
    const overrideId = sanitizeId(
      typeof overrides.serviceId === 'string' && overrides.serviceId.trim()
        ? overrides.serviceId.trim()
        : bundle.id,
      bundle.id
    );
    const overrideName =
      typeof overrides.serviceName === 'string' && overrides.serviceName.trim()
        ? overrides.serviceName.trim()
        : bundle.name || overrideId;
    let overridePrefix =
      typeof overrides.servicePrefix === 'string' && overrides.servicePrefix.trim()
        ? overrides.servicePrefix.trim()
        : bundle.prefix;
    if (overridePrefix && !overridePrefix.startsWith('/')) {
      overridePrefix = `/${overridePrefix}`;
    }
    const overrideDisplay =
      typeof overrides.displayName === 'string' && overrides.displayName.trim()
        ? overrides.displayName.trim()
        : bundle.displayName || overrideName;
    const overridePortRaw = overrides.internalPort ?? overrides.servicePort ?? overrides.port;
    const overridePortNum = Number(overridePortRaw);
    const overrideInternalPort =
      Number.isFinite(overridePortNum) && overridePortNum > 0 ? overridePortNum : bundle.internalPort;
    const mergedBundle = {
      ...bundle,
      id: overrideId,
      name: overrideName,
      displayName: overrideDisplay,
      prefix: overridePrefix || `/${overrideId}`,
      internalPort: overrideInternalPort,
    };

    const dockerfileInfo = ensureDockerfile(workDir);
    addLog(
      `upload-service: preparing ${mergedBundle.name} (id=${mergedBundle.id}, prefix=${mergedBundle.prefix}, port=${mergedBundle.internalPort || dockerfileInfo.internalPort || 'auto'})`
    );
    const dockerfilePath = dockerfileInfo.dockerfilePath;
    if (!fs.existsSync(dockerfilePath)) {
      addLog('upload-service: Dockerfile missing and no static site detected');
      return res.status(400).json({ ok: false, error: 'dockerfile_missing' });
    }

    if (dockerfileInfo.generated) {
      addLog(
        `upload-service: generated nginx Dockerfile for static site (source: ${dockerfileInfo.source || '.'})`
      );
    }
    if (bundle.configPath) {
      addLog(`upload-service: detected config at ${bundle.configPath}`);
    }

    let services = loadServices();
    const prefixConflict = services.find(
      (s) =>
        s.prefix === mergedBundle.prefix &&
        s.id !== mergedBundle.id &&
        s.name !== mergedBundle.name
    );
    if (prefixConflict) {
      return res.status(409).json({ ok: false, error: 'prefix_in_use', conflict: prefixConflict });
    }

    const toReplace = services.filter((s) => s.id === mergedBundle.id || s.name === mergedBundle.name);
    for (const svc of toReplace) {
      try {
        const u = new URL(svc.target);
        await stopContainer(u.hostname);
        addLog(`upload-service: stopped previous container ${u.hostname} for ${svc.name}`);
      } catch (stopErr) {
        addLog(`upload-service: could not stop previous container for ${svc.name} - ${stopErr.message}`);
      }
    }
    services = services.filter((s) => !toReplace.includes(s));

    const imageTag = `linartsystems-${mergedBundle.id}:${ts}`;
    try {
      await execAsync(`docker build -t ${imageTag} "${workDir}"`);
      addLog(`upload-service: built image ${imageTag}`);
    } catch (buildErr) {
      addLog(`upload-service: build failed - ${buildErr.stderr || buildErr.message}`);
      return res.status(500).json({ ok: false, error: 'build_failed', detail: buildErr.stderr || buildErr.message });
    }

    const containerName = `linart_${mergedBundle.id}_${ts}`;
    const network = getProjectNetwork();
    const envArgs = buildEnvArgs(mergedBundle.env);
    const runCmd = [
      'docker run -d',
      `--name ${containerName}`,
      `--network ${network}`,
      envArgs,
      imageTag,
    ]
      .filter(Boolean)
      .join(' ');

    try {
      await execAsync(runCmd);
      addLog(`upload-service: started container ${containerName} on ${network}`);
    } catch (runErr) {
      addLog(`upload-service: run failed - ${runErr.stderr || runErr.message}`);
      return res.status(500).json({ ok: false, error: 'run_failed', detail: runErr.stderr || runErr.message });
    }

    const internalPort = mergedBundle.internalPort || dockerfileInfo.internalPort || 3000;
    const target = `http://${containerName}:${internalPort}`;
    const registered = normalizeService({
      ...mergedBundle,
      target,
    });
    services.push(registered);
    saveServices(services);
    registerProxies(app);
    addLog(`upload-service: registered proxy ${registered.prefix} -> ${registered.target}`);

    res.json({
      ok: true,
      service: registered,
      container: containerName,
      image: imageTag,
      network,
      configPath: bundle.configPath || null,
      generatedDockerfile: dockerfileInfo.generated,
      internalPort,
    });
  });
});

app.get('/admin/config', requireSuperadmin, (req, res) => {
  res.json(loadConfig());
});

app.post('/admin/config', requireSuperadmin, (req, res) => {
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

app.get('/admin/social-links', requireSuperadmin, (req, res) => {
  const config = loadConfig();
  res.json({ ok: true, links: config.socialLinks });
});

app.post('/admin/social-links', requireSuperadmin, (req, res) => {
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

app.patch('/admin/social-links/:id', requireSuperadmin, (req, res) => {
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

app.delete('/admin/social-links/:id', requireSuperadmin, (req, res) => {
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

app.get('/admin/users', requireSuperadmin, (req, res) => {
  const users = Array.isArray(adminCredentials.users)
    ? adminCredentials.users.map((u) => ({
        username: u.username,
        allowedServices: normalizeAllowedServices(u.allowedServices),
      }))
    : [];
  res.json({ ok: true, users });
});

app.post('/admin/users', requireSuperadmin, async (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const allowedServices = normalizeAllowedServices(body.allowedServices);
  if (!username || username.toLowerCase() === DEFAULT_ADMIN_USERNAME.toLowerCase()) {
    return res.status(400).json({ ok: false, error: 'invalid_username' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ ok: false, error: 'weak_password' });
  }
  if (!Array.isArray(adminCredentials.users)) {
    adminCredentials.users = [];
  }
  if (adminCredentials.users.find((u) => u.username === username)) {
    return res.status(400).json({ ok: false, error: 'exists' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  adminCredentials.users.push({ username, passwordHash, allowedServices });
  saveAdminCredentials(adminCredentials);
  res.json({ ok: true });
});

app.patch('/admin/users/:username', requireSuperadmin, async (req, res) => {
  const username = typeof req.params.username === 'string' ? req.params.username.trim() : '';
  if (!username || username.toLowerCase() === DEFAULT_ADMIN_USERNAME.toLowerCase()) {
    return res.status(400).json({ ok: false, error: 'invalid_username' });
  }
  const body = req.body || {};
  if (!Array.isArray(adminCredentials.users)) {
    adminCredentials.users = [];
  }
  const idx = adminCredentials.users.findIndex((u) => u.username === username);
  if (idx === -1) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  const user = { ...adminCredentials.users[idx] };
  if (Object.prototype.hasOwnProperty.call(body, 'allowedServices')) {
    user.allowedServices = normalizeAllowedServices(body.allowedServices);
  }
  if (typeof body.password === 'string' && body.password.length >= 4) {
    user.passwordHash = await bcrypt.hash(body.password, 10);
  }
  adminCredentials.users[idx] = user;
  saveAdminCredentials(adminCredentials);
  res.json({ ok: true });
});

app.delete('/admin/users/:username', requireSuperadmin, (req, res) => {
  const username = typeof req.params.username === 'string' ? req.params.username.trim() : '';
  if (!username || username.toLowerCase() === DEFAULT_ADMIN_USERNAME.toLowerCase()) {
    return res.status(400).json({ ok: false, error: 'invalid_username' });
  }
  if (!Array.isArray(adminCredentials.users)) {
    adminCredentials.users = [];
  }
  const initial = adminCredentials.users.length;
  adminCredentials.users = adminCredentials.users.filter((u) => u.username !== username);
  if (adminCredentials.users.length === initial) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  saveAdminCredentials(adminCredentials);
  res.json({ ok: true });
});

app.post('/admin/upload-logo', requireSuperadmin, (req, res, next) => {
  upload.single('logo')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'no_file' });
    }

    const relativePath = `/static/uploads/${req.file.filename}`;
    res.json({ ok: true, path: relativePath });
  });
});

app.get('/admin/logs', requireSuperadmin, (_req, res) => {
  res.json({ ok: true, logs: HUB_LOG });
});

// Reverse-proxy route: expose service2 under /service2/
app.get('/service2', (req, res) => res.redirect(301, '/service2/'));
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
