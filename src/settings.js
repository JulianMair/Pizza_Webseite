'use strict';

const { db } = require('./db');
const config = require('./config');
const { badRequest } = require('./errors');

// Alle im Admin Bereich änderbaren Einstellungen mit Typ und Standardwert.
const SCHEMA = {
  shop_name: { type: 'string', max: 80, default: 'Pizza Vorbestellung' },
  shop_subtitle: { type: 'string', max: 200, default: 'Online vorbestellen, Zeitslot wählen, frisch genießen.' },
  ordering_enabled: { type: 'bool', default: '1' },
  closed_message: { type: 'text', max: 500, default: 'Aktuell nehmen wir keine Online Bestellungen an. Schau bald wieder vorbei!' },
  min_delivery_items: { type: 'int', min: 0, max: 1000, default: '4' },
  lead_minutes: { type: 'int', min: 0, max: 1440, default: '30' },
  imprint_url: { type: 'url', max: 500, default: '' },
  privacy_url: { type: 'url', max: 500, default: '' },

  waha_url: { type: 'url', max: 500, default: 'http://waha:3000' },
  waha_session: { type: 'string', max: 100, default: 'default' },
  waha_api_key: { type: 'string', max: 500, default: '', secret: true },
  wa_confirm_enabled: { type: 'bool', default: '0' },
  wa_ready_enabled: { type: 'bool', default: '1' },
  wa_tpl_confirm: {
    type: 'text',
    max: 2000,
    default: 'Hallo {name}, danke für deine Bestellung #{order_id} bei {shop}!\n{type} am {date} um {timeslot} Uhr\n{items}\nSumme: {total}\nWir melden uns hier, sobald alles fertig ist.',
  },
  wa_tpl_ready_pickup: {
    type: 'text',
    max: 2000,
    default: 'Hallo {name}, deine Bestellung #{order_id} ist fertig und kann jetzt abgeholt werden (Zeitslot {timeslot} Uhr). Guten Appetit! Dein Team von {shop}',
  },
  wa_tpl_ready_delivery: {
    type: 'text',
    max: 2000,
    default: 'Hallo {name}, deine Bestellung #{order_id} ist fertig und macht sich jetzt auf den Weg zu dir ({address}). Guten Appetit! Dein Team von {shop}',
  },

  smtp_host: { type: 'string', max: 255, default: '' },
  smtp_port: { type: 'int', min: 1, max: 65535, default: '587' },
  smtp_secure: { type: 'bool', default: '0' },
  smtp_user: { type: 'string', max: 255, default: '' },
  smtp_pass: { type: 'string', max: 500, default: '', secret: true },
  smtp_from: { type: 'string', max: 255, default: '' },
  smtp_from_name: { type: 'string', max: 100, default: '' },
  mail_confirm_enabled: { type: 'bool', default: '1' },
  mail_ready_enabled: { type: 'bool', default: '1' },
  mail_tpl_confirm_subject: { type: 'string', max: 200, default: 'Deine Bestellung #{order_id} bei {shop}' },
  mail_tpl_confirm_body: {
    type: 'text',
    max: 5000,
    default: 'Hallo {name},\n\nvielen Dank für deine Bestellung bei {shop}!\n\nBestellnummer: #{order_id}\nBestellart: {type}\nZeitslot: {date}, {timeslot} Uhr\n\n{items}\n\nSumme: {total} (Bezahlung bei Abholung bzw. Lieferung)\n\nSobald deine Bestellung fertig ist, bekommst du eine weitere Nachricht.\n\nViele Grüße\n{shop}',
  },
  mail_tpl_ready_subject: { type: 'string', max: 200, default: 'Deine Bestellung #{order_id} ist fertig' },
  mail_tpl_ready_pickup_body: {
    type: 'text',
    max: 5000,
    default: 'Hallo {name},\n\ndeine Bestellung #{order_id} ist fertig und kann jetzt abgeholt werden (Zeitslot {timeslot} Uhr).\n\nGuten Appetit!\n{shop}',
  },
  mail_tpl_ready_delivery_body: {
    type: 'text',
    max: 5000,
    default: 'Hallo {name},\n\ndeine Bestellung #{order_id} ist fertig und macht sich jetzt auf den Weg zu dir:\n{address}\n\nGuten Appetit!\n{shop}',
  },
};

const selectOne = db.prepare('SELECT value FROM settings WHERE key = ?');
const selectAll = db.prepare('SELECT key, value FROM settings');
const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const remove = db.prepare('DELETE FROM settings WHERE key = ?');

// Reihenfolge: gespeicherter Wert, dann Vorbelegung aus Env, dann Standardwert.
function get(key) {
  const row = selectOne.get(key);
  if (row) return row.value;
  if (config.initial[key] !== undefined) return config.initial[key];
  return SCHEMA[key] ? SCHEMA[key].default : undefined;
}

function getBool(key) {
  return get(key) === '1';
}

function getInt(key) {
  const n = Number.parseInt(get(key), 10);
  return Number.isFinite(n) ? n : Number.parseInt(SCHEMA[key].default, 10);
}

function getAll() {
  const stored = Object.fromEntries(selectAll.all().map((r) => [r.key, r.value]));
  const result = {};
  for (const key of Object.keys(SCHEMA)) {
    if (key in stored) result[key] = stored[key];
    else if (config.initial[key] !== undefined) result[key] = config.initial[key];
    else result[key] = SCHEMA[key].default;
  }
  return result;
}

// Für das Admin UI: Geheimnisse werden nie im Klartext ausgeliefert.
function getForAdmin() {
  const all = getAll();
  const out = {};
  for (const [key, def] of Object.entries(SCHEMA)) {
    if (def.secret) {
      out[key] = '';
      out[`${key}_set`] = all[key] !== '';
    } else if (def.type === 'bool') {
      out[key] = all[key] === '1';
    } else if (def.type === 'int') {
      out[key] = Number.parseInt(all[key], 10);
    } else {
      out[key] = all[key];
    }
  }
  return out;
}

function normalize(key, value) {
  const def = SCHEMA[key];
  switch (def.type) {
    case 'bool':
      return value === true || value === 1 || value === '1' || value === 'true' ? '1' : '0';
    case 'int': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < def.min || n > def.max) {
        throw badRequest(`Ungültiger Wert für ${key}: erlaubt ist eine ganze Zahl von ${def.min} bis ${def.max}.`);
      }
      return String(n);
    }
    case 'url': {
      const s = String(value ?? '').trim();
      if (s.length > def.max) throw badRequest(`${key} ist zu lang.`);
      if (s && !/^https?:\/\/\S+$/i.test(s)) throw badRequest(`${key} muss mit http:// oder https:// beginnen.`);
      return s.replace(/\/+$/, '');
    }
    default: {
      const s = def.type === 'text' ? String(value ?? '').replace(/\r\n/g, '\n') : String(value ?? '').trim();
      if (s.length > def.max) throw badRequest(`${key} ist zu lang (maximal ${def.max} Zeichen).`);
      return s;
    }
  }
}

// Übernimmt nur bekannte Schlüssel. Leere Geheimnisse bleiben unverändert,
// außer sie stehen explizit in clearSecrets.
function update(values, clearSecrets = []) {
  const changes = [];
  for (const [key, value] of Object.entries(values || {})) {
    const def = SCHEMA[key];
    if (!def) continue;
    if (def.secret && (value === '' || value === null || value === undefined)) continue;
    changes.push([key, normalize(key, value)]);
  }
  db.transaction(() => {
    for (const [key, value] of changes) upsert.run(key, value);
    for (const key of clearSecrets) {
      if (SCHEMA[key]?.secret) upsert.run(key, '');
    }
  })();
  return getForAdmin();
}

// Interne Werte (Passwort Hash, Session Secret), nicht über die API änderbar.
function getInternal(key) {
  const row = selectOne.get(key);
  return row ? row.value : null;
}

function setInternal(key, value) {
  if (value === null) remove.run(key);
  else upsert.run(key, String(value));
}

module.exports = {
  SCHEMA,
  get,
  getBool,
  getInt,
  getAll,
  getForAdmin,
  update,
  getInternal,
  setInternal,
};
