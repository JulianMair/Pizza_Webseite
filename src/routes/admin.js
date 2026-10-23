'use strict';

const express = require('express');
const config = require('../config');
const auth = require('../auth');
const settings = require('../settings');
const time = require('../time');
const events = require('../events');
const menu = require('../services/menu');
const slots = require('../services/slots');
const orders = require('../services/orders');
const notify = require('../services/notify');
const { createLimiter } = require('../ratelimit');
const { badRequest, HttpError } = require('../errors');

const router = express.Router();

const loginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.',
});

function id(req) {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Ungültige ID.');
  return n;
}

router.post('/login', (req, res) => {
  loginLimiter.check(req.ip);
  const { username, password } = req.body || {};
  if (!auth.checkCredentials(username, password)) {
    throw new HttpError(401, 'Benutzername oder Passwort ist falsch.');
  }
  loginLimiter.reset(req.ip);
  auth.setSessionCookie(res);
  res.json({ ok: true, user: config.adminUser });
});

router.post('/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ authenticated: auth.isAuthenticated(req), user: config.adminUser });
});

router.use(auth.requireAdmin);

router.get('/events', (req, res) => events.subscribe(req, res));

// Bestellungen und Küchenansicht
router.get('/order-dates', (req, res) => {
  const today = time.today();
  res.json({ today, dates: slots.listDates(time.addDays(today, -30)) });
});

router.get('/orders', (req, res) => {
  const date = req.query.date || time.today();
  res.json({ date, slots: orders.listForDate(date) });
});

router.patch('/orders/:id/status', async (req, res) => {
  res.json(await orders.setStatus(id(req), req.body?.status));
});

router.post('/orders/:id/notify', async (req, res) => {
  res.json(await orders.resendNotifications(id(req), req.body?.kind));
});

// Speisekarte
router.get('/menu', (req, res) => {
  res.json({ categories: menu.getMenu() });
});

router.post('/categories', (req, res) => {
  res.status(201).json({ category: menu.createCategory(req.body || {}) });
});

router.put('/categories/:id', (req, res) => {
  res.json({ category: menu.updateCategory(id(req), req.body || {}) });
});

router.delete('/categories/:id', (req, res) => {
  menu.deleteCategory(id(req));
  res.json({ ok: true });
});

router.post('/menu', (req, res) => {
  res.status(201).json({ item: menu.createItem(req.body || {}) });
});

router.put('/menu/:id', (req, res) => {
  res.json({ item: menu.updateItem(id(req), req.body || {}) });
});

router.patch('/menu/:id/availability', (req, res) => {
  res.json({ item: menu.setAvailability(id(req), Boolean(req.body?.available)) });
});

router.delete('/menu/:id', (req, res) => {
  menu.deleteItem(id(req));
  res.json({ ok: true });
});

// Zeitslots
router.get('/slots', (req, res) => {
  const date = req.query.date || time.today();
  res.json({ date, slots: slots.listByDate(date) });
});

router.post('/slots', (req, res) => {
  const slot = slots.createSlot(req.body || {});
  events.broadcast('slots:changed', { date: slot.date });
  res.status(201).json({ slot });
});

router.post('/slots/generate', (req, res) => {
  const result = slots.generate(req.body || {});
  events.broadcast('slots:changed', {});
  res.status(201).json(result);
});

router.put('/slots/:id', (req, res) => {
  const slot = slots.updateSlot(id(req), req.body || {});
  events.broadcast('slots:changed', { date: slot.date });
  res.json({ slot });
});

router.delete('/slots/:id', (req, res) => {
  slots.deleteSlot(id(req));
  events.broadcast('slots:changed', {});
  res.json({ ok: true });
});

router.delete('/slots', (req, res) => {
  const deleted = slots.deleteFreeSlotsByDate(req.query.date);
  events.broadcast('slots:changed', { date: req.query.date });
  res.json({ deleted });
});

// Einstellungen
router.get('/settings', (req, res) => {
  res.json({ settings: settings.getForAdmin(), timezone: config.timezone });
});

router.put('/settings', (req, res) => {
  const { clear_secrets: clearSecrets, ...values } = req.body || {};
  res.json({ settings: settings.update(values, Array.isArray(clearSecrets) ? clearSecrets : []) });
});

router.post('/settings/test-whatsapp', async (req, res) => {
  try {
    const chatId = await notify.sendTestWhatsapp(String(req.body?.phone || ''));
    res.json({ ok: true, message: `Testnachricht an ${chatId} gesendet.` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post('/settings/test-email', async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw badRequest('Bitte eine gültige E-Mail-Adresse angeben.');
  try {
    await notify.sendTestEmail(to);
    res.json({ ok: true, message: `Testmail an ${to} gesendet.` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post('/password', (req, res) => {
  const { current, next } = req.body || {};
  if (!auth.checkCredentials(config.adminUser, String(current || ''))) throw badRequest('Das aktuelle Passwort ist falsch.');
  if (typeof next !== 'string' || next.length < 8) throw badRequest('Das neue Passwort muss mindestens 8 Zeichen haben.');
  auth.setPassword(next);
  auth.setSessionCookie(res);
  res.json({ ok: true });
});

router.post('/cleanup', (req, res) => {
  res.json(orders.cleanup(req.body?.days));
});

module.exports = router;
