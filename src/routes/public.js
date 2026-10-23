'use strict';

const express = require('express');
const config = require('../config');
const settings = require('../settings');
const time = require('../time');
const menu = require('../services/menu');
const slots = require('../services/slots');
const orders = require('../services/orders');
const mailer = require('../services/mailer');
const { createLimiter } = require('../ratelimit');

const router = express.Router();

const orderLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  max: config.orderRateLimit,
  message: 'Zu viele Bestellungen in kurzer Zeit. Bitte später erneut versuchen.',
});

router.get('/shop', (req, res) => {
  res.json({
    shop_name: settings.get('shop_name'),
    shop_subtitle: settings.get('shop_subtitle'),
    ordering_enabled: settings.getBool('ordering_enabled'),
    closed_message: settings.get('closed_message'),
    min_delivery_items: settings.getInt('min_delivery_items'),
    lead_minutes: settings.getInt('lead_minutes'),
    imprint_url: settings.get('imprint_url'),
    privacy_url: settings.get('privacy_url'),
    today: time.today(),
    // Damit die Bestätigungsseite nur Benachrichtigungen ankündigt, die auch verschickt werden.
    notifications: {
      ready_whatsapp: settings.getBool('wa_ready_enabled') && Boolean(settings.get('waha_url')),
      ready_email: settings.getBool('mail_ready_enabled') && mailer.isConfigured(),
      confirm_whatsapp: settings.getBool('wa_confirm_enabled') && Boolean(settings.get('waha_url')),
      confirm_email: settings.getBool('mail_confirm_enabled') && mailer.isConfigured(),
    },
  });
});

router.get('/menu', (req, res) => {
  res.json({ categories: menu.getMenu() });
});

router.get('/slots', (req, res) => {
  res.json({ slots: slots.listUpcoming() });
});

router.post('/orders', orderLimiter.middleware, (req, res) => {
  const order = orders.createOrder(req.body);
  res.status(201).json({ order });
});

module.exports = router;
