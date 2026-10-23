'use strict';

const path = require('node:path');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function trustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && String(n) === value ? n : value;
}

const env = process.env;

module.exports = {
  port: int(env.PORT, 3000),
  dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
  timezone: env.APP_TIMEZONE || env.TZ || 'Europe/Berlin',
  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || '',
  sessionSecret: env.SESSION_SECRET || '',
  sessionDays: int(env.SESSION_DAYS, 7),
  cookieSecure: bool(env.COOKIE_SECURE, false),
  trustProxy: trustProxy(env.TRUST_PROXY),
  seedDemoData: bool(env.SEED_DEMO_DATA, true),
  // Bestellungen pro IP in 10 Minuten. Bei Events im selben WLAN teilen sich viele Gäste eine IP.
  orderRateLimit: int(env.ORDER_RATE_LIMIT, 60),
  // Vorbelegung der Integrationen: gesetzte Variablen werden übernommen, solange der Wert
  // noch nicht im Admin Bereich gespeichert wurde. Danach gilt der Wert aus der Datenbank.
  initial: Object.fromEntries(
    Object.entries({
      waha_url: env.WAHA_URL,
      waha_session: env.WAHA_SESSION,
      waha_api_key: env.WAHA_API_KEY,
      smtp_host: env.SMTP_HOST,
      smtp_port: env.SMTP_PORT,
      smtp_secure: env.SMTP_SECURE === undefined || env.SMTP_SECURE === '' ? undefined : (bool(env.SMTP_SECURE, false) ? '1' : '0'),
      smtp_user: env.SMTP_USER,
      smtp_pass: env.SMTP_PASS,
      smtp_from: env.SMTP_FROM,
      smtp_from_name: env.SMTP_FROM_NAME,
    }).filter(([, value]) => value !== undefined && value !== ''),
  ),
};
