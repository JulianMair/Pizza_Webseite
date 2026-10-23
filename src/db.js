'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');
const time = require('./time');

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(path.join(config.dataDir, 'pizza.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SCHEMA_VERSION = 1;

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS menu_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    price_cents     INTEGER NOT NULL CHECK (price_cents >= 0),
    available       INTEGER NOT NULL DEFAULT 1,
    counts_capacity INTEGER NOT NULL DEFAULT 1,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS timeslots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL,
    time       TEXT NOT NULL,
    max_orders INTEGER NOT NULL CHECK (max_orders >= 0),
    max_items  INTEGER NOT NULL CHECK (max_items >= 0),
    locked     INTEGER NOT NULL DEFAULT 0,
    UNIQUE (date, time)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    client_token     TEXT UNIQUE,
    timeslot_id      INTEGER NOT NULL REFERENCES timeslots(id),
    type             TEXT NOT NULL CHECK (type IN ('pickup', 'delivery')),
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'preparing', 'ready', 'cancelled')),
    customer_name    TEXT NOT NULL,
    phone_raw        TEXT NOT NULL,
    phone_normalized TEXT NOT NULL,
    email            TEXT NOT NULL,
    street           TEXT NOT NULL DEFAULT '',
    city             TEXT NOT NULL DEFAULT '',
    note             TEXT NOT NULL DEFAULT '',
    item_count       INTEGER NOT NULL,
    capacity_count   INTEGER NOT NULL,
    total_cents      INTEGER NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    ready_at         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_timeslot ON orders(timeslot_id, status);

  CREATE TABLE IF NOT EXISTS order_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id    INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    price_cents     INTEGER NOT NULL,
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    counts_capacity INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('confirmation', 'ready')),
    channel    TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email')),
    status     TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
    error      TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_order ON notifications(order_id);
`);

// Bestellnummern beginnen bei 1001.
const hasSequence = db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = 'orders'").get();
if (!hasSequence) {
  db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('orders', 1000)").run();
}

if (db.pragma('user_version', { simple: true }) < SCHEMA_VERSION) {
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function seedDemoData() {
  const isEmpty = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0
    && db.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n === 0
    && db.prepare('SELECT COUNT(*) AS n FROM timeslots').get().n === 0;
  if (!isEmpty) return false;

  const now = time.nowIso();
  const insertCategory = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
  const insertItem = db.prepare(`
    INSERT INTO menu_items (category_id, name, description, price_cents, available, counts_capacity, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
  `);
  const insertSlot = db.prepare('INSERT OR IGNORE INTO timeslots (date, time, max_orders, max_items, locked) VALUES (?, ?, 5, 12, 0)');

  db.transaction(() => {
    const pizza = insertCategory.run('Pizza', 1).lastInsertRowid;
    const drinks = insertCategory.run('Getränke', 2).lastInsertRowid;
    const pizzas = [
      ['Margherita', 'Tomatensauce, Fior di Latte, Basilikum', 850],
      ['Salami', 'Tomatensauce, Mozzarella, Salami', 950],
      ['Funghi', 'Tomatensauce, Mozzarella, frische Champignons', 950],
      ['Prosciutto e Funghi', 'Tomatensauce, Mozzarella, Kochschinken, Champignons', 1050],
      ['Diavola', 'Tomatensauce, Mozzarella, scharfe Salami, Peperoni', 1050],
      ['Vegetariana', 'Tomatensauce, Mozzarella, Paprika, Zucchini, Aubergine, Zwiebeln', 1050],
      ['Quattro Formaggi', 'Mozzarella, Gorgonzola, Parmesan, Fontina', 1150],
    ];
    pizzas.forEach(([name, description, price], i) => {
      insertItem.run(pizza, name, description, price, 1, i + 1, now, now);
    });
    const drinkItems = [
      ['Cola 0,33 l', 'Gekühlt', 250],
      ['Apfelschorle 0,33 l', 'Gekühlt', 250],
      ['Mineralwasser 0,5 l', 'Still oder sprudelnd, bitte in der Notiz angeben', 200],
    ];
    drinkItems.forEach(([name, description, price], i) => {
      insertItem.run(drinks, name, description, price, 0, i + 1, now, now);
    });

    const start = time.today();
    for (const date of [start, time.addDays(start, 1)]) {
      for (let m = 17 * 60; m <= 21 * 60; m += 30) {
        insertSlot.run(date, time.minutesToTime(m));
      }
    }
  })();
  return true;
}

module.exports = { db, seedDemoData };
