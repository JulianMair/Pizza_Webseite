'use strict';

const { db } = require('../db');
const settings = require('../settings');
const time = require('../time');
const events = require('../events');
const slots = require('./slots');
const notify = require('./notify');
const { normalizePhone } = require('./whatsapp');
const { HttpError, badRequest, notFound, conflict } = require('../errors');

const STATUSES = ['open', 'preparing', 'ready', 'cancelled'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const ORDER_SELECT = `
  SELECT o.*, t.date AS slot_date, t.time AS slot_time
  FROM orders o JOIN timeslots t ON t.id = o.timeslot_id
`;

const stmts = {
  menuItem: db.prepare('SELECT id, name, price_cents, available, counts_capacity FROM menu_items WHERE id = ?'),
  byToken: db.prepare('SELECT id FROM orders WHERE client_token = ?'),
  insertOrder: db.prepare(`
    INSERT INTO orders (client_token, timeslot_id, type, status, customer_name, phone_raw, phone_normalized, email, street, city, note,
                        item_count, capacity_count, total_cents, created_at, updated_at)
    VALUES (@client_token, @timeslot_id, @type, 'open', @customer_name, @phone_raw, @phone_normalized, @email, @street, @city, @note,
            @item_count, @capacity_count, @total_cents, @now, @now)
  `),
  insertItem: db.prepare(`
    INSERT INTO order_items (order_id, menu_item_id, name, price_cents, quantity, counts_capacity)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  orderById: db.prepare(`${ORDER_SELECT} WHERE o.id = ?`),
  ordersByDate: db.prepare(`${ORDER_SELECT} WHERE t.date = ? ORDER BY t.time, o.id`),
  itemsByOrder: db.prepare('SELECT name, price_cents, quantity, counts_capacity FROM order_items WHERE order_id = ? ORDER BY id'),
  notificationsByOrder: db.prepare('SELECT kind, channel, status, error, created_at FROM notifications WHERE order_id = ? ORDER BY id'),
  updateStatus: db.prepare(`
    UPDATE orders SET status = @status, updated_at = @now,
      ready_at = CASE WHEN @status = 'ready' THEN @now ELSE ready_at END
    WHERE id = @id
  `),
  deleteOldOrders: db.prepare('DELETE FROM orders WHERE timeslot_id IN (SELECT id FROM timeslots WHERE date < ?)'),
  deleteOldSlots: db.prepare('DELETE FROM timeslots WHERE date < ? AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.timeslot_id = timeslots.id)'),
};

function str(value, name, { required = false, max }) {
  const s = String(value ?? '').trim();
  if (required && !s) throw badRequest(`Bitte ${name} angeben.`, { field: name });
  if (s.length > max) throw badRequest(`${name} ist zu lang (maximal ${max} Zeichen).`, { field: name });
  return s;
}

function validateInput(body) {
  if (!body || typeof body !== 'object') throw badRequest('Ungültige Bestellung.');
  const type = body.type === 'delivery' ? 'delivery' : body.type === 'pickup' ? 'pickup' : null;
  if (!type) throw badRequest('Bitte Abholung oder Lieferung wählen.');
  const slotId = Number(body.slot_id);
  if (!Number.isInteger(slotId) || slotId <= 0) throw badRequest('Bitte einen Zeitslot wählen.');

  const c = body.customer || {};
  const customer = {
    name: str(c.name, 'Name', { required: true, max: 100 }),
    phone: str(c.phone, 'Telefonnummer', { required: true, max: 40 }),
    email: str(c.email, 'E-Mail', { required: true, max: 200 }),
    street: str(c.street, 'Straße und Hausnummer', { required: type === 'delivery', max: 200 }),
    city: str(c.city, 'Ort und Hinweise', { required: type === 'delivery', max: 300 }),
    note: str(c.note, 'Notiz', { max: 1000 }),
  };
  if (customer.name.length < 2) throw badRequest('Bitte den vollständigen Namen angeben.', { field: 'Name' });
  const phoneNormalized = normalizePhone(customer.phone);
  if (!phoneNormalized) throw badRequest('Bitte eine gültige Telefonnummer angeben (z. B. 0171 1234567).', { field: 'Telefonnummer' });
  if (!EMAIL_RE.test(customer.email)) throw badRequest('Bitte eine gültige E-Mail-Adresse angeben.', { field: 'E-Mail' });
  if (type === 'pickup') {
    customer.street = '';
    customer.city = '';
  }

  if (!Array.isArray(body.items) || body.items.length === 0) throw badRequest('Der Warenkorb ist leer.');
  const quantities = new Map();
  for (const line of body.items) {
    const id = Number(line?.id);
    const qty = Number(line?.quantity);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty < 1 || qty > 50) {
      throw badRequest('Ungültige Menge im Warenkorb (1 bis 50 pro Artikel).');
    }
    quantities.set(id, (quantities.get(id) || 0) + qty);
  }
  if (quantities.size > 50) throw badRequest('Zu viele verschiedene Artikel.');

  let clientToken = null;
  if (body.client_token !== undefined && body.client_token !== null && body.client_token !== '') {
    clientToken = String(body.client_token);
    if (!/^[A-Za-z0-9-]{8,100}$/.test(clientToken)) throw badRequest('Ungültiges Bestell Token.');
  }

  return { type, slotId, customer, phoneNormalized, quantities, clientToken };
}

function loadOrder(id) {
  const order = stmts.orderById.get(id);
  if (!order) return null;
  order.items = stmts.itemsByOrder.all(id);
  return order;
}

// Letzter Stand pro Art und Kanal, z. B. ready.whatsapp = { status, error, created_at }.
function notificationSummary(orderId) {
  const summary = { confirmation: {}, ready: {} };
  for (const n of stmts.notificationsByOrder.all(orderId)) {
    summary[n.kind][n.channel] = { status: n.status, error: n.error, at: n.created_at };
  }
  return summary;
}

function publicOrder(order) {
  return {
    id: order.id,
    type: order.type,
    status: order.status,
    date: order.slot_date,
    time: order.slot_time,
    customer_name: order.customer_name,
    items: order.items.map((i) => ({ name: i.name, quantity: i.quantity, price_cents: i.price_cents })),
    total_cents: order.total_cents,
  };
}

function adminOrder(order) {
  return {
    id: order.id,
    type: order.type,
    status: order.status,
    date: order.slot_date,
    time: order.slot_time,
    timeslot_id: order.timeslot_id,
    customer_name: order.customer_name,
    phone: order.phone_raw,
    phone_normalized: order.phone_normalized,
    email: order.email,
    street: order.street,
    city: order.city,
    note: order.note,
    item_count: order.item_count,
    capacity_count: order.capacity_count,
    total_cents: order.total_cents,
    created_at: order.created_at,
    ready_at: order.ready_at,
    items: order.items,
    notifications: notificationSummary(order.id),
  };
}

// Legt eine Bestellung an. Alle Prüfungen und der Insert laufen in einer
// BEGIN IMMEDIATE Transaktion, damit parallele Bestellungen keinen Platz doppelt belegen.
const createOrderTx = db.transaction((input) => {
  if (input.clientToken) {
    const existing = stmts.byToken.get(input.clientToken);
    if (existing) return { id: existing.id, duplicate: true };
  }
  if (!settings.getBool('ordering_enabled')) {
    throw new HttpError(503, settings.get('closed_message') || 'Aktuell werden keine Bestellungen angenommen.');
  }

  const lines = [];
  const unavailable = [];
  for (const [id, quantity] of input.quantities) {
    const item = stmts.menuItem.get(id);
    if (!item) {
      unavailable.push({ id, name: 'Unbekannter Artikel' });
      continue;
    }
    if (!item.available) unavailable.push({ id, name: item.name });
    lines.push({ ...item, quantity });
  }
  if (unavailable.length) {
    throw conflict(`Leider nicht mehr verfügbar: ${unavailable.map((u) => u.name).join(', ')}. Bitte aus dem Warenkorb entfernen.`, {
      code: 'items_unavailable',
      items: unavailable.map((u) => u.id),
    });
  }

  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  const capacityCount = lines.reduce((sum, l) => sum + (l.counts_capacity ? l.quantity : 0), 0);
  const totalCents = lines.reduce((sum, l) => sum + l.price_cents * l.quantity, 0);
  if (itemCount > 100) throw badRequest('Maximal 100 Artikel pro Bestellung. Für Großbestellungen bitte anrufen.');

  const minDelivery = settings.getInt('min_delivery_items');
  if (input.type === 'delivery' && capacityCount < minDelivery) {
    throw badRequest(`Lieferung erst ab ${minDelivery} Pizzen möglich, es fehlen noch ${minDelivery - capacityCount}.`, { code: 'delivery_minimum' });
  }

  const slot = slots.getById(input.slotId);
  if (!slot) throw conflict('Der gewählte Zeitslot existiert nicht mehr.', { code: 'slot_unavailable' });
  const check = slots.checkBookable(slot, capacityCount);
  if (!check.ok) throw conflict(check.reason, { code: 'slot_unavailable' });

  const orderId = stmts.insertOrder.run({
    client_token: input.clientToken,
    timeslot_id: slot.id,
    type: input.type,
    customer_name: input.customer.name,
    phone_raw: input.customer.phone,
    phone_normalized: input.phoneNormalized,
    email: input.customer.email,
    street: input.customer.street,
    city: input.customer.city,
    note: input.customer.note,
    item_count: itemCount,
    capacity_count: capacityCount,
    total_cents: totalCents,
    now: time.nowIso(),
  }).lastInsertRowid;
  for (const l of lines) {
    stmts.insertItem.run(orderId, l.id, l.name, l.price_cents, l.quantity, l.counts_capacity);
  }
  return { id: Number(orderId), duplicate: false };
});

function createOrder(body) {
  const input = validateInput(body);
  const { id, duplicate } = createOrderTx.immediate(input);
  const order = loadOrder(id);
  if (!duplicate) {
    events.broadcast('order:new', { id, date: order.slot_date });
    notify.sendOrderNotifications(order, 'confirmation')
      .then(() => events.broadcast('order:updated', { id, date: order.slot_date }))
      .catch((err) => console.error(`[notify] Bestellung #${id}: ${err.message}`));
  }
  return publicOrder(order);
}

// Kapazitätsübersicht und Bestellungen eines Tages, gruppiert nach Slot.
function listForDate(date) {
  const daySlots = slots.listByDate(date);
  const orders = stmts.ordersByDate.all(date).map((o) => {
    o.items = stmts.itemsByOrder.all(o.id);
    return adminOrder(o);
  });
  return daySlots.map((slot) => {
    const slotOrders = orders.filter((o) => o.timeslot_id === slot.id);
    const pizzas = new Map();
    const others = new Map();
    for (const o of slotOrders) {
      if (o.status === 'cancelled') continue;
      for (const i of o.items) {
        const target = i.counts_capacity ? pizzas : others;
        target.set(i.name, (target.get(i.name) || 0) + i.quantity);
      }
    }
    const toList = (m) => [...m.entries()].map(([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
    return { ...slot, orders: slotOrders, summary: { pizzas: toList(pizzas), others: toList(others) } };
  });
}

function getAdminOrder(id) {
  const order = loadOrder(id);
  if (!order) throw notFound('Bestellung nicht gefunden.');
  return adminOrder(order);
}

// Speichert den Status zuerst und löst danach beim Wechsel auf "Fertig" die
// Benachrichtigungen aus. Deren Fehler werden zurückgegeben, nicht geworfen.
async function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw badRequest('Ungültiger Status.');
  const order = loadOrder(id);
  if (!order) throw notFound('Bestellung nicht gefunden.');
  let warning = null;
  if (order.status === 'cancelled' && status !== 'cancelled') {
    const slot = slots.getById(order.timeslot_id);
    if (slot.orders_count + 1 > slot.max_orders || slot.items_count + order.capacity_count > slot.max_items) {
      warning = `Bestellung reaktiviert, der Slot ${slot.time} Uhr ist damit überbucht.`;
    }
  }
  const previous = order.status;
  if (previous !== status) {
    stmts.updateStatus.run({ id, status, now: time.nowIso() });
    events.broadcast('order:updated', { id, date: order.slot_date });
  }

  let notifications = null;
  if (status === 'ready' && previous !== 'ready') {
    notifications = await notify.sendOrderNotifications(loadOrder(id), 'ready');
    events.broadcast('order:updated', { id, date: order.slot_date });
  }
  return { order: getAdminOrder(id), previous, notifications, warning };
}

async function resendNotifications(id, kind) {
  if (!['confirmation', 'ready'].includes(kind)) throw badRequest('Ungültige Benachrichtigungsart.');
  const order = loadOrder(id);
  if (!order) throw notFound('Bestellung nicht gefunden.');
  const notifications = await notify.sendOrderNotifications(order, kind, { force: true });
  events.broadcast('order:updated', { id, date: order.slot_date });
  return { order: getAdminOrder(id), notifications };
}

// Datensparsamkeit: entfernt Bestellungen und Slots, die älter als N Tage sind.
function cleanup(days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw badRequest('Bitte eine Anzahl Tage von 1 bis 3650 angeben.');
  const cutoff = time.addDays(time.today(), -n);
  return db.transaction(() => ({
    orders: stmts.deleteOldOrders.run(cutoff).changes,
    slots: stmts.deleteOldSlots.run(cutoff).changes,
    cutoff,
  }))();
}

module.exports = { STATUSES, createOrder, listForDate, getAdminOrder, setStatus, resendNotifications, cleanup };
