const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
// Node 18+ includes a global fetch; avoid requiring node-fetch (ESM) to keep CommonJS simple

const app = express();
const PORT = process.env.PORT || 8080;

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
  const services = [
    { name: 'service1', url: 'http://service1:3000/health' },
    { name: 'service2', url: 'http://service2:3001/health' }
  ];

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
