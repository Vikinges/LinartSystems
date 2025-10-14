const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
// Node 18+ includes a global fetch; avoid requiring node-fetch (ESM) to keep CommonJS simple

const cookieParser = require('cookie-parser');
const session = require('express-session');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.HUB_ADMIN_PASSWORD || 'admin';

app.use(cookieParser());
app.use(session({ secret: process.env.SESSION_SECRET || 'changeme', resave: false, saveUninitialized: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SERVICES_FILE = path.join(__dirname, 'services.json');

function loadServices(){
  try{
    return JSON.parse(fs.readFileSync(SERVICES_FILE, 'utf8'));
  }catch(e){
    return [];
  }
}

function saveServices(list){
  fs.writeFileSync(SERVICES_FILE, JSON.stringify(list, null, 2));
}

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
  const services = loadServices().map(s => ({ name: s.name, displayName: s.displayName, description: s.description, prefix: s.prefix, url: s.target + '/health' }));

  const results = await Promise.all(services.map(async s => {
    try {
      const r = await fetch(s.url, { timeout: 2000 });
      if (!r.ok) return { name: s.name, ok: false, status: r.status };
      const body = await r.json();
      return { name: s.name, ok: true, info: body };
    } catch (err) {
      return { name: s.name, ok: false, error: String(err) };
    }
  }));

  res.json({ services: results, hub: { now: new Date().toISOString() } });
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
  const body = req.body;
  if (!body || !body.name || !body.target || !body.prefix) return res.status(400).json({ ok: false, error: 'missing fields' });
  const list = loadServices();
  if (list.find(s=>s.name===body.name)) return res.status(400).json({ ok: false, error: 'exists' });
  list.push({ name: body.name, target: body.target, prefix: body.prefix });
  saveServices(list);
  // naive: register proxies again (may duplicate in memory but acceptable for minimal admin)
  registerProxies(app);
  res.json({ ok: true });
});

app.delete('/admin/services/:name', requireAuth, (req, res) => {
  const name = req.params.name;
  let list = loadServices();
  list = list.filter(s=>s.name !== name);
  saveServices(list);
  res.json({ ok: true });
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

app.listen(PORT, () => console.log(`Hub listening on ${PORT}`));
