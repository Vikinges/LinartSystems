const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3001;

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/', (req, res) => {
  res.send(`<h2>Service 2</h2><p>This is demo service 2 running in another container.</p><p><a href=\"/\">Back</a></p>`);
});

app.listen(PORT, () => console.log(`Service2 on ${PORT}`));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'service2', uptime: process.uptime(), now: new Date().toISOString() });
});
