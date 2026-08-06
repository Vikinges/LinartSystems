const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
// Node 18+ includes a global fetch; avoid requiring node-fetch (ESM) to keep CommonJS simple

const cookieParser = require('cookie-parser');
const session = require('express-session');
const fs = require('fs');
const { exec } = require('child_process');
const multer = require('multer');
const archiver = require('archiver');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const http2 = require('http2');

const app = express();
const PORT = process.env.PORT || 8080;
const PROXY_PREFIXES = ['/service2', '/sign'];

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

const IS_PROD = (process.env.NODE_ENV || '').toLowerCase() === 'production';
const ADMIN_AUTH_COOKIE = 'hub_admin_auth';
const ADMIN_AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USER_ROLE_ADMIN = 'admin';
const USER_ROLE_MANAGER = 'manager';   // shown in the admin UI as "Engineer" (fills/submits reports)
const USER_ROLE_PLANNER = 'planner';   // shown in the admin UI as "Manager" — plans work for the team;
                                       // (future) creates calendar tasks. Auto-grants file + chat access.
const USER_ROLE_BLOCKED = 'blocked';
const USER_ROLE_SET = new Set([USER_ROLE_ADMIN, USER_ROLE_MANAGER, USER_ROLE_PLANNER, USER_ROLE_BLOCKED]);

// Trust reverse proxy (Traefik) so secure cookies work behind TLS
app.set('trust proxy', 1);

const shouldBypassBodyParsing = (req) => {
  const urlPath = req.url || '';
  return PROXY_PREFIXES.some((prefix) => urlPath.startsWith(prefix));
};

const jsonParser = express.json();
const urlencodedParser = express.urlencoded({ extended: true });

app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
  },
}));
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

const DATA_DIR = process.env.HUB_DATA_DIR ? path.resolve(process.env.HUB_DATA_DIR) : null;
const DEFAULT_SERVICES_FILE = path.join(__dirname, 'services.json');
const DEFAULT_CONFIG_FILE = path.join(__dirname, 'config.json');
const SERVICES_FILE = process.env.HUB_SERVICES_FILE
  ? path.resolve(process.env.HUB_SERVICES_FILE)
  : (DATA_DIR ? path.join(DATA_DIR, 'services.json') : DEFAULT_SERVICES_FILE);
const CONFIG_FILE = process.env.HUB_CONFIG_FILE
  ? path.resolve(process.env.HUB_CONFIG_FILE)
  : (DATA_DIR ? path.join(DATA_DIR, 'config.json') : DEFAULT_CONFIG_FILE);
const ADMIN_STORE_FILE = process.env.HUB_ADMIN_STORE_FILE
  ? path.resolve(process.env.HUB_ADMIN_STORE_FILE)
  : (DATA_DIR ? path.join(DATA_DIR, 'admin.json') : path.join(__dirname, 'admin.json'));
const UPLOAD_DIR = path.join(__dirname, 'static', 'uploads');
const TEMP_DIR = path.join(UPLOAD_DIR, 'tmp');

// --- Push notifications (P3): APNs config + device-registry path ---
const APNS_KEY_ID = process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '';
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || '';
const APNS_ENV = (process.env.APNS_ENV || 'production').toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
// Shared secret for service2 -> hub internal calls (e.g. submit-failure push). Feature is
// disabled (endpoint 401s) until this is set in the stack env on both services.
const HUB_INTERNAL_TOKEN = process.env.HUB_INTERNAL_TOKEN || '';
// service2 base URL on the internal network — used to pull feedback attachment bytes back
// so they can be re-posted as real chat attachments in the Feedback & reports feed.
const SERVICE2_INTERNAL_URL = (process.env.SERVICE2_INTERNAL_URL || 'http://service2:3001').replace(/\/+$/, '');

// AI Assistant chat-bot (LinArt AI Consultant, LSC LED tenant). The hub relays a user's
// message in their private "AI Assistant" chat to the platform ask API and posts the
// answer back as the `assistant` participant. Origin must be an allowed domain on the
// platform tenant. Set AI_ASSISTANT_ENABLED=false to turn the bot off.
const AI_ASSISTANT_URL = (process.env.AI_ASSISTANT_URL || 'https://ai.crm-iot.com').replace(/\/+$/, '');
const AI_ASSISTANT_CLIENT_ID = process.env.AI_ASSISTANT_CLIENT_ID || '31';
const AI_ASSISTANT_ORIGIN = process.env.AI_ASSISTANT_ORIGIN || 'https://lsc-led.de';
const AI_ASSISTANT_ENABLED = String(process.env.AI_ASSISTANT_ENABLED || 'true').toLowerCase() !== 'false';
// Process boot time — surfaced in /api/status as hub.startedAt so a deploy can be verified
// even for hub-only changes (service2 doesn't restart, so its uptime is not a hub signal).
const HUB_STARTED_AT = new Date().toISOString();
const PUSH_DEVICES_FILE = process.env.HUB_PUSH_DEVICES_FILE
  ? path.resolve(process.env.HUB_PUSH_DEVICES_FILE)
  : (DATA_DIR ? path.join(DATA_DIR, 'push-devices.json') : path.join(__dirname, 'push-devices.json'));
const AUDIT_FILE = process.env.HUB_AUDIT_FILE
  ? path.resolve(process.env.HUB_AUDIT_FILE)
  : (DATA_DIR ? path.join(DATA_DIR, 'audit.jsonl') : path.join(__dirname, 'audit.jsonl'));
let APNS_PRIVATE_KEY = null;
(function loadApnsKey() {
  try {
    if (process.env.APNS_KEY_P8_BASE64) {
      APNS_PRIVATE_KEY = Buffer.from(process.env.APNS_KEY_P8_BASE64, 'base64').toString('utf8');
    } else if (process.env.APNS_KEY_PATH && fs.existsSync(process.env.APNS_KEY_PATH)) {
      APNS_PRIVATE_KEY = fs.readFileSync(process.env.APNS_KEY_PATH, 'utf8');
    }
    if (APNS_PRIVATE_KEY) crypto.createPrivateKey(APNS_PRIVATE_KEY); // validate or throw
  } catch (err) {
    console.warn('[hub] APNs private key failed to load:', err.message);
    APNS_PRIVATE_KEY = null;
  }
})();
function apnsConfigured() {
  return !!(APNS_KEY_ID && APNS_TEAM_ID && APNS_BUNDLE_ID && APNS_PRIVATE_KEY);
}
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
  // AI Assistant chat widget (LinArt AI Consultant). Shown as a bottom-right popup to
  // logged-in users on the hub web. Appearance (colour/logo/greeting) is configured on
  // the platform (ai.crm-iot.com) for this clientId.
  aiWidget: { enabled: true, clientId: '31', apiUrl: 'https://ai.crm-iot.com' },
};
const DEFAULT_ADMIN_PASSWORD = HUB_ADMIN_PASSWORD;
const DEFAULT_ADMIN_USERNAME = 'admin';
const DISABLE_UPLOADS = process.env.DISABLE_UPLOADS === '1';
const FORCE_ADMIN_PASSWORD = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.HUB_ADMIN_PASSWORD_FORCE || '').trim().toLowerCase()
);

function ensureDir(dirPath) {
  if (!dirPath) return;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    // ignore mkdir errors here; file ops will surface issues
  }
}

function seedFile(targetPath, fallbackPath, fallbackContent) {
  if (!targetPath || fs.existsSync(targetPath)) return;
  if (fallbackPath && fs.existsSync(fallbackPath)) {
    fs.copyFileSync(fallbackPath, targetPath);
    return;
  }
  if (fallbackContent !== undefined) {
    fs.writeFileSync(targetPath, fallbackContent);
  }
}

ensureDir(DATA_DIR);
ensureDir(path.dirname(ADMIN_STORE_FILE));
if (DATA_DIR) {
  seedFile(SERVICES_FILE, DEFAULT_SERVICES_FILE, JSON.stringify([], null, 2));
  seedFile(CONFIG_FILE, DEFAULT_CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });
if (DISABLE_UPLOADS) {
  console.warn('[hub] DISABLE_UPLOADS=1 is set: upload endpoints are disabled.');
}

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

  const aw = (merged.aiWidget && typeof merged.aiWidget === 'object') ? merged.aiWidget : {};
  merged.aiWidget = {
    enabled: aw.enabled !== false,
    clientId: (typeof aw.clientId === 'string' && aw.clientId.trim()) ? aw.clientId.trim() : DEFAULT_CONFIG.aiWidget.clientId,
    apiUrl: (typeof aw.apiUrl === 'string' && /^https?:\/\//i.test(aw.apiUrl.trim())) ? aw.apiUrl.trim().replace(/\/+$/, '') : DEFAULT_CONFIG.aiWidget.apiUrl,
  };

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
      const normalized = {
        users: Array.isArray(data.users)
          ? data.users
              .map((user) => {
                if (!user || typeof user !== 'object') return null;
                const username = typeof user.username === 'string' ? user.username.trim() : '';
                const passwordHash = typeof user.passwordHash === 'string' ? user.passwordHash : '';
                if (!username || !passwordHash) return null;
                const normalizedUser = {
                  username,
                  passwordHash,
                  allowedServices: normalizeAllowedServices(user.allowedServices),
                  role: normalizeUserRole(user.role, USER_ROLE_MANAGER),
                  canViewFiles: normalizeFilesAccess(user.canViewFiles, false),
                  canGenerateLinks: normalizeFilesAccess(user.canGenerateLinks, false),
                  canDeleteFiles: normalizeFilesAccess(user.canDeleteFiles, false),
                  canUseChat: user.canUseChat !== false,
                };
                // Preserve account-lifecycle fields (Apple deletion flow) across reloads.
                if (user.appReviewProtected === true) normalizedUser.appReviewProtected = true;
                if (user.pendingDeletion && typeof user.pendingDeletion === 'object') {
                  normalizedUser.pendingDeletion = user.pendingDeletion;
                }
                if (user.twoFactor && typeof user.twoFactor === 'object') {
                  normalizedUser.twoFactor = user.twoFactor;
                }
                return normalizedUser;
              })
              .filter(Boolean)
          : [],
      };
      if (data.passwordHash) {
        normalized.superadmin = { username: DEFAULT_ADMIN_USERNAME, passwordHash: data.passwordHash };
      } else if (data.superadmin && data.superadmin.passwordHash) {
        normalized.superadmin = {
          username: data.superadmin.username || DEFAULT_ADMIN_USERNAME,
          passwordHash: data.superadmin.passwordHash,
        };
        if (data.superadmin.twoFactor && typeof data.superadmin.twoFactor === 'object') {
          normalized.superadmin.twoFactor = data.superadmin.twoFactor;
        }
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

function getSuperadminHash(credentials) {
  if (credentials && credentials.superadmin && typeof credentials.superadmin.passwordHash === 'string') {
    return credentials.superadmin.passwordHash;
  }
  if (credentials && typeof credentials.passwordHash === 'string') {
    return credentials.passwordHash;
  }
  return null;
}

function buildSuperadminCredentials(existing, password) {
  const username =
    existing && existing.superadmin && typeof existing.superadmin.username === 'string' && existing.superadmin.username.trim()
      ? existing.superadmin.username.trim()
      : DEFAULT_ADMIN_USERNAME;
  const users = Array.isArray(existing && existing.users) ? existing.users : [];
  const passwordHash = bcrypt.hashSync(password, 10);
  const superadmin = { username, passwordHash };
  if (existing && existing.superadmin && existing.superadmin.twoFactor) {
    superadmin.twoFactor = existing.superadmin.twoFactor;
  }
  return { superadmin, users };
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

function normalizeUserRole(value, fallback = USER_ROLE_MANAGER) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (USER_ROLE_SET.has(raw)) return raw;
  return USER_ROLE_SET.has(fallback) ? fallback : USER_ROLE_MANAGER;
}

function normalizeFilesAccess(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function resolveFilesAccess(role, isSuperadmin, canViewFiles) {
  // Manager (planner) auto-grants file access (view / generate links / delete) like admin.
  if (isSuperadmin || role === USER_ROLE_ADMIN || role === USER_ROLE_PLANNER) return true;
  if (role === USER_ROLE_BLOCKED) return false;
  return Boolean(canViewFiles);
}

// Chat access defaults to ENABLED for managers (undefined -> true); admins always
// on, blocked always off. Differs from file perms, which default off.
function resolveChatAccess(role, isSuperadmin, canUseChat) {
  if (isSuperadmin || role === USER_ROLE_ADMIN || role === USER_ROLE_PLANNER) return true;
  if (role === USER_ROLE_BLOCKED) return false;
  return canUseChat !== false;
}

function normalizeSessionUser(user) {
  if (!user || typeof user !== 'object') return null;
  const username = typeof user.username === 'string' ? user.username.trim() : '';
  if (!username) return null;
  const isSuperadmin = Boolean(user.isSuperadmin);
  const allowedServices = Array.isArray(user.allowedServices) ? user.allowedServices : [];
  const role = normalizeUserRole(
    user.role,
    isSuperadmin ? USER_ROLE_ADMIN : USER_ROLE_MANAGER
  );
  const canViewFiles = resolveFilesAccess(
    role,
    isSuperadmin,
    normalizeFilesAccess(user.canViewFiles, false)
  );
  const canGenerateLinks = resolveFilesAccess(
    role,
    isSuperadmin,
    normalizeFilesAccess(user.canGenerateLinks, false)
  );
  const canDeleteFiles = resolveFilesAccess(
    role,
    isSuperadmin,
    normalizeFilesAccess(user.canDeleteFiles, false)
  );
  const canUseChat = resolveChatAccess(role, isSuperadmin, user.canUseChat);
  return { username, isSuperadmin, allowedServices, role, canViewFiles, canGenerateLinks, canDeleteFiles, canUseChat };
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
if (FORCE_ADMIN_PASSWORD) {
  try {
    const existingHash = getSuperadminHash(adminCredentials);
    const matches = existingHash ? bcrypt.compareSync(HUB_ADMIN_PASSWORD, existingHash) : false;
    if (!matches) {
      const next = buildSuperadminCredentials(adminCredentials, HUB_ADMIN_PASSWORD);
      saveAdminCredentials(next);
      console.warn('[hub] HUB_ADMIN_PASSWORD_FORCE=1: superadmin password reset from env.');
    } else {
      console.warn('[hub] HUB_ADMIN_PASSWORD_FORCE=1: superadmin password already matches env.');
    }
  } catch (err) {
    console.warn('[hub] Failed to apply HUB_ADMIN_PASSWORD_FORCE', err);
  }
}

function getBearerAuthToken(req) {
  const header = req.get ? req.get('authorization') || '' : '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function getSessionUser(req) {
  if (req.session && req.session.user) {
    const normalized = normalizeSessionUser(req.session.user);
    if (normalized && (!req.session.user.role || req.session.user.role !== normalized.role)) {
      req.session.user = normalized;
    }
    return normalized;
  }
  const token = req.cookies ? req.cookies[ADMIN_AUTH_COOKIE] : null;
  if (token) {
    const user = parseAdminAuthToken(token);
    if (user) {
      setSessionUser(req, user);
      return user;
    }
  }
  // Mobile/API clients: Authorization: Bearer <token> (same signed payload as cookie).
  const bearer = getBearerAuthToken(req);
  if (bearer) {
    const user = parseAdminAuthToken(bearer);
    if (user) return user;
  }
  return null;
}

function setSessionUser(req, user) {
  if (req.session) {
    req.session.user = normalizeSessionUser(user);
  }
}

function clearSessionUser(req) {
  if (req.session) {
    req.session.user = null;
    req.session.authenticated = false;
  }
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  if (!input) return '';
  const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signAdminPayload(payload) {
  return base64UrlEncode(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
}

function buildAdminAuthToken(user) {
  const normalized = normalizeSessionUser(user);
  if (!normalized) return '';
  const payload = JSON.stringify({
    u: normalized.username,
    a: normalized.isSuperadmin ? 1 : 0,
    r: normalized.role,
    f: normalized.canViewFiles ? 1 : 0,
    g: normalized.canGenerateLinks ? 1 : 0,
    d: normalized.canDeleteFiles ? 1 : 0,
    c: normalized.canUseChat ? 1 : 0,
    s: Array.isArray(normalized.allowedServices) ? normalized.allowedServices : [],
    t: Date.now(),
  });
  const encoded = base64UrlEncode(payload);
  const sig = signAdminPayload(payload);
  return `${encoded}.${sig}`;
}

function parseAdminAuthToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const payload = base64UrlDecode(encoded);
  if (!payload) return null;
  const expectedSig = signAdminPayload(payload);
  const sigBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expectedSig);
  if (sigBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;
  let data;
  try {
    data = JSON.parse(payload);
  } catch (err) {
    return null;
  }
  if (!data || !data.u || !data.t) return null;
  if (Date.now() - Number(data.t) > ADMIN_AUTH_TTL_MS) return null;
  const isSuperadmin = data.a === 1;
  const role = normalizeUserRole(data.r, isSuperadmin ? USER_ROLE_ADMIN : USER_ROLE_MANAGER);
  const canViewFiles = normalizeFilesAccess(data.f, false);
  const canGenerateLinks = normalizeFilesAccess(data.g, false);
  const canDeleteFiles = normalizeFilesAccess(data.d, false);
  // Legacy tokens have no `c`; treat absence as enabled (default-on for chat).
  const canUseChat = data.c === 0 ? false : true;
  return normalizeSessionUser({
    username: String(data.u),
    isSuperadmin,
    role,
    canViewFiles,
    canGenerateLinks,
    canDeleteFiles,
    canUseChat,
    allowedServices: Array.isArray(data.s) ? data.s : [],
  });
}

function adminCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: ADMIN_AUTH_TTL_MS,
    path: '/',
  };
}

function setNoCache(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function getAllowedServiceSet(req) {
  const user = getSessionUser(req);
  if (!user) return null;
  if (user.isSuperadmin || user.role === USER_ROLE_ADMIN) return null;
  if (user.role === USER_ROLE_BLOCKED) return new Set();
  if (!Array.isArray(user.allowedServices) || user.allowedServices.length === 0) return null;
  return new Set(user.allowedServices.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
}

function isServiceAllowed(service, allowedSet, user) {
  if (user && user.role === USER_ROLE_BLOCKED) return false;

  // Public services are always visible
  if (service.allowPublic) return true;

  // Unauthenticated users can only see public services
  if (!user) return false;

  // Superadmin/admin or user with no restrictions
  if (!allowedSet) return true;

  const id = (service.id || service.name || '').toLowerCase();
  const name = (service.name || '').toLowerCase();
  return allowedSet.has(id) || allowedSet.has(name);
}

function canUserViewFiles(user) {
  if (!user) return false;
  if (user.role === USER_ROLE_BLOCKED) return false;
  if (user.isSuperadmin || user.role === USER_ROLE_ADMIN || user.role === USER_ROLE_PLANNER) return true;
  return Boolean(user.canViewFiles);
}

function requireFilesAccess(req, res, next) {
  const user = getSessionUser(req);
  if (canUserViewFiles(user)) return next();
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    return res.redirect('/');
  }
  return res.status(403).send('Forbidden');
}

function requireFilesAdminAccess(req, res, next) {
  const user = getSessionUser(req);
  if (user && canUserViewFiles(user) && (user.isSuperadmin || user.role === USER_ROLE_ADMIN || user.role === USER_ROLE_PLANNER)) {
    return next();
  }
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    return res.redirect('/');
  }
  return res.status(403).send('Forbidden');
}

function attachHubProxyHeaders(req, _res, next) {
  // Strip any client-supplied hub headers first so they can't be spoofed, then
  // set them authoritatively from the authenticated session.
  delete req.headers['x-hub-role'];
  delete req.headers['x-hub-user'];
  delete req.headers['x-hub-can-generate-links'];
  delete req.headers['x-hub-can-delete-files'];
  const user = getSessionUser(req);
  if (user) {
    req.headers['x-hub-role'] = user.role || (user.isSuperadmin ? USER_ROLE_ADMIN : USER_ROLE_MANAGER);
    req.headers['x-hub-user'] = user.username;
    if (user.canGenerateLinks) req.headers['x-hub-can-generate-links'] = '1';
    if (user.canDeleteFiles) req.headers['x-hub-can-delete-files'] = '1';
  }
  next();
}

// Delete any client-supplied hub headers without setting new ones. Applied to the
// open dynamic service proxies so a caller can never spoof x-hub-* permissions.
function stripClientHubHeaders(req, _res, next) {
  delete req.headers['x-hub-role'];
  delete req.headers['x-hub-user'];
  delete req.headers['x-hub-can-generate-links'];
  delete req.headers['x-hub-can-delete-files'];
  next();
}

function resolveServiceAccess(serviceId, prefix) {
  const services = loadServices();
  const normalizedId = serviceId ? String(serviceId).trim().toLowerCase() : '';
  const byId =
    normalizedId
      ? services.find((s) => {
          const id = (s && (s.id || s.name) ? String(s.id || s.name) : '').trim().toLowerCase();
          return id && id === normalizedId;
        })
      : null;
  if (byId) return byId;
  const byPrefix =
    prefix && services.find((s) => s && typeof s.prefix === 'string' && s.prefix === prefix);
  if (byPrefix) return byPrefix;
  return { id: serviceId || prefix || 'service', name: serviceId || prefix || 'service', allowPublic: false };
}

function requireServiceAccess(serviceId, prefix) {
  return (req, res, next) => {
    const user = getSessionUser(req);
    const allowedSet = getAllowedServiceSet(req);
    const service = resolveServiceAccess(serviceId, prefix);
    if (isServiceAllowed(service, allowedSet, user)) {
      return next();
    }
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
      return res.redirect('/admin');
    }
    return res.status(403).send('Forbidden');
  };
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

// Simple per-IP rate limiter (login)
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
function rateLimitLogin(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  const bucket = loginAttempts.get(key) || { count: 0, ts: now };
  if (now - bucket.ts > LOGIN_WINDOW_MS) {
    bucket.count = 0;
    bucket.ts = now;
  }
  bucket.count += 1;
  loginAttempts.set(key, bucket);
  if (bucket.count > LOGIN_MAX_ATTEMPTS) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.ts + LOGIN_WINDOW_MS - now) / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({ ok: false, error: 'too_many_attempts', retryAfter: retryAfterSec });
  }
  return next();
}

// Basic same-origin guard for admin POST-like requests
function requireSameOrigin(req, res, next) {
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) return next();
  const origin = req.get('origin') || '';
  const referer = req.get('referer') || '';
  const host = req.get('host') || '';
  const isSameOrigin =
    (origin && origin.endsWith(host)) ||
    (referer && referer.includes(host));
  if (!isSameOrigin) {
    return res.status(403).json({ ok: false, error: 'invalid_origin' });
  }
  return next();
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
    app.use(s.prefix, stripClientHubHeaders, createProxyMiddleware({ target: s.target, changeOrigin: true, pathRewrite: { ['^'+s.prefix]: '' }, logLevel: 'warn' }));
  });
}

// Gate the service2 manager-stats path to admin/manager BEFORE the open dynamic
// proxy below catches /service2/*. (registerProxies mounts an unauthenticated
// catch-all for each service prefix; anything needing auth must be registered first.)
app.use('/service2/api/admin', requireDashboardAccess, attachHubProxyHeaders, createProxyMiddleware({
  target: 'http://service2:3001',
  changeOrigin: true,
  pathRewrite: { '^/service2': '' },
  logLevel: 'warn'
}));

// P4 approval: report review/status is admin/manager only; attach authoritative
// x-hub-user / x-hub-role so service2 records who reviewed. Must precede registerProxies.
app.use('/service2/api/reports', requireDashboardAccess, attachHubProxyHeaders, createProxyMiddleware({
  target: 'http://service2:3001',
  changeOrigin: true,
  pathRewrite: { '^/service2': '' },
  logLevel: 'warn'
}));

// Sign endpoints (service2 gates them on x-hub-can-generate-links). Registered
// BEFORE registerProxies' open /service2 catch-all so the authoritative header is
// attached: admin/superadmin and canGenerateLinks managers pass; others get 403,
// and attachHubProxyHeaders strips any spoofed header first.
app.use('/service2/api/sign', requireServiceAccess('service2', '/service2'), attachHubProxyHeaders, createProxyMiddleware({
  target: 'http://service2:3001',
  changeOrigin: true,
  pathRewrite: { '^/service2': '' },
  logLevel: 'warn'
}));

// Trash / soft-delete (issue #1): recycle bin for report files. Same admin gate as the
// hard-delete route. Registered BEFORE registerProxies' open /service2 catch-all so the
// authoritative x-hub-* headers are attached (deletedBy from x-hub-user; service2
// re-checks x-hub-can-delete-files) and a caller can't reach it unauthenticated. Literal
// /trash* routes precede the :type/:filename param routes so they aren't captured by them.
const service2TrashProxy = createProxyMiddleware({
  target: 'http://service2:3001',
  changeOrigin: true,
  pathRewrite: { '^/service2': '' },
  logLevel: 'warn'
});
app.get('/service2/api/files/trash/settings', requireFilesAdminAccess, attachHubProxyHeaders, service2TrashProxy);
app.put('/service2/api/files/trash/settings', requireFilesAdminAccess, attachHubProxyHeaders, service2TrashProxy);
app.post('/service2/api/files/trash/empty', requireFilesAdminAccess, attachHubProxyHeaders, service2TrashProxy);
app.get('/service2/api/files/trash', requireFilesAdminAccess, attachHubProxyHeaders, service2TrashProxy);
app.post('/service2/api/files/:type/:filename/trash', requireFilesAdminAccess, attachHubProxyHeaders, service2TrashProxy);
app.post('/service2/api/files/:type/:filename/restore', requireFilesAdminAccess, attachHubProxyHeaders, service2TrashProxy);
app.delete('/service2/api/files/:type/:filename/purge', requireFilesAdminAccess, attachHubProxyHeaders, service2TrashProxy);
// Legacy hard-delete + bulk-zip used by the web Files page. service2 gates both on
// delete permission; register them here (before registerProxies' open /service2
// catch-all) so an admin hub session attaches the authoritative x-hub-* headers and
// can delete/zip without the separate service2 admin password. Admin/superadmin only,
// matching the trash routes and the delete policy (managers get view/download only).
app.post('/service2/api/files/delete', requireFilesAdminAccess, attachHubProxyHeaders, service2TrashProxy);
app.post('/service2/api/files/zip', requireFilesAdminAccess, attachHubProxyHeaders, service2TrashProxy);

// In-app feedback / diagnostics (issue #1). Intake is any authenticated service2 user
// (same gate as report submit); management is admin/superadmin only. Registered before
// registerProxies' open /service2 catch-all so the authoritative x-hub-user is attached
// (records who reported) and admin routes can't be reached unauthenticated. Literal
// /admin/list precedes the /admin/:id param routes.
const service2FeedbackProxy = createProxyMiddleware({
  target: 'http://service2:3001',
  changeOrigin: true,
  pathRewrite: { '^/service2': '' },
  logLevel: 'warn'
});
app.post('/service2/api/feedback', requireServiceAccess('service2', '/service2'), attachHubProxyHeaders, service2FeedbackProxy);
app.get('/service2/api/feedback/admin/list', requireSuperadmin, attachHubProxyHeaders, service2FeedbackProxy);
app.get('/service2/api/feedback/admin/:id/attachments/:name', requireSuperadmin, attachHubProxyHeaders, service2FeedbackProxy);
app.get('/service2/api/feedback/admin/:id/logs', requireSuperadmin, attachHubProxyHeaders, service2FeedbackProxy);
app.get('/service2/api/feedback/admin/:id/form_archive', requireSuperadmin, attachHubProxyHeaders, service2FeedbackProxy);
app.get('/service2/api/feedback/admin/:id', requireSuperadmin, attachHubProxyHeaders, service2FeedbackProxy);
app.delete('/service2/api/feedback/admin/:id', requireSuperadmin, attachHubProxyHeaders, service2FeedbackProxy);

// register once on startup
registerProxies(app);

// Safer Referer-based proxy: only proxy when we can match a service by the Referer path.
// This avoids defaulting to an incorrect target (previously 'http://localhost') which
// caused ECONNREFUSED and 502 responses.
app.use(['/submit', '/suggest', '/api/suggest', '/upload'], (req, res, next) => {
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

// Web chat client (LSC LED Chat). Requires a session; chat-access is enforced by
// the /api/chat guard, and the page shows a friendly message on 403 chat_disabled.
app.get('/chat', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'static', 'chat.html'));
});

// Public legal/support pages (no auth) — required for Apple App Store review.
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'privacy.html'));
});
app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'support.html'));
});

// Simple pages
// Aggregated status API that queries each service health endpoint
app.get('/api/status', async (req, res) => {
  setNoCache(res);
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
    ok: true,
    services: results,
    hub: {
      now: new Date().toISOString(),
      startedAt: HUB_STARTED_AT,
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
      aiWidget: config.aiWidget,
      filtered: Boolean(allowed) || !user,
      user: user
        ? {
            username: user.username,
            isSuperadmin: user.isSuperadmin,
            role: user.role,
            canViewFiles: user.canViewFiles,
            canGenerateLinks: user.canGenerateLinks,
            canDeleteFiles: user.canDeleteFiles,
            canUseChat: user.canUseChat,
            allowedServices: user.allowedServices || [],
          }
        : null,
    },
  });
});

// Admin: login page
app.get('/admin', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (user && user.isSuperadmin) return res.sendFile(path.join(__dirname, 'static', 'admin.html'));
  return res.sendFile(path.join(__dirname, 'static', 'admin-login.html'));
});

// Shared credential check used by /admin/login (cookie session) and /api/auth/token (Bearer).
async function authenticateCredentials(usernameRaw, pass) {
  const normalizedUsername = (typeof usernameRaw === 'string' && usernameRaw.trim()) || DEFAULT_ADMIN_USERNAME;
  if (typeof pass !== 'string' || !pass.length) return null;
  let matchedUser = null;
  const superadmin = adminCredentials.superadmin;
  if (
    superadmin &&
    typeof superadmin.passwordHash === 'string' &&
    await bcrypt.compare(pass, superadmin.passwordHash) &&
    normalizedUsername === (superadmin.username || DEFAULT_ADMIN_USERNAME)
  ) {
    matchedUser = {
      username: superadmin.username || DEFAULT_ADMIN_USERNAME,
      isSuperadmin: true,
      role: USER_ROLE_ADMIN,
      allowedServices: [],
    };
  } else if (Array.isArray(adminCredentials.users)) {
    for (const user of adminCredentials.users) {
      if (!user || typeof user.username !== 'string' || typeof user.passwordHash !== 'string') continue;
      if (user.username.trim() !== normalizedUsername) continue;
      const ok = await bcrypt.compare(pass, user.passwordHash);
      if (ok) {
        // Logging in within the grace window cancels a pending account deletion.
        if (user.pendingDeletion) {
          delete user.pendingDeletion;
          try { saveAdminCredentials(adminCredentials); } catch (e) { /* best-effort */ }
        }
        matchedUser = {
          username: user.username.trim(),
          isSuperadmin: false,
          role: normalizeUserRole(user.role, USER_ROLE_MANAGER),
          canViewFiles: normalizeFilesAccess(user.canViewFiles, false),
          canGenerateLinks: normalizeFilesAccess(user.canGenerateLinks, false),
          canDeleteFiles: normalizeFilesAccess(user.canDeleteFiles, false),
          canUseChat: user.canUseChat,
          allowedServices: Array.isArray(user.allowedServices) ? user.allowedServices : [],
        };
        break;
      }
    }
  }
  if (!matchedUser && normalizedUsername === (superadmin && superadmin.username ? superadmin.username : DEFAULT_ADMIN_USERNAME)) {
    if (pass === HUB_ADMIN_PASSWORD) {
      matchedUser = { username: normalizedUsername, isSuperadmin: true, role: USER_ROLE_ADMIN, allowedServices: [] };
      try {
        const next = buildSuperadminCredentials(adminCredentials, HUB_ADMIN_PASSWORD);
        saveAdminCredentials(next);
        console.warn('[hub] Admin login matched HUB_ADMIN_PASSWORD; refreshed stored hash.');
      } catch (err) {
        console.warn('[hub] Failed to refresh admin credentials after env login', err);
      }
    }
  }
  return matchedUser;
}

// Look up current permissions for a known username (used by token refresh).
function buildSessionUserFromStore(username) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return null;
  const superadmin = adminCredentials.superadmin;
  const superName = (superadmin && superadmin.username) || DEFAULT_ADMIN_USERNAME;
  if (normalizedUsername === superName) {
    return normalizeSessionUser({ username: superName, isSuperadmin: true, role: USER_ROLE_ADMIN, allowedServices: [] });
  }
  if (Array.isArray(adminCredentials.users)) {
    for (const user of adminCredentials.users) {
      if (!user || typeof user.username !== 'string') continue;
      if (user.username.trim() !== normalizedUsername) continue;
      return normalizeSessionUser({
        username: user.username.trim(),
        isSuperadmin: false,
        role: normalizeUserRole(user.role, USER_ROLE_MANAGER),
        canViewFiles: normalizeFilesAccess(user.canViewFiles, false),
        canGenerateLinks: normalizeFilesAccess(user.canGenerateLinks, false),
        canDeleteFiles: normalizeFilesAccess(user.canDeleteFiles, false),
        canUseChat: user.canUseChat,
        allowedServices: Array.isArray(user.allowedServices) ? user.allowedServices : [],
      });
    }
  }
  return null;
}

app.post('/admin/login', rateLimitLogin, async (req, res) => {
  setNoCache(res);
  const username = (req.body && typeof req.body.username === 'string' && req.body.username.trim()) || DEFAULT_ADMIN_USERNAME;
  const pass = req.body && req.body.password;
  if (typeof pass !== 'string' || !pass.length) {
    return res.status(403).json({ ok: false, error: 'missing_credentials' });
  }
  try {
    const matchedUser = await authenticateCredentials(username, pass);

    if (matchedUser) {
      const rec2fa = find2faRecord(matchedUser);
      if (twoFactorRequired(rec2fa)) {
        const totp = req.body ? (req.body.totp || req.body.code) : null;
        const recovery = req.body ? req.body.recoveryCode : null;
        if (!verifyTwoFactor(rec2fa, totp, recovery)) {
          appendAudit('login_2fa_failed', { actor: matchedUser.username, ip: clientIp(req) });
          return res.status(401).json({ ok: false, error: (totp || recovery) ? 'invalid_totp' : 'totp_required' });
        }
      }
      req.session.authenticated = true;
      const normalized = normalizeSessionUser(matchedUser);
      setSessionUser(req, normalized);
      appendAudit('login', { actor: normalized.username, role: normalized.role, ip: clientIp(req) });
      res.cookie(ADMIN_AUTH_COOKIE, buildAdminAuthToken(normalized), adminCookieOptions());
      const payload = {
        ok: true,
        user: {
          username: normalized.username,
          isSuperadmin: normalized.isSuperadmin,
          role: normalized.role,
          canViewFiles: normalized.canViewFiles,
          allowedServices: normalized.allowedServices,
        },
      };
      const accept = req.headers.accept || '';
      if (accept.includes('text/html')) {
        return res.redirect(
          normalized.isSuperadmin || normalized.role === USER_ROLE_ADMIN ? '/admin' : '/'
        );
      }
      return res.json(payload);
    }
  } catch (err) {
    console.warn('[hub] Failed to compare admin password', err);
    return res.status(500).json({ ok: false, error: 'login_failed' });
  }
  appendAudit('login_failed', { actor: username, ip: clientIp(req) });
  return res.status(401).json({ ok: false, error: 'invalid_credentials' });
});

app.post('/api/logout', (req, res) => {
  clearSessionUser(req);
  if (req.session) {
    req.session.destroy(() => {});
  }
  res.clearCookie(ADMIN_AUTH_COOKIE, adminCookieOptions());
  res.json({ ok: true });
});

// --- Token auth for API/mobile clients (no cookies) ---

function buildTokenResponse(user) {
  return {
    ok: true,
    token: buildAdminAuthToken(user),
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + ADMIN_AUTH_TTL_MS).toISOString(),
    user: {
      username: user.username,
      isSuperadmin: user.isSuperadmin,
      role: user.role,
      canViewFiles: user.canViewFiles,
      canGenerateLinks: user.canGenerateLinks,
      canDeleteFiles: user.canDeleteFiles,
      canUseChat: user.canUseChat,
      allowedServices: user.allowedServices || [],
    },
  };
}

// Login with credentials, receive a Bearer token (send as `Authorization: Bearer <token>`).
app.post('/api/auth/token', rateLimitLogin, async (req, res) => {
  setNoCache(res);
  const username = req.body && typeof req.body.username === 'string' ? req.body.username : '';
  const pass = req.body && req.body.password;
  if (typeof pass !== 'string' || !pass.length) {
    return res.status(403).json({ ok: false, error: 'missing_credentials' });
  }
  try {
    const matchedUser = await authenticateCredentials(username, pass);
    if (!matchedUser) return res.status(403).json({ ok: false, error: 'forbidden' });
    const rec2fa = find2faRecord(matchedUser);
    if (twoFactorRequired(rec2fa)) {
      const totp = req.body ? (req.body.totp || req.body.code) : null;
      const recovery = req.body ? req.body.recoveryCode : null;
      if (!verifyTwoFactor(rec2fa, totp, recovery)) {
        return res.status(401).json({ ok: false, error: (totp || recovery) ? 'invalid_totp' : 'totp_required' });
      }
    }
    const normalized = normalizeSessionUser(matchedUser);
    return res.json(buildTokenResponse(normalized));
  } catch (err) {
    console.warn('[hub] /api/auth/token failed', err);
    return res.status(500).json({ ok: false, error: 'login_failed' });
  }
});

// Exchange a still-valid token for a fresh one; permissions are re-read from the user store.
app.post('/api/auth/refresh', (req, res) => {
  setNoCache(res);
  const current = getSessionUser(req);
  if (!current) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const fresh = buildSessionUserFromStore(current.username);
  if (!fresh || fresh.role === USER_ROLE_BLOCKED) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  return res.json(buildTokenResponse(fresh));
});

// Current user info (works with both cookie and Bearer auth).
app.get('/api/auth/me', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  return res.json({
    ok: true,
    user: {
      username: user.username,
      isSuperadmin: user.isSuperadmin,
      role: user.role,
      canViewFiles: user.canViewFiles,
      canGenerateLinks: user.canGenerateLinks,
      canDeleteFiles: user.canDeleteFiles,
      canUseChat: user.canUseChat,
      allowedServices: user.allowedServices || [],
    },
  });
});

// --- Account self-deletion (Apple App Store Guideline 5.1.1(v)) ---
// Works with cookie OR Bearer auth (uses getSessionUser, not requireAuth, since
// mobile clients authenticate via the hub_admin_auth cookie / Authorization header).
const ACCOUNT_DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

app.post('/api/account/delete-request', (req, res) => {
  setNoCache(res);
  const current = getSessionUser(req);
  if (!current) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (current.isSuperadmin) {
    return res.status(403).json({ ok: false, error: 'cannot_delete_superadmin' });
  }
  const body = req.body || {};
  if (body.confirm !== true) {
    return res.status(400).json({ ok: false, error: 'confirmation_required' });
  }
  if (!Array.isArray(adminCredentials.users)) adminCredentials.users = [];
  const idx = adminCredentials.users.findIndex((u) => u && u.username === current.username);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'not_found' });

  const now = Date.now();
  const scheduledFor = new Date(now + ACCOUNT_DELETION_GRACE_MS).toISOString();
  adminCredentials.users[idx].pendingDeletion = {
    requestedAt: new Date(now).toISOString(),
    scheduledFor,
    ...(typeof body.reason === 'string' && body.reason.trim()
      ? { reason: body.reason.trim().slice(0, 500) }
      : {}),
  };
  saveAdminCredentials(adminCredentials);
  appendAudit('account_delete_request', { actor: current.username, scheduledFor, ip: clientIp(req) });

  // Revoke the current session + cookie so the client is signed out immediately.
  clearSessionUser(req);
  if (req.session) req.session.destroy(() => {});
  res.clearCookie(ADMIN_AUTH_COOKIE, adminCookieOptions());

  return res.json({ ok: true, scheduledFor });
});

function requireAuth(req, res, next){
  if (req.session && req.session.authenticated && getSessionUser(req)) return next();
  return res.status(401).send({ ok: false, error: 'unauthorized' });
}

function requireSuperadmin(req, res, next) {
  const user = getSessionUser(req);
  if (user && (user.isSuperadmin || user.role === USER_ROLE_ADMIN)) return next();
  return res.status(403).json({ ok: false, error: 'forbidden' });
}

// Admin API: list services
app.get('/admin/services', requireSuperadmin, (req, res) => {
  res.json(loadServices());
});

// Add service: { name, target, prefix }
app.post('/admin/services', requireSuperadmin, requireSameOrigin, (req, res) => {
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

app.delete('/admin/services/:name', requireSuperadmin, requireSameOrigin, (req, res) => {
  const name = req.params.name;
  let list = loadServices();
  list = list.filter(s=>s.name !== name);
  saveServices(list);
  res.json({ ok: true });
});

app.post('/admin/password', requireSuperadmin, requireSameOrigin, async (req, res) => {
  const body = req.body || {};
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  try {
    const superadmin = adminCredentials && adminCredentials.superadmin
      ? adminCredentials.superadmin
      : (adminCredentials && adminCredentials.passwordHash
        ? { username: DEFAULT_ADMIN_USERNAME, passwordHash: adminCredentials.passwordHash }
        : null);
    if (!superadmin || typeof superadmin.passwordHash !== 'string') {
      return res.status(500).json({ ok: false, error: 'missing_admin_credentials' });
    }
    const matches = await bcrypt.compare(currentPassword, superadmin.passwordHash);
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
    const users = Array.isArray(adminCredentials && adminCredentials.users) ? adminCredentials.users : [];
    const nextCredentials = {
      superadmin: {
        username:
          adminCredentials && adminCredentials.superadmin && adminCredentials.superadmin.username
            ? adminCredentials.superadmin.username
            : DEFAULT_ADMIN_USERNAME,
        passwordHash,
      },
      users,
    };
    saveAdminCredentials(nextCredentials);
    res.json({ ok: true });
  } catch (err) {
    console.error('[hub] Failed to update password', err);
    res.status(500).json({ ok: false, error: 'update_failed' });
  }
});

// Upload a service bundle (ZIP), build and run it on the project network (admin-only)
app.post('/admin/upload-service', requireSuperadmin, requireSameOrigin, (req, res, next) => {
  if (DISABLE_UPLOADS) {
    return res.status(403).json({ ok: false, error: 'uploads_disabled' });
  }
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
    const safetyArgs = ['--memory 512m', '--cpus 0.5', '--pids-limit 256'];
    const runCmd = [
      'docker run -d',
      `--name ${containerName}`,
      `--network ${network}`,
      safetyArgs.join(' '),
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

app.post('/admin/config', requireSuperadmin, requireSameOrigin, (req, res) => {
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

  if (Object.prototype.hasOwnProperty.call(body, 'aiWidget') && body.aiWidget && typeof body.aiWidget === 'object') {
    const cur = next.aiWidget || DEFAULT_CONFIG.aiWidget;
    next.aiWidget = {
      enabled: Object.prototype.hasOwnProperty.call(body.aiWidget, 'enabled') ? body.aiWidget.enabled !== false : cur.enabled,
      clientId: typeof body.aiWidget.clientId === 'string' && body.aiWidget.clientId.trim() ? body.aiWidget.clientId.trim() : cur.clientId,
      apiUrl: typeof body.aiWidget.apiUrl === 'string' && body.aiWidget.apiUrl.trim() ? body.aiWidget.apiUrl.trim() : cur.apiUrl,
    };
  }

  const saved = saveConfig(next);
  res.json({ ok: true, config: saved });
});

app.get('/admin/social-links', requireSuperadmin, (req, res) => {
  const config = loadConfig();
  res.json({ ok: true, links: config.socialLinks });
});

app.post('/admin/social-links', requireSuperadmin, requireSameOrigin, (req, res) => {
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

app.patch('/admin/social-links/:id', requireSuperadmin, requireSameOrigin, (req, res) => {
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

app.delete('/admin/social-links/:id', requireSuperadmin, requireSameOrigin, (req, res) => {
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
        role: normalizeUserRole(u.role, USER_ROLE_MANAGER),
        canViewFiles: normalizeFilesAccess(u.canViewFiles, false),
        canGenerateLinks: normalizeFilesAccess(u.canGenerateLinks, false),
        canDeleteFiles: normalizeFilesAccess(u.canDeleteFiles, false),
        canUseChat: u.canUseChat !== false,
      }))
    : [];
  res.json({ ok: true, users });
});

app.get('/admin/me', requireSuperadmin, (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  res.json({
    ok: true,
    user: {
      username: user.username,
      isSuperadmin: user.isSuperadmin,
      role: user.role,
      canViewFiles: user.canViewFiles,
      canGenerateLinks: user.canGenerateLinks,
      canDeleteFiles: user.canDeleteFiles,
      canUseChat: user.canUseChat,
      allowedServices: user.allowedServices || [],
    },
  });
});


app.post('/admin/users', requireSuperadmin, requireSameOrigin, async (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const allowedServices = normalizeAllowedServices(body.allowedServices);
  const role = normalizeUserRole(body.role, USER_ROLE_MANAGER);
  const rawFilesAccess = normalizeFilesAccess(body.canViewFiles, false);
  const canViewFiles = resolveFilesAccess(role, false, rawFilesAccess);
  const canGenerateLinks = resolveFilesAccess(role, false, normalizeFilesAccess(body.canGenerateLinks, false));
  const canDeleteFiles = resolveFilesAccess(role, false, normalizeFilesAccess(body.canDeleteFiles, false));
  const canUseChat = resolveChatAccess(role, false, body.canUseChat);
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
  const newUser = { username, passwordHash, allowedServices, role, canViewFiles, canGenerateLinks, canDeleteFiles, canUseChat };
  // appReviewProtected accounts are exempt from the account-deletion sweeper (Apple review account).
  if (body.appReviewProtected === true) newUser.appReviewProtected = true;
  adminCredentials.users.push(newUser);
  saveAdminCredentials(adminCredentials);
  appendAudit('user_created', { actor: (getSessionUser(req) || {}).username || null, target: username, role });
  res.json({ ok: true });
});

app.patch('/admin/users/:username', requireSuperadmin, requireSameOrigin, async (req, res) => {
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
  if (Object.prototype.hasOwnProperty.call(body, 'role')) {
    user.role = normalizeUserRole(body.role, USER_ROLE_MANAGER);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'appReviewProtected')) {
    if (body.appReviewProtected === true) user.appReviewProtected = true;
    else delete user.appReviewProtected;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'canViewFiles')) {
    user.canViewFiles = normalizeFilesAccess(body.canViewFiles, false);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'canGenerateLinks')) {
    user.canGenerateLinks = normalizeFilesAccess(body.canGenerateLinks, false);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'canDeleteFiles')) {
    user.canDeleteFiles = normalizeFilesAccess(body.canDeleteFiles, false);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'canUseChat')) {
    user.canUseChat = body.canUseChat !== false;
  }
  user.canUseChat = resolveChatAccess(
    normalizeUserRole(user.role, USER_ROLE_MANAGER),
    false,
    user.canUseChat
  );
  user.canViewFiles = resolveFilesAccess(
    normalizeUserRole(user.role, USER_ROLE_MANAGER),
    false,
    normalizeFilesAccess(user.canViewFiles, false)
  );
  user.canGenerateLinks = resolveFilesAccess(
    normalizeUserRole(user.role, USER_ROLE_MANAGER),
    false,
    normalizeFilesAccess(user.canGenerateLinks, false)
  );
  user.canDeleteFiles = resolveFilesAccess(
    normalizeUserRole(user.role, USER_ROLE_MANAGER),
    false,
    normalizeFilesAccess(user.canDeleteFiles, false)
  );
  if (typeof body.password === 'string' && body.password.length >= 4) {
    user.passwordHash = await bcrypt.hash(body.password, 10);
  }
  adminCredentials.users[idx] = user;
  saveAdminCredentials(adminCredentials);
  res.json({ ok: true });
});
app.delete('/admin/users/:username', requireSuperadmin, requireSameOrigin, (req, res) => {
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
  appendAudit('user_deleted', { actor: (getSessionUser(req) || {}).username || null, target: username });
  res.json({ ok: true });
});

app.post('/admin/upload-logo', requireSuperadmin, requireSameOrigin, (req, res, next) => {
  if (DISABLE_UPLOADS) {
    return res.status(403).json({ ok: false, error: 'uploads_disabled' });
  }
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

// --- Manager dashboard (P2): presence (heartbeat) + dashboard composition ---
const presence = new Map(); // username -> { lastSeen: ms, userAgent, appVersion }
const ONLINE_WINDOW_MS = 90 * 1000;

function isOnline(entry) {
  return entry && (Date.now() - entry.lastSeen) < ONLINE_WINDOW_MS;
}

// admin OR manager (not blocked) — managers get the dashboard on their phone.
function requireDashboardAccess(req, res, next) {
  const user = getSessionUser(req);
  if (user && (user.isSuperadmin || user.role === USER_ROLE_ADMIN || user.role === USER_ROLE_MANAGER || user.role === USER_ROLE_PLANNER)) {
    return next();
  }
  return res.status(403).json({ ok: false, error: 'forbidden' });
}

// Fetch the report-stats aggregation from service2 over the internal network.
async function fetchService2Stats() {
  let target = 'http://service2:3001';
  try {
    const svc = loadServices().find((s) => (s.id || s.name) === 'service2');
    if (svc && svc.target) target = svc.target;
  } catch (err) { /* fall back to default */ }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch(new URL('/api/admin/stats', target).toString(), { signal: controller.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// iOS sends this every ~60s to report presence (cookie or Bearer auth).
app.post('/api/heartbeat', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const wasOnline = isOnline(presence.get(user.username));
  presence.set(user.username, {
    lastSeen: Date.now(),
    userAgent: req.get('user-agent') || null,
    appVersion: (req.body && typeof req.body.appVersion === 'string') ? req.body.appVersion : null,
  });
  if (!wasOnline) broadcast('presence', { user: user.username, online: true }, true);
  const onlineCount = [...presence.values()].filter(isOnline).length;
  return res.json({ ok: true, onlineCount });
});

app.get('/admin/online', requireDashboardAccess, (req, res) => {
  setNoCache(res);
  const online = [...presence.entries()]
    .filter(([, v]) => isOnline(v))
    .map(([username, v]) => ({
      username,
      lastSeen: new Date(v.lastSeen).toISOString(),
      userAgent: v.userAgent,
      appVersion: v.appVersion,
    }));
  return res.json({ ok: true, count: online.length, online });
});

app.get('/admin/dashboard/overview', requireDashboardAccess, async (req, res) => {
  setNoCache(res);
  const users = Array.isArray(adminCredentials.users) ? adminCredentials.users : [];
  const totalUsers = users.length + (adminCredentials.superadmin ? 1 : 0);
  const onlineCount = [...presence.values()].filter(isOnline).length;
  const stats = await fetchService2Stats();
  return res.json({
    ok: true,
    users: totalUsers,
    online: onlineCount,
    reports: stats ? stats.totals.reportCount : null,
    storageBytes: stats ? stats.totals.totalBytes : null,
    byType: stats ? stats.byType : null,
  });
});

app.get('/admin/users/stats', requireDashboardAccess, async (req, res) => {
  setNoCache(res);
  const stats = await fetchService2Stats();
  const byUser = (stats && stats.byUser) || {};
  const users = Array.isArray(adminCredentials.users) ? adminCredentials.users : [];
  const list = users.map((u) => {
    const pres = presence.get(u.username);
    const us = byUser[u.username] || { reportCount: 0, bytes: 0, lastSubmittedAt: null, last7Days: 0 };
    return {
      username: u.username,
      role: normalizeUserRole(u.role, USER_ROLE_MANAGER),
      online: isOnline(pres),
      lastSeen: pres ? new Date(pres.lastSeen).toISOString() : null,
      reportCount: us.reportCount,
      bytes: us.bytes,
      last7Days: us.last7Days,
      lastSubmittedAt: us.lastSubmittedAt || null,
    };
  });
  // Surface report submitters that don't map to a hub user (e.g. legacy/owner_user_id mismatches).
  const known = new Set(users.map((u) => u.username));
  const unmatched = Object.keys(byUser).filter((k) => !known.has(k)).map((k) => ({ username: k, ...byUser[k] }));
  return res.json({ ok: true, users: list, unmatchedSubmitters: unmatched, statsAvailable: !!stats });
});

app.get('/admin/storage', requireDashboardAccess, async (req, res) => {
  setNoCache(res);
  const stats = await fetchService2Stats();
  if (!stats) return res.status(502).json({ ok: false, error: 'stats_unavailable' });
  return res.json({ ok: true, totals: stats.totals, byType: stats.byType, byMonth: stats.byMonth, byUser: stats.byUser });
});

// --- Push notifications (P3): device registry + APNs sender ---
function loadPushDevices() {
  try {
    const data = JSON.parse(fs.readFileSync(PUSH_DEVICES_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    return [];
  }
}
function savePushDevices(list) {
  try {
    fs.writeFileSync(PUSH_DEVICES_FILE, JSON.stringify(list, null, 2));
  } catch (err) {
    console.warn('[hub] push-devices save failed', err.message);
  }
}

// APNs provider JWT (ES256), reusable up to ~60 min — cache for 40.
let _apnsJwt = { token: null, at: 0 };
function apnsJwt() {
  const now = Date.now();
  if (_apnsJwt.token && (now - _apnsJwt.at) < 40 * 60 * 1000) return _apnsJwt.token;
  const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', kid: APNS_KEY_ID }));
  const claims = base64UrlEncode(JSON.stringify({ iss: APNS_TEAM_ID, iat: Math.floor(now / 1000) }));
  const input = `${header}.${claims}`;
  const sig = crypto.sign('SHA256', Buffer.from(input), {
    key: crypto.createPrivateKey(APNS_PRIVATE_KEY),
    dsaEncoding: 'ieee-p1363',
  });
  _apnsJwt = { token: `${input}.${base64UrlEncode(sig)}`, at: now };
  return _apnsJwt.token;
}

// Send one notification to one device token over APNs HTTP/2. Never throws.
function apnsSend(deviceToken, payload, pushType) {
  return new Promise((resolve) => {
    const host = APNS_ENV === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const body = Buffer.from(JSON.stringify(payload));
    let client;
    try {
      client = http2.connect(host);
    } catch (e) {
      return resolve({ ok: false, status: 0, error: e.message });
    }
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } try { client.close(); } catch (e) { /* noop */ } };
    client.on('error', (e) => done({ ok: false, status: 0, error: e.message }));
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${apnsJwt()}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': pushType || 'alert',
      'content-type': 'application/json',
      'content-length': body.length,
    });
    let status = 0; let data = '';
    req.on('response', (h) => { status = h[':status']; });
    req.setEncoding('utf8');
    req.on('data', (d) => { data += d; });
    req.on('end', () => done({ ok: status === 200, status, body: data }));
    req.on('error', (e) => done({ ok: false, status: 0, error: e.message }));
    req.end(body);
  });
}

// Send to every device a user registered; prune tokens APNs reports dead.
async function sendPushToUser(username, payload, pushType) {
  if (!apnsConfigured()) return { ok: false, error: 'apns_not_configured', sent: 0 };
  const devices = loadPushDevices();
  const mine = devices.filter((d) => d && d.username === username);
  let sent = 0;
  const results = [];
  const dead = new Set();
  for (const d of mine) {
    const r = await apnsSend(d.token, payload, pushType);
    results.push({ token: String(d.token).slice(0, 8) + '…', status: r.status, ok: r.ok });
    if (r.ok) sent += 1;
    if (r.status === 410 || (r.status === 400 && /BadDeviceToken/i.test(r.body || ''))) dead.add(d.token);
  }
  if (dead.size) savePushDevices(devices.filter((d) => !dead.has(d.token)));
  return { ok: true, sent, total: mine.length, results };
}

// Usernames of admin/superadmin accounts (the people who manage feedback).
function adminUsernames() {
  const names = new Set();
  const su = adminCredentials && adminCredentials.superadmin;
  names.add((su && su.username) || DEFAULT_ADMIN_USERNAME);
  if (adminCredentials && Array.isArray(adminCredentials.users)) {
    for (const u of adminCredentials.users) {
      if (u && typeof u.username === 'string'
        && normalizeUserRole(u.role, USER_ROLE_MANAGER) === USER_ROLE_ADMIN) {
        names.add(u.username.trim());
      }
    }
  }
  return names;
}

// Fan a push out to every admin's registered devices.
async function sendPushToAdmins(payload, pushType) {
  if (!apnsConfigured()) return { ok: false, error: 'apns_not_configured', sent: 0, total: 0 };
  let sent = 0;
  let total = 0;
  const admins = adminUsernames();
  for (const name of admins) {
    const r = await sendPushToUser(name, payload, pushType);
    sent += r.sent || 0;
    total += r.total || 0;
  }
  return { ok: true, sent, total, admins: admins.size };
}

// Internal (service2 -> hub): a new in-app feedback item arrived. Drop it into the
// admin-only chat feed; for submit_failure also push admins via APNs. Token-gated (not a
// user session); reached over the internal network, never a browser. Not under /service2,
// so the open proxy catch-all doesn't shadow it.
app.post('/internal/notify/feedback', async (req, res) => {
  const token = String(req.headers['x-internal-token'] || '');
  if (!HUB_INTERNAL_TOKEN || token !== HUB_INTERNAL_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const b = req.body || {};
  const ctx = (b.context && typeof b.context === 'object') ? b.context : {};
  const who = String(b.username || ctx.username || 'An engineer').slice(0, 80);

  // Always surface it in the admin-only Feedback & reports chat feed.
  const chatPosted = postFeedbackToChat({
    id: b.feedbackId,
    kind: b.kind,
    username: b.username,
    message: b.message,
    context: ctx,
    attachmentCount: b.attachmentCount,
  });

  // Then re-post the uploaded files as real chat attachments (photos/voice show inline).
  // Fire-and-forget so this internal notify returns fast for service2.
  if (Array.isArray(b.attachments) && b.attachments.length) {
    relayFeedbackAttachmentsToChat({
      id: b.feedbackId,
      kind: b.kind,
      username: b.username,
      attachments: b.attachments,
    });
  }

  // submit_failure means an engineer couldn't publish from the field → also push admins.
  let push = { skipped: true };
  if (b.kind === 'submit_failure') {
    const deviceBits = [ctx.deviceModel, ctx.appVersion || ctx.build].filter(Boolean).join(' · ');
    console.log(`[hub] submit-failure push requested: feedback=${b.feedbackId || '?'} who=${who}`);
    const payload = {
      aps: {
        alert: {
          title: 'Report submission failed',
          body: `${who} couldn't publish a report from the field${deviceBits ? ` (${deviceBits})` : ''}.`,
        },
        sound: 'default',
      },
      kind: 'submit_failure',
      feedbackId: b.feedbackId || null,
    };
    try {
      push = await sendPushToAdmins(payload, 'alert');
    } catch (err) {
      console.warn('[hub] submit-failure push failed:', err && err.message);
      push = { ok: false, error: 'push_failed' };
    }
  }
  return res.json({ ok: true, chatPosted, push });
});

app.post('/api/push/register', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const b = req.body || {};
  const token = typeof b.token === 'string' ? b.token.trim() : '';
  if (!token) return res.status(400).json({ ok: false, error: 'token_required' });
  const devices = loadPushDevices();
  const entry = {
    token,
    username: user.username,
    platform: typeof b.platform === 'string' ? b.platform : 'ios',
    environment: b.environment === 'sandbox' ? 'sandbox' : (b.environment === 'production' ? 'production' : APNS_ENV),
    appVersion: typeof b.appVersion === 'string' ? b.appVersion : null,
    locale: typeof b.locale === 'string' ? b.locale : null,
    updatedAt: new Date().toISOString(),
  };
  const idx = devices.findIndex((d) => d && d.token === token);
  if (idx >= 0) devices[idx] = entry; else devices.push(entry);
  savePushDevices(devices);
  return res.json({ ok: true, deviceId: token, apnsConfigured: apnsConfigured() });
});

app.delete('/api/push/register', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const token = (req.body && typeof req.body.token === 'string' && req.body.token.trim())
    || (typeof req.query.token === 'string' ? req.query.token.trim() : '');
  if (!token) return res.status(400).json({ ok: false, error: 'token_required' });
  const devices = loadPushDevices();
  const next = devices.filter((d) => !(d && d.token === token && d.username === user.username));
  savePushDevices(next);
  return res.json({ ok: true, removed: devices.length - next.length });
});

app.get('/api/push/devices', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const mine = loadPushDevices()
    .filter((d) => d && d.username === user.username)
    .map((d) => ({
      token: String(d.token).slice(0, 8) + '…',
      platform: d.platform, environment: d.environment, appVersion: d.appVersion, locale: d.locale, updatedAt: d.updatedAt,
    }));
  return res.json({ ok: true, devices: mine, apnsConfigured: apnsConfigured() });
});

// Push pipeline status (auth) — booleans only, no secrets.
app.get('/api/push/status', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  return res.json({
    ok: true,
    configured: apnsConfigured(),
    environment: APNS_ENV,
    hasKeyId: !!APNS_KEY_ID,
    hasTeamId: !!APNS_TEAM_ID,
    hasBundleId: !!APNS_BUNDLE_ID,
    hasKey: !!APNS_PRIVATE_KEY,
  });
});

// Send a test push to the caller's own devices (verifies the whole pipeline).
app.post('/api/push/test', async (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!apnsConfigured()) {
    return res.status(503).json({
      ok: false, error: 'apns_not_configured',
      need: { keyId: !!APNS_KEY_ID, teamId: !!APNS_TEAM_ID, bundleId: !!APNS_BUNDLE_ID, key: !!APNS_PRIVATE_KEY },
    });
  }
  const title = (req.body && typeof req.body.title === 'string') ? req.body.title : 'LinArt';
  const message = (req.body && typeof req.body.body === 'string') ? req.body.body : 'Push pipeline works ✅';
  const payload = { aps: { alert: { title, body: message }, sound: 'default' } };
  const result = await sendPushToUser(user.username, payload, 'alert');
  return res.json(result);
});

// --- Audit log + realtime SSE (P8) ---
const sseClients = new Set();
function ssePush(client, type, data) {
  try {
    client.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, at: new Date().toISOString(), ...data })}\n\n`);
  } catch (e) { /* client gone */ }
}
function broadcast(type, data, adminOnly) {
  for (const c of sseClients) {
    if (adminOnly && !c.isAdmin) continue;
    ssePush(c, type, data);
  }
}
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || null;
}
function appendAudit(event, fields) {
  const record = { at: new Date().toISOString(), event, ...fields };
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n');
  } catch (e) { /* best-effort */ }
  broadcast('audit', record, true);
}

// Live event stream (SSE). Auth required; admin/manager also receive presence + audit.
app.get('/api/events', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const client = {
    res,
    user: user.username,
    isAdmin: user.isSuperadmin || user.role === USER_ROLE_ADMIN || user.role === USER_ROLE_MANAGER,
  };
  sseClients.add(client);
  ssePush(client, 'ready', { user: user.username });
  const keepAlive = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch (e) { /* noop */ } }, 25000);
  req.on('close', () => { clearInterval(keepAlive); sseClients.delete(client); });
});

// Recent audit entries (admin/manager), newest first; optional ?event= / ?actor= / ?limit=.
app.get('/admin/audit', requireDashboardAccess, (req, res) => {
  setNoCache(res);
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 100;
  const eventFilter = typeof req.query.event === 'string' ? req.query.event : '';
  const actorFilter = typeof req.query.actor === 'string' ? req.query.actor : '';
  let lines = [];
  try { lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean); } catch (e) { lines = []; }
  const events = [];
  for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch (e) { continue; }
    if (eventFilter && o.event !== eventFilter) continue;
    if (actorFilter && o.actor !== actorFilter) continue;
    events.push(o);
  }
  res.json({ ok: true, total: events.length, events });
});

// --- Two-factor auth (P7): opt-in TOTP (RFC 6238), built on crypto, no deps ---
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]; bits += 8;
    while (bits >= 5) { out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { buf[i] = c & 0xff; c = Math.floor(c / 256); }
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}
function verifyTotp(secretBase32, code, window) {
  if (!secretBase32 || !/^\d{6}$/.test(String(code || ''))) return false;
  const secretBuf = base32Decode(secretBase32);
  const step = Math.floor(Date.now() / 1000 / 30);
  const w = Number.isInteger(window) ? window : 1;
  for (let i = -w; i <= w; i++) {
    if (hotp(secretBuf, step + i) === String(code)) return true;
  }
  return false;
}
function generateTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
function generateRecoveryCodes(n) {
  const codes = [];
  for (let i = 0; i < n; i++) codes.push(crypto.randomBytes(5).toString('hex'));
  return codes;
}
function hashRecovery(code) {
  return crypto.createHash('sha256').update(String(code).toLowerCase()).digest('hex');
}

// Resolve the *stored* account record (superadmin obj or users[] entry) for a session user.
function find2faRecord(user) {
  if (!user) return null;
  if (user.isSuperadmin) return adminCredentials.superadmin || null;
  return (Array.isArray(adminCredentials.users) ? adminCredentials.users : []).find((u) => u && u.username === user.username) || null;
}
function twoFactorRequired(rec) {
  return !!(rec && rec.twoFactor && rec.twoFactor.enabled && !rec.appReviewProtected);
}
// Returns true if the 2FA challenge passes (or isn't enabled). Consumes a recovery code if used.
function verifyTwoFactor(rec, totp, recoveryCode) {
  const tf = rec && rec.twoFactor;
  if (!tf || !tf.enabled) return true;
  if (totp && tf.secret && verifyTotp(tf.secret, totp)) return true;
  if (recoveryCode && Array.isArray(tf.recoveryCodes)) {
    const h = hashRecovery(recoveryCode);
    const idx = tf.recoveryCodes.indexOf(h);
    if (idx >= 0) { tf.recoveryCodes.splice(idx, 1); saveAdminCredentials(adminCredentials); return true; }
  }
  return false;
}

app.get('/api/2fa/status', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const tf = (find2faRecord(user) || {}).twoFactor;
  return res.json({
    ok: true,
    enabled: !!(tf && tf.enabled),
    pending: !!(tf && tf.pendingSecret && !tf.enabled),
    recoveryCodesRemaining: (tf && Array.isArray(tf.recoveryCodes)) ? tf.recoveryCodes.length : 0,
  });
});

app.post('/api/2fa/setup', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const rec = find2faRecord(user);
  if (!rec) return res.status(404).json({ ok: false, error: 'account_not_found' });
  const secret = generateTotpSecret();
  rec.twoFactor = Object.assign({}, rec.twoFactor, { pendingSecret: secret });
  saveAdminCredentials(adminCredentials);
  const otpauthUrl = `otpauth://totp/LinArt:${encodeURIComponent(user.username)}?secret=${secret}&issuer=LinArt&algorithm=SHA1&digits=6&period=30`;
  return res.json({ ok: true, secret, otpauthUrl });
});

app.post('/api/2fa/enable', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const rec = find2faRecord(user);
  if (!rec || !rec.twoFactor || !rec.twoFactor.pendingSecret) return res.status(400).json({ ok: false, error: 'no_pending_setup' });
  const code = req.body && (req.body.totp || req.body.code);
  if (!verifyTotp(rec.twoFactor.pendingSecret, code)) return res.status(400).json({ ok: false, error: 'invalid_totp' });
  const recoveryCodes = generateRecoveryCodes(8);
  rec.twoFactor = { enabled: true, secret: rec.twoFactor.pendingSecret, recoveryCodes: recoveryCodes.map(hashRecovery) };
  saveAdminCredentials(adminCredentials);
  appendAudit('2fa_enabled', { actor: user.username });
  return res.json({ ok: true, recoveryCodes });
});

app.post('/api/2fa/disable', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const rec = find2faRecord(user);
  if (!rec || !rec.twoFactor || !rec.twoFactor.enabled) return res.json({ ok: true, alreadyDisabled: true });
  const code = req.body && (req.body.totp || req.body.code);
  const recovery = req.body && req.body.recoveryCode;
  if (!verifyTwoFactor(rec, code, recovery)) return res.status(400).json({ ok: false, error: 'invalid_totp' });
  rec.twoFactor = { enabled: false };
  saveAdminCredentials(adminCredentials);
  appendAudit('2fa_disabled', { actor: user.username });
  return res.json({ ok: true });
});

// --- Team chat (P9 MVP): REST-only, flat JSON storage, clients poll ---
// direct = 1:1 between hub users (members only); project = open room per projectKey
// (visible to every authenticated user, author auto-joins on post); group = named,
// invite-only room with a hand-picked member list (only members see/post).
const CHAT_DIR = DATA_DIR ? path.join(DATA_DIR, 'chat') : path.join(__dirname, 'chat');
const CHAT_INDEX_FILE = path.join(CHAT_DIR, 'conversations.json');
const CHAT_BODY_MAX = 4000;

function chatSanitizeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
}
function loadChatIndex() {
  try {
    const data = JSON.parse(fs.readFileSync(CHAT_INDEX_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    return [];
  }
}
function saveChatIndex(list) {
  try {
    fs.mkdirSync(CHAT_DIR, { recursive: true });
    fs.writeFileSync(CHAT_INDEX_FILE, JSON.stringify(list, null, 2));
  } catch (err) {
    console.warn('[hub] chat index save failed', err.message);
  }
}

// Self-service chat display names: a user can set the name shown next to their messages.
// Stored as { username: "Vladimir" }; the shown label is "Vladimir(Admin)" (name + role).
const CHAT_NAMES_FILE = path.join(CHAT_DIR, 'display-names.json');
const CHAT_DISPLAY_NAME_MAX = 40;
function loadChatNames() {
  try {
    const data = JSON.parse(fs.readFileSync(CHAT_NAMES_FILE, 'utf8'));
    return (data && typeof data === 'object') ? data : {};
  } catch (err) {
    return {};
  }
}
function saveChatNames(map) {
  try {
    fs.mkdirSync(CHAT_DIR, { recursive: true });
    fs.writeFileSync(CHAT_NAMES_FILE, JSON.stringify(map, null, 2));
  } catch (err) {
    console.warn('[hub] chat names save failed', err.message);
  }
}
function getChatDisplayName(username) {
  const map = loadChatNames();
  const v = map[username];
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}
function setChatDisplayName(username, name) {
  const map = loadChatNames();
  const clean = String(name || '').replace(/[\r\n\t]/g, ' ').replace(/[()]/g, '').trim().slice(0, CHAT_DISPLAY_NAME_MAX);
  if (clean) map[username] = clean; else delete map[username];
  saveChatNames(map);
  return clean;
}
// Short role tag shown in parentheses after the name.
function chatRoleLabel(user) {
  if (!user) return '';
  if (user.isSuperadmin || user.role === USER_ROLE_ADMIN) return 'Admin';
  if (user.role === USER_ROLE_PLANNER) return 'Manager';
  if (user.role === USER_ROLE_MANAGER) return 'Engineer';
  return '';
}
// The label shown next to a user's chat messages: "Vladimir(Admin)" (or "username(Role)").
function formatChatAuthor(user) {
  const name = getChatDisplayName(user.username) || user.username;
  const tag = chatRoleLabel(user);
  return tag ? `${name}(${tag})` : name;
}
function chatMessagesPath(convId) {
  return path.join(CHAT_DIR, `msg_${chatSanitizeId(convId)}.jsonl`);
}
function readChatMessages(convId) {
  try {
    return fs.readFileSync(chatMessagesPath(convId), 'utf8')
      .split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}
function appendChatMessage(convId, message) {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  fs.appendFileSync(chatMessagesPath(convId), JSON.stringify(message) + '\n');
}
function knownHubUsername(name) {
  if (!name) return false;
  const superName = adminCredentials.superadmin && adminCredentials.superadmin.username;
  if (name === (superName || DEFAULT_ADMIN_USERNAME)) return true;
  return (Array.isArray(adminCredentials.users) ? adminCredentials.users : []).some((u) => u && u.username === name);
}
function isAdminUsername(name) {
  return !!name && adminUsernames().has(name);
}
function canSeeConversation(conv, username) {
  if (!conv) return false;
  // Admin-only rooms (e.g. the Feedback & reports feed) are visible to every admin,
  // regardless of explicit membership, and to no one else.
  if (conv.adminOnly) return isAdminUsername(username);
  if (conv.kind === 'project') return true;
  return Array.isArray(conv.memberUsernames) && conv.memberUsernames.includes(username);
}

// Admin-only chat feed that in-app feedback (bug / idea / submit_failure) lands in, so
// admins read reports right inside LSC LED Chat. Created lazily on the first report.
const FEEDBACK_CONV_ID = 'feedback-reports';
const FEEDBACK_KIND_LABEL = { submit_failure: 'Submit failure', bug: 'Bug', idea: 'Idea' };
function ensureFeedbackConversation() {
  const index = loadChatIndex();
  let conv = index.find((c) => c.id === FEEDBACK_CONV_ID);
  if (!conv) {
    conv = {
      id: FEEDBACK_CONV_ID,
      kind: 'group',
      adminOnly: true,
      title: '📋 Feedback & reports',
      memberUsernames: [],
      reads: {},
      createdAt: new Date().toISOString(),
    };
    index.push(conv);
    saveChatIndex(index);
  }
  return conv;
}
// Post a feedback item into the admin-only feed as a message "from" the reporting user.
function postFeedbackToChat(record) {
  try {
    ensureFeedbackConversation();
    const ctx = (record && record.context && typeof record.context === 'object') ? record.context : {};
    const author = String(record.username || ctx.username || 'unknown');
    const label = FEEDBACK_KIND_LABEL[record.kind] || record.kind || 'Feedback';
    const deviceBits = [ctx.deviceModel, ctx.appVersion || ctx.build].filter(Boolean).join(' · ');
    const lines = [`[${label}]${deviceBits ? ` ${deviceBits}` : ''}`];
    if (record.message) lines.push(String(record.message));
    const extras = [];
    if (record.attachmentCount) extras.push(`${record.attachmentCount} attachment(s)`);
    if (ctx.error) extras.push(`error: ${ctx.error}`);
    if (record.id) extras.push(`id ${record.id}`);
    if (extras.length) lines.push('— ' + extras.join(' · '));
    const message = {
      id: `m${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      conversationId: FEEDBACK_CONV_ID,
      authorId: author,
      authorDisplayName: author,
      kind: 'text',
      body: lines.join('\n').slice(0, CHAT_BODY_MAX),
      createdAt: new Date().toISOString(),
      feedback: { id: record.id || null, kind: record.kind || null },
    };
    appendChatMessage(FEEDBACK_CONV_ID, message);
    const index = loadChatIndex();
    const conv = index.find((c) => c.id === FEEDBACK_CONV_ID);
    if (conv) { conv.lastMessageAt = message.createdAt; saveChatIndex(index); }
    for (const c of sseClients) {
      if (isAdminUsername(c.user)) ssePush(c, 'chat', { conversationId: FEEDBACK_CONV_ID, message });
    }
    return true;
  } catch (err) {
    console.warn('[hub] postFeedbackToChat failed:', err && err.message);
    return false;
  }
}

// Pull a feedback item's stored attachments back from service2 and re-post them into the
// Feedback & reports feed as REAL chat attachments (image / audio / file), so admins see the
// photos and voice notes inline instead of just a "— N attachment(s)" count. Best-effort and
// fire-and-forget: the text summary is already posted; any file that can't be fetched is skipped.
async function relayFeedbackAttachmentsToChat(record) {
  try {
    const atts = Array.isArray(record.attachments) ? record.attachments : [];
    if (!atts.length || !record.id || !HUB_INTERNAL_TOKEN) return;
    ensureFeedbackConversation();
    const author = String(record.username || 'unknown');
    const dir = path.join(CHAT_ATTACH_DIR, chatSanitizeId(FEEDBACK_CONV_ID));
    fs.mkdirSync(dir, { recursive: true });
    for (const a of atts) {
      if (!a || !a.file) continue;
      try {
        const url = `${SERVICE2_INTERNAL_URL}/api/feedback/admin/${encodeURIComponent(record.id)}/attachments/${encodeURIComponent(a.file)}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        // Direct internal call (never through the public proxy); x-hub-role satisfies service2's
        // requireFileAdmin, which trusts the hub on the internal network.
        const resp = await fetch(url, { headers: { 'x-hub-role': 'admin' }, signal: controller.signal })
          .finally(() => clearTimeout(timer));
        if (!resp.ok) { console.warn('[hub] feedback attach fetch failed', a.file, resp.status); continue; }
        const buf = Buffer.from(await resp.arrayBuffer());
        if (!buf.length || buf.length > CHAT_ATTACH_MAX) continue;
        const ext = path.extname(a.file || '').toLowerCase().slice(0, 12);
        const stored = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${ext}`;
        fs.writeFileSync(path.join(dir, stored), buf);
        const mime = a.mime || resp.headers.get('content-type') || 'application/octet-stream';
        const message = {
          id: `m${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
          conversationId: FEEDBACK_CONV_ID,
          authorId: author,
          authorDisplayName: author,
          kind: chatAttachmentKind(mime),
          body: '',
          createdAt: new Date().toISOString(),
          feedback: { id: record.id, kind: record.kind || null },
          attachment: {
            name: String(a.name || a.file).slice(0, 200),
            file: stored,
            mime,
            size: buf.length,
            url: `/api/chat/conversations/${FEEDBACK_CONV_ID}/attachments/${encodeURIComponent(stored)}`,
          },
        };
        appendChatMessage(FEEDBACK_CONV_ID, message);
        const index = loadChatIndex();
        const conv = index.find((c) => c.id === FEEDBACK_CONV_ID);
        if (conv) { conv.lastMessageAt = message.createdAt; saveChatIndex(index); }
        for (const c of sseClients) {
          if (isAdminUsername(c.user)) ssePush(c, 'chat', { conversationId: FEEDBACK_CONV_ID, message });
        }
      } catch (e) { console.warn('[hub] feedback attach relay error', a && a.file, e && e.message); }
    }
  } catch (err) {
    console.warn('[hub] relayFeedbackAttachmentsToChat failed:', err && err.message);
  }
}

// --- AI Assistant chat-bot (per-user private DM that relays to the AI platform) ---
const ASSISTANT_AUTHOR = 'assistant';
function assistantConvId(username) {
  return `assistant_${chatSanitizeId(username)}`;
}
// Ensure the user's private "AI Assistant" DM exists so it always shows in their chat list.
function ensureAssistantConversation(username) {
  if (!AI_ASSISTANT_ENABLED || !username) return null;
  const id = assistantConvId(username);
  const index = loadChatIndex();
  let conv = index.find((c) => c.id === id);
  if (!conv) {
    conv = {
      id,
      kind: 'direct',
      assistant: true,
      title: 'AI Assistant',
      memberUsernames: [username],
      ownerUsername: username,
      createdAt: new Date().toISOString(),
      reads: {},
    };
    index.push(conv);
    saveChatIndex(index);
  }
  return conv;
}
// Relay a user's message in their assistant DM to the platform ask API and post the answer
// back as the `assistant`. Fire-and-forget; never throws into the request path.
async function relayToAssistant(convId, text, username) {
  if (!AI_ASSISTANT_ENABLED) return;
  let answer = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const r = await fetch(`${AI_ASSISTANT_URL}/api/chat/${encodeURIComponent(AI_ASSISTANT_CLIENT_ID)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': AI_ASSISTANT_ORIGIN },
        body: JSON.stringify({ message: String(text || '').slice(0, CHAT_BODY_MAX), session_id: convId }),
        signal: controller.signal,
      });
      const data = await r.json().catch(() => ({}));
      answer = (data && typeof data.response === 'string') ? data.response.trim() : '';
    } finally { clearTimeout(timer); }
  } catch (err) {
    console.warn('[hub] assistant relay failed:', err && err.message);
  }
  if (!answer) answer = 'Entschuldigung, ich konnte gerade keine Antwort erzeugen. Bitte versuche es später erneut.';
  const message = {
    id: `m${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
    conversationId: convId,
    authorId: ASSISTANT_AUTHOR,
    authorDisplayName: 'AI Assistant',
    kind: 'text',
    body: answer.slice(0, CHAT_BODY_MAX),
    createdAt: new Date().toISOString(),
    assistant: true,
  };
  appendChatMessage(convId, message);
  const index = loadChatIndex();
  const conv = index.find((c) => c.id === convId);
  if (conv) { conv.lastMessageAt = message.createdAt; saveChatIndex(index); }
  for (const c of sseClients) {
    if (c.user === username) ssePush(c, 'chat', { conversationId: convId, message });
  }
  // Notify when the app is backgrounded (app suppresses for the active chat) — unless the user
  // muted their AI Assistant conversation.
  if (!isConversationMuted(conv, username)) {
    sendPushToUser(username, {
      aps: { alert: { title: 'AI Assistant', body: answer.slice(0, 160) }, sound: 'default' },
      kind: 'chat', conversationId: convId,
    }, 'alert').catch(() => {});
  }
}

// Per-(user, conversation) notification mute. Stored like reads: conv.mutes[username] = true.
function isConversationMuted(conv, username) {
  return !!(conv && conv.mutes && conv.mutes[username]);
}

function conversationPayload(conv, username) {
  const msgs = readChatMessages(conv.id);
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const lastReadAt = (conv.reads && conv.reads[username]) || null;
  const unreadCount = msgs.reduce(
    (n, m) => n + ((!lastReadAt || m.createdAt > lastReadAt) && m.authorId !== username ? 1 : 0),
    0
  );
  return {
    id: conv.id,
    kind: conv.kind,
    ...(conv.projectKey ? { projectKey: conv.projectKey } : {}),
    ...(conv.ownerUsername ? { ownerUsername: conv.ownerUsername } : {}),
    title: conv.title,
    memberUsernames: conv.memberUsernames || [],
    lastMessage: last,
    unreadCount,
    lastReadAt,
    muted: isConversationMuted(conv, username),
  };
}

// --- P10-A: chat attachments (photos, audio, files) stored under CHAT_DIR/attachments/<convId>/ ---
const CHAT_ATTACH_DIR = path.join(CHAT_DIR, 'attachments');
const CHAT_ATTACH_MAX = 25 * 1024 * 1024; // 25 MB per attachment
// Never accept these — active/scriptable content is an XSS/exec risk even for authed users.
const CHAT_ATTACH_BLOCK_EXT = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.sh', '.js', '.mjs', '.jar',
  '.app', '.dll', '.ps1', '.svg', '.html', '.htm', '.xhtml',
]);
// Documents allowed by extension (images/audio are allowed by MIME family below).
const CHAT_ATTACH_DOC_EXT = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt',
  '.rtf', '.json', '.log', '.pages', '.numbers', '.key', '.zip', '.heic',
]);

function chatAttachmentKind(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/svg+xml') return 'file';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

const chatUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(CHAT_ATTACH_DIR, chatSanitizeId(req.params.id));
      try { fs.mkdirSync(dir, { recursive: true }); cb(null, dir); }
      catch (err) { cb(err); }
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 12);
      cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: CHAT_ATTACH_MAX },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (CHAT_ATTACH_BLOCK_EXT.has(ext) || mime === 'image/svg+xml') {
      const err = new Error('This file type is not allowed in chat.');
      err.code = 'UNSUPPORTED_FILE_TYPE';
      return cb(err);
    }
    if (mime.startsWith('image/') || mime.startsWith('audio/')) return cb(null, true);
    if (mime === 'application/pdf' || CHAT_ATTACH_DOC_EXT.has(ext)) return cb(null, true);
    const err = new Error('Unsupported attachment type.');
    err.code = 'UNSUPPORTED_FILE_TYPE';
    return cb(err);
  },
});

// Auth + membership guard that runs BEFORE multer, so rejected requests never write a file.
function requireChatMember(req, res, next) {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  let index = loadChatIndex();
  let conv = index.find((c) => c.id === req.params.id);
  // The user's own AI Assistant DM is created lazily on first access.
  if (!conv && AI_ASSISTANT_ENABLED && req.params.id === assistantConvId(user.username)) {
    ensureAssistantConversation(user.username);
    index = loadChatIndex();
    conv = index.find((c) => c.id === req.params.id);
  }
  if (!conv) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
  if (!canSeeConversation(conv, user.username)) return res.status(403).json({ ok: false, error: 'not_member' });
  req.chatUser = user;
  req.chatIndex = index;
  req.chatConv = conv;
  return next();
}

// Every /api/chat/* route requires an authenticated, chat-enabled user. Admins are
// always enabled; managers honor their canUseChat flag (read live from the user store
// so an admin's toggle applies at once); blocked users never pass.
function userChatEnabled(user) {
  if (!user) return false;
  if (user.isSuperadmin || user.role === USER_ROLE_ADMIN) return true;
  if (user.role === USER_ROLE_BLOCKED) return false;
  const rec = (Array.isArray(adminCredentials.users) ? adminCredentials.users : [])
    .find((u) => u && u.username === user.username);
  if (rec) return rec.canUseChat !== false;
  return user.canUseChat !== false;
}

app.use('/api/chat', (req, res, next) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!userChatEnabled(user)) return res.status(403).json({ ok: false, error: 'chat_disabled' });
  return next();
});

// Self-service chat display name. GET returns the current name + the label shown to others
// ("Vladimir(Admin)"); POST { displayName } sets it (empty clears back to the username).
app.get('/api/chat/profile', (req, res) => {
  const user = getSessionUser(req);
  return res.json({
    ok: true,
    username: user.username,
    displayName: getChatDisplayName(user.username),
    roleLabel: chatRoleLabel(user),
    authorLabel: formatChatAuthor(user),
  });
});
app.post('/api/chat/profile', (req, res) => {
  const user = getSessionUser(req);
  const body = req.body || {};
  const displayName = setChatDisplayName(user.username, body.displayName);
  return res.json({
    ok: true,
    username: user.username,
    displayName,
    roleLabel: chatRoleLabel(user),
    authorLabel: formatChatAuthor(user),
  });
});

app.get('/api/chat/conversations', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  ensureAssistantConversation(user.username); // always surface the AI Assistant DM
  const conversations = loadChatIndex()
    .filter((c) => canSeeConversation(c, user.username))
    .map((c) => conversationPayload(c, user.username))
    .sort((a, b) => {
      const at = (a.lastMessage && a.lastMessage.createdAt) || '';
      const bt = (b.lastMessage && b.lastMessage.createdAt) || '';
      return bt.localeCompare(at);
    });
  return res.json({ ok: true, conversations });
});

app.post('/api/chat/conversations', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const body = req.body || {};
  const kind = ['project', 'direct', 'group'].includes(body.kind) ? body.kind : null;
  if (!kind) return res.status(400).json({ ok: false, error: 'invalid_kind' });
  const index = loadChatIndex();
  let conv;
  if (kind === 'direct') {
    const member = typeof body.member === 'string' ? body.member.trim() : '';
    if (!member) return res.status(400).json({ ok: false, error: 'member_required' });
    if (member === user.username) return res.status(400).json({ ok: false, error: 'cannot_dm_self' });
    if (!knownHubUsername(member)) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const pair = [user.username, member].sort();
    const id = `dm_${chatSanitizeId(pair.join('__'))}`;
    conv = index.find((c) => c.id === id);
    if (!conv) {
      conv = { id, kind, title: pair.join(' & '), memberUsernames: pair, createdAt: new Date().toISOString(), reads: {} };
      index.push(conv);
      saveChatIndex(index);
    }
  } else if (kind === 'group') {
    // Named, invite-only room (e.g. "26-1505 Siemens"): only listed members see it and can post.
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return res.status(400).json({ ok: false, error: 'title_required' });
    const rawMembers = Array.isArray(body.members) ? body.members : [];
    const picked = [...new Set(rawMembers.map((m) => String(m || '').trim()).filter(Boolean))]
      .filter((m) => m !== user.username);
    for (const m of picked) {
      if (!knownHubUsername(m)) return res.status(404).json({ ok: false, error: 'user_not_found', member: m });
    }
    const members = [user.username, ...picked];
    const id = `grp_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
    conv = {
      id, kind: 'group', title: title.slice(0, 120),
      memberUsernames: members, ownerUsername: user.username,
      createdAt: new Date().toISOString(), reads: {},
    };
    index.push(conv);
    saveChatIndex(index);
  } else {
    const projectKey = typeof body.projectKey === 'string' ? body.projectKey.trim() : '';
    if (!projectKey) return res.status(400).json({ ok: false, error: 'projectKey_required' });
    const id = `prj_${chatSanitizeId(projectKey)}`;
    conv = index.find((c) => c.id === id);
    if (!conv) {
      conv = { id, kind, projectKey, title: `Project ${projectKey}`, memberUsernames: [user.username], createdAt: new Date().toISOString(), reads: {} };
      index.push(conv);
      saveChatIndex(index);
    }
  }
  return res.json({ ok: true, conversation: conversationPayload(conv, user.username) });
});

// Add members to a group (owner or admin only). Body: { members: [usernames] } or { member }.
app.post('/api/chat/conversations/:id/members', requireChatMember, (req, res) => {
  const user = req.chatUser;
  const index = req.chatIndex;
  const conv = req.chatConv;
  if (conv.kind !== 'group') return res.status(400).json({ ok: false, error: 'not_a_group' });
  const isOwner = conv.ownerUsername === user.username;
  const isAdmin = user.isSuperadmin || user.role === USER_ROLE_ADMIN;
  if (!isOwner && !isAdmin) return res.status(403).json({ ok: false, error: 'forbidden' });
  const body = req.body || {};
  const raw = Array.isArray(body.members) ? body.members : (body.member ? [body.member] : []);
  const toAdd = [...new Set(raw.map((m) => String(m || '').trim()).filter(Boolean))];
  for (const m of toAdd) {
    if (!knownHubUsername(m)) return res.status(404).json({ ok: false, error: 'user_not_found', member: m });
  }
  if (!Array.isArray(conv.memberUsernames)) conv.memberUsernames = [];
  let added = 0;
  for (const m of toAdd) {
    if (!conv.memberUsernames.includes(m)) { conv.memberUsernames.push(m); added++; }
  }
  if (added) saveChatIndex(index);
  return res.json({ ok: true, added, conversation: conversationPayload(conv, user.username) });
});

app.get('/api/chat/conversations/:id/messages', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const conv = loadChatIndex().find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
  if (!canSeeConversation(conv, user.username)) return res.status(403).json({ ok: false, error: 'not_member' });
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 200)) : 50;
  const all = readChatMessages(conv.id);
  let upper = all.length;
  const before = typeof req.query.before === 'string' ? req.query.before.trim() : '';
  if (before) {
    const idx = all.findIndex((m) => m.id === before);
    if (idx >= 0) upper = idx;
  }
  const start = Math.max(0, upper - limit);
  return res.json({ ok: true, messages: all.slice(start, upper), hasMore: start > 0 });
});

// Accepts JSON `{ body }` (text) OR multipart/form-data with a `file` part
// (photo/audio/document) plus an optional `body` caption. requireChatMember runs
// first so unauthorized/non-member requests never reach multer (no orphan files).
app.post('/api/chat/conversations/:id/messages', requireChatMember, chatUpload.single('file'), (req, res) => {
  const user = req.chatUser;
  const index = req.chatIndex;
  const conv = req.chatConv;
  const body = req.body || {};
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  const file = req.file || null;
  if (!text && !file) return res.status(400).json({ ok: false, error: 'body_or_file_required' });
  const message = {
    id: `m${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
    conversationId: conv.id,
    authorId: user.username,
    authorDisplayName: formatChatAuthor(user),
    kind: file ? chatAttachmentKind(file.mimetype) : 'text',
    body: text.slice(0, CHAT_BODY_MAX),
    createdAt: new Date().toISOString(),
  };
  if (file) {
    message.attachment = {
      name: String(file.originalname || 'file').slice(0, 200),
      file: file.filename,
      mime: file.mimetype || 'application/octet-stream',
      size: file.size,
      url: `/api/chat/conversations/${conv.id}/attachments/${encodeURIComponent(file.filename)}`,
    };
  }
  appendChatMessage(conv.id, message);
  if (conv.kind === 'project' && !conv.memberUsernames.includes(user.username)) {
    conv.memberUsernames.push(user.username); // author auto-joins the project room
  }
  if (!conv.reads) conv.reads = {};
  conv.reads[user.username] = message.createdAt; // your own message is read
  conv.lastMessageAt = message.createdAt;
  saveChatIndex(index);
  // Bonus: instant delivery for clients on the P8 SSE stream (poll remains the source of truth).
  for (const c of sseClients) {
    if (c.user !== user.username && canSeeConversation(conv, c.user)) {
      ssePush(c, 'chat', { conversationId: conv.id, message });
    }
  }
  // APNs to other members so they're notified when the app is backgrounded/closed. Skip the
  // sender and anyone who muted this conversation (the app suppresses the banner for the chat
  // that's currently open). Fire-and-forget; no-op if APNs isn't configured.
  try {
    const recipients = (conv.memberUsernames || [])
      .filter((u) => u && u !== user.username && !isConversationMuted(conv, u));
    if (recipients.length) {
      const bodyText = text
        ? text
        : (file ? `📎 ${(message.attachment && message.attachment.name) || 'attachment'}` : 'New message');
      const payload = {
        aps: { alert: { title: conv.title || 'New message', body: `${message.authorDisplayName}: ${bodyText}`.slice(0, 180) }, sound: 'default' },
        kind: 'chat',
        conversationId: conv.id,
      };
      for (const u of recipients) sendPushToUser(u, payload, 'alert').catch(() => {});
    }
  } catch (e) { /* never block the message on push */ }
  // AI Assistant DM: relay the user's message to the platform and post the answer back
  // (fire-and-forget so the user's own message returns immediately).
  if (conv.assistant && message.authorId !== ASSISTANT_AUTHOR && text) {
    relayToAssistant(conv.id, text, user.username);
  }
  return res.json({ ok: true, ...message });
});

// Serve an attachment to conversation members only. Sandboxed + nosniff to
// neutralize any scriptable payload that slipped past the upload allowlist.
app.get('/api/chat/conversations/:id/attachments/:name', requireChatMember, (req, res) => {
  const stored = chatSanitizeId(req.params.name);
  if (!stored || stored.includes('..')) return res.status(400).json({ ok: false, error: 'bad_name' });
  const dir = path.resolve(path.join(CHAT_ATTACH_DIR, chatSanitizeId(req.params.id)));
  const filePath = path.resolve(path.join(dir, stored));
  if (filePath !== path.join(dir, stored) || !filePath.startsWith(dir + path.sep)) {
    return res.status(400).json({ ok: false, error: 'bad_path' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'not_found' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  return res.sendFile(filePath);
});

app.post('/api/chat/conversations/:id/read', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const index = loadChatIndex();
  const conv = index.find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
  if (!canSeeConversation(conv, user.username)) return res.status(403).json({ ok: false, error: 'not_member' });
  if (!conv.reads) conv.reads = {};
  conv.reads[user.username] = new Date().toISOString();
  saveChatIndex(index);
  return res.json({ ok: true });
});

// Mute / unmute a conversation for the requesting user. Muted conversations don't send that
// user an APNs push (the badge/unread still updates when they open the app). Persisted per
// (user, conversation) so it survives app restarts / reinstalls.
app.post('/api/chat/conversations/:id/mute', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const index = loadChatIndex();
  const conv = index.find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
  if (!canSeeConversation(conv, user.username)) return res.status(403).json({ ok: false, error: 'not_member' });
  const muted = !!(req.body && req.body.muted);
  if (!conv.mutes) conv.mutes = {};
  if (muted) conv.mutes[user.username] = true; else delete conv.mutes[user.username];
  saveChatIndex(index);
  return res.json({ ok: true, ...conversationPayload(conv, user.username) });
});

// P10-B: member directory for the DM username picker. Excludes the requester and
// blocked accounts (they cannot use any service). Superadmin is always included.
app.get('/api/chat/members', (req, res) => {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const superName = (adminCredentials.superadmin && adminCredentials.superadmin.username) || DEFAULT_ADMIN_USERNAME;
  const members = [];
  if (superName) members.push({ username: superName, role: USER_ROLE_ADMIN, isSuperadmin: true });
  for (const u of (Array.isArray(adminCredentials.users) ? adminCredentials.users : [])) {
    if (!u || !u.username || u.username === superName) continue;
    const role = normalizeUserRole(u.role, USER_ROLE_MANAGER);
    if (role === USER_ROLE_BLOCKED) continue;
    members.push({ username: u.username, role, isSuperadmin: false });
  }
  const list = members
    .filter((m) => m.username !== user.username)
    .sort((a, b) => a.username.localeCompare(b.username));
  return res.json({ ok: true, members: list });
});

// --- P10-C: admin moderation (list / delete / zip export) — admin or superadmin only ---
function requireChatAdmin(req, res, next) {
  setNoCache(res);
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!(user.isSuperadmin || user.role === USER_ROLE_ADMIN)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  req.chatUser = user;
  return next();
}

// Full inventory of every conversation (bypasses membership) for the moderation view.
app.get('/api/chat/admin/conversations', requireChatAdmin, (req, res) => {
  const conversations = loadChatIndex().map((c) => {
    const msgs = readChatMessages(c.id);
    const attachDir = path.join(CHAT_ATTACH_DIR, chatSanitizeId(c.id));
    let attachmentCount = 0;
    try { attachmentCount = fs.existsSync(attachDir) ? fs.readdirSync(attachDir).length : 0; } catch (e) { /* noop */ }
    return {
      id: c.id,
      kind: c.kind,
      ...(c.projectKey ? { projectKey: c.projectKey } : {}),
      title: c.title,
      memberUsernames: c.memberUsernames || [],
      createdAt: c.createdAt || null,
      lastMessageAt: c.lastMessageAt || (msgs.length ? msgs[msgs.length - 1].createdAt : null),
      messageCount: msgs.length,
      attachmentCount,
    };
  }).sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
  return res.json({ ok: true, conversations });
});

// Read any conversation's messages (bypasses membership) for the admin viewer.
app.get('/api/chat/admin/conversations/:id/messages', requireChatAdmin, (req, res) => {
  const conv = loadChatIndex().find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 200;
  const all = readChatMessages(conv.id);
  let upper = all.length;
  const before = typeof req.query.before === 'string' ? req.query.before.trim() : '';
  if (before) { const idx = all.findIndex((m) => m.id === before); if (idx >= 0) upper = idx; }
  const start = Math.max(0, upper - limit);
  return res.json({
    ok: true,
    conversation: {
      id: conv.id, kind: conv.kind, title: conv.title,
      ...(conv.projectKey ? { projectKey: conv.projectKey } : {}),
      memberUsernames: conv.memberUsernames || [],
    },
    messages: all.slice(start, upper),
    hasMore: start > 0,
  });
});

// Serve any conversation's attachment (bypasses membership) for the admin viewer.
app.get('/api/chat/admin/conversations/:id/attachments/:name', requireChatAdmin, (req, res) => {
  const stored = chatSanitizeId(req.params.name);
  if (!stored || stored.includes('..')) return res.status(400).json({ ok: false, error: 'bad_name' });
  const dir = path.resolve(path.join(CHAT_ATTACH_DIR, chatSanitizeId(req.params.id)));
  const filePath = path.resolve(path.join(dir, stored));
  if (filePath !== path.join(dir, stored) || !filePath.startsWith(dir + path.sep)) {
    return res.status(400).json({ ok: false, error: 'bad_path' });
  }
  if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'not_found' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  return res.sendFile(filePath);
});

// Download one conversation (metadata + messages + attachments) as a .zip.
app.get('/api/chat/admin/conversations/:id/archive', requireChatAdmin, (req, res) => {
  const conv = loadChatIndex().find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
  const safeId = chatSanitizeId(conv.id);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="chat_${safeId}.zip"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { console.error('[hub] chat archive error', err.message); try { res.status(500).end(); } catch (e) { /* noop */ } });
  archive.pipe(res);
  archive.append(JSON.stringify(conv, null, 2), { name: 'conversation.json' });
  const msgPath = chatMessagesPath(conv.id);
  if (fs.existsSync(msgPath)) archive.file(msgPath, { name: 'messages.jsonl' });
  const attachDir = path.join(CHAT_ATTACH_DIR, safeId);
  if (fs.existsSync(attachDir)) archive.directory(attachDir, 'attachments');
  archive.finalize();
});

// Download the entire chat store (all conversations + attachments) as one .zip.
app.get('/api/chat/admin/archive', requireChatAdmin, (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="chat_archive.zip"');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { console.error('[hub] chat archive error', err.message); try { res.status(500).end(); } catch (e) { /* noop */ } });
  archive.pipe(res);
  if (fs.existsSync(CHAT_DIR)) archive.directory(CHAT_DIR, false);
  else archive.append('[]', { name: 'conversations.json' });
  archive.finalize();
});

// Permanently delete a conversation: index entry + messages + attachments.
app.delete('/api/chat/admin/conversations/:id', requireChatAdmin, (req, res) => {
  const index = loadChatIndex();
  const idx = index.findIndex((c) => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
  const [removed] = index.splice(idx, 1);
  saveChatIndex(index);
  try { const p = chatMessagesPath(removed.id); if (fs.existsSync(p)) fs.unlinkSync(p); }
  catch (e) { console.warn('[hub] chat msg unlink failed', e.message); }
  try { const d = path.join(CHAT_ATTACH_DIR, chatSanitizeId(removed.id)); if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); }
  catch (e) { console.warn('[hub] chat attach rm failed', e.message); }
  return res.json({ ok: true, deleted: removed.id });
});

// Reverse-proxy route: expose service2 under /service2/ (auth required)
const requireService2Access = requireServiceAccess('service2', '/service2');
app.get('/service2', requireService2Access, (req, res) => res.redirect(301, '/service2/'));

// File archive requires explicit permission.
app.use('/service2/files', requireFilesAccess, createProxyMiddleware({
  target: 'http://service2:3001',
  changeOrigin: true,
  pathRewrite: { '^/service2': '' },
  logLevel: 'warn'
}));
app.use('/service2/api/files/delete', requireFilesAdminAccess, attachHubProxyHeaders, createProxyMiddleware({
  target: 'http://service2:3001',
  changeOrigin: true,
  pathRewrite: { '^/service2': '' },
  logLevel: 'warn'
}));
app.use('/service2/api/files/zip', requireFilesAdminAccess, attachHubProxyHeaders, createProxyMiddleware({
  target: 'http://service2:3001',
  changeOrigin: true,
  pathRewrite: { '^/service2': '' },
  logLevel: 'warn'
}));
app.use('/service2/api/files', requireFilesAccess, createProxyMiddleware({
  target: 'http://service2:3001',
  changeOrigin: true,
  pathRewrite: { '^/service2': '' },
  logLevel: 'warn'
}));

app.use('/service2', requireService2Access, createProxyMiddleware({
  target: 'http://service2:3001',
  changeOrigin: true,
  pathRewrite: { '^/service2': '' },
  logLevel: 'warn'
}));

// Convenience redirect so /files (from service2 redirects) lands under /service2/files.
app.get('/files', requireFilesAccess, (req, res) => {
  const queryIndex = req.originalUrl.indexOf('?');
  const suffix = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
  res.redirect(`/service2/files${suffix}`);
});

// Allow direct PDF download links without /service2 prefix (auth required)
app.use('/download', requireFilesAccess, createProxyMiddleware({
  target: 'http://service2:3001',
  changeOrigin: true,
  logLevel: 'warn'
}));

// Public signing routes — no auth required (cryptographic tokens protect access)
app.use('/sign', createProxyMiddleware({
  target: 'http://service-sign:3002',
  changeOrigin: true,
  pathRewrite: { '^/sign': '' },
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

// --- Account-deletion sweeper: purge accounts whose 7-day grace window elapsed ---
// appReviewProtected accounts (Apple reviewer) are never purged. Report/PDF purge in
// service2 is a documented follow-up; this removes the hub login record.
function sweepPendingDeletions() {
  try {
    if (!Array.isArray(adminCredentials.users) || !adminCredentials.users.length) return;
    const now = Date.now();
    const survivors = [];
    const purged = [];
    for (const user of adminCredentials.users) {
      const pd = user && user.pendingDeletion;
      if (pd && !user.appReviewProtected && pd.scheduledFor && Date.parse(pd.scheduledFor) <= now) {
        purged.push(user.username);
        continue;
      }
      survivors.push(user);
    }
    if (purged.length) {
      adminCredentials.users = survivors;
      saveAdminCredentials(adminCredentials);
      console.warn(`[hub] account-deletion sweeper purged ${purged.length} account(s): ${purged.join(', ')}`);
    }
  } catch (err) {
    console.warn('[hub] account-deletion sweeper failed', err);
  }
}
setInterval(sweepPendingDeletions, 60 * 60 * 1000); // hourly
sweepPendingDeletions(); // run once on boot

app.listen(PORT, () => console.log(`Hub listening on ${PORT}`));
