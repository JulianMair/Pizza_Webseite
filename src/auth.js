'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const settings = require('./settings');
const { HttpError } = require('./errors');

const COOKIE_NAME = 'pizza_admin';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyHash(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Stellt sicher, dass ein Login möglich ist. Ohne ADMIN_PASSWORD und ohne gespeichertes
// Passwort wird einmalig ein Zufallspasswort erzeugt und im Log ausgegeben.
function ensureAdminPassword() {
  if (settings.getInternal('admin_password_hash') || config.adminPassword) return;
  const generated = crypto.randomBytes(9).toString('base64url');
  settings.setInternal('admin_password_hash', hashPassword(generated));
  console.log('================================================================');
  console.log(' Kein ADMIN_PASSWORD gesetzt. Erzeugtes Admin Passwort:');
  console.log(`   Benutzer: ${config.adminUser}   Passwort: ${generated}`);
  console.log(' Bitte nach dem ersten Login unter Einstellungen ändern.');
  console.log('================================================================');
}

function checkCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  const userOk = safeEqual(username, config.adminUser);
  const storedHash = settings.getInternal('admin_password_hash');
  const passOk = storedHash ? verifyHash(password, storedHash) : (config.adminPassword !== '' && safeEqual(password, config.adminPassword));
  return userOk && passOk;
}

function setPassword(newPassword) {
  settings.setInternal('admin_password_hash', hashPassword(newPassword));
  // Neue Version macht alle bestehenden Sessions ungültig.
  settings.setInternal('session_version', String(sessionVersion() + 1));
}

function sessionVersion() {
  return Number.parseInt(settings.getInternal('session_version') || '1', 10);
}

function secret() {
  if (config.sessionSecret) return config.sessionSecret;
  let stored = settings.getInternal('session_secret');
  if (!stored) {
    stored = crypto.randomBytes(32).toString('hex');
    settings.setInternal('session_secret', stored);
  }
  return stored;
}

function sign(data) {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

function createToken() {
  const payload = Buffer.from(JSON.stringify({
    u: config.adminUser,
    v: sessionVersion(),
    exp: Date.now() + config.sessionDays * 86400000,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp < Date.now() || data.v !== sessionVersion() || data.u !== config.adminUser) return null;
    return data;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function setSessionCookie(res) {
  res.cookie(COOKIE_NAME, createToken(), {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    maxAge: config.sessionDays * 86400000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/' });
}

function isAuthenticated(req) {
  return Boolean(verifyToken(readCookie(req, COOKIE_NAME)));
}

// Schützt Admin Routen. Schreibende Requests brauchen zusätzlich den Header
// X-Requested-With, den fremde Seiten ohne CORS Freigabe nicht setzen können.
function requireAdmin(req, res, next) {
  if (!isAuthenticated(req)) return next(new HttpError(401, 'Bitte erneut anmelden.'));
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'fetch') {
    return next(new HttpError(403, 'Ungültige Anfrage.'));
  }
  return next();
}

module.exports = {
  hashPassword,
  verifyHash,
  ensureAdminPassword,
  checkCredentials,
  setPassword,
  setSessionCookie,
  clearSessionCookie,
  isAuthenticated,
  requireAdmin,
};
