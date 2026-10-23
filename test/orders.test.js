'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Eigene Datenbank pro Testlauf, muss vor dem Laden der Module gesetzt sein.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pizza-orders-'));
process.env.SEED_DEMO_DATA = 'false';
// Benachrichtigungen ins Leere laufen lassen, damit keine echten Requests entstehen.
process.env.WAHA_URL = '';

const { db } = require('../src/db');
const settings = require('../src/settings');
const time = require('../src/time');
const menu = require('../src/services/menu');
const slots = require('../src/services/slots');
const orders = require('../src/services/orders');

settings.update({ wa_confirm_enabled: false, mail_confirm_enabled: false, min_delivery_items: 4, lead_minutes: 0 });

const pizzaCat = menu.createCategory({ name: 'Pizza', sort_order: 1 });
const drinkCat = menu.createCategory({ name: 'Getränke', sort_order: 2 });
const margherita = menu.createItem({ name: 'Margherita', price: '8,50', category_id: pizzaCat.id });
const salami = menu.createItem({ name: 'Salami', price: '9.50', category_id: pizzaCat.id });
const soldOut = menu.createItem({ name: 'Tonno', price: '10', category_id: pizzaCat.id, available: false });
const cola = menu.createItem({ name: 'Cola', price: '2,50', category_id: drinkCat.id, counts_capacity: false });

const tomorrow = time.addDays(time.today(), 1);
const slot = slots.createSlot({ date: tomorrow, time: '18:00', max_orders: 2, max_items: 5 });

const customer = { name: 'Erika Muster', phone: '0171 1234567', email: 'erika@example.com' };

function order(overrides = {}) {
  return orders.createOrder({ type: 'pickup', slot_id: slot.id, customer, items: [], ...overrides });
}

function expectError(fn, status, pattern) {
  assert.throws(fn, (err) => {
    assert.equal(err.status, status, err.message);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

test.after(() => db.close());

test('Bestellung wird angelegt, Preise kommen vom Server', () => {
  const o = order({ items: [{ id: margherita.id, quantity: 2, price_cents: 1 }, { id: cola.id, quantity: 1 }] });
  assert.equal(o.id, 1001);
  assert.equal(o.total_cents, 2 * 850 + 250);
  assert.equal(o.time, '18:00');
  const s = slots.getById(slot.id);
  assert.equal(s.orders_count, 1);
  assert.equal(s.items_count, 2, 'Getränke zählen nicht zur Pizza Kapazität');
});

test('max_items: Warenkorb, der die Restkapazität sprengt, wird abgelehnt', () => {
  expectError(() => order({ items: [{ id: salami.id, quantity: 4 }] }), 409, /nur noch 3 Pizzen frei/);
});

test('max_orders: weitere Bestellung bei vollem Slot wird abgelehnt', () => {
  order({ items: [{ id: salami.id, quantity: 3 }] });
  const s = slots.getById(slot.id);
  assert.equal(s.orders_count, 2);
  assert.equal(s.items_count, 5);
  expectError(() => order({ items: [{ id: cola.id, quantity: 1 }] }), 409, /ausgebucht/);
});

test('stornierte Bestellungen geben Kapazität frei', async () => {
  await orders.setStatus(1001, 'cancelled');
  const s = slots.getById(slot.id);
  assert.equal(s.orders_count, 1);
  assert.equal(s.items_count, 3);
  const o = order({ items: [{ id: margherita.id, quantity: 2 }] });
  assert.ok(o.id > 1001);
});

test('ausverkaufte Artikel werden abgelehnt', () => {
  const extra = slots.createSlot({ date: tomorrow, time: '19:00', max_orders: 5, max_items: 20 });
  assert.throws(
    () => orders.createOrder({ type: 'pickup', slot_id: extra.id, customer, items: [{ id: soldOut.id, quantity: 1 }] }),
    (err) => err.status === 409 && err.details.code === 'items_unavailable' && err.details.items.includes(soldOut.id),
  );
});

test('Lieferung erst ab Mindestanzahl Pizzen und nur mit Adresse', () => {
  const extra = slots.createSlot({ date: tomorrow, time: '19:30', max_orders: 5, max_items: 20 });
  const base = { type: 'delivery', slot_id: extra.id, customer: { ...customer, street: 'Hauptstr. 1', city: '12345 Musterstadt' } };
  expectError(() => orders.createOrder({ ...base, items: [{ id: margherita.id, quantity: 3 }, { id: cola.id, quantity: 5 }] }), 400, /es fehlen noch 1/);
  expectError(() => orders.createOrder({ ...base, customer, items: [{ id: margherita.id, quantity: 4 }] }), 400, /Straße/);
  const o = orders.createOrder({ ...base, items: [{ id: margherita.id, quantity: 4 }] });
  assert.equal(o.type, 'delivery');
});

test('gesperrte und vergangene Slots sind nicht buchbar', () => {
  const locked = slots.createSlot({ date: tomorrow, time: '20:00', max_orders: 5, max_items: 20, locked: true });
  expectError(() => order({ slot_id: locked.id, items: [{ id: margherita.id, quantity: 1 }] }), 409, /gesperrt/);
  const past = slots.createSlot({ date: time.addDays(time.today(), -1), time: '18:00', max_orders: 5, max_items: 20 });
  expectError(() => order({ slot_id: past.id, items: [{ id: margherita.id, quantity: 1 }] }), 409, /nicht mehr buchbar/);
});

test('gleicher client_token erzeugt keine doppelte Bestellung', () => {
  const extra = slots.createSlot({ date: tomorrow, time: '20:30', max_orders: 5, max_items: 20 });
  const body = { type: 'pickup', slot_id: extra.id, customer, items: [{ id: margherita.id, quantity: 1 }], client_token: 'token-12345678' };
  const first = orders.createOrder(body);
  const second = orders.createOrder(body);
  assert.equal(first.id, second.id);
  assert.equal(slots.getById(extra.id).orders_count, 1);
});

test('Validierung der Kundendaten', () => {
  const items = [{ id: margherita.id, quantity: 1 }];
  expectError(() => order({ items, customer: { ...customer, phone: '123' } }), 400, /Telefonnummer/);
  expectError(() => order({ items, customer: { ...customer, email: 'keine-mail' } }), 400, /E-Mail/);
  expectError(() => order({ items, customer: { ...customer, name: '' } }), 400, /Name/);
  expectError(() => order({ items: [] }), 400, /leer/);
  expectError(() => order({ items: [{ id: margherita.id, quantity: 0 }] }), 400, /Menge/);
});

test('pausierte Bestellannahme liefert 503', () => {
  settings.update({ ordering_enabled: false });
  try {
    expectError(() => order({ items: [{ id: margherita.id, quantity: 1 }] }), 503);
  } finally {
    settings.update({ ordering_enabled: true });
  }
});

test('Slot Generator erzeugt Slots inklusive Endzeit und überspringt Duplikate', () => {
  const from = time.addDays(time.today(), 10);
  const r1 = slots.generate({ date_from: from, date_to: from, start: '17:00', end: '21:00', interval: 15, max_orders: 4, max_items: 10 });
  assert.equal(r1.created, 17);
  const r2 = slots.generate({ date_from: from, date_to: from, start: '17:00', end: '18:00', interval: 30, max_orders: 4, max_items: 10 });
  assert.equal(r2.created, 0);
  assert.equal(r2.skipped, 3);
});

test('Slots mit Bestellungen lassen sich nicht löschen', () => {
  expectError(() => slots.deleteSlot(slot.id), 409, /Sperre/);
});
