'use strict';

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const config = require('./config');
const { db, seedDemoData } = require('./db');
const auth = require('./auth');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ALPINE_FILE = require.resolve('alpinejs/dist/cdn.min.js');

if (config.seedDemoData && seedDemoData()) {
  console.log('[setup] Demo Speisekarte und Zeitslots für heute und morgen angelegt.');
}
auth.ensureAdminPassword();

if (!fs.existsSync(path.join(PUBLIC_DIR, 'css', 'app.css'))) {
  console.warn('[setup] public/css/app.css fehlt. Bitte "npm run build:css" ausführen (im Docker Image passiert das automatisch).');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
  });
  next();
});

app.use(express.json({ limit: '100kb' }));

app.get('/healthz', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api/admin', adminRoutes);
app.use('/api', publicRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));

app.get('/vendor/alpine.min.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=604800');
  res.sendFile(ALPINE_FILE);
});

app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Fehlerbehandlung: bekannte Fehler mit Meldung, alles andere generisch und geloggt.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Ungültiges JSON.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Anfrage ist zu groß.' });
  }
  if (err.expose && err.status) {
    return res.status(err.status).json({ error: err.message, ...(err.details || {}) });
  }
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  return res.status(500).json({ error: 'Interner Serverfehler. Bitte erneut versuchen.' });
});

const server = app.listen(config.port, () => {
  const { port } = server.address();
  console.log(`[server] Läuft auf Port ${port} (Zeitzone ${config.timezone}, Daten in ${config.dataDir})`);
  console.log(`[server] Shop: http://localhost:${port}/   Admin: http://localhost:${port}/admin`);
});

function shutdown(signal) {
  console.log(`[server] ${signal} empfangen, fahre herunter.`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // SSE Verbindungen halten den Server offen, daher nach kurzer Zeit hart beenden.
  setTimeout(() => {
    db.close();
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
