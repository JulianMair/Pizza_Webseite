'use strict';

const { db } = require('../db');
const settings = require('../settings');
const time = require('../time');
const whatsapp = require('./whatsapp');
const mailer = require('./mailer');
const { render } = require('./templates');

const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

const stmts = {
  insert: db.prepare('INSERT INTO notifications (order_id, kind, channel, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  sentBefore: db.prepare("SELECT 1 FROM notifications WHERE order_id = ? AND kind = ? AND channel = ? AND status = 'sent' LIMIT 1"),
};

function formatMoney(cents) {
  return money.format(cents / 100).replace(/ /g, ' ');
}

// Werte für die Platzhalter in WhatsApp und E-Mail Vorlagen.
function buildContext(order) {
  return {
    name: order.customer_name,
    order_id: order.id,
    timeslot: order.slot_time,
    date: time.formatDateDe(order.slot_date),
    type: order.type === 'delivery' ? 'Lieferung' : 'Abholung',
    items: order.items.map((i) => `${i.quantity}x ${i.name}`).join('\n'),
    total: formatMoney(order.total_cents),
    address: order.type === 'delivery' ? [order.street, order.city].filter(Boolean).join(', ') : '',
    shop: settings.get('shop_name'),
  };
}

function record(orderId, kind, channel, status, error = null) {
  stmts.insert.run(orderId, kind, channel, status, error, time.nowIso());
  return { status, error };
}

function errorMessage(err) {
  return String(err && err.message ? err.message : err).slice(0, 500);
}

async function sendWhatsapp(order, kind, ctx, force) {
  const enabledKey = kind === 'ready' ? 'wa_ready_enabled' : 'wa_confirm_enabled';
  if (!force && kind === 'ready' && stmts.sentBefore.get(order.id, kind, 'whatsapp')) {
    return { status: 'sent', error: null, previously: true };
  }
  if (!settings.getBool(enabledKey)) return record(order.id, kind, 'whatsapp', 'skipped', 'In den Einstellungen deaktiviert');
  const baseUrl = settings.get('waha_url');
  if (!baseUrl) return record(order.id, kind, 'whatsapp', 'skipped', 'WAHA ist nicht konfiguriert');
  const chatId = whatsapp.formatChatId(order.phone_raw);
  if (!chatId) return record(order.id, kind, 'whatsapp', 'failed', `Ungültige Telefonnummer: ${order.phone_raw}`);

  let template;
  if (kind === 'confirmation') template = settings.get('wa_tpl_confirm');
  else template = settings.get(order.type === 'delivery' ? 'wa_tpl_ready_delivery' : 'wa_tpl_ready_pickup');

  try {
    await whatsapp.sendText({
      baseUrl,
      session: settings.get('waha_session'),
      apiKey: settings.get('waha_api_key'),
      chatId,
      text: render(template, ctx),
    });
    console.log(`[notify] Bestellung #${order.id} ${kind}: WhatsApp an ${chatId} gesendet`);
    return record(order.id, kind, 'whatsapp', 'sent');
  } catch (err) {
    console.error(`[notify] Bestellung #${order.id} ${kind}: WhatsApp fehlgeschlagen: ${errorMessage(err)}`);
    return record(order.id, kind, 'whatsapp', 'failed', errorMessage(err));
  }
}

async function sendEmail(order, kind, ctx, force) {
  const enabledKey = kind === 'ready' ? 'mail_ready_enabled' : 'mail_confirm_enabled';
  if (!force && kind === 'ready' && stmts.sentBefore.get(order.id, kind, 'email')) {
    return { status: 'sent', error: null, previously: true };
  }
  if (!settings.getBool(enabledKey)) return record(order.id, kind, 'email', 'skipped', 'In den Einstellungen deaktiviert');
  if (!mailer.isConfigured()) return record(order.id, kind, 'email', 'skipped', 'SMTP ist nicht konfiguriert');

  let subject;
  let body;
  if (kind === 'confirmation') {
    subject = settings.get('mail_tpl_confirm_subject');
    body = settings.get('mail_tpl_confirm_body');
  } else {
    subject = settings.get('mail_tpl_ready_subject');
    body = settings.get(order.type === 'delivery' ? 'mail_tpl_ready_delivery_body' : 'mail_tpl_ready_pickup_body');
  }

  try {
    await mailer.sendMail({ to: order.email, subject: render(subject, ctx).replace(/\s+/g, ' ').trim(), text: render(body, ctx) });
    console.log(`[notify] Bestellung #${order.id} ${kind}: E-Mail an ${order.email} gesendet`);
    return record(order.id, kind, 'email', 'sent');
  } catch (err) {
    console.error(`[notify] Bestellung #${order.id} ${kind}: E-Mail fehlgeschlagen: ${errorMessage(err)}`);
    return record(order.id, kind, 'email', 'failed', errorMessage(err));
  }
}

// Verschickt WhatsApp und E-Mail parallel. Wirft nie: jeder Fehler landet im Ergebnis
// und in der Tabelle notifications, damit ein Statuswechsel niemals daran scheitert.
async function sendOrderNotifications(order, kind, { force = false } = {}) {
  const ctx = buildContext(order);
  const [wa, mail] = await Promise.allSettled([
    sendWhatsapp(order, kind, ctx, force),
    sendEmail(order, kind, ctx, force),
  ]);
  const unwrap = (result, channel) => {
    if (result.status === 'fulfilled') return result.value;
    console.error(`[notify] Bestellung #${order.id} ${kind}: ${channel} unerwarteter Fehler: ${errorMessage(result.reason)}`);
    return { status: 'failed', error: errorMessage(result.reason) };
  };
  return { whatsapp: unwrap(wa, 'WhatsApp'), email: unwrap(mail, 'E-Mail') };
}

async function sendTestWhatsapp(phone) {
  const chatId = whatsapp.formatChatId(phone);
  if (!chatId) throw new Error('Ungültige Telefonnummer.');
  await whatsapp.sendText({
    baseUrl: settings.get('waha_url'),
    session: settings.get('waha_session'),
    apiKey: settings.get('waha_api_key'),
    chatId,
    text: `Testnachricht von ${settings.get('shop_name')}: Die WhatsApp Anbindung funktioniert.`,
  });
  return chatId;
}

async function sendTestEmail(to) {
  await mailer.sendMail({
    to,
    subject: `Testmail von ${settings.get('shop_name')}`,
    text: 'Hallo,\n\ndie E-Mail Anbindung funktioniert.\n\nViele Grüße',
  });
}

module.exports = { buildContext, formatMoney, sendOrderNotifications, sendTestWhatsapp, sendTestEmail };
