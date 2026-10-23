'use strict';

const nodemailer = require('nodemailer');
const settings = require('../settings');
const { textToHtml } = require('./templates');

let cached = { key: null, transport: null };

function smtpConfig() {
  return {
    host: settings.get('smtp_host'),
    port: settings.getInt('smtp_port'),
    secure: settings.getBool('smtp_secure'),
    user: settings.get('smtp_user'),
    pass: settings.get('smtp_pass'),
    from: settings.get('smtp_from'),
    fromName: settings.get('smtp_from_name') || settings.get('shop_name'),
  };
}

function isConfigured() {
  const cfg = smtpConfig();
  return Boolean(cfg.host && cfg.from);
}

function getTransport(cfg) {
  const key = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass]);
  if (cached.key !== key) {
    if (cached.transport) cached.transport.close();
    cached = {
      key,
      transport: nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
      }),
    };
  }
  return cached.transport;
}

// Versendet eine Text Mail (plus einfache HTML Variante). Wirft bei Fehlern.
async function sendMail({ to, subject, text }) {
  const cfg = smtpConfig();
  if (!cfg.host) throw new Error('SMTP Host ist nicht konfiguriert.');
  if (!cfg.from) throw new Error('Absender E-Mail ist nicht konfiguriert.');
  const transport = getTransport(cfg);
  try {
    return await transport.sendMail({
      from: { name: cfg.fromName, address: cfg.from },
      to,
      subject,
      text,
      html: textToHtml(text),
    });
  } catch (err) {
    const code = err.code ? ` (${err.code})` : '';
    throw new Error(`SMTP Fehler${code}: ${err.message}`);
  }
}

module.exports = { isConfigured, sendMail };
